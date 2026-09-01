import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Mono } from "@/components/ui/primitives";
import { amount, fmtDate, fmtTime, qty } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { attestationBlock } from "@/server/attestation";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pr = await prisma.purchaseRequisition.findUnique({
    where: { id },
    select: { number: true },
  });
  return { title: pr ? `${pr.number} — Annexure 1` : "Annexure 1" };
}

/**
 * Annexure 1 — Purchase Requisition form.
 *
 * ZAM/PUR/SOP-01 §4: a requisition is system-generated, and "where unavailable,
 * raised on the specified PR form (Annexure 1)". The system generates it, so
 * this is the same requisition rendered in the form's own layout — for the file,
 * and for the desks that still want a signed sheet.
 *
 * The form ends with the head of department's Sign, Stamp, Date and Time, of
 * which the Annexure says: "Stamps, Date, Time are compulsory to ensure
 * compliance." Those come from the approval attestation, not from the status
 * change — a status says the requisition moved, an attestation says who put
 * their name to it, in what office, at what minute. Where nothing is signed the
 * blocks print empty, because an unsigned form is a real thing and filling it
 * from a status change is the forgery the control exists to prevent.
 *
 * Deliberately plain: no navigation, no colour, no actions.
 */
export default async function Annexure1Page({ params }: { params: Promise<{ id: string }> }) {
  const { authorized } = await pageContext(P.PR_VIEW);
  if (!authorized) return <AccessDenied title="Annexure 1" />;

  const { id } = await params;
  const pr = await prisma.purchaseRequisition.findUnique({
    where: { id },
    include: {
      entity: { select: { name: true } },
      department: { select: { name: true } },
      requester: { select: { name: true, title: true } },
      approvedBy: { select: { name: true, title: true } },
      project: { select: { name: true } },
      site: { select: { name: true } },
      deliveryStore: { select: { name: true } },
      items: {
        orderBy: { lineNo: "asc" },
        include: { item: { select: { sku: true } } },
      },
    },
  });
  if (!pr) notFound();

  // One sign-off block on the form, two ways to reach it. APPROVED is the
  // signature; REVIEWED covers a return or rejection, which is also somebody
  // putting their name to a decision and belongs on the sheet.
  const blocks = await attestationBlock("PR", pr.id, ["APPROVED", "REVIEWED"]);
  const signOff = blocks.find((b) => b.signed) ?? blocks[0];

  const lineTotal = pr.items.reduce((a, li) => a + (li.estimatedTotal ?? 0), 0);
  const anyPriced = pr.items.some((li) => li.estimatedUnitPrice != null);
  const anyStockChecked = pr.items.some((li) => li.inStockAtRequest != null);

  // "Req Location" is where the goods are wanted, which is not always the store
  // that receives them. Fall through the records that can answer it rather than
  // printing a blank the requester did supply.
  const reqLocation =
    pr.requiredLocation ??
    pr.site?.name ??
    pr.deliveryStore?.name ??
    pr.deliveryLocationNote ??
    null;

  const field = (label: string, value: React.ReactNode) => (
    <div>
      <dt className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );

  return (
    <div className="mx-auto max-w-[62rem] space-y-5 print:max-w-none">
      <div className="no-print flex items-center justify-between">
        <Link className="link text-xs" href={`/pr/${pr.id}`}>
          ← Back to {pr.number}
        </Link>
        <span className="text-2xs text-[var(--c-text-tertiary)]">
          Print this page to produce the signed requisition form.
        </span>
      </div>

      <div className="card space-y-5 px-6 py-6">
        <header className="border-b border-[var(--c-border)] pb-4 text-center">
          <p className="text-2xs uppercase tracking-widest text-[var(--c-text-tertiary)]">
            {pr.entity.name} · Annexure 1
          </p>
          <h1 className="mt-1 text-base font-semibold">Purchase Requisition</h1>
          <Mono className="mt-1 block text-xs text-[var(--c-text-secondary)]">{pr.number}</Mono>
        </header>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-xs sm:grid-cols-4">
          {field("Document no", <Mono className="text-xs">{pr.number}</Mono>)}
          {field("Document date", fmtDate(pr.createdAt))}
          {field("Required date", fmtDate(pr.requiredDate))}
          {field("Department", pr.department.name)}
          {field("Required by", pr.requester.name)}
          {field("Req location", reqLocation ?? "—")}
          {field("Approved by", pr.approvedBy?.name ?? signOff?.name ?? "—")}
          {field("Approval status", humanize(pr.status))}
        </dl>

        <div>
          <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
            Description / comments
          </p>
          <p className="mt-1 whitespace-pre-line text-xs leading-5">
            {pr.title}
            {pr.justification ? `\n\n${pr.justification}` : ""}
          </p>
        </div>

        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "3rem" }}>Sr.</th>
                <th style={{ width: "7rem" }}>Item code</th>
                <th style={{ minWidth: "14rem" }}>Description</th>
                <th style={{ minWidth: "10rem" }}>Additional comments</th>
                <th style={{ width: "5rem" }} className="text-right">
                  Qty
                </th>
                <th style={{ width: "4rem" }}>UOM</th>
                <th style={{ width: "6rem" }} className="text-right">
                  Unit cost
                </th>
                <th style={{ width: "6.5rem" }} className="text-right">
                  Total cost
                </th>
                <th style={{ width: "5rem" }} className="text-right">
                  In stock
                </th>
              </tr>
            </thead>
            <tbody>
              {pr.items.map((li) => (
                <tr key={li.id}>
                  <td className="tnum">{li.lineNo}</td>
                  <td>
                    <Mono className="text-2xs">{li.itemCode ?? li.item?.sku ?? "—"}</Mono>
                  </td>
                  <td className="text-xs">
                    {li.description}
                    {(li.brand || li.model || li.make) && (
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        {[li.make, li.brand, li.model].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </td>
                  <td className="text-2xs leading-4">
                    {[li.specification, li.notes].filter(Boolean).join(" — ") || "—"}
                  </td>
                  <td className="tnum text-right">{qty(li.quantity)}</td>
                  <td className="text-2xs">{li.unit}</td>
                  <td className="tnum text-right">
                    {li.estimatedUnitPrice != null ? amount(li.estimatedUnitPrice) : "—"}
                  </td>
                  <td className="tnum text-right">
                    {li.estimatedTotal ? amount(li.estimatedTotal) : "—"}
                  </td>
                  <td className="tnum text-right">
                    {li.inStockAtRequest != null ? qty(li.inStockAtRequest) : "—"}
                  </td>
                </tr>
              ))}
              {anyPriced && (
                <tr>
                  <td colSpan={7} className="text-right text-2xs uppercase tracking-wide">
                    Total ({pr.currency})
                  </td>
                  <td className="tnum text-right font-semibold">{amount(lineTotal)}</td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {!anyStockChecked && (
          <p className="no-print text-2xs text-[var(--c-text-tertiary)]">
            The In Stock column is blank because no stock check was recorded when this requisition was raised. The
            column is what the requester could see at the time, so it stays empty rather than being filled with
            today&rsquo;s figure.
          </p>
        )}

        <div>
          <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
            Document comments
          </p>
          <p className="mt-1 min-h-[2.5rem] whitespace-pre-line border-b border-dashed border-[var(--c-border)] pb-2 text-xs leading-5">
            {pr.documentComments ?? ""}
          </p>
        </div>

        <div className="grid gap-8 border-t border-[var(--c-border)] pt-5 sm:grid-cols-[1.4fr_1fr]">
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              HOD / Regional Head — signature
            </p>
            <div className="mt-7 border-b border-[var(--c-text-tertiary)]" />
            <p className="mt-1 text-xs">{signOff?.name ?? "Name"}</p>
            <p className="text-2xs text-[var(--c-text-tertiary)]">
              {signOff?.designation ?? "Designation"}
              {signOff?.roleAtSigning ? ` · ${signOff.roleAtSigning}` : ""}
            </p>
            {signOff?.comment && (
              <p className="mt-1 text-2xs leading-4 text-[var(--c-text-secondary)]">
                {signOff.comment}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-x-5 gap-y-3 text-xs">
            <div>
              <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Date</p>
              <p className="mt-0.5 border-b border-[var(--c-text-tertiary)] pb-1">
                {signOff?.signedAt ? fmtDate(signOff.signedAt) : " "}
              </p>
            </div>
            <div>
              <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Time</p>
              <p className="mt-0.5 border-b border-[var(--c-text-tertiary)] pb-1">
                {signOff?.signedAt ? fmtTime(signOff.signedAt) : " "}
              </p>
            </div>
            <div className="col-span-2">
              <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Stamp</p>
              <div className="mt-1 flex h-14 items-center justify-center border border-dashed border-[var(--c-text-tertiary)]">
                {signOff?.stampRef ? (
                  <Mono className="text-2xs">{signOff.stampRef}</Mono>
                ) : (
                  <span className="text-2xs text-[var(--c-text-tertiary)] print:invisible">
                    Affix stamp
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {!signOff?.signed && (
          <p className="text-2xs text-[var(--c-warning)]">
            Unsigned. Stamp, date and time are compulsory under Annexure 1, and this requisition carries none of them
            yet — the blocks above are left blank rather than filled from the status change.
          </p>
        )}
      </div>

      <p className="no-print text-2xs text-[var(--c-text-tertiary)]">
        Date, time and stamp come from the approval attestation, not from the requisition&rsquo;s status. A status
        change records that the requisition moved; the attestation records who put their name to it and in what office
        — which is what &ldquo;compulsory to ensure compliance&rdquo; is asking for.
      </p>
    </div>
  );
}
