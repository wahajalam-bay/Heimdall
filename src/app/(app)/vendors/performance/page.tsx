import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
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
import { ActionButton } from "@/components/ui/forms";
import { RankedBars } from "@/components/ui/charts";
import { humanize } from "@/lib/domain";
import { fmtDate, money, percent, round2 } from "@/lib/format";
import { recomputePerformanceAction } from "../actions";
import { tableLink } from "@/lib/links";

export const metadata = { title: "Vendor performance" };
export const dynamic = "force-dynamic";

export default async function VendorPerformancePage() {
  const { user, authorized } = await pageContext(P.VENDOR_VIEW);
  if (!authorized) {
    return <AccessDenied title="Vendor performance" message="You do not have permission to view vendor performance." />;
  }

  const [vendors, savedViews] = await Promise.all([
    prisma.vendor.findMany({
      where: { totalOrders: { gt: 0 } },
      orderBy: [{ performanceScore: "desc" }, { name: "asc" }],
      include: {
        performance: { orderBy: { periodEnd: "desc" }, take: 1 },
        issues: { where: { status: { notIn: ["RESOLVED", "CLOSED"] } }, select: { id: true, severity: true } },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "vendor-performance", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const scored = vendors.filter((v) => v.performanceScore !== null);
  const strong = scored.filter((v) => (v.performanceScore ?? 0) >= 70);
  const weak = scored.filter((v) => (v.performanceScore ?? 0) < 50);
  const canRecompute = userHasPermission(user, P.VENDOR_EVALUATE, P.VENDOR_APPROVE, P.ANALYTICS_VIEW);

  const columns: TableColumn[] = [
    { key: "vendor", header: "Vendor", locked: true, sortable: true, minWidth: "16rem" },
    { key: "band", header: "Band", filterable: true, sortable: true, width: "11rem", defaultHidden: true },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "10rem" },
    { key: "score", header: "Score", numeric: true, sortable: true, width: "10rem" },
    { key: "onTime", header: "On time", numeric: true, sortable: true, width: "8.5rem" },
    { key: "quality", header: "Quality", numeric: true, sortable: true, width: "8.5rem" },
    { key: "rejection", header: "Rejection", numeric: true, sortable: true, width: "8.5rem" },
    { key: "orders", header: "Orders", numeric: true, sortable: true, width: "7rem" },
    { key: "spend", header: "Spend", numeric: true, sortable: true, width: "11rem" },
    { key: "late", header: "Late deliveries", numeric: true, sortable: true, width: "9.5rem" },
    { key: "partial", header: "Partial", numeric: true, sortable: true, width: "7.5rem" },
    { key: "qualityIssues", header: "Quality issues", numeric: true, sortable: true, width: "9.5rem" },
    { key: "invoiceIssues", header: "Invoice issues", numeric: true, sortable: true, width: "9.5rem" },
    { key: "openIssues", header: "Open issues", numeric: true, sortable: true, width: "9rem" },
    { key: "priceVariance", header: "Avg price variance", numeric: true, sortable: true, width: "11rem", defaultHidden: true },
    { key: "period", header: "Latest period", sortable: true, width: "12rem" },
    { key: "lastOrder", header: "Last order", sortable: true, width: "9.5rem" },
  ];

  const rows: TableRow[] = vendors.map((v) => {
    const p = v.performance[0];
    const score = v.performanceScore ?? 0;
    return {
      id: v.id,
      href: `/vendors/${v.id}?tab=performance`,
      flag: score >= 70 ? "success" : score < 50 ? "danger" : null,
      search: `${v.name} ${v.code}`,
      values: {
        vendor: v.name,
        status: humanize(v.status),
        band:
          v.performanceScore === null ? "Not scored" : score >= 70 ? "Performing well" : score < 50 ? "Underperforming" : "Middling",
        score: round2(score),
        onTime: round2(v.onTimePercent ?? 0),
        quality: round2(v.qualityPercent ?? 0),
        rejection: round2(v.rejectionPercent ?? 0),
        orders: v.totalOrders,
        spend: v.totalSpend,
        late: p?.lateDeliveries ?? 0,
        partial: p?.partialDeliveries ?? 0,
        qualityIssues: p?.qualityIssues ?? 0,
        invoiceIssues: p?.invoiceIssues ?? 0,
        openIssues: v.issues.length,
        priceVariance: round2(p?.avgPriceVariance ?? 0),
        period: p ? `${fmtDate(p.periodStart)} — ${fmtDate(p.periodEnd)}` : "",
        lastOrder: v.lastOrderAt ? v.lastOrderAt.toISOString() : "",
      },
      cells: {
        band:
          v.performanceScore === null ? (
            <span className="text-[var(--c-text-tertiary)]">Not scored</span>
          ) : score >= 70 ? (
            <Badge tone="success">Performing well</Badge>
          ) : score < 50 ? (
            <Badge tone="danger">Underperforming</Badge>
          ) : (
            <span className="text-[var(--c-text-tertiary)]">Middling</span>
          ),
        vendor: (
          <span>
            <RefLink href={`/vendors/${v.id}`}>{v.name}</RefLink>
            <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{v.code}</span>
          </span>
        ),
        status: <StatusBadge status={v.status} />,
        score:
          v.performanceScore === null ? (
            <span className="text-2xs text-[var(--c-text-tertiary)]">Not computed</span>
          ) : (
            <Meter value={score} max={100} tone={score >= 70 ? "success" : score >= 50 ? "warning" : "danger"} />
          ),
        onTime: v.onTimePercent === null ? "—" : percent(v.onTimePercent, 0),
        quality: v.qualityPercent === null ? "—" : percent(v.qualityPercent, 0),
        rejection:
          v.rejectionPercent === null ? (
            "—"
          ) : (
            <span className={v.rejectionPercent > 5 ? "text-[var(--c-danger)] font-600" : undefined}>
              {percent(v.rejectionPercent, 1)}
            </span>
          ),
        orders: v.totalOrders,
        spend: <Mono>{money(v.totalSpend)}</Mono>,
        late: p?.lateDeliveries ? <Badge tone="warning">{p.lateDeliveries}</Badge> : "—",
        partial: p?.partialDeliveries ?? "—",
        qualityIssues: p?.qualityIssues ? <Badge tone="danger">{p.qualityIssues}</Badge> : "—",
        invoiceIssues: p?.invoiceIssues ? <Badge tone="warning">{p.invoiceIssues}</Badge> : "—",
        openIssues: v.issues.length ? <Badge tone="warning">{v.issues.length}</Badge> : "—",
        priceVariance: p ? percent(p.avgPriceVariance, 1) : "—",
        period: p ? `${fmtDate(p.periodStart)} — ${fmtDate(p.periodEnd)}` : "—",
        lastOrder: v.lastOrderAt ? fmtDate(v.lastOrderAt) : "—",
      },
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Vendors", href: "/vendors" }, { label: "Performance" }]} />

      <PageHeader
        eyebrow="Vendors"
        title="Vendor performance"
        subtitle="Computed from delivery dates, inspection outcomes, invoice matching and recorded issues. Nothing here is typed in by hand."
        actions={
          canRecompute && (
            <ActionButton
              action={recomputePerformanceAction}
              payload={{ months: 12 }}
              label="Recompute all"
              tone="secondary"
              confirm="Recompute performance for every vendor over the last 12 months?"
            />
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Vendors with orders" value={vendors.length} href="/vendors/performance" />
        <StatTile
          label="Scored"
          value={scored.length}
          href={tableLink("/vendors/performance", { band: ["Performing well", "Middling", "Underperforming"] })}
        />
        <StatTile
          label="Performing well"
          value={strong.length}
          tone="success"
          hint="Score 70 or above"
          href={tableLink("/vendors/performance", { band: "Performing well" }, { sort: "score:desc" })}
        />
        <StatTile
          label="Underperforming"
          value={weak.length}
          tone={weak.length ? "danger" : "default"}
          hint="Score below 50"
          href={tableLink("/vendors/performance", { band: "Underperforming" }, { sort: "score:asc" })}
        />
      </div>

      {weak.length > 0 && (
        <InlineAlert tone="warning">
          {weak.length} vendor{weak.length === 1 ? "" : "s"} scoring below 50. Sustained underperformance is grounds for an
          investigation, not an immediate blacklisting — open a case so the evidence and the vendor&apos;s reply are on the
          record.
        </InlineAlert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Strongest performers" description="By computed performance score.">
          <RankedBars
            data={scored.slice(0, 10).map((v) => ({ label: v.name, value: round2(v.performanceScore ?? 0), href: `/vendors/${v.id}` }))}
            format="number"
            maxRows={10}
          />
        </SectionCard>
        <SectionCard title="Weakest performers" description="Where intervention is most likely warranted.">
          <RankedBars
            data={[...scored]
              .sort((a, b) => (a.performanceScore ?? 0) - (b.performanceScore ?? 0))
              .slice(0, 10)
              .map((v) => ({ label: v.name, value: round2(v.performanceScore ?? 0), href: `/vendors/${v.id}` }))}
            format="number"
            colorIndex={3}
            maxRows={10}
          />
        </SectionCard>
      </div>

      <DataTable
        id="vendor-performance"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "score", dir: "desc" }}
        exportName="vendor-performance"
        emptyState={
          <EmptyState
            title="No vendor has an order yet"
            description="Performance is derived from real transactions, so it appears once orders have been placed and received."
          />
        }
      />
    </div>
  );
}
