import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Mono } from "@/components/ui/primitives";
import { amount, fmtDate, fmtTime, percent } from "@/lib/format";
import { humanize } from "@/lib/domain";
import {
  ANNEXURE_6_SECTION_SUM,
  ANNEXURE_6_STATED_PASS,
  ANNEXURE_6_STATED_TOTAL,
  selectionForm,
} from "@/server/vendor-selection-form";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = await prisma.vendor.findUnique({ where: { id }, select: { name: true } });
  return { title: v ? `${v.name} — Annexure 6` : "Annexure 6" };
}

/**
 * Annexure 6 — the Vendor Selection Form.
 *
 * Built to `image20`: the preparer block, the vendor information including the
 * related-party question, the seven scored sections, the three mandatory
 * documents, and three signatures rather than one.
 *
 * Where the system's instrument and the form disagree the sheet says so on its
 * face. A section with no criteria prints as unscored rather than as zero, and a
 * section maximum that differs from the form's is marked — because the form's own
 * seven maxima sum to 61 against a stated qualifying score out of 60, and
 * nothing here is entitled to decide which figure is right.
 *
 * Deliberately plain: no navigation, no colour, no actions.
 */
export default async function Annexure6Page({ params }: { params: Promise<{ id: string }> }) {
  const { authorized } = await pageContext(P.VENDOR_VIEW);
  if (!authorized) return <AccessDenied title="Annexure 6" />;

  const { id } = await params;
  const vendor = await prisma.vendor.findUnique({
    where: { id },
    include: {
      evaluations: {
        where: { evaluationType: "PRE_QUALIFICATION" },
        orderBy: { evaluatedAt: "desc" },
        take: 1,
        include: { evaluator: { select: { name: true, title: true } } },
      },
    },
  });
  if (!vendor) notFound();

  const evaluation = vendor.evaluations[0] ?? null;
  const [form, approver] = await Promise.all([
    selectionForm(vendor.id, evaluation ? { evaluationId: evaluation.id } : {}),
    evaluation?.approvedById
      ? prisma.user.findUnique({
          where: { id: evaluation.approvedById },
          select: { name: true, title: true },
        })
      : Promise.resolve(null),
  ]);

  const field = (label: string, value: React.ReactNode) => (
    <div>
      <dt className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );

  const rows = form.offForm ? [...form.sections, form.offForm] : form.sections;
  // The whole-instrument case: not one criterion lands on an Annexure 6 section.
  // That is not seven small gaps, it is one large one, and saying it once at the
  // top is honest where seven "unscored" rows only look like a rendering fault.
  const wholesaleMismatch =
    form.sections.every((x) => x.unscored) && (form.offForm?.lines.length ?? 0) > 0;

  return (
    <div className="mx-auto max-w-[58rem] space-y-5 print:max-w-none">
      <div className="no-print flex items-center justify-between">
        <Link className="link text-xs" href={`/vendors/${vendor.id}`}>
          ← Back to {vendor.name}
        </Link>
        <span className="text-2xs text-[var(--c-text-tertiary)]">
          Print this page to produce the selection form for signature.
        </span>
      </div>

      <div className="card space-y-5 px-6 py-6">
        <header className="border-b border-[var(--c-border)] pb-4 text-center">
          <p className="text-2xs uppercase tracking-widest text-[var(--c-text-tertiary)]">
            Annexure 6
          </p>
          <h1 className="mt-1 text-base font-semibold">Vendor Selection Form</h1>
          <Mono className="mt-1 block text-xs text-[var(--c-text-secondary)]">{vendor.code}</Mono>
        </header>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-xs sm:grid-cols-4">
          {field("Prepared by", evaluation?.evaluator.name ?? "—")}
          {field("Designation", evaluation?.evaluator.title ?? "—")}
          {field("Date", evaluation ? fmtDate(evaluation.evaluatedAt) : "—")}
          {field(
            "Vendor referred by",
            vendor.referredByName
              ? `${vendor.referredByName}${vendor.referredByDesignation ? `, ${vendor.referredByDesignation}` : ""}`
              : humanize(vendor.sourceChannel),
          )}
        </dl>

        <div className="border-y border-[var(--c-border)] py-3">
          <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
            Vendor information
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2.5 text-xs sm:grid-cols-4">
            {field("Company name", vendor.legalName ?? vendor.name)}
            {field("Address", vendor.address ?? "—")}
            {field("City", vendor.city ?? "—")}
            {field("Contact", vendor.contactPhone ?? vendor.contactEmail ?? "—")}
            {field("Type of business", humanize(vendor.businessType))}
            {field("Representative", vendor.contactPerson ?? "—")}
            {field("Tax status", humanize(vendor.taxStatus))}
            {field("NTN / STRN", [vendor.ntn, vendor.strn].filter(Boolean).join(" / ") || "—")}
          </dl>

          {/* The one field on this form with real teeth: two names owned by one
              person quoting against each other on the same comparative is not a
              comparison. It prints as unanswered rather than as "none". */}
          <div className="mt-3">
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Any other company owned by the same owner
            </p>
            <p className="mt-0.5 min-h-[1.5rem] border-b border-dashed border-[var(--c-border)] pb-1 text-xs">
              {vendor.relatedCompanies ?? ""}
            </p>
            {!vendor.relatedCompanies && (
              <p className="mt-1 text-2xs text-[var(--c-warning)]">
                Unanswered. Blank is not the same as none — an unanswered related-party question is what lets two
                names with one owner appear on the same comparative.
              </p>
            )}
          </div>
        </div>

        {wholesaleMismatch && (
          <p className="border border-[var(--c-warning)] px-3 py-2 text-2xs leading-4">
            The scoring below is not Annexure 6&rsquo;s. This vendor was scored on the instrument the system holds —{" "}
            {form.offForm?.lines.length} criteria in{" "}
            {new Set(form.offForm?.lines.map((l) => l.group)).size} groups — and none of its criteria belong to a section this form names. The scores are real and are printed
            as recorded; the seven sections are empty because the instrument does not use them. Rebuilding the
            instrument to Annexure 6&rsquo;s sections is a P0 in the plan.
          </p>
        )}

        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ minWidth: "14rem" }}>Section</th>
                <th style={{ width: "5rem" }} className="text-right">
                  Form max
                </th>
                <th style={{ width: "6rem" }} className="text-right">
                  Instrument max
                </th>
                <th style={{ width: "5rem" }} className="text-right">
                  Scored
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.key}>
                  <td className="text-xs">
                    {s.label}
                    {s.lines.length > 0 && (
                      <span className="mt-0.5 block text-2xs leading-4 text-[var(--c-text-tertiary)]">
                        {s.lines.map((l) => `${l.name} ${l.score}/${l.maxScore}`).join(" · ")}
                      </span>
                    )}
                    {s.unscored && !wholesaleMismatch && (
                      <span className="mt-0.5 block text-2xs leading-4 text-[var(--c-warning)]">
                        No criterion in the instrument belongs to this section — unscored, not zero.
                      </span>
                    )}
                    {s.maximumDiffers && (
                      <span className="mt-0.5 block text-2xs leading-4 text-[var(--c-warning)]">
                        The instrument scores this section out of {amount(s.instrumentMax)}, the form out of{" "}
                        {s.formMax}.
                      </span>
                    )}
                  </td>
                  <td className="tnum text-right">{s.key === "OFF_FORM" ? "—" : s.formMax}</td>
                  <td className="tnum text-right">
                    {s.instrumentMax ? amount(s.instrumentMax) : "—"}
                  </td>
                  <td className="tnum text-right">{s.lines.length ? amount(s.scored) : "—"}</td>
                </tr>
              ))}
              {form.totals && (
                <tr>
                  <td className="text-2xs uppercase tracking-wide">
                    Total as the instrument scored it
                  </td>
                  <td className="tnum text-right">{ANNEXURE_6_STATED_TOTAL}</td>
                  <td className="tnum text-right font-semibold">{amount(form.totals.max)}</td>
                  <td className="tnum text-right font-semibold">{amount(form.totals.scored)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {form.totals ? (
          <p className="text-xs">
            {amount(form.totals.scored)} of {amount(form.totals.max)} ({percent(form.totals.percentage, 1)}) against a
            pass mark of {amount(form.totals.passMark)} —{" "}
            <span className={form.totals.passed ? "text-[var(--c-success)]" : "text-[var(--c-danger)]"}>
              {form.totals.passed ? "qualified" : "below the pass mark"}
            </span>
            . {humanize(evaluation?.status ?? "DRAFT")}.
          </p>
        ) : (
          <p className="text-xs text-[var(--c-warning)]">
            No pre-qualification evaluation is recorded for this vendor, so the scoring section prints empty. The form
            is the sheet on which that evaluation is made, not a record that it happened.
          </p>
        )}

        <p className="text-2xs leading-4 text-[var(--c-text-tertiary)]">
          Annexure 6 states a qualifying score of {ANNEXURE_6_STATED_PASS} out of {ANNEXURE_6_STATED_TOTAL}, while its
          seven section maxima sum to {ANNEXURE_6_SECTION_SUM}. Both figures are printed as the form gives them; the
          discrepancy is in the source and is recorded as PCZ-06 rather than resolved here.
        </p>

        <div>
          <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
            Mandatory documents
          </p>
          <ul className="mt-1.5 space-y-1.5 text-xs">
            {form.mandatory.map((m) => (
              <li key={m.docType} className="flex flex-wrap items-baseline gap-2">
                <span className="w-4">{m.present ? "☑" : "☐"}</span>
                <span>{m.label}</span>
                <span className="text-2xs text-[var(--c-text-tertiary)]">
                  {m.present
                    ? `${m.name ?? "attached"}${m.verified ? " · verified" : " · not verified"}${
                        m.expiryDate ? ` · expires ${fmtDate(m.expiryDate)}` : ""
                      }`
                    : "not on file"}
                  {m.note ? ` — ${m.note}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {form.missingMandatory.length > 0 && (
            <p className="mt-1.5 text-2xs text-[var(--c-warning)]">
              Missing: {form.missingMandatory.join(", ")}. Annexure 6 marks these mandatory.
            </p>
          )}
        </div>

        {/* Three signatures, not one. Preparing the sheet, checking it and
            approving the vendor are three acts, and the form separates them. */}
        <div className="grid gap-8 border-t border-[var(--c-border)] pt-5 sm:grid-cols-3">
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Prepared by
            </p>
            <div className="mt-7 border-b border-[var(--c-text-tertiary)]" />
            <p className="mt-1 text-xs">{evaluation?.evaluator.name ?? "Name"}</p>
            <p className="text-2xs text-[var(--c-text-tertiary)]">
              {evaluation?.evaluator.title ?? "Designation"}
              {evaluation ? ` · ${fmtDate(evaluation.evaluatedAt)}` : " · Date"}
            </p>
          </div>
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Verified by
            </p>
            <div className="mt-7 border-b border-[var(--c-text-tertiary)]" />
            <p className="mt-1 text-xs">Name</p>
            <p className="text-2xs text-[var(--c-text-tertiary)]">Designation · Date</p>
            <p className="mt-1 text-2xs leading-4 text-[var(--c-warning)]">
              The instrument records who evaluated and who approved, and has no third act between them. This block
              prints blank rather than reusing one of the other two names.
            </p>
          </div>
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Approved by
            </p>
            <div className="mt-7 border-b border-[var(--c-text-tertiary)]" />
            <p className="mt-1 text-xs">{approver?.name ?? "Name"}</p>
            <p className="text-2xs text-[var(--c-text-tertiary)]">
              {approver?.title ?? "Designation"}
              {evaluation?.approvedAt
                ? ` · ${fmtDate(evaluation.approvedAt)} ${fmtTime(evaluation.approvedAt)}`
                : " · Date"}
            </p>
          </div>
        </div>
      </div>

      <p className="no-print text-2xs text-[var(--c-text-tertiary)]">
        The sections are the form&rsquo;s; the scores are the instrument&rsquo;s. Rebuilding the instrument to the
        form&rsquo;s seven weighted sections is a P0 in the plan and needs the 60-versus-61 question answered first —
        until then the sheet shows both figures rather than picking one.
      </p>
    </div>
  );
}
