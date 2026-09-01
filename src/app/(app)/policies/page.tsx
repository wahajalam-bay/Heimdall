import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  InlineAlert,
  Meter,
  Mono,
  PageHeader,
  SectionCard,
  StatTile,
} from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/forms";
import { fmtDate } from "@/lib/format";
import { acknowledgementStanding } from "@/server/policy-acknowledgement";
import { PublishPolicyForm } from "./PublishPolicyForm";
import { acknowledgePolicyAction } from "./actions";

export const metadata = { title: "Policies" };
export const dynamic = "force-dynamic";

/**
 * Policy acknowledgement, tied to the exact version.
 *
 * The qualifier is the whole point. An acknowledgement of "the procurement
 * policy" says nothing the moment the policy changes — everybody's signature
 * silently becomes a signature on a document they never read, and the register
 * looks complete while meaning nothing.
 */
export default async function PoliciesPage() {
  const { ctx, authorized } = await pageContext(P.DOCUMENT_VIEW, P.PR_VIEW);
  if (!authorized) return <AccessDenied title="Policies" />;

  const canPublish = userHasPermission(ctx.user, P.CONFIG_MANAGE, P.ROLE_MANAGE);

  const [standing, roles] = await Promise.all([
    acknowledgementStanding(ctx.user.id, ctx.entityId),
    prisma.role.findMany({ select: { code: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const mineOutstanding = standing.filter(
    (s) => !s.mine && s.outstanding.some((o) => o.id === ctx.user.id),
  );
  const fullySigned = standing.filter((s) => s.required > 0 && s.acknowledged === s.required);
  const totalOutstanding = standing.reduce((a, s) => a + s.outstanding.length, 0);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Governance" }, { label: "Policies" }]} />

      <PageHeader
        eyebrow="Governance"
        title="Policies and acknowledgements"
        subtitle="What somebody signs is a code plus a version. Publishing a new version does not carry earlier acknowledgements forward — the register goes back to zero for that policy, which is uncomfortable and correct."
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="Live policies" value={standing.length} />
        <StatTile
          label="Waiting on you"
          value={mineOutstanding.length}
          hint={mineOutstanding.length ? "Read and acknowledge" : "Nothing outstanding"}
          tone={mineOutstanding.length ? "warning" : undefined}
        />
        <StatTile label="Fully acknowledged" value={fullySigned.length} />
        <StatTile
          label="Signatures outstanding"
          value={totalOutstanding}
          hint={totalOutstanding ? "Across everybody" : "None"}
          tone={totalOutstanding ? "warning" : undefined}
        />
      </div>

      {mineOutstanding.length > 0 && (
        <InlineAlert tone="warning">
          {mineOutstanding.length} polic{mineOutstanding.length === 1 ? "y is" : "ies are"} waiting on your
          acknowledgement: {mineOutstanding.map((s) => `${s.title} v${s.version}`).join(", ")}.
        </InlineAlert>
      )}

      {standing.length === 0 && (
        <InlineAlert tone="info">
          No policy versions published. Until one is, nothing records that anybody has read the procurement policy —
          and an acknowledgement register that does not exist is indistinguishable from one where nobody signed.
        </InlineAlert>
      )}

      {standing.map((s) => {
        const isMine = s.outstanding.some((o) => o.id === ctx.user.id);
        return (
          <SectionCard
            key={s.policyId}
            title={`${s.title} — version ${s.version}`}
            description={`${s.code} · effective ${fmtDate(s.effectiveFrom)} · ${
              s.requiredRoleCodes.length
                ? `required of ${s.requiredRoleCodes.map((r) => r.replace(/_/g, " ").toLowerCase()).join(", ")}`
                : "required of everybody"
            }`}
            actions={
              isMine ? (
                <ActionButton
                  action={acknowledgePolicyAction}
                  payload={{ policyId: s.policyId }}
                  label="I have read and understood this"
                  tone="primary"
                  confirm={`Acknowledge ${s.title} version ${s.version}? Your name, the office you hold now, and the time are recorded against this exact version.`}
                />
              ) : s.mine ? (
                <Badge tone="success">You have acknowledged this version</Badge>
              ) : undefined
            }
          >
            <div className="space-y-3">
              <Meter
                value={s.acknowledged}
                max={Math.max(1, s.required)}
                label={`${s.acknowledged} of ${s.required} required acknowledgements`}
                tone={s.acknowledged >= s.required ? "success" : "warning"}
              />

              {s.outstanding.length > 0 && (
                <div>
                  <p className="mb-1 text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
                    Still to acknowledge
                  </p>
                  <p className="text-2xs leading-5 text-muted">
                    {s.outstanding
                      .slice(0, 25)
                      .map((o) => o.name)
                      .join(", ")}
                    {s.outstanding.length > 25 && ` and ${s.outstanding.length - 25} more`}
                  </p>
                </div>
              )}
            </div>
          </SectionCard>
        );
      })}

      {canPublish && (
        <SectionCard
          title="Publish a version"
          description="A new version supersedes the last and starts its register empty. Earlier acknowledgements are kept as what they were — what somebody signed in March is still what they signed, and carrying it forward to April's text would be forging it."
        >
          <PublishPolicyForm
            roles={roles.map((r) => ({ code: r.code, name: r.name }))}
            entityId={ctx.entityId}
          />
        </SectionCard>
      )}

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        An acknowledgement records the person, the office they held at that moment, and the time — captured rather
        than joined, because an acknowledgement is a statement by somebody in a role on a day. Nobody can enter one on
        anybody else&rsquo;s behalf: an administrator asserting that a person read something is the one thing this
        register exists to prevent.
      </p>
    </div>
  );
}
