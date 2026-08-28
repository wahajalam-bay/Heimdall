import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, Meter, PageHeader, RefLink, StatTile, StatusBadge } from "@/components/ui/primitives";
import { PO_STATUSES, humanize } from "@/lib/domain";
import { ageDays, fmtDate, money, qty, round2 } from "@/lib/format";
import { statusLink, tableLink } from "@/lib/links";

export const metadata = { title: "Purchase Orders" };
export const dynamic = "force-dynamic";

export default async function PoListPage() {
  const { user, ctx, authorized } = await pageContext(P.PO_VIEW);
  if (!authorized) {
    return <AccessDenied title="Purchase Orders" message="You do not have permission to view purchase orders." />;
  }

  const [pos, savedViews] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where: ctx.entityFilter,
      orderBy: { createdAt: "desc" },
      take: 500,
      include: {
        entity: { select: { code: true } },
        vendor: { select: { id: true, name: true, status: true } },
        pr: { select: { id: true, number: true, title: true, department: { select: { name: true } } } },
        deliveryStore: { select: { name: true } },
        createdBy: { select: { name: true } },
        items: { select: { quantity: true, acceptedQty: true, unitPrice: true, invoicedQty: true } },
        grns: { where: { status: "POSTED" }, select: { id: true } },
        invoices: { select: { id: true, status: true, matchStatus: true, total: true } },
        exceptions: { where: { status: { in: ["OPEN", "IN_PROGRESS"] } }, select: { id: true, severity: true } },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "pos", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const now = new Date();
  // Named once so the tile's figure and the filter it links to are read from the
  // same list — the two drift the moment they are spelled out separately.
  const LIVE_STATUSES = PO_STATUSES.filter((st) => st !== "CANCELLED" && st !== "CLOSED");
  const UNSETTLED_ADVANCE = ["PENDING", "APPROVED", "PAID"];
  const live = pos.filter((p) => !["CANCELLED", "CLOSED"].includes(p.status));
  const stats = {
    live: live.length,
    liveValue: round2(live.reduce((a, p) => a + p.total, 0)),
    pendingApproval: pos.filter((p) => p.status === "PENDING_APPROVAL").length,
    awaitingIssue: pos.filter((p) => p.status === "APPROVED").length,
    overdue: pos.filter(
      (p) => ["ISSUED", "PARTIALLY_RECEIVED"].includes(p.status) && p.deliveryDate && p.deliveryDate < now,
    ).length,
    withAdvance: pos.filter((p) => p.advanceRequired && p.advanceStatus !== "SETTLED").length,
  };

  const columns: TableColumn[] = [
    { key: "number", header: "PO", locked: true, sortable: true, width: "9.5rem" },
    { key: "vendor", header: "Vendor", sortable: true, minWidth: "14rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "pr", header: "Requisition", sortable: true, width: "9.5rem" },
    { key: "department", header: "Department", filterable: true, sortable: true, width: "11rem", defaultHidden: true },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "11rem" },
    { key: "total", header: "Value", numeric: true, sortable: true, width: "10.5rem" },
    { key: "received", header: "Received", sortable: false, width: "9rem" },
    { key: "pendingValue", header: "Pending value", numeric: true, sortable: true, width: "11rem" },
    { key: "store", header: "Delivery to", sortable: true, width: "13rem" },
    { key: "deliveryDate", header: "Promised", sortable: true, width: "8.5rem" },
    { key: "issued", header: "Issued", sortable: true, width: "8.5rem", defaultHidden: true },
    { key: "grns", header: "GRNs", numeric: true, sortable: true, width: "5.5rem" },
    { key: "invoices", header: "Invoices", numeric: true, sortable: true, width: "6.5rem" },
    { key: "advance", header: "Advance", filterable: true, sortable: true, width: "9rem", defaultHidden: true },
    { key: "buyer", header: "Raised by", sortable: true, width: "11rem", defaultHidden: true },
    { key: "age", header: "Age", numeric: true, sortable: true, width: "5rem" },
    { key: "flags", header: "Flags", sortable: false, minWidth: "11rem" },
    // Lateness is not a status, so no status filter reaches it. The tile counting
    // overdue deliveries points here, and it doubles as a control of its own.
    { key: "delivery", header: "Delivery", filterable: true, sortable: true, width: "9rem", defaultHidden: true },
  ];

  const rows: TableRow[] = pos.map((po) => {
    const ordered = round2(po.items.reduce((a, i) => a + i.quantity, 0));
    const accepted = round2(po.items.reduce((a, i) => a + i.acceptedQty, 0));
    const pendingValue = round2(
      po.items.reduce((a, i) => a + Math.max(0, i.quantity - i.acceptedQty) * i.unitPrice, 0),
    );
    const overdue = ["ISSUED", "PARTIALLY_RECEIVED"].includes(po.status) && po.deliveryDate && po.deliveryDate < now;
    const mismatch = po.invoices.some((i) => i.matchStatus === "FAILED");
    return {
      id: po.id,
      href: `/po/${po.id}`,
      flag: mismatch ? "danger" : overdue ? "warning" : po.status === "CLOSED" ? "success" : null,
      search: `${po.number} ${po.vendor.name} ${po.pr?.number ?? ""} ${po.pr?.title ?? ""}`,
      values: {
        number: po.number,
        vendor: po.vendor.name,
        entity: po.entity.code,
        pr: po.pr?.number ?? "",
        department: po.pr?.department.name ?? "",
        status: humanize(po.status),
        total: po.total,
        received: ordered ? Math.round((accepted / ordered) * 100) : 0,
        pendingValue,
        store: po.deliveryStore?.name ?? "",
        deliveryDate: po.deliveryDate ? po.deliveryDate.toISOString().slice(0, 10) : "",
        issued: po.issuedAt ? po.issuedAt.toISOString().slice(0, 10) : "",
        grns: po.grns.length,
        invoices: po.invoices.length,
        advance: po.advanceRequired ? humanize(po.advanceStatus ?? "PENDING") : "",
        buyer: po.createdBy.name,
        age: ageDays(po.createdAt) ?? 0,
        flags: [overdue ? "Overdue" : "", mismatch ? "Invoice mismatch" : "", po.exceptions.length ? "Exception" : ""]
          .filter(Boolean)
          .join(" "),
        delivery: overdue ? "Overdue" : po.deliveryDate ? "On schedule" : "No date",
      },
      cells: {
        delivery: overdue ? (
          <Badge tone="danger">Overdue</Badge>
        ) : (
          <span className="text-[var(--c-text-tertiary)]">{po.deliveryDate ? "On schedule" : "No date"}</span>
        ),
        number: <RefLink href={`/po/${po.id}`}>{po.number}</RefLink>,
        vendor: (
          <span>
            <RefLink href={`/vendors/${po.vendor.id}`}>{po.vendor.name}</RefLink>
            {po.vendor.status === "BLACKLISTED" && (
              <span className="ml-1.5">
                <Badge tone="danger">Blacklisted</Badge>
              </span>
            )}
          </span>
        ),
        entity: <Badge tone="neutral">{po.entity.code}</Badge>,
        pr: po.pr ? <RefLink href={`/pr/${po.pr.id}`}>{po.pr.number}</RefLink> : "—",
        department: po.pr?.department.name ?? "—",
        status: <StatusBadge status={po.status} />,
        total: money(po.total),
        received: (
          <Meter
            value={accepted}
            max={ordered || 1}
            tone={accepted >= ordered && ordered > 0 ? "success" : accepted > 0 ? "warning" : "danger"}
          />
        ),
        pendingValue: pendingValue > 0 ? <span className="text-[var(--c-warning)]">{money(pendingValue)}</span> : "—",
        store: po.deliveryStore?.name ?? "—",
        deliveryDate: po.deliveryDate ? (
          <span className={overdue ? "text-[var(--c-danger)]" : undefined}>{fmtDate(po.deliveryDate)}</span>
        ) : (
          "—"
        ),
        issued: po.issuedAt ? fmtDate(po.issuedAt) : "—",
        grns: po.grns.length ? (
          <span className="tnum">{po.grns.length}</span>
        ) : (
          <span className="text-2xs text-[var(--c-warning)]">none</span>
        ),
        invoices: po.invoices.length,
        advance: po.advanceRequired ? <StatusBadge status={po.advanceStatus ?? "PENDING"} /> : "—",
        buyer: po.createdBy.name,
        age: <span className="tnum">{ageDays(po.createdAt) ?? 0}d</span>,
        flags: (
          <span className="flex flex-wrap gap-1">
            {overdue && <Badge tone="danger">Overdue</Badge>}
            {mismatch && <Badge tone="danger">Invoice mismatch</Badge>}
            {po.exceptions.length > 0 && <Badge tone="warning">{po.exceptions.length} exception</Badge>}
          </span>
        ),
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Procurement"
        title="Purchase orders"
        subtitle="Every order raised, its receiving position and its invoice state. A purchase order is only issued once its approval chain is complete."
        actions={
          <Link href="/open-pos" className="btn btn-secondary btn-sm">
            Open PO control tower
          </Link>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Live orders"
          value={stats.live}
          tone="accent"
          href={statusLink("/po", "status", LIVE_STATUSES)}
        />
        <StatTile
          label="Live value"
          value={money(stats.liveValue, "PKR", { compact: true })}
          href={statusLink("/po", "status", LIVE_STATUSES)}
        />
        <StatTile
          label="Pending approval"
          value={stats.pendingApproval}
          tone={stats.pendingApproval ? "warning" : "default"}
          href={statusLink("/po", "status", ["PENDING_APPROVAL"])}
        />
        <StatTile
          label="Approved, not issued"
          value={stats.awaitingIssue}
          tone={stats.awaitingIssue ? "warning" : "default"}
          href={statusLink("/po", "status", ["APPROVED"])}
        />
        <StatTile
          label="Delivery overdue"
          value={stats.overdue}
          tone={stats.overdue ? "danger" : "default"}
          href={tableLink("/po", { delivery: "Overdue" })}
        />
        <StatTile
          label="Advances outstanding"
          value={stats.withAdvance}
          hint="Not yet settled against delivery"
          href={statusLink("/po", "advance", UNSETTLED_ADVANCE)}
        />
      </div>

      <DataTable
        id="pos"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "number", dir: "desc" }}
        exportName="purchase-orders"
        emptyState={
          <EmptyState
            title="No purchase orders"
            description="A purchase order is generated from an approved procurement case once sourcing and any required committee review are complete."
            action={
              <Link href="/pr" className="btn btn-secondary btn-sm">
                Browse requisitions
              </Link>
            }
          />
        }
      />
    </div>
  );
}
