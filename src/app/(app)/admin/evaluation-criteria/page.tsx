import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
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
import { RankedBars } from "@/components/ui/charts";
import { percent, round2 } from "@/lib/format";
import { CriterionForm } from "../AdminMasterForms";

export const metadata = { title: "Evaluation criteria" };
export const dynamic = "force-dynamic";

export default async function AdminCriteriaPage() {
  const { authorized } = await pageContext(P.MASTER_DATA_MANAGE);
  if (!authorized) {
    return <AccessDenied title="Evaluation criteria" message="You do not have permission to manage evaluation criteria." />;
  }

  const [criteria, passMark, configuredMax, usage] = await Promise.all([
    prisma.evaluationCriterion.findMany({
      orderBy: [{ group: "asc" }, { sequence: "asc" }],
      include: { _count: { select: { scores: true } } },
    }),
    getConfigNumber(CONFIG_KEYS.VENDOR_MIN_SCORE, null),
    getConfigNumber(CONFIG_KEYS.VENDOR_MAX_SCORE, null),
    prisma.vendorScore.groupBy({ by: ["criterionId"], _avg: { score: true }, _count: { _all: true } }),
  ]);

  const avgByCriterion = new Map(usage.map((u) => [u.criterionId, { avg: u._avg.score ?? 0, count: u._count._all }]));

  const activeCriteria = criteria.filter((c) => c.active);
  const rawMax = round2(activeCriteria.reduce((a, c) => a + c.maxScore * c.weight, 0));
  const groups = [...new Set(criteria.map((c) => c.group))];

  const byGroup = groups.map((g) => {
    const list = activeCriteria.filter((c) => c.group === g);
    return {
      group: g,
      criteria: list,
      weightedMax: round2(list.reduce((a, c) => a + c.maxScore * c.weight, 0)),
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Administration", href: "/admin" }, { label: "Evaluation criteria" }]} />

      <PageHeader
        eyebrow="Administration"
        title="Evaluation criteria"
        subtitle={`The scoring sheet behind every vendor pre-qualification. Raw weighted scores are scaled to ${configuredMax}, and a vendor needs ${passMark} to pass.`}
        actions={
          <>
            <Link href="/vendors/prequalification" className="btn btn-secondary btn-sm">
              Pre-qualification queue
            </Link>
            <CriterionForm groups={groups.length ? groups : ["General"]} />
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Criteria" value={criteria.length} hint={`${activeCriteria.length} active`} />
        <StatTile label="Groups" value={groups.length} />
        <StatTile label="Raw weighted maximum" value={rawMax} hint={`Scaled to ${configuredMax} on every evaluation`} />
        <StatTile label="Pass mark" value={`${passMark} of ${configuredMax}`} hint="Configurable per entity" />
      </div>

      <InlineAlert tone="info">
        Weight multiplies the raw score; the weighted total is then scaled to the configured maximum so the pass mark
        stays meaningful even when criteria are added or removed. Existing evaluations keep the sheet they were scored
        against.
      </InlineAlert>

      {criteria.length === 0 ? (
        <EmptyState
          title="No criteria defined"
          description="Vendors cannot be pre-qualified until there is something to score them against."
          action={<CriterionForm groups={["General"]} />}
        />
      ) : (
        <>
          <SectionCard title="Weight by group" description="Where the scoring sheet actually puts its emphasis.">
            <RankedBars
              data={byGroup
                .map((g) => ({
                  label: g.group,
                  value: g.weightedMax,
                  sub: `${g.criteria.length} criteria · ${percent(rawMax > 0 ? (g.weightedMax / rawMax) * 100 : 0, 0)} of total`,
                }))
                .sort((a, b) => b.value - a.value)}
              format="decimal"
              maxRows={10}
            />
          </SectionCard>

          {byGroup.map((g) => (
            <SectionCard
              key={g.group}
              title={g.group}
              description={`${g.criteria.length} criteria · weighted maximum ${g.weightedMax} (${percent(rawMax > 0 ? (g.weightedMax / rawMax) * 100 : 0, 0)} of the sheet)`}
              bodyClassName="px-0 py-0"
            >
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th style={{ width: "3.5rem" }}>Seq</th>
                      <th style={{ width: "10rem" }}>Code</th>
                      <th style={{ minWidth: "16rem" }}>Criterion</th>
                      <th style={{ minWidth: "22rem" }}>What it means</th>
                      <th className="text-right" style={{ width: "6.5rem" }}>Max</th>
                      <th className="text-right" style={{ width: "6.5rem" }}>Weight</th>
                      <th className="text-right" style={{ width: "8rem" }}>Weighted</th>
                      <th className="text-right" style={{ width: "9rem" }}>Average scored</th>
                      <th className="text-right" style={{ width: "8rem" }}>Times used</th>
                      <th style={{ width: "6rem" }} />
                    </tr>
                  </thead>
                  <tbody>
                    {g.criteria.map((c) => {
                      const u = avgByCriterion.get(c.id);
                      const avgPercent = u && c.maxScore > 0 ? round2((u.avg / c.maxScore) * 100) : null;
                      return (
                        <tr key={c.id}>
                          <td className="num text-xs text-[var(--c-text-tertiary)]">{c.sequence}</td>
                          <td>
                            <Mono>{c.code}</Mono>
                          </td>
                          <td className="text-xs font-500">{c.name}</td>
                          <td className="text-2xs text-muted">{c.description ?? "—"}</td>
                          <td className="num text-xs">{c.maxScore}</td>
                          <td className="num text-xs">{c.weight}</td>
                          <td className="num text-xs">{round2(c.maxScore * c.weight)}</td>
                          <td className="num text-xs">
                            {u ? (
                              <span
                                className={
                                  avgPercent !== null && avgPercent < 50 ? "text-[var(--c-warning)] font-600" : undefined
                                }
                              >
                                {round2(u.avg)} ({percent(avgPercent ?? 0, 0)})
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="num text-xs">{u?.count ?? 0}</td>
                          <td>
                            <CriterionForm
                              groups={groups}
                              initial={{
                                id: c.id,
                                code: c.code,
                                name: c.name,
                                description: c.description,
                                maxScore: c.maxScore,
                                weight: c.weight,
                                group: c.group,
                                sequence: c.sequence,
                                active: c.active,
                              }}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          ))}

          {criteria.some((c) => !c.active) && (
            <SectionCard
              title="Retired criteria"
              description="No longer scored on new evaluations, but kept so historic scores still make sense."
              bodyClassName="px-0 py-0"
            >
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Criterion</th>
                      <th>Group</th>
                      <th className="text-right">Times used</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {criteria
                      .filter((c) => !c.active)
                      .map((c) => (
                        <tr key={c.id}>
                          <td>
                            <Mono>{c.code}</Mono>
                          </td>
                          <td className="text-xs">{c.name}</td>
                          <td className="text-2xs">{c.group}</td>
                          <td className="num text-xs">{c._count.scores}</td>
                          <td>
                            <span className="flex items-center gap-2">
                              <Badge tone="neutral">Retired</Badge>
                              <CriterionForm
                                groups={groups}
                                initial={{
                                  id: c.id,
                                  code: c.code,
                                  name: c.name,
                                  description: c.description,
                                  maxScore: c.maxScore,
                                  weight: c.weight,
                                  group: c.group,
                                  sequence: c.sequence,
                                  active: c.active,
                                }}
                              />
                            </span>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}
        </>
      )}
    </div>
  );
}
