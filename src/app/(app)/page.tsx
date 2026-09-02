import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import type { AppContext } from "@/lib/context";
import { PERMISSIONS as P } from "@/lib/permissions";
import { nullableEntityScope, userHasPermission, visibleEntityIds, type SessionUser } from "@/lib/rbac";
import { procurementKpis, monthlyTrend, spendByDimension, bottlenecks } from "@/server/analytics";
import { prVisibilityFilter } from "@/server/pr";
import { openPoRows } from "@/server/grn";
import { cpcStats } from "@/server/cpc";
import {
  Badge,
  EmptyState,
  MetaItem,
  PageHeader,
  RefLink,
  SectionCard,
  SkeletonTable,
  SkeletonTiles,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { ActionTiles, ActionTile, ActivityList, ActivityRow, BandHeading, MetricGroup } from "@/components/ui/lists";
import { SectionBoundary } from "@/components/ui/SectionBoundary";
import { ChartFrame, ChartTable, RankedBars, TrendChart } from "@/components/ui/charts";
import { fmtDate, money, percent, relativeTime } from "@/lib/format";
import { SEVERITY_TONE, humanize } from "@/lib/domain";
import { statusLink, tableLink } from "@/lib/links";

export const metadata = { title: "Executive Dashboard" };
export const dynamic = "force-dynamic";

/**
 * The dashboard.
 *
 * It is read in one order, so it is built in that order: what is waiting on you,
 * then where the operation stands, then the detail behind both. Every figure in
 * the first two bands links to the records it counts, because a number nobody can
 * act on is decoration.
 *
 * Each band streams on its own. The page used to await a dozen aggregates before
 * rendering a single pixel; now the header and the queue arrive first and the
 * heavier analytics fill in behind them, each inside its own boundary so a slow
 * or failing query costs its own panel and nothing else.
 */

type Scope = { user: SessionUser; ctx: AppContext; scoped: string[] | null };

export default async function DashboardPage() {
  const { user, ctx } = await pageContext();
  const scoped = visibleEntityIds(user);
  const scope: Scope = { user, ctx, scoped };
  const canSeeAnalytics = userHasPermission(user, P.ANALYTICS_VIEW);
  const hasDetail =
    canSeeAnalytics ||
    userHasPermission(user, P.PO_VIEW) ||
    userHasPermission(user, P.PR_VIEW, P.PR_VIEW_ALL) ||
    userHasPermission(user, P.EXCEPTION_VIEW);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="ProcurementOS"
        title="Executive dashboard"
        subtitle={
          ctx.entityName
            ? `${ctx.entityCode} — ${ctx.entityName}. The live procurement position, from requisition through to payment.`
            : "The live procurement position across every entity you can access, from requisition through to payment."
        }
        meta={
          <>
            <MetaItem label="Signed in as">{user.name}</MetaItem>
            <MetaItem label="Acting as">{user.roleNames.join(", ") || "—"}</MetaItem>
          </>
        }
        actions={
          <>
            {userHasPermission(user, P.PR_CREATE) && (
              <Link href="/pr/new" className="btn btn-primary btn-sm">
                New requisition
              </Link>
            )}
            <Link href="/workspace" className="btn btn-secondary btn-sm">
              My workspace
            </Link>
          </>
        }
      />

      <Band
        heading="Requires attention"
        label="Requires attention"
        action={
          <Link href="/alerts" className="text-xs text-[var(--c-accent-text)] hover:underline">
            All alerts
          </Link>
        }
        fallback={<AttentionSkeleton />}
      >
        <Attention {...scope} />
      </Band>

      {canSeeAnalytics && (
        <Band heading="Position" label="Position" fallback={<PositionSkeleton />}>
          <Position {...scope} />
        </Band>
      )}

      {hasDetail && (
        <Band
          heading="Detail"
          label="Detail"
          action={
            canSeeAnalytics ? (
              <Link href="/analytics" className="text-xs text-[var(--c-accent-text)] hover:underline">
                Full analytics
              </Link>
            ) : undefined
          }
          fallback={<DetailSkeleton />}
        >
          <Detail {...scope} />
        </Band>
      )}
    </div>
  );
}

