import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, PageHeader, RefLink, StatTile, StatusBadge } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, money, round2 } from "@/lib/format";

export const metadata = { title: "CPC cases" };
export const dynamic = "force-dynamic";

export default async function CpcCasesPage() {
  const { user, authorized } = await pageContext(P.CPC_VIEW);
  if (!authorized) return <AccessDenied title="CPC cases" message="You do not have permission to view CPC cases." />;

  const scoped = visibleEntityIds(user);
  const [cases, savedViews] = await Promise.all([
    prisma.cpcCase.findMany({
      where: scoped ? { pr: { entityId: { in: scoped } } } : {},
      orderBy: { createdAt: "desc" },
      take: 500,
      include: {
        pr: {
          select: {
            id: true,
            number: true,
            title: true,
            procurementType: true,
            entity: { select: { code: true } },
            department: { select: { name: true } },
          },
        },
        meeting: { select: { id: true, number: true, scheduledAt: true } },
        members: { select: { userId: true, required: true } },
        decisions: { select: { memberId: true, vote: true } },
        comparative: {
          select: { lines: { where: { isSelected: true }, select: { vendor: { select: { id: true, name: true } } } } },
        },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "cpc-cases", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const open = cases.filter((c) => ["PENDING", "SCHEDULED", "UNDER_REVIEW"].includes(c.status));
  const approved = cases.filter((c) => c.status === "APPROVED");
  const rejected = cases.filter((c) => ["REJECTED", "RETURNED", "CLARIFICATION"].includes(c.status));

  const columns: TableColumn[] = [
    { key: "number", header: "Case", locked: true, sortable: true, width: "10rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "pr", header: "Requisition", sortable: true, width: "11rem" },
    { key: "title", header: "Case", sortable: true, minWidth: "20rem" },
    { key: "department", header: "Department", filterable: true, sortable: true, width: "13rem" },
    { key: "type", header: "Procurement type", filterable: true, sortable: true, width: "12rem" },
    { key: "vendor", header: "Recommended vendor", sortable: true, minWidth: "14rem" },
    { key: "amount", header: "Value", numeric: true, sortable: true, width: "11rem" },
    { key: "savings", header: "Savings", numeric: true, sortable: true, width: "10rem" },
    { key: "votes", header: "Votes", sortable: true, width: "7rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "11rem" },
    { key: "meeting", header: "Meeting", sortable: true, width: "10rem" },
    { key: "raised", header: "Raised", sortable: true, width: "9rem" },
    { key: "decided", header: "Decided", sortable: true, width: "9rem" },
    { key: "turnaround", header: "Turnaround (days)", numeric: true, sortable: true, width: "10rem" },
  ];

  const rows: TableRow[] = cases.map((c) => {
    const required = c.members.filter((m) => m.required).length;
    const voted = new Set(c.decisions.map((d) => d.memberId)).size;
    const isOpen = ["PENDING", "SCHEDULED", "UNDER_REVIEW"].includes(c.status);
    const age = ageDays(c.createdAt) ?? 0;
    const turnaround =
      c.decidedAt !== null ? round2((c.decidedAt.getTime() - c.createdAt.getTime()) / 86400000) : 0;
    const vendor = c.comparative?.lines[0]?.vendor;
    return {
      id: c.id,
      href: `/cpc/cases/${c.id}`,
      flag:
        c.status === "REJECTED"
          ? "danger"
          : isOpen && age > 7
            ? "warning"
            : c.status === "APPROVED"
              ? "success"
              : null,
      search: `${c.number} ${c.pr.number} ${c.title} ${vendor?.name ?? ""}`,
      values: {
        number: c.number,
        entity: c.pr.entity.code,
        pr: c.pr.number,
        title: c.title,
        department: c.pr.department.name,
        type: humanize(c.pr.procurementType),
        vendor: vendor?.name ?? "",
        amount: c.amount,
        savings: c.savingsAmount,
        votes: `${voted}/${required}`,
        status: humanize(c.status),
        meeting: c.meeting?.number ?? "",
        raised: c.createdAt.toISOString(),
        decided: c.decidedAt ? c.decidedAt.toISOString() : "",
        turnaround: turnaround || (isOpen ? age : 0),
      },
      cells: {
        number: <RefLink href={`/cpc/cases/${c.id}`}>{c.number}</RefLink>,
        entity: <Badge tone="neutral">{c.pr.entity.code}</Badge>,
        pr: <RefLink href={`/pr/${c.pr.id}`}>{c.pr.number}</RefLink>,
        title: (
          <span className="block max-w-[28rem] truncate" title={c.title}>
            {c.title}
          </span>
        ),
        department: c.pr.department.name,
        type: humanize(c.pr.procurementType),
        vendor: vendor ? <RefLink href={`/vendors/${vendor.id}`}>{vendor.name}</RefLink> : "—",
        amount: money(c.amount),
        savings: c.savingsAmount > 0 ? money(c.savingsAmount) : "—",
        votes: (
          <span className={voted >= required && required > 0 ? "text-[var(--c-success)]" : undefined}>
            {voted} / {required}
          </span>
        ),
        status: <StatusBadge status={c.status} />,
        meeting: c.meeting ? <RefLink href={`/cpc/meetings/${c.meeting.id}`}>{c.meeting.number}</RefLink> : "—",
        raised: fmtDate(c.createdAt),
        decided: c.decidedAt ? fmtDate(c.decidedAt) : "—",
        turnaround: c.decidedAt ? turnaround : isOpen ? `${age} (open)` : "—",
      },
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "CPC", href: "/cpc" }, { label: "Cases" }]} />

      <PageHeader
        eyebrow="Governance"
        title="CPC cases"
        subtitle="Every case the committee has ever seen, with the votes cast and the turnaround achieved."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Cases raised" value={cases.length} />
        <StatTile label="Open" value={open.length} tone={open.length ? "warning" : "success"} />
        <StatTile label="Approved" value={approved.length} tone="success" />
        <StatTile label="Rejected or returned" value={rejected.length} tone={rejected.length ? "danger" : "default"} />
      </div>

      <DataTable
        id="cpc-cases"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "raised", dir: "desc" }}
        exportName="cpc-cases"
        emptyState={
          <EmptyState
            title="No CPC cases"
            description="A case is created automatically when a recommended comparative exceeds the configured threshold for its entity."
          />
        }
      />
    </div>
  );
}
