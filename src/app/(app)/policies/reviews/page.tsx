import Link from "next/link";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { Badge, InlineAlert, PageHeader, SectionCard, StatTile } from "@/components/ui/primitives";
import { fmtDate } from "@/lib/format";
import { REVIEW_KIND_LABELS, orientationGap, reviewStanding, type ReviewKind } from "@/server/policy-review";
import { RecordReviewForm } from "./RecordReviewForm";

export const metadata = { title: "Policy reviews" };
export const dynamic = "force-dynamic";

/**
 * AS-014 — where each manager's review obligations stand.
 *
 * Three duties, one register, and the page is built around what is *outstanding*
 * rather than what has been done, because a compliance register that leads with
 * its successes is one nobody uses to find the gap.
 */
export default async function PolicyReviewsPage() {
  const { ctx, authorized } = await pageContext(P.CONFIG_MANAGE, P.AUDIT_VIEW, P.DISPOSAL_VIEW);
  if (!authorized) return <AccessDenied title="Policy reviews" />;

  const canRecord = userHasPermission(
    ctx.user,
    P.CONFIG_MANAGE,
    P.ROLE_MANAGE,
    P.DISPOSAL_APPROVE,
    P.AUDIT_VIEW,
  );
  const entityIds = visibleEntityIds(ctx.user);
  const standing = await reviewStanding({ entityIds });

  const flat = standing.flatMap((s) =>
    s.departments.map((d) => ({ policy: s.policy, ...d })),
  );
  const outstanding = flat.filter((r) => r.outstanding.length > 0);
  const complete = flat.filter((r) => r.outstanding.length === 0);

  // Only worth computing for the policies that have a live register.
  const gaps = standing.length
    ? await orientationGap(standing[0].policy.id, { entityIds })
    : [];

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Policies", href: "/policies" }, { label: "Reviews" }]} />

      <PageHeader
        eyebrow="Policies"
        title="Manager reviews"
        subtitle="Three duties the Scrap Material Policy puts on business unit managers, and they are three different acts: reviewing the policy with the team, covering it in orientation, and reviewing how disposal is actually being done."
        actions={
          <Link className="btn btn-secondary btn-sm" href="/policies">
            Acknowledgements
          </Link>
        }
      />

      <InlineAlert tone="info">
        This is not the acknowledgement register. A team where everybody has ticked &ldquo;read&rdquo; and nobody has
        ever discussed the document satisfies that one and not this — which is exactly the distinction the clause draws
        by asking for a review <span className="italic">with employees</span> and documentation that it happened.
      </InlineAlert>

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="Policies in the register" value={standing.length} />
        <StatTile
          label="Departments with something outstanding"
          value={outstanding.length}
          tone={outstanding.length ? "warning" : "success"}
        />
        <StatTile label="Fully reviewed" value={complete.length} tone={complete.length ? "success" : undefined} />
        <StatTile
          label="Departments with unoriented joiners"
          value={gaps.length}
          hint={gaps.length ? "Measured against people, not dates" : "None"}
          tone={gaps.length ? "warning" : undefined}
        />
      </div>

      {standing.length === 0 && (
        <InlineAlert tone="warning">
          No published policy is in the register, so there is nothing to review against. Publish a policy first.
        </InlineAlert>
      )}

      {gaps.length > 0 && (
        <SectionCard
          title="Joiners who have not been through orientation"
          description="The orientation duty is about people rather than a date, so this counts everyone who arrived after the department last recorded one."
          bodyClassName="px-0 py-0"
        >
          <ul className="row-list">
            {gaps.map((g) => (
              <li key={g.departmentId} className="px-3.5 py-2.5">
                <p className="text-xs font-500">
                  {g.department}
                  <span className="ml-2 text-2xs text-[var(--c-warning)]">{g.joiners.length}</span>
                </p>
                <p className="mt-0.5 text-2xs leading-4 text-muted">
                  {g.joiners.slice(0, 8).join(", ")}
                  {g.joiners.length > 8 ? `, and ${g.joiners.length - 8} more` : ""}
                </p>
                <p className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">
                  {g.since ? `Last orientation recorded ${fmtDate(g.since)}.` : "No orientation has ever been recorded for this department."}
                </p>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {standing.map((s) => (
        <SectionCard
          key={s.policy.id}
          title={`${s.policy.code} v${s.policy.version} — ${s.policy.title}`}
          description="One row per department. A blank column is a duty nobody has discharged for that team against this version."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ minWidth: "12rem" }}>Department</th>
                  <th style={{ minWidth: "13rem" }}>Reviewed with the team</th>
                  <th style={{ minWidth: "11rem" }}>In orientation</th>
                  <th style={{ minWidth: "15rem" }}>Practice reviewed</th>
                </tr>
              </thead>
              <tbody>
                {s.departments.map((d) => (
                  <tr key={d.departmentId}>
                    <td className="text-xs">{d.department}</td>
                    <td className="text-2xs">
                      {d.team ? (
                        <>
                          <Badge tone="success">{fmtDate(d.team.at)}</Badge>
                          <span className="mt-0.5 block text-[var(--c-text-tertiary)]">
                            {d.team.by}
                            {d.team.attendees ? ` · ${d.team.attendees} attended` : ""}
                          </span>
                        </>
                      ) : (
                        <Badge tone="warning">not done</Badge>
                      )}
                    </td>
                    <td className="text-2xs">
                      {d.orientation ? (
                        <>
                          <Badge tone="success">{fmtDate(d.orientation.at)}</Badge>
                          <span className="mt-0.5 block text-[var(--c-text-tertiary)]">
                            {d.orientation.by}
                          </span>
                        </>
                      ) : (
                        <Badge tone="warning">not done</Badge>
                      )}
                    </td>
                    <td className="text-2xs">
                      {d.practice ? (
                        <>
                          <Badge tone="success">{fmtDate(d.practice.at)}</Badge>
                          <span className="mt-0.5 block leading-4 text-muted">
                            {d.practice.findings}
                          </span>
                        </>
                      ) : (
                        <Badge tone="warning">not done</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ))}

      {canRecord && standing.length > 0 && (
        <SectionCard
          title="Record a review"
          description="Each kind asks for what makes it a review rather than a note: a team review needs attendees, a practice review needs findings."
        >
          <RecordReviewForm
            policies={standing.map((s) => ({
              id: s.policy.id,
              label: `${s.policy.code} v${s.policy.version} — ${s.policy.title}`,
            }))}
            departments={standing[0].departments.map((d) => ({
              id: d.departmentId,
              name: d.department,
            }))}
            kinds={(Object.keys(REVIEW_KIND_LABELS) as ReviewKind[]).map((k) => ({
              value: k,
              label: REVIEW_KIND_LABELS[k],
            }))}
          />
        </SectionCard>
      )}
    </div>
  );
}
