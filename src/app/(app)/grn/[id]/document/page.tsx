import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Mono } from "@/components/ui/primitives";
import { amount, fmtDate, fmtTime, qty } from "@/lib/format";
import { humanize } from "@/lib/domain";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const grn = await prisma.grn.findUnique({ where: { id }, select: { number: true } });
  return { title: grn ? `${grn.number} — Goods receipt note` : "Goods receipt note" };
}

/**
 * The Goods Receipt Note, as the document.
 *
 * Annexure A lists the GRN among the papers that must accompany a payment, and
 * ZAM/PUR/SOP-01 §4.7 puts it at the end of the receiving chain — gate pass,
 * delivery, inspection, receipt. So the sheet shows that chain rather than the
 * receipt alone: the gate serial the goods came in on, the delivery they arrived
 * with, and the inspection that passed them, each named and linked. A receipt
 * that cannot show its inspection is the thing this control exists to catch.
 *
 * Ordered, received, accepted and rejected are printed as four separate columns
 * because they are four different numbers, and a receipt that collapses them
 * cannot be reconciled against either the order or the invoice.
 *
 * Deliberately plain: no navigation, no colour, no actions.
 */
export default async function GrnDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { authorized } = await pageContext(P.GRN_VIEW);
  if (!authorized) return <AccessDenied title="Goods receipt note" />;

  const { id } = await params;
  const grn = await prisma.grn.findUnique({
    where: { id },
    include: {
      po: {
        select: {
          id: true,
          number: true,
          currency: true,
          entity: { select: { name: true } },
          pr: { select: { id: true, number: true, department: { select: { name: true } } } },
        },
      },
      vendor: { select: { name: true, code: true } },
      store: { select: { name: true } },
      delivery: {
        select: {
          id: true,
          number: true,
          deliveryDate: true,
          deliveryNoteRef: true,
        },
      },
      gatePass: {
        select: { id: true, number: true, serial: true, arrivedAt: true, vehicleNumber: true },
      },
      inspection: {
        select: { id: true, number: true, result: true, inspectedAt: true },
      },
      receivedBy: { select: { name: true, title: true } },
      postedBy: { select: { name: true, title: true } },
      items: {
        orderBy: { lineNo: "asc" },
        include: { item: { select: { sku: true } } },
      },
    },
  });
  if (!grn) notFound();

  const totals = grn.items.reduce(
    (a, li) => ({
      ordered: a.ordered + li.orderedQty,
      received: a.received + li.receivedQty,
      accepted: a.accepted + li.acceptedQty,
      rejected: a.rejected + li.rejectedQty,
    }),
    { ordered: 0, received: 0, accepted: 0, rejected: 0 },
  );
  const anyExpiry = grn.items.some((li) => li.expiryDate);
  const anyBatch = grn.items.some((li) => li.batchNumber);

  const field = (label: string, value: React.ReactNode) => (
    <div>
      <dt className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );

  return (
    <div className="mx-auto max-w-[64rem] space-y-5 print:max-w-none">
      <div className="no-print flex items-center justify-between">
        <Link className="link text-xs" href={`/grn/${grn.id}`}>
          ← Back to {grn.number}
        </Link>
        <span className="text-2xs text-[var(--c-text-tertiary)]">
          Print this page to produce the receipt note for the file and for the payment pack.
        </span>
      </div>

      <div className="card space-y-5 px-6 py-6">
        <header className="border-b border-[var(--c-border)] pb-4 text-center">
          <p className="text-2xs uppercase tracking-widest text-[var(--c-text-tertiary)]">
            {grn.po.entity.name}
          </p>
          <h1 className="mt-1 text-base font-semibold">Goods Receipt Note</h1>
          <Mono className="mt-1 block text-xs text-[var(--c-text-secondary)]">{grn.number}</Mono>
        </header>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-xs sm:grid-cols-4">
          {field("Receipt date", fmtDate(grn.receivedAt))}
          {field("Status", humanize(grn.status))}
          {field("Supplier", grn.vendor.name)}
          {field("Store", grn.store.name)}
          {field(
            "Against order",
            <Link className="link" href={`/po/${grn.po.id}/document`}>
              <Mono className="text-xs">{grn.po.number}</Mono>
            </Link>,
          )}
          {field(
            "Against requisition",
            grn.po.pr ? (
              <Link className="link" href={`/pr/${grn.po.pr.id}/annexure-1`}>
                <Mono className="text-xs">{grn.po.pr.number}</Mono>
              </Link>
            ) : (
              "—"
            ),
          )}
          {field("Requesting department", grn.po.pr?.department.name ?? "—")}
          {field("Value", `${grn.po.currency} ${amount(grn.totalValue)}`)}
        </dl>

        {/* The receiving chain, printed as a chain. Each step names its own
            document, so a receipt that skipped one is visible on the sheet
            rather than only in the system. */}
        <div className="grid gap-4 border-y border-[var(--c-border)] py-3 text-xs sm:grid-cols-3">
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Inward gate pass
            </p>
            {grn.gatePass ? (
              <p className="mt-0.5">
                <Link className="link" href={`/gate-passes/${grn.gatePass.id}`}>
                  <Mono className="text-xs">
                    {grn.gatePass.serial}
                  </Mono>
                </Link>
                <span className="ml-1.5 text-2xs text-[var(--c-text-tertiary)]">
                  {fmtDate(grn.gatePass.arrivedAt)}
                  {grn.gatePass.vehicleNumber ? ` · ${grn.gatePass.vehicleNumber}` : ""}
                </span>
              </p>
            ) : (
              <p className="mt-0.5 text-2xs text-[var(--c-warning)]">
                None recorded — §4.7 issues an inward serial at arrival
              </p>
            )}
          </div>
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Delivery</p>
            {grn.delivery ? (
              <p className="mt-0.5">
                <Mono className="text-xs">{grn.delivery.number}</Mono>
                <span className="ml-1.5 text-2xs text-[var(--c-text-tertiary)]">
                  {fmtDate(grn.delivery.deliveryDate)}
                  {grn.delivery.deliveryNoteRef ? ` · DN ${grn.delivery.deliveryNoteRef}` : ""}
                </span>
              </p>
            ) : (
              <p className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">None recorded</p>
            )}
          </div>
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Inspection
            </p>
            {grn.inspection ? (
              <p className="mt-0.5">
                <Link className="link" href={`/inspections/${grn.inspection.id}/annexure-4`}>
                  <Mono className="text-xs">{grn.inspection.number}</Mono>
                </Link>
                <span className="ml-1.5 text-2xs text-[var(--c-text-tertiary)]">
                  {humanize(grn.inspection.result ?? "PENDING")}
                  {grn.inspection.inspectedAt ? ` · ${fmtDate(grn.inspection.inspectedAt)}` : ""}
                </span>
              </p>
            ) : (
              <p className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">
                {grn.inspectionStatus === "NOT_REQUIRED"
                  ? "Not required for this receipt"
                  : humanize(grn.inspectionStatus)}
              </p>
            )}
          </div>
        </div>

        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "3rem" }}>Sr.</th>
                <th style={{ width: "7rem" }}>Item code</th>
                <th style={{ minWidth: "14rem" }}>Description</th>
                {anyBatch && <th style={{ width: "6rem" }}>Batch</th>}
                {anyExpiry && <th style={{ width: "6rem" }}>Expiry</th>}
                <th style={{ width: "4.5rem" }} className="text-right">
                  Ordered
                </th>
                <th style={{ width: "4.5rem" }} className="text-right">
                  Received
                </th>
                <th style={{ width: "4.5rem" }} className="text-right">
                  Accepted
                </th>
                <th style={{ width: "4.5rem" }} className="text-right">
                  Rejected
                </th>
                <th style={{ width: "4rem" }}>UOM</th>
                <th style={{ width: "6.5rem" }} className="text-right">
                  Line value
                </th>
              </tr>
            </thead>
            <tbody>
              {grn.items.map((li) => (
                <tr key={li.id}>
                  <td className="tnum">{li.lineNo}</td>
                  <td>
                    <Mono className="text-2xs">{li.item?.sku ?? "—"}</Mono>
                  </td>
                  <td className="text-xs">
                    {li.description}
                    {li.remarks && (
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        {li.remarks}
                      </span>
                    )}
                  </td>
                  {anyBatch && <td className="text-2xs">{li.batchNumber ?? "—"}</td>}
                  {anyExpiry && (
                    <td className="text-2xs">{li.expiryDate ? fmtDate(li.expiryDate) : "—"}</td>
                  )}
                  <td className="tnum text-right">{qty(li.orderedQty)}</td>
                  <td className="tnum text-right">{qty(li.receivedQty)}</td>
                  <td className="tnum text-right">{qty(li.acceptedQty)}</td>
                  <td className="tnum text-right">
                    {li.rejectedQty ? qty(li.rejectedQty) : "—"}
                  </td>
                  <td className="text-2xs">{li.unit}</td>
                  <td className="tnum text-right">{amount(li.lineValue)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={3 + (anyBatch ? 1 : 0) + (anyExpiry ? 1 : 0)} className="text-2xs uppercase tracking-wide">
                  Total
                </td>
                <td className="tnum text-right font-semibold">{qty(totals.ordered)}</td>
                <td className="tnum text-right font-semibold">{qty(totals.received)}</td>
                <td className="tnum text-right font-semibold">{qty(totals.accepted)}</td>
                <td className="tnum text-right font-semibold">
                  {totals.rejected ? qty(totals.rejected) : "—"}
                </td>
                <td />
                <td className="tnum text-right font-semibold">{amount(grn.totalValue)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {grn.remarks && (
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Remarks</p>
            <p className="mt-1 whitespace-pre-line text-xs leading-5">{grn.remarks}</p>
          </div>
        )}

        {/* Received and posted are two acts and can be two people — the
            segregation the three-way match relies on is between the person who
            took delivery and the person whose act created the stock. */}
        <div className="grid gap-8 border-t border-[var(--c-border)] pt-5 sm:grid-cols-2">
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Received by — Store
            </p>
            <div className="mt-7 border-b border-[var(--c-text-tertiary)]" />
            <p className="mt-1 text-xs">{grn.receivedBy.name}</p>
            <p className="text-2xs text-[var(--c-text-tertiary)]">
              {grn.receivedBy.title ?? "Designation"} · {fmtDate(grn.receivedAt)}{" "}
              {fmtTime(grn.receivedAt)}
            </p>
          </div>
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Posted to inventory by
            </p>
            <div className="mt-7 border-b border-[var(--c-text-tertiary)]" />
            <p className="mt-1 text-xs">{grn.postedBy?.name ?? "Name"}</p>
            <p className="text-2xs text-[var(--c-text-tertiary)]">
              {grn.postedBy?.title ?? "Designation"}
              {grn.postedAt ? ` · ${fmtDate(grn.postedAt)} ${fmtTime(grn.postedAt)}` : " · Date"}
            </p>
            {!grn.postedAt && (
              <p className="mt-1 text-2xs text-[var(--c-warning)]">
                Not yet posted — the goods are received but no stock record exists.
              </p>
            )}
          </div>
        </div>
      </div>

      <p className="no-print text-2xs text-[var(--c-text-tertiary)]">
        Annexure A requires this receipt with the payment. It is the record itself rather than a re-uploaded scan, so
        the payment pack counts it as held — and the order, requisition and inspection are linked above, so the pack
        can be walked in either direction.
      </p>
    </div>
  );
}
