import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { procurementKpis, monthlyTrend, spendByDimension, bottlenecks } from "@/server/analytics";
import { openPoRows } from "@/server/grn";
import { cpcStats } from "@/server/cpc";
import {
  Badge,
  Card,
  EmptyState,
  MetaItem,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
  Meter,
} from "@/components/ui/primitives";
import { ChartFrame, ChartTable, ColumnChart, DonutChart, RankedBars, TrendChart } from "@/components/ui/charts";
import { fmtDate, money, percent, relativeTime } from "@/lib/format";
import { SEVERITY_TONE, humanize } from "@/lib/domain";

export const metadata = { title: "Executive Dashboard" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { user, ctx } = await pageContext();
  const scoped = visibleEntityIds(user);
  const canSeeAnalytics = userHasPermission(user, P.ANALYTICS_VIEW);
  const filter = { entityId: ctx.entityId, entityIds: scoped };

  const [kpis, trend, categorySpend, entitySpend, openPos, cpc, blockers, myTasks, recentCases, exceptions] =
    await Promise.all([
      procurementKpis(filter),
      monthlyTrend(filter, 12),
      spendByDimension("category", filter),
      spendByDimension("entity", { entityIds: scoped }),
      openPoRows(ctx.entityId ? [ctx.entityId] : scoped),
      cpcStats(scoped),
      canSeeAnalytics ? bottlenecks(filter) : Promise.resolve([]),
      prisma.task.findMany({
        where: {
          status: { in: ["OPEN", "IN_PROGRESS"] },
          OR: [{ assigneeId: user.id }, { assigneeId: null, assignedRoleCode: { in: user.roleCodes } }],
        },
        orderBy: [{ dueAt: "asc" }],
        take: 8,
      }),
      prisma.purchaseRequisition.findMany({
        where: ctx.entityFilter,
        orderBy: { updatedAt: "desc" },
        take: 8,
        include: {
          entity: { select: { code: true } },
          requester: { select: { name: true } },
          department: { select: { name: true } },
        },
      }),
      prisma.exception.findMany({
        where: { status: { in: ["OPEN", "IN_PROGRESS"] } },
        orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
        take: 6,
      }),
    ]);

  const overdueTasks = myTasks.filter((t) => t.dueAt && t.dueAt < new Date()).length;
  const trendSeries = [
    { key: "poValue", label: "Purchase order value" },
    { key: "savings", label: "Savings", colorIndex: 1 },
  ];
  const criticalBlockers = blockers.filter((b) => b.severity === "CRITICAL" || b.severity === "HIGH").slice(0, 8);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Home"
        title="Executive dashboard"
        subtitle={
          ctx.entityName
            ? `${ctx.entityCode} — ${ctx.entityName}. Live procurement position across the requisition-to-payment lifecycle.`
            : "Live procurement position across every entity you can access."
        }
        meta={
          <>
            <MetaItem label="Signed in as">{user.name}</MetaItem>
            <MetaItem label="Roles">{user.roleNames.join(", ") || "—"}</MetaItem>
            <MetaItem label="My open tasks">
              <Link href="/workspace" className="text-[var(--c-accent-text)]">
                {myTasks.length}
                {overdueTasks > 0 && <span className="text-[var(--c-danger)]"> ({overdueTasks} overdue)</span>}
              </Link>
            </MetaItem>
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

      {/* Headline KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Procurement value"
          value={money(kpis.totalProcurementValue, "PKR", { compact: true })}
          hint={`${kpis.poCount} purchase orders · ${money(kpis.monthProcurementValue, "PKR", { compact: true })} this month`}
          tone="accent"
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
          hint={`${kpis.invoicesPendingCount} invoices in progress · ${money(kpis.paymentPendingValue, "PKR", { compact: true })} pending payment`}
          tone={kpis.invoiceMismatchCount > 0 ? "danger" : "default"}
          href="/invoices"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <StatTile label="Requisitions" value={kpis.prCount} hint={`${kpis.prPendingApproval} awaiting approval`} href="/pr" />
        <StatTile
          label="Approval time"
          value={kpis.avgPrApprovalHours ? `${kpis.avgPrApprovalHours.toFixed(1)}h` : "—"}
          hint="Submission to final approval"
        />
        <StatTile
          label="Cycle time"
          value={kpis.avgCycleTimeDays ? `${kpis.avgCycleTimeDays.toFixed(1)}d` : "—"}
          hint="Submission to case closure"
        />
        <StatTile
          label="Quotes per RFQ"
          value={kpis.avgQuotationsPerRfq ? kpis.avgQuotationsPerRfq.toFixed(1) : "—"}
          hint={`${kpis.rfqCount} RFQs issued`}
          href="/rfq"
        />
        <StatTile
          label="GRNs pending"
          value={kpis.grnPendingCount}
          hint="Received but not taken into inventory"
          tone={kpis.grnPendingCount > 0 ? "warning" : "default"}
          href="/receiving"
        />
        <StatTile
          label="Open exceptions"
          value={kpis.openExceptions}
          hint={`${kpis.criticalExceptions} critical`}
          tone={kpis.criticalExceptions > 0 ? "danger" : kpis.openExceptions > 0 ? "warning" : "default"}
          href="/analytics/exceptions"
        />
      </div>

      {/* Charts */}
      {canSeeAnalytics && (
        <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
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
              data={trend.map((t) => ({ label: t.label, values: [t.poValue, t.savings] }))}
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
              data={categorySpend.map((c) => ({ label: c.label, value: c.value, sub: `${c.count} line(s)` }))}
              format="moneyCompact"
              maxRows={8}
              secondaryLabel={
                categorySpend.length > 8 ? `Showing the top 8 of ${categorySpend.length} categories.` : undefined
              }
            />
          </ChartFrame>
        </div>
      )}

      {canSeeAnalytics && (
        <div className="grid gap-4 xl:grid-cols-3">
          <ChartFrame
            title="Spend by entity"
            subtitle="All-time purchase order value"
            tableView={
              <ChartTable columns={["Entity", "Spend", "Orders"]} rows={entitySpend.map((e) => [e.label, money(e.value), e.count])} />
            }
          >
            <DonutChart
              data={entitySpend.map((e) => ({ label: e.label, value: e.value }))}
              format="moneyCompact"
              centerLabel="Total spend"
            />
          </ChartFrame>

          <ChartFrame
            title="Requisitions raised by month"
            subtitle="Volume of new procurement cases"
            tableView={<ChartTable columns={["Month", "Requisitions"]} rows={trend.map((t) => [t.label, t.prCount])} />}
          >
            <ColumnChart
              data={trend.map((t) => ({ label: t.label, values: [t.prCount] }))}
              series={[{ key: "prCount", label: "Requisitions", colorIndex: 4 }]}
              height={220}
              format="number"
              highlightLast
            />
          </ChartFrame>

          <SectionCard
            title="Central Procurement Committee"
            description="Committee throughput and value under review"
            actions={
              <Link href="/cpc" className="btn btn-ghost btn-xs">
                Open CPC
              </Link>
            }
          >
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              {[
                ["Pending", cpc.pending, cpc.pending > 0 ? "warning" : "default"],
                ["Approved", cpc.approved, "default"],
                ["Returned", cpc.returned, cpc.returned > 0 ? "warning" : "default"],
                ["Rejected", cpc.rejected, "default"],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <div className="label">{String(label)}</div>
                  <div className="tnum text-[1.125rem] font-600">{String(value)}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 space-y-1 border-t border-[var(--c-border-subtle)] pt-3">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-[var(--c-text-secondary)]">Value reviewed</span>
                <span className="tnum font-500">{money(cpc.totalValue, "PKR", { compact: true })}</span>
              </div>
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-[var(--c-text-secondary)]">Savings endorsed</span>
                <span className="tnum font-500 text-[var(--c-success)]">
                  {money(cpc.totalSavings, "PKR", { compact: true })}
                </span>
              </div>
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-[var(--c-text-secondary)]">Average decision time</span>
                <span className="tnum font-500">
                  {cpc.avgApprovalHours ? `${(cpc.avgApprovalHours / 24).toFixed(1)}d` : "—"}
                </span>
              </div>
            </div>
          </SectionCard>
        </div>
      )}

      {/* Operational attention */}
      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard
          title="Needs attention"
          description="The highest-severity blockers across the lifecycle right now"
          actions={
            <Link href="/analytics/bottlenecks" className="btn btn-ghost btn-xs">
              All bottlenecks
            </Link>
          }
          bodyClassName="px-0 py-0"
        >
          {criticalBlockers.length === 0 ? (
            <EmptyState compact title="Nothing critical" description="No high-severity blockers in the pipeline." />
          ) : (
            <ul className="divide-y divide-[var(--c-border-subtle)]">
              {criticalBlockers.map((b) => (
                <li key={b.id} className="px-4 py-2.5">
                  <Link href={b.href} className="group block">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={SEVERITY_TONE[b.severity] ?? "neutral"}>{humanize(b.severity)}</Badge>
                      <span className="mono text-[var(--c-accent-text)]">{b.documentRef}</span>
                      <span className="text-xs font-500 group-hover:underline">{b.stage}</span>
                      {b.overdue && <Badge tone="danger">Overdue</Badge>}
                      <span className="tnum ml-auto text-2xs text-[var(--c-text-tertiary)]">
                        {Math.floor(b.ageHours / 24)}d {b.ageHours % 24}h
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs leading-5 text-[var(--c-text-secondary)]">{b.reason}</p>
                    <p className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">
                      Owner: {b.owner} · Next: {b.nextAction}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Open purchase orders"
          description="Issued but not fully received, oldest first"
          actions={
            <Link href="/open-pos" className="btn btn-ghost btn-xs">
              Control tower
            </Link>
          }
          bodyClassName="px-0 py-0"
        >
          {openPos.length === 0 ? (
            <EmptyState compact title="No open orders" description="Every issued purchase order has been fully received." />
          ) : (
            <div className="table-wrap max-h-[22rem] overflow-y-auto">
              <table className="dt">
                <thead>
                  <tr>
                    <th>PO</th>
                    <th>Vendor</th>
                    <th className="text-right">Pending value</th>
                    <th>Promised</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {openPos.slice(0, 12).map((po) => (
                    <tr key={po.id}>
                      <td>
                        <RefLink href={`/po/${po.id}`}>{po.number}</RefLink>
                      </td>
                      <td className="max-w-[10rem] truncate text-xs" title={po.vendorName}>
                        {po.vendorName}
                      </td>
                      <td className="num">{money(po.pendingValue, "PKR", { compact: true })}</td>
                      <td className="text-xs">
                        <span className={po.daysOverdue && po.daysOverdue > 0 ? "text-[var(--c-danger)]" : undefined}>
                          {po.deliveryDate ? fmtDate(po.deliveryDate) : "—"}
                        </span>
                      </td>
                      <td>
                        <span className="flex flex-wrap gap-1">
                          {po.flags.slice(0, 2).map((f) => (
                            <Badge key={f} tone={f.includes("Overdue") || f.includes("Missing") ? "danger" : "warning"}>
                              {f}
                            </Badge>
                          ))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr_1fr]">
        <SectionCard
          title="My next actions"
          description={overdueTasks > 0 ? `${overdueTasks} overdue` : "Assigned to you or your role"}
          actions={
            <Link href="/workspace" className="btn btn-ghost btn-xs">
              Workspace
            </Link>
          }
          bodyClassName="px-0 py-0"
        >
          {myTasks.length === 0 ? (
            <EmptyState compact title="Nothing waiting on you" description="You have no open procurement tasks." />
          ) : (
            <ul className="divide-y divide-[var(--c-border-subtle)]">
              {myTasks.map((t) => {
                const overdue = t.dueAt && t.dueAt < new Date();
                return (
                  <li key={t.id} className="px-4 py-2.5">
                    <Link href={t.linkUrl ?? "/workspace"} className="group block">
                      <div className="flex items-center gap-2">
                        <Badge tone={t.taskType === "APPROVAL" ? "accent" : "neutral"}>{humanize(t.taskType)}</Badge>
                        <span className="mono text-2xs text-[var(--c-text-tertiary)]">{t.documentRef}</span>
                        {overdue && <Badge tone="danger">Overdue</Badge>}
                      </div>
                      <p className="mt-0.5 text-xs font-500 group-hover:underline">{t.title}</p>
                      {t.dueAt && (
                        <p className="text-2xs text-[var(--c-text-tertiary)]">Due {relativeTime(t.dueAt)}</p>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Recent case activity" bodyClassName="px-0 py-0">
          {recentCases.length === 0 ? (
            <EmptyState compact title="No cases yet" />
          ) : (
            <ul className="divide-y divide-[var(--c-border-subtle)]">
              {recentCases.map((pr) => (
                <li key={pr.id} className="px-4 py-2.5">
                  <Link href={`/pr/${pr.id}`} className="group block">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mono text-[var(--c-accent-text)]">{pr.number}</span>
                      <StatusBadge status={pr.status} />
                      <span className="tnum ml-auto text-2xs text-[var(--c-text-tertiary)]">
                        {money(pr.estimatedValue, "PKR", { compact: true })}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs font-500 group-hover:underline">{pr.title}</p>
                    <p className="text-2xs text-[var(--c-text-tertiary)]">
                      {pr.entity.code} · {pr.department.name} · {pr.requester.name} · {relativeTime(pr.updatedAt)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Governance position"
          description="Where the controls stand today"
        >
          <div className="space-y-3.5">
            <div>
              <Meter
                value={kpis.activeVendors}
                max={kpis.activeVendors + kpis.blacklistedVendors}
                label={`${kpis.activeVendors} approved vendors`}
                tone="success"
              />
              <p className="mt-1 text-2xs text-[var(--c-text-tertiary)]">
                {kpis.blacklistedVendors} blacklisted and blocked from sourcing
              </p>
            </div>
            <div className="space-y-1 border-t border-[var(--c-border-subtle)] pt-3">
              {[
                ["Inventory value", money(kpis.inventoryValue, "PKR", { compact: true }), "/inventory"],
                ["Assets on register", String(kpis.assetCount), "/assets"],
                ["Petty cash spend", money(kpis.pettyCashSpend, "PKR", { compact: true }), "/petty-cash"],
                [
                  "Petty cash store-entry gap",
                  String(kpis.pettyCashStoreGap),
                  "/petty-cash",
                  kpis.pettyCashStoreGap > 0,
                ],
                ["Payments pending", money(kpis.paymentPendingValue, "PKR", { compact: true }), "/finance/pending"],
              ].map(([label, value, href, danger]) => (
                <Link
                  key={String(label)}
                  href={String(href)}
                  className="flex items-baseline justify-between gap-3 py-0.5 text-xs hover:text-[var(--c-accent-text)]"
                >
                  <span className="text-[var(--c-text-secondary)]">{String(label)}</span>
                  <span className={`tnum font-500 ${danger ? "text-[var(--c-danger)]" : ""}`}>{String(value)}</span>
                </Link>
              ))}
            </div>
          </div>
        </SectionCard>
      </div>

      {exceptions.length > 0 && userHasPermission(user, P.EXCEPTION_VIEW) && (
        <SectionCard
          title="Latest exceptions"
          description="Every tolerated rule breach is tracked, owned and dated"
          actions={
            <Link href="/analytics/exceptions" className="btn btn-ghost btn-xs">
              All exceptions
            </Link>
          }
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Type</th>
                  <th>Severity</th>
                  <th>Document</th>
                  <th style={{ minWidth: "20rem" }}>Detail</th>
                  <th>Raised</th>
                </tr>
              </thead>
              <tbody>
                {exceptions.map((e) => (
                  <tr key={e.id} data-clickable="true">
                    <td>
                      <RefLink href={`/analytics/exceptions/${e.id}`}>{e.number}</RefLink>
                    </td>
                    <td className="text-xs">{humanize(e.type)}</td>
                    <td>
                      <Badge tone={SEVERITY_TONE[e.severity] ?? "neutral"}>{humanize(e.severity)}</Badge>
                      {e.blocking && (
                        <span className="ml-1">
                          <Badge tone="danger">Blocking</Badge>
                        </span>
                      )}
                    </td>
                    <td className="mono text-2xs">{e.documentRef}</td>
                    <td className="text-xs">{e.title}</td>
                    <td className="text-2xs">{relativeTime(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </div>
  );
}
