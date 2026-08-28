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
  SectionCard,
  StatTile,
} from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/forms";
import { RankedBars } from "@/components/ui/charts";
import { fmtDateTime, relativeTime } from "@/lib/format";
import { adminOptions, toggleUserAction } from "../actions";
import { ResetPasswordForm, UserForm } from "../AdminAccessForms";
import { tableLink } from "@/lib/links";

export const metadata = { title: "Users" };
export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const { user, authorized } = await pageContext(P.USER_MANAGE);
  if (!authorized) {
    return <AccessDenied title="Users" message="You do not have permission to manage users." />;
  }

  const [users, options, savedViews] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      include: {
        primaryDepartment: { select: { id: true, name: true } },
        roles: { include: { role: { select: { id: true, code: true, name: true } } } },
        entityAccess: { include: { entity: { select: { id: true, code: true } } } },
        sessions: {
          select: { id: true, createdAt: true, expiresAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    }),
    adminOptions(),
    prisma.savedView.findMany({
      where: { resource: "admin-users", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const entityById = new Map(options.entities.map((e) => [e.id, e]));
  const active = users.filter((u) => u.active);
  const noRoles = active.filter((u) => u.roles.length === 0);
  const withSessions = users.filter((u) => u.sessions.length > 0);

  const byRole = new Map<string, number>();
  for (const u of users) {
    for (const r of u.roles) byRole.set(r.role.name, (byRole.get(r.role.name) ?? 0) + 1);
  }

  const columns: TableColumn[] = [
    { key: "name", header: "Name", locked: true, sortable: true, minWidth: "15rem" },
    { key: "email", header: "Email", sortable: true, minWidth: "16rem" },
    { key: "title", header: "Job title", sortable: true, width: "16rem" },
    { key: "entity", header: "Primary entity", filterable: true, sortable: true, width: "10rem" },
    { key: "department", header: "Department", filterable: true, sortable: true, width: "14rem" },
    { key: "roles", header: "Roles", sortable: true, minWidth: "20rem" },
    { key: "roleCount", header: "Role count", numeric: true, sortable: true, width: "8.5rem", defaultHidden: true },
    { key: "entityAccess", header: "Entity access", sortable: true, width: "11rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "8rem" },
    { key: "roleState", header: "Role state", filterable: true, sortable: true, width: "10rem", defaultHidden: true },
    { key: "sessionState", header: "Session", filterable: true, sortable: true, width: "10rem", defaultHidden: true },
    { key: "lastLogin", header: "Latest session", sortable: true, width: "13rem" },
    { key: "actions", header: "", width: "16rem", noExport: true },
  ];

  const rows: TableRow[] = users.map((u) => {
    const primary = u.primaryEntityId ? entityById.get(u.primaryEntityId) : null;
    return {
      id: u.id,
      flag: !u.active ? "danger" : u.roles.length === 0 ? "warning" : null,
      search: `${u.name} ${u.email} ${u.title ?? ""} ${u.roles.map((r) => r.role.name).join(" ")}`,
      values: {
        name: u.name,
        email: u.email,
        title: u.title ?? "",
        entity: primary?.code ?? "",
        department: u.primaryDepartment?.name ?? "",
        roles: u.roles.map((r) => r.role.name).join(", "),
        roleCount: u.roles.length,
        entityAccess: u.entityAccess.map((a) => a.entity.code).join(", "),
        status: u.active ? "Active" : "Inactive",
        roleState: u.roles.length ? "Has a role" : "No role",
        sessionState: u.sessions[0] ? "Signed in" : "No session",
        lastLogin: u.sessions[0] ? u.sessions[0].createdAt.toISOString() : "",
        actions: "",
      },
      cells: {
        roleState: u.roles.length ? (
          <span className="text-[var(--c-text-tertiary)]">Has a role</span>
        ) : (
          <Badge tone="warning">No role</Badge>
        ),
        sessionState: u.sessions[0] ? (
          <Badge tone="success">Signed in</Badge>
        ) : (
          <span className="text-[var(--c-text-tertiary)]">No session</span>
        ),
        name: (
          <span>
            <span className="block text-xs font-500">{u.name}</span>
            {u.phone && <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{u.phone}</span>}
          </span>
        ),
        email: <Mono>{u.email}</Mono>,
        title: u.title ?? "—",
        entity: primary ? <Badge tone="neutral">{primary.code}</Badge> : "—",
        department: u.primaryDepartment?.name ?? "—",
        roles:
          u.roles.length === 0 ? (
            <Badge tone="warning">No roles</Badge>
          ) : (
            <span className="flex flex-wrap gap-1">
              {u.roles.map((r) => (
                <Badge key={r.role.id} tone="info">
                  {r.role.name}
                </Badge>
              ))}
            </span>
          ),
        roleCount: u.roles.length,
        entityAccess:
          u.entityAccess.length === 0 ? (
            <span className="text-2xs text-[var(--c-text-tertiary)]">Primary only</span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {u.entityAccess.map((a) => (
                <Badge key={a.entity.id} tone="neutral">
                  {a.entity.code}
                </Badge>
              ))}
            </span>
          ),
        status: u.active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Inactive</Badge>,
        lastLogin: u.sessions[0] ? (
          <span>
            <span className="block text-xs">{fmtDateTime(u.sessions[0].createdAt)}</span>
            <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
              {relativeTime(u.sessions[0].createdAt)}
            </span>
          </span>
        ) : (
          <span className="text-2xs text-[var(--c-text-tertiary)]">No recent session</span>
        ),
        actions: (
          <span className="flex flex-wrap items-center gap-1.5">
            <UserForm
              roles={options.roles}
              entities={options.entities}
              departments={options.departments}
              triggerClass="btn btn-secondary btn-xs"
              initial={{
                id: u.id,
                email: u.email,
                name: u.name,
                title: u.title,
                phone: u.phone,
                departmentId: u.primaryDepartmentId,
                primaryEntityId: u.primaryEntityId,
                active: u.active,
                roleIds: u.roles.map((r) => r.roleId),
                entityIds: u.entityAccess.map((a) => a.entityId),
              }}
            />
            <ResetPasswordForm userId={u.id} name={u.name} />
            {u.id !== user.id && (
              <ActionButton
                action={toggleUserAction}
                payload={{ userId: u.id }}
                label={u.active ? "Deactivate" : "Reactivate"}
                tone={u.active ? "danger-soft" : "secondary"}
                size="xs"
                reasonLabel={u.active ? "Why is this account being deactivated?" : "Why is this account being reactivated?"}
              />
            )}
          </span>
        ),
      },
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Administration", href: "/admin" }, { label: "Users" }]} />

      <PageHeader
        eyebrow="Administration"
        title="Users"
        subtitle="Accounts, the roles they hold and the entities they can see. Deactivating an account revokes its sessions immediately."
        actions={
          <UserForm roles={options.roles} entities={options.entities} departments={options.departments} />
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Accounts" value={users.length} href="/admin/users" />
        <StatTile
          label="Active"
          value={active.length}
          tone="success"
          href={tableLink("/admin/users", { status: "Active" })}
        />
        <StatTile
          label="Active with no role"
          value={noRoles.length}
          tone={noRoles.length ? "warning" : "default"}
          hint="Can sign in but see almost nothing"
          href={tableLink("/admin/users", { status: "Active", roleState: "No role" })}
        />
        <StatTile
          label="With a live session"
          value={withSessions.length}
          href={tableLink("/admin/users", { sessionState: "Signed in" }, { sort: "lastLogin:desc" })}
        />
      </div>

      {noRoles.length > 0 && (
        <InlineAlert tone="warning">
          {noRoles.length} active account{noRoles.length === 1 ? " has" : "s have"} no role assigned:{" "}
          {noRoles.slice(0, 5).map((u) => u.name).join(", ")}
          {noRoles.length > 5 ? ` and ${noRoles.length - 5} more` : ""}. Either assign a role or deactivate the account.
        </InlineAlert>
      )}

      <SectionCard title="People per role" description="How authority is actually distributed.">
        <RankedBars
          data={[...byRole.entries()]
            .map(([label, value]) => ({
              label,
              value,
              href: tableLink("/admin/users", undefined, { q: label }),
            }))
            .sort((a, b) => b.value - a.value)}
          format="number"
          maxRows={12}
        />
      </SectionCard>

      <DataTable
        id="admin-users"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "name", dir: "asc" }}
        exportName="users"
        emptyState={<EmptyState title="No users" description="Add the first account to get started." />}
      />
    </div>
  );
}
