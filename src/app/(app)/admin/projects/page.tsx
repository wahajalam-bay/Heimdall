import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, Mono, PageHeader, SectionCard, StatTile } from "@/components/ui/primitives";
import { RankedBars } from "@/components/ui/charts";
import { fmtDate, money, round2, toInputDate } from "@/lib/format";
import { adminOptions } from "../actions";
import { ProjectForm } from "../AdminMasterForms";
import { tableLink } from "@/lib/links";

export const metadata = { title: "Projects" };
export const dynamic = "force-dynamic";

export default async function AdminProjectsPage() {
  const { authorized } = await pageContext(P.MASTER_DATA_MANAGE);
  if (!authorized) {
    return <AccessDenied title="Projects" message="You do not have permission to manage projects." />;
  }

  const [projects, options] = await Promise.all([
    prisma.project.findMany({
      orderBy: [{ status: "asc" }, { code: "asc" }],
      include: {
        entity: { select: { id: true, code: true } },
        _count: { select: { sites: true, stores: true, requisitions: true } },
        requisitions: { select: { estimatedValue: true, status: true } },
      },
    }),
    adminOptions(),
  ]);

  const managerIds = [...new Set(projects.map((p) => p.managerId).filter((x): x is string => !!x))];
  const managers = managerIds.length
    ? await prisma.user.findMany({ where: { id: { in: managerIds } }, select: { id: true, name: true, title: true } })
    : [];
  const managerById = new Map(managers.map((m) => [m.id, m]));

  const activeProjects = projects.filter((p) => p.status === "Active");
  const budgeted = round2(projects.reduce((a, p) => a + (p.budget ?? 0), 0));

  const columns: TableColumn[] = [
    { key: "code", header: "Code", locked: true, sortable: true, width: "9rem" },
    { key: "name", header: "Project", sortable: true, minWidth: "18rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "6rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "9.5rem" },
    { key: "manager", header: "Project manager", sortable: true, minWidth: "14rem" },
    { key: "city", header: "City", filterable: true, sortable: true, width: "9rem" },
    { key: "budget", header: "Budget", numeric: true, sortable: true, width: "12rem" },
    { key: "committed", header: "Requisitioned", numeric: true, sortable: true, width: "12rem" },
    { key: "utilisation", header: "Utilisation", numeric: true, sortable: true, width: "10rem" },
    { key: "sites", header: "Sites", numeric: true, sortable: true, width: "7rem" },
    { key: "stores", header: "Stores", numeric: true, sortable: true, width: "7rem" },
    { key: "requisitions", header: "Requisitions", numeric: true, sortable: true, width: "9.5rem" },
    { key: "start", header: "Start", sortable: true, width: "9rem" },
    { key: "end", header: "End", sortable: true, width: "9rem" },
    { key: "actions", header: "", width: "6rem", noExport: true },
  ];

  const rows: TableRow[] = projects.map((p) => {
    const manager = p.managerId ? managerById.get(p.managerId) : null;
    const committed = round2(
      p.requisitions.filter((r) => !["DRAFT", "REJECTED", "CANCELLED"].includes(r.status)).reduce((a, r) => a + r.estimatedValue, 0),
    );
    const utilisation = p.budget && p.budget > 0 ? round2((committed / p.budget) * 100) : null;
    return {
      id: p.id,
      flag:
        utilisation !== null && utilisation > 100
          ? "danger"
          : utilisation !== null && utilisation > 85
            ? "warning"
            : null,
      search: `${p.code} ${p.name} ${manager?.name ?? ""} ${p.city ?? ""}`,
      values: {
        code: p.code,
        name: p.name,
        entity: p.entity.code,
        status: p.status,
        manager: manager?.name ?? "",
        city: p.city ?? "",
        budget: p.budget ?? 0,
        committed,
        utilisation: utilisation ?? 0,
        sites: p._count.sites,
        stores: p._count.stores,
        requisitions: p._count.requisitions,
        start: p.startDate ? p.startDate.toISOString() : "",
        end: p.endDate ? p.endDate.toISOString() : "",
        actions: "",
      },
      cells: {
        code: <Mono>{p.code}</Mono>,
        name: p.name,
        entity: <Badge tone="neutral">{p.entity.code}</Badge>,
        status: (
          <Badge
            tone={
              p.status === "Active"
                ? "success"
                : p.status === "On Hold"
                  ? "warning"
                  : p.status === "Cancelled"
                    ? "danger"
                    : "neutral"
            }
          >
            {p.status}
          </Badge>
        ),
        manager: manager ? manager.name : <span className="text-2xs text-[var(--c-text-tertiary)]">Unassigned</span>,
        city: p.city ?? "—",
        budget: p.budget ? <Mono>{money(p.budget)}</Mono> : "—",
        committed: committed > 0 ? <Mono>{money(committed)}</Mono> : "—",
        utilisation:
          utilisation === null ? (
            "—"
          ) : (
            <Badge tone={utilisation > 100 ? "danger" : utilisation > 85 ? "warning" : "success"}>
              {utilisation.toFixed(0)}%
            </Badge>
          ),
        sites: p._count.sites,
        stores: p._count.stores,
        requisitions: p._count.requisitions,
        start: p.startDate ? fmtDate(p.startDate) : "—",
        end: p.endDate ? fmtDate(p.endDate) : "—",
        actions: (
          <ProjectForm
            entities={options.entities}
            users={options.users}
            initial={{
              id: p.id,
              entityId: p.entityId,
              code: p.code,
              name: p.name,
              city: p.city,
              managerId: p.managerId,
              budget: p.budget,
              status: p.status,
              startDate: p.startDate ? toInputDate(p.startDate) : null,
              endDate: p.endDate ? toInputDate(p.endDate) : null,
            }}
          />
        ),
      },
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Administration", href: "/admin" }, { label: "Projects" }]} />

      <PageHeader
        eyebrow="Administration"
        title="Projects"
        subtitle="Construction and development projects. Material demands, site stores and project spend all hang off these."
        actions={<ProjectForm entities={options.entities} users={options.users} />}
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Projects" value={projects.length} href="/admin/projects" />
        <StatTile
          label="Active"
          value={activeProjects.length}
          tone="success"
          href={tableLink("/admin/projects", { status: "Active" })}
        />
        <StatTile
          label="Total budget"
          value={money(budgeted)}
          href={tableLink("/admin/projects", undefined, { sort: "budget:desc" })}
        />
        <StatTile
          label="Requisitions raised"
          value={projects.reduce((a, p) => a + p._count.requisitions, 0)}
          href={tableLink("/admin/projects", undefined, { sort: "requisitions:desc" })}
        />
      </div>

      <SectionCard
        title="Budget utilisation"
        description="Requisitioned value against budget. Anything past 100% is committing more than the project holds."
      >
        <RankedBars
          data={projects
            .filter((p) => p.budget && p.budget > 0)
            .map((p) => {
              const committed = round2(
                p.requisitions
                  .filter((r) => !["DRAFT", "REJECTED", "CANCELLED"].includes(r.status))
                  .reduce((a, r) => a + r.estimatedValue, 0),
              );
              return {
                label: `${p.code} — ${p.name}`,
                value: round2((committed / (p.budget ?? 1)) * 100),
                sub: `${money(committed, "PKR", { compact: true })} of ${money(p.budget ?? 0, "PKR", { compact: true })}`,
                href: tableLink("/pr", { project: `${p.code} — ${p.name}` }),
              };
            })
            .sort((a, b) => b.value - a.value)}
          format="percent"
          maxRows={10}
        />
      </SectionCard>

      <DataTable
        id="admin-projects"
        columns={columns}
        rows={rows}
        defaultSort={{ key: "code", dir: "asc" }}
        exportName="projects"
        emptyState={<EmptyState title="No projects" description="Add a project before raising material demands against it." />}
      />
    </div>
  );
}
