import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { CONFIG_KEYS, getConfig } from "@/lib/config";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, InlineAlert, Meter, PageHeader, RefLink, StatTile } from "@/components/ui/primitives";
import { budgetPositions } from "@/server/budget";
import { money, percent, round2 } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { statusLink, tableLink } from "@/lib/links";

export const metadata = { title: "Budgets" };
export const dynamic = "force-dynamic";

/**
 * Budget positions.
 *
 * Allocated is the only figure stored. Committed is what live orders have
 * promised and utilised is what receipts have actually consumed, both computed
 * from the documents — so a cancelled order stops counting the moment it is
 * cancelled rather than when somebody remembers to adjust a total.
 */
export default async function BudgetsPage() {
  const { user, authorized } = await pageContext(P.BUDGET_VIEW);
  if (!authorized) {
    return <AccessDenied title="Budgets" message="You do not have permission to view budgets." />;
  }

  const scoped = visibleEntityIds(user);
  const [positions, control] = await Promise.all([
    budgetPositions({ entityIds: scoped }),
    getConfig<string>(CONFIG_KEYS.BUDGET_CONTROL, null),
  ]);

  const totals = {
    allocated: round2(positions.reduce((a, p) => a + p.allocated, 0)),
    committed: round2(positions.reduce((a, p) => a + p.committed, 0)),
    utilised: round2(positions.reduce((a, p) => a + p.utilised, 0)),
  };
  const overcommitted = positions.filter((p) => p.state === "OVERCOMMITTED");
  const nearing = positions.filter((p) => p.state === "WARN" || p.state === "EXHAUSTED");

  const columns: TableColumn[] = [
    { key: "year", header: "Year", filterable: true, sortable: true, width: "6rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "department", header: "Department", filterable: true, sortable: true, width: "14rem" },
    { key: "costCenter", header: "Cost centre", filterable: true, sortable: true, width: "10rem" },
    { key: "category", header: "Category", filterable: true, sortable: true, width: "13rem" },
    { key: "type", header: "Type", filterable: true, sortable: true, width: "7rem" },
    { key: "allocated", header: "Allocated", numeric: true, sortable: true, width: "11rem" },
    { key: "committed", header: "Committed", numeric: true, sortable: true, width: "11rem" },
    { key: "utilised", header: "Utilised", numeric: true, sortable: true, width: "11rem" },
    { key: "available", header: "Uncommitted", numeric: true, sortable: true, width: "11rem" },
    { key: "use", header: "Commitment", sortable: true, width: "12rem" },
    { key: "state", header: "State", filterable: true, sortable: true, width: "10rem" },
  ];

  const rows: TableRow[] = positions.map((p) => ({
    id: p.budgetId,
    href: p.departmentName ? tableLink("/pr", { department: p.departmentName }) : undefined,
    flag:
      p.state === "OVERCOMMITTED"
        ? "danger"
        : p.state === "EXHAUSTED"
          ? "warning"
          : p.state === "WARN"
            ? "warning"
            : null,
    search: `${p.year} ${p.entityCode} ${p.departmentName ?? ""} ${p.costCenterCode ?? ""} ${p.categoryName ?? ""}`,
    values: {
      year: p.year,
      entity: p.entityCode,
      department: p.departmentName ?? "All departments",
      costCenter: p.costCenterCode ?? "Any",
      category: p.categoryName ?? "Any",
      type: p.expenditureType === "BOTH" ? "Capital & operating" : humanize(p.expenditureType),
      allocated: p.allocated,
      committed: p.committed,
      utilised: p.utilised,
      available: p.available,
      use: p.committedPercent,
      state: humanize(p.state),
    },
    cells: {
      year: p.year,
      entity: <Badge tone="neutral">{p.entityCode}</Badge>,
      department: p.departmentName ? (
        <RefLink href={tableLink("/pr", { department: p.departmentName })}>{p.departmentName}</RefLink>
      ) : (
        <span className="text-[var(--c-text-tertiary)]">All departments</span>
      ),
      costCenter: p.costCenterCode ?? "—",
      category: p.categoryName ?? "—",
      type: p.expenditureType === "BOTH" ? "Capital & operating" : humanize(p.expenditureType),
      allocated: money(p.allocated, "PKR", { compact: true }),
      committed: money(p.committed, "PKR", { compact: true }),
      utilised: money(p.utilised, "PKR", { compact: true }),
      available: (
        <span className={p.available < 0 ? "text-danger-soft-foreground" : undefined}>
          {money(p.available, "PKR", { compact: true })}
        </span>
      ),
      use: (
        <Meter
          value={Math.min(p.committed, p.allocated)}
          max={p.allocated || 1}
          label={percent(p.committedPercent, 0)}
          tone={p.state === "OVERCOMMITTED" || p.state === "EXHAUSTED" ? "danger" : p.state === "WARN" ? "warning" : "success"}
        />
      ),
      state: (
        <Badge
          tone={
            p.state === "OVERCOMMITTED"
              ? "danger"
              : p.state === "EXHAUSTED"
                ? "warning"
                : p.state === "WARN"
                  ? "warning"
                  : "success"
          }
        >
          {humanize(p.state)}
        </Badge>
      ),
    },
  }));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Finance"
        title="Budgets"
        subtitle="Allocated is held; committed and utilised are read from live orders and posted receipts, so they cannot drift from the documents that caused them."
      />

      <InlineAlert tone={control === "BLOCK" ? "warning" : "info"}>
        <span>
          Budget control is set to <span className="font-500">{humanize(control ?? "WARN")}</span>.
        </span>{" "}
        {control === "BLOCK"
          ? "An order that would exceed its allocation is refused at approval."
          : control === "OFF"
            ? "Allocations are reported but never enforced."
            : "An order that would exceed its allocation is flagged to the approver but allowed."}{" "}
        This is configuration — the specification leaves the control mechanism to finance.
      </InlineAlert>

      {overcommitted.length > 0 && (
        <InlineAlert tone="danger">
          {overcommitted.length} budget line{overcommitted.length === 1 ? "" : "s"} committed beyond the allocation.
        </InlineAlert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Allocated"
          value={money(totals.allocated, "PKR", { compact: true })}
          hint={`${positions.length} budget line(s)`}
          href={tableLink("/finance/budgets", undefined, { sort: "allocated:desc" })}
        />
        <StatTile
          label="Committed"
          value={money(totals.committed, "PKR", { compact: true })}
          hint="Live orders against these allocations"
          tone="accent"
          href={tableLink("/finance/budgets", undefined, { sort: "committed:desc" })}
        />
        <StatTile
          label="Utilised"
          value={money(totals.utilised, "PKR", { compact: true })}
          hint="Value actually received"
          tone="success"
          href={tableLink("/finance/budgets", undefined, { sort: "utilised:desc" })}
        />
        <StatTile
          label="Needing attention"
          value={overcommitted.length + nearing.length}
          hint={`${overcommitted.length} over, ${nearing.length} close to exhausted`}
          tone={overcommitted.length ? "danger" : nearing.length ? "warning" : "default"}
          href={statusLink("/finance/budgets", "state", ["OVERCOMMITTED", "EXHAUSTED", "WARN"])}
        />
      </div>

      <DataTable
        id="budgets"
        columns={columns}
        rows={rows}
        exportName="budgets"
        defaultSort={{ key: "use", dir: "desc" }}
        emptyState={
          <EmptyState
            title="No budgets loaded"
            description="Until an allocation exists, procurement runs unbudgeted and nothing is checked against a limit."
          />
        }
      />
    </div>
  );
}
