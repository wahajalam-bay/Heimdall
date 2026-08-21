import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P, PERMISSION_META, ROLE_DEFINITIONS } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
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
import { restoreRoleDefaultsAction } from "../actions";
import { RoleForm } from "../AdminAccessForms";

export const metadata = { title: "Roles and permissions" };
export const dynamic = "force-dynamic";

export default async function AdminRolesPage() {
  const { authorized } = await pageContext(P.ROLE_MANAGE);
  if (!authorized) {
    return <AccessDenied title="Roles" message="You do not have permission to manage roles and permissions." />;
  }

  const [roles, allPermissions] = await Promise.all([
    prisma.role.findMany({
      orderBy: { name: "asc" },
      include: {
        permissions: { include: { permission: { select: { code: true, name: true, group: true } } } },
        users: { select: { userId: true } },
      },
    }),
    prisma.permission.findMany({ orderBy: [{ group: "asc" }, { code: "asc" }] }),
  ]);

  // Group the permission catalogue for the editor.
  const groupsMap = new Map<string, Array<{ code: string; name: string }>>();
  for (const p of allPermissions) {
    const list = groupsMap.get(p.group) ?? [];
    list.push({ code: p.code, name: p.name });
    groupsMap.set(p.group, list);
  }
  const permissionGroups = [...groupsMap.entries()].map(([group, permissions]) => ({ group, permissions }));

  const shippedByCode = new Map(ROLE_DEFINITIONS.map((r) => [r.code, r.permissions]));

  const drifted = roles.filter((r) => {
    const shipped = shippedByCode.get(r.code);
    if (!shipped) return false;
    const current = r.permissions.map((p) => p.permission.code);
    return (
      current.length !== shipped.length || current.some((c) => !shipped.includes(c)) || shipped.some((s) => !current.includes(s))
    );
  });

  const unassigned = roles.filter((r) => r.users.length === 0);
  const orphanPermissions = allPermissions.filter(
    (p) => !roles.some((r) => r.permissions.some((rp) => rp.permission.code === p.code)),
  );

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Administration", href: "/admin" }, { label: "Roles" }]} />

      <PageHeader
        eyebrow="Administration"
        title="Roles and permissions"
        subtitle={`${roles.length} roles across ${allPermissions.length} permissions. Every screen and every action re-checks these on the server — the interface never decides authority on its own.`}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Roles" value={roles.length} />
        <StatTile label="Permissions" value={allPermissions.length} />
        <StatTile
          label="Roles changed from shipped"
          value={drifted.length}
          tone={drifted.length ? "warning" : "default"}
          hint="Deliberate drift is fine; accidental drift is not"
        />
        <StatTile
          label="Permissions held by nobody"
          value={orphanPermissions.length}
          tone={orphanPermissions.length ? "warning" : "success"}
          hint="Nobody can perform these actions at all"
        />
      </div>

      {orphanPermissions.length > 0 && (
        <InlineAlert tone="warning">
          {orphanPermissions.length} permission{orphanPermissions.length === 1 ? " is" : "s are"} held by no role, so the
          corresponding action cannot be performed by anyone:{" "}
          {orphanPermissions
            .slice(0, 6)
            .map((p) => p.code)
            .join(", ")}
          {orphanPermissions.length > 6 ? ` and ${orphanPermissions.length - 6} more` : ""}.
        </InlineAlert>
      )}

      {unassigned.length > 0 && (
        <InlineAlert tone="info">
          {unassigned.length} role{unassigned.length === 1 ? " has" : "s have"} nobody assigned:{" "}
          {unassigned.map((r) => r.name).join(", ")}. Approval rules referencing them will find no approver.
        </InlineAlert>
      )}

      <SectionCard title="People per role" description="Where authority actually sits.">
        <RankedBars
          data={roles
            .map((r) => ({ label: r.name, value: r.users.length, sub: `${r.permissions.length} permissions` }))
            .sort((a, b) => b.value - a.value)}
          format="number"
          maxRows={12}
        />
      </SectionCard>

      {roles.length === 0 ? (
        <EmptyState title="No roles defined" description="Roles are created by the seed and can be edited here." />
      ) : (
        <div className="space-y-4">
          {roles.map((role) => {
            const current = role.permissions.map((p) => p.permission.code);
            const shipped = shippedByCode.get(role.code) ?? [];
            const added = current.filter((c) => !shipped.includes(c));
            const removed = shipped.filter((s) => !current.includes(s));
            const hasDrift = shipped.length > 0 && (added.length > 0 || removed.length > 0);

            const byGroup = new Map<string, number>();
            for (const p of role.permissions) {
              byGroup.set(p.permission.group, (byGroup.get(p.permission.group) ?? 0) + 1);
            }

            return (
              <SectionCard
                key={role.id}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {role.name}
                    <Mono>{role.code}</Mono>
                    {hasDrift && <Badge tone="warning">Changed from shipped</Badge>}
                    {role.users.length === 0 && <Badge tone="neutral">Nobody assigned</Badge>}
                  </span>
                }
                description={`${role.users.length} user(s) · ${current.length} permission(s)${role.description ? ` · ${role.description}` : ""}`}
                actions={
                  <>
                    <RoleForm
                      roleId={role.id}
                      roleName={role.name}
                      roleCode={role.code}
                      current={current}
                      permissionGroups={permissionGroups}
                      defaults={shipped}
                    />
                    {shipped.length > 0 && hasDrift && (
                      <ActionButton
                        action={restoreRoleDefaultsAction}
                        payload={{ roleId: role.id }}
                        label="Restore shipped"
                        tone="secondary"
                        size="sm"
                        confirm={`Restore ${role.name} to its shipped ${shipped.length} permissions? Local changes will be lost.`}
                        reasonLabel="Why is this role being reset to the shipped definition?"
                      />
                    )}
                  </>
                }
              >
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-1.5">
                    {[...byGroup.entries()]
                      .sort((a, b) => b[1] - a[1])
                      .map(([group, count]) => (
                        <Badge key={group} tone="neutral">
                          {group} · {count}
                        </Badge>
                      ))}
                    {current.length === 0 && <Badge tone="danger">No permissions</Badge>}
                  </div>

                  {hasDrift && (
                    <div className="grid gap-3 border-t border-[var(--c-border-subtle)] pt-2.5 sm:grid-cols-2">
                      {added.length > 0 && (
                        <div>
                          <span className="label mb-1 block text-[var(--c-warning)]">
                            Added beyond shipped ({added.length})
                          </span>
                          <p className="mono text-2xs leading-4 text-[var(--c-text-secondary)]">{added.join(", ")}</p>
                        </div>
                      )}
                      {removed.length > 0 && (
                        <div>
                          <span className="label mb-1 block text-[var(--c-warning)]">
                            Removed from shipped ({removed.length})
                          </span>
                          <p className="mono text-2xs leading-4 text-[var(--c-text-secondary)]">{removed.join(", ")}</p>
                        </div>
                      )}
                    </div>
                  )}

                  <details className="border-t border-[var(--c-border-subtle)] pt-2.5">
                    <summary className="cursor-pointer text-2xs text-[var(--c-text-secondary)]">
                      Show all {current.length} permissions
                    </summary>
                    <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                      {role.permissions
                        .slice()
                        .sort((a, b) => a.permission.group.localeCompare(b.permission.group))
                        .map((p) => (
                          <span key={p.permission.code} className="text-2xs">
                            <span className="text-[var(--c-text-tertiary)]">{p.permission.group}</span>{" "}
                            {p.permission.name}
                          </span>
                        ))}
                    </div>
                  </details>
                </div>
              </SectionCard>
            );
          })}
        </div>
      )}

      <SectionCard
        title="Permission catalogue"
        description="Every permission the system checks, grouped by area. The name is what the permission actually allows."
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap max-h-[28rem] overflow-y-auto">
          <table className="dt">
            <thead>
              <tr>
                <th>Group</th>
                <th>Permission</th>
                <th>Code</th>
                <th className="text-right">Roles holding it</th>
              </tr>
            </thead>
            <tbody>
              {allPermissions.map((p) => {
                const holders = roles.filter((r) => r.permissions.some((rp) => rp.permission.code === p.code));
                return (
                  <tr key={p.id}>
                    <td className="text-2xs text-[var(--c-text-tertiary)]">{p.group}</td>
                    <td className="text-xs">
                      {p.name}
                      {PERMISSION_META[p.code]?.name && PERMISSION_META[p.code].name !== p.name && (
                        <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                          {PERMISSION_META[p.code].name}
                        </span>
                      )}
                    </td>
                    <td>
                      <Mono>{p.code}</Mono>
                    </td>
                    <td className="num text-xs">
                      {holders.length === 0 ? <Badge tone="danger">None</Badge> : holders.length}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
