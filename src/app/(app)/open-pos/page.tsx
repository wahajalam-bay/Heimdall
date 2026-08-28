import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { openPoRows } from "@/server/grn";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type BulkAction, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import {
  Badge,
  EmptyState,
  InlineAlert,
  Meter,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { ChartFrame, ChartTable, RankedBars } from "@/components/ui/charts";
import { humanize } from "@/lib/domain";
import { fmtDate, money, qty, round2 } from "@/lib/format";
import { tableLink } from "@/lib/links";

export const metadata = { title: "Open POs" };
export const dynamic = "force-dynamic";

/**
 * Open PO control tower. Everything issued but not fully received, with the
 * exception reasons that make each row actionable.
 */
export default async function OpenPosPage() {
  const { user, ctx, authorized } = await pageContext(P.PO_VIEW);
  if (!authorized) {
    return <AccessDenied title="Open POs" message="You do not have permission to view purchase orders." />;
  }

  const scoped = visibleEntityIds(user);
  const entityIds = ctx.entityId ? [ctx.entityId] : scoped;

  const [rows, staleDays, missingGrnDays, savedViews] = await Promise.all([
    openPoRows(entityIds),
    getConfigNumber(CONFIG_KEYS.OPEN_PO_STALE_DAYS, ctx.entityId),
    getConfigNumber(CONFIG_KEYS.MISSING_GRN_DAYS, ctx.entityId),
    prisma.savedView.findMany({
      where: { resource: "open-pos", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const stats = {
    count: rows.length,
    value: round2(rows.reduce((a, r) => a + r.pendingValue, 0)),
    noGrn: rows.filter((r) => r.grnCount === 0).length,
    partial: rows.filter((r) => r.grnCount > 0 && r.pendingQty > 0).length,
    overdue: rows.filter((r) => (r.daysOverdue ?? 0) > 0).length,
    missingGrn: rows.filter((r) => r.flags.includes("Missing GRN")).length,
    stale: rows.filter((r) => r.flags.includes("Long outstanding")).length,
    inspectionPending: rows.filter((r) => r.inspectionPending > 0).length,
    dueSoon: rows.filter((r) => r.flags.includes("Due soon")).length,
  };

  const byVendor = new Map<string, { label: string; value: number; count: number }>();
  for (const r of rows) {
    const cur = byVendor.get(r.vendorId) ?? { label: r.vendorName, value: 0, count: 0 };
    cur.value = round2(cur.value + r.pendingValue);
    cur.count += 1;
    byVendor.set(r.vendorId, cur);
  }
  const vendorExposure = [...byVendor.values()].sort((a, b) => b.value - a.value);

  const columns: TableColumn[] = [
    { key: "number", header: "PO", locked: true, sortable: true, width: "9.5rem" },
    { key: "vendor", header: "Vendor", sortable: true, minWidth: "14rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "11rem" },
    { key: "pr", header: "Requisition", sortable: true, width: "9.5rem", defaultHidden: true },
    { key: "store", header: "Delivery to", sortable: true, width: "13rem" },
    { key: "total", header: "Order value", numeric: true, sortable: true, width: "10rem", defaultHidden: true },
    { key: "pendingValue", header: "Pending value", numeric: true, sortable: true, width: "11rem" },
    { key: "pendingQty", header: "Pending qty", numeric: true, sortable: true, width: "9rem" },
    { key: "received", header: "Received", sortable: false, width: "8rem" },
    { key: "issued", header: "Issued", sortable: true, width: "8.5rem" },
    { key: "promised", header: "Promised", sortable: true, width: "8.5rem" },
    { key: "daysOverdue", header: "Days overdue", numeric: true, sortable: true, width: "9rem" },
    { key: "daysOpen", header: "Days open", numeric: true, sortable: true, width: "8.5rem" },
    { key: "grns", header: "GRNs", numeric: true, sortable: true, width: "5.5rem" },
    { key: "inspection", header: "Inspection", numeric: true, sortable: true, width: "8rem" },
    { key: "exceptions", header: "Exceptions", numeric: true, sortable: true, width: "8rem" },
    { key: "flags", header: "Why it is open", sortable: false, minWidth: "18rem" },
    // The reasons above, one column each. A flag string holding several reasons
    // cannot be filtered to any one of them, and every tile on this page counts
    // exactly one reason.
    { key: "receiptState", header: "Receipt state", filterable: true, sortable: true, width: "12rem", defaultHidden: true },
    { key: "deliveryState", header: "Delivery", filterable: true, sortable: true, width: "11rem", defaultHidden: true },
    { key: "grnAlert", header: "GRN alert", filterable: true, sortable: true, width: "11rem", defaultHidden: true },
    { key: "ageState", header: "Time open", filterable: true, sortable: true, width: "12rem", defaultHidden: true },
    { key: "inspectionState", header: "Inspection", filterable: true, sortable: true, width: "12rem", defaultHidden: true },
  ];

  const tableRows: TableRow[] = rows.map((r) => ({
    id: r.id,
    href: `/po/${r.id}`,
    flag:
      r.flags.includes("Missing GRN") || (r.daysOverdue ?? 0) > 30
        ? "danger"
        : (r.daysOverdue ?? 0) > 0 || r.flags.includes("Long outstanding")
          ? "warning"
          : null,
    search: `${r.number} ${r.vendorName} ${r.prNumber ?? ""} ${r.flags.join(" ")}`,
    values: {
      number: r.number,
      vendor: r.vendorName,
      entity: r.entityCode,
      status: humanize(r.status),
      pr: r.prNumber ?? "",
      store: r.storeName ?? "",
      total: r.total,
      pendingValue: r.pendingValue,
      pendingQty: r.pendingQty,
      received: r.orderedQty ? Math.round((r.receivedQty / r.orderedQty) * 100) : 0,
      issued: r.issuedAt ? r.issuedAt.toISOString().slice(0, 10) : "",
      promised: r.deliveryDate ? r.deliveryDate.toISOString().slice(0, 10) : "",
      daysOverdue: r.daysOverdue ?? 0,
      daysOpen: r.daysOpen ?? 0,
      grns: r.grnCount,
      inspection: r.inspectionPending,
      exceptions: r.openExceptions,
      flags: r.flags.join(" "),
      receiptState: r.grnCount === 0 ? "No GRN at all" : r.pendingQty > 0 ? "Partially received" : "Fully received",
      deliveryState:
        (r.daysOverdue ?? 0) > 0 ? "Overdue" : r.flags.includes("Due soon") ? "Due soon" : "On schedule",
      grnAlert: r.flags.includes("Missing GRN") ? "Missing GRN" : "None",
      ageState: r.flags.includes("Long outstanding") ? "Long outstanding" : "Within range",
      inspectionState: r.inspectionPending > 0 ? "Pending" : "Clear",
    },
    cells: {
      receiptState:
        r.grnCount === 0 ? (
          <Badge tone="danger">No GRN at all</Badge>
        ) : r.pendingQty > 0 ? (
          <Badge tone="warning">Partially received</Badge>
        ) : (
          <span className="text-[var(--c-text-tertiary)]">Fully received</span>
        ),
      deliveryState:
        (r.daysOverdue ?? 0) > 0 ? (
          <Badge tone="danger">Overdue</Badge>
        ) : r.flags.includes("Due soon") ? (
          <Badge tone="warning">Due soon</Badge>
        ) : (
          <span className="text-[var(--c-text-tertiary)]">On schedule</span>
        ),
      grnAlert: r.flags.includes("Missing GRN") ? (
        <Badge tone="danger">Missing GRN</Badge>
      ) : (
        <span className="text-[var(--c-text-tertiary)]">None</span>
      ),
      ageState: r.flags.includes("Long outstanding") ? (
        <Badge tone="warning">Long outstanding</Badge>
      ) : (
        <span className="text-[var(--c-text-tertiary)]">Within range</span>
      ),
      inspectionState: r.inspectionPending > 0 ? (
        <Badge tone="warning">Pending</Badge>
      ) : (
        <span className="text-[var(--c-text-tertiary)]">Clear</span>
      ),
      number: <RefLink href={`/po/${r.id}`}>{r.number}</RefLink>,
      vendor: <RefLink href={`/vendors/${r.vendorId}`}>{r.vendorName}</RefLink>,
      entity: <Badge tone="neutral">{r.entityCode}</Badge>,
      status: <StatusBadge status={r.status} />,
      pr: r.prNumber ?? "—",
      store: r.storeName ?? "—",
      total: money(r.total),
      pendingValue: <span className="font-500 text-[var(--c-warning)]">{money(r.pendingValue)}</span>,
      pendingQty: qty(r.pendingQty),
      received: (
        <Meter
          value={r.receivedQty}
          max={r.orderedQty || 1}
          tone={r.receivedQty === 0 ? "danger" : r.pendingQty > 0 ? "warning" : "success"}
        />
      ),
      issued: r.issuedAt ? fmtDate(r.issuedAt) : "—",
      promised: r.deliveryDate ? (
        <span className={(r.daysOverdue ?? 0) > 0 ? "text-[var(--c-danger)]" : undefined}>
          {fmtDate(r.deliveryDate)}
        </span>
      ) : (
        "—"
      ),
      daysOverdue:
        (r.daysOverdue ?? 0) > 0 ? (
          <span className="tnum font-500 text-[var(--c-danger)]">{r.daysOverdue}</span>
        ) : (
          <span className="text-2xs text-[var(--c-text-tertiary)]">—</span>
        ),
      daysOpen: <span className="tnum">{r.daysOpen ?? "—"}</span>,
      grns: r.grnCount ? (
        <span className="tnum">{r.grnCount}</span>
      ) : (
        <span className="text-2xs text-[var(--c-danger)]">none</span>
      ),
      inspection: r.inspectionPending ? (
        <Badge tone="warning">{r.inspectionPending} pending</Badge>
      ) : (
        <span className="text-2xs text-[var(--c-text-tertiary)]">—</span>
      ),
      exceptions: r.openExceptions ? <Badge tone="danger">{r.openExceptions}</Badge> : "—",
      flags: (
        <span className="flex flex-wrap gap-1">
          {r.flags.map((f) => (
            <Badge
              key={f}
              tone={
                f.includes("Missing") || f.includes("Overdue")
                  ? "danger"
                  : f.includes("Long") || f.includes("pending") || f.includes("exception")
                    ? "warning"
                    : f.includes("Due soon")
                      ? "info"
                      : "neutral"
              }
            >
              {f}
            </Badge>
          ))}
        </span>
      ),
    },
  }));

  const bulkActions: BulkAction[] | undefined = userHasPermission(user, P.PO_CLOSE)
    ? [
        {
          id: "short-close",
          label: "Short-close selected",
          endpoint: "/api/bulk/po",
          tone: "danger",
          confirm:
            "Short-close {n} purchase order(s)? Any pending quantity is written off and a quantity-mismatch exception is recorded against each order.",
          promptLabel:
            "Reason for short-closing these orders (required, recorded permanently against each order and as an exception)",
        },
      ]
    : undefined;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Operations"
        title="Open PO control tower"
        subtitle={`Every order issued but not fully received. Orders open longer than ${staleDays} days are flagged long-outstanding; a missing GRN is flagged ${missingGrnDays} days past the promised date.`}
        actions={
          <Link href="/po" className="btn btn-secondary btn-sm">
            All purchase orders
          </Link>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Open orders"
          value={stats.count}
          hint={`${money(stats.value, "PKR", { compact: true })} of value outstanding`}
          tone="accent"
          href={tableLink("/open-pos", undefined, { sort: "pendingValue:desc" })}
        />
        <StatTile
          label="No GRN at all"
          value={stats.noGrn}
          hint="Nothing recorded as received into inventory"
          tone={stats.noGrn ? "danger" : "default"}
          href={tableLink("/open-pos", { receiptState: "No GRN at all" })}
        />
        <StatTile
          label="Delivery overdue"
          value={stats.overdue}
          hint={`${stats.dueSoon} due within 3 days`}
          tone={stats.overdue ? "warning" : "default"}
          href={tableLink("/open-pos", { deliveryState: "Overdue" }, { sort: "daysOverdue:desc" })}
        />
        <StatTile
          label="Missing GRN alerts"
          value={stats.missingGrn}
          hint={`Past the ${missingGrnDays}-day threshold`}
          tone={stats.missingGrn ? "danger" : "default"}
          href={tableLink("/open-pos", { grnAlert: "Missing GRN" })}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Partially received"
          value={stats.partial}
          hint="Some quantity still outstanding"
          href={tableLink("/open-pos", { receiptState: "Partially received" })}
        />
        <StatTile
          label="Long outstanding"
          value={stats.stale}
          hint={`Open more than ${staleDays} days`}
          tone={stats.stale ? "warning" : "default"}
          href={tableLink("/open-pos", { ageState: "Long outstanding" }, { sort: "daysOpen:desc" })}
        />
        <StatTile
          label="Inspection pending"
          value={stats.inspectionPending}
          hint="GRN blocked until inspection is signed"
          tone={stats.inspectionPending ? "warning" : "default"}
          href={tableLink("/open-pos", { inspectionState: "Pending" })}
        />
        <StatTile
          label="Vendors with exposure"
          value={vendorExposure.length}
          hint={vendorExposure[0] ? `Largest: ${vendorExposure[0].label}` : undefined}
          href="/analytics/vendors"
        />
      </div>

      {stats.missingGrn > 0 && (
        <InlineAlert tone="danger">
          {stats.missingGrn} order(s) are past the missing-GRN threshold. Until a GRN is posted, the system treats those
          goods as <span className="font-600">not received</span> — no invoice against them can be paid.
        </InlineAlert>
      )}

      {vendorExposure.length > 0 && (
        <ChartFrame
          title="Outstanding value by vendor"
          subtitle="Where the delivery risk is concentrated"
          tableView={
            <ChartTable
              columns={["Vendor", "Pending value", "Open orders"]}
              rows={vendorExposure.map((v) => [v.label, money(v.value), v.count])}
            />
          }
        >
          <RankedBars
            data={vendorExposure.map((v) => ({
              label: v.label,
              value: v.value,
              sub: `${v.count} PO`,
              href: tableLink("/open-pos", undefined, { q: v.label, sort: "pendingValue:desc" }),
            }))}
            format="moneyCompact"
            maxRows={8}
            colorIndex={2}
            secondaryLabel={
              vendorExposure.length > 8 ? `Showing the top 8 of ${vendorExposure.length} vendors.` : undefined
            }
          />
        </ChartFrame>
      )}

      <DataTable
        id="open-pos"
        columns={columns}
        rows={tableRows}
        savedViews={savedViews}
        bulkActions={bulkActions}
        defaultSort={{ key: "daysOverdue", dir: "desc" }}
        exportName="open-purchase-orders"
        emptyState={
          <EmptyState
            title="Nothing outstanding"
            description="Every issued purchase order has been fully received and taken into inventory."
          />
        }
      />

      <SectionCard
        title="How this board is built"
        description="Each flag comes from a rule, not a manual note"
      >
        <ul className="grid gap-x-8 gap-y-2 text-xs leading-5 text-muted sm:grid-cols-2">
          <li>
            <span className="font-600 text-[var(--c-text)]">No GRN</span> — the order is issued but no goods receipt note
            has been posted, so nothing is in inventory.
          </li>
          <li>
            <span className="font-600 text-[var(--c-text)]">Partial GRN</span> — some quantity has been received and
            accepted, but the order is not complete.
          </li>
          <li>
            <span className="font-600 text-[var(--c-text)]">Overdue</span> — the promised delivery date has passed with
            quantity still outstanding.
          </li>
          <li>
            <span className="font-600 text-[var(--c-text)]">Long outstanding</span> — issued more than {staleDays} days
            ago without full receipt.
          </li>
          <li>
            <span className="font-600 text-[var(--c-text)]">Missing GRN</span> — more than {missingGrnDays} days past the
            promised date with no GRN at all; a tracked exception is raised.
          </li>
          <li>
            <span className="font-600 text-[var(--c-text)]">Inspection pending</span> — goods are physically in but a
            mandatory technical inspection blocks the GRN.
          </li>
        </ul>
      </SectionCard>
    </div>
  );
}
