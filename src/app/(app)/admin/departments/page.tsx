import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, InlineAlert, Mono, PageHeader, StatTile } from "@/components/ui/primitives";
import { adminOptions } from "../actions";
import { DepartmentForm } from "../AdminMasterForms";

export const metadata = { title: "Departments" };
export const dynamic = "force-dynamic";

export default async function AdminDepartmentsPage() {
  const { authorized } = await pageContext(P.MASTER_DATA_MANAGE);
  if (!authorized) {
    return <AccessDenied title="Departments" message="You do not have permission to manage departments." />;
  }

  const [departments, options] = await Promise.all([
    prisma.department.findMany({
      orderBy: [{ entity: { code: "asc" } }, { name: "asc" }],
      include: {
        entity: { select: { id: true, code: true, name: true } },
        _count: { select: { users: true, requisitions: true, approvalRules: true, pettyCash: true } },
      },
    }),
    adminOptions(),
  ]);

  const headIds = [...new Set(departments.map((d) => d.headId).filter((x): x is string => !!x))];
  const heads = headIds.length
    ? await prisma.user.findMany({ where: { id: { in: headIds } }, select: { id: true, name: true, title: true } })
    : [];
  const headById = new Map(heads.map((h) => [h.id, h]));

  const withoutHead = departments.filter((d) => !d.headId && d.active);
  const active = departments.filter((d) => d.active);

  const columns: TableColumn[] = [
    { key: "code", header: "Code", locked: true, sortable: true, width: "8rem" },
    { key: "name", header: "Department", sortable: true, minWidth: "16rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "6rem" },
    { key: "head", header: "Head", sortable: true, minWidth: "14rem" },
    { key: "costCenter", header: "Cost centre", sortable: true, width: "11rem" },
    { key: "users", header: "People", numeric: true, sortable: true, width: "7.5rem" },
    { key: "requisitions", header: "Requisitions", numeric: true, sortable: true, width: "9.5rem" },
    { key: "pettyCash", header: "Petty cash", numeric: true, sortable: true, width: "9rem" },
    { key: "rules", header: "Approval rules", numeric: true, sortable: true, width: "10rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "8rem" },
    { key: "actions", header: "", width: "6rem", noExport: true },
  ];

  const rows: TableRow[] = departments.map((d) => {
    const head = d.headId ? headById.get(d.headId) : null;
    return {
      id: d.id,
      flag: !d.active ? "danger" : !d.headId ? "warning" : null,
      search: `${d.code} ${d.name} ${head?.name ?? ""} ${d.costCenter ?? ""}`,
      values: {
        code: d.code,
        name: d.name,
        entity: d.entity.code,
        head: head?.name ?? "",
        costCenter: d.costCenter ?? "",
        users: d._count.users,
        requisitions: d._count.requisitions,
        pettyCash: d._count.pettyCash,
        rules: d._count.approvalRules,
        status: d.active ? "Active" : "Inactive",
        actions: "",
      },
      cells: {
        code: <Mono>{d.code}</Mono>,
        name: d.name,
        entity: <Badge tone="neutral">{d.entity.code}</Badge>,
        head: head ? (
          <span>
            <span className="block text-xs">{head.name}</span>
            {head.title && <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{head.title}</span>}
          </span>
        ) : (
          <Badge tone="warning">No head</Badge>
        ),
        costCenter: d.costCenter ?? "—",
        users: d._count.users,
        requisitions: d._count.requisitions,
        pettyCash: d._count.pettyCash,
        rules: d._count.approvalRules,
        status: d.active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Inactive</Badge>,
        actions: (
          <DepartmentForm
            entities={options.entities}
            users={options.users}
            initial={{
              id: d.id,
              entityId: d.entityId,
              code: d.code,
              name: d.name,
              headId: d.headId,
              costCentre: d.costCenter,
              active: d.active,
            }}
          />
        ),
      },
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Administration", href: "/admin" }, { label: "Departments" }]} />

      <PageHeader
        eyebrow="Administration"
        title="Departments"
        subtitle="Departments own requisitions and budgets. The head is the approver wherever a rule delegates to the requesting department."
        actions={<DepartmentForm entities={options.entities} users={options.users} />}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Departments" value={departments.length} />
        <StatTile label="Active" value={active.length} tone="success" />
        <StatTile
          label="Without a head"
          value={withoutHead.length}
          tone={withoutHead.length ? "warning" : "success"}
          hint="Department-head approvals cannot be routed"
        />
        <StatTile label="Requisitions raised" value={departments.reduce((a, d) => a + d._count.requisitions, 0)} />
      </div>

      {withoutHead.length > 0 && (
        <InlineAlert tone="warning">
          {withoutHead.length} active department{withoutHead.length === 1 ? " has" : "s have"} no head assigned:{" "}
          {withoutHead.map((d) => d.name).join(", ")}. Any approval step that delegates to the department head will have
          nobody to route to.
        </InlineAlert>
      )}

      <DataTable
        id="admin-departments"
        columns={columns}
        rows={rows}
        defaultSort={{ key: "code", dir: "asc" }}
        exportName="departments"
        emptyState={<EmptyState title="No departments" description="Add the first department for this entity." />}
      />
    </div>
  );
}
