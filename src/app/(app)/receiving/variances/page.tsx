import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, InlineAlert, PageHeader, RefLink, StatTile, StatusBadge } from "@/components/ui/primitives";
import { receivingExceptionStats } from "@/server/receiving-exceptions";
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, money, qty } from "@/lib/format";

export const metadata = { title: "Receipt Variances" };
export const dynamic = "force-dynamic";

/**
 * Differences between what was ordered and what arrived.
 *
 * The specification says a PO-to-GRN mismatch is "zeroed out", which is read here
 * as squared off rather than erased: the order closes, and the difference lives
 * on this screen until somebody says what happened to it — recovered from the
 * vendor, accepted, written off or disputed.
 */
export default async function VariancesPage() {
  const { user, authorized } = await pageContext(P.VARIANCE_VIEW);
  if (!authorized) {
    return <AccessDenied title="Receipt variances" message="You do not have permission to view receipt variances." />;
  }

  const scoped = visibleEntityIds(user);
  const [variances, stats] = await Promise.all([
    prisma.poVariance.findMany({
      where: scoped ? { po: { entityId: { in: scoped } } } : {},
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 400,
      include: {
        po: { select: { id: true, number: true, vendor: { select: { name: true } }, entity: { select: { code: true } } } },
        grn: { select: { id: true, number: true } },
        resolvedBy: { select: { name: true } },
      },
    }),
    receivingExceptionStats(scoped),
  ]);

  const canResolve = userHasPermission(user, P.VARIANCE_RESOLVE);

  const columns: TableColumn[] = [
    { key: "number", header: "Variance", locked: true, sortable: true, width: "10rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "order", header: "Order", sortable: true, width: "11rem" },
    { key: "receipt", header: "Receipt", sortable: true, width: "11rem" },
    { key: "vendor", header: "Vendor", filterable: true, sortable: true, width: "15rem" },
    { key: "type", header: "Type", filterable: true, sortable: true, width: "9rem" },
    { key: "ordered", header: "Ordered", numeric: true, sortable: true, width: "8rem" },
    { key: "received", header: "Received", numeric: true, sortable: true, width: "8rem" },
    { key: "diff", header: "Difference", numeric: true, sortable: true, width: "9rem" },
    { key: "value", header: "Value effect", numeric: true, sortable: true, width: "10rem" },
    { key: "reasonCode", header: "Reason", filterable: true, sortable: true, width: "11rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "10rem" },
    { key: "resolvedBy", header: "Resolved by", sortable: true, width: "12rem" },
    { key: "raised", header: "Raised", sortable: true, width: "9rem" },
    { key: "age", header: "Age (days)", numeric: true, sortable: true, width: "7.5rem", defaultHidden: true },
  ];

  const rows: TableRow[] = variances.map((v) => {
    const valueEffect = (v.grnValue ?? 0) - (v.poValue ?? 0);
    return {
      id: v.id,
      href: `/receiving/variances/${v.id}`,
      flag: v.status === "OPEN" ? (Math.abs(v.variancePct ?? 0) > 10 ? "danger" : "warning") : null,
      search: `${v.number} ${v.po.number} ${v.po.vendor.name} ${v.reasonCode}`,
      values: {
        number: v.number,
        entity: v.po.entity.code,
        order: v.po.number,
        receipt: v.grn?.number ?? "",
        vendor: v.po.vendor.name,
        type: humanize(v.type),
        ordered: v.poQuantity ?? 0,
        received: v.grnQuantity ?? 0,
        diff: v.variance,
        value: valueEffect,
        reasonCode: humanize(v.reasonCode),
        status: humanize(v.status),
        resolvedBy: v.resolvedBy?.name ?? "",
        raised: v.createdAt.toISOString(),
        age: ageDays(v.createdAt) ?? 0,
      },
      cells: {
        number: <RefLink href={`/receiving/variances/${v.id}`}>{v.number}</RefLink>,
        entity: <Badge tone="neutral">{v.po.entity.code}</Badge>,
        order: <RefLink href={`/po/${v.po.id}`}>{v.po.number}</RefLink>,
        receipt: v.grn ? <RefLink href={`/grn/${v.grn.id}`}>{v.grn.number}</RefLink> : "—",
        vendor: v.po.vendor.name,
        type: <Badge tone="neutral">{humanize(v.type)}</Badge>,
        ordered: qty(v.poQuantity ?? 0),
        received: qty(v.grnQuantity ?? 0),
        diff: (
          <span className={v.variance < 0 ? "text-danger-soft-foreground" : "text-warning-soft-foreground"}>
            {v.variance > 0 ? "+" : ""}
            {qty(v.variance)}
            {v.variancePct !== null && ` (${v.variancePct > 0 ? "+" : ""}${v.variancePct}%)`}
          </span>
        ),
        value: money(valueEffect, "PKR", { compact: true }),
        reasonCode: humanize(v.reasonCode),
        status: <StatusBadge status={v.status} />,
        resolvedBy: v.resolvedBy?.name ?? "—",
        raised: fmtDate(v.createdAt),
        age: ageDays(v.createdAt) ?? 0,
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Receiving"
        title="Receipt variances"
        subtitle="Where a receipt did not match its order. The order squares off so it can close; the difference stays here, owned and dated, until it is answered for."
      />

      {stats.openVariances > 0 && (
        <InlineAlert tone={canResolve ? "warning" : "info"}>
          {stats.openVariances} open variance{stats.openVariances === 1 ? "" : "s"} worth{" "}
          {money(stats.varianceValue, "PKR", { compact: true })} in net difference.{" "}
          {canResolve
            ? "Each needs a resolution: recovered, accepted, written off or disputed."
            : "Procurement or finance will resolve these."}
        </InlineAlert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Open variances"
          value={stats.openVariances}
          hint="Awaiting a resolution"
          tone={stats.openVariances ? "warning" : "default"}
        />
        <StatTile
          label="Net difference"
          value={money(stats.varianceValue, "PKR", { compact: true })}
          hint="Across every open variance"
        />
        <StatTile label="Open returns" value={stats.openReturns} hint="Goods going back to vendors" />
        <StatTile
          label="Replacements overdue"
          value={stats.replacementOverdue}
          hint="Past the date the vendor promised"
          tone={stats.replacementOverdue ? "danger" : "default"}
        />
      </div>

      <DataTable
        id="po-variances"
        columns={columns}
        rows={rows}
        exportName="receipt-variances"
        defaultSort={{ key: "raised", dir: "desc" }}
        emptyState={
          <EmptyState
            title="No variances recorded"
            description="Every receipt has matched the quantity its order stated."
          />
        }
      />
    </div>
  );
}
