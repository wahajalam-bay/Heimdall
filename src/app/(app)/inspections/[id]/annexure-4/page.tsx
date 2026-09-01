import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Mono } from "@/components/ui/primitives";
import { fmtDate, qty, round2 } from "@/lib/format";
import { annexure4Signatures } from "@/server/receiving";
import { signoffsFor } from "@/server/inspection-matrix";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const i = await prisma.inspection.findUnique({ where: { id }, select: { number: true } });
  return { title: i ? `${i.number} — Annexure 4` : "Annexure 4" };
}

/**
 * Annexure 4 — Goods / Material Inspection Note.
 *
 * Built to `image17.png`: the header dates and supplier, the per-line grid with
 * its split inspection columns, the four totals, the certification text quoting
 * the purchase order, the reason for any rejection, and the two signature
 * blocks.
 *
 * The quantitative column prints a quantity as well as pass and reject, because
 * counting is a number; the qualitative and technical columns print only pass or
 * reject, because judging is not. That is the form's own distinction and it is
 * kept.
 *
 * Deliberately plain — a document to be printed, signed and filed.
 */
export default async function Annexure4Page({ params }: { params: Promise<{ id: string }> }) {
  const { authorized } = await pageContext(P.INSPECTION_PERFORM, P.INSPECTION_SCHEDULE, P.GRN_VIEW);
  if (!authorized) return <AccessDenied title="Annexure 4" />;

  const { id } = await params;
  const insp = await prisma.inspection.findUnique({
    where: { id },
    include: {
      po: {
        select: {
          number: true,
          vendor: { select: { name: true } },
          entity: { select: { name: true, code: true } },
        },
      },
      delivery: {
        select: {
          number: true,
          deliveryDate: true,
          store: { select: { name: true } },
          receivedBy: { select: { name: true, title: true } },
        },
      },
      items: {
        orderBy: { lineNo: "asc" },
        include: {
          item: { select: { sku: true, name: true } },
          poItem: { select: { unit: true } },
        },
      },
    },
  });
  if (!insp) notFound();

  const [signatures, signoffs, department, poc] = await Promise.all([
    annexure4Signatures(insp.id),
    signoffsFor(insp.id),
    insp.concernedDepartmentId
      ? prisma.department.findUnique({
          where: { id: insp.concernedDepartmentId },
          select: { name: true },
        })
      : Promise.resolve(null),
    insp.concernedPocId
      ? prisma.user.findUnique({
          where: { id: insp.concernedPocId },
          select: { name: true, title: true },
        })
      : Promise.resolve(null),
  ]);

  const received = round2(insp.items.reduce((a, i) => a + i.quantityInspected, 0));
  const inspected = received;
  const accepted = round2(insp.items.reduce((a, i) => a + i.quantityPassed, 0));
  const returned = round2(insp.items.reduce((a, i) => a + i.quantityFailed, 0));

  const qualitative = signoffs.find((s) => s.inspectionType === "QUALITATIVE");
  const technical = signoffs.find((s) => s.inspectionType === "TECHNICAL");
  const mark = (v: string | null, want: "PASS" | "FAIL") => {
    if (!v) return "—";
    if (want === "PASS") return v === "PASS" || v === "CONDITIONAL" ? "✓" : "";
    return v === "FAIL" ? "✓" : "";
  };

  return (
    <div className="mx-auto max-w-[62rem] space-y-5 print:max-w-none">
      <div className="no-print flex items-center justify-between">
        <Link className="link text-xs" href={`/inspections/${insp.id}`}>
          ← Back to {insp.number}
        </Link>
        <span className="text-2xs text-[var(--c-text-tertiary)]">
          Print this page to produce the signed inspection note.
        </span>
      </div>

      <div className="card space-y-5 px-6 py-6">
        <header className="border-b border-[var(--c-border)] pb-4 text-center">
          <p className="text-2xs uppercase tracking-widest text-[var(--c-text-tertiary)]">
            {insp.po?.entity?.name ?? "—"} · Annexure 4
          </p>
          <h1 className="mt-1 text-base font-semibold">Goods / Material Inspection Note</h1>
          <Mono className="mt-1 block text-xs text-[var(--c-text-secondary)]">{insp.number}</Mono>
        </header>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Receiving date</dt>
            <dd className="mt-0.5">
              {insp.receivedDate
                ? fmtDate(insp.receivedDate)
                : insp.delivery?.deliveryDate
                  ? fmtDate(insp.delivery.deliveryDate)
                  : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Inspection date</dt>
            <dd className="mt-0.5">{insp.inspectedAt ? fmtDate(insp.inspectedAt) : "Not yet inspected"}</dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Supplier</dt>
            <dd className="mt-0.5">{insp.po?.vendor?.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Store</dt>
            <dd className="mt-0.5">{insp.delivery?.store?.name ?? "—"}</dd>
          </div>
        </dl>

        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th rowSpan={2} style={{ width: "3rem" }}>
                  Sr.
                </th>
                <th rowSpan={2} style={{ width: "8rem" }}>
                  Item code
                </th>
                <th rowSpan={2} style={{ minWidth: "13rem" }}>
                  Description
                </th>
                <th colSpan={3} className="text-center">
                  Quantitative
                </th>
                <th colSpan={2} className="text-center">
                  Qualitative / Technical
                </th>
                <th rowSpan={2} style={{ width: "7rem" }}>
                  Expiry
                </th>
              </tr>
              <tr>
                <th style={{ width: "6rem" }} className="text-right">
                  Qty
                </th>
                <th style={{ width: "5rem" }} className="text-right">
                  Passed
                </th>
                <th style={{ width: "5rem" }} className="text-right">
                  Rejected
                </th>
                <th style={{ width: "5rem" }} className="text-center">
                  Passed
                </th>
                <th style={{ width: "5rem" }} className="text-center">
                  Rejected
                </th>
              </tr>
            </thead>
            <tbody>
              {insp.items.map((li) => {
                // The form's own distinction: counting produces a number, judging
                // produces a verdict. The qualitative and technical columns take
                // the sign-off's verdict, not a quantity.
                const judged = qualitative?.verdict ?? technical?.verdict ?? li.verdict;
                return (
                  <tr key={li.id}>
                    <td className="tnum">{li.lineNo}</td>
                    <td>
                      <Mono className="text-2xs">{li.item?.sku ?? "—"}</Mono>
                    </td>
                    <td>{li.description}</td>
                    <td className="tnum text-right">
                      {qty(li.quantityInspected)} {li.poItem?.unit ?? ""}
                    </td>
                    <td className="tnum text-right">{qty(li.quantityPassed)}</td>
                    <td className="tnum text-right">{li.quantityFailed ? qty(li.quantityFailed) : "—"}</td>
                    <td className="text-center">{mark(judged, "PASS")}</td>
                    <td className="text-center">{mark(judged, "FAIL")}</td>
                    <td className="text-2xs">{li.expiryDate ? fmtDate(li.expiryDate) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Received quantity", received],
            ["Inspected quantity", inspected],
            ["Accepted quantity", accepted],
            ["Returned quantity", returned],
          ].map(([label, value]) => (
            <div key={String(label)} className="border border-[var(--c-border)] px-3 py-2">
              <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">{label}</p>
              <p className="tnum mt-0.5 text-sm font-semibold">{qty(Number(value))}</p>
            </div>
          ))}
        </div>

        <p className="border-t border-[var(--c-border)] pt-4 text-xs leading-6">
          Certified that the goods described above, received against purchase order{" "}
          <strong>{insp.po?.number ?? "—"}</strong>
          {insp.delivery?.number ? ` under delivery ${insp.delivery.number}` : ""}, have been inspected as recorded,
          and that {qty(accepted)} of {qty(received)} presented {accepted === received ? "were" : "have been"}{" "}
          accepted into store.
        </p>

        {(returned > 0 || insp.findings) && (
          <div className="border border-[var(--c-border)] px-3 py-2">
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Reason for rejection / return
            </p>
            <p className="mt-1 text-xs leading-5">
              {insp.findings ?? "Not recorded."}
              {insp.conditions ? ` Conditions: ${insp.conditions}` : ""}
            </p>
          </div>
        )}

        <div className="grid gap-6 border-t border-[var(--c-border)] pt-5 sm:grid-cols-2">
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Logistics (Received by)</p>
            <div className="mt-7 border-b border-[var(--c-text-tertiary)]" />
            <p className="mt-1 text-xs">
              {signatures.logistics?.name ?? insp.delivery?.receivedBy?.name ?? "Name"}
            </p>
            <p className="text-2xs text-[var(--c-text-tertiary)]">
              {signatures.logistics?.designation ?? insp.delivery?.receivedBy?.title ?? "Designation"}
              {signatures.logistics?.signedAt ? ` · ${fmtDate(signatures.logistics.signedAt)}` : " · Date"}
            </p>
            {!signatures.logistics && (
              <p className="no-print mt-1 text-2xs text-[var(--c-warning)]">Unsigned</p>
            )}
          </div>

          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Concerned Department (Signature — POC)
            </p>
            <div className="mt-7 border-b border-[var(--c-text-tertiary)]" />
            <p className="mt-1 text-xs">{signatures.department?.name ?? poc?.name ?? "Name"}</p>
            <p className="text-2xs text-[var(--c-text-tertiary)]">
              {signatures.department?.designation ?? poc?.title ?? "Designation"}
              {department?.name ? ` · ${department.name}` : ""}
              {signatures.department?.signedAt ? ` · ${fmtDate(signatures.department.signedAt)}` : " · Date"}
            </p>
            {!signatures.department && (
              <p className="no-print mt-1 text-2xs text-[var(--c-warning)]">
                {poc ? "Unsigned" : "No POC appointed for the requesting department"}
              </p>
            )}
          </div>
        </div>
      </div>

      <p className="no-print text-2xs text-[var(--c-text-tertiary)]">
        The two blocks are different signatures and the form treats them so. Logistics certifies what arrived and in
        what condition; the concerned department&rsquo;s POC certifies that it is what they asked for — §3.2. An
        inspector signing both would be the inspection verifying itself.
      </p>
    </div>
  );
}
