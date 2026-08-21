import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, PageHeader, RefLink, StatTile, StatusBadge } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { ageHours, fmtDateTime, qty } from "@/lib/format";

export const metadata = { title: "Inspections" };
export const dynamic = "force-dynamic";

export default async function InspectionsPage() {
  const { user, ctx, authorized } = await pageContext(P.INSPECTION_VIEW);
  if (!authorized) {
    return <AccessDenied title="Inspections" message="You do not have permission to view inspections." />;
  }

  const [inspections, sla, savedViews] = await Promise.all([
    prisma.inspection.findMany({
      where: { po: ctx.entityFilter },
      orderBy: [{ createdAt: "desc" }],
      take: 400,
      include: {
        po: { select: { id: true, number: true, entity: { select: { code: true } }, vendor: { select: { name: true } } } },
        delivery: { select: { id: true, number: true, store: { select: { name: true } } } },
        inspector: { select: { id: true, name: true } },
        items: { select: { id: true, quantityInspected: true, quantityPassed: true, quantityFailed: true, verdict: true } },
        grns: { select: { id: true, number: true } },
      },
    }),
    getConfigNumber(CONFIG_KEYS.SLA_INSPECTION_HOURS, ctx.entityId),
    prisma.savedView.findMany({
      where: { resource: "inspections", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const pending = inspections.filter((i) => ["PENDING", "IN_PROGRESS", "RE_INSPECTION_REQUIRED"].includes(i.result));
  const overdue = pending.filter((i) => (ageHours(i.scheduledAt ?? i.createdAt) ?? 0) > sla);
  const unassigned = pending.filter((i) => !i.inspectorId);
  const rejected = inspections.filter((i) => i.result === "REJECTED");

  const columns: TableColumn[] = [
    { key: "number", header: "Inspection", locked: true, sortable: true, width: "10rem" },
    { key: "type", header: "Type", filterable: true, sortable: true, width: "9rem" },
    { key: "result", header: "Result", filterable: true, sortable: true, width: "13rem" },
    { key: "po", header: "PO", sortable: true, width: "9.5rem" },
    { key: "vendor", header: "Vendor", sortable: true, minWidth: "12rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "delivery", header: "Receipt", sortable: true, width: "9.5rem" },
    { key: "store", header: "Store", filterable: true, sortable: true, width: "13rem" },
    { key: "inspector", header: "Inspector", filterable: true, sortable: true, width: "12rem" },
    { key: "lines", header: "Lines", numeric: true, sortable: true, width: "5rem" },
    { key: "inspected", header: "Inspected", numeric: true, sortable: true, width: "8rem" },
    { key: "passed", header: "Passed", numeric: true, sortable: true, width: "7rem" },
    { key: "failed", header: "Failed", numeric: true, sortable: true, width: "7rem" },
    { key: "grn", header: "GRN", sortable: true, width: "9.5rem" },
    { key: "raised", header: "Raised", sortable: true, width: "12rem" },
    { key: "age", header: "Age", numeric: true, sortable: true, width: "6rem" },
    { key: "signedBy", header: "Signed by", sortable: true, minWidth: "13rem", defaultHidden: true },
  ];

  const rows: TableRow[] = inspections.map((i) => {
    const isPending = ["PENDING", "IN_PROGRESS", "RE_INSPECTION_REQUIRED"].includes(i.result);
    const hours = ageHours(i.scheduledAt ?? i.createdAt) ?? 0;
    const isOverdue = isPending && hours > sla;
    const inspected = i.items.reduce((a, x) => a + x.quantityInspected, 0);
    const passed = i.items.reduce((a, x) => a + x.quantityPassed, 0);
    const failed = i.items.reduce((a, x) => a + x.quantityFailed, 0);
    return {
      id: i.id,
      href: `/inspections/${i.id}`,
      flag: i.result === "REJECTED" ? "danger" : isOverdue ? "warning" : i.result === "APPROVED" ? "success" : null,
      search: `${i.number} ${i.po?.number ?? ""} ${i.po?.vendor.name ?? ""} ${i.delivery?.number ?? ""}`,
      values: {
        number: i.number,
        type: humanize(i.inspectionType),
        result: humanize(i.result),
        po: i.po?.number ?? "",
        vendor: i.po?.vendor.name ?? "",
        entity: i.po?.entity.code ?? "",
        delivery: i.delivery?.number ?? "",
        store: i.delivery?.store.name ?? "",
        inspector: i.inspector?.name ?? "Unassigned",
        lines: i.items.length,
        inspected,
        passed,
        failed,
        grn: i.grns[0]?.number ?? "",
        raised: i.createdAt.toISOString(),
        age: Math.floor(hours / 24),
        signedBy: i.signedByName ?? "",
      },
      cells: {
        number: <RefLink href={`/inspections/${i.id}`}>{i.number}</RefLink>,
        type: <Badge tone="neutral">{humanize(i.inspectionType)}</Badge>,
        result: (
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={i.result} />
            {isOverdue && <Badge tone="danger">Overdue</Badge>}
          </span>
        ),
        po: i.po ? <RefLink href={`/po/${i.po.id}`}>{i.po.number}</RefLink> : "—",
        vendor: i.po?.vendor.name ?? "—",
        entity: i.po ? <Badge tone="neutral">{i.po.entity.code}</Badge> : "—",
        delivery: i.delivery ? <RefLink href={`/receiving/${i.delivery.id}`}>{i.delivery.number}</RefLink> : "—",
        store: i.delivery?.store.name ?? "—",
        inspector: i.inspector ? (
          i.inspector.name
        ) : (
          <Badge tone="warning">Unassigned</Badge>
        ),
        lines: i.items.length,
        inspected: qty(inspected),
        passed: <span className="text-[var(--c-success)]">{qty(passed)}</span>,
        failed: failed > 0 ? <span className="text-[var(--c-danger)]">{qty(failed)}</span> : "—",
        grn: i.grns[0] ? <RefLink href={`/grn/${i.grns[0].id}`}>{i.grns[0].number}</RefLink> : "—",
        raised: fmtDateTime(i.createdAt),
        age: <span className={isOverdue ? "tnum text-[var(--c-danger)]" : "tnum"}>{Math.floor(hours / 24)}d</span>,
        signedBy: i.signedByName ?? "—",
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Operations"
        title="Technical inspections"
        subtitle={`Mandatory for configured categories. A GRN cannot be posted while a required inspection is outstanding or failed. Target turnaround is ${sla} hours.`}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Inspections" value={inspections.length} />
        <StatTile
          label="Outstanding"
          value={pending.length}
          hint="Blocking a GRN"
          tone={pending.length ? "warning" : "default"}
        />
        <StatTile
          label="Overdue"
          value={overdue.length}
          hint={`Beyond the ${sla}-hour target`}
          tone={overdue.length ? "danger" : "default"}
        />
        <StatTile
          label="Unassigned"
          value={unassigned.length}
          hint="No named inspector yet"
          tone={unassigned.length ? "warning" : "default"}
        />
        <StatTile label="Rejected" value={rejected.length} tone={rejected.length ? "danger" : "default"} />
      </div>

      <DataTable
        id="inspections"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "raised", dir: "desc" }}
        exportName="technical-inspections"
        emptyState={
          <EmptyState
            title="No inspections raised"
            description="An inspection is raised automatically when goods are received against a category configured to require one — IT equipment, machinery, electrical and structural steel by default."
            action={
              <Link href="/admin/policies" className="btn btn-secondary btn-sm">
                Review inspection policy
              </Link>
            }
          />
        }
      />
    </div>
  );
}
