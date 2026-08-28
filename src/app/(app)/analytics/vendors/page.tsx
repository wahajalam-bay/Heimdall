import Link from "next/link";
import { pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { vendorAnalytics } from "@/server/analytics";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import {
  Badge,
  EmptyState,
  InlineAlert,
  Meter,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { DonutChart, RankedBars } from "@/components/ui/charts";
import { humanize } from "@/lib/domain";
import { fmtDate, money, percent, round2 } from "@/lib/format";
import { AnalyticsFilters } from "../AnalyticsFilters";
import { buildFilter, filterOptions } from "../filters";
import { tableLink } from "@/lib/links";

export const metadata = { title: "Vendor analytics" };
export const dynamic = "force-dynamic";

export default async function VendorAnalyticsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, ctx, authorized } = await pageContext(P.ANALYTICS_VIEW, P.VENDOR_VIEW);
  if (!authorized) {
    return <AccessDenied title="Vendor analytics" message="You do not have permission to view vendor analytics." />;
  }

  const sp = await searchParams;
  const filter = buildFilter(user, sp, ctx.entityId);
  const [rows, options] = await Promise.all([vendorAnalytics(filter), filterOptions(user)]);

  const transacting = rows.filter((v) => v.orders > 0);
  const totalSpend = round2(transacting.reduce((a, v) => a + v.spend, 0));
  const top1 = transacting[0];
  const top5Share = round2(transacting.slice(0, 5).reduce((a, v) => a + v.concentrationPercent, 0));
  const weak = transacting.filter((v) => (v.score ?? 100) < 50);
  const withIssues = transacting.filter((v) => v.openIssues > 0);

  const statusMix = ["APPROVED", "CONDITIONAL", "SUSPENDED", "BLACKLISTED", "PROSPECT", "UNDER_EVALUATION", "PENDING_APPROVAL", "INACTIVE"]
    .map((s, i) => ({ label: humanize(s), value: rows.filter((v) => v.status === s).length, colorIndex: i }))
    .filter((d) => d.value > 0);

  const columns: TableColumn[] = [
    { key: "vendor", header: "Vendor", locked: true, sortable: true, minWidth: "16rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "10rem" },
    { key: "type", header: "Type", filterable: true, sortable: true, width: "11rem" },
    { key: "city", header: "City", filterable: true, sortable: true, width: "9rem", defaultHidden: true },
    { key: "orders", header: "Orders", numeric: true, sortable: true, width: "7.5rem" },
    { key: "spend", header: "Spend", numeric: true, sortable: true, width: "12rem" },
    { key: "concentration", header: "Share of spend", numeric: true, sortable: true, width: "11rem" },
    { key: "qualification", header: "Pre-qual %", numeric: true, sortable: true, width: "9.5rem" },
    { key: "score", header: "Performance", numeric: true, sortable: true, width: "11rem" },
    { key: "onTime", header: "On time", numeric: true, sortable: true, width: "8.5rem" },
    { key: "quality", header: "Quality", numeric: true, sortable: true, width: "8.5rem" },
    { key: "rejection", header: "Rejection", numeric: true, sortable: true, width: "8.5rem" },
    { key: "priceVariance", header: "Avg price variance", numeric: true, sortable: true, width: "11rem", defaultHidden: true },
    { key: "openIssues", header: "Open issues", numeric: true, sortable: true, width: "9rem" },
    { key: "invoiceIssues", header: "Invoice issues", numeric: true, sortable: true, width: "10rem" },
    { key: "lastOrder", header: "Last order", sortable: true, width: "9.5rem" },
  ];

  const tableRows: TableRow[] = rows.map((v) => ({
    id: v.id,
    href: `/vendors/${v.id}`,
    flag:
      v.status === "BLACKLISTED"
        ? "danger"
        : v.concentrationPercent > 25
          ? "warning"
          : (v.score ?? 0) >= 80
            ? "success"
            : null,
    search: `${v.code} ${v.name} ${v.city ?? ""}`,
    values: {
      vendor: v.name,
      status: humanize(v.status),
      type: humanize(v.businessType),
      city: v.city ?? "",
      orders: v.orders,
      spend: v.spend,
      concentration: v.concentrationPercent,
      qualification: v.qualificationPercent ?? 0,
      score: v.score ?? 0,
      onTime: v.onTimePercent ?? 0,
      quality: v.qualityPercent ?? 0,
      rejection: v.rejectionPercent ?? 0,
      priceVariance: v.avgPriceVariance ?? 0,
      openIssues: v.openIssues,
      invoiceIssues: v.invoiceIssues,
      lastOrder: v.lastOrderAt ? v.lastOrderAt.toISOString() : "",
    },
    cells: {
      vendor: (
        <span>
          <RefLink href={`/vendors/${v.id}`}>{v.name}</RefLink>
          <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{v.code}</span>
        </span>
      ),
      status: <StatusBadge status={v.status} />,
      type: humanize(v.businessType),
      city: v.city ?? "—",
      orders: v.orders,
      spend: v.spend > 0 ? <Mono>{money(v.spend)}</Mono> : "—",
      concentration:
        v.concentrationPercent > 0 ? (
          <Badge tone={v.concentrationPercent > 25 ? "warning" : v.concentrationPercent > 10 ? "info" : "neutral"}>
            {percent(v.concentrationPercent, 1)}
          </Badge>
        ) : (
          "—"
        ),
      qualification: v.qualificationPercent !== null ? percent(v.qualificationPercent, 0) : "—",
      score:
        v.score === null ? (
          "—"
        ) : (
          <Meter value={v.score} max={100} tone={v.score >= 70 ? "success" : v.score >= 50 ? "warning" : "danger"} />
        ),
      onTime: v.onTimePercent !== null ? percent(v.onTimePercent, 0) : "—",
      quality: v.qualityPercent !== null ? percent(v.qualityPercent, 0) : "—",
      rejection:
        v.rejectionPercent !== null ? (
          <span className={v.rejectionPercent > 5 ? "text-[var(--c-danger)] font-600" : undefined}>
            {percent(v.rejectionPercent, 1)}
          </span>
        ) : (
          "—"
        ),
      priceVariance: v.avgPriceVariance !== null ? percent(v.avgPriceVariance, 1) : "—",
      openIssues: v.openIssues > 0 ? <Badge tone="warning">{v.openIssues}</Badge> : "—",
      invoiceIssues: v.invoiceIssues > 0 ? <Badge tone="danger">{v.invoiceIssues}</Badge> : "—",
      lastOrder: v.lastOrderAt ? fmtDate(v.lastOrderAt) : "—",
    },
  }));

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Analytics", href: "/analytics" }, { label: "Vendors" }]} />

      <PageHeader
        eyebrow="Analytics"
        title="Vendor analytics"
        subtitle="Concentration, qualification and delivered performance side by side — the three things that decide whether a vendor should keep getting work."
        actions={
          <>
            <Link href="/vendors/performance" className="btn btn-secondary btn-sm">
              Performance detail
            </Link>
            <Link href="/api/export/vendors" className="btn btn-secondary btn-sm" prefetch={false}>
              Export CSV
            </Link>
          </>
        }
      />

      <AnalyticsFilters entities={options.entities} show={["entity", "from", "to"]} />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Vendors transacting"
          value={transacting.length}
          hint={`${rows.length} on the register`}
          href={tableLink("/analytics/vendors", undefined, { sort: "orders:desc" })}
        />
        <StatTile
          label="Total spend"
          value={money(totalSpend)}
          href={tableLink("/analytics/vendors", undefined, { sort: "spend:desc" })}
        />
        <StatTile
          label="Top five share"
          value={percent(top5Share, 1)}
          tone={top5Share > 70 ? "warning" : "default"}
          hint="Concentration in the largest five vendors"
          href={tableLink("/analytics/vendors", undefined, { sort: "concentration:desc" })}
        />
        <StatTile
          label="Underperforming"
          value={weak.length}
          tone={weak.length ? "danger" : "success"}
          hint="Performance score below 50"
          href={tableLink("/vendors/performance", { band: "Underperforming" }, { sort: "score:asc" })}
        />
      </div>

      {top1 && top1.concentrationPercent > 25 && (
        <InlineAlert tone="warning">
          <RefLink href={`/vendors/${top1.id}`}>{top1.name}</RefLink> holds {percent(top1.concentrationPercent, 1)} of
          total spend. At this level a single vendor failure is an operational problem, not just a commercial one — the
          mitigation is a second qualified source, not a better price.
        </InlineAlert>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="Spend concentration" description="Share of total spend by vendor.">
          <RankedBars
            data={transacting.slice(0, 10).map((v) => ({
              label: v.name,
              value: v.concentrationPercent,
              sub: money(v.spend, "PKR", { compact: true }),
              href: `/vendors/${v.id}`,
            }))}
            format="percent"
            maxRows={10}
          />
        </SectionCard>
        <SectionCard title="Register by status" description="Composition of the vendor base.">
          <DonutChart
            data={statusMix.map((d) => ({ ...d, href: tableLink("/analytics/vendors", { status: d.label }) }))}
            centerLabel="Vendors"
            centerValue={String(rows.length)}
            format="number"
          />
        </SectionCard>
        <SectionCard title="Performance leaders" description="Computed score, highest first.">
          <RankedBars
            data={transacting
              .filter((v) => v.score !== null)
              .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
              .slice(0, 10)
              .map((v) => ({ label: v.name, value: round2(v.score ?? 0), href: `/vendors/${v.id}` }))}
            format="number"
            colorIndex={5}
            maxRows={10}
          />
        </SectionCard>
      </div>

      {withIssues.length > 0 && (
        <SectionCard
          title="Vendors with open issues"
          description="Unresolved issues drag the performance score and are the evidence base for any investigation."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap max-h-[20rem] overflow-y-auto">
            <table className="dt">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Status</th>
                  <th className="text-right">Open issues</th>
                  <th className="text-right">Invoice issues</th>
                  <th className="text-right">Performance</th>
                  <th className="text-right">Spend</th>
                  <th className="text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {withIssues
                  .sort((a, b) => b.openIssues - a.openIssues)
                  .map((v) => (
                    <tr key={v.id}>
                      <td>
                        <RefLink href={`/vendors/${v.id}?tab=issues`}>{v.name}</RefLink>
                      </td>
                      <td>
                        <StatusBadge status={v.status} />
                      </td>
                      <td className="num text-xs font-600 text-[var(--c-warning)]">{v.openIssues}</td>
                      <td className="num text-xs">{v.invoiceIssues || "—"}</td>
                      <td className="num text-xs">{v.score !== null ? round2(v.score) : "—"}</td>
                      <td className="num text-xs">{money(v.spend)}</td>
                      <td className="num text-xs">{percent(v.concentrationPercent, 1)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <DataTable
        id="vendor-analytics"
        columns={columns}
        rows={tableRows}
        defaultSort={{ key: "spend", dir: "desc" }}
        exportName="vendor-analytics"
        emptyState={
          <EmptyState title="No vendors on the register" description="Register and qualify vendors before analytics can say anything useful." />
        }
      />
    </div>
  );
}
