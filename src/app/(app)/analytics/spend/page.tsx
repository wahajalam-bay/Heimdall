import Link from "next/link";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { categorySpendTrend, monthlyTrend, spendByDimension } from "@/server/analytics";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs, TabNav } from "@/components/ui/nav";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, PageHeader, RefLink, SectionCard, StatTile } from "@/components/ui/primitives";
import { RankedBars, TrendChart } from "@/components/ui/charts";
import { money, percent, round2 } from "@/lib/format";
import { AnalyticsFilters } from "../AnalyticsFilters";
import { buildFilter, filterOptions, periodLabel } from "../filters";

export const metadata = { title: "Spend analysis" };
export const dynamic = "force-dynamic";

const DIMENSIONS = [
  { key: "category", label: "Category" },
  { key: "vendor", label: "Vendor" },
  { key: "department", label: "Department" },
  { key: "entity", label: "Entity" },
  { key: "project", label: "Project" },
  { key: "site", label: "Site" },
  { key: "buyer", label: "Buyer" },
  { key: "procurementType", label: "Type" },
] as const;

type Dimension = (typeof DIMENSIONS)[number]["key"];

export default async function SpendPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, ctx, authorized } = await pageContext(P.ANALYTICS_VIEW);
  if (!authorized) {
    return <AccessDenied title="Spend analysis" message="You do not have permission to view spend analytics." />;
  }

  const sp = await searchParams;
  const requested = first(sp.tab) ?? "category";
  const dimension = (DIMENSIONS.some((d) => d.key === requested) ? requested : "category") as Dimension;
  const filter = buildFilter(user, sp, ctx.entityId);

  const [slices, options, trend, catTrend] = await Promise.all([
    spendByDimension(dimension, filter),
    filterOptions(user),
    monthlyTrend(filter, 12),
    categorySpendTrend(filter),
  ]);

  const total = round2(slices.reduce((a, s) => a + s.value, 0));
  const orders = slices.reduce((a, s) => a + s.count, 0);
  const top3Share = total > 0 ? round2((slices.slice(0, 3).reduce((a, s) => a + s.value, 0) / total) * 100) : 0;

  const hrefFor = (key: string) =>
    dimension === "vendor" ? `/vendors/${key}` : undefined;

  const columns: TableColumn[] = [
    { key: "label", header: DIMENSIONS.find((d) => d.key === dimension)!.label, locked: true, sortable: true, minWidth: "18rem" },
    { key: "value", header: "Spend", numeric: true, sortable: true, width: "13rem" },
    { key: "share", header: "Share", numeric: true, sortable: true, width: "9rem" },
    { key: "count", header: "Orders", numeric: true, sortable: true, width: "8rem" },
    { key: "average", header: "Average order", numeric: true, sortable: true, width: "12rem" },
    { key: "cumulative", header: "Cumulative share", numeric: true, sortable: true, width: "11rem" },
  ];

  let running = 0;
  const rows: TableRow[] = slices.map((s) => {
    const share = total > 0 ? round2((s.value / total) * 100) : 0;
    running = round2(running + share);
    const avg = s.count > 0 ? round2(s.value / s.count) : 0;
    const href = hrefFor(s.key);
    return {
      id: s.key,
      href,
      flag: share > 30 ? "warning" : null,
      search: s.label,
      values: {
        label: s.label,
        value: s.value,
        share,
        count: s.count,
        average: avg,
        cumulative: running,
      },
      cells: {
        label: href ? <RefLink href={href}>{s.label}</RefLink> : s.label,
        value: money(s.value),
        share: (
          <Badge tone={share > 30 ? "warning" : share > 15 ? "info" : "neutral"}>{percent(share, 1)}</Badge>
        ),
        count: s.count,
        average: money(avg),
        cumulative: percent(running, 1),
      },
    };
  });

  const trendData = trend.map((m) => ({ label: m.label, values: [round2(m.poValue)] }));

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Analytics", href: "/analytics" }, { label: "Spend" }]} />

      <PageHeader
        eyebrow="Analytics"
        title="Spend analysis"
        subtitle={`Purchase order value cut every way that matters — ${periodLabel(filter)}.`}
        actions={
          <Link href="/api/export/spend" className="btn btn-secondary btn-sm" prefetch={false}>
            Export CSV
          </Link>
        }
      />

      <AnalyticsFilters
        entities={options.entities}
        departments={options.departments}
        categories={options.categories}
        vendors={options.vendors}
        projects={options.projects}
        show={["entity", "department", "category", "vendor", "project", "from", "to"]}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Total spend" value={money(total)} hint={`${orders} order line groups`} />
        <StatTile label="Distinct values" value={slices.length} hint={DIMENSIONS.find((d) => d.key === dimension)!.label} />
        <StatTile
          label="Top three share"
          value={percent(top3Share, 1)}
          tone={top3Share > 70 ? "warning" : "default"}
          hint="Concentration in the largest three"
        />
        <StatTile
          label="Average order value"
          value={orders > 0 ? money(round2(total / orders)) : "—"}
        />
      </div>

      <SectionCard title="Spend by month" description="Issued purchase order value over the last twelve months.">
        <TrendChart
          data={trendData}
          series={[{ key: "poValue", label: "PO value", colorIndex: 0 }]}
          format="moneyCompact"
          height={240}
          area
        />
      </SectionCard>

      <TabNav baseHref="/analytics/spend" active={dimension} tabs={DIMENSIONS.map((d) => ({ key: d.key, label: d.label }))} />

      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <SectionCard
          title={`Top by ${DIMENSIONS.find((d) => d.key === dimension)!.label.toLowerCase()}`}
          description="Ranked by value."
        >
          <RankedBars
            data={slices.map((s) => ({
              label: s.label,
              value: s.value,
              sub: `${s.count} orders`,
              href: hrefFor(s.key),
            }))}
            format="moneyCompact"
            maxRows={10}
          />
        </SectionCard>

        {dimension === "category" && catTrend.length > 0 && (
          <SectionCard
            title="Category movement"
            description="Last six months against the six before them. Movement matters more than absolute level."
            bodyClassName="px-0 py-0"
          >
            <div className="table-wrap max-h-[24rem] overflow-y-auto">
              <table className="dt">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th className="text-right">Last 6 months</th>
                    <th className="text-right">Prior 6 months</th>
                    <th className="text-right">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {catTrend.map((c) => (
                    <tr key={c.key}>
                      <td className="text-xs">{c.label}</td>
                      <td className="num text-xs">{money(c.value)}</td>
                      <td className="num text-xs">{c.priorValue > 0 ? money(c.priorValue) : "—"}</td>
                      <td className="num text-xs">
                        {c.changePercent === null ? (
                          <Badge tone="info">New</Badge>
                        ) : (
                          <span
                            className={
                              c.changePercent > 20
                                ? "text-[var(--c-danger)] font-600"
                                : c.changePercent < -20
                                  ? "text-[var(--c-success)] font-600"
                                  : undefined
                            }
                          >
                            {c.changePercent > 0 ? "+" : ""}
                            {percent(c.changePercent, 1)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        )}

        {dimension !== "category" && (
          <SectionCard
            title="Concentration"
            description="Cumulative share, largest first. A steep curve means a small number of names carry the spend."
          >
            <RankedBars
              data={rows.slice(0, 10).map((r) => ({
                label: String(r.values.label),
                value: Number(r.values.cumulative),
                sub: `${percent(Number(r.values.share), 1)} alone`,
              }))}
              format="percent"
              colorIndex={2}
              maxRows={10}
            />
          </SectionCard>
        )}
      </div>

      <DataTable
        id={`spend-${dimension}`}
        columns={columns}
        rows={rows}
        defaultSort={{ key: "value", dir: "desc" }}
        exportName={`spend-by-${dimension}`}
        emptyState={
          <EmptyState
            title="No spend in this view"
            description="Widen the date range or clear the filters. Only issued purchase orders count towards spend."
          />
        }
      />
    </div>
  );
}
