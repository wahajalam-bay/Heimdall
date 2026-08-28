import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { prVisibilityFilter } from "@/server/pr";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type BulkAction, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import {
  Badge,
  EmptyState,
  InlineAlert,
  PageHeader,
  RefLink,
  StatTile,
  StatusBadge,
  UserChip,
} from "@/components/ui/primitives";
import { PROCUREMENT_TYPE_LABELS, PRIORITY_TONE, PR_STATUSES, humanize, type ProcurementType } from "@/lib/domain";
import { ageDays, fmtDate, money, qty, relativeTime } from "@/lib/format";
import { statusLink, tableLink } from "@/lib/links";

export const metadata = { title: "Purchase Requisitions" };
export const dynamic = "force-dynamic";

export default async function PrListPage() {
  const { user, ctx, authorized } = await pageContext(P.PR_VIEW, P.PR_VIEW_ALL);
  if (!authorized) {
    return <AccessDenied title="Purchase Requisitions" message="You do not have permission to view requisitions." />;
  }

  const canCreate = userHasPermission(user, P.PR_CREATE);
  // Only the people who would act on it are told about the handover queue.
  const canSeeSourcing = userHasPermission(user, P.RFQ_ISSUE, P.PO_CREATE);
  const seesAll = userHasPermission(user, P.PR_VIEW_ALL);

  const [prs, savedViews] = await Promise.all([
    prisma.purchaseRequisition.findMany({
      where: { ...ctx.entityFilter, ...prVisibilityFilter(user) },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: {
        entity: { select: { code: true } },
        department: { select: { name: true } },
        requester: { select: { name: true, title: true } },
        project: { select: { code: true, name: true } },
        site: { select: { name: true } },
        deliveryStore: { select: { name: true } },
        items: { select: { id: true, quantity: true, unit: true } },
        purchaseOrders: { select: { id: true, number: true, status: true } },
        rfqs: { select: { id: true, number: true, status: true, quotes: { select: { id: true } } } },
        cpcCases: { select: { id: true, number: true, status: true } },
        exceptions: { where: { status: { in: ["OPEN", "IN_PROGRESS"] } }, select: { id: true, severity: true } },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "prs", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  // Approved and waiting for the purchase order module to pick it up. This is the
  // handover queue: the requisition has done its job and nobody has started
  // sourcing, which is the gap where a case sits for a fortnight unnoticed.
  const awaitingSourcing = prs.filter(
    (p) => ["APPROVED", "PROCUREMENT_REVIEW"].includes(p.status) && !p.rfqs.length && !p.purchaseOrders.length,
  );
  const awaitingSourcingIds = new Set(awaitingSourcing.map((p) => p.id));

  // Each tile is a claim about a set of rows in the table below it, so the set is
  // named once and both the count and the tile's link are read from it. Spelling
  // the statuses out twice is how a figure and the filter it links to drift.
  const AWAITING_APPROVAL = ["SUBMITTED", "UNDER_DEPARTMENT_APPROVAL"];
  const IN_SOURCING = ["PROCUREMENT_REVIEW", "SOURCING", "CPC_REVIEW", "PO_PREPARATION"];
  const openStatuses = ["SUBMITTED", "UNDER_DEPARTMENT_APPROVAL", "APPROVED", ...IN_SOURCING];
  const LIVE = PR_STATUSES.filter((st) => st !== "REJECTED" && st !== "CANCELLED");

  const stats = {
    total: prs.length,
    drafts: prs.filter((p) => p.status === "DRAFT").length,
    awaitingApproval: prs.filter((p) => AWAITING_APPROVAL.includes(p.status)).length,
    inSourcing: prs.filter((p) => IN_SOURCING.includes(p.status)).length,
    open: prs.filter((p) => openStatuses.includes(p.status)).length,
    value: prs.filter((p) => LIVE.includes(p.status as (typeof LIVE)[number])).reduce((a, p) => a + p.estimatedValue, 0),
    returned: prs.filter((p) => p.status === "RETURNED").length,
    exceptions: prs.reduce((a, p) => a + p.exceptions.length, 0),
  };

  // Chasing an approval changes nothing; it only surfaces the queue to whoever
  // is holding it, and records that the nudge was sent.
  const bulkActions: BulkAction[] | undefined = userHasPermission(user, P.PR_VIEW_ALL, P.PR_APPROVE)
    ? [
        {
          id: "remind",
          label: "Remind approvers",
          endpoint: "/api/bulk/pr",
          tone: "default",
          confirm:
            "Send an approval reminder for {n} requisition(s)? Nothing is approved — the current step owner is simply notified.",
          promptLabel: "Note to include with the reminder (optional)",
        },
      ]
    : undefined;

  const columns: TableColumn[] = [
    { key: "number", header: "Reference", locked: true, sortable: true, width: "9.5rem" },
    { key: "title", header: "Title", minWidth: "18rem", sortable: true },
    { key: "entity", header: "Entity", filterable: true, width: "5rem", sortable: true },
    { key: "department", header: "Department", filterable: true, sortable: true, width: "11rem" },
    { key: "type", header: "Type", filterable: true, sortable: true, width: "11rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "12rem" },
    { key: "priority", header: "Priority", filterable: true, sortable: true, width: "6.5rem" },
    { key: "value", header: "Est. value", numeric: true, sortable: true, width: "9.5rem" },
    { key: "requester", header: "Requester", sortable: true, width: "12rem", defaultHidden: true },
    { key: "project", header: "Project", filterable: true, sortable: true, width: "12rem", defaultHidden: true },
    { key: "site", header: "Site", sortable: true, width: "11rem", defaultHidden: true },
    { key: "store", header: "Receiving store", sortable: true, width: "13rem", defaultHidden: true },
    { key: "lines", header: "Lines", numeric: true, sortable: true, width: "4.5rem", defaultHidden: true },
    { key: "required", header: "Required", sortable: true, width: "9.5rem" },
    { key: "age", header: "Age", numeric: true, sortable: true, width: "5.5rem" },
    { key: "progress", header: "Downstream", sortable: false, minWidth: "12rem" },
    { key: "flags", header: "Flags", sortable: false, width: "9rem" },
    // Not a status: approved with nothing started downstream. The tile counting
    // it needs a control it can point at, and a reader needs one to find it.
    { key: "handover", header: "Handover", filterable: true, sortable: true, width: "10rem", defaultHidden: true },
  ];

  const rows: TableRow[] = prs.map((pr) => {
    const age = ageDays(pr.createdAt) ?? 0;
    const overdueRequired = pr.requiredDate < new Date() && openStatuses.includes(pr.status);
    const rfq = pr.rfqs[0];
    const po = pr.purchaseOrders[0];
    const cpc = pr.cpcCases[0];
    return {
      id: pr.id,
      href: `/pr/${pr.id}`,
      flag: pr.exceptions.some((e) => e.severity === "CRITICAL" || e.severity === "HIGH")
        ? "danger"
        : pr.status === "RETURNED"
          ? "warning"
          : overdueRequired
            ? "warning"
            : null,
      search: `${pr.number} ${pr.title} ${pr.requester.name} ${pr.project?.name ?? ""} ${pr.boqReference ?? ""}`,
      values: {
        number: pr.number,
        title: pr.title,
        entity: pr.entity.code,
        department: pr.department.name,
        type: PROCUREMENT_TYPE_LABELS[pr.procurementType as ProcurementType] ?? pr.procurementType,
        status: humanize(pr.status),
        priority: humanize(pr.priority),
        value: pr.estimatedValue,
        requester: pr.requester.name,
        project: pr.project?.name ?? "",
        site: pr.site?.name ?? "",
        store: pr.deliveryStore?.name ?? "",
        lines: pr.items.length,
        required: pr.requiredDate.toISOString().slice(0, 10),
        age,
        progress: [rfq?.number, cpc?.number, po?.number].filter(Boolean).join(" "),
        flags: pr.exceptions.length,
        handover: awaitingSourcingIds.has(pr.id) ? "Awaiting sourcing" : "Started",
      },
      cells: {
        handover: awaitingSourcingIds.has(pr.id) ? (
          <Badge tone="warning">Awaiting sourcing</Badge>
        ) : (
          <span className="text-[var(--c-text-tertiary)]">Started</span>
        ),
        number: <RefLink href={`/pr/${pr.id}`}>{pr.number}</RefLink>,
        title: (
          <span className="block max-w-[26rem] truncate" title={pr.title}>
            {pr.title}
          </span>
        ),
        entity: <Badge tone="neutral">{pr.entity.code}</Badge>,
        department: pr.department.name,
        type: (
          <span className="text-xs">
            {PROCUREMENT_TYPE_LABELS[pr.procurementType as ProcurementType] ?? humanize(pr.procurementType)}
          </span>
        ),
        status: <StatusBadge status={pr.status} />,
        priority: <Badge tone={PRIORITY_TONE[pr.priority] ?? "neutral"}>{humanize(pr.priority)}</Badge>,
        value: money(pr.estimatedValue),
        requester: <UserChip name={pr.requester.name} sub={pr.requester.title} />,
        project: pr.project ? `${pr.project.code} — ${pr.project.name}` : "—",
        site: pr.site?.name ?? "—",
        store: pr.deliveryStore?.name ?? "—",
        lines: qty(pr.items.length),
        required: (
          <span className={overdueRequired ? "text-[var(--c-danger)]" : undefined}>{fmtDate(pr.requiredDate)}</span>
        ),
        age: <span className="tnum">{age}d</span>,
        progress: (
          <span className="flex flex-wrap items-center gap-1">
            {rfq && (
              <Link href={`/rfq/${rfq.id}`} className="badge badge-info" title={`${rfq.quotes.length} quotation(s)`}>
                {rfq.number.split("-").slice(-1)} RFQ
              </Link>
            )}
            {cpc && (
              <Link href={`/cpc/cases/${cpc.id}`} className={`badge badge-${cpc.status === "APPROVED" ? "success" : "progress"}`}>
                CPC
              </Link>
            )}
            {po && (
              <Link href={`/po/${po.id}`} className="badge badge-accent">
                {po.number}
              </Link>
            )}
            {!rfq && !po && !cpc && <span className="text-2xs text-[var(--c-text-tertiary)]">—</span>}
          </span>
        ),
        flags: pr.exceptions.length ? (
          <Link href={`/analytics/exceptions?ref=${pr.number}`} className="badge badge-danger">
            {pr.exceptions.length} exception{pr.exceptions.length > 1 ? "s" : ""}
          </Link>
        ) : (
          <span className="text-2xs text-[var(--c-text-tertiary)]">Clear</span>
        ),
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Procurement"
        title="Purchase Requisitions"
        subtitle={
          seesAll
            ? "Every requisition across the entities you can access, with its downstream sourcing, committee and purchase-order state."
            : "Requisitions you raised or that belong to your department."
        }
        actions={
          canCreate && (
            <Link href="/pr/new" className="btn btn-primary">
              New requisition
            </Link>
          )
        }
      />

      {awaitingSourcing.length > 0 && canSeeSourcing && (
        <InlineAlert tone="warning">
          {awaitingSourcing.length} approved requisition{awaitingSourcing.length === 1 ? "" : "s"} with no sourcing
          started. The requisition module is finished on{" "}
          {awaitingSourcing.slice(0, 5).map((p, i) => (
            <span key={p.id}>
              {i > 0 && ", "}
              <Link href={`/pr/${p.id}?tab=rfq`} className="mono text-[var(--c-accent-text)]">
                {p.number}
              </Link>
            </span>
          ))}
          {awaitingSourcing.length > 5 && ` and ${awaitingSourcing.length - 5} more`} — the purchase order module begins
          with the RFQ.
        </InlineAlert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Open requisitions"
          value={stats.open}
          hint={`${stats.total} total on record`}
          tone="accent"
          href={statusLink("/pr", "status", openStatuses)}
        />
        <StatTile
          label="Awaiting approval"
          value={stats.awaitingApproval}
          hint="With a department head or procurement"
          tone={stats.awaitingApproval > 0 ? "warning" : "default"}
          href={statusLink("/pr", "status", AWAITING_APPROVAL)}
        />
        <StatTile
          label="Awaiting sourcing"
          value={awaitingSourcing.length}
          hint="Approved; the order module has not started"
          tone={awaitingSourcing.length > 0 ? "warning" : "default"}
          href={tableLink("/pr", { handover: "Awaiting sourcing" })}
        />
        <StatTile
          label="In sourcing"
          value={stats.inSourcing}
          hint="RFQ, comparative, committee or PO stage"
          href={statusLink("/pr", "status", IN_SOURCING)}
        />
        <StatTile
          label="Returned"
          value={stats.returned}
          hint="Sent back to the requester"
          tone={stats.returned > 0 ? "warning" : "default"}
          href={statusLink("/pr", "status", ["RETURNED"])}
        />
        <StatTile
          label="Live value"
          value={money(stats.value, "PKR", { compact: true })}
          hint="Excluding rejected and cancelled"
          href={statusLink("/pr", "status", LIVE)}
        />
      </div>

      <DataTable
        id="prs"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        bulkActions={bulkActions}
        defaultSort={{ key: "number", dir: "desc" }}
        exportName="purchase-requisitions"
        emptyState={
          <EmptyState
            title="No requisitions yet"
            description={
              canCreate
                ? "Raise the first requisition to start a procurement case. It will flow through approval, sourcing, purchase order, receiving and invoicing."
                : "Requisitions raised by you or your department will appear here."
            }
            action={
              canCreate && (
                <Link href="/pr/new" className="btn btn-primary btn-sm">
                  New requisition
                </Link>
              )
            }
          />
        }
        toolbarExtra={
          <span className="hidden text-2xs text-[var(--c-text-tertiary)] xl:inline">
            Updated {relativeTime(prs[0]?.updatedAt ?? new Date())}
          </span>
        }
      />
    </div>
  );
}
