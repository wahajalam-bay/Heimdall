import Link from "next/link";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  InlineAlert,
  Mono,
  PageHeader,
  SectionCard,
  StatTile,
} from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/DataTable";
import { accessReview, permissionLabel, separationReport } from "@/server/access-review";
import { RecordReviewForm } from "./RecordReviewForm";

export const metadata = { title: "Access review" };
export const dynamic = "force-dynamic";

/**
 * The quarterly access review, and the standing segregation report.
 *
 * The meeting requirements ask for the review "as a decision record", and the
 * distinction from a report is the whole point: a list of who holds what is a
 * report, and everybody has one. A review is somebody looking at that list and
 * saying it is right.
 */
export default async function AccessReviewPage() {
  const { ctx, authorized } = await pageContext(P.USER_MANAGE, P.ROLE_MANAGE, P.AUDIT_VIEW);
  if (!authorized) return <AccessDenied title="Access review" />;

  const canRecord = userHasPermission(ctx.user, P.USER_MANAGE, P.ROLE_MANAGE, P.AUDIT_VIEW);

  const [review, separations] = await Promise.all([
    accessReview({ entityId: ctx.entityId }),
    separationReport({ entityId: ctx.entityId }),
  ]);

  const flagged = review.rows.filter((r) => r.flags.length > 0);
  const onBothSides = separations.rows.reduce((a, r) => a + r.bothSides.length, 0);
  const breachedConflicts = separations.conflicts.filter((c) => c.holders.length > 0);

  const period = `${new Date().getFullYear()}-Q${Math.floor(new Date().getMonth() / 3) + 1}`;

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[{ label: "Administration", href: "/admin" }, { label: "Access review" }]}
      />

      <PageHeader
        eyebrow="Administration"
        title="Access review"
        subtitle="Who holds what, and whether anybody holds a combination the separations rely on being split. Performing the review records the figures as they stood, so the decision is anchored to what was actually in front of the reviewer."
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile
          label="Active users"
          value={review.totals.active}
          hint={`${review.totals.inactive} inactive`}
        />
        <StatTile
          label="Active with no role"
          value={review.totals.noRole}
          hint={review.totals.noRole ? "Can sign in and do nothing" : "None"}
          tone={review.totals.noRole ? "warning" : undefined}
        />
        <StatTile
          label="Inactive but still hold roles"
          value={review.totals.inactiveWithRoles}
          hint={review.totals.inactiveWithRoles ? "What a leaver's access looks like" : "None"}
          tone={review.totals.inactiveWithRoles ? "danger" : undefined}
        />
        <StatTile
          label="On both sides of a separation"
          value={onBothSides}
          hint={onBothSides ? "Control rests on their restraint" : "None"}
          tone={onBothSides ? "warning" : undefined}
        />
      </div>

      {review.totals.inactiveWithRoles > 0 && (
        <InlineAlert tone="danger">
          {review.totals.inactiveWithRoles} inactive account
          {review.totals.inactiveWithRoles === 1 ? "" : "s"} still carr
          {review.totals.inactiveWithRoles === 1 ? "ies" : "y"} roles. That is exactly what a leaver&rsquo;s access
          looks like when nobody removed it — the account cannot sign in, but the grant is still on the record and
          would come back with the account.
        </InlineAlert>
      )}

      {breachedConflicts.length > 0 && (
        <InlineAlert tone="danger">
          {breachedConflicts.length} prohibited role combination
          {breachedConflicts.length === 1 ? " is" : "s are"} actually held:{" "}
          {breachedConflicts.map((c) => `${c.roles.join(" + ")} (${c.holders.join(", ")})`).join("; ")}.
        </InlineAlert>
      )}

      <SectionCard
        title="Segregation of duties"
        description="The three per-transaction separations are enforced on every document. This shows where one person holds both sides — which is not a breach, but is the point at which the control depends on their restraint rather than on the system."
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ minWidth: "13rem" }}>The separation</th>
                <th style={{ minWidth: "16rem" }}>Where it comes from</th>
                <th style={{ width: "8rem" }} className="text-right">
                  Both sides
                </th>
                <th style={{ minWidth: "16rem" }}>Who</th>
              </tr>
            </thead>
            <tbody>
              {separations.rows.map((r) => (
                <tr key={r.code}>
                  <td className="text-xs">
                    Nobody may {r.action} having {r.counterpart}
                    <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                      {[...r.sidePermissions.acting, ...r.sidePermissions.counterpart]
                        .map(permissionLabel)
                        .join(" / ")}
                    </span>
                  </td>
                  <td className="text-2xs leading-4 text-muted">{r.source}</td>
                  <td className="tnum text-right">
                    {r.bothSides.length ? (
                      <Badge tone="warning">{r.bothSides.length}</Badge>
                    ) : (
                      <span className="text-[var(--c-success)]">0</span>
                    )}
                  </td>
                  <td className="text-2xs leading-4">
                    {r.bothSides.length
                      ? r.bothSides
                          .slice(0, 12)
                          .map((p) => p.name)
                          .join(", ") + (r.bothSides.length > 12 ? ` and ${r.bothSides.length - 12} more` : "")
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {separations.conflicts.length === 0 && (
          <p className="px-3.5 py-2.5 text-2xs text-[var(--c-text-tertiary)]">
            No prohibited role pairs are configured. Neither SOP names one, so the list ships empty rather than being
            populated with a combination nobody chose — see ES-025 in the source matrix.
          </p>
        )}
      </SectionCard>

      {(review.soleHolders.length > 0 || review.unheldRoles.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {review.soleHolders.length > 0 && (
            <SectionCard
              title="Roles with a single holder"
              description="Not wrong, but each is a single point of failure — and where that role owns a control on the calendar, one absence stops it."
              bodyClassName="px-3.5 py-3"
            >
              <ul className="space-y-1 text-xs">
                {review.soleHolders.map((s) => (
                  <li key={s.code} className="flex flex-wrap items-baseline gap-2">
                    <span>{s.name}</span>
                    <span className="text-2xs text-[var(--c-text-tertiary)]">{s.holder}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}
          {review.unheldRoles.length > 0 && (
            <SectionCard
              title="Roles nobody holds"
              description="Either dead weight or a control with no owner. The control calendar shows which."
              bodyClassName="px-3.5 py-3"
              actions={
                <Link className="link text-2xs" href="/analytics/controls">
                  Control calendar
                </Link>
              }
            >
              <p className="text-xs leading-5 text-muted">
                {review.unheldRoles.map((r) => r.name).join(", ")}
              </p>
            </SectionCard>
          )}
        </div>
      )}

      <DataTable
        id="access-review"
        columns={[
          { key: "name", header: "Person", sortable: true },
          { key: "entity", header: "Company", filterable: true, sortable: true, width: "12rem" },
          { key: "roles", header: "Roles", filterable: false, minWidth: "16rem" },
          { key: "acting", header: "Acting roles", sortable: true, align: "right", width: "9rem" },
          { key: "perms", header: "Permissions", sortable: true, align: "right", width: "9rem" },
          { key: "state", header: "State", filterable: true, sortable: true, width: "8rem" },
          { key: "flags", header: "Worth a look", filterable: true, minWidth: "14rem" },
        ]}
        rows={review.rows.map((r) => ({
          id: r.userId,
          search: `${r.name} ${r.email} ${r.roles.join(" ")}`,
          flag: r.flags.length
            ? r.flags.some((f) => f.startsWith("Inactive"))
              ? ("danger" as const)
              : ("warning" as const)
            : null,
          cells: {
            name: (
              <>
                {r.name}
                <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                  {r.title ?? r.email}
                </span>
              </>
            ),
            entity: r.entityName ?? "—",
            roles: r.roles.length ? (
              <span className="text-2xs leading-4">
                {r.roles.map((c) => c.replace(/_/g, " ").toLowerCase()).join(", ")}
              </span>
            ) : (
              <span className="text-2xs text-[var(--c-warning)]">none</span>
            ),
            acting: r.actingRoles.length || "—",
            perms: r.permissionCount || "—",
            state: r.active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>,
            flags: r.flags.length ? (
              <span className="text-2xs leading-4">{r.flags.join(" · ")}</span>
            ) : (
              "—"
            ),
          },
          values: {
            name: r.name,
            entity: r.entityName ?? "",
            roles: r.roles.join(", "),
            acting: r.actingRoles.length,
            perms: r.permissionCount,
            state: r.active ? "Active" : "Inactive",
            flags: r.flags.join(" · "),
          },
        }))}
        emptyState="No users."
      />

      {canRecord && (
        <SectionCard
          title={`Record the review for ${period}`}
          description="This is what makes it a review rather than a report. The figures as they stand are written into the record alongside what you conclude."
        >
          <RecordReviewForm
            period={period}
            entityId={ctx.entityId}
            summary={{
              flagged: flagged.length,
              onBothSides,
              noRole: review.totals.noRole,
              inactiveWithRoles: review.totals.inactiveWithRoles,
            }}
          />
        </SectionCard>
      )}
    </div>
  );
}
