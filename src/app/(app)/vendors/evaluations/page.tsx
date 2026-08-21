import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { scoreBand } from "@/server/vendors";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, Mono, PageHeader, RefLink, SectionCard, StatTile } from "@/components/ui/primitives";
import { ColumnChart } from "@/components/ui/charts";
import { humanize } from "@/lib/domain";
import { fmtDate, percent, round2 } from "@/lib/format";

export const metadata = { title: "Vendor evaluations" };
export const dynamic = "force-dynamic";

export default async function VendorEvaluationsPage() {
  const { user, authorized } = await pageContext(P.VENDOR_VIEW);
  if (!authorized) {
    return <AccessDenied title="Vendor evaluations" message="You do not have permission to view vendor evaluations." />;
  }

  const [evaluations, savedViews, passMark, configuredMax] = await Promise.all([
    prisma.vendorEvaluation.findMany({
      orderBy: { evaluatedAt: "desc" },
      take: 400,
      include: {
        vendor: { select: { id: true, code: true, name: true, status: true } },
        evaluator: { select: { name: true } },
        scores: { select: { id: true, criterion: { select: { group: true } }, weightedScore: true } },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "vendor-evaluations", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
    getConfigNumber(CONFIG_KEYS.VENDOR_MIN_SCORE, null),
    getConfigNumber(CONFIG_KEYS.VENDOR_MAX_SCORE, null),
  ]);

  const passed = evaluations.filter((e) => e.passed).length;
  const bands = [
    { label: "Below 50%", min: 0, max: 50 },
    { label: "50–59%", min: 50, max: 60 },
    { label: "60–69%", min: 60, max: 70 },
    { label: "70–79%", min: 70, max: 80 },
    { label: "80%+", min: 80, max: 1000 },
  ].map((b) => ({
    label: b.label,
    values: [evaluations.filter((e) => e.percentage >= b.min && e.percentage < b.max).length],
  }));

  const columns: TableColumn[] = [
    { key: "number", header: "Evaluation", locked: true, sortable: true, width: "10rem" },
    { key: "vendor", header: "Vendor", sortable: true, minWidth: "16rem" },
    { key: "type", header: "Type", filterable: true, sortable: true, width: "12rem" },
    { key: "score", header: "Score", numeric: true, sortable: true, width: "9rem" },
    { key: "max", header: "Max", numeric: true, sortable: true, width: "7rem" },
    { key: "percentage", header: "Percentage", numeric: true, sortable: true, width: "9rem" },
    { key: "passMark", header: "Pass mark", numeric: true, sortable: true, width: "8.5rem" },
    { key: "outcome", header: "Outcome", filterable: true, sortable: true, width: "8.5rem" },
    { key: "band", header: "Band", filterable: true, sortable: true, width: "10rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "9rem" },
    { key: "criteria", header: "Criteria scored", numeric: true, sortable: true, width: "9rem" },
    { key: "vendorStatus", header: "Vendor status", filterable: true, sortable: true, width: "10rem" },
    { key: "evaluator", header: "Evaluator", sortable: true, width: "12rem" },
    { key: "date", header: "Evaluated", sortable: true, width: "9.5rem" },
    { key: "recommendation", header: "Recommendation", sortable: true, minWidth: "18rem", defaultHidden: true },
  ];

  const rows: TableRow[] = evaluations.map((e) => {
    const band = scoreBand(e.percentage);
    return {
      id: e.id,
      href: `/vendors/${e.vendor.id}?tab=evaluations`,
      flag: e.passed ? "success" : "danger",
      search: `${e.number} ${e.vendor.name} ${e.vendor.code} ${e.evaluator.name} ${e.recommendation ?? ""}`,
      values: {
        number: e.number,
        vendor: e.vendor.name,
        type: humanize(e.evaluationType),
        score: round2(e.totalScore),
        max: round2(e.maxScore),
        percentage: round2(e.percentage),
        passMark: round2(e.passingScore),
        outcome: e.passed ? "Passed" : "Failed",
        band: band.label,
        status: humanize(e.status),
        criteria: e.scores.length,
        vendorStatus: humanize(e.vendor.status),
        evaluator: e.evaluator.name,
        date: e.evaluatedAt.toISOString(),
        recommendation: e.recommendation ?? "",
      },
      cells: {
        number: <Mono>{e.number}</Mono>,
        vendor: (
          <span>
            <RefLink href={`/vendors/${e.vendor.id}`}>{e.vendor.name}</RefLink>
            <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{e.vendor.code}</span>
          </span>
        ),
        type: humanize(e.evaluationType),
        score: <Mono>{round2(e.totalScore)}</Mono>,
        max: round2(e.maxScore),
        percentage: percent(e.percentage, 1),
        passMark: round2(e.passingScore),
        outcome: <Badge tone={e.passed ? "success" : "danger"}>{e.passed ? "Passed" : "Failed"}</Badge>,
        band: <Badge tone={band.tone}>{band.label}</Badge>,
        status: <Badge tone="neutral">{humanize(e.status)}</Badge>,
        criteria: e.scores.length,
        vendorStatus: <Badge tone="neutral">{humanize(e.vendor.status)}</Badge>,
        evaluator: e.evaluator.name,
        date: fmtDate(e.evaluatedAt),
        recommendation: (
          <span className="block max-w-[24rem] truncate" title={e.recommendation ?? ""}>
            {e.recommendation ?? "—"}
          </span>
        ),
      },
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Vendors", href: "/vendors" }, { label: "Evaluations" }]} />

      <PageHeader
        eyebrow="Vendors"
        title="Pre-qualification evaluations"
        subtitle={`Every scoring sheet ever recorded, with the pass mark that applied at the time. Current policy: ${passMark} of ${configuredMax}.`}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Evaluations recorded" value={evaluations.length} />
        <StatTile label="Passed" value={passed} tone="success" />
        <StatTile label="Failed" value={evaluations.length - passed} tone={evaluations.length - passed ? "warning" : "default"} />
        <StatTile
          label="Average percentage"
          value={
            evaluations.length
              ? percent(round2(evaluations.reduce((a, e) => a + e.percentage, 0) / evaluations.length), 1)
              : "—"
          }
        />
      </div>

      {evaluations.length > 0 && (
        <SectionCard title="Score distribution" description="How the vendor base scores against the criteria in force.">
          <ColumnChart data={bands} series={[{ key: "count", label: "Evaluations", colorIndex: 0 }]} format="number" height={200} />
        </SectionCard>
      )}

      <DataTable
        id="vendor-evaluations"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "date", dir: "desc" }}
        exportName="vendor-evaluations"
        emptyState={
          <EmptyState
            title="No evaluations recorded"
            description="Score a vendor from its record or from the pre-qualification queue."
          />
        }
      />
    </div>
  );
}
