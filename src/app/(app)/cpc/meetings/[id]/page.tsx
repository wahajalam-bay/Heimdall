import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { documentTimeline } from "@/server/timeline";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  DefList,
  EmptyState,
  InlineAlert,
  MetaItem,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { Timeline } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { humanize } from "@/lib/domain";
import { fmtDate, fmtDateTime, money, round2 } from "@/lib/format";
import { MinutesForm } from "../../CpcForms";
import { AgendaPicker } from "./AgendaPicker";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = await prisma.cpcMeeting.findUnique({ where: { id }, select: { number: true } });
  return { title: m ? `${m.number} — CPC meeting` : "CPC meeting" };
}

export default async function CpcMeetingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.CPC_VIEW);
  if (!authorized) return <AccessDenied title="CPC meeting" />;

  const meeting = await prisma.cpcMeeting.findUnique({
    where: { id },
    include: {
      entity: { select: { id: true, code: true, name: true } },
      cases: {
        orderBy: { amount: "desc" },
        include: {
          pr: { select: { id: true, number: true, title: true, department: { select: { name: true } } } },
          members: { select: { userId: true, required: true } },
          decisions: { select: { memberId: true, vote: true } },
          comparative: {
            select: { lines: { where: { isSelected: true }, select: { vendor: { select: { id: true, name: true } } } } },
          },
        },
      },
    },
  });
  if (!meeting) notFound();

  const [events, unscheduled] = await Promise.all([
    documentTimeline("CpcMeeting", meeting.id),
    prisma.cpcCase.findMany({
      where: {
        status: { in: ["PENDING"] },
        meetingId: null,
        pr: { entityId: meeting.entityId },
      },
      select: { id: true, number: true, title: true, amount: true, pr: { select: { number: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const canManage = userHasPermission(user, P.CPC_MANAGE);
  const decidedCases = meeting.cases.filter((c) =>
    ["APPROVED", "REJECTED", "RETURNED", "CLARIFICATION"].includes(c.status),
  );
  const undecided = meeting.cases.length - decidedCases.length;
  const valueTabled = round2(meeting.cases.reduce((a, c) => a + c.amount, 0));
  const savings = round2(meeting.cases.reduce((a, c) => a + c.savingsAmount, 0));
  const past = meeting.scheduledAt.getTime() < Date.now();

  // Attendance is derived from who actually voted on this agenda.
  const attendance = new Map<string, { voted: number; required: number }>();
  for (const c of meeting.cases) {
    for (const m of c.members) {
      const cur = attendance.get(m.userId) ?? { voted: 0, required: 0 };
      if (m.required) cur.required += 1;
      if (c.decisions.some((d) => d.memberId === m.userId)) cur.voted += 1;
      attendance.set(m.userId, cur);
    }
  }
  const memberIds = [...attendance.keys()];
  const members = memberIds.length
    ? await prisma.user.findMany({
        where: { id: { in: memberIds } },
        select: { id: true, name: true, title: true },
        orderBy: { name: "asc" },
      })
    : [];

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "CPC", href: "/cpc" },
          { label: "Meetings", href: "/cpc/meetings" },
          { label: meeting.number },
        ]}
      />

      <PageHeader
        eyebrow={`${meeting.entity.code} · ${humanize(meeting.meetingType)}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-[var(--c-text-secondary)]">{meeting.number}</span>
            <span>{meeting.title}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={meeting.status} />
            </MetaItem>
            <MetaItem label="Scheduled">{fmtDateTime(meeting.scheduledAt)}</MetaItem>
            <MetaItem label="Location">{meeting.location ?? "—"}</MetaItem>
            <MetaItem label="Cases">{meeting.cases.length}</MetaItem>
            <MetaItem label="Decided">
              {decidedCases.length} of {meeting.cases.length}
            </MetaItem>
            <MetaItem label="Value tabled">{money(valueTabled)}</MetaItem>
          </>
        }
        actions={
          <>
            {canManage && (
              <MinutesForm
                meetingId={meeting.id}
                number={meeting.number}
                existing={meeting.minutes}
                undecided={undecided}
              />
            )}
            <Link href="/cpc/cases" className="btn btn-secondary btn-sm">
              All cases
            </Link>
          </>
        }
      />

      {past && !meeting.minutes && meeting.status !== "CANCELLED" && (
        <InlineAlert tone="warning">
          This sitting has passed with no minutes on file. Minutes are the committee&apos;s own record and an auditor will
          ask for them.
        </InlineAlert>
      )}
      {undecided > 0 && meeting.status === "COMPLETED" && (
        <InlineAlert tone="warning">
          The meeting is closed but {undecided} case{undecided === 1 ? "" : "s"} on this agenda still have no recorded
          outcome. They remain open and block their requisitions from becoming purchase orders.
        </InlineAlert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Cases tabled" value={meeting.cases.length} />
        <StatTile label="Decided" value={decidedCases.length} tone={decidedCases.length ? "success" : "default"} />
        <StatTile label="Still open" value={undecided} tone={undecided ? "warning" : "success"} />
        <StatTile label="Savings endorsed" value={savings > 0 ? money(savings) : "—"} tone={savings > 0 ? "success" : "default"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          <SectionCard
            title="Agenda"
            description="Cases tabled at this sitting. Each one carries its own recorded decision."
            bodyClassName="px-0 py-0"
            actions={
              canManage && unscheduled.length > 0 ? (
                <AgendaPicker
                  meetingId={meeting.id}
                  cases={unscheduled.map((c) => ({
                    id: c.id,
                    number: c.number,
                    title: c.title,
                    amount: c.amount,
                    prNumber: c.pr.number,
                  }))}
                />
              ) : null
            }
          >
            {meeting.cases.length === 0 ? (
              <EmptyState
                title="Nothing on the agenda"
                description="Add pending cases so the committee has something to decide at this sitting."
              />
            ) : (
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Case</th>
                      <th>Requisition</th>
                      <th>Department</th>
                      <th>Recommended vendor</th>
                      <th className="text-right">Value</th>
                      <th>Votes</th>
                      <th>Outcome</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {meeting.cases.map((c) => {
                      const required = c.members.filter((m) => m.required).length;
                      const voted = new Set(c.decisions.map((d) => d.memberId)).size;
                      return (
                        <tr key={c.id}>
                          <td>
                            <RefLink href={`/cpc/cases/${c.id}`}>{c.number}</RefLink>
                          </td>
                          <td>
                            <RefLink href={`/pr/${c.pr.id}`}>{c.pr.number}</RefLink>
                            <span className="mt-0.5 block max-w-[14rem] truncate text-2xs text-[var(--c-text-tertiary)]">
                              {c.pr.title}
                            </span>
                          </td>
                          <td className="text-2xs">{c.pr.department.name}</td>
                          <td className="text-xs">
                            {c.comparative?.lines[0] ? (
                              <RefLink href={`/vendors/${c.comparative.lines[0].vendor.id}`}>
                                {c.comparative.lines[0].vendor.name}
                              </RefLink>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="num text-xs">{money(c.amount)}</td>
                          <td className="text-2xs">
                            <span className={voted >= required && required > 0 ? "text-[var(--c-success)]" : undefined}>
                              {voted} / {required}
                            </span>
                          </td>
                          <td>
                            <StatusBadge status={c.status} />
                          </td>
                          <td>
                            <Link href={`/cpc/cases/${c.id}`} className="btn btn-secondary btn-xs">
                              Open
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard title="Minutes" description="The committee's own record of the sitting.">
            {meeting.minutes ? (
              <p className="whitespace-pre-wrap text-[0.8125rem] leading-6">{meeting.minutes}</p>
            ) : (
              <p className="text-xs text-[var(--c-text-secondary)]">
                No minutes recorded yet.
                {canManage ? " Use the button above to record them." : ""}
              </p>
            )}
          </SectionCard>
        </div>

        <div className="space-y-4">
          <SectionCard title="Meeting detail">
            <DefList
              columns={1}
              items={[
                { label: "Meeting number", value: <Mono>{meeting.number}</Mono> },
                { label: "Entity", value: meeting.entity.name },
                { label: "Type", value: humanize(meeting.meetingType) },
                { label: "Scheduled", value: fmtDateTime(meeting.scheduledAt) },
                { label: "Location", value: meeting.location ?? "—" },
                { label: "Status", value: <StatusBadge status={meeting.status} /> },
                { label: "Created", value: fmtDate(meeting.createdAt) },
                {
                  label: "Agenda notes",
                  value: meeting.agenda ? <span className="whitespace-pre-wrap">{meeting.agenda}</span> : "—",
                },
              ]}
            />
          </SectionCard>

          {members.length > 0 && (
            <SectionCard
              title="Participation"
              description="Derived from votes actually cast on this agenda — not a manual attendance list."
            >
              <ul className="space-y-2">
                {members.map((m) => {
                  const a = attendance.get(m.id)!;
                  return (
                    <li key={m.id} className="flex items-center justify-between gap-3 text-xs">
                      <span className="min-w-0">
                        <span className="block truncate">{m.name}</span>
                        {m.title && (
                          <span className="block truncate text-2xs text-[var(--c-text-tertiary)]">{m.title}</span>
                        )}
                      </span>
                      <Badge tone={a.voted === 0 ? "warning" : a.voted >= a.required ? "success" : "info"}>
                        {a.voted} of {a.required} voted
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            </SectionCard>
          )}

          <SectionCard title="Activity">
            <Timeline events={events} emptyLabel="No activity recorded yet." />
          </SectionCard>
        </div>
      </div>

      <DocumentsPanel
        user={user}
        linkedType="CPC"
        linkedId={meeting.id}
        entityId={meeting.entityId}
        title="Meeting pack"
        description="Signed minutes, attendance sheet and the case packs circulated to members."
        defaultCategory="CPC"
      />
    </div>
  );
}
