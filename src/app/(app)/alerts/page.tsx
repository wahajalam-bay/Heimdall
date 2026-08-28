import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext, first, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds, nullableEntityScope } from "@/lib/rbac";
import { bottlenecks } from "@/server/analytics";
import { openPoRows } from "@/server/grn";
import { pettyCashStoreEntryGap } from "@/server/pettycash";
import { vendorsDueForReevaluation } from "@/server/vendors";
import { Badge, EmptyState, PageHeader, RefLink, SectionCard, StatTile } from "@/components/ui/primitives";
import { PillNav } from "@/components/ui/nav";
import { SEVERITY_TONE, humanize } from "@/lib/domain";
import { fmtDate, money, relativeTime } from "@/lib/format";
import { MarkAllRead } from "./MarkAllRead";
import { tableLink } from "@/lib/links";

export const metadata = { title: "Alerts" };
export const dynamic = "force-dynamic";

/**
 * Consolidated alert centre: personal notifications plus every systemic signal
 * the caller is entitled to see.
 */
export default async function AlertsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, ctx } = await pageContext();
  const view = first((await searchParams).view) ?? "all";
  const scoped = visibleEntityIds(user);
  const entityIds = ctx.entityId ? [ctx.entityId] : scoped;

  const [notifications, unread, blockers, openPos, pcGap, vendorsDue, exceptions] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: user.id, ...(view === "unread" ? { read: false } : {}) },
      orderBy: [{ read: "asc" }, { createdAt: "desc" }],
      take: 120,
    }),
    prisma.notification.count({ where: { userId: user.id, read: false } }),
    userHasPermission(user, P.ANALYTICS_VIEW)
      ? bottlenecks({ entityId: ctx.entityId, entityIds: scoped })
      : Promise.resolve([]),
    userHasPermission(user, P.PO_VIEW) ? openPoRows(entityIds) : Promise.resolve([]),
    userHasPermission(user, P.PETTY_CASH_VIEW) ? pettyCashStoreEntryGap(entityIds) : Promise.resolve([]),
    userHasPermission(user, P.VENDOR_VIEW) ? vendorsDueForReevaluation() : Promise.resolve([]),
    userHasPermission(user, P.EXCEPTION_VIEW)
      ? prisma.exception.findMany({
          where: {
            status: { in: ["OPEN", "IN_PROGRESS"] },
            ...nullableEntityScope(ctx.entityId, scoped),
          },
          orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
          take: 60,
        })
      : Promise.resolve([]),
  ]);

  const overduePos = openPos.filter((p) => p.daysOverdue !== null && p.daysOverdue > 0);
  const missingGrn = openPos.filter((p) => p.flags.includes("Missing GRN"));
  const criticalExceptions = exceptions.filter((e) => e.severity === "CRITICAL" || e.severity === "HIGH");

  const nav = [
    { label: "All", href: "/alerts" },
    { label: "Unread", href: "/alerts?view=unread", count: unread },
    { label: "Systemic", href: "/alerts?view=systemic" },
  ];
  const activeHref = view === "unread" ? "/alerts?view=unread" : view === "systemic" ? "/alerts?view=systemic" : "/alerts";

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Home"
        title="Alerts"
        subtitle="Your notifications alongside the systemic signals the procurement controls raise on their own."
        actions={unread > 0 ? <MarkAllRead unread={unread} /> : undefined}
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        <StatTile label="Unread notifications" value={unread} tone={unread ? "accent" : "default"} href="#inbox" />
        <StatTile
          label="Overdue deliveries"
          value={overduePos.length}
          hint="Past the promised date"
          tone={overduePos.length ? "warning" : "default"}
          href={tableLink("/open-pos", { deliveryState: "Overdue" }, { sort: "daysOverdue:desc" })}
        />
        <StatTile
          label="Missing GRNs"
          value={missingGrn.length}
          hint="Delivered value not in inventory"
          tone={missingGrn.length ? "danger" : "default"}
          href={tableLink("/open-pos", { grnAlert: "Missing GRN" })}
        />
        <StatTile
          label="Critical exceptions"
          value={criticalExceptions.length}
          tone={criticalExceptions.length ? "danger" : "default"}
          href="/analytics/exceptions"
        />
        <StatTile
          label="Petty cash store gap"
          value={pcGap.length}
          hint="Purchased but not booked into store"
          tone={pcGap.length ? "warning" : "default"}
          href={tableLink("/petty-cash", { storeGapState: "Outstanding" })}
        />
      </div>

      <PillNav items={nav} active={activeHref} />

      {view !== "systemic" && (
        <SectionCard
          id="inbox"
          title={view === "unread" ? "Unread notifications" : "Notifications"}
          description={`${notifications.length} shown`}
          bodyClassName="px-0 py-0"
        >
          {notifications.length === 0 ? (
            <EmptyState
              title={view === "unread" ? "Nothing unread" : "No notifications"}
              description="You are notified when an approval needs you, a requisition is returned, a quotation arrives, delivery is overdue, an inspection is required, an invoice fails matching or a vendor issue is raised."
            />
          ) : (
            <ul className="row-list">
              {notifications.map((n) => {
                const body = (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      {!n.read && (
                        <span
                          className="size-1.5 shrink-0 rounded-full"
                          style={{
                            background:
                              n.priority === "CRITICAL"
                                ? "var(--c-danger)"
                                : n.priority === "HIGH"
                                  ? "var(--c-warning)"
                                  : "var(--c-accent)",
                          }}
                          aria-label="Unread"
                        />
                      )}
                      <Badge tone="neutral">{humanize(n.type)}</Badge>
                      <span className={n.read ? "text-[0.8125rem] text-muted" : "text-[0.8125rem] font-500"}>
                        {n.title}
                      </span>
                      <span className="ml-auto shrink-0 text-2xs text-[var(--c-text-tertiary)]">
                        {relativeTime(n.createdAt)}
                      </span>
                    </div>
                    {n.body && <p className="mt-0.5 text-xs leading-5 text-muted">{n.body}</p>}
                  </>
                );
                return (
                  <li key={n.id} className="px-4 py-2.5 hover:bg-[var(--c-surface-hover)]">
                    {n.linkUrl ? (
                      <Link href={n.linkUrl} className="block">
                        {body}
                      </Link>
                    ) : (
                      body
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      )}

      {view !== "unread" && (
        <>
          {blockers.length > 0 && (
            <SectionCard
              title="Pipeline blockers"
              description="Work sitting somewhere in the lifecycle, with owner, age and next action"
              actions={
                <Link href="/analytics/bottlenecks" className="btn btn-ghost btn-xs">
                  Full board
                </Link>
              }
              bodyClassName="px-0 py-0"
            >
              <div className="table-wrap max-h-[26rem] overflow-y-auto">
                <table className="dt">
                  <thead>
                    <tr>
                      <th style={{ width: "7rem" }}>Severity</th>
                      <th style={{ width: "9rem" }}>Reference</th>
                      <th style={{ width: "12rem" }}>Stage</th>
                      <th style={{ minWidth: "20rem" }}>Reason</th>
                      <th style={{ width: "12rem" }}>Owner</th>
                      <th className="text-right" style={{ width: "6rem" }}>Age</th>
                      <th className="text-right" style={{ width: "9rem" }}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {blockers.slice(0, 60).map((b) => (
                      <tr key={b.id} data-clickable="true">
                        <td>
                          <Badge tone={SEVERITY_TONE[b.severity] ?? "neutral"}>{humanize(b.severity)}</Badge>
                        </td>
                        <td>
                          <RefLink href={b.href}>{b.documentRef}</RefLink>
                        </td>
                        <td className="text-xs">{b.stage}</td>
                        <td className="text-xs leading-5">
                          {b.reason}
                          <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">Next: {b.nextAction}</span>
                        </td>
                        <td className="text-xs">{b.owner}</td>
                        <td className="num text-2xs">
                          <span className={b.overdue ? "text-[var(--c-danger)]" : undefined}>
                            {Math.floor(b.ageHours / 24)}d
                          </span>
                        </td>
                        <td className="num text-xs">{b.value !== null ? money(b.value, "PKR", { compact: true }) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}

          {pcGap.length > 0 && (
            <SectionCard
              title="Petty cash purchases without a store entry"
              description="These cannot be reconciled or closed until the items are booked into inventory — the control that closes the historical gap."
              bodyClassName="px-0 py-0"
            >
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>Purpose</th>
                      <th>Entity</th>
                      <th>Requester</th>
                      <th className="text-right">Amount</th>
                      <th className="text-right">Unbooked lines</th>
                      <th>Status</th>
                      <th>Waiting</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pcGap.map((g) => (
                      <tr key={g.id} data-clickable="true">
                        <td>
                          <RefLink href={`/petty-cash/${g.id}`}>{g.number}</RefLink>
                        </td>
                        <td className="max-w-[22rem] truncate text-xs" title={g.purpose}>
                          {g.purpose}
                        </td>
                        <td>
                          <Badge tone="neutral">{g.entityCode}</Badge>
                        </td>
                        <td className="text-xs">{g.requester}</td>
                        <td className="num">{money(g.amount)}</td>
                        <td className="num font-500 text-[var(--c-warning)]">{g.unbooked}</td>
                        <td className="text-xs">{humanize(g.status)}</td>
                        <td className="text-2xs">{relativeTime(g.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}

          {vendorsDue.length > 0 && (
            <SectionCard
              title="Vendors due for re-evaluation"
              description="Approved vendors whose scheduled re-scoring interval has elapsed"
              bodyClassName="px-0 py-0"
            >
              <div className="table-wrap max-h-[20rem] overflow-y-auto">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Vendor</th>
                      <th>Status</th>
                      <th>Last evaluated</th>
                      <th className="text-right">Current score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendorsDue.map((v) => (
                      <tr key={v.id} data-clickable="true">
                        <td>
                          <RefLink href={`/vendors/${v.id}`}>{v.code}</RefLink>
                        </td>
                        <td className="text-xs">{v.name}</td>
                        <td>
                          <Badge tone={v.status === "APPROVED" ? "success" : "warning"}>{humanize(v.status)}</Badge>
                        </td>
                        <td className="text-xs">{fmtDate(v.lastEvaluatedAt)}</td>
                        <td className="num text-xs">
                          {v.currentScore !== null ? `${v.currentScore} / ${v.maxScore ?? "—"}` : "Not scored"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}

          {blockers.length === 0 && pcGap.length === 0 && vendorsDue.length === 0 && view === "systemic" && (
            <SectionCard title="Systemic alerts">
              <EmptyState
                title="No systemic alerts"
                description="No overdue deliveries, missing GRNs, store-entry gaps or overdue vendor evaluations."
              />
            </SectionCard>
          )}
        </>
      )}
    </div>
  );
}
