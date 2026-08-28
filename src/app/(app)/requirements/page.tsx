import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { requirementVisibilityFilter } from "@/server/requirements";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import {
  Badge,
  EmptyState,
  InlineAlert,
  PageHeader,
  RefLink,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, money } from "@/lib/format";
import { statusLink } from "@/lib/links";

export const metadata = { title: "Requirements" };
export const dynamic = "force-dynamic";

/**
 * The demand register.
 *
 * This is the front door: a department states what it needs and the system
 * decides whether a store can meet it before procurement is involved at all.
 * The register is therefore ordered by what is waiting on a decision, not by
 * what was raised most recently.
 */
export default async function RequirementsPage() {
  const { user, ctx, authorized } = await pageContext(P.REQUIREMENT_VIEW, P.REQUIREMENT_VIEW_ALL);
  if (!authorized) {
    return <AccessDenied title="Requirements" message="You do not have permission to view requirements." />;
  }

  const requirements = await prisma.requirement.findMany({
    where: { ...ctx.entityFilter, ...requirementVisibilityFilter(user) },
    orderBy: [{ createdAt: "desc" }],
    take: 400,
    include: {
      entity: { select: { code: true } },
      department: { select: { name: true } },
      requester: { select: { name: true } },
      store: { select: { code: true, name: true } },
      items: { select: { id: true, quantity: true, fromStockQty: true, procureQty: true } },
      storeIssues: { select: { id: true, number: true, status: true } },
      requisitions: { select: { id: true, number: true, status: true } },
    },
  });

  const canCreate = userHasPermission(user, P.REQUIREMENT_CREATE);
  const canDecide = userHasPermission(user, P.REQUIREMENT_DECIDE);

  const awaiting = requirements.filter((r) => ["SUBMITTED", "CHECKING_STOCK"].includes(r.status));
  const fromStock = requirements.filter((r) => r.status === "FULFILLED_FROM_STOCK");
  const split = requirements.filter((r) => r.status === "SPLIT");
  const bought = requirements.filter((r) => r.status === "SENT_TO_PROCUREMENT");

  const columns: TableColumn[] = [
    { key: "number", header: "Requirement", locked: true, sortable: true, width: "11rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "department", header: "Department", filterable: true, sortable: true, width: "13rem" },
    { key: "title", header: "What is needed", sortable: true, minWidth: "20rem" },
    { key: "lines", header: "Lines", numeric: true, sortable: true, width: "6rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "13rem" },
    { key: "outcome", header: "Met by", filterable: true, sortable: true, width: "16rem" },
    { key: "store", header: "Store", filterable: true, sortable: true, width: "10rem" },
    { key: "priority", header: "Priority", filterable: true, sortable: true, width: "8rem" },
    { key: "value", header: "Estimated", numeric: true, sortable: true, width: "10rem" },
    { key: "requester", header: "Raised by", sortable: true, width: "12rem" },
    { key: "required", header: "Needed by", sortable: true, width: "9rem" },
    { key: "age", header: "Age (days)", numeric: true, sortable: true, width: "7.5rem", defaultHidden: true },
  ];

  const rows: TableRow[] = requirements.map((r) => {
    const outcome =
      r.storeIssues.length && r.requisitions.length
        ? `${r.storeIssues.length} store req · ${r.requisitions.length} purchase req`
        : r.storeIssues.length
          ? r.storeIssues.map((s) => s.number).join(", ")
          : r.requisitions.length
            ? r.requisitions.map((s) => s.number).join(", ")
            : "";
    const waiting = ["SUBMITTED", "CHECKING_STOCK"].includes(r.status);
    return {
      id: r.id,
      href: `/requirements/${r.id}`,
      flag: waiting ? "warning" : r.status === "CANCELLED" ? "danger" : r.decidedAt ? "success" : null,
      search: `${r.number} ${r.title} ${r.department.name} ${r.requester.name} ${outcome}`,
      values: {
        number: r.number,
        entity: r.entity.code,
        department: r.department.name,
        title: r.title,
        lines: r.items.length,
        status: humanize(r.status),
        outcome,
        store: r.store?.code ?? "",
        priority: humanize(r.priority),
        value: r.estimatedValue,
        requester: r.requester.name,
        required: r.requiredDate.toISOString(),
        age: ageDays(r.createdAt) ?? 0,
      },
      cells: {
        number: <RefLink href={`/requirements/${r.id}`}>{r.number}</RefLink>,
        entity: <Badge tone="neutral">{r.entity.code}</Badge>,
        department: r.department.name,
        lines: r.items.length,
        store: r.store?.code ?? "—",
        requester: r.requester.name,
        age: ageDays(r.createdAt) ?? 0,
        title: (
          <span className="block max-w-[28rem] truncate" title={r.title}>
            {r.title}
          </span>
        ),
        status: <StatusBadge status={r.status} />,
        outcome: outcome ? (
          <span className="flex flex-wrap gap-1">
            {r.storeIssues.map((s) => (
              <Link key={s.id} href={`/issuance/${s.id}`} className="ref-chip mono text-2xs text-[var(--c-accent-text)]">
                {s.number}
              </Link>
            ))}
            {r.requisitions.map((s) => (
              <Link key={s.id} href={`/pr/${s.id}`} className="ref-chip mono text-2xs text-[var(--c-accent-text)]">
                {s.number}
              </Link>
            ))}
          </span>
        ) : (
          <span className="text-[var(--c-text-tertiary)]">—</span>
        ),
        priority: <Badge tone={r.priority === "URGENT" ? "danger" : r.priority === "HIGH" ? "warning" : "neutral"}>{humanize(r.priority)}</Badge>,
        value: money(r.estimatedValue, "PKR", { compact: true }),
        required: fmtDate(r.requiredDate),
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Demand"
        title="Requirements"
        subtitle="What departments need. Every requirement is checked against stock before it is allowed to become a purchase."
        actions={
          canCreate && (
            <Link href="/requirements/new" className="btn btn-primary btn-sm">
              New requirement
            </Link>
          )
        }
      />

      {awaiting.length > 0 && canDecide && (
        <InlineAlert tone="warning">
          {awaiting.length} requirement{awaiting.length === 1 ? "" : "s"} waiting on a stock check and a decision. Until
          one is taken, nothing is issued and nothing is bought.
        </InlineAlert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Awaiting decision"
          value={awaiting.length}
          hint="Submitted, not yet routed"
          tone={awaiting.length ? "warning" : "default"}
          href={statusLink("/requirements", "status", ["SUBMITTED", "CHECKING_STOCK"])}
        />
        <StatTile
          label="Met from stock"
          value={fromStock.length}
          hint="No purchase needed"
          tone="success"
          href={statusLink("/requirements", "status", ["FULFILLED_FROM_STOCK"])}
        />
        <StatTile
          label="Split"
          value={split.length}
          hint="Part issued, part bought"
          href={statusLink("/requirements", "status", ["SPLIT"])}
        />
        <StatTile
          label="Sent to procurement"
          value={bought.length}
          hint="Nothing on the shelf"
          href={statusLink("/requirements", "status", ["SENT_TO_PROCUREMENT"])}
        />
      </div>

      <DataTable
        id="requirements"
        columns={columns}
        rows={rows}
        exportName="requirements"
        defaultSort={{ key: "required", dir: "asc" }}
        emptyState={
          <EmptyState
            title="No requirements yet"
            description="A requirement is the first step: state what is needed, and the stores are checked before anybody buys."
            action={
              canCreate ? (
                <Link href="/requirements/new" className="btn btn-primary btn-sm">
                  New requirement
                </Link>
              ) : undefined
            }
          />
        }
      />
    </div>
  );
}
