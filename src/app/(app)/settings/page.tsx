import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PageHeader, SectionCard, DefList, Badge, StatTile } from "@/components/ui/primitives";
import { PERMISSION_META } from "@/lib/permissions";
import { fmtDateTime } from "@/lib/format";
import { NotificationPreferencesForm } from "./PreferencesForm";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { user, ctx } = await pageContext();

  const [me, sessions, notificationCounts] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { notifyInApp: true, notifyEmail: true, notifyDigest: true, createdAt: true },
    }),
    prisma.session.findMany({
      where: { userId: user.id, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: { id: true, ip: true, userAgent: true, createdAt: true, expiresAt: true },
    }),
    prisma.notification.groupBy({
      by: ["type"],
      where: { userId: user.id },
      _count: { _all: true },
    }),
  ]);

  // Group the caller's effective permissions so they can see exactly what they hold.
  const grouped = new Map<string, string[]>();
  for (const code of user.permissions) {
    const meta = PERMISSION_META[code];
    const group = meta?.group ?? "Other";
    const arr = grouped.get(group) ?? [];
    arr.push(meta?.name ?? code);
    grouped.set(group, arr);
  }

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Account"
        title="Settings"
        subtitle="Your profile, notification preferences and the exact access your roles grant you."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Roles held" value={user.roleNames.length} hint={user.roleNames.join(", ") || "—"} />
        <StatTile label="Permissions" value={user.permissions.length} hint="Effective, across all your roles" />
        <StatTile label="Entities" value={user.entityIds.length} hint={ctx.entities.map((e) => e.code).join(", ")} />
        <StatTile label="Active sessions" value={sessions.length} hint="Signed-in devices" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <SectionCard title="Profile" description="Managed by your system administrator.">
          <DefList
            columns={1}
            items={[
              { label: "Name", value: user.name },
              { label: "Email", value: user.email },
              { label: "Title", value: user.title ?? "—" },
              { label: "Primary entity", value: user.primaryEntityName ? `${user.primaryEntityCode} — ${user.primaryEntityName}` : "—" },
              { label: "Department", value: user.primaryDepartmentName ?? "—" },
              { label: "Account created", value: fmtDateTime(me.createdAt) },
              {
                label: "Roles",
                value: (
                  <span className="flex flex-wrap gap-1">
                    {user.roleNames.map((r) => (
                      <Badge key={r} tone="accent">
                        {r}
                      </Badge>
                    ))}
                  </span>
                ),
              },
            ]}
          />
        </SectionCard>

        <NotificationPreferencesForm
          initial={{ notifyInApp: me.notifyInApp, notifyEmail: me.notifyEmail, notifyDigest: me.notifyDigest }}
          counts={notificationCounts.map((c) => ({ type: c.type, count: c._count._all }))}
        />
      </div>

      <SectionCard
        title="My access"
        description="The effective permissions granted by your roles. Access is enforced server-side on every request."
      >
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...grouped.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([group, perms]) => (
              <div key={group}>
                <h4 className="label mb-1.5">{group}</h4>
                <ul className="space-y-0.5">
                  {perms.sort().map((p) => (
                    <li key={p} className="flex items-start gap-1.5 text-xs leading-5 text-muted">
                      <span className="mt-1.5 size-1 shrink-0 rounded-full bg-[var(--c-success)]" aria-hidden />
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      </SectionCard>

      <SectionCard
        title="Active sessions"
        description="Sessions expire automatically. Signing out ends the current session immediately."
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Signed in</th>
                <th>Expires</th>
                <th>IP address</th>
                <th style={{ minWidth: "22rem" }}>Device</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="text-xs">{fmtDateTime(s.createdAt)}</td>
                  <td className="text-xs">{fmtDateTime(s.expiresAt)}</td>
                  <td className="mono text-2xs">{s.ip ?? "—"}</td>
                  <td className="max-w-[28rem] truncate text-2xs text-muted" title={s.userAgent ?? ""}>
                    {s.userAgent ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

