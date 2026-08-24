import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { visibleEntityIds } from "@/lib/rbac";
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
import { DonutChart, RankedBars } from "@/components/ui/charts";
import { EXCEPTION_TYPES, SEVERITY_TONE, humanize } from "@/lib/domain";
import { ageDays, fmtDate, round2 } from "@/lib/format";
import { AnalyticsFilters } from "../AnalyticsFilters";
import { buildFilter, filterOptions } from "../filters";

export const metadata = { title: "Exceptions" };
export const dynamic = "force-dynamic";

const OPEN = ["OPEN", "IN_PROGRESS"];

export default async function ExceptionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, ctx, authorized } = await pageContext(P.EXCEPTION_VIEW);
  if (!authorized) {
    return <AccessDenied title="Exceptions" message="You do not have permission to view exceptions." />;
  }

  const sp = await searchParams;
  const filter = buildFilter(user, sp, ctx.entityId);
  const scoped = visibleEntityIds(user);

  const [rows, savedViews, options] = await Promise.all([
    prisma.exception.findMany({
      where: {
        ...(filter.entityId ? { entityId: filter.entityId } : scoped ? { OR: [{ entityId: { in: scoped } }, { entityId: null }] } : {}),
        ...(filter.from || filter.to
          ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }],
      take: 600,
      include: {
        owner: { select: { id: true, name: true } },
        raisedBy: { select: { id: true, name: true } },
        pr: { select: { id: true, number: true } },
        po: { select: { id: true, number: true } },
        invoice: { select: { id: true, number: true } },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "exceptions", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
    filterOptions(user),
  ]);

  const open = rows.filter((e) => OPEN.includes(e.status));
  const blocking = open.filter((e) => e.blocking);
  const critical = open.filter((e) => e.severity === "CRITICAL");
  const waived = rows.filter((e) => e.status === "WAIVED");
  const overdue = open.filter((e) => e.dueAt && e.dueAt.getTime() < Date.now());

  const byType = EXCEPTION_TYPES.map((t) => ({
    label: humanize(t),
    value: rows.filter((e) => e.type === t).length,
  })).filter((d) => d.value > 0);

  const severityMix = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
    .map((s, i) => ({ label: humanize(s), value: open.filter((e) => e.severity === s).length, colorIndex: [3, 2, 4, 6][i] }))
    .filter((d) => d.value > 0);

  const byOwner = new Map<string, number>();
  for (const e of open) {
    const key = e.owner?.name ?? "Unassigned";
    byOwner.set(key, (byOwner.get(key) ?? 0) + 1);
  }

  const columns: TableColumn[] = [
    { key: "number", header: "Exception", locked: true, sortable: true, width: "10rem" },
    { key: "type", header: "Type", filterable: true, sortable: true, width: "15rem" },
    { key: "severity", header: "Severity", filterable: true, sortable: true, width: "8.5rem" },
    { key: "blocking", header: "Blocking", filterable: true, sortable: true, width: "8rem" },
    { key: "title", header: "What happened", sortable: true, minWidth: "24rem" },
    { key: "document", header: "Document", sortable: true, width: "12rem" },
    { key: "case", header: "Case", sortable: true, width: "11rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "10rem" },
    { key: "owner", header: "Owner", filterable: true, sortable: true, width: "13rem" },
    { key: "raisedBy", header: "Raised by", sortable: true, width: "13rem", defaultHidden: true },
    { key: "raised", header: "Raised", sortable: true, width: "9rem" },
    { key: "due", header: "Due", sortable: true, width: "9rem" },
    { key: "age", header: "Age (days)", numeric: true, sortable: true, width: "8rem" },
    { key: "resolved", header: "Resolved", sortable: true, width: "9rem", defaultHidden: true },
  ];

  const tableRows: TableRow[] = rows.map((e) => {
    const isOpen = OPEN.includes(e.status);
    const age = ageDays(e.createdAt) ?? 0;
    const isOverdue = !!e.dueAt && e.dueAt.getTime() < Date.now() && isOpen;
    const docHref = e.invoice
      ? `/invoices/${e.invoice.id}`
      : e.po
        ? `/po/${e.po.id}`
        : e.pr
          ? `/pr/${e.pr.id}`
          : undefined;
    const docRef = e.invoice?.number ?? e.po?.number ?? e.pr?.number ?? e.documentRef;
    return {
      id: e.id,
      href: `/analytics/exceptions/${e.id}`,
      flag: e.blocking && isOpen ? "danger" : isOverdue ? "warning" : !isOpen ? "success" : null,
      search: `${e.number} ${e.title} ${e.documentRef} ${e.caseKey ?? ""} ${e.description ?? ""}`,
      values: {
        number: e.number,
        type: humanize(e.type),
        severity: e.severity,
        blocking: e.blocking ? "Yes" : "No",
        title: e.title,
        document: docRef,
        case: e.caseKey ?? "",
        status: humanize(e.status),
        owner: e.owner?.name ?? "Unassigned",
        raisedBy: e.raisedBy?.name ?? "System",
        raised: e.createdAt.toISOString(),
        due: e.dueAt ? e.dueAt.toISOString() : "",
        age,
        resolved: e.resolvedAt ? e.resolvedAt.toISOString() : "",
      },
      cells: {
        number: <RefLink href={`/analytics/exceptions/${e.id}`}>{e.number}</RefLink>,
        type: humanize(e.type),
        severity: <Badge tone={SEVERITY_TONE[e.severity] ?? "neutral"}>{humanize(e.severity)}</Badge>,
        blocking: e.blocking ? <Badge tone="danger">Blocking</Badge> : <Badge tone="neutral">No</Badge>,
        title: (
          <span className="block max-w-[30rem] truncate" title={e.title}>
            {e.title}
          </span>
        ),
        document: docHref ? <RefLink href={docHref}>{docRef}</RefLink> : docRef,
        case: e.caseKey ?? "—",
        status: <StatusBadge status={e.status} />,
        owner: e.owner?.name ?? <span className="text-2xs text-[var(--c-text-tertiary)]">Unassigned</span>,
        raisedBy: e.raisedBy?.name ?? "System",
        raised: fmtDate(e.createdAt),
        due: e.dueAt ? (
          <span className={isOverdue ? "text-[var(--c-danger)] font-600" : undefined}>{fmtDate(e.dueAt)}</span>
        ) : (
          "—"
        ),
        age: isOpen ? age : "—",
        resolved: e.resolvedAt ? fmtDate(e.resolvedAt) : "—",
      },
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Analytics", href: "/analytics" }, { label: "Exceptions" }]} />

      <PageHeader
        eyebrow="Governance"
        title="Exceptions"
        subtitle="Control breaches as first-class objects: each one is owned, aged and closed out with a written outcome. Blocking exceptions stop the transaction until they are dealt with."
        actions={
          <Link href="/api/export/exceptions" className="btn btn-secondary btn-sm" prefetch={false}>
            Export CSV
          </Link>
        }
      />

      <AnalyticsFilters entities={options.entities} show={["entity", "from", "to"]} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Open exceptions" value={open.length} tone={open.length ? "warning" : "success"} />
        <StatTile
          label="Blocking"
          value={blocking.length}
          tone={blocking.length ? "danger" : "success"}
          hint="Stopping a transaction right now"
        />
        <StatTile label="Critical" value={critical.length} tone={critical.length ? "danger" : "default"} />
        <StatTile
          label="Waived to date"
          value={waived.length}
          tone={waived.length ? "warning" : "default"}
          hint="Controls deliberately overridden"
        />
      </div>

      {blocking.length > 0 && (
        <InlineAlert tone="danger">
          {blocking.length} blocking exception{blocking.length === 1 ? " is" : "s are"} open. Each one is holding a
          transaction — resolve the cause or have an authorised approver record a waiver; nothing proceeds silently.
        </InlineAlert>
      )}

      {overdue.length > 0 && (
        <SectionCard
          title="Past their due date"
          description="Exceptions that were given a deadline and have passed it."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap max-h-[20rem] overflow-y-auto">
            <table className="dt">
              <thead>
                <tr>
                  <th>Exception</th>
                  <th>Type</th>
                  <th>Severity</th>
                  <th>Owner</th>
                  <th>Due</th>
                  <th className="text-right">Days late</th>
                  <th>Blocking</th>
                </tr>
              </thead>
              <tbody>
                {overdue.map((e) => (
                  <tr key={e.id} className="bg-[var(--c-danger-soft)]/25">
                    <td>
                      <RefLink href={`/analytics/exceptions/${e.id}`}>{e.number}</RefLink>
                      <span className="mt-0.5 block max-w-[22rem] truncate text-2xs text-[var(--c-text-tertiary)]">
                        {e.title}
                      </span>
                    </td>
                    <td className="text-2xs">{humanize(e.type)}</td>
                    <td>
                      <Badge tone={SEVERITY_TONE[e.severity] ?? "neutral"}>{humanize(e.severity)}</Badge>
                    </td>
                    <td className="text-xs">{e.owner?.name ?? "Unassigned"}</td>
                    <td className="text-xs">{e.dueAt ? fmtDate(e.dueAt) : "—"}</td>
                    <td className="num text-xs font-600 text-[var(--c-danger)]">
                      {e.dueAt ? round2(ageDays(e.dueAt) ?? 0) : "—"}
                    </td>
                    <td>{e.blocking ? <Badge tone="danger">Yes</Badge> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="By type" description="What actually goes wrong, all time.">
          <RankedBars data={byType.sort((a, b) => b.value - a.value)} format="number" maxRows={10} />
        </SectionCard>
        <SectionCard title="Open by severity">
          {severityMix.length > 0 ? (
            <DonutChart data={severityMix} centerLabel="Open" centerValue={String(open.length)} format="number" />
          ) : (
            <p className="py-8 text-center text-xs text-muted">Nothing open.</p>
          )}
        </SectionCard>
        <SectionCard title="Open by owner" description="Unassigned exceptions are nobody's problem — that is the risk.">
          <RankedBars
            data={[...byOwner.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)}
            format="number"
            colorIndex={2}
            maxRows={10}
          />
        </SectionCard>
      </div>

      <DataTable
        id="exceptions"
        columns={columns}
        rows={tableRows}
        savedViews={savedViews}
        defaultSort={{ key: "raised", dir: "desc" }}
        exportName="exceptions"
        emptyState={
          <EmptyState
            title="No exceptions recorded"
            description="Exceptions are raised automatically when a control is breached — a short delivery, a failed inspection, an invoice mismatch, a missing store entry."
          />
        }
      />
    </div>
  );
}
