import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { monthlyTrend, procurementKpis } from "@/server/analytics";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import {
  Badge,
  EmptyState,
  InlineAlert,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { ColumnChart, RankedBars } from "@/components/ui/charts";
import { humanize } from "@/lib/domain";
import { fmtDate, money, round2 } from "@/lib/format";
import { AnalyticsFilters } from "../AnalyticsFilters";
import { buildFilter, filterOptions, periodLabel } from "../filters";

export const metadata = { title: "Process performance" };
export const dynamic = "force-dynamic";

const hours = (a: Date, b: Date) => round2((b.getTime() - a.getTime()) / 3600000);
const days = (a: Date, b: Date) => round2((b.getTime() - a.getTime()) / 86400000);

/**
 * Process performance: how long each stage actually takes, measured from the
 * documents themselves rather than from self-reported dates.
 */
export default async function PerformancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, ctx, authorized } = await pageContext(P.ANALYTICS_VIEW);
  if (!authorized) {
    return <AccessDenied title="Process performance" message="You do not have permission to view performance analytics." />;
  }

  const sp = await searchParams;
  const filter = buildFilter(user, sp, ctx.entityId);
  const scope = filter.entityId ? { entityId: filter.entityId } : filter.entityIds ? { entityId: { in: filter.entityIds } } : {};
  const dateScope =
    filter.from || filter.to
      ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
      : {};

  const [kpis, options, trend, prs] = await Promise.all([
    procurementKpis(filter),
    filterOptions(user),
    monthlyTrend(filter, 12),
    prisma.purchaseRequisition.findMany({
      where: { ...scope, ...dateScope },
      orderBy: { createdAt: "desc" },
      take: 400,
      include: {
        entity: { select: { code: true } },
        department: { select: { name: true } },
        requester: { select: { name: true } },
        rfqs: {
          select: {
            issuedAt: true,
            createdAt: true,
            quotes: { select: { id: true, quoteDate: true } },
          },
          orderBy: { createdAt: "asc" },
        },
        comparatives: { select: { preparedAt: true, status: true }, orderBy: { preparedAt: "asc" } },
        cpcCases: { select: { createdAt: true, decidedAt: true, status: true }, orderBy: { createdAt: "asc" } },
        purchaseOrders: {
          select: {
            id: true,
            number: true,
            issuedAt: true,
            createdAt: true,
            total: true,
            status: true,
            grns: { select: { receivedAt: true, status: true }, orderBy: { receivedAt: "asc" } },
            invoices: { select: { receivedDate: true, handoffs: { select: { paidDate: true } } } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    }),
  ]);

  const collect: Record<string, number[]> = {
    submitToApprove: [],
    approveToRfq: [],
    rfqToQuotes: [],
    quotesToComparative: [],
    comparativeToCpc: [],
    cpcToPo: [],
    poToDelivery: [],
    deliveryToInvoice: [],
    invoiceToPayment: [],
  };

  const rows: TableRow[] = [];

  for (const pr of prs) {
    const firstRfq = pr.rfqs[0];
    const firstQuote = pr.rfqs.flatMap((r) => r.quotes).sort((a, b) => a.quoteDate.getTime() - b.quoteDate.getTime())[0];
    const comparative = pr.comparatives[0];
    const cpc = pr.cpcCases[0];
    const po = pr.purchaseOrders[0];
    const grn = po?.grns.find((g) => g.status === "POSTED") ?? po?.grns[0];
    const invoice = po?.invoices[0];
    const paid = invoice?.handoffs.find((h) => h.paidDate)?.paidDate ?? null;

    const submitToApprove = pr.approvedAt ? hours(pr.createdAt, pr.approvedAt) : null;
    const approveToRfq = pr.approvedAt && firstRfq?.issuedAt ? hours(pr.approvedAt, firstRfq.issuedAt) : null;
    const rfqToQuotes = firstRfq?.issuedAt && firstQuote ? hours(firstRfq.issuedAt, firstQuote.quoteDate) : null;
    const quotesToComparative = firstQuote && comparative ? hours(firstQuote.quoteDate, comparative.preparedAt) : null;
    const comparativeToCpc = comparative && cpc ? hours(comparative.preparedAt, cpc.createdAt) : null;
    const cpcToPo = cpc?.decidedAt && po?.issuedAt ? hours(cpc.decidedAt, po.issuedAt) : null;
    const poToDelivery = po?.issuedAt && grn?.receivedAt ? days(po.issuedAt, grn.receivedAt) : null;
    const deliveryToInvoice = grn?.receivedAt && invoice ? days(grn.receivedAt, invoice.receivedDate) : null;
    const invoiceToPayment = invoice && paid ? days(invoice.receivedDate, paid) : null;
    const endToEnd = po?.issuedAt ? days(pr.createdAt, po.issuedAt) : null;

    if (submitToApprove !== null) collect.submitToApprove.push(submitToApprove);
    if (approveToRfq !== null) collect.approveToRfq.push(approveToRfq);
    if (rfqToQuotes !== null) collect.rfqToQuotes.push(rfqToQuotes);
    if (quotesToComparative !== null) collect.quotesToComparative.push(quotesToComparative);
    if (comparativeToCpc !== null) collect.comparativeToCpc.push(comparativeToCpc);
    if (cpcToPo !== null) collect.cpcToPo.push(cpcToPo);
    if (poToDelivery !== null) collect.poToDelivery.push(poToDelivery);
    if (deliveryToInvoice !== null) collect.deliveryToInvoice.push(deliveryToInvoice);
    if (invoiceToPayment !== null) collect.invoiceToPayment.push(invoiceToPayment);

    rows.push({
      id: pr.id,
      href: `/pr/${pr.id}`,
      flag: endToEnd !== null && endToEnd > 30 ? "warning" : endToEnd !== null && endToEnd <= 10 ? "success" : null,
      search: `${pr.number} ${pr.title} ${pr.requester.name} ${po?.number ?? ""}`,
      values: {
        number: pr.number,
        entity: pr.entity.code,
        title: pr.title,
        department: pr.department.name,
        requester: pr.requester.name,
        status: humanize(pr.status),
        value: po?.total ?? pr.estimatedValue,
        approvalHours: submitToApprove ?? 0,
        sourcingHours: approveToRfq ?? 0,
        quoteHours: rfqToQuotes ?? 0,
        cpcHours: cpc?.decidedAt ? hours(cpc.createdAt, cpc.decidedAt) : 0,
        endToEnd: endToEnd ?? 0,
        deliveryDays: poToDelivery ?? 0,
        invoiceDays: deliveryToInvoice ?? 0,
        paymentDays: invoiceToPayment ?? 0,
        po: po?.number ?? "",
        raised: pr.createdAt.toISOString(),
      },
      cells: {
        number: <RefLink href={`/pr/${pr.id}`}>{pr.number}</RefLink>,
        entity: <Badge tone="neutral">{pr.entity.code}</Badge>,
        title: (
          <span className="block max-w-[24rem] truncate" title={pr.title}>
            {pr.title}
          </span>
        ),
        department: pr.department.name,
        requester: pr.requester.name,
        status: <StatusBadge status={pr.status} />,
        value: money(po?.total ?? pr.estimatedValue),
        approvalHours: submitToApprove !== null ? `${submitToApprove} h` : "—",
        sourcingHours: approveToRfq !== null ? `${approveToRfq} h` : "—",
        quoteHours: rfqToQuotes !== null ? `${rfqToQuotes} h` : "—",
        cpcHours: cpc?.decidedAt ? `${hours(cpc.createdAt, cpc.decidedAt)} h` : "—",
        endToEnd:
          endToEnd !== null ? (
            <span className={endToEnd > 30 ? "text-[var(--c-danger)] font-600" : undefined}>{endToEnd} d</span>
          ) : (
            "—"
          ),
        deliveryDays: poToDelivery !== null ? `${poToDelivery} d` : "—",
        invoiceDays: deliveryToInvoice !== null ? `${deliveryToInvoice} d` : "—",
        paymentDays: invoiceToPayment !== null ? `${invoiceToPayment} d` : "—",
        po: po ? <RefLink href={`/po/${po.id}`}>{po.number}</RefLink> : "—",
        raised: fmtDate(pr.createdAt),
      },
    });
  }

  const avg = (xs: number[]) => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return round2(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
  };

  const stages: Array<{ key: string; label: string; unit: "h" | "d"; samples: number[] }> = [
    { key: "submitToApprove", label: "Requisition to approval", unit: "h", samples: collect.submitToApprove },
    { key: "approveToRfq", label: "Approval to RFQ issued", unit: "h", samples: collect.approveToRfq },
    { key: "rfqToQuotes", label: "RFQ to first quotation", unit: "h", samples: collect.rfqToQuotes },
    { key: "quotesToComparative", label: "Quotations to comparative", unit: "h", samples: collect.quotesToComparative },
    { key: "comparativeToCpc", label: "Comparative to CPC case", unit: "h", samples: collect.comparativeToCpc },
    { key: "cpcToPo", label: "CPC decision to PO issued", unit: "h", samples: collect.cpcToPo },
    { key: "poToDelivery", label: "PO issued to goods received", unit: "d", samples: collect.poToDelivery },
    { key: "deliveryToInvoice", label: "Goods received to invoice", unit: "d", samples: collect.deliveryToInvoice },
    { key: "invoiceToPayment", label: "Invoice to payment", unit: "d", samples: collect.invoiceToPayment },
  ];

  const stageChart = stages
    .filter((s) => s.samples.length > 0)
    .map((s) => ({
      label: s.label,
      value: s.unit === "h" ? round2(avg(s.samples) / 24) : avg(s.samples),
      sub: `${s.samples.length} samples`,
    }));

  const trendData = trend.map((m) => ({ label: m.label, values: [m.prCount, m.poCount] }));

  const columns: TableColumn[] = [
    { key: "number", header: "Requisition", locked: true, sortable: true, width: "11rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "title", header: "Title", sortable: true, minWidth: "20rem" },
    { key: "department", header: "Department", filterable: true, sortable: true, width: "13rem" },
    { key: "requester", header: "Requester", sortable: true, width: "13rem", defaultHidden: true },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "12rem" },
    { key: "value", header: "Value", numeric: true, sortable: true, width: "11rem" },
    { key: "approvalHours", header: "To approval", numeric: true, sortable: true, width: "9.5rem" },
    { key: "sourcingHours", header: "To RFQ", numeric: true, sortable: true, width: "8.5rem" },
    { key: "quoteHours", header: "To first quote", numeric: true, sortable: true, width: "9.5rem" },
    { key: "cpcHours", header: "CPC decision", numeric: true, sortable: true, width: "9.5rem" },
    { key: "endToEnd", header: "Requisition to PO", numeric: true, sortable: true, width: "10rem" },
    { key: "deliveryDays", header: "PO to receipt", numeric: true, sortable: true, width: "9.5rem" },
    { key: "invoiceDays", header: "Receipt to invoice", numeric: true, sortable: true, width: "10rem" },
    { key: "paymentDays", header: "Invoice to payment", numeric: true, sortable: true, width: "10rem" },
    { key: "po", header: "Purchase order", sortable: true, width: "11rem" },
    { key: "raised", header: "Raised", sortable: true, width: "9rem" },
  ];

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Analytics", href: "/analytics" }, { label: "Performance" }]} />

      <PageHeader
        eyebrow="Analytics"
        title="Process performance"
        subtitle={`Stage-by-stage cycle time measured from the documents themselves — ${periodLabel(filter)}.`}
        actions={
          <Link href="/analytics/bottlenecks" className="btn btn-secondary btn-sm">
            Live bottlenecks
          </Link>
        }
      />

      <AnalyticsFilters entities={options.entities} departments={options.departments} show={["entity", "department", "from", "to"]} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Requisition to PO"
          value={`${kpis.avgCycleTimeDays} days`}
          hint="Average end to end"
          tone={kpis.avgCycleTimeDays > 21 ? "warning" : "default"}
        />
        <StatTile
          label="Approval turnaround"
          value={kpis.avgPrApprovalHours > 48 ? `${round2(kpis.avgPrApprovalHours / 24)} days` : `${kpis.avgPrApprovalHours} h`}
        />
        <StatTile
          label="Median PO to receipt"
          value={collect.poToDelivery.length ? `${median(collect.poToDelivery)} days` : "—"}
          hint={`${collect.poToDelivery.length} deliveries measured`}
        />
        <StatTile
          label="Median invoice to payment"
          value={collect.invoiceToPayment.length ? `${median(collect.invoiceToPayment)} days` : "—"}
          hint={`${collect.invoiceToPayment.length} payments measured`}
        />
      </div>

      {stageChart.length === 0 ? (
        <EmptyState
          title="Not enough completed work to measure"
          description="Stage durations appear once requisitions have travelled far enough through the lifecycle to have both endpoints."
        />
      ) : (
        <>
          <SectionCard
            title="Average stage duration"
            description="Expressed in days for comparability. The tallest bar is where the process actually loses time."
          >
            <RankedBars data={stageChart} format="decimal" maxRows={10} secondaryLabel="days" />
          </SectionCard>

          <SectionCard title="Stage detail" bodyClassName="px-0 py-0">
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th className="text-right">Samples</th>
                    <th className="text-right">Average</th>
                    <th className="text-right">Median</th>
                    <th className="text-right">Fastest</th>
                    <th className="text-right">Slowest</th>
                  </tr>
                </thead>
                <tbody>
                  {stages.map((s) => (
                    <tr key={s.key}>
                      <td className="text-xs font-500">{s.label}</td>
                      <td className="num text-xs">{s.samples.length || "—"}</td>
                      <td className="num text-xs">
                        {s.samples.length ? `${avg(s.samples)} ${s.unit}` : "—"}
                      </td>
                      <td className="num text-xs">
                        {s.samples.length ? `${median(s.samples)} ${s.unit}` : "—"}
                      </td>
                      <td className="num text-xs">
                        {s.samples.length ? `${round2(Math.min(...s.samples))} ${s.unit}` : "—"}
                      </td>
                      <td className="num text-xs">
                        {s.samples.length ? (
                          <span className="text-[var(--c-warning)]">
                            {round2(Math.max(...s.samples))} {s.unit}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </>
      )}

      <SectionCard title="Workload by month" description="Requisitions raised against purchase orders issued.">
        <ColumnChart
          data={trendData}
          series={[
            { key: "prCount", label: "Requisitions", colorIndex: 1 },
            { key: "poCount", label: "Purchase orders", colorIndex: 4 },
          ]}
          format="number"
          height={220}
        />
      </SectionCard>

      {kpis.avgQuotationsPerRfq < 3 && kpis.rfqCount > 0 && (
        <InlineAlert tone="warning">
          RFQs are averaging {kpis.avgQuotationsPerRfq} quotations. Below three, the comparative statement is weak
          evidence and the price is effectively unbenchmarked.
        </InlineAlert>
      )}

      <DataTable
        id="performance"
        columns={columns}
        rows={rows}
        defaultSort={{ key: "endToEnd", dir: "desc" }}
        exportName="process-performance"
        emptyState={
          <EmptyState title="No requisitions in this period" description="Widen the date range or clear the filters." />
        }
      />
    </div>
  );
}
