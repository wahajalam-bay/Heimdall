import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import {
  Badge,
  EmptyState,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { fmtDate, fmtDateTime, money, round2 } from "@/lib/format";
import { cpcOptions } from "../actions";
import { ScheduleMeetingForm } from "../CpcForms";
import { statusLink, tableLink } from "@/lib/links";

export const metadata = { title: "CPC meetings" };
export const dynamic = "force-dynamic";

export default async function CpcMeetingsPage() {
  const { user, ctx, authorized } = await pageContext(P.CPC_VIEW);
  if (!authorized) return <AccessDenied title="CPC meetings" message="You do not have permission to view CPC meetings." />;

  const scoped = visibleEntityIds(user);
  const [meetings, savedViews, options] = await Promise.all([
    prisma.cpcMeeting.findMany({
      where: scoped ? { entityId: { in: scoped } } : {},
      orderBy: { scheduledAt: "desc" },
      take: 300,
      include: {
        entity: { select: { code: true, name: true } },
        cases: { select: { id: true, number: true, status: true, amount: true, savingsAmount: true } },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "cpc-meetings", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
    cpcOptions(ctx.entityId),
  ]);

  const canManage = userHasPermission(user, P.CPC_MANAGE);
  const now = Date.now();
  const upcoming = meetings.filter((m) => m.scheduledAt.getTime() >= now && m.status !== "CANCELLED");
  const completed = meetings.filter((m) => m.status === "COMPLETED");
  const noMinutes = meetings.filter(
    (m) => m.scheduledAt.getTime() < now && m.status !== "CANCELLED" && !m.minutes,
  );

  const columns: TableColumn[] = [
    { key: "number", header: "Meeting", locked: true, sortable: true, width: "10rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "title", header: "Title", sortable: true, minWidth: "18rem" },
    { key: "type", header: "Type", filterable: true, sortable: true, width: "9rem" },
    { key: "scheduled", header: "Scheduled", sortable: true, width: "13rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "10rem" },
    { key: "cases", header: "Cases", numeric: true, sortable: true, width: "7rem" },
    { key: "decided", header: "Decided", numeric: true, sortable: true, width: "8rem" },
    { key: "value", header: "Value tabled", numeric: true, sortable: true, width: "11rem" },
    { key: "savings", header: "Savings endorsed", numeric: true, sortable: true, width: "11rem" },
    { key: "location", header: "Location", sortable: true, width: "13rem", defaultHidden: true },
    { key: "minutes", header: "Minutes", filterable: true, sortable: true, width: "9rem" },
    // Whether a meeting is still ahead is the clock against its scheduled date,
    // not its status, so the tile counting them points here.
    { key: "when", header: "When", filterable: true, sortable: true, width: "9rem", defaultHidden: true },
  ];

  const rows: TableRow[] = meetings.map((m) => {
    const decidedCount = m.cases.filter((c) =>
      ["APPROVED", "REJECTED", "RETURNED", "CLARIFICATION"].includes(c.status),
    ).length;
    const value = round2(m.cases.reduce((a, c) => a + c.amount, 0));
    const savings = round2(m.cases.reduce((a, c) => a + c.savingsAmount, 0));
    const overdueMinutes = m.scheduledAt.getTime() < now && m.status !== "CANCELLED" && !m.minutes;
    return {
      id: m.id,
      href: `/cpc/meetings/${m.id}`,
      flag: overdueMinutes ? "warning" : m.status === "COMPLETED" ? "success" : null,
      search: `${m.number} ${m.title} ${m.agenda ?? ""} ${m.location ?? ""}`,
      values: {
        when: m.status === "CANCELLED" ? "Cancelled" : m.scheduledAt.getTime() >= now ? "Upcoming" : "Past",
        number: m.number,
        entity: m.entity.code,
        title: m.title,
        type: humanize(m.meetingType),
        scheduled: m.scheduledAt.toISOString(),
        status: humanize(m.status),
        cases: m.cases.length,
        decided: decidedCount,
        value,
        savings,
        location: m.location ?? "",
        minutes: m.minutes ? "On file" : "Missing",
      },
      cells: {
        when:
          m.status === "CANCELLED" ? (
            <span className="text-[var(--c-text-tertiary)]">Cancelled</span>
          ) : m.scheduledAt.getTime() >= now ? (
            <Badge tone="accent">Upcoming</Badge>
          ) : (
            <span className="text-[var(--c-text-tertiary)]">Past</span>
          ),
        number: <RefLink href={`/cpc/meetings/${m.id}`}>{m.number}</RefLink>,
        entity: <Badge tone="neutral">{m.entity.code}</Badge>,
        title: (
          <span className="block max-w-[24rem] truncate" title={m.title}>
            {m.title}
          </span>
        ),
        type: humanize(m.meetingType),
        scheduled: fmtDateTime(m.scheduledAt),
        status: <StatusBadge status={m.status} />,
        cases: m.cases.length,
        decided: (
          <span className={decidedCount < m.cases.length ? "text-[var(--c-warning)]" : undefined}>
            {decidedCount} / {m.cases.length}
          </span>
        ),
        value: value > 0 ? money(value) : "—",
        savings: savings > 0 ? money(savings) : "—",
        location: m.location ?? "—",
        minutes: m.minutes ? <Badge tone="success">On file</Badge> : <Badge tone="warning">Missing</Badge>,
      },
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "CPC", href: "/cpc" }, { label: "Meetings" }]} />

      <PageHeader
        eyebrow="Governance"
        title="CPC meetings"
        subtitle="Sittings, agendas and minutes. Minutes are the committee's own record — cases still carry their individual decisions."
        actions={
          canManage && (
            <ScheduleMeetingForm
              entities={options.entities}
              defaultEntityId={ctx.entityId ?? options.entities[0]?.id ?? ""}
              pendingCases={options.unscheduled.map((c) => ({
                id: c.id,
                number: c.number,
                title: c.title,
                amount: c.amount,
                entityId: c.pr.entityId,
                prNumber: c.pr.number,
              }))}
            />
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Meetings held or scheduled" value={meetings.length} href="/cpc/meetings" />
        <StatTile
          label="Upcoming"
          value={upcoming.length}
          tone={upcoming.length ? "accent" : "default"}
          href={tableLink("/cpc/meetings", { when: "Upcoming" }, { sort: "scheduled:asc" })}
        />
        <StatTile
          label="Completed"
          value={completed.length}
          tone="success"
          href={statusLink("/cpc/meetings", "status", ["COMPLETED"])}
        />
        <StatTile
          label="Minutes outstanding"
          value={noMinutes.length}
          tone={noMinutes.length ? "warning" : "success"}
          hint="Meetings that have passed with no minutes on file"
          href={tableLink("/cpc/meetings", { when: "Past", minutes: "No" })}
        />
      </div>

      {upcoming.length > 0 && (
        <SectionCard title="Next sittings" description="What is on the agenda and how much of it is already decided.">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {upcoming.slice(0, 6).map((m) => {
              const decidedCount = m.cases.filter((c) =>
                ["APPROVED", "REJECTED", "RETURNED", "CLARIFICATION"].includes(c.status),
              ).length;
              return (
                <div key={m.id} className="rounded-xl border border-border px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <RefLink href={`/cpc/meetings/${m.id}`}>{m.number}</RefLink>
                    <Badge tone="neutral">{m.entity.code}</Badge>
                  </div>
                  <p className="mt-1 text-xs font-500">{m.title}</p>
                  <p className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">{fmtDateTime(m.scheduledAt)}</p>
                  <p className="mt-1.5 text-2xs">
                    {m.cases.length} case{m.cases.length === 1 ? "" : "s"} · {decidedCount} decided ·{" "}
                    {money(round2(m.cases.reduce((a, c) => a + c.amount, 0)))}
                  </p>
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}

      <DataTable
        id="cpc-meetings"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "scheduled", dir: "desc" }}
        exportName="cpc-meetings"
        emptyState={
          <EmptyState
            title="No meetings scheduled"
            description="Cases can be decided without a formal sitting, but a scheduled meeting keeps the agenda and minutes in one place."
          />
        }
      />
    </div>
  );
}
