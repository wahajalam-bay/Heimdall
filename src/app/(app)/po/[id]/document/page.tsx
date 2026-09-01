import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Mono } from "@/components/ui/primitives";
import { amount, fmtDate, fmtTime, percent, qty } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { PO_ACKNOWLEDGEMENT_LABELS, type PoAcknowledgementState } from "@/server/po";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    select: { number: true },
  });
  return { title: po ? `${po.number} — Purchase order` : "Purchase order" };
}

/**
 * The purchase order, as the document that goes to the vendor.
 *
 * ZAM/PUR/SOP-01 §4.6: the order is issued to the vendor "with the signature of
 * Manager Procurement or other authorized signatory". So the sheet carries that
 * signature — the recorded authorised signatory and the minute they signed —
 * rather than a blank line, because the order in the system was signed by
 * somebody and the paper should say who.
 *
 * Annexure A lists the PO as one of the documents that must accompany the
 * payment. This is that document: nothing on it is typed in, every line comes
 * from the order, and the requisition it serves is named at the top so the pack
 * can be followed backwards from the invoice to the demand.
 *
 * Deliberately plain: no navigation, no colour, no actions.
 */
export default async function PoDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { authorized } = await pageContext(P.PO_VIEW);
  if (!authorized) return <AccessDenied title="Purchase order" />;

  const { id } = await params;
  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: {
      entity: { select: { name: true } },
      vendor: {
        select: {
          name: true,
          code: true,
          address: true,
          city: true,
          contactPerson: true,
          contactPhone: true,
          contactEmail: true,
        },
      },
      pr: {
        select: {
          id: true,
          number: true,
          department: { select: { name: true } },
          requester: { select: { name: true } },
        },
      },
      deliveryStore: { select: { name: true } },
      createdBy: { select: { name: true, title: true } },
      authorisedSignatory: { select: { name: true, title: true } },
      items: {
        orderBy: { lineNo: "asc" },
        include: { item: { select: { sku: true } } },
      },
    },
  });
  if (!po) notFound();

  const anyTax = po.items.some((li) => li.taxRate > 0);

  const field = (label: string, value: React.ReactNode) => (
    <div>
      <dt className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );

  const totalRow = (label: string, value: number, strong = false) => (
    <div className="flex items-baseline justify-between gap-6 py-0.5">
      <span className={strong ? "text-xs font-semibold" : "text-xs text-muted"}>{label}</span>
      <span className={strong ? "tnum text-xs font-semibold" : "tnum text-xs"}>{amount(value)}</span>
    </div>
  );

  return (
    <div className="mx-auto max-w-[62rem] space-y-5 print:max-w-none">
      <div className="no-print flex items-center justify-between">
        <Link className="link text-xs" href={`/po/${po.id}`}>
          ← Back to {po.number}
        </Link>
        <span className="text-2xs text-[var(--c-text-tertiary)]">
          Print this page to produce the order for the vendor and for the payment pack.
        </span>
      </div>

      <div className="card space-y-5 px-6 py-6">
        <header className="border-b border-[var(--c-border)] pb-4 text-center">
          <p className="text-2xs uppercase tracking-widest text-[var(--c-text-tertiary)]">
            {po.entity.name}
          </p>
          <h1 className="mt-1 text-base font-semibold">Purchase Order</h1>
          <Mono className="mt-1 block text-xs text-[var(--c-text-secondary)]">{po.number}</Mono>
        </header>

        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Supplier</p>
            <p className="mt-1 text-xs font-semibold">{po.vendor.name}</p>
            <p className="mt-0.5 whitespace-pre-line text-2xs leading-4 text-[var(--c-text-secondary)]">
              {po.vendorAddress ??
                [po.vendor.address, po.vendor.city].filter(Boolean).join(", ") ??
                ""}
            </p>
            <p className="mt-0.5 text-2xs text-[var(--c-text-secondary)]">
              {[po.vendorContact ?? po.vendor.contactPerson, po.vendor.contactPhone, po.vendor.contactEmail]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Deliver to
            </p>
            <p className="mt-1 text-xs font-semibold">{po.deliveryStore?.name ?? "—"}</p>
            <p className="mt-0.5 whitespace-pre-line text-2xs leading-4 text-[var(--c-text-secondary)]">
              {po.deliveryAddress ?? ""}
            </p>
            {po.deliveryDate && (
              <p className="mt-0.5 text-2xs text-[var(--c-text-secondary)]">
                Required by {fmtDate(po.deliveryDate)}
              </p>
            )}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 border-y border-[var(--c-border)] py-3 text-xs sm:grid-cols-4">
          {field("Order date", fmtDate(po.issuedAt ?? po.createdAt))}
          {field("Status", humanize(po.status))}
          {field(
            "Against requisition",
            po.pr ? (
              <Link className="link" href={`/pr/${po.pr.id}/annexure-1`}>
                <Mono className="text-xs">{po.pr.number}</Mono>
              </Link>
            ) : (
              "—"
            ),
          )}
          {field("Requesting department", po.pr?.department.name ?? "—")}
          {field("Payment terms", po.paymentTerms ?? (po.creditDays ? `${po.creditDays} days` : "—"))}
          {field("Warranty", po.warrantyTerms ?? "—")}
          {field("Incoterms", po.incoterms ?? "—")}
          {field("Currency", po.currency)}
        </dl>

        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "3rem" }}>Sr.</th>
                <th style={{ width: "7rem" }}>Item code</th>
                <th style={{ minWidth: "16rem" }}>Description</th>
                <th style={{ width: "5rem" }} className="text-right">
                  Qty
                </th>
                <th style={{ width: "4rem" }}>UOM</th>
                <th style={{ width: "6.5rem" }} className="text-right">
                  Unit price
                </th>
                {anyTax && (
                  <th style={{ width: "4.5rem" }} className="text-right">
                    Tax
                  </th>
                )}
                <th style={{ width: "7rem" }} className="text-right">
                  Line total
                </th>
              </tr>
            </thead>
            <tbody>
              {po.items.map((li) => (
                <tr key={li.id}>
                  <td className="tnum">{li.lineNo}</td>
                  <td>
                    <Mono className="text-2xs">{li.item?.sku ?? "—"}</Mono>
                  </td>
                  <td className="text-xs">
                    {li.description}
                    {(li.brand || li.model || li.specification) && (
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        {[li.brand, li.model, li.specification].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </td>
                  <td className="tnum text-right">{qty(li.quantity)}</td>
                  <td className="text-2xs">{li.unit}</td>
                  <td className="tnum text-right">{amount(li.unitPrice)}</td>
                  {anyTax && (
                    <td className="tnum text-right text-2xs">
                      {li.taxRate ? percent(li.taxRate, 1) : "—"}
                    </td>
                  )}
                  <td className="tnum text-right">{amount(li.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex justify-end">
          <div className="w-full max-w-[20rem] border-t border-[var(--c-border)] pt-2">
            {totalRow("Subtotal", po.subtotal)}
            {po.discount > 0 && totalRow("Discount", -po.discount)}
            {po.taxAmount > 0 && totalRow("Tax", po.taxAmount)}
            {po.deliveryCharges > 0 && totalRow("Delivery", po.deliveryCharges)}
            {po.otherCharges > 0 && totalRow("Other charges", po.otherCharges)}
            <div className="mt-1 border-t border-[var(--c-text-tertiary)] pt-1">
              {totalRow(`Total (${po.currency})`, po.total, true)}
            </div>
          </div>
        </div>

        {po.advanceRequired && (
          <div className="border border-[var(--c-border)] px-3 py-2 text-xs">
            <span className="font-semibold">Advance: </span>
            {po.advanceAmount != null ? amount(po.advanceAmount) : ""}
            {po.advancePercent != null ? ` (${percent(po.advancePercent, 0)})` : ""}
            {po.collateralType ? ` · secured by ${humanize(po.collateralType)}` : ""}
            {po.collateralRef ? ` ${po.collateralRef}` : ""}
          </div>
        )}

        {po.termsConditions && (
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Terms and conditions
            </p>
            <p className="mt-1 whitespace-pre-line text-2xs leading-4">{po.termsConditions}</p>
          </div>
        )}

        <div className="grid gap-8 border-t border-[var(--c-border)] pt-5 sm:grid-cols-[1.3fr_1fr]">
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Authorised signatory — Procurement
            </p>
            <div className="mt-7 border-b border-[var(--c-text-tertiary)]" />
            <p className="mt-1 text-xs">{po.authorisedSignatory?.name ?? "Name"}</p>
            <p className="text-2xs text-[var(--c-text-tertiary)]">
              {po.authorisedSignatory?.title ?? "Designation"}
              {po.signedAt ? ` · ${fmtDate(po.signedAt)} ${fmtTime(po.signedAt)}` : " · Date"}
            </p>
            {!po.authorisedSignatory && (
              <p className="mt-1 text-2xs text-[var(--c-warning)]">
                No authorised signatory recorded. §4.6 requires the order to carry one before it goes to the vendor.
              </p>
            )}
            <p className="mt-2 text-2xs text-[var(--c-text-tertiary)]">
              Prepared by {po.createdBy.name}
              {po.createdBy.title ? `, ${po.createdBy.title}` : ""}
            </p>
          </div>

          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Supplier acknowledgement
            </p>
            <div className="mt-7 border-b border-[var(--c-text-tertiary)]" />
            <p className="mt-1 text-xs">{po.acknowledgedByName ?? "Name and signature"}</p>
            <p className="text-2xs text-[var(--c-text-tertiary)]">
              {PO_ACKNOWLEDGEMENT_LABELS[po.acknowledgementStatus as PoAcknowledgementState] ??
                humanize(po.acknowledgementStatus)}
              {po.acknowledgedAt ? ` · ${fmtDate(po.acknowledgedAt)}` : ""}
            </p>
            {po.acknowledgementDueAt && po.acknowledgementStatus === "PENDING" && (
              <p className="mt-1 text-2xs text-[var(--c-text-tertiary)]">
                Confirmation due {fmtDate(po.acknowledgementDueAt)}
              </p>
            )}
          </div>
        </div>
      </div>

      <p className="no-print text-2xs text-[var(--c-text-tertiary)]">
        Annexure A requires this order with the payment. It is the record itself rather than a re-uploaded scan, so the
        payment pack counts it as held — and the requisition is linked above, so the pack can be walked back from the
        invoice to the demand that started it.
      </p>
    </div>
  );
}
