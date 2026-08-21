import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext, first, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { grnReadiness } from "@/server/grn";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { BlockedNotice, Card, EmptyState, PageHeader, RefLink, SectionCard, StatusBadge } from "@/components/ui/primitives";
import { fmtDateTime, qty, round2, toInputDate } from "@/lib/format";
import { GrnForm } from "../GrnForm";

export const metadata = { title: "New GRN" };
export const dynamic = "force-dynamic";

export default async function NewGrnPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { ctx, authorized } = await pageContext(P.GRN_CREATE);
  if (!authorized) {
    return <AccessDenied title="New GRN" message="You do not have permission to create goods receipt notes." />;
  }

  const deliveryId = first((await searchParams).deliveryId);

  if (!deliveryId) {
    const awaiting = await prisma.delivery.findMany({
      where: { po: ctx.entityFilter, grns: { none: {} }, status: { not: "REJECTED" } },
      orderBy: { deliveryDate: "desc" },
      take: 100,
      include: {
        po: { select: { id: true, number: true } },
        vendor: { select: { name: true } },
        store: { select: { name: true } },
        items: { select: { acceptedQty: true } },
        inspections: { select: { result: true } },
      },
    });
    return (
      <div className="space-y-5">
        <Breadcrumbs items={[{ label: "Operations", href: "/grn" }, { label: "GRNs", href: "/grn" }, { label: "New" }]} />
        <PageHeader
          title="Raise a goods receipt note"
          subtitle="A GRN is always raised from a recorded physical receipt. Select the receipt below."
        />
        {awaiting.length === 0 ? (
          <Card>
            <EmptyState
              title="No receipts awaiting a GRN"
              description="Every verified delivery has already been taken into inventory."
              action={
                <Link href="/receiving" className="btn btn-secondary btn-sm">
                  View receiving
                </Link>
              }
            />
          </Card>
        ) : (
          <SectionCard title="Receipts awaiting a GRN" bodyClassName="px-0 py-0">
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>PO</th>
                    <th>Vendor</th>
                    <th>Store</th>
                    <th>Verification</th>
                    <th>Inspection</th>
                    <th className="text-right">Accepted</th>
                    <th>Received</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {awaiting.map((d) => {
                    const blocked = d.inspections.some((i) =>
                      ["PENDING", "IN_PROGRESS", "RE_INSPECTION_REQUIRED", "REJECTED"].includes(i.result),
                    );
                    return (
                      <tr key={d.id}>
                        <td>
                          <RefLink href={`/receiving/${d.id}`}>{d.number}</RefLink>
                        </td>
                        <td>
                          <RefLink href={`/po/${d.po.id}`}>{d.po.number}</RefLink>
                        </td>
                        <td className="text-xs">{d.vendor.name}</td>
                        <td className="text-xs">{d.store.name}</td>
                        <td>
                          <StatusBadge status={d.status} />
                        </td>
                        <td>
                          {d.inspections.length ? (
                            <StatusBadge status={d.inspections[0].result} />
                          ) : (
                            <span className="text-2xs text-[var(--c-text-tertiary)]">Not required</span>
                          )}
                        </td>
                        <td className="num text-xs">{qty(round2(d.items.reduce((a, i) => a + i.acceptedQty, 0)))}</td>
                        <td className="text-xs">{fmtDateTime(d.deliveryDate)}</td>
                        <td>
                          {blocked ? (
                            <span className="text-2xs text-[var(--c-warning)]">Inspection outstanding</span>
                          ) : (
                            <Link href={`/grn/new?deliveryId=${d.id}`} className="btn btn-primary btn-xs">
                              Raise GRN
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </SectionCard>
        )}
      </div>
    );
  }

  const delivery = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    include: {
      po: { select: { id: true, number: true, entityId: true } },
      vendor: { select: { name: true } },
      store: { select: { id: true, name: true, locations: { where: { active: true }, orderBy: { label: "asc" } } } },
      items: {
        orderBy: { lineNo: "asc" },
        include: { poItem: { select: { id: true, quantity: true, acceptedQty: true, unitPrice: true, disposition: true } } },
      },
      inspections: { orderBy: { createdAt: "desc" }, take: 1, include: { items: true } },
    },
  });

  if (!delivery) {
    return <AccessDenied title="New GRN" message="That receipt could not be found." />;
  }

  const readiness = await grnReadiness(delivery.id);
  if (!readiness.ready) {
    return (
      <div className="space-y-5">
        <Breadcrumbs
          items={[
            { label: "Operations", href: "/grn" },
            { label: delivery.number, href: `/receiving/${delivery.id}` },
            { label: "New GRN" },
          ]}
        />
        <PageHeader title="Raise a goods receipt note" subtitle={`${delivery.number} — ${delivery.vendor.name}`} />
        <BlockedNotice title="A GRN cannot be raised for this receipt" reasons={readiness.issues} />
        <Card>
          <Link href={`/receiving/${delivery.id}`} className="btn btn-secondary btn-sm">
            Back to the receipt
          </Link>
        </Card>
      </div>
    );
  }

  const inspection = delivery.inspections[0];

  const lines = delivery.items
    .filter((i) => i.acceptedQty > 0)
    .map((i) => {
      const inspItem = inspection?.items.find((x) => x.poItemId === i.poItemId);
      return {
        deliveryItemId: i.id,
        lineNo: i.lineNo,
        description: i.description,
        unit: i.unit,
        orderedQty: i.orderedQty,
        deliveredQty: i.actualQty,
        acceptedAtReceipt: i.acceptedQty,
        inspectionPassed: inspItem ? inspItem.quantityPassed : null,
        poOutstanding: round2(Math.max(0, i.poItem.quantity - i.poItem.acceptedQty)),
        unitPrice: i.poItem.unitPrice,
        disposition: i.poItem.disposition,
        batchNumber: i.batchNumber,
        serialNumbers: i.serialNumbers,
        expiryDate: i.expiryDate ? toInputDate(i.expiryDate) : null,
        warrantyMonths: i.warrantyMonths,
        discrepancyType: i.discrepancyType,
      };
    });

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Operations", href: "/grn" },
          { label: delivery.number, href: `/receiving/${delivery.id}` },
          { label: "New GRN" },
        ]}
      />
      <PageHeader
        title="Raise a goods receipt note"
        subtitle="The GRN is the official confirmation that goods have entered organisational inventory. Nothing is payable against goods without one."
      />
      <GrnForm
        delivery={{
          id: delivery.id,
          number: delivery.number,
          poId: delivery.po.id,
          poNumber: delivery.po.number,
          vendorName: delivery.vendor.name,
          storeId: delivery.store.id,
          storeName: delivery.store.name,
        }}
        lines={lines}
        locations={delivery.store.locations.map((l) => ({
          id: l.id,
          label: l.label,
          zone: l.zone,
          handling: l.handling,
        }))}
        inspectionStatus={readiness.inspectionStatus}
      />
    </div>
  );
}
