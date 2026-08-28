import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import {
  Badge,
  EmptyState,
  InlineAlert,
  Mono,
  PageHeader,
  RefLink,
  StatTile,
} from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { money, round2 } from "@/lib/format";
import { adminOptions } from "../actions";
import { StoreForm } from "../AdminMasterForms";
import { tableLink } from "@/lib/links";

export const metadata = { title: "Stores" };
export const dynamic = "force-dynamic";

export default async function AdminStoresPage() {
  const { authorized } = await pageContext(P.MASTER_DATA_MANAGE);
  if (!authorized) {
    return <AccessDenied title="Stores" message="You do not have permission to manage stores." />;
  }

  const [stores, options] = await Promise.all([
    prisma.store.findMany({
      orderBy: [{ entity: { code: "asc" } }, { kind: "asc" }, { name: "asc" }],
      include: {
        entity: { select: { id: true, code: true } },
        site: { select: { id: true, code: true, name: true } },
        project: { select: { id: true, code: true, name: true } },
        inventory: { select: { quantity: true, unitCost: true } },
        _count: { select: { locations: true, grns: true, issues: true, transfersFrom: true, transfersTo: true } },
      },
    }),
    adminOptions(),
  ]);

  const managerIds = [...new Set(stores.map((s) => s.managerId).filter((x): x is string => !!x))];
  const managers = managerIds.length
    ? await prisma.user.findMany({ where: { id: { in: managerIds } }, select: { id: true, name: true, title: true } })
    : [];
  const managerById = new Map(managers.map((m) => [m.id, m]));

  const active = stores.filter((s) => s.active);
  const withoutKeeper = active.filter((s) => !s.managerId);
  const totalValue = round2(
    stores.reduce((a, s) => a + s.inventory.reduce((x, i) => x + i.quantity * i.unitCost, 0), 0),
  );

  const columns: TableColumn[] = [
    { key: "code", header: "Code", locked: true, sortable: true, width: "9rem" },
    { key: "name", header: "Store", sortable: true, minWidth: "16rem" },
    { key: "kind", header: "Type", filterable: true, sortable: true, width: "13rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "6rem" },
    { key: "keeper", header: "Storekeeper", sortable: true, minWidth: "14rem" },
    { key: "site", header: "Site", filterable: true, sortable: true, width: "13rem" },
    { key: "project", header: "Project", filterable: true, sortable: true, width: "13rem" },
    { key: "city", header: "City", filterable: true, sortable: true, width: "9rem" },
    { key: "value", header: "Stock value", numeric: true, sortable: true, width: "12rem" },
    { key: "lines", header: "Stock lines", numeric: true, sortable: true, width: "9.5rem" },
    { key: "bins", header: "Bins", numeric: true, sortable: true, width: "7rem" },
    { key: "receipts", header: "GRNs", numeric: true, sortable: true, width: "7.5rem" },
    { key: "issues", header: "Issues", numeric: true, sortable: true, width: "7.5rem" },
    { key: "transfers", header: "Transfers", numeric: true, sortable: true, width: "9rem" },
    { key: "keeperState", header: "Storekeeper state", filterable: true, sortable: true, width: "12rem", defaultHidden: true },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "8rem" },
    { key: "actions", header: "", width: "6rem", noExport: true },
  ];

  const rows: TableRow[] = stores.map((s) => {
    const manager = s.managerId ? managerById.get(s.managerId) : null;
    const value = round2(s.inventory.reduce((a, i) => a + i.quantity * i.unitCost, 0));
    return {
      id: s.id,
      href: `/stores/${s.id}`,
      flag: !s.active ? "danger" : !s.managerId ? "warning" : null,
      search: `${s.code} ${s.name} ${manager?.name ?? ""} ${s.city ?? ""} ${s.site?.name ?? ""}`,
      values: {
        code: s.code,
        name: s.name,
        kind: humanize(s.kind),
        entity: s.entity.code,
        keeper: manager?.name ?? "",
        site: s.site?.name ?? "",
        project: s.project?.name ?? "",
        city: s.city ?? "",
        value,
        lines: s.inventory.length,
        bins: s._count.locations,
        receipts: s._count.grns,
        issues: s._count.issues,
        transfers: s._count.transfersFrom + s._count.transfersTo,
        status: s.active ? "Active" : "Inactive",
        keeperState: manager ? "Assigned" : "No storekeeper",
        actions: "",
      },
      cells: {
        keeperState: manager ? (
          <span className="text-[var(--c-text-tertiary)]">Assigned</span>
        ) : (
          <Badge tone="warning">No storekeeper</Badge>
        ),
        code: <Mono>{s.code}</Mono>,
        name: <RefLink href={`/stores/${s.id}`}>{s.name}</RefLink>,
        kind: <Badge tone="neutral">{humanize(s.kind)}</Badge>,
        entity: <Badge tone="neutral">{s.entity.code}</Badge>,
        keeper: manager ? manager.name : <Badge tone="warning">No storekeeper</Badge>,
        site: s.site?.name ?? "—",
        project: s.project?.name ?? "—",
        city: s.city ?? "—",
        value: value > 0 ? <Mono>{money(value)}</Mono> : "—",
        lines: s.inventory.length,
        bins: s._count.locations,
        receipts: s._count.grns,
        issues: s._count.issues,
        transfers: s._count.transfersFrom + s._count.transfersTo,
        status: s.active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Inactive</Badge>,
        actions: (
          <StoreForm
            entities={options.entities}
            sites={options.sites}
            projects={options.projects}
            users={options.users}
            initial={{
              id: s.id,
              entityId: s.entityId,
              code: s.code,
              name: s.name,
              kind: s.kind,
              siteId: s.siteId,
              projectId: s.projectId,
              address: s.address,
              city: s.city,
              managerId: s.managerId,
              active: s.active,
            }}
          />
        ),
      },
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Administration", href: "/admin" }, { label: "Stores" }]} />

      <PageHeader
        eyebrow="Administration"
        title="Stores"
        subtitle="Where inventory physically lives. Every receipt, issue and transfer names a store, and balances are held per store."
        actions={
          <>
            <Link href="/stores" className="btn btn-secondary btn-sm">
              Store operations
            </Link>
            <StoreForm
              entities={options.entities}
              sites={options.sites}
              projects={options.projects}
              users={options.users}
            />
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Stores" value={stores.length} href="/admin/stores" />
        <StatTile
          label="Active"
          value={active.length}
          tone="success"
          href={tableLink("/admin/stores", { status: "Active" })}
        />
        <StatTile
          label="Without a storekeeper"
          value={withoutKeeper.length}
          tone={withoutKeeper.length ? "warning" : "success"}
          hint="Store tasks have nobody to route to"
          href={tableLink("/admin/stores", { keeperState: "No storekeeper" })}
        />
        <StatTile
          label="Stock value held"
          value={money(totalValue)}
          href={tableLink("/admin/stores", undefined, { sort: "value:desc" })}
        />
      </div>

      {withoutKeeper.length > 0 && (
        <InlineAlert tone="warning">
          {withoutKeeper.length} active store{withoutKeeper.length === 1 ? " has" : "s have"} no storekeeper:{" "}
          {withoutKeeper.map((s) => s.name).join(", ")}. Receiving and issue tasks for these stores fall back to whoever
          triggered them.
        </InlineAlert>
      )}

      <DataTable
        id="admin-stores"
        columns={columns}
        rows={rows}
        defaultSort={{ key: "code", dir: "asc" }}
        exportName="stores"
        emptyState={<EmptyState title="No stores" description="Create a store before receiving any goods." />}
      />
    </div>
  );
}
