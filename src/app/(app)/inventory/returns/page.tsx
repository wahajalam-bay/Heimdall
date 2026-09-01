import Link from "next/link";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { Badge, InlineAlert, Mono, PageHeader, StatTile, StatusBadge } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/DataTable";
import { fmtDate } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { listEmployeeReturns, RETURN_REASON_LABELS, type ReturnReason } from "@/server/employee-returns";

export const metadata = { title: "Employee returns" };
export const dynamic = "force-dynamic";

/**
 * Employee returns.
 *
 * ZAM/PUR/SOP-01, Store Keeping: Store Receiving Note, then inspection for IT
 * equipment only, then either Repair and Maintenance or stacking and inventory.
 */
export default async function EmployeeReturnsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { ctx, authorized } = await pageContext(P.INVENTORY_VIEW);
  if (!authorized) {
    return <AccessDenied title="Employee returns" message="You do not have access to inventory." />;
  }

  const sp = await searchParams;
  const status = first(sp.status) ?? null;
  const canReceive = userHasPermission(ctx.user, P.RECEIVE_GOODS, P.STORE_ISSUE, P.INVENTORY_ADJUST);

  const rows = await listEmployeeReturns({ entityIds: visibleEntityIds(ctx.user), status });

  const awaitingInspection = rows.filter((r) => r.status === "PENDING_INSPECTION");
  const atRepair = rows.filter((r) => r.status === "AT_REPAIR");
  const failed = rows.filter((r) => r.status === "INSPECTION_FAILED");
  const open = rows.filter((r) => !["CLOSED", "CANCELLED", "STACKED"].includes(r.status));

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Stores", href: "/inventory" }, { label: "Employee returns" }]} />

      <PageHeader
        eyebrow="Stores"
        title="Employee returns"
        subtitle="Equipment coming back from staff. The SOP inspects IT equipment only, and a failed unit goes to Repair and Maintenance rather than back on the shelf."
        actions={
          canReceive ? (
            <Link className="btn btn-primary btn-sm" href="/inventory/returns/new">
              Receive a return
            </Link>
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="Open" value={open.length} />
        <StatTile
          label="Awaiting IT inspection"
          value={awaitingInspection.length}
          tone={awaitingInspection.length ? "warning" : undefined}
        />
        <StatTile
          label="Failed inspection"
          value={failed.length}
          hint={failed.length ? "Not yet handed to R&M" : "None"}
          tone={failed.length ? "danger" : undefined}
        />
        <StatTile label="At Repair and Maintenance" value={atRepair.length} />
      </div>

      {failed.length > 0 && (
        <InlineAlert tone="danger">
          {failed.length} return{failed.length === 1 ? "" : "s"} failed inspection and {failed.length === 1 ? "has" : "have"}{" "}
          not been handed to Repair and Maintenance. Until that hand-off is recorded, nothing says where the failed
          units are.
        </InlineAlert>
      )}

      <DataTable
        id="employee-returns"
        columns={[
          { key: "number", header: "Number", sortable: true, width: "10rem" },
          { key: "from", header: "Returned by", filterable: false },
          { key: "store", header: "Store", filterable: true, sortable: true, width: "12rem" },
          { key: "reason", header: "Reason", filterable: true, sortable: true, width: "11rem" },
          { key: "lines", header: "Lines", sortable: true, align: "right", width: "6rem" },
          { key: "inspection", header: "IT inspection", filterable: true, sortable: true, width: "11rem" },
          { key: "status", header: "Status", filterable: true, sortable: true, width: "11rem" },
          { key: "received", header: "Received", sortable: true, width: "9rem" },
        ]}
        rows={rows.map((r) => ({
          id: r.id,
          href: `/inventory/returns/${r.id}`,
          search: `${r.number} ${r.returnedByName} ${r.store.name}`,
          flag:
            r.status === "INSPECTION_FAILED"
              ? ("danger" as const)
              : r.status === "PENDING_INSPECTION"
                ? ("warning" as const)
                : null,
          cells: {
            number: <Mono>{r.number}</Mono>,
            from: (
              <>
                {r.returnedByName}
                {r.department && (
                  <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{r.department}</span>
                )}
              </>
            ),
            store: r.store.name,
            reason: RETURN_REASON_LABELS[r.reason as ReturnReason] ?? humanize(r.reason),
            lines: r._count.items,
            inspection: r.inspectionRequired ? (
              <>
                <Badge
                  tone={
                    r.inspectionResult === "PASSED"
                      ? "success"
                      : r.inspectionResult === "FAILED"
                        ? "danger"
                        : "warning"
                  }
                >
                  {r.inspectionResult ? humanize(r.inspectionResult) : "Pending"}
                </Badge>
                {r.inspectedBy && (
                  <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                    {r.inspectedBy.name}
                  </span>
                )}
              </>
            ) : (
              <span className="text-2xs text-[var(--c-text-tertiary)]">Not IT equipment</span>
            ),
            status: <StatusBadge status={r.status} />,
            received: (
              <>
                {r.receivedAt ? fmtDate(r.receivedAt) : "—"}
                {r.receivedBy && (
                  <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{r.receivedBy.name}</span>
                )}
              </>
            ),
          },
          values: {
            number: r.number,
            from: r.returnedByName,
            store: r.store.name,
            reason: RETURN_REASON_LABELS[r.reason as ReturnReason] ?? r.reason,
            lines: r._count.items,
            inspection: r.inspectionRequired ? (r.inspectionResult ?? "Pending") : "Not IT equipment",
            status: r.status,
            received: r.receivedAt ? r.receivedAt.toISOString().slice(0, 10) : "",
          },
        }))}
        emptyState="No employee returns recorded."
      />

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        Only units dispositioned for stacking go back into inventory. A unit at Repair and Maintenance is not usable
        stock, and counting it as though it were is the difference between an inventory figure and a pile of things
        in a corner.
      </p>
    </div>
  );
}
