import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, PageHeader, RefLink, StatTile, StatusBadge } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { ageHours, fmtDateTime, money, qty, round2 } from "@/lib/format";

export const metadata = { title: "Receiving" };
export const dynamic = "force-dynamic";

export default async function ReceivingPage() {
  const { user, ctx, authorized } = await pageContext(P.RECEIVING_VIEW, P.RECEIVE_GOODS);
  if (!authorized) {
    return <AccessDenied title="Receiving" message="You do not have permission to view deliveries." />;
  }

  const [deliveries, grnSla, savedViews] = await Promise.all([
    prisma.delivery.findMany({
      where: { po: ctx.entityFilter },
      orderBy: { deliveryDate: "desc" },
      take: 400,
      include: {
        po: { select: { id: true, number: true, entity: { select: { code: true } } } },
        vendor: { select: { id: true, name: true } },
        store: { select: { id: true, name: true, kind: true } },
        receivedBy: { select: { name: true } },
        items: { select: { id: true, actualQty: true, acceptedQty: true, rejectedQty: true, discrepancyType: true, unit: true } },
        inspections: { select: { id: true, number: true, result: true } },
        grns: { select: { id: true, number: true, status: true, totalValue: true } },
        gatePass: { select: { id: true, number: true } },
      },
    }),
    getConfigNumber(CONFIG_KEYS.SLA_GRN_HOURS, ctx.entityId),
    prisma.savedView.findMany({
      where: { resource: "receiving", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const awaitingGrn = deliveries.filter((d) => d.grns.length === 0 && d.status !== "REJECTED");
  const blockedByInspection = awaitingGrn.filter((d) =>
    d.inspections.some((i) => ["PENDING", "IN_PROGRESS", "RE_INSPECTION_REQUIRED"].includes(i.result)),
  );
  const overdueGrn = awaitingGrn.filter((d) => (ageHours(d.deliveryDate) ?? 0) > grnSla);
  const withDiscrepancy = deliveries.filter((d) => d.items.some((i) => i.discrepancyType !== "OK"));

  const columns: TableColumn[] = [
    { key: "number", header: "Receipt", locked: true, sortable: true, width: "9.5rem" },
    { key: "po", header: "PO", sortable: true, width: "9.5rem" },
    { key: "vendor", header: "Vendor", sortable: true, minWidth: "13rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "store", header: "Store", filterable: true, sortable: true, width: "14rem" },
    { key: "status", header: "Verification", filterable: true, sortable: true, width: "13rem" },
    { key: "delivered", header: "Delivered", numeric: true, sortable: true, width: "8rem" },
    { key: "accepted", header: "Accepted", numeric: true, sortable: true, width: "8rem" },
    { key: "rejected", header: "Rejected", numeric: true, sortable: true, width: "8rem" },
    { key: "discrepancies", header: "Discrepancies", sortable: true, width: "13rem" },
    { key: "inspection", header: "Inspection", filterable: true, sortable: true, width: "11rem" },
    { key: "grn", header: "GRN", sortable: true, width: "11rem" },
    { key: "gatePass", header: "Gate pass", sortable: true, width: "9.5rem", defaultHidden: true },
    { key: "receivedBy", header: "Received by", sortable: true, width: "12rem", defaultHidden: true },
    { key: "date", header: "Received", sortable: true, width: "12rem" },
    { key: "waiting", header: "Age", numeric: true, sortable: true, width: "6rem" },
  ];

  const rows: TableRow[] = deliveries.map((d) => {
    const delivered = round2(d.items.reduce((a, i) => a + i.actualQty, 0));
    const accepted = round2(d.items.reduce((a, i) => a + i.acceptedQty, 0));
    const rejected = round2(d.items.reduce((a, i) => a + i.rejectedQty, 0));
    const discrepancies = d.items.filter((i) => i.discrepancyType !== "OK");
    const pendingInsp = d.inspections.filter((i) =>
      ["PENDING", "IN_PROGRESS", "RE_INSPECTION_REQUIRED"].includes(i.result),
    );
    const grn = d.grns[0];
    const hours = ageHours(d.deliveryDate) ?? 0;
    const grnOverdue = !grn && d.status !== "REJECTED" && hours > grnSla;

    return {
      id: d.id,
      href: `/receiving/${d.id}`,
      flag: grnOverdue ? "danger" : discrepancies.length ? "warning" : grn ? "success" : null,
      search: `${d.number} ${d.po.number} ${d.vendor.name} ${d.deliveryNoteRef ?? ""}`,
      values: {
        number: d.number,
        po: d.po.number,
        vendor: d.vendor.name,
        entity: d.po.entity.code,
        store: d.store.name,
        status: humanize(d.status),
        delivered,
        accepted,
        rejected,
        discrepancies: discrepancies.length,
        inspection: pendingInsp.length
          ? "Pending"
          : d.inspections.length
            ? humanize(d.inspections[0].result)
            : "Not required",
        grn: grn?.number ?? "",
        gatePass: d.gatePass?.number ?? "",
        receivedBy: d.receivedBy.name,
        date: d.deliveryDate.toISOString(),
        waiting: Math.floor(hours / 24),
      },
      cells: {
        number: <RefLink href={`/receiving/${d.id}`}>{d.number}</RefLink>,
        po: <RefLink href={`/po/${d.po.id}`}>{d.po.number}</RefLink>,
        vendor: <RefLink href={`/vendors/${d.vendor.id}`}>{d.vendor.name}</RefLink>,
        entity: <Badge tone="neutral">{d.po.entity.code}</Badge>,
        store: (
          <span>
            <RefLink href={`/stores/${d.store.id}`}>{d.store.name}</RefLink>
            <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{humanize(d.store.kind)}</span>
          </span>
        ),
        status: <StatusBadge status={d.status} />,
        delivered: qty(delivered),
        accepted: <span className="font-500">{qty(accepted)}</span>,
        rejected: rejected > 0 ? <span className="text-[var(--c-danger)]">{qty(rejected)}</span> : "—",
        discrepancies: discrepancies.length ? (
          <span className="flex flex-wrap gap-1">
            {[...new Set(discrepancies.map((x) => x.discrepancyType))].map((t) => (
              <Badge key={t} tone="warning">
                {humanize(t)}
              </Badge>
            ))}
          </span>
        ) : (
          <Badge tone="success">Clean</Badge>
        ),
        inspection: pendingInsp.length ? (
          <Link href={`/inspections/${pendingInsp[0].id}`}>
            <Badge tone="warning">{humanize(pendingInsp[0].result)}</Badge>
          </Link>
        ) : d.inspections.length ? (
          <Link href={`/inspections/${d.inspections[0].id}`}>
            <Badge tone={d.inspections[0].result === "APPROVED" ? "success" : "danger"}>
              {humanize(d.inspections[0].result)}
            </Badge>
          </Link>
        ) : (
          <span className="text-2xs text-[var(--c-text-tertiary)]">Not required</span>
        ),
        grn: grn ? (
          <Link href={`/grn/${grn.id}`} className="badge badge-success">
            {grn.number}
          </Link>
        ) : pendingInsp.length ? (
          <Badge tone="warning">Blocked by inspection</Badge>
        ) : userHasPermission(user, P.GRN_CREATE) ? (
          <Link href={`/grn/new?deliveryId=${d.id}`} className="btn btn-primary btn-xs">
            Raise GRN
          </Link>
        ) : (
          <Badge tone="warning">Pending</Badge>
        ),
        gatePass: d.gatePass ? <RefLink href={`/gate-passes/${d.gatePass.id}`}>{d.gatePass.number}</RefLink> : "—",
        receivedBy: d.receivedBy.name,
        date: fmtDateTime(d.deliveryDate),
        waiting: (
          <span className={grnOverdue ? "tnum text-[var(--c-danger)]" : "tnum"}>{Math.floor(hours / 24)}d</span>
        ),
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Operations"
        title="Goods receiving"
        subtitle={`Physical verification of every delivery. A GRN is expected within ${grnSla} hours of receipt; until one is posted the goods are not in inventory.`}
        actions={
          userHasPermission(user, P.RECEIVE_GOODS) && (
            <Link href="/receiving/new" className="btn btn-primary btn-sm">
              Record receipt
            </Link>
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Receipts recorded" value={deliveries.length} />
        <StatTile
          label="Awaiting GRN"
          value={awaitingGrn.length}
          hint="Received but not in inventory"
          tone={awaitingGrn.length ? "warning" : "default"}
        />
        <StatTile
          label="GRN overdue"
          value={overdueGrn.length}
          hint={`Beyond the ${grnSla}-hour target`}
          tone={overdueGrn.length ? "danger" : "default"}
        />
        <StatTile
          label="Blocked by inspection"
          value={blockedByInspection.length}
          hint="Mandatory inspection outstanding"
          tone={blockedByInspection.length ? "warning" : "default"}
        />
        <StatTile
          label="With discrepancy"
          value={withDiscrepancy.length}
          hint="Short, damaged or wrong item"
          tone={withDiscrepancy.length ? "warning" : "default"}
        />
      </div>

      <DataTable
        id="receiving"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "date", dir: "desc" }}
        exportName="goods-receipts"
        emptyState={
          <EmptyState
            title="No receipts recorded"
            description="Deliveries appear here once the store performs physical verification against a purchase order."
            action={
              userHasPermission(user, P.RECEIVE_GOODS) && (
                <Link href="/receiving/new" className="btn btn-primary btn-sm">
                  Record receipt
                </Link>
              )
            }
          />
        }
      />
    </div>
  );
}
