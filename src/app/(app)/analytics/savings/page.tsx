import Link from "next/link";
import { pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { monthlyTrend, savingsRows } from "@/server/analytics";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, Mono, PageHeader, RefLink, SectionCard, StatTile } from "@/components/ui/primitives";
import { RankedBars, TrendChart } from "@/components/ui/charts";
import { humanize } from "@/lib/domain";
import { fmtDate, money, percent, round2 } from "@/lib/format";
import { AnalyticsFilters } from "../AnalyticsFilters";
import { buildFilter, filterOptions, periodLabel } from "../filters";
import { tableLink } from "@/lib/links";

export const metadata = { title: "Savings" };
export const dynamic = "force-dynamic";

export default async function SavingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, ctx, authorized } = await pageContext(P.ANALYTICS_VIEW);
  if (!authorized) {
    return <AccessDenied title="Savings" message="You do not have permission to view savings analytics." />;
  }

  const sp = await searchParams;
  const filter = buildFilter(user, sp, ctx.entityId);

  const [rows, options, trend] = await Promise.all([
    savingsRows(filter),
    filterOptions(user),
    monthlyTrend(filter, 12),
  ]);

  const total = round2(rows.reduce((a, r) => a + r.totalSavings, 0));
  const negotiated = round2(
    rows.filter((r) => r.savingsType === "NEGOTIATION").reduce((a, r) => a + r.totalSavings, 0),
  );
  const baseline = round2(total - negotiated);
  const avgPercent = rows.length ? round2(rows.reduce((a, r) => a + r.savingsPercent, 0) / rows.length) : 0;

  const byVendor = new Map<string, number>();
  const byCategory = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const r of rows) {
    if (r.vendorName) byVendor.set(r.vendorName, round2((byVendor.get(r.vendorName) ?? 0) + r.totalSavings));
    if (r.categoryName) byCategory.set(r.categoryName, round2((byCategory.get(r.categoryName) ?? 0) + r.totalSavings));
    byType.set(humanize(r.savingsType), round2((byType.get(humanize(r.savingsType)) ?? 0) + r.totalSavings));
  }

  const trendData = trend.map((m) => ({ label: m.label, values: [round2(m.savings)] }));

  const columns: TableColumn[] = [
    { key: "recorded", header: "Recorded", locked: true, sortable: true, width: "9.5rem" },
    { key: "po", header: "Purchase order", sortable: true, width: "11rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "vendor", header: "Vendor", filterable: true, sortable: true, minWidth: "14rem" },
    { key: "category", header: "Category", filterable: true, sortable: true, width: "13rem" },
    { key: "item", header: "Item", sortable: true, minWidth: "18rem" },
    { key: "quantity", header: "Quantity", numeric: true, sortable: true, width: "8rem" },
    { key: "marketPrice", header: "Market price", numeric: true, sortable: true, width: "10rem", defaultHidden: true },
    { key: "previousPrice", header: "Previous price", numeric: true, sortable: true, width: "10rem", defaultHidden: true },
    { key: "initialQuote", header: "Initial quote", numeric: true, sortable: true, width: "10rem" },
    { key: "negotiatedPrice", header: "Negotiated", numeric: true, sortable: true, width: "10rem" },
    { key: "finalPrice", header: "Final price", numeric: true, sortable: true, width: "10rem" },
    { key: "perUnit", header: "Saving per unit", numeric: true, sortable: true, width: "10rem" },
    { key: "totalSavings", header: "Total saving", numeric: true, sortable: true, width: "11rem" },
    { key: "savingsPercent", header: "Saving %", numeric: true, sortable: true, width: "9rem" },
    { key: "type", header: "Basis", filterable: true, sortable: true, width: "11rem" },
    { key: "notes", header: "Notes", sortable: true, minWidth: "18rem", defaultHidden: true },
  ];

  const tableRows: TableRow[] = rows.map((r) => ({
    id: r.id,
    href: r.poNumber ? undefined : undefined,
    flag: r.savingsPercent >= 10 ? "success" : r.savingsPercent <= 0 ? "warning" : null,
    search: `${r.itemDescription} ${r.vendorName ?? ""} ${r.poNumber ?? ""} ${r.notes ?? ""}`,
    values: {
      recorded: r.recordedAt.toISOString(),
      po: r.poNumber ?? "",
      entity: r.entityCode ?? "",
      vendor: r.vendorName ?? "",
      category: r.categoryName ?? "",
      item: r.itemDescription,
      quantity: r.quantity,
      marketPrice: r.marketPrice ?? 0,
      previousPrice: r.previousPrice ?? 0,
      initialQuote: r.initialQuote ?? 0,
      negotiatedPrice: r.negotiatedPrice ?? 0,
      finalPrice: r.finalPrice,
      perUnit: r.savingsPerUnit,
      totalSavings: r.totalSavings,
      savingsPercent: r.savingsPercent,
      type: humanize(r.savingsType),
      notes: r.notes ?? "",
    },
    cells: {
      recorded: fmtDate(r.recordedAt),
      po: r.poNumber ? <Mono>{r.poNumber}</Mono> : "—",
      entity: r.entityCode ? <Badge tone="neutral">{r.entityCode}</Badge> : "—",
      vendor: r.vendorName ?? "—",
      category: r.categoryName ?? "—",
      item: (
        <span className="block max-w-[24rem] truncate" title={r.itemDescription}>
          {r.itemDescription}
        </span>
      ),
      quantity: r.quantity,
      marketPrice: r.marketPrice !== null ? money(r.marketPrice) : "—",
      previousPrice: r.previousPrice !== null ? money(r.previousPrice) : "—",
      initialQuote: r.initialQuote !== null ? money(r.initialQuote) : "—",
      negotiatedPrice: r.negotiatedPrice !== null ? money(r.negotiatedPrice) : "—",
      finalPrice: money(r.finalPrice),
      perUnit: money(r.savingsPerUnit),
      totalSavings: <Mono>{money(r.totalSavings)}</Mono>,
      savingsPercent: (
        <Badge tone={r.savingsPercent >= 10 ? "success" : r.savingsPercent > 0 ? "info" : "warning"}>
          {percent(r.savingsPercent, 1)}
        </Badge>
      ),
      type: humanize(r.savingsType),
      notes: (
        <span className="block max-w-[22rem] truncate" title={r.notes ?? ""}>
          {r.notes ?? "—"}
        </span>
      ),
    },
  }));

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Analytics", href: "/analytics" }, { label: "Savings" }]} />

      <PageHeader
        eyebrow="Analytics"
        title="Savings register"
        subtitle={`Every saving with the baseline it was measured against — ${periodLabel(filter)}. A saving without a stated baseline is not a saving.`}
        actions={
          <Link href="/api/export/savings" className="btn btn-secondary btn-sm" prefetch={false}>
            Export CSV
          </Link>
        }
      />

      <AnalyticsFilters
        entities={options.entities}
        categories={options.categories}
        vendors={options.vendors}
        show={["entity", "category", "vendor", "from", "to"]}
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Total savings"
          value={money(total)}
          tone="success"
          hint={`${rows.length} records`}
          href={tableLink("/analytics/savings", undefined, { sort: "totalSavings:desc" })}
        />
        <StatTile
          label="From negotiation"
          value={money(negotiated)}
          hint="Vendor conceded on price"
          href={tableLink("/analytics/savings", undefined, { sort: "negotiatedPrice:desc" })}
        />
        <StatTile
          label="Against baseline"
          value={money(baseline)}
          hint="Market or last-paid comparison"
          href={tableLink("/analytics/savings", undefined, { sort: "marketPrice:desc" })}
        />
        <StatTile
          label="Average saving"
          value={percent(avgPercent, 1)}
          href={tableLink("/analytics/savings", undefined, { sort: "savingsPercent:desc" })}
        />
      </div>

      <SectionCard title="Savings by month" description="Recorded savings against the month the order was placed.">
        <TrendChart
          data={trendData}
          series={[{ key: "savings", label: "Savings", colorIndex: 5 }]}
          format="moneyCompact"
          height={240}
          area
        />
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="By vendor" description="Where negotiation is actually landing.">
          <RankedBars
            data={[...byVendor.entries()]
              .map(([label, value]) => ({
                label,
                value,
                href: tableLink("/analytics/savings", { vendor: label }, { sort: "totalSavings:desc" }),
              }))
              .sort((a, b) => b.value - a.value)}
            format="moneyCompact"
            maxRows={8}
          />
        </SectionCard>
        <SectionCard title="By category">
          <RankedBars
            data={[...byCategory.entries()]
              .map(([label, value]) => ({
                label,
                value,
                href: tableLink("/analytics/savings", { category: label }, { sort: "totalSavings:desc" }),
              }))
              .sort((a, b) => b.value - a.value)}
            format="moneyCompact"
            colorIndex={1}
            maxRows={8}
          />
        </SectionCard>
        <SectionCard title="By basis" description="How the saving was established.">
          <RankedBars
            data={[...byType.entries()]
              .map(([label, value]) => ({
                label,
                value,
                href: tableLink("/analytics/savings", { type: label }, { sort: "totalSavings:desc" }),
              }))
              .sort((a, b) => b.value - a.value)}
            format="moneyCompact"
            colorIndex={5}
            maxRows={6}
          />
        </SectionCard>
      </div>

      <DataTable
        id="savings"
        columns={columns}
        rows={tableRows}
        defaultSort={{ key: "totalSavings", dir: "desc" }}
        exportName="savings"
        emptyState={
          <EmptyState
            title="No savings recorded in this period"
            description="Savings are written when a purchase order is issued, comparing the final price against the market price, the last price paid and the initial quote."
          />
        }
      />
    </div>
  );
}
