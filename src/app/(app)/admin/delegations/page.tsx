import { prisma } from "@/lib/db";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P, PERMISSION_META } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  InlineAlert,
  PageHeader,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/forms";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { listDelegations } from "@/server/delegation";
import { DelegationForm } from "./DelegationForm";
import { revokeDelegationAction } from "./actions";

export const metadata = { title: "Delegated authority" };
export const dynamic = "force-dynamic";

/**
 * Delegated authority.
 *
 * The alternative to this is giving somebody a role while an approver is away,
 * which is permanent until removed, invisible once removed, and afterwards
 * indistinguishable from that person having always held it. A delegation is
 * dated, scoped, and names both people on every act taken under it.
 */
export default async function DelegationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { ctx, authorized } = await pageContext(P.USER_MANAGE, P.ROLE_MANAGE, P.AUDIT_VIEW);
  if (!authorized) {
    return <AccessDenied title="Delegated authority" />;
  }

  const sp = await searchParams;
  const status = first(sp.status) ?? null;
  const mineOnly = first(sp.scope) === "mine";
  const canAdminister = userHasPermission(ctx.user, P.USER_MANAGE, P.ROLE_MANAGE);

  const [rows, people] = await Promise.all([
    listDelegations({ status, userId: mineOnly ? ctx.user.id : null }),
    prisma.user.findMany({
      where: { active: true },
      select: { id: true, name: true, title: true },
      orderBy: { name: "asc" },
      take: 600,
    }),
  ]);

  const active = rows.filter((r) => r.status === "ACTIVE");
  const pending = rows.filter((r) => r.status === "PENDING");
  const used = rows.filter((r) => r._count.uses > 0);
  const broad = active.filter((r) => r.permissionCodes.length >= 8);

  // What the current user can actually lend. Delegation lends existing
  // authority; it never creates any, so the picker only offers what they hold.
  const ownPermissions = ctx.user.permissions.slice().sort();

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Administration", href: "/admin" }, { label: "Delegations" }]} />

      <PageHeader
        eyebrow="Administration"
        title="Delegated authority"
        subtitle="A dated, scoped grant from one named person to another. Every act taken under it names both — the delegate who acted and the delegator whose authority allowed it."
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="In force" value={active.length} />
        <StatTile label="Starting later" value={pending.length} />
        <StatTile label="Actually used" value={used.length} hint={used.length ? "Acts on record" : "None yet"} />
        <StatTile
          label="Broad in scope"
          value={broad.length}
          hint={broad.length ? "Eight or more permissions" : "None"}
          tone={broad.length ? "warning" : undefined}
        />
      </div>

      {broad.length > 0 && (
        <InlineAlert tone="warning">
          {broad.length} live delegation{broad.length === 1 ? "" : "s"} lend eight or more permissions at once. A wide
          delegation is what makes segregation of duties unenforceable for as long as it lasts — narrow it to what the
          delegate actually has to do.
        </InlineAlert>
      )}

      <div className="card flex flex-row flex-wrap items-end gap-3 px-3.5 py-3">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="min-w-[11rem]">
            <span className="label mb-1 block">Status</span>
            <select className="field" name="status" defaultValue={status ?? ""}>
              <option value="">All</option>
              <option value="ACTIVE">In force</option>
              <option value="PENDING">Starting later</option>
              <option value="EXPIRED">Expired</option>
              <option value="REVOKED">Revoked</option>
            </select>
          </label>
          <label className="min-w-[11rem]">
            <span className="label mb-1 block">Scope</span>
            <select className="field" name="scope" defaultValue={mineOnly ? "mine" : ""}>
              <option value="">Everybody</option>
              <option value="mine">Mine</option>
            </select>
          </label>
          <button type="submit" className="btn btn-secondary btn-sm">
            Show
          </button>
        </form>
      </div>

      <SectionCard
        title="Delegate authority"
        description="You can delegate what you hold. Delegation lends existing authority; it never creates any, so a permission you do not hold is not on the list."
      >
        <DelegationForm
          people={people
            .filter((p) => p.id !== ctx.user.id)
            .map((p) => ({ id: p.id, label: `${p.name}${p.title ? ` — ${p.title}` : ""}` }))}
          delegators={
            canAdminister
              ? people.map((p) => ({ id: p.id, label: `${p.name}${p.title ? ` — ${p.title}` : ""}` }))
              : []
          }
          selfId={ctx.user.id}
          selfName={ctx.user.name}
          permissions={ownPermissions.map((c) => ({
            code: c,
            label: PERMISSION_META[c]?.name ?? c,
            group: PERMISSION_META[c]?.group ?? "Other",
          }))}
        />
      </SectionCard>

      <SectionCard title="Delegations on record" bodyClassName="px-0 py-0">
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ minWidth: "13rem" }}>Whose authority</th>
                <th style={{ minWidth: "13rem" }}>Used by</th>
                <th style={{ minWidth: "14rem" }}>What</th>
                <th style={{ width: "11rem" }}>Period</th>
                <th style={{ width: "9rem" }}>Status</th>
                <th style={{ width: "7rem" }} className="text-right">
                  Used
                </th>
                <th style={{ minWidth: "13rem" }}>Why</th>
                <th style={{ width: "8rem" }} className="no-print" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-[var(--c-text-tertiary)]">
                    No delegations recorded. Until one is, the only way to cover an absent approver is to give
                    somebody their role — which is permanent until removed and invisible afterwards.
                  </td>
                </tr>
              )}
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>
                    {d.delegator.name}
                    {d.delegator.title && (
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        {d.delegator.title}
                      </span>
                    )}
                  </td>
                  <td>
                    {d.delegate.name}
                    {d.recordedBy && d.recordedById !== d.delegatorId && (
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        recorded by {d.recordedBy.name}
                      </span>
                    )}
                  </td>
                  <td className="text-2xs leading-4">
                    {d.permissionCodes
                      .slice(0, 4)
                      .map((c) => PERMISSION_META[c]?.name ?? c)
                      .join(", ")}
                    {d.permissionCodes.length > 4 && ` and ${d.permissionCodes.length - 4} more`}
                    {d.documentTypeList.length > 0 && (
                      <span className="mt-0.5 block text-[var(--c-text-tertiary)]">
                        only {d.documentTypeList.join(", ")}
                      </span>
                    )}
                    {d.valueLimit != null && (
                      <span className="mt-0.5 block text-[var(--c-text-tertiary)]">
                        up to {money(d.valueLimit)}
                      </span>
                    )}
                  </td>
                  <td className="text-2xs">
                    {fmtDate(d.validFrom)} – {fmtDate(d.validTo)}
                  </td>
                  <td>
                    <StatusBadge status={d.status} />
                    {d.revokedAt && (
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        {fmtDateTime(d.revokedAt)}
                      </span>
                    )}
                  </td>
                  <td className="tnum text-right">
                    {d._count.uses ? <Badge tone="info">{d._count.uses}</Badge> : "—"}
                  </td>
                  <td className="text-2xs leading-4 text-muted">
                    {d.reason}
                    {d.revokeReason && (
                      <span className="mt-0.5 block text-[var(--c-text-tertiary)]">
                        Revoked: {d.revokeReason}
                      </span>
                    )}
                  </td>
                  <td className="no-print">
                    {["ACTIVE", "PENDING"].includes(d.status) &&
                      (d.delegatorId === ctx.user.id || canAdminister) && (
                        <ActionButton
                          action={revokeDelegationAction}
                          payload={{ delegationId: d.id }}
                          label="Revoke"
                          tone="danger-soft"
                          size="xs"
                          reasonLabel="Why the delegation is being revoked"
                          reasonRequired
                        />
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        A delegation does not widen anybody&rsquo;s session silently. The delegated set is kept separate from the
        person&rsquo;s own permissions, so a caller has to decide to use it and the use is recorded — which is the
        whole difference between this and a temporary role grant.
      </p>
    </div>
  );
}
