import Link from "next/link";
import { pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { monthlyTrend, procurementKpis, spendByDimension } from "@/server/analytics";
import { AccessDenied } from "@/components/ui/guard";
import {
  Badge,
  InlineAlert,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
} from "@/components/ui/primitives";
import { ColumnChart, DonutChart, RankedBars, TrendChart } from "@/components/ui/charts";
import { money, percent, round2 } from "@/lib/format";
import { AnalyticsFilters } from "./AnalyticsFilters";
import { buildFilter, filterOptions, periodLabel } from "./filters";
import { statusLink, tableLink } from "@/lib/links";

export const metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, ctx, authorized } = await pageContext(P.ANALYTICS_VIEW);
  if (!authorized) {
    return <AccessDenied title="Analytics" message="You do not have permission to view procurement analytics." />;
  }

  const sp = await searchParams;
  const filter = buildFilter(user, sp, ctx.entityId);

  const [kpis, options, byCategory, byVendor, byDepartment, byType, trend] = await Promise.all([
    procurementKpis(filter),
    filterOptions(user),
    spendByDimension("category", filter),
    spendByDimension("vendor", filter),
    spendByDimension("department", filter),
    spendByDimension("procurementType", filter),
    monthlyTrend(filter, 12),
  ]);

  const trendData = trend.map((m) => ({
    label: m.label,
    values: [round2(m.poValue), round2(m.savings)],
  }));
  const volumeData = trend.map((m) => ({ label: m.label, values: [m.prCount, m.poCount] }));

  const topVendorShare =
    byVendor.length > 0 && kpis.poValue > 0 ? round2((byVendor[0].value / kpis.poValue) * 100) : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Analytics"
        title="Procurement analytics"
        subtitle={`Spend, savings, cycle time and control health — ${periodLabel(filter)}.`}
        actions={
          <>
            <Link href="/analytics/spend" className="btn btn-secondary btn-sm">
              Spend
            </Link>
            <Link href="/analytics/savings" className="btn btn-secondary btn-sm">
              Savings
            </Link>
            <Link href="/analytics/bottlenecks" className="btn btn-secondary btn-sm">
              Bottlenecks
            </Link>
            <Link href="/analytics/reports" className="btn btn-primary btn-sm">
              Reports
            </Link>
          </>
        }
      />

      <AnalyticsFilters
        entities={options.entities}
        departments={options.departments}
        categories={options.categories}
        vendors={options.vendors}
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Procurement value"
          value={money(kpis.totalProcurementValue)}
          hint="Issued purchase orders"
          href="/analytics/spend"
        />
        <StatTile
          label="Savings realised"
          value={money(kpis.savingsAmount)}
          hint={kpis.savingsPercent > 0 ? `${percent(kpis.savingsPercent, 2)} of addressable spend` : undefined}
          tone="success"
          href="/analytics/savings"
        />
        <StatTile
          label="Average cycle time"
          value={`${kpis.avgCycleTimeDays} days`}
          hint="Requisition raised to purchase order issued"
          href="/analytics/performance"
        />
        <StatTile
          label="Open exceptions"
          value={kpis.openExceptions}
          tone={kpis.criticalExceptions > 0 ? "danger" : kpis.openExceptions > 0 ? "warning" : "success"}
          hint={`${kpis.criticalExceptions} critical`}
          href="/analytics/exceptions"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Requisitions"
          value={kpis.prCount}
          hint={`${kpis.prPendingApproval} awaiting approval`}
          href="/pr"
        />
        <StatTile
          label="Average approval time"
          value={kpis.avgPrApprovalHours > 48 ? `${round2(kpis.avgPrApprovalHours / 24)} days` : `${kpis.avgPrApprovalHours} h`}
          hint="Requisition submission to decision"
          href="/analytics/bottlenecks"
        />
        <StatTile
          label="Quotations per RFQ"
          value={kpis.avgQuotationsPerRfq}
          hint={`${kpis.rfqCount} RFQs issued`}
          tone={kpis.avgQuotationsPerRfq < 3 ? "warning" : "default"}
          href={tableLink("/rfq", { quorum: "Below minimum" })}
        />
        <StatTile
          label="Open purchase orders"
          value={kpis.openPoCount}
          hint={`${money(kpis.openPoValue)} outstanding · ${kpis.overduePoCount} overdue`}
          tone={kpis.overduePoCount > 0 ? "warning" : "default"}
          href="/open-pos"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Invoices pending"
          value={kpis.invoicesPendingCount}
          hint={`${kpis.invoiceMismatchCount} failing the match`}
          tone={kpis.invoiceMismatchCount > 0 ? "danger" : "default"}
          href="/finance/pending"
        />
        <StatTile
          label="Payments pending"
          value={money(kpis.paymentPendingValue)}
          hint={`${kpis.paymentPendingCount} handoff(s) with finance`}
          href="/finance/handoffs"
        />
        <StatTile
          label="Petty cash store gap"
          value={kpis.pettyCashStoreGap}
          tone={kpis.pettyCashStoreGap > 0 ? "danger" : "success"}
          hint={`${money(kpis.pettyCashSpend)} cash spend`}
          href={tableLink("/petty-cash", { storeGapState: "Outstanding" })}
        />
        <StatTile
          label="CPC cases"
          value={kpis.cpcPendingCount}
          hint={`${kpis.cpcApprovedCount} approved to date`}
          tone={kpis.cpcPendingCount > 0 ? "warning" : "default"}
          href={statusLink("/cpc/cases", "status", ["PENDING", "SCHEDULED", "UNDER_REVIEW"])}
        />
      </div>

      {(kpis.invoiceMismatchCount > 0 || kpis.pettyCashStoreGap > 0 || kpis.criticalExceptions > 0) && (
        <InlineAlert tone="danger">
          Control health needs attention:{" "}
          {[
            kpis.invoiceMismatchCount > 0 ? `${kpis.invoiceMismatchCount} invoice(s) failing the three-way match` : null,
            kpis.pettyCashStoreGap > 0 ? `${kpis.pettyCashStoreGap} petty cash purchase(s) never entered into a store` : null,
            kpis.criticalExceptions > 0 ? `${kpis.criticalExceptions} critical exception(s) open` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          .
        </InlineAlert>
      )}

      <SectionCard
        title="Value and savings by month"
        description="Purchase order value issued against savings recorded in the same month."
      >
        <TrendChart
          data={trendData}
          series={[
            { key: "poValue", label: "PO value", colorIndex: 0 },
            { key: "savings", label: "Savings", colorIndex: 5 },
          ]}
          format="moneyCompact"
          height={260}
        />
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Requisition and order volume" description="How much work is flowing through each month.">
          <ColumnChart
            data={volumeData}
            series={[
              { key: "prCount", label: "Requisitions", colorIndex: 1 },
              { key: "poCount", label: "Purchase orders", colorIndex: 4 },
            ]}
            format="number"
            height={220}
          />
        </SectionCard>
        <SectionCard title="Spend by procurement type" description="Where the money goes by the nature of the buy.">
          <DonutChart
            data={byType.slice(0, 6).map((t, i) => ({
              label: t.label,
              value: t.value,
              colorIndex: i,
              href: tableLink("/pr", { type: t.label }),
            }))}
            centerLabel="Total"
            centerValue={money(kpis.poValue, "PKR", { compact: true })}
            format="moneyCompact"
          />
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="Top categories" description="By purchase order value.">
          <RankedBars
            data={byCategory.map((c) => ({
              label: c.label,
              value: c.value,
              sub: `${c.count} orders`,
              href: tableLink("/analytics/spend", undefined, { dimension: "category", q: c.label }),
            }))}
            format="moneyCompact"
            maxRows={8}
          />
        </SectionCard>
        <SectionCard
          title="Top vendors"
          description={topVendorShare > 30 ? `Concentration risk: ${percent(topVendorShare, 0)} with one vendor.` : "By purchase order value."}
        >
          <RankedBars
            data={byVendor.map((v) => ({ label: v.label, value: v.value, href: `/vendors/${v.key}`, sub: `${v.count} orders` }))}
            format="moneyCompact"
            colorIndex={1}
            maxRows={8}
          />
        </SectionCard>
        <SectionCard title="Top departments" description="Who is spending.">
          <RankedBars
            data={byDepartment.map((d) => ({ label: d.label, value: d.value, sub: `${d.count} orders` }))}
            format="moneyCompact"
            colorIndex={2}
            maxRows={8}
          />
        </SectionCard>
      </div>

      <SectionCard title="Where to look next">
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { href: "/analytics/spend", label: "Spend analysis", note: "By entity, department, category, vendor, project and buyer" },
            { href: "/analytics/savings", label: "Savings register", note: "Every recorded saving with its basis" },
            { href: "/analytics/vendors", label: "Vendor analytics", note: "Concentration, performance and issue rates" },
            { href: "/analytics/performance", label: "Process performance", note: "Cycle times and stage durations" },
            { href: "/analytics/bottlenecks", label: "Bottlenecks", note: "Where work is sitting, and with whom" },
            { href: "/analytics/exceptions", label: "Exceptions", note: "Control breaches as first-class objects" },
            { href: "/analytics/audit", label: "Audit trail", note: "Every action, actor and reason" },
            { href: "/analytics/reports", label: "Reports", note: "Exportable operational and management reports" },
          ].map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-xl border border-border px-3 py-2.5 transition-colors hover:bg-[var(--c-surface-hover)]"
            >
              <span className="block text-xs font-600">{l.label}</span>
              <span className="mt-0.5 block text-2xs text-muted">{l.note}</span>
            </Link>
          ))}
        </div>
      </SectionCard>

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Inventory value"
          value={money(kpis.inventoryValue)}
          href={tableLink("/inventory", undefined, { sort: "value:desc" })}
        />
        <StatTile label="Assets on register" value={kpis.assetCount} href="/assets" />
        <StatTile label="Active vendors" value={kpis.activeVendors} href="/vendors?tab=approved" />
        <StatTile
          label="Blacklisted vendors"
          value={kpis.blacklistedVendors}
          tone={kpis.blacklistedVendors > 0 ? "danger" : "default"}
          href="/vendors/blacklist"
        />
      </div>

      {byVendor.length > 0 && topVendorShare > 30 && (
        <InlineAlert tone="warning">
          <RefLink href={`/vendors/${byVendor[0].key}`}>{byVendor[0].label}</RefLink> accounts for{" "}
          {percent(topVendorShare, 1)} of purchase order value in this period. Single-vendor concentration at this level
          is a continuity risk as much as a commercial one.{" "}
          <Badge tone="warning">Concentration</Badge>
        </InlineAlert>
      )}
    </div>
  );
}
