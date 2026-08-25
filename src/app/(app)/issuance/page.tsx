import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import {
  Badge,
  EmptyState,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { RankedBars } from "@/components/ui/charts";
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, qty, round2 } from "@/lib/format";

const AWAITING = [
  "PENDING_APPROVAL",
  "PENDING_DEPARTMENT_APPROVAL",
  "PENDING_HOD_APPROVAL",
  "PENDING_CROSS_STORE_APPROVAL",
];

export const metadata = { title: "Stock Issuance" };
export const dynamic = "force-dynamic";

export default async function IssuancePage() {
  const { user, ctx, authorized } = await pageContext(P.INVENTORY_VIEW, P.STORE_ISSUE);
  if (!authorized) {
    return (
      <AccessDenied
        title="Store requisitions"
        message="You do not have permission to view store requisitions."
      />
    );
  }

  const [issues, savedViews] = await Promise.all([
    prisma.storeIssue.findMany({
      where: { store: ctx.entityFilter },
      orderBy: { requestedAt: "desc" },
      take: 400,
      include: {
        store: { select: { id: true, name: true, kind: true, entity: { select: { code: true } } } },
        requestedBy: { select: { name: true } },
        items: { select: { requestedQty: true, approvedQty: true, issuedQty: true, unit: true, item: { select: { name: true } } } },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "issuance", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const departmentIds = [...new Set(issues.map((i) => i.departmentId).filter((x): x is string => !!x))];
  const projectIds = [...new Set(issues.map((i) => i.projectId).filter((x): x is string => !!x))];
  const [departments, projects] = await Promise.all([
    departmentIds.length
      ? prisma.department.findMany({ where: { id: { in: departmentIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    projectIds.length
      ? prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, code: true } })
      : Promise.resolve([]),
  ]);
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const projCode = new Map(projects.map((p) => [p.id, p.code]));

  const canApprove = userHasPermission(user, P.STORE_ISSUE_APPROVE);
  const canIssue = userHasPermission(user, P.STORE_ISSUE);

  const stats = {
    open: issues.filter((i) => ["DRAFT", "RETURNED", "APPROVED", "PARTIALLY_ISSUED", ...AWAITING].includes(i.status))
      .length,
    awaitingApproval: issues.filter((i) => AWAITING.includes(i.status)).length,
    awaitingRelease: issues.filter((i) => ["APPROVED", "PARTIALLY_ISSUED"].includes(i.status)).length,
    issuedThisMonth: issues.filter((i) => i.issuedAt && (ageDays(i.issuedAt) ?? 999) <= 30).length,
  };

  // Where issued stock is going — consumption by cost centre, not by store.
  const byConsumer = new Map<string, number>();
  for (const i of issues) {
    if (!["ISSUED", "PARTIALLY_ISSUED"].includes(i.status)) continue;
    const label = i.projectId
      ? `${projCode.get(i.projectId) ?? "Project"}`
      : (deptName.get(i.departmentId ?? "") ?? "Unassigned");
    const lines = i.items.reduce((a, li) => a + li.issuedQty, 0);
    byConsumer.set(label, round2((byConsumer.get(label) ?? 0) + lines));
  }
  const consumerRows = [...byConsumer.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  const columns: TableColumn[] = [
    { key: "number", header: "Issue", locked: true, sortable: true, width: "9.5rem" },
    { key: "store", header: "Store", filterable: true, sortable: true, width: "14rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "recipient", header: "Issued to", sortable: true, minWidth: "12rem" },
    { key: "consumer", header: "Charged to", filterable: true, sortable: true, width: "12rem" },
    { key: "purpose", header: "Purpose", sortable: true, minWidth: "16rem" },
    { key: "lines", header: "Lines", numeric: true, sortable: true, width: "5.5rem" },
    { key: "requestedQty", header: "Requested", numeric: true, sortable: true, width: "8.5rem" },
    { key: "issuedQty", header: "Issued", numeric: true, sortable: true, width: "8.5rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "11rem" },
    { key: "requestedBy", header: "Requested by", sortable: true, width: "11rem" },
    { key: "requested", header: "Requested", sortable: true, width: "8.5rem" },
    { key: "issued", header: "Released", sortable: true, width: "8.5rem", defaultHidden: true },
    { key: "age", header: "Age (days)", numeric: true, sortable: true, width: "7.5rem", defaultHidden: true },
    { key: "action", header: "", width: "7.5rem", noExport: true },
  ];

  const rows: TableRow[] = issues.map((i) => {
    const requested = round2(i.items.reduce((a, li) => a + li.requestedQty, 0));
    const issued = round2(i.items.reduce((a, li) => a + li.issuedQty, 0));
    const consumer = i.projectId
      ? (projCode.get(i.projectId) ?? "Project")
      : (deptName.get(i.departmentId ?? "") ?? "—");
    const stale = [...AWAITING, "APPROVED"].includes(i.status) && (ageDays(i.requestedAt) ?? 0) > 3;
    return {
      id: i.id,
      href: `/issuance/${i.id}`,
      flag: i.status === "REJECTED" ? "danger" : stale ? "warning" : i.status === "ISSUED" ? "success" : null,
      search: `${i.number} ${i.recipientName} ${i.purpose ?? ""} ${i.items.map((li) => li.item.name).join(" ")}`,
      values: {
        number: i.number,
        store: i.store.name,
        entity: i.store.entity.code,
        recipient: i.recipientName,
        consumer,
        purpose: i.purpose ?? "",
        lines: i.items.length,
        requestedQty: requested,
        issuedQty: issued,
        status: humanize(i.status),
        requestedBy: i.requestedBy.name,
        requested: i.requestedAt.toISOString(),
        issued: i.issuedAt ? i.issuedAt.toISOString() : "",
        age: ageDays(i.requestedAt) ?? 0,
        action: "",
      },
      cells: {
        number: <RefLink href={`/issuance/${i.id}`}>{i.number}</RefLink>,
        store: (
          <span>
            <RefLink href={`/stores/${i.store.id}`}>{i.store.name}</RefLink>
            <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{humanize(i.store.kind)}</span>
          </span>
        ),
        entity: <Badge tone="neutral">{i.store.entity.code}</Badge>,
        recipient: i.recipientName,
        consumer: consumer === "—" ? "—" : <Badge tone={i.projectId ? "info" : "neutral"}>{consumer}</Badge>,
        purpose: (
          <span className="block max-w-[24rem] truncate" title={i.purpose ?? ""}>
            {i.purpose ?? "—"}
          </span>
        ),
        lines: i.items.length,
        requestedQty: <Mono>{qty(requested)}</Mono>,
        issuedQty: issued > 0 ? <Mono>{qty(issued)}</Mono> : "—",
        status: <StatusBadge status={i.status} />,
        requestedBy: i.requestedBy.name,
        requested: fmtDate(i.requestedAt),
        issued: i.issuedAt ? fmtDate(i.issuedAt) : "—",
        age: ageDays(i.requestedAt) ?? 0,
        action:
          AWAITING.includes(i.status) && canApprove ? (
            <Link href={`/issuance/${i.id}`} className="btn btn-primary btn-xs">
              Approve
            </Link>
          ) : ["APPROVED", "PARTIALLY_ISSUED"].includes(i.status) && canIssue ? (
            <Link href={`/issuance/${i.id}`} className="btn btn-primary btn-xs">
              Release
            </Link>
          ) : (
            <span className="text-2xs text-[var(--c-text-tertiary)]">—</span>
          ),
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Demand"
        title="Store requisitions"
        subtitle="Requests for stock the stores already hold. Each one is approved by the department and the head before the counter releases anything, and every release deducts inventory through the ledger."
        actions={
          canIssue && (
            <Link href="/issuance/new" className="btn btn-primary btn-sm">
              Raise issue
            </Link>
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Open requisitions" value={stats.open} hint="Not yet fully issued" />
        <StatTile
          label="Awaiting approval"
          value={stats.awaitingApproval}
          tone={stats.awaitingApproval ? "warning" : "default"}
        />
        <StatTile
          label="Approved, not released"
          value={stats.awaitingRelease}
          hint="Store has authority to hand over"
          tone={stats.awaitingRelease ? "accent" : "default"}
        />
        <StatTile label="Released in last 30 days" value={stats.issuedThisMonth} tone="success" />
      </div>

      {consumerRows.length > 0 && (
        <SectionCard
          title="Consumption by cost centre"
          description="Units released, grouped by the project or department the stock was charged to."
        >
          <RankedBars data={consumerRows} format="number" maxRows={8} secondaryLabel="units issued" />
        </SectionCard>
      )}

      <DataTable
        id="issuance"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "requested", dir: "desc" }}
        exportName="stock-issues"
        emptyState={
          <EmptyState
            title="No stock issues raised"
            description="An issue records stock leaving a store for internal use — site consumption, an office requirement, or handing an asset to a custodian."
            action={
              canIssue && (
                <Link href="/issuance/new" className="btn btn-primary btn-sm">
                  Raise issue
                </Link>
              )
            }
          />
        }
      />
    </div>
  );
}
