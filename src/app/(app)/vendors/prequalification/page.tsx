import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { scoreBand } from "@/server/vendors";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  EmptyState,
  InlineAlert,
  Meter,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, percent, round2 } from "@/lib/format";
import { EvaluateVendorForm, VendorDecisionForm } from "../VendorStageForms";

export const metadata = { title: "Vendor pre-qualification" };
export const dynamic = "force-dynamic";

/**
 * The pre-qualification queue: everything that is registered but not yet usable,
 * plus what has been scored and is waiting on an approval decision.
 */
export default async function PrequalificationPage() {
  const { user, authorized } = await pageContext(P.VENDOR_VIEW);
  if (!authorized) {
    return <AccessDenied title="Pre-qualification" message="You do not have permission to view vendor pre-qualification." />;
  }

  const [vendors, criteria, passMark, configuredMax, entities] = await Promise.all([
    prisma.vendor.findMany({
      where: { status: { in: ["PROSPECT", "UNDER_EVALUATION", "PENDING_APPROVAL"] } },
      orderBy: { createdAt: "asc" },
      include: {
        entityLinks: { include: { entity: { select: { id: true, code: true, name: true } } } },
        evaluations: {
          orderBy: { evaluatedAt: "desc" },
          take: 1,
          include: { evaluator: { select: { name: true } } },
        },
        documents: { select: { id: true, docType: true, verified: true } },
      },
    }),
    prisma.evaluationCriterion.findMany({
      where: { active: true },
      orderBy: [{ group: "asc" }, { sequence: "asc" }],
    }),
    getConfigNumber(CONFIG_KEYS.VENDOR_MIN_SCORE, null),
    getConfigNumber(CONFIG_KEYS.VENDOR_MAX_SCORE, null),
    prisma.entity.findMany({
      where: { active: true, id: { in: user.entityIds } },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);

  const canEvaluate = userHasPermission(user, P.VENDOR_EVALUATE);
  const canApprove = userHasPermission(user, P.VENDOR_APPROVE);

  const unscored = vendors.filter((v) => v.evaluations.length === 0);
  const scored = vendors.filter((v) => v.evaluations.length > 0);
  const passing = scored.filter((v) => v.evaluations[0].passed);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Vendors", href: "/vendors" }, { label: "Pre-qualification" }]} />

      <PageHeader
        eyebrow="Vendors"
        title="Pre-qualification queue"
        subtitle={`Scored against ${criteria.length} weighted criteria and scaled to ${configuredMax}. A vendor needs ${passMark} to pass — and an explicit approval decision on top of that.`}
        actions={
          userHasPermission(user, P.VENDOR_CREATE) && (
            <Link href="/vendors/new" className="btn btn-primary btn-sm">
              Register vendor
            </Link>
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="In the queue" value={vendors.length} />
        <StatTile label="Not yet scored" value={unscored.length} tone={unscored.length ? "warning" : "default"} />
        <StatTile label="Scored" value={scored.length} />
        <StatTile label="Passing, awaiting approval" value={passing.length} tone={passing.length ? "accent" : "default"} />
      </div>

      <InlineAlert tone="info">
        Scoring and approval are deliberately separate. A passing score is evidence; approval is a decision someone owns
        and signs for. Nothing in sourcing will accept a vendor until both exist.
      </InlineAlert>

      {vendors.length === 0 ? (
        <EmptyState
          title="Nothing awaiting pre-qualification"
          description="Every registered vendor has been scored and decided. New registrations appear here automatically."
        />
      ) : (
        <div className="space-y-4">
          {vendors.map((v) => {
            const ev = v.evaluations[0];
            const band = scoreBand(ev ? ev.percentage : null);
            const waiting = ageDays(v.createdAt) ?? 0;
            return (
              <SectionCard
                key={v.id}
                title={v.name}
                description={
                  <span className="flex flex-wrap items-center gap-2">
                    <Mono>{v.code}</Mono>
                    <span>·</span>
                    <span>{humanize(v.businessType)}</span>
                    {v.city && (
                      <>
                        <span>·</span>
                        <span>{v.city}</span>
                      </>
                    )}
                    <span>·</span>
                    <span>registered {fmtDate(v.createdAt)}</span>
                    {waiting > 14 && <Badge tone="warning">{waiting} days in the queue</Badge>}
                  </span>
                }
                actions={
                  <>
                    <StatusBadge status={v.status} />
                    {canEvaluate && (
                      <EvaluateVendorForm
                        vendorId={v.id}
                        vendorName={v.name}
                        criteria={criteria}
                        passMark={passMark}
                        configuredMax={configuredMax}
                        label={ev ? "Re-score" : "Score"}
                        evaluationType={ev ? "RE_EVALUATION" : "PRE_QUALIFICATION"}
                      />
                    )}
                    {canApprove && (
                      <VendorDecisionForm
                        vendorId={v.id}
                        vendorName={v.name}
                        entities={v.entityLinks.length ? v.entityLinks.map((l) => l.entity) : entities}
                        currentEntityIds={v.entityLinks.map((l) => l.entityId)}
                        hasEvaluation={!!ev}
                        latestPassed={!!ev?.passed}
                      />
                    )}
                    <Link href={`/vendors/${v.id}`} className="btn btn-secondary btn-sm">
                      Open
                    </Link>
                  </>
                }
              >
                <div className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <span className="label mb-1 block">Score on file</span>
                    {ev ? (
                      <>
                        <span className="tnum text-[1rem] font-600">
                          {round2(ev.totalScore)} / {round2(ev.maxScore)}
                        </span>
                        <div className="mt-1.5">
                          <Meter
                            value={ev.percentage}
                            max={100}
                            tone={band.tone === "neutral" ? "info" : band.tone}
                            label={`${percent(ev.percentage, 0)} · pass mark ${passMark}`}
                          />
                        </div>
                        <span className="mt-1 block text-2xs text-[var(--c-text-tertiary)]">
                          {ev.evaluator.name} · {fmtDate(ev.evaluatedAt)}
                        </span>
                      </>
                    ) : (
                      <p className="text-xs text-muted">
                        No evaluation recorded. Approval will be refused until one exists.
                      </p>
                    )}
                  </div>
                  <div>
                    <span className="label mb-1 block">Outcome</span>
                    {ev ? (
                      <Badge tone={ev.passed ? "success" : "danger"}>
                        {ev.passed ? `At or above ${passMark}` : `Below ${passMark}`}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">Unscored</Badge>
                    )}
                    {ev?.recommendation && (
                      <p className="mt-1.5 text-2xs leading-4 text-muted">{ev.recommendation}</p>
                    )}
                  </div>
                  <div>
                    <span className="label mb-1 block">Documents</span>
                    {v.documents.length === 0 ? (
                      <p className="text-xs text-muted">None on file.</p>
                    ) : (
                      <ul className="space-y-1">
                        {v.documents.slice(0, 5).map((d) => (
                          <li key={d.id} className="flex items-center justify-between gap-2 text-2xs">
                            <span>{humanize(d.docType)}</span>
                            <Badge tone={d.verified ? "success" : "warning"}>
                              {d.verified ? "Verified" : "Unverified"}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </SectionCard>
            );
          })}
        </div>
      )}

      <SectionCard title="Criteria in force" description="The scoring sheet every evaluator uses. Maintained in administration." bodyClassName="px-0 py-0">
        <div className="table-wrap max-h-[24rem] overflow-y-auto">
          <table className="dt">
            <thead>
              <tr>
                <th>Group</th>
                <th>Criterion</th>
                <th className="text-right">Max</th>
                <th className="text-right">Weight</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {criteria.map((c) => (
                <tr key={c.id}>
                  <td className="text-2xs text-[var(--c-text-tertiary)]">{c.group}</td>
                  <td className="text-xs font-500">{c.name}</td>
                  <td className="num text-xs">{c.maxScore}</td>
                  <td className="num text-xs">{c.weight}</td>
                  <td className="text-2xs text-muted">{c.description ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-separator px-4 py-2.5 text-2xs text-[var(--c-text-tertiary)]">
          <RefLink href="/admin/evaluation-criteria">Maintain criteria</RefLink>
        </div>
      </SectionCard>
    </div>
  );
}
