import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, PageHeader, RefLink, StatTile, StatusBadge, Meter } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, money, relativeTime } from "@/lib/format";
import { statusLink, tableLink } from "@/lib/links";

export const metadata = { title: "RFQs" };
export const dynamic = "force-dynamic";

export default async function RfqListPage() {
  const { user, ctx, authorized } = await pageContext(P.RFQ_VIEW);
  if (!authorized) {
    return <AccessDenied title="Requests for Quotation" message="You do not have permission to view RFQs." />;
  }

  const [rfqs, minQuotes, savedViews] = await Promise.all([
    prisma.rfq.findMany({
      where: { pr: ctx.entityFilter },
      orderBy: { createdAt: "desc" },
      take: 400,
      include: {
        pr: {
          select: {
            id: true,
            number: true,
            title: true,
            estimatedValue: true,
            status: true,
            entity: { select: { code: true } },
            department: { select: { name: true } },
          },
        },
        createdBy: { select: { name: true } },
        vendors: { select: { id: true, status: true } },
        quotes: { select: { id: true, total: true, technicalCompliance: true } },
        comparatives: { select: { id: true, number: true, status: true } },
      },
    }),
    getConfigNumber(CONFIG_KEYS.MIN_QUOTATIONS, ctx.entityId),
    prisma.savedView.findMany({
      where: { resource: "rfqs", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const now = new Date();
  const stats = {
    open: rfqs.filter((r) => ["DRAFT", "ISSUED", "RESPONSES_IN"].includes(r.status)).length,
    awaitingResponses: rfqs.filter(
      (r) => ["ISSUED", "RESPONSES_IN"].includes(r.status) && r.vendors.some((v) => v.status === "INVITED"),
    ).length,
    overdueDeadline: rfqs.filter(
      (r) => ["ISSUED", "RESPONSES_IN"].includes(r.status) && r.responseDeadline < now,
    ).length,
    belowMinimum: rfqs.filter(
      (r) => ["RESPONSES_IN", "CLOSED"].includes(r.status) && r.quotes.length < minQuotes,
    ).length,
    needComparative: rfqs.filter((r) => r.quotes.length > 0 && r.comparatives.length === 0).length,
  };

  const columns: TableColumn[] = [
    { key: "number", header: "RFQ", locked: true, sortable: true, width: "9.5rem" },
    { key: "title", header: "Title", minWidth: "18rem", sortable: true },
    { key: "pr", header: "Requisition", sortable: true, width: "9.5rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "department", header: "Department", filterable: true, sortable: true, width: "11rem", defaultHidden: true },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "9rem" },
    { key: "invited", header: "Invited", numeric: true, sortable: true, width: "5.5rem" },
    { key: "quoted", header: "Quoted", numeric: true, sortable: true, width: "5.5rem" },
    { key: "coverage", header: "Coverage", sortable: false, width: "8rem" },
    { key: "lowest", header: "Lowest quote", numeric: true, sortable: true, width: "10rem" },
    { key: "compliant", header: "Compliant", numeric: true, sortable: true, width: "6.5rem", defaultHidden: true },
    { key: "deadline", header: "Deadline", sortable: true, width: "8.5rem" },
    { key: "comparative", header: "Comparative", sortable: true, width: "10rem" },
    { key: "raisedBy", header: "Raised by", sortable: true, width: "11rem", defaultHidden: true },
    { key: "age", header: "Age", numeric: true, sortable: true, width: "5rem" },
    // Three states no status can express: whether vendors still owe a response,
    // whether the deadline has passed, and whether the policy minimum was met.
    // Each tile above points at one of these, and each is a control in its own
    // right for somebody working the queue.
    { key: "responses", header: "Responses", filterable: true, sortable: true, width: "10rem", defaultHidden: true },
    { key: "timing", header: "Timing", filterable: true, sortable: true, width: "9rem", defaultHidden: true },
    { key: "quorum", header: "Quorum", filterable: true, sortable: true, width: "10rem", defaultHidden: true },
    { key: "comparativeState", header: "Comparative state", filterable: true, sortable: true, width: "11rem", defaultHidden: true },
  ];

  const rows: TableRow[] = rfqs.map((r) => {
    const quoted = r.quotes.length;
    const lowest = quoted ? Math.min(...r.quotes.map((q) => q.total)) : null;
    const compliant = r.quotes.filter((q) => q.technicalCompliance === "COMPLIANT").length;
    const overdue = ["ISSUED", "RESPONSES_IN"].includes(r.status) && r.responseDeadline < now;
    const short = ["RESPONSES_IN", "CLOSED"].includes(r.status) && quoted < minQuotes;
    const comparative = r.comparatives[0];
    const awaitingResponses =
      ["ISSUED", "RESPONSES_IN"].includes(r.status) && r.vendors.some((v) => v.status === "INVITED");
    const needComparative = quoted > 0 && r.comparatives.length === 0;
    return {
      id: r.id,
      href: `/rfq/${r.id}`,
      flag: overdue ? "warning" : short ? "danger" : null,
      search: `${r.number} ${r.title} ${r.pr.number} ${r.pr.title}`,
      values: {
        number: r.number,
        title: r.title,
        pr: r.pr.number,
        entity: r.pr.entity.code,
        department: r.pr.department.name,
        status: humanize(r.status),
        invited: r.vendors.length,
        quoted,
        coverage: quoted,
        lowest: lowest ?? 0,
        compliant,
        deadline: r.responseDeadline.toISOString().slice(0, 10),
        comparative: comparative?.number ?? "",
        raisedBy: r.createdBy.name,
        age: ageDays(r.createdAt) ?? 0,
        responses: awaitingResponses ? "Awaiting vendors" : "All in",
        timing: overdue ? "Past deadline" : "Within deadline",
        quorum: short ? "Below minimum" : "Minimum met",
        comparativeState: needComparative ? "Pending" : comparative ? "Prepared" : "Not applicable",
      },
      cells: {
        responses: awaitingResponses ? (
          <Badge tone="warning">Awaiting vendors</Badge>
        ) : (
          <span className="text-[var(--c-text-tertiary)]">All in</span>
        ),
        timing: overdue ? (
          <Badge tone="danger">Past deadline</Badge>
        ) : (
          <span className="text-[var(--c-text-tertiary)]">Within deadline</span>
        ),
        quorum: short ? (
          <Badge tone="danger">Below minimum</Badge>
        ) : (
          <span className="text-[var(--c-text-tertiary)]">Minimum met</span>
        ),
        comparativeState: needComparative ? (
          <Badge tone="warning">Pending</Badge>
        ) : (
          <span className="text-[var(--c-text-tertiary)]">{comparative ? "Prepared" : "Not applicable"}</span>
        ),
        number: <RefLink href={`/rfq/${r.id}`}>{r.number}</RefLink>,
        title: (
          <span className="block max-w-[24rem] truncate" title={r.title}>
            {r.title}
          </span>
        ),
        pr: <RefLink href={`/pr/${r.pr.id}`}>{r.pr.number}</RefLink>,
        entity: <Badge tone="neutral">{r.pr.entity.code}</Badge>,
        department: r.pr.department.name,
        status: <StatusBadge status={r.status} />,
        invited: r.vendors.length,
        quoted: (
          <span className={short ? "font-500 text-[var(--c-danger)]" : undefined}>
            {quoted}
            {short && <span className="ml-1 text-2xs">/ {minQuotes}</span>}
          </span>
        ),
        coverage: <Meter value={quoted} max={Math.max(minQuotes, r.vendors.length)} tone={short ? "danger" : "success"} />,
        lowest: lowest !== null ? money(lowest) : "—",
        compliant: compliant,
        deadline: (
          <span className={overdue ? "text-[var(--c-danger)]" : undefined}>{fmtDate(r.responseDeadline)}</span>
        ),
        comparative: comparative ? (
          <Link href={`/comparatives/${comparative.id}`} className="badge badge-accent">
            {comparative.number}
          </Link>
        ) : quoted > 0 ? (
          <Badge tone="warning">Pending</Badge>
        ) : (
          <span className="text-2xs text-[var(--c-text-tertiary)]">—</span>
        ),
        raisedBy: r.createdBy.name,
        age: <span className="tnum">{ageDays(r.createdAt) ?? 0}d</span>,
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Procurement"
        title="Requests for Quotation"
        subtitle={`Sourcing events and vendor coverage. Procurement policy requires ${minQuotes} quotations above the waiver value.`}
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="Open RFQs"
          value={stats.open}
          tone="accent"
          href={statusLink("/rfq", "status", ["DRAFT", "ISSUED", "RESPONSES_IN"])}
        />
        <StatTile
          label="Awaiting vendor response"
          value={stats.awaitingResponses}
          tone={stats.awaitingResponses ? "warning" : "default"}
          href={tableLink("/rfq", { responses: "Awaiting vendors" })}
        />
        <StatTile
          label="Past deadline"
          value={stats.overdueDeadline}
          tone={stats.overdueDeadline ? "danger" : "default"}
          href={tableLink("/rfq", { timing: "Past deadline" })}
        />
        <StatTile
          label={`Below ${minQuotes} quotations`}
          value={stats.belowMinimum}
          hint="Policy minimum not met"
          tone={stats.belowMinimum ? "danger" : "default"}
          href={tableLink("/rfq", { quorum: "Below minimum" })}
        />
        <StatTile
          label="Comparative pending"
          value={stats.needComparative}
          hint="Quotes in, no comparative yet"
          tone={stats.needComparative ? "warning" : "default"}
          href={tableLink("/rfq", { comparativeState: "Pending" })}
        />
      </div>

      <DataTable
        id="rfqs"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "number", dir: "desc" }}
        exportName="rfqs"
        emptyState={
          <EmptyState
            title="No RFQs yet"
            description="An RFQ is raised from an approved requisition once it enters sourcing. Open a requisition and choose “Raise RFQ”."
            action={
              <Link href="/pr" className="btn btn-secondary btn-sm">
                Browse requisitions
              </Link>
            }
          />
        }
        toolbarExtra={
          <span className="hidden text-2xs text-[var(--c-text-tertiary)] xl:inline">
            Updated {relativeTime(rfqs[0]?.updatedAt ?? new Date())}
          </span>
        }
      />
    </div>
  );
}
