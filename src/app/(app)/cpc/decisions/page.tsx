import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { visibleEntityIds } from "@/lib/rbac";
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
import { RankedBars } from "@/components/ui/charts";
import { humanize } from "@/lib/domain";
import { fmtDateTime, money, percent, round2 } from "@/lib/format";

export const metadata = { title: "CPC decisions" };
export const dynamic = "force-dynamic";

const VOTE_TONE: Record<string, "success" | "danger" | "warning" | "neutral"> = {
  APPROVE: "success",
  REJECT: "danger",
  RETURN: "warning",
  REQUEST_CLARIFICATION: "warning",
  ABSTAIN: "neutral",
};

/** The individual voting record — who decided what, and when. */
export default async function CpcDecisionsPage() {
  const { user, authorized } = await pageContext(P.CPC_VIEW);
  if (!authorized) return <AccessDenied title="CPC decisions" message="You do not have permission to view CPC decisions." />;

  const scoped = visibleEntityIds(user);
  const [decisions, savedViews] = await Promise.all([
    prisma.cpcDecision.findMany({
      where: scoped ? { case: { pr: { entityId: { in: scoped } } } } : {},
      orderBy: { decidedAt: "desc" },
      take: 600,
      include: {
        member: { select: { id: true, name: true, title: true } },
        case: {
          select: {
            id: true,
            number: true,
            title: true,
            amount: true,
            status: true,
            savingsAmount: true,
            createdAt: true,
            decidedAt: true,
            pr: { select: { id: true, number: true, entity: { select: { code: true } }, department: { select: { name: true } } } },
            members: { select: { userId: true, roleLabel: true } },
          },
        },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "cpc-decisions", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const approvals = decisions.filter((d) => d.vote === "APPROVE").length;
  const dissents = decisions.filter((d) => ["REJECT", "RETURN", "REQUEST_CLARIFICATION"].includes(d.vote)).length;
  const abstentions = decisions.filter((d) => d.vote === "ABSTAIN").length;

  const byMember = new Map<string, { name: string; count: number; id: string }>();
  for (const d of decisions) {
    const cur = byMember.get(d.memberId) ?? { name: d.member.name, count: 0, id: d.memberId };
    cur.count += 1;
    byMember.set(d.memberId, cur);
  }

  const columns: TableColumn[] = [
    { key: "case", header: "Case", locked: true, sortable: true, width: "10rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "member", header: "Member", sortable: true, minWidth: "14rem" },
    { key: "role", header: "Committee role", filterable: true, sortable: true, width: "16rem" },
    { key: "vote", header: "Vote", filterable: true, sortable: true, width: "11rem" },
    { key: "final", header: "Chair final", filterable: true, sortable: true, width: "8.5rem" },
    { key: "comment", header: "Comment", sortable: true, minWidth: "22rem" },
    { key: "caseTitle", header: "Case title", sortable: true, minWidth: "18rem", defaultHidden: true },
    { key: "department", header: "Department", filterable: true, sortable: true, width: "13rem", defaultHidden: true },
    { key: "amount", header: "Case value", numeric: true, sortable: true, width: "11rem" },
    { key: "outcome", header: "Case outcome", filterable: true, sortable: true, width: "11rem" },
    { key: "decided", header: "Voted at", sortable: true, width: "13rem" },
  ];

  const rows: TableRow[] = decisions.map((d) => {
    const role = d.case.members.find((m) => m.userId === d.memberId)?.roleLabel ?? "—";
    return {
      id: d.id,
      href: `/cpc/cases/${d.case.id}`,
      flag: d.vote === "REJECT" ? "danger" : ["RETURN", "REQUEST_CLARIFICATION"].includes(d.vote) ? "warning" : null,
      search: `${d.case.number} ${d.member.name} ${d.comment ?? ""} ${d.case.title}`,
      values: {
        case: d.case.number,
        entity: d.case.pr.entity.code,
        member: d.member.name,
        role,
        vote: humanize(d.vote),
        final: d.isFinal ? "Yes" : "No",
        comment: d.comment ?? "",
        caseTitle: d.case.title,
        department: d.case.pr.department.name,
        amount: d.case.amount,
        outcome: humanize(d.case.status),
        decided: d.decidedAt.toISOString(),
      },
      cells: {
        case: <RefLink href={`/cpc/cases/${d.case.id}`}>{d.case.number}</RefLink>,
        entity: <Badge tone="neutral">{d.case.pr.entity.code}</Badge>,
        member: (
          <span>
            <span className="block text-xs font-500">{d.member.name}</span>
            {d.member.title && (
              <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{d.member.title}</span>
            )}
          </span>
        ),
        role,
        vote: <Badge tone={VOTE_TONE[d.vote] ?? "neutral"}>{humanize(d.vote)}</Badge>,
        final: d.isFinal ? <Badge tone="info">Chair</Badge> : "—",
        comment: (
          <span className="block max-w-[28rem] truncate" title={d.comment ?? ""}>
            {d.comment ?? "—"}
          </span>
        ),
        caseTitle: (
          <span className="block max-w-[22rem] truncate" title={d.case.title}>
            {d.case.title}
          </span>
        ),
        department: d.case.pr.department.name,
        amount: money(d.case.amount),
        outcome: <StatusBadge status={d.case.status} />,
        decided: fmtDateTime(d.decidedAt),
      },
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "CPC", href: "/cpc" }, { label: "Decisions" }]} />

      <PageHeader
        eyebrow="Governance"
        title="Decision register"
        subtitle="Every individual vote ever cast, attributed by name and role. This is the accountability record — it is never edited, only added to."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Votes cast" value={decisions.length} />
        <StatTile
          label="Approvals"
          value={approvals}
          hint={decisions.length ? percent(round2((approvals / decisions.length) * 100), 0) : undefined}
          tone="success"
        />
        <StatTile label="Dissents" value={dissents} tone={dissents ? "warning" : "default"} hint="Reject, return or clarification" />
        <StatTile label="Abstentions" value={abstentions} />
      </div>

      {byMember.size > 0 && (
        <SectionCard
          title="Participation by member"
          description="Votes cast. A member who never votes is as much a bottleneck as one who always rejects."
        >
          <RankedBars
            data={[...byMember.values()]
              .map((m) => ({ label: m.name, value: m.count }))
              .sort((a, b) => b.value - a.value)}
            format="number"
            maxRows={10}
          />
        </SectionCard>
      )}

      <DataTable
        id="cpc-decisions"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "decided", dir: "desc" }}
        exportName="cpc-decisions"
        emptyState={
          <EmptyState
            title="No decisions recorded"
            description="Votes appear here as committee members decide the cases assigned to them."
          />
        }
      />
    </div>
  );
}