/** Heading, boundary and placeholder for one band of the page. */
function Band({
  heading,
  action,
  label,
  fallback,
  children,
}: {
  heading: string;
  action?: ReactNode;
  label: string;
  fallback: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <BandHeading action={action}>{heading}</BandHeading>
      <SectionBoundary label={label}>
        <Suspense fallback={fallback}>{children}</Suspense>
      </SectionBoundary>
    </section>
  );
}

/* ── Level 1: what is waiting on somebody ─────────────────── */

async function Attention({ user, ctx, scoped }: Scope) {
  const canSeeAnalytics = userHasPermission(user, P.ANALYTICS_VIEW);
  const canSeeExceptions = userHasPermission(user, P.EXCEPTION_VIEW);

  const canSeeRequirements = userHasPermission(user, P.REQUIREMENT_VIEW, P.REQUIREMENT_VIEW_ALL);

  const [myTasks, blockers, blockingExceptions, awaitingDecision] = await Promise.all([
    prisma.task.findMany({
      where: {
        status: { in: ["OPEN", "IN_PROGRESS"] },
        OR: [{ assigneeId: user.id }, { assigneeId: null, assignedRoleCode: { in: user.roleCodes } }],
      },
      orderBy: [{ dueAt: "asc" }],
      take: 6,
    }),
    canSeeAnalytics ? bottlenecks({ entityId: ctx.entityId, entityIds: scoped }) : Promise.resolve([]),
    canSeeExceptions
      ? prisma.exception.count({
          where: {
            status: { in: ["OPEN", "IN_PROGRESS"] },
            blocking: true,
            ...nullableEntityScope(ctx.entityId, scoped),
          },
        })
      : Promise.resolve(0),
    canSeeRequirements
      ? prisma.requirement.count({
          where: { status: { in: ["SUBMITTED", "CHECKING_STOCK"] }, ...ctx.entityFilter },
        })
      : Promise.resolve(0),
  ]);

  const now = new Date();
  const mineOverdue = myTasks.filter((t) => t.dueAt && t.dueAt < now).length;
  const pastSla = blockers.filter((b) => b.overdue);
  const severe = blockers.filter((b) => b.severity === "CRITICAL" || b.severity === "HIGH");
  const oldest = pastSla.reduce<(typeof pastSla)[number] | null>(
    (worst, b) => (!worst || b.ageHours > worst.ageHours ? b : worst),
    null,
  );
  // Late first, then longest waiting — the order somebody working the queue down
  // would choose for themselves.
  const stuck = [...blockers]
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.ageHours - a.ageHours)
    .slice(0, 6);

  return (
    <div className="space-y-4">
      <ActionTiles
        allClear={
          canSeeAnalytics
            ? "Nothing is waiting on you, and every stage is inside its target time."
            : "Nothing is waiting on you."
        }
      >
        <ActionTile
          label="Assigned to you"
          count={myTasks.length}
          context={mineOverdue > 0 ? `${mineOverdue} past its due date` : "None past due"}
          tone={mineOverdue > 0 ? "danger" : "accent"}
          href="/workspace"
        />
        {canSeeAnalytics && (
          <ActionTile
            label="Past target time"
            count={pastSla.length}
            context={
              oldest
                ? `Longest ${Math.floor(oldest.ageHours / 24)}d in ${oldest.stage.toLowerCase()}`
                : "Every stage inside its target"
            }
            tone="warning"
            href="/analytics/bottlenecks"
          />
        )}
        {canSeeAnalytics && (
          <ActionTile
            label="Critical and high"
            count={severe.length}
            context={`of ${blockers.length} ${blockers.length === 1 ? "item" : "items"} in flight`}
            tone="danger"
            href="/analytics/bottlenecks"
          />
        )}
        {canSeeRequirements && (
          <ActionTile
            label="Requirements to route"
            count={awaitingDecision}
            context={awaitingDecision > 0 ? "Stock check and decision outstanding" : "Nothing waiting to be routed"}
            tone="warning"
            href="/requirements"
          />
        )}
        {canSeeExceptions && (
          <ActionTile
            label="Blocking exceptions"
            count={blockingExceptions}
            context={blockingExceptions > 0 ? "Holding receipt or payment" : "Nothing is blocked"}
            tone="danger"
            href="/analytics/exceptions"
          />
        )}
      </ActionTiles>

      <div className={canSeeAnalytics ? "grid items-start gap-4 xl:grid-cols-2" : undefined}>
        <SectionCard
          title="Your queue"
          description={mineOverdue > 0 ? `${mineOverdue} of these are past due` : "Assigned to you or to your role"}
          actions={
            <Link href="/workspace" className="btn btn-ghost btn-xs">
              Open workspace
            </Link>
          }
          bodyClassName="pb-1"
        >
          <ActivityList
            empty={
              <EmptyState
                compact
                title="Nothing is waiting on you"
                description="Approvals and tasks raised for you or your role appear here as soon as they are created."
              />
            }
          >
            {myTasks.map((t) => {
              const overdue = t.dueAt && t.dueAt < now;
              return (
                <ActivityRow
                  key={t.id}
                  href={t.linkUrl ?? "/workspace"}
                  lead={
                    <>
                      <Badge tone={t.taskType === "APPROVAL" ? "accent" : "neutral"}>{humanize(t.taskType)}</Badge>
                      <span className="mono text-2xs text-[var(--c-text-tertiary)]">{t.documentRef}</span>
                      {overdue && <Badge tone="danger">Overdue</Badge>}
                    </>
                  }
                  title={t.title}
                  aside={t.dueAt ? `Due ${relativeTime(t.dueAt)}` : undefined}
                />
              );
            })}
          </ActivityList>
        </SectionCard>

        {canSeeAnalytics && (
          <SectionCard
            title="Where work is stuck"
            description="Late first, then longest waiting"
            actions={
              <Link href="/analytics/bottlenecks" className="btn btn-ghost btn-xs">
                All bottlenecks
              </Link>
            }
            bodyClassName="pb-1"
          >
            <ActivityList
              empty={
                <EmptyState
                  compact
                  title="Nothing is stuck"
                  description="Every open document is inside the target time for its stage."
                />
              }
            >
              {stuck.map((b) => (
                <ActivityRow
                  key={b.id}
                  href={b.href}
                  lead={
                    <>
                      <Badge tone={SEVERITY_TONE[b.severity] ?? "neutral"}>{humanize(b.severity)}</Badge>
                      <span className="mono text-2xs text-[var(--c-accent-text)]">{b.documentRef}</span>
                      {b.overdue && <Badge tone="danger">Late</Badge>}
                    </>
                  }
                  title={b.stage}
                  meta={`${b.owner} · ${b.nextAction}`}
                  aside={`${Math.floor(b.ageHours / 24)}d ${b.ageHours % 24}h`}
                />
              ))}
            </ActivityList>
          </SectionCard>
        )}
      </div>
    </div>
  );
}

