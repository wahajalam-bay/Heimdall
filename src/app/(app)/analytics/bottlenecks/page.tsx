import Link from "next/link";
import { pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { bottlenecks } from "@/server/analytics";
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
} from "@/components/ui/primitives";
import { RankedBars } from "@/components/ui/charts";
import { SEVERITY_TONE, humanize } from "@/lib/domain";
import { money, round2 } from "@/lib/format";
import { AnalyticsFilters } from "../AnalyticsFilters";
import { buildFilter, filterOptions } from "../filters";

export const metadata = { title: "Bottlenecks" };
export const dynamic = "force-dynamic";

/**
 * The bottleneck board: every place work is sitting, who owns it, how long it
 * has been there and what needs to happen next. Deliberately unsparing — the
 * point is that nothing waits invisibly.
 */
export default async function BottlenecksPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, ctx, authorized } = await pageContext(P.ANALYTICS_VIEW);
  if (!authorized) {
    return <AccessDenied title="Bottlenecks" message="You do not have permission to view the bottleneck board." />;
  }

  const sp = await searchParams;
  const filter = buildFilter(user, sp, ctx.entityId);
  const [rows, options] = await Promise.all([bottlenecks(filter), filterOptions(user)]);

  const overdue = rows.filter((b) => b.overdue);
  const critical = rows.filter((b) => b.severity === "CRITICAL");
  const valueHeld = round2(rows.reduce((a, b) => a + (b.value ?? 0), 0));

  const byStage = new Map<string, number>();
  const byOwner = new Map<string, number>();
  for (const b of rows) {
    byStage.set(b.stage, (byStage.get(b.stage) ?? 0) + 1);
    byOwner.set(b.owner, (byOwner.get(b.owner) ?? 0) + 1);
  }

  const columns: TableColumn[] = [
    { key: "stage", header: "Stage", locked: true, filterable: true, sortable: true, width: "15rem" },
    { key: "reference", header: "Document", sortable: true, width: "11rem" },
    { key: "documentType", header: "Type", filterable: true, sortable: true, width: "10rem" },
    { key: "title", header: "What is waiting", sortable: true, minWidth: "22rem" },
    { key: "owner", header: "Owner", filterable: true, sortable: true, width: "14rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "age", header: "Age", numeric: true, sortable: true, width: "9rem" },
    { key: "sla", header: "SLA (hours)", numeric: true, sortable: true, width: "9rem" },
    { key: "overdue", header: "Overdue", filterable: true, sortable: true, width: "8rem" },
    { key: "severity", header: "Severity", filterable: true, sortable: true, width: "9rem" },
    { key: "value", header: "Value held", numeric: true, sortable: true, width: "12rem" },
    { key: "reason", header: "Why it is waiting", sortable: true, minWidth: "22rem" },
    { key: "nextAction", header: "Next action", sortable: true, minWidth: "20rem" },
  ];

  const tableRows: TableRow[] = rows.map((b) => ({
    id: b.id,
    href: b.href,
    flag: b.severity === "CRITICAL" ? "danger" : b.overdue ? "warning" : null,
    search: `${b.documentRef} ${b.title} ${b.owner} ${b.reason} ${b.nextAction}`,
    values: {
      stage: b.stage,
      reference: b.documentRef,
      documentType: humanize(b.documentType),
      title: b.title,
      owner: b.owner,
      entity: b.entityCode ?? "",
      age: b.ageHours,
      sla: b.slaHours ?? 0,
      overdue: b.overdue ? "Yes" : "No",
      severity: b.severity,
      value: b.value ?? 0,
      reason: b.reason,
      nextAction: b.nextAction,
    },
    cells: {
      stage: <span className="text-xs font-500">{b.stage}</span>,
      reference: <RefLink href={b.href}>{b.documentRef}</RefLink>,
      documentType: humanize(b.documentType),
      title: (
        <span className="block max-w-[26rem] truncate" title={b.title}>
          {b.title}
        </span>
      ),
      owner: b.owner,
      entity: b.entityCode ? <Badge tone="neutral">{b.entityCode}</Badge> : "—",
      age: (
        <span className={b.overdue ? "text-[var(--c-danger)] font-600" : undefined}>
          {b.ageHours >= 48 ? `${round2(b.ageHours / 24)} d` : `${b.ageHours} h`}
        </span>
      ),
      sla: b.slaHours ?? "—",
      overdue: b.overdue ? <Badge tone="danger">Overdue</Badge> : <Badge tone="success">Within SLA</Badge>,
      severity: <Badge tone={SEVERITY_TONE[b.severity] ?? "neutral"}>{humanize(b.severity)}</Badge>,
      value: b.value !== null ? money(b.value) : "—",
      reason: (
        <span className="block max-w-[26rem] truncate" title={b.reason}>
          {b.reason}
        </span>
      ),
      nextAction: (
        <span className="block max-w-[24rem] truncate" title={b.nextAction}>
          {b.nextAction}
        </span>
      ),
    },
  }));

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Analytics", href: "/analytics" }, { label: "Bottlenecks" }]} />

      <PageHeader
        eyebrow="Analytics"
        title="Bottleneck board"
        subtitle="Everywhere work is sitting right now, with the owner, the age, the reason and the next action. Nothing waits anonymously."
        actions={
          <Link href="/api/export/bottlenecks" className="btn btn-secondary btn-sm" prefetch={false}>
            Export CSV
          </Link>
        }
      />

      <AnalyticsFilters entities={options.entities} show={["entity"]} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Items waiting" value={rows.length} tone={rows.length ? "warning" : "success"} />
        <StatTile label="Past SLA" value={overdue.length} tone={overdue.length ? "danger" : "success"} />
        <StatTile label="Critical" value={critical.length} tone={critical.length ? "danger" : "default"} />
        <StatTile label="Value held up" value={money(valueHeld)} hint="Order and invoice value in waiting states" />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing is stuck"
          description="No document is sitting past its stage owner. This is the state the board is meant to be in."
        />
      ) : (
        <>
          {critical.length > 0 && (
            <InlineAlert tone="danger">
              {critical.length} item{critical.length === 1 ? " is" : "s are"} critical:{" "}
              {critical
                .slice(0, 3)
                .map((b) => `${b.documentRef} (${b.owner})`)
                .join(", ")}
              {critical.length > 3 ? ` and ${critical.length - 3} more` : ""}.
            </InlineAlert>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="By stage" description="Which step in the chain is holding the most work.">
              <RankedBars
                data={[...byStage.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)}
                format="number"
                maxRows={10}
              />
            </SectionCard>
            <SectionCard title="By owner" description="Who has the most sitting with them.">
              <RankedBars
                data={[...byOwner.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)}
                format="number"
                colorIndex={2}
                maxRows={10}
              />
            </SectionCard>
          </div>

          {overdue.length > 0 && (
            <SectionCard
              title="Past SLA"
              description="These have exceeded the time their stage allows. Each row names the person and the action."
              bodyClassName="px-0 py-0"
            >
              <div className="table-wrap max-h-[24rem] overflow-y-auto">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Stage</th>
                      <th>Document</th>
                      <th>Owner</th>
                      <th className="text-right">Age</th>
                      <th className="text-right">SLA</th>
                      <th className="text-right">Value</th>
                      <th>Next action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overdue
                      .sort((a, b) => b.ageHours - a.ageHours)
                      .map((b) => (
                        <tr key={b.id} className="bg-[var(--c-danger-soft)]/25">
                          <td className="text-xs">{b.stage}</td>
                          <td>
                            <RefLink href={b.href}>{b.documentRef}</RefLink>
                          </td>
                          <td className="text-xs">{b.owner}</td>
                          <td className="num text-xs font-600 text-[var(--c-danger)]">
                            {b.ageHours >= 48 ? `${round2(b.ageHours / 24)} d` : `${b.ageHours} h`}
                          </td>
                          <td className="num text-2xs">{b.slaHours ? `${b.slaHours} h` : "—"}</td>
                          <td className="num text-xs">{b.value !== null ? money(b.value) : "—"}</td>
                          <td className="max-w-[24rem] text-2xs text-muted">{b.nextAction}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}

          <DataTable
            id="bottlenecks"
            columns={columns}
            rows={tableRows}
            defaultSort={{ key: "age", dir: "desc" }}
            exportName="bottlenecks"
          />
        </>
      )}
    </div>
  );
}
