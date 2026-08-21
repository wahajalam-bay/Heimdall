import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext, first, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { Badge, Card, EmptyState, PageHeader, RefLink, SectionCard } from "@/components/ui/primitives";
import { fmtDate, money, qty, round2, toInputDate } from "@/lib/format";
import { receivingOptions } from "../actions";
import { ReceiveForm } from "../ReceiveForm";

export const metadata = { title: "Record receipt" };
export const dynamic = "force-dynamic";

export default async function NewReceiptPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { ctx, authorized } = await pageContext(P.RECEIVE_GOODS);
  if (!authorized) {
    return <AccessDenied title="Record receipt" message="You do not have permission to record goods receiving." />;
  }

  const poId = first((await searchParams).poId);
  const { stores, openPos } = await receivingOptions(ctx.entityId);

  if (!poId) {
    return (
      <div className="space-y-5">
        <Breadcrumbs items={[{ label: "Operations", href: "/receiving" }, { label: "Record receipt" }]} />
        <PageHeader
          title="Record a goods receipt"
          subtitle="Select the purchase order the delivery is against. Physical verification is always recorded against a specific order."
        />
        {openPos.length === 0 ? (
          <Card>
            <EmptyState
              title="No open purchase orders"
              description="Goods can only be received against an issued purchase order."
              action={
                <Link href="/po" className="btn btn-secondary btn-sm">
                  Browse purchase orders
                </Link>
              }
            />
          </Card>
        ) : (
          <SectionCard title="Open purchase orders awaiting delivery" bodyClassName="px-0 py-0">
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th>PO</th>
                    <th>Vendor</th>
                    <th>Delivery to</th>
                    <th>Promised</th>
                    <th className="text-right">Outstanding</th>
                    <th className="text-right">Value</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {openPos.map((po) => {
                    const outstanding = round2(
                      po.items.reduce((a, i) => a + Math.max(0, i.quantity - i.acceptedQty), 0),
                    );
                    const overdue = po.deliveryDate && po.deliveryDate < new Date();
                    return (
                      <tr key={po.id}>
                        <td>
                          <RefLink href={`/po/${po.id}`}>{po.number}</RefLink>
                        </td>
                        <td className="text-xs">{po.vendor.name}</td>
                        <td className="text-xs">{po.deliveryStore?.name ?? "—"}</td>
                        <td className="text-xs">
                          <span className={overdue ? "text-[var(--c-danger)]" : undefined}>
                            {po.deliveryDate ? fmtDate(po.deliveryDate) : "—"}
                          </span>
                          {overdue && (
                            <span className="ml-1.5">
                              <Badge tone="danger">Overdue</Badge>
                            </span>
                          )}
                        </td>
                        <td className="num text-xs">{qty(outstanding)}</td>
                        <td className="num text-xs">{money(po.total)}</td>
                        <td>
                          <Link href={`/receiving/new?poId=${po.id}`} className="btn btn-primary btn-xs">
                            Receive
                          </Link>
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

  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: {
      vendor: { select: { name: true } },
      deliveryStore: { select: { id: true, name: true } },
      items: { include: { item: { select: { trackSerial: true, trackBatch: true, trackExpiry: true } } }, orderBy: { lineNo: "asc" } },
      gatePasses: {
        where: { status: { in: ["RECORDED", "ROUTED_TO_STORE"] } },
        orderBy: { arrivedAt: "desc" },
        select: { id: true, number: true, serial: true, vehicleNumber: true, arrivedAt: true },
      },
    },
  });

  if (!po) {
    return <AccessDenied title="Record receipt" message="That purchase order could not be found." />;
  }
  if (!["ISSUED", "PARTIALLY_RECEIVED", "APPROVED", "ON_HOLD"].includes(po.status)) {
    return (
      <AccessDenied
        title="Record receipt"
        message={`${po.number} is ${po.status.replace(/_/g, " ").toLowerCase()} — goods cannot be received against it.`}
      />
    );
  }

  const overReceipt = await getConfigNumber(CONFIG_KEYS.ALLOW_EXCESS_RECEIPT_PERCENT, po.entityId);

  const lines = po.items.map((i) => ({
    poItemId: i.id,
    lineNo: i.lineNo,
    description: i.description,
    specification: i.specification,
    unit: i.unit,
    orderedQty: i.quantity,
    alreadyAccepted: i.acceptedQty,
    expectedQty: round2(Math.max(0, i.quantity - i.acceptedQty)),
    unitPrice: i.unitPrice,
    requiresInspection: i.requiresInspection,
    trackSerial: i.item?.trackSerial ?? false,
    trackBatch: i.item?.trackBatch ?? false,
    trackExpiry: i.item?.trackExpiry ?? false,
  }));

  const fullyReceived = lines.every((l) => l.expectedQty <= 0);

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Operations", href: "/receiving" },
          { label: po.number, href: `/po/${po.id}` },
          { label: "Record receipt" },
        ]}
      />
      <PageHeader
        title={`Physical verification — ${po.number}`}
        subtitle="Verify quantity, weight, specification, condition and packaging before anything is accepted. Discrepancies are recorded, never suppressed."
      />
      {fullyReceived ? (
        <Card>
          <EmptyState
            title="Nothing outstanding on this order"
            description="Every line has already been fully accepted. If goods have arrived in excess, the over-receipt policy applies and must be raised with procurement."
            action={
              <Link href={`/po/${po.id}`} className="btn btn-secondary btn-sm">
                Back to the order
              </Link>
            }
          />
        </Card>
      ) : (
        <ReceiveForm
          po={{
            id: po.id,
            number: po.number,
            vendorName: po.vendor.name,
            deliveryStoreId: po.deliveryStoreId,
            deliveryStoreName: po.deliveryStore?.name ?? null,
            deliveryDate: po.deliveryDate ? fmtDate(po.deliveryDate) : null,
            isOverdue: Boolean(po.deliveryDate && po.deliveryDate < new Date()),
          }}
          lines={lines}
          stores={stores}
          gatePasses={po.gatePasses.map((g) => ({
            id: g.id,
            number: g.number,
            serial: g.serial,
            vehicleNumber: g.vehicleNumber,
            arrivedAt: toInputDate(g.arrivedAt),
          }))}
          overReceiptPercent={overReceipt}
        />
      )}
    </div>
  );
}