/* ── Level 2: where the operation stands ──────────────────── */

async function Position({ ctx, scoped }: Scope) {
  const filter = { entityId: ctx.entityId, entityIds: scoped };
  const [kpis, cpc] = await Promise.all([procurementKpis(filter), cpcStats(scoped)]);

  const hours = (h: number) => (h ? `${h.toFixed(1)}h` : "—");
  const days = (d: number) => (d ? `${d.toFixed(1)}d` : "—");

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Procurement value"
          value={money(kpis.totalProcurementValue, "PKR", { compact: true })}
          hint={`${kpis.poCount} orders · ${money(kpis.monthProcurementValue, "PKR", { compact: true })} this month`}
          tone="accent"
          href="/po"
        />
        <StatTile
          label="Savings realised"
          value={money(kpis.savingsAmount, "PKR", { compact: true })}
          hint={`${percent(kpis.savingsPercent)} against baseline prices`}
          tone="success"
          href="/analytics/savings"
        />
        <StatTile
          label="Open purchase orders"
          value={kpis.openPoCount}
          hint={`${money(kpis.openPoValue, "PKR", { compact: true })} outstanding · ${kpis.overduePoCount} overdue`}
          tone={kpis.overduePoCount > 0 ? "warning" : "default"}
          href="/open-pos"
        />
        <StatTile
          label="Invoice mismatches"
          value={kpis.invoiceMismatchCount}
          hint={`${kpis.invoicesPendingCount} invoices in progress · ${money(kpis.paymentPendingValue, "PKR", { compact: true })} awaiting payment`}
          tone={kpis.invoiceMismatchCount > 0 ? "danger" : "default"}
          href="/invoices"
        />
      </div>

      {/* The supporting figures. Each of these had a card of its own, which gave a
          three-hour approval time the same weight as the entire procurement
          value; grouped and labelled they stay available without competing. */}
      <SectionCard title="Supporting figures" description="Everything else the lifecycle is reporting today">
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
          <MetricGroup
            title="Flow"
            items={[
              { label: "Requisitions raised", value: kpis.prCount, href: "/pr" },
              {
                label: "Awaiting approval",
                value: kpis.prPendingApproval,
                href: statusLink("/pr", "status", ["SUBMITTED", "UNDER_DEPARTMENT_APPROVAL"]),
                alert: kpis.prPendingApproval > 0,
              },
              { label: "RFQs issued", value: kpis.rfqCount, href: "/rfq" },
              {
                label: "Quotes per RFQ",
                value: kpis.avgQuotationsPerRfq ? kpis.avgQuotationsPerRfq.toFixed(1) : "—",
                href: tableLink("/rfq", { quorum: "Below minimum" }),
              },
              { label: "Approval time", value: hours(kpis.avgPrApprovalHours), href: "/analytics/bottlenecks" },
              { label: "Requisition to closure", value: days(kpis.avgCycleTimeDays), href: "/analytics/performance" },
            ]}
          />
          <MetricGroup
            title="Governance"
            items={[
              { label: "Committee pending", value: cpc.pending, href: "/cpc", alert: cpc.pending > 0 },
              { label: "Committee approved", value: cpc.approved, href: "/cpc" },
              {
                label: "Committee decision time",
                value: cpc.avgApprovalHours ? days(cpc.avgApprovalHours / 24) : "—",
                href: "/cpc/decisions",
              },
              { label: "Approved vendors", value: kpis.activeVendors, href: "/vendors?tab=approved" },
              { label: "Blacklisted vendors", value: kpis.blacklistedVendors, href: "/vendors/blacklist" },
              {
                label: "Open exceptions",
                value: `${kpis.openExceptions}${kpis.criticalExceptions ? ` (${kpis.criticalExceptions} critical)` : ""}`,
                href: "/analytics/exceptions",
                alert: kpis.criticalExceptions > 0,
              },
            ]}
          />
          <MetricGroup
            title="Goods, assets and cash"
            items={[
              { label: "Receipts to record", value: kpis.grnPendingCount, href: "/receiving", alert: kpis.grnPendingCount > 0 },
              { label: "Inventory value", value: money(kpis.inventoryValue, "PKR", { compact: true }), href: "/inventory" },
              { label: "Assets on register", value: kpis.assetCount, href: "/assets" },
              { label: "Petty cash spend", value: money(kpis.pettyCashSpend, "PKR", { compact: true }), href: "/petty-cash" },
              { label: "Store-entry gap", value: kpis.pettyCashStoreGap, href: "/petty-cash", alert: kpis.pettyCashStoreGap > 0 },
              { label: "Awaiting payment", value: money(kpis.paymentPendingValue, "PKR", { compact: true }), href: "/finance/pending" },
            ]}
          />
        </div>
      </SectionCard>
    </div>
  );
}

