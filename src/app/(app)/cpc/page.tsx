import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { CONFIG_KEYS, getConfigBool, getConfigNumber } from "@/lib/config";
import { cpcStats } from "@/server/cpc";
import { AccessDenied } from "@/components/ui/guard";
import {
  Badge,
  EmptyState,
  InlineAlert,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { ColumnChart, DonutChart } from "@/components/ui/charts";
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, fmtDateTime, money, round2 } from "@/lib/format";
import { cpcOptions } from "./actions";
import { ScheduleMeetingForm } from "./CpcForms";

export const metadata = { title: "Central Procurement Committee" };
export const dynamic = "force-dynamic";

export default async function CpcPage() {
  const { user, ctx, authorized } = await pageContext(P.CPC_VIEW);
  if (!authorized) {
    return <AccessDenied title="Central Procurement Committee" message="You do not have permission to view CPC cases." />;
  }

  const scoped = visibleEntityIds(user);
  const prFilter = scoped ? { pr: { entityId: { in: scoped } } } : {};

  const [stats, pendingCases, upcoming, recentDecisions, myCases, entityThresholds, options] = await Promise.all([
    cpcStats(scoped),
    prisma.cpcCase.findMany({
      where: { status: { in: ["PENDING", "SCHEDULED", "UNDER_REVIEW"] }, ...prFilter },
      orderBy: { createdAt: "asc" },
      include: {
        pr: { select: { id: true, number: true, title: true, entity: { select: { code: true } }, department: { select: { name: true } } } },
        meeting: { select: { id: true, number: true, scheduledAt: true } },
        members: { select: { userId: true, required: true, roleLabel: true } },
        decisions: { select: { memberId: true, vote: true } },
        comparative: {
          select: { lines: { where: { isSelected: true }, select: { vendor: { select: { name: true } } } } },
        },
      },
    }),
    prisma.cpcMeeting.findMany({
      where: { status: { in: ["SCHEDULED", "IN_PROGRESS"] }, ...(scoped ? { entityId: { in: scoped } } : {}) },
      orderBy: { scheduledAt: "asc" },
      take: 5,
      include: { entity: { select: { code: true } }, cases: { select: { id: true, status: true } } },
    }),
    prisma.cpcCase.findMany({
      where: { decidedAt: { not: null }, ...prFilter },
      orderBy: { decidedAt: "desc" },
      take: 10,
      include: { pr: { select: { id: true, number: true, entity: { select: { code: true } } } } },
    }),
    prisma.cpcCase.findMany({
      where: {
        status: { in: ["PENDING", "SCHEDULED", "UNDER_REVIEW"] },
        members: { some: { userId: user.id } },
        ...prFilter,
      },
      include: {
        pr: { select: { id: true, number: true, title: true } },
        decisions: { where: { memberId: user.id }, select: { vote: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    Promise.all(
      ctx.entities.map(async (e) => ({
        code: e.code,
        name: e.name,
        enabled: await getConfigBool(CONFIG_KEYS.CPC_ENABLED, e.id),
        threshold: await getConfigNumber(CONFIG_KEYS.CPC_THRESHOLD, e.id),
      })),
    ),
    cpcOptions(ctx.entityId),
  ]);

  const canManage = userHasPermission(user, P.CPC_MANAGE);

  const outcomeMix = [
    { label: "Approved", value: stats.approved, colorIndex: 5 },
    { label: "Rejected", value: stats.rejected, colorIndex: 3 },
    { label: "Returned", value: stats.returned, colorIndex: 2 },
    { label: "Open", value: stats.pending, colorIndex: 0 },
  ].filter((d) => d.value > 0);

  const ageBuckets = [
    { label: "0–2 days", min: 0, max: 3 },
    { label: "3–7 days", min: 3, max: 8 },
    { label: "8–14 days", min: 8, max: 15 },
    { label: "15+ days", min: 15, max: 100000 },
  ].map((b) => ({
    label: b.label,
    values: [pendingCases.filter((c) => { const d = ageDays(c.createdAt) ?? 0; return d >= b.min && d < b.max; }).length],
  }));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Governance"
        title="Central Procurement Committee"
        subtitle="Cases above the configured threshold cannot become purchase orders without a recorded committee decision. Each member's vote is attributed and permanent."
        actions={
          <>
            <Link href="/cpc/cases" className="btn btn-secondary btn-sm">
              All cases
            </Link>
            <Link href="/cpc/meetings" className="btn btn-secondary btn-sm">
              Meetings
            </Link>
            {canManage && (
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
            )}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Open cases" value={stats.pending} tone={stats.pending ? "warning" : "success"} />
        <StatTile label="Value under review" value={money(round2(pendingCases.reduce((a, c) => a + c.amount, 0)))} />
        <StatTile
          label="Average time to decision"
          value={stats.avgApprovalHours > 48 ? `${round2(stats.avgApprovalHours / 24)} days` : `${stats.avgApprovalHours} h`}
          hint="From case creation to recorded outcome"
        />
        <StatTile label="Savings endorsed" value={money(stats.totalSavings)} tone="success" />
      </div>

      {myCases.length > 0 && (
        <SectionCard
          title="Awaiting your decision"
          description="Cases where you are a committee member and have not yet voted."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Requisition</th>
                  <th>Title</th>
                  <th className="text-right">Value</th>
                  <th>Status</th>
                  <th>Your vote</th>
                  <th className="text-right">Waiting</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {myCases.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <RefLink href={`/cpc/cases/${c.id}`}>{c.number}</RefLink>
                    </td>
                    <td>
                      <RefLink href={`/pr/${c.pr.id}`}>{c.pr.number}</RefLink>
                    </td>
                    <td className="max-w-[24rem] truncate text-xs" title={c.title}>
                      {c.title}
                    </td>
                    <td className="num text-xs">{money(c.amount)}</td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td>
                      {c.decisions[0] ? (
                        <Badge tone={c.decisions[0].vote === "APPROVE" ? "success" : "warning"}>
                          {humanize(c.decisions[0].vote)}
                        </Badge>
                      ) : (
                        <Badge tone="danger">Not voted</Badge>
                      )}
                    </td>
                    <td className="num text-xs">{ageDays(c.createdAt) ?? 0} d</td>
                    <td>
                      <Link href={`/cpc/cases/${c.id}`} className="btn btn-primary btn-xs">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <SectionCard
          title="Cases in the queue"
          description="Everything awaiting the committee, oldest first."
          bodyClassName="px-0 py-0"
        >
          {pendingCases.length === 0 ? (
            <EmptyState
              title="No cases awaiting the committee"
              description="Cases arrive here automatically when a recommended comparative crosses the configured threshold."
            />
          ) : (
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Entity</th>
                    <th>Requisition</th>
                    <th>Recommended vendor</th>
                    <th className="text-right">Value</th>
                    <th className="text-right">Savings</th>
                    <th>Votes</th>
                    <th>Meeting</th>
                    <th className="text-right">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingCases.map((c) => {
                    const required = c.members.filter((m) => m.required).length;
                    const voted = new Set(c.decisions.map((d) => d.memberId)).size;
                    const age = ageDays(c.createdAt) ?? 0;
                    return (
                      <tr key={c.id}>
                        <td>
                          <RefLink href={`/cpc/cases/${c.id}`}>{c.number}</RefLink>
                        </td>
                        <td>
                          <Badge tone="neutral">{c.pr.entity.code}</Badge>
                        </td>
                        <td>
                          <RefLink href={`/pr/${c.pr.id}`}>{c.pr.number}</RefLink>
                          <span className="mt-0.5 block max-w-[16rem] truncate text-2xs text-[var(--c-text-tertiary)]">
                            {c.pr.title}
                          </span>
                        </td>
                        <td className="text-xs">{c.comparative?.lines[0]?.vendor.name ?? "—"}</td>
                        <td className="num text-xs">{money(c.amount)}</td>
                        <td className="num text-xs">{c.savingsAmount > 0 ? money(c.savingsAmount) : "—"}</td>
                        <td className="text-2xs">
                          <span className={voted >= required ? "text-[var(--c-success)]" : undefined}>
                            {voted} / {required}
                          </span>
                        </td>
                        <td className="text-2xs">
                          {c.meeting ? (
                            <RefLink href={`/cpc/meetings/${c.meeting.id}`}>{fmtDate(c.meeting.scheduledAt)}</RefLink>
                          ) : (
                            <Badge tone="warning">Unscheduled</Badge>
                          )}
                        </td>
                        <td className="num text-xs">
                          <span className={age > 7 ? "text-[var(--c-danger)] font-600" : undefined}>{age} d</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <div className="space-y-4">
          <SectionCard title="Upcoming sittings">
            {upcoming.length === 0 ? (
              <p className="text-xs text-muted">
                No meetings scheduled. Cases can still be decided individually, but a sitting keeps the record tidy.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {upcoming.map((m) => (
                  <li key={m.id} className="rounded-xl border border-border px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <RefLink href={`/cpc/meetings/${m.id}`}>{m.number}</RefLink>
                      <StatusBadge status={m.status} />
                    </div>
                    <p className="mt-1 text-xs">{m.title}</p>
                    <p className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">
                      {m.entity.code} · {fmtDateTime(m.scheduledAt)} · {m.cases.length} case
                      {m.cases.length === 1 ? "" : "s"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {outcomeMix.length > 0 && (
            <SectionCard title="Outcome mix" description="All cases ever raised.">
              <DonutChart data={outcomeMix} centerLabel="Cases" centerValue={String(stats.approved + stats.rejected + stats.returned + stats.pending)} format="number" />
            </SectionCard>
          )}

          <SectionCard title="Queue age" description="How long open cases have been waiting.">
            <ColumnChart data={ageBuckets} series={[{ key: "cases", label: "Open cases", colorIndex: 2 }]} format="number" height={180} />
          </SectionCard>

          <SectionCard title="Threshold in force" description="Configured per entity — no value is hard-coded.">
            <ul className="space-y-2">
              {entityThresholds.map((e) => (
                <li key={e.code} className="flex items-baseline justify-between gap-3 text-xs">
                  <span>
                    <Mono>{e.code}</Mono>
                    <span className="ml-2 text-muted">{e.name}</span>
                  </span>
                  <span className="text-right">
                    {e.enabled ? (
                      <span className="tnum font-600">{money(e.threshold)}</span>
                    ) : (
                      <Badge tone="neutral">CPC disabled</Badge>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      </div>

      {recentDecisions.length > 0 && (
        <SectionCard title="Recent decisions" bodyClassName="px-0 py-0">
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Entity</th>
                  <th>Requisition</th>
                  <th>Title</th>
                  <th className="text-right">Value</th>
                  <th>Outcome</th>
                  <th>Decided</th>
                </tr>
              </thead>
              <tbody>
                {recentDecisions.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <RefLink href={`/cpc/cases/${c.id}`}>{c.number}</RefLink>
                    </td>
                    <td>
                      <Badge tone="neutral">{c.pr.entity.code}</Badge>
                    </td>
                    <td>
                      <RefLink href={`/pr/${c.pr.id}`}>{c.pr.number}</RefLink>
                    </td>
                    <td className="max-w-[24rem] truncate text-xs" title={c.title}>
                      {c.title}
                    </td>
                    <td className="num text-xs">{money(c.amount)}</td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="text-xs">{c.decidedAt ? fmtDateTime(c.decidedAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {stats.pending === 0 && pendingCases.length === 0 && (
        <InlineAlert tone="success">
          Nothing is waiting on the committee. Cases appear here as soon as a recommended comparative crosses the
          threshold for its entity.
        </InlineAlert>
      )}
    </div>
  );
}
