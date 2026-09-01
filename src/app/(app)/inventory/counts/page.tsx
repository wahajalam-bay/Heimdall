import { prisma } from "@/lib/db";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { InlineAlert, Mono, PageHeader, StatTile, StatusBadge } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/DataTable";
import { money, fmtDate } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { listStockCounts } from "@/server/stock-count";
import { OpenCountForm } from "./OpenCountForm";

export const metadata = { title: "Stock counts" };
export const dynamic = "force-dynamic";

/**
 * Stock counts.
 *
 * ZAM/PUR/SOP-01: "Internal auditor audits the store on monthly basis, to
 * monitor stock and inventory status." A count is the only thing that
 * establishes whether the ledger is true, and the system had none.
 */
export default async function StockCountsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { ctx, authorized } = await pageContext(P.INVENTORY_VIEW);
  if (!authorized) {
    return <AccessDenied title="Stock counts" message="You do not have access to inventory." />;
  }

  const sp = await searchParams;
  const status = first(sp.status) ?? null;
  const canOpen = userHasPermission(ctx.user, P.INVENTORY_ADJUST, P.AUDIT_VIEW, P.STORE_ISSUE);

  const [rows, stores, categories] = await Promise.all([
    listStockCounts({ entityIds: visibleEntityIds(ctx.user), status }),
    prisma.store.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.category.findMany({ select: { id: true, code: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const open = rows.filter((r) => ["COUNTING", "REVIEW", "APPROVED"].includes(r.status));
  const withVariance = rows.filter((r) => r.varianceLines > 0);
  const netVariance = rows.reduce((a, r) => a + r.varianceValue, 0);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Stores", href: "/inventory" }, { label: "Counts" }]} />

      <PageHeader
        eyebrow="Stores"
        title="Stock counts"
        subtitle="ZAM/PUR/SOP-01 puts a monthly store audit with Internal Audit. The expected quantity on each sheet is frozen when the sheet is cut, so a count taken over several hours is not compared against a balance that moved underneath it."
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="Open sheets" value={open.length} hint={open.length ? "In progress" : "None"} />
        <StatTile
          label="Sheets with a variance"
          value={withVariance.length}
          tone={withVariance.length ? "warning" : undefined}
        />
        <StatTile
          label="Net variance value"
          value={money(netVariance)}
          hint={netVariance < 0 ? "Ledger over-stated" : netVariance > 0 ? "Ledger under-stated" : "Balanced"}
          tone={Math.abs(netVariance) > 1 ? "warning" : undefined}
        />
        <StatTile label="Counts on record" value={rows.length} />
      </div>

      {canOpen && (
        <OpenCountForm
          stores={stores}
          categories={categories.map((c) => ({ id: c.id, label: `${c.code} — ${c.name}` }))}
        />
      )}

      {open.length === 0 && rows.length === 0 && (
        <InlineAlert tone="warning">
          No stock count has ever been taken. Until one is, the inventory ledger has never been checked against a
          shelf — and checking it against a shelf is the only thing that establishes whether it is true.
        </InlineAlert>
      )}

      <DataTable
        id="stock-counts"
        columns={[
          { key: "number", header: "Number", sortable: true, width: "10rem" },
          { key: "store", header: "Store", filterable: true, sortable: true, width: "13rem" },
          { key: "type", header: "Type", filterable: true, sortable: true, width: "7rem" },
          { key: "lines", header: "Lines", sortable: true, align: "right", width: "6rem" },
          { key: "variances", header: "Variances", sortable: true, align: "right", width: "8rem" },
          { key: "value", header: "Variance value", sortable: true, align: "right", width: "11rem" },
          { key: "status", header: "Status", filterable: true, sortable: true, width: "10rem" },
          { key: "opened", header: "Opened", sortable: true, width: "9rem" },
        ]}
        rows={rows.map((r) => ({
          id: r.id,
          href: `/inventory/counts/${r.id}`,
          search: `${r.number} ${r.store.name}`,
          flag: r.varianceLines > 0 ? ("warning" as const) : null,
          cells: {
            number: <Mono>{r.number}</Mono>,
            store: r.store.name,
            type: humanize(r.countType),
            lines: r._count.lines,
            variances: r.varianceLines || "—",
            value: r.varianceValue ? money(r.varianceValue) : "—",
            status: <StatusBadge status={r.status} />,
            opened: (
              <>
                {fmtDate(r.createdAt)}
                <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{r.createdBy.name}</span>
              </>
            ),
          },
          values: {
            number: r.number,
            store: r.store.name,
            type: humanize(r.countType),
            lines: r._count.lines,
            variances: r.varianceLines,
            value: r.varianceValue,
            status: r.status,
            opened: r.createdAt.toISOString().slice(0, 10),
          },
        }))}
        emptyState="No stock counts yet."
      />

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        A variance is not an adjustment. The sheet records what was found; correcting the ledger is a separate act by
        a separate person, posted through the same immutable ledger as every other stock movement and carrying the
        count&rsquo;s number as its reason.
      </p>
    </div>
  );
}