/* ── Level 3: the detail behind it ────────────────────────── */

async function Detail({ user, ctx, scoped }: Scope) {
  // Every panel here mirrors the gate on the register it summarises: the
  // dashboard must not become the way to see what a register would refuse.
  const canSeeAnalytics = userHasPermission(user, P.ANALYTICS_VIEW);
  const canSeeExceptions = userHasPermission(user, P.EXCEPTION_VIEW);
  const canSeePos = userHasPermission(user, P.PO_VIEW);
  const canSeePrs = userHasPermission(user, P.PR_VIEW, P.PR_VIEW_ALL);
  const filter = { entityId: ctx.entityId, entityIds: scoped };

  const [trend, categorySpend, openPos, recentCases, exceptions] = await Promise.all([
    canSeeAnalytics ? monthlyTrend(filter, 12) : Promise.resolve([]),
    canSeeAnalytics ? spendByDimension("category", filter) : Promise.resolve([]),
    canSeePos ? openPoRows(ctx.entityId ? [ctx.entityId] : scoped) : Promise.resolve([]),
    canSeePrs
      ? prisma.purchaseRequisition.findMany({
          where: { ...ctx.entityFilter, ...prVisibilityFilter(user) },
          orderBy: { updatedAt: "desc" },
          take: 7,
          include: {
            entity: { select: { code: true } },
            requester: { select: { name: true } },
            department: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    canSeeExceptions
      ? prisma.exception.findMany({
          where: {
            status: { in: ["OPEN", "IN_PROGRESS"] },
            ...nullableEntityScope(ctx.entityId, scoped),
          },
          orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
          take: 5,
        })
      : Promise.resolve([]),
  ]);

  const trendSeries = [
    { key: "poValue", label: "Purchase order value" },
    { key: "savings", label: "Savings", colorIndex: 1 },
  ];

  return (
    <div className="space-y-4">
      {canSeeAnalytics && (
        <div className="grid items-start gap-4 xl:grid-cols-[1.6fr_1fr]">
          <ChartFrame
            title="Procurement value and savings by month"
            subtitle="Purchase order value against recorded savings, last 12 months"
            series={trendSeries}
            tableView={
              <ChartTable
                columns={["Month", "PO value", "Savings", "PRs raised"]}
                rows={trend.map((t) => [t.label, money(t.poValue), money(t.savings), t.prCount])}
              />
            }
            footnote="Purchase order value excludes drafts, cancellations and orders pending approval."
          >
            <TrendChart
              data={trend.map((t) => ({
                label: t.label,
                values: [t.poValue, t.savings],
              }))}
              series={trendSeries}
              area
              height={240}
              format="moneyCompact"
            />
          </ChartFrame>

          <ChartFrame
            title="Spend by category"
            subtitle="Purchase order value, all time"
            tableView={
              <ChartTable
                columns={["Category", "Spend", "Orders"]}
                rows={categorySpend.map((c) => [c.label, money(c.value), c.count])}
              />
            }
          >
            <RankedBars
              data={categorySpend.map((c) => ({
                label: c.label,
                value: c.value,
                sub: `${c.count} line(s)`,
                href: tableLink("/analytics/spend", undefined, { dimension: "category", q: c.label }),
              }))}
              format="moneyCompact"
              maxRows={8}
              secondaryLabel={
                categorySpend.length > 8 ? `Showing the top 8 of ${categorySpend.length} categories.` : undefined
              }
            />
          </ChartFrame>
        </div>
      )}

      {/* Two panels or one: a lone card should not sit in a two-column grid with
          half the row left blank. */}
      <div
        className={
          canSeePos && canSeePrs
            ? "grid items-start gap-4 xl:grid-cols-[1.6fr_1fr]"
            : "grid items-start gap-4"
        }
      >
        {canSeePos && (
          <SectionCard
            title="Open purchase orders"
            description="Issued but not fully received, oldest promise first"
            actions={
              <Link href="/open-pos" className="btn btn-ghost btn-xs">
                Control tower
              </Link>
            }
            bodyClassName="px-0 pb-0"
          >
            {openPos.length === 0 ? (
              <EmptyState
                compact
                title="No open orders"
                description="Every issued purchase order has been received in full."
              />
            ) : (
              <div className="table-wrap">
                <table className="dt min-w-[34rem]">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Vendor</th>
                      <th className="text-right">Pending value</th>
                      <th>Promised</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openPos.slice(0, 8).map((po) => {
                      const late = po.daysOverdue !== null && po.daysOverdue > 0;
                      return (
                        <tr key={po.id} data-clickable="true">
                          <td>
                            <RefLink href={`/po/${po.id}`}>{po.number}</RefLink>
                          </td>
                          <td className="max-w-[14rem] truncate text-xs" title={po.vendorName}>
                            {po.vendorName}
                          </td>
                          <td className="num">{money(po.pendingValue, "PKR", { compact: true })}</td>
                          <td>
                            <div className="flex items-center gap-1.5 text-xs">
                              <span className={late ? "text-danger-soft-foreground" : undefined}>
                                {po.deliveryDate ? fmtDate(po.deliveryDate) : "—"}
                              </span>
                              {late && <Badge tone="danger">{po.daysOverdue}d late</Badge>}
                            </div>
                            {/* The rest of the flags live on the control tower; the
                              first is worth carrying here because it explains why
                              an order that looks on time is not. */}
                            {po.flags.length > 0 && (
                              <div className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">
                                {po.flags[0]}
                                {po.flags.length > 1 ? ` +${po.flags.length - 1}` : ""}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        )}

        {canSeePrs && (
          <SectionCard
            title="Recent activity"
            description="Requisitions that moved most recently"
            actions={
              <Link href="/pr" className="btn btn-ghost btn-xs">
                All requisitions
              </Link>
            }
            bodyClassName="pb-1"
          >
            <ActivityList
              empty={
                <EmptyState
                  compact
                  title="No requisitions yet"
                  description="The first requisition raised here appears in this list."
                  action={
                    userHasPermission(user, P.PR_CREATE) ? (
                      <Link href="/pr/new" className="btn btn-primary btn-xs">
                        New requisition
                      </Link>
                    ) : undefined
                  }
                />
              }
            >
              {recentCases.map((pr) => (
                <ActivityRow
                  key={pr.id}
                  href={`/pr/${pr.id}`}
                  lead={
                    <>
                      <span className="mono text-2xs text-[var(--c-accent-text)]">{pr.number}</span>
                      <StatusBadge status={pr.status} />
                    </>
                  }
                  title={pr.title}
                  meta={`${pr.entity.code} · ${pr.department.name} · ${pr.requester.name} · ${relativeTime(pr.updatedAt)}`}
                  aside={money(pr.estimatedValue, "PKR", { compact: true })}
                />
              ))}
            </ActivityList>
          </SectionCard>
        )}
      </div>

      {canSeeExceptions && (
        <SectionCard
          title="Open exceptions"
          description="Every tolerated rule breach is recorded, owned and dated"
          actions={
            <Link href="/analytics/exceptions" className="btn btn-ghost btn-xs">
              All exceptions
            </Link>
          }
          bodyClassName="px-0 pb-0"
        >
          {exceptions.length === 0 ? (
            <EmptyState
              compact
              title="No open exceptions"
              description="No rule has been breached or waived on an open document."
            />
          ) : (
            <div className="table-wrap">
              <table className="dt min-w-[34rem]">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Severity</th>
                    <th className="w-full">What happened</th>
                    <th>Raised</th>
                  </tr>
                </thead>
                <tbody>
                  {exceptions.map((e) => (
                    <tr key={e.id} data-clickable="true">
                      <td>
                        <RefLink href={`/analytics/exceptions/${e.id}`}>{e.number}</RefLink>
                        <div className="mono mt-0.5 text-2xs text-[var(--c-text-tertiary)]">{e.documentRef}</div>
                      </td>
                      <td>
                        <span className="flex items-center gap-1">
                          <Badge tone={SEVERITY_TONE[e.severity] ?? "neutral"}>{humanize(e.severity)}</Badge>
                          {e.blocking && <Badge tone="danger">Blocking</Badge>}
                        </span>
                      </td>
                      <td className="wrap text-xs">
                        {e.title}
                        <div className="mt-0.5 text-2xs text-muted">{humanize(e.type)}</div>
                      </td>
                      <td className="text-2xs">{relativeTime(e.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      )}
    </div>
  );
}

/* ── Placeholders, shaped like what replaces them ─────────── */

function AttentionSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="card grid gap-px overflow-hidden bg-separator sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-surface px-4 py-3.5">
            <div className="skeleton h-2.5 w-20" />
            <div className="skeleton mt-2.5 h-6 w-12" />
            <div className="skeleton mt-2 h-2.5 w-28" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="card card-pad space-y-3">
            <div className="skeleton h-3 w-32" />
            {Array.from({ length: 4 }).map((_, r) => (
              <div key={r} className="space-y-1.5">
                <div className="skeleton h-2.5 w-24" />
                <div className="skeleton h-2.5 w-[70%]" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function PositionSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <SkeletonTiles />
      <div className="card card-pad">
        <div className="skeleton h-3 w-36" />
        <div className="mt-4 grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((c) => (
            <div key={c} className="space-y-2">
              <div className="skeleton h-2.5 w-20" />
              {Array.from({ length: 6 }).map((_, r) => (
                <div key={r} className="skeleton h-2.5 w-full" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <div className="card card-pad">
          <div className="skeleton h-3 w-64" />
          <div className="skeleton mt-2 h-2.5 w-80" />
          <div className="skeleton mt-4 h-[240px] w-full" />
        </div>
        <div className="card card-pad">
          <div className="skeleton h-3 w-36" />
          <div className="skeleton mt-2 h-2.5 w-48" />
          <div className="mt-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i}>
                <div className="skeleton h-2.5 w-32" />
                <div className="skeleton mt-1.5 h-1.5 w-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <SkeletonTable rows={6} cols={4} />
    </div>
  );
}
