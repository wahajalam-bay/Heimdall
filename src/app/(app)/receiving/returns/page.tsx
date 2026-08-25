import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, InlineAlert, PageHeader, RefLink, StatTile, StatusBadge } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, money } from "@/lib/format";

export const metadata = { title: "Vendor Returns" };
export const dynamic = "force-dynamic";

/**
 * Goods going back, and what is owed in their place.
 *
 * A return is not finished when the lorry leaves. It is finished when a
 * replacement arrives or a credit note does — so the register is ordered by what
 * is still owed, and a replacement past its promised date is flagged.
 */
export default async function ReturnsPage() {
  const { user, authorized } = await pageContext(P.RETURN_VIEW);
  if (!authorized) {
    return <AccessDenied title="Vendor returns" message="You do not have permission to view vendor returns." />;
  }

  const scoped = visibleEntityIds(user);
  const returns = await prisma.vendorReturn.findMany({
    where: scoped ? { OR: [{ po: { entityId: { in: scoped } } }, { poId: null }] } : {},
    orderBy: [{ createdAt: "desc" }],
    take: 400,
    include: {
      vendor: { select: { id: true, name: true, status: true } },
      po: { select: { id: true, number: true, entity: { select: { code: true } } } },
      grn: { select: { id: true, number: true } },
      raisedBy: { select: { name: true } },
      items: { select: { id: true, quantity: true } },
      rejections: { select: { id: true, number: true } },
    },
  });

  const open = returns.filter((r) => !["CLOSED", "CANCELLED"].includes(r.status));
  const overdue = open.filter(
    (r) => r.replacementStatus === "AWAITED" && r.replacementDueDate && r.replacementDueDate < new Date(),
  );
  const value = returns
    .filter((r) => !["CLOSED", "CANCELLED"].includes(r.status))
    .reduce((a, r) => a + r.totalValue, 0);

  const columns: TableColumn[] = [
    { key: "number", header: "Return", locked: true, sortable: true, width: "10rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "vendor", header: "Vendor", filterable: true, sortable: true, width: "16rem" },
    { key: "order", header: "Order", sortable: true, width: "11rem" },
    { key: "receipt", header: "Receipt", sortable: true, width: "11rem" },
    { key: "lines", header: "Lines", numeric: true, sortable: true, width: "6rem" },
    { key: "value", header: "Value", numeric: true, sortable: true, width: "10rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "12rem" },
    { key: "replacement", header: "Replacement", filterable: true, sortable: true, width: "12rem" },
    { key: "due", header: "Replacement due", sortable: true, width: "11rem" },
    { key: "findings", header: "Findings", numeric: true, sortable: true, width: "8rem", defaultHidden: true },
    { key: "raisedBy", header: "Raised by", sortable: true, width: "12rem" },
    { key: "raised", header: "Raised", sortable: true, width: "9rem" },
    { key: "age", header: "Age (days)", numeric: true, sortable: true, width: "7.5rem", defaultHidden: true },
  ];

  const rows: TableRow[] = returns.map((r) => {
    const late =
      r.replacementStatus === "AWAITED" && r.replacementDueDate && r.replacementDueDate < new Date();
    return {
      id: r.id,
      href: `/receiving/returns/${r.id}`,
      flag: late ? "danger" : r.status === "CLOSED" ? "success" : open.includes(r) ? "warning" : null,
      search: `${r.number} ${r.vendor.name} ${r.po?.number ?? ""} ${r.reason}`,
      values: {
        number: r.number,
        entity: r.po?.entity.code ?? "",
        vendor: r.vendor.name,
        order: r.po?.number ?? "",
        receipt: r.grn?.number ?? "",
        lines: r.items.length,
        value: r.totalValue,
        status: humanize(r.status),
        replacement: humanize(r.replacementStatus),
        due: r.replacementDueDate ? r.replacementDueDate.toISOString() : "",
        findings: r.rejections.length,
        raisedBy: r.raisedBy.name,
        raised: r.createdAt.toISOString(),
        age: ageDays(r.createdAt) ?? 0,
      },
      cells: {
        number: <RefLink href={`/receiving/returns/${r.id}`}>{r.number}</RefLink>,
        entity: r.po ? <Badge tone="neutral">{r.po.entity.code}</Badge> : "—",
        vendor: r.vendor.name,
        order: r.po ? <RefLink href={`/po/${r.po.id}`}>{r.po.number}</RefLink> : "—",
        receipt: r.grn ? <RefLink href={`/grn/${r.grn.id}`}>{r.grn.number}</RefLink> : "—",
        lines: r.items.length,
        value: money(r.totalValue, r.currency, { compact: true }),
        status: <StatusBadge status={r.status} />,
        replacement:
          r.replacementStatus === "NOT_REQUIRED" ? (
            <span className="text-[var(--c-text-tertiary)]">Not required</span>
          ) : (
            <Badge tone={r.replacementStatus === "AWAITED" ? (late ? "danger" : "warning") : "success"}>
              {humanize(r.replacementStatus)}
            </Badge>
          ),
        due: r.replacementDueDate ? (
          <span className={late ? "text-danger-soft-foreground" : undefined}>{fmtDate(r.replacementDueDate)}</span>
        ) : (
          "—"
        ),
        findings: r.rejections.length,
        raisedBy: r.raisedBy.name,
        raised: fmtDate(r.createdAt),
        age: ageDays(r.createdAt) ?? 0,
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Receiving"
        title="Vendor returns"
        subtitle="Goods refused and sent back. A return closes only when the replacement arrives or a credit note does."
      />

      {overdue.length > 0 && (
        <InlineAlert tone="danger">
          {overdue.length} replacement{overdue.length === 1 ? "" : "s"} past the date the vendor promised. These belong
          in the next vendor performance review.
        </InlineAlert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Open returns" value={open.length} hint="Not yet closed" tone={open.length ? "warning" : "default"} />
        <StatTile label="Value out" value={money(value, "PKR", { compact: true })} hint="Goods away from site" />
        <StatTile
          label="Replacements awaited"
          value={open.filter((r) => r.replacementStatus === "AWAITED").length}
          hint="Vendor owes goods"
        />
        <StatTile
          label="Overdue"
          value={overdue.length}
          hint="Past the promised date"
          tone={overdue.length ? "danger" : "default"}
        />
      </div>

      <DataTable
        id="vendor-returns"
        columns={columns}
        rows={rows}
        exportName="vendor-returns"
        defaultSort={{ key: "raised", dir: "desc" }}
        emptyState={
          <EmptyState
            title="No returns raised"
            description="Nothing has been refused and sent back to a vendor."
          />
        }
      />
    </div>
  );
}
