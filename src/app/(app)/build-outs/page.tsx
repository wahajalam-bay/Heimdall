import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { Badge, InlineAlert, Mono, PageHeader, StatTile } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/DataTable";
import { fmtDate, money, percent, round2 } from "@/lib/format";
import { BUILD_OUT_STATE_LABELS, type BuildOutState } from "@/server/buildout";
import { CHECKLIST_COUNT } from "@/server/buildout-checklist";

export const metadata = { title: "Build-outs" };
export const dynamic = "force-dynamic";

/**
 * Build-outs.
 *
 * The SOP's objective for this section is coordination — "avoiding duplication",
 * "synergy", "timely decisions" — across ten departments. So the list is built
 * around the two things that tell you whether that is happening: how much of the
 * departmental checklist is done, and whether the standing Friday review has
 * actually been held recently.
 */
export default async function BuildOutsPage() {
  const { ctx, authorized } = await pageContext(P.BUILD_OUT_VIEW);
  if (!authorized) return <AccessDenied title="Build-outs" />;

  const canCreate = userHasPermission(ctx.user, P.BUILD_OUT_CREATE);
  const entityIds = visibleEntityIds(ctx.user);

  const rows = await prisma.buildOut.findMany({
    where: entityIds ? { entityId: { in: entityIds } } : {},
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: {
      entity: { select: { code: true } },
      tasks: { select: { status: true } },
      meetings: {
        where: { status: "HELD" },
        orderBy: { heldAt: "desc" },
        take: 1,
        select: { heldAt: true, number: true },
      },
      boqLines: { select: { budgetTotal: true, actualTotal: true } },
      lessons: { select: { id: true } },
    },
  });

  const live = rows.filter((r) => !["CLOSED", "CANCELLED"].includes(r.status));
  const awaitingGoAhead = rows.filter((r) => r.status === "DRAFT" || r.status === "PENDING_MANAGEMENT");
  const staleReview = live.filter((r) => {
    if (r.status !== "IN_EXECUTION") return false;
    const last = r.meetings[0]?.heldAt;
    // A build-out in execution with no review inside a fortnight has lost the
    // weekly cadence BO-009 is built on.
    return !last || Date.now() - last.getTime() > 14 * 86_400_000;
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Build-outs" }]} />

      <PageHeader
        eyebrow="Build-outs"
        title="Build-outs"
        subtitle="Ten departments, one set of deadlines. Management gives the go-ahead, Admin gathers requirements, the Cross Functional Committee hands out the checklist, and progress is reviewed every Friday until the project closes with its variance and its lessons."
        actions={
          canCreate ? (
            <Link className="btn btn-primary btn-sm" href="/build-outs/new">
              Raise a build-out
            </Link>
          ) : null
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="In flight" value={live.length} hint={`${rows.length} in total`} />
        <StatTile
          label="Awaiting management"
          value={awaitingGoAhead.length}
          hint={awaitingGoAhead.length ? "BO-002 puts this first" : "None"}
          tone={awaitingGoAhead.length ? "warning" : undefined}
        />
        <StatTile
          label="Weekly review overdue"
          value={staleReview.length}
          hint={staleReview.length ? "No CFC meeting in a fortnight" : "Cadence holding"}
          tone={staleReview.length ? "danger" : undefined}
        />
        <StatTile label="Checklist size" value={CHECKLIST_COUNT} hint="Responsibilities per project" />
      </div>

      {staleReview.length > 0 && (
        <InlineAlert tone="warning">
          {staleReview.length} build-out{staleReview.length === 1 ? " has" : "s have"} gone more than a fortnight
          without a Cross Functional Committee review: {staleReview.map((r) => r.number).join(", ")}. BO-009 makes that
          a standing Friday meeting, and it is where the checklist gets updated.
        </InlineAlert>
      )}

      <DataTable
        id="build-outs"
        columns={[
          { key: "number", header: "Number", sortable: true, width: "9rem" },
          { key: "name", header: "Build-out", sortable: true, minWidth: "16rem" },
          { key: "region", header: "Region", filterable: true, sortable: true, width: "8rem" },
          { key: "status", header: "Stage", filterable: true, sortable: true, width: "13rem" },
          { key: "checklist", header: "Checklist", align: "right", width: "8rem" },
          { key: "budget", header: "Budget", align: "right", sortable: true, width: "10rem" },
          { key: "actual", header: "Actual", align: "right", sortable: true, width: "10rem" },
          { key: "review", header: "Last review", sortable: true, width: "10rem" },
        ]}
        rows={rows.map((r) => {
          const done = r.tasks.filter((t) => ["DONE", "NOT_APPLICABLE"].includes(t.status)).length;
          const budget = round2(r.boqLines.reduce((a, l) => a + l.budgetTotal, 0)) || r.budgetAmount || 0;
          const actual = round2(r.boqLines.reduce((a, l) => a + (l.actualTotal ?? 0), 0));
          const last = r.meetings[0]?.heldAt ?? null;
          const over = budget > 0 && actual > budget;
          return {
            id: r.id,
            href: `/build-outs/${r.id}`,
            search: `${r.number} ${r.name} ${r.region}`,
            flag: staleReview.some((s) => s.id === r.id) ? ("warning" as const) : null,
            cells: {
              number: <Mono className="text-xs">{r.number}</Mono>,
              name: (
                <>
                  {r.name}
                  <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                    {r.entity.code}
                    {r.city ? ` · ${r.city}` : ""}
                    {r.headcount ? ` · ${r.headcount} seats` : ""}
                  </span>
                </>
              ),
              region: r.region.charAt(0) + r.region.slice(1).toLowerCase(),
              status: (
                <Badge
                  tone={
                    r.status === "CLOSED"
                      ? "success"
                      : r.status === "CANCELLED"
                        ? "neutral"
                        : r.status === "DRAFT" || r.status === "PENDING_MANAGEMENT"
                          ? "warning"
                          : "progress"
                  }
                >
                  {BUILD_OUT_STATE_LABELS[r.status as BuildOutState] ?? r.status}
                </Badge>
              ),
              checklist: r.tasks.length ? `${done}/${r.tasks.length}` : "—",
              budget: budget ? money(budget) : "—",
              actual: actual ? (
                <span className={over ? "text-[var(--c-danger)]" : undefined}>{money(actual)}</span>
              ) : (
                "—"
              ),
              review: last ? fmtDate(last) : <span className="text-[var(--c-text-tertiary)]">never</span>,
            },
            values: {
              number: r.number,
              name: r.name,
              region: r.region,
              status: BUILD_OUT_STATE_LABELS[r.status as BuildOutState] ?? r.status,
              budget,
              actual,
              review: last ? last.getTime() : 0,
            },
          };
        })}
        emptyState="No build-outs yet."
      />

      <p className="text-2xs leading-4 text-[var(--c-text-tertiary)]">
        The checklist column counts the {CHECKLIST_COUNT} responsibilities the Checklist of Roles &amp;
        Responsibilities names across Sales, HR, IT, Procurement, Administration, Finance, Internal Audit, Architect,
        Marketing and Legal. It is copied onto each project when the committee is convened, so a later revision of the
        document cannot rewrite what a finished project was asked to do.
      </p>
    </div>
  );
}
