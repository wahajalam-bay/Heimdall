import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import {
  Badge,
  EmptyState,
  MetaItem,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { SEVERITY_TONE, humanize } from "@/lib/domain";
import { fmtDateTime, money, relativeTime } from "@/lib/format";

export const metadata = { title: "My Workspace" };
import { ApprovalQueue, type QueueItem } from "./ApprovalQueue";

export const dynamic = "force-dynamic";

/**
 * Personal task centre. Nobody should have to search the system to discover
 * what is waiting on them.
 */
export default async function WorkspacePage() {
  const { user, ctx } = await pageContext();

  const taskWhere = {
    status: { in: ["OPEN", "IN_PROGRESS"] },
    OR: [{ assigneeId: user.id }, { assigneeId: null, assignedRoleCode: { in: user.roleCodes } }],
  };

  const [tasks, drafts, returned, myCases, cpcCases, notifications, exceptionsOwned, recentActivity, doneCount] =
    await Promise.all([
      prisma.task.findMany({ where: taskWhere, orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }] }),
      prisma.purchaseRequisition.findMany({
        where: { requesterId: user.id, status: "DRAFT" },
        orderBy: { updatedAt: "desc" },
        include: { entity: { select: { code: true } }, items: { select: { id: true } } },
      }),
      prisma.purchaseRequisition.findMany({
        where: { requesterId: user.id, status: "RETURNED" },
        orderBy: { updatedAt: "desc" },
        include: { entity: { select: { code: true } } },
      }),
      prisma.purchaseRequisition.findMany({
        where: {
          OR: [{ requesterId: user.id }, { pmOwnerId: user.id }],
          status: { notIn: ["CLOSED", "CANCELLED", "REJECTED", "DRAFT"] },
        },
        orderBy: { updatedAt: "desc" },
        take: 20,
        include: { entity: { select: { code: true } }, department: { select: { name: true } } },
      }),
      userHasPermission(user, P.CPC_DECIDE)
        ? prisma.cpcCase.findMany({
            where: {
              status: { in: ["PENDING", "SCHEDULED", "UNDER_REVIEW"] },
              members: { some: { userId: user.id } },
            },
            include: { pr: { select: { number: true, title: true } }, decisions: { where: { memberId: user.id } } },
            orderBy: { createdAt: "asc" },
          })
        : Promise.resolve([]),
      prisma.notification.findMany({
        where: { userId: user.id },
        orderBy: [{ read: "asc" }, { createdAt: "desc" }],
        take: 12,
      }),
      prisma.exception.findMany({
        where: { ownerId: user.id, status: { in: ["OPEN", "IN_PROGRESS"] } },
        orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
      }),
      prisma.auditLog.findMany({ where: { actorId: user.id }, orderBy: { createdAt: "desc" }, take: 15 }),
      prisma.task.count({
        where: {
          status: "DONE",
          completedById: user.id,
          completedAt: { gte: new Date(Date.now() - 30 * 86400000) },
        },
      }),
    ]);

  const now = new Date();
  const overdue = tasks.filter((t) => t.dueAt && t.dueAt < now);
  const approvals = tasks.filter((t) => t.taskType === "APPROVAL");
  const pendingVotes = cpcCases.filter((c) => c.decisions.length === 0);

  // Approvals are actioned in place, so they come out of the generic task table.
  const queueItems: QueueItem[] = approvals.map((t) => ({
    taskId: t.id,
    documentType: t.documentType,
    documentId: t.documentId,
    documentRef: t.documentRef,
    title: t.title,
    description: t.description,
    linkUrl: t.linkUrl,
    dueAt: t.dueAt ? t.dueAt.toISOString() : null,
    overdue: Boolean(t.dueAt && t.dueAt < now),
  }));

  const groups: Array<{ label: string; items: typeof tasks; description: string }> = [
    {
      label: "Overdue",
      items: overdue.filter((t) => t.taskType !== "APPROVAL"),
      description: "Past the service-level target for this step",
    },
    {
      label: "Other actions",
      items: tasks.filter((t) => !overdue.includes(t) && t.taskType !== "APPROVAL"),
      description: "Sourcing, receiving, inspection, verification and data entry",
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Home"
        title="My workspace"
        subtitle="Everything waiting on you, everything you own, and what you have recently done."
        meta={
          <>
            <MetaItem label="Name">{user.name}</MetaItem>
            <MetaItem label="Roles">{user.roleNames.join(", ") || "—"}</MetaItem>
            {ctx.entityName && <MetaItem label="Entity">{`${ctx.entityCode} — ${ctx.entityName}`}</MetaItem>}
            {user.primaryDepartmentName && <MetaItem label="Department">{user.primaryDepartmentName}</MetaItem>}
          </>
        }
        actions={
          userHasPermission(user, P.PR_CREATE) && (
            <Link href="/pr/new" className="btn btn-primary btn-sm">
              New requisition
            </Link>
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Open tasks" value={tasks.length} hint="Assigned to you or your role" tone="accent" />
        <StatTile
          label="Overdue"
          value={overdue.length}
          hint="Past their service-level target"
          tone={overdue.length ? "danger" : "default"}
        />
        <StatTile
          label="Approvals waiting"
          value={approvals.length + pendingVotes.length}
          hint={pendingVotes.length ? `${pendingVotes.length} committee vote(s) included` : "Decisions needing you"}
          tone={approvals.length + pendingVotes.length ? "warning" : "default"}
        />
        <StatTile label="My drafts" value={drafts.length} hint="Not yet submitted" />
        <StatTile label="Completed (30 days)" value={doneCount} hint="Tasks you closed" tone="success" />
      </div>

      {returned.length > 0 && (
        <SectionCard
          title="Returned to you"
          description="These requisitions need revision before they can move forward."
          bodyClassName="px-0 py-0"
        >
          <ul className="divide-y divide-[var(--c-border-subtle)]">
            {returned.map((pr) => (
              <li key={pr.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <RefLink href={`/pr/${pr.id}`}>{pr.number}</RefLink>
                    <StatusBadge status={pr.status} />
                    <Badge tone="neutral">{pr.entity.code}</Badge>
                  </div>
                  <p className="mt-0.5 text-[0.8125rem] font-500">{pr.title}</p>
                  {pr.returnReason && (
                    <p className="mt-1 max-w-3xl rounded-[var(--radius-sm)] border border-[var(--c-warning-border)] bg-[var(--c-warning-soft)] px-2.5 py-1.5 text-xs leading-5 text-[var(--c-warning)]">
                      {pr.returnReason}
                    </p>
                  )}
                </div>
                <Link href={`/pr/${pr.id}/edit`} className="btn btn-primary btn-sm shrink-0">
                  Revise and resubmit
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {pendingVotes.length > 0 && (
        <SectionCard
          title="Committee decisions awaiting your vote"
          description="You are an assigned member of these Central Procurement Committee cases."
          bodyClassName="px-0 py-0"
        >
          <ul className="divide-y divide-[var(--c-border-subtle)]">
            {pendingVotes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <RefLink href={`/cpc/cases/${c.id}`}>{c.number}</RefLink>
                    <StatusBadge status={c.status} />
                    <span className="mono text-2xs text-[var(--c-text-tertiary)]">{c.pr.number}</span>
                  </div>
                  <p className="mt-0.5 text-[0.8125rem] font-500">{c.title}</p>
                  {c.recommendation && (
                    <p className="mt-0.5 max-w-3xl text-xs leading-5 text-[var(--c-text-secondary)]">
                      {c.recommendation}
                    </p>
                  )}
                </div>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="tnum text-[0.9375rem] font-600">{money(c.amount)}</span>
                  <Link href={`/cpc/cases/${c.id}`} className="btn btn-primary btn-sm">
                    Review case
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {queueItems.length > 0 && (
        <SectionCard
          title="Waiting on your decision"
          description={`${queueItems.length} approval${queueItems.length === 1 ? "" : "s"} — approve or return without leaving this page.`}
        >
          <ApprovalQueue items={queueItems} />
        </SectionCard>
      )}

      {groups.map((g) =>
        g.items.length === 0 ? null : (
          <SectionCard
            key={g.label}
            title={g.label}
            description={`${g.items.length} item(s) — ${g.description}`}
            bodyClassName="px-0 py-0"
          >
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: "8rem" }}>Type</th>
                    <th style={{ minWidth: "20rem" }}>Task</th>
                    <th style={{ width: "9rem" }}>Reference</th>
                    <th style={{ width: "8rem" }}>Priority</th>
                    <th style={{ width: "10rem" }}>Due</th>
                    <th style={{ width: "6rem" }} />
                  </tr>
                </thead>
                <tbody>
                  {g.items.map((t) => {
                    const isOverdue = t.dueAt && t.dueAt < now;
                    return (
                      <tr key={t.id}>
                        <td>
                          <Badge tone={t.taskType === "APPROVAL" ? "accent" : "neutral"}>{humanize(t.taskType)}</Badge>
                        </td>
                        <td>
                          <div className="font-500">{t.title}</div>
                          {t.description && (
                            <div className="mt-0.5 text-2xs text-[var(--c-text-secondary)]">{t.description}</div>
                          )}
                          {!t.assigneeId && t.assignedRoleCode && (
                            <div className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">
                              Assigned to the {humanize(t.assignedRoleCode)} role — anyone holding it may action this
                            </div>
                          )}
                        </td>
                        <td className="mono text-2xs">{t.documentRef}</td>
                        <td>
                          <Badge
                            tone={t.priority === "URGENT" ? "danger" : t.priority === "HIGH" ? "warning" : "neutral"}
                          >
                            {humanize(t.priority)}
                          </Badge>
                        </td>
                        <td className="text-xs">
                          {t.dueAt ? (
                            <span className={isOverdue ? "font-500 text-[var(--c-danger)]" : undefined}>
                              {relativeTime(t.dueAt)}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>
                          {t.linkUrl && (
                            <Link href={t.linkUrl} className="btn btn-secondary btn-xs">
                              Open
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </SectionCard>
        ),
      )}

      {tasks.length === 0 && queueItems.length === 0 && pendingVotes.length === 0 && returned.length === 0 && (
        <SectionCard title="Tasks">
          <EmptyState
            title="Nothing is waiting on you"
            description="When a requisition needs your approval, goods arrive for your store, an inspection is assigned to you or an invoice needs verification, it will appear here."
          />
        </SectionCard>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        <SectionCard title="My drafts" description="Requisitions not yet submitted" bodyClassName="px-0 py-0">
          {drafts.length === 0 ? (
            <EmptyState compact title="No drafts" />
          ) : (
            <ul className="divide-y divide-[var(--c-border-subtle)]">
              {drafts.map((d) => (
                <li key={d.id} className="px-4 py-2.5">
                  <Link href={`/pr/${d.id}`} className="group block">
                    <div className="flex items-center gap-2">
                      <span className="mono text-[var(--c-accent-text)]">{d.number}</span>
                      <Badge tone="neutral">{d.entity.code}</Badge>
                      <span className="tnum ml-auto text-2xs text-[var(--c-text-tertiary)]">
                        {d.items.length} line(s)
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs font-500 group-hover:underline">{d.title}</p>
                    <p className="text-2xs text-[var(--c-text-tertiary)]">Updated {relativeTime(d.updatedAt)}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="My live cases" description="Requisitions you raised or manage" bodyClassName="px-0 py-0">
          {myCases.length === 0 ? (
            <EmptyState compact title="No live cases" />
          ) : (
            <ul className="divide-y divide-[var(--c-border-subtle)]">
              {myCases.map((c) => (
                <li key={c.id} className="px-4 py-2.5">
                  <Link href={`/pr/${c.id}`} className="group block">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mono text-[var(--c-accent-text)]">{c.number}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    <p className="mt-0.5 truncate text-xs font-500 group-hover:underline">{c.title}</p>
                    <p className="text-2xs text-[var(--c-text-tertiary)]">
                      {c.entity.code} · {c.department.name} · {money(c.estimatedValue, "PKR", { compact: true })}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Exceptions I own" bodyClassName="px-0 py-0">
          {exceptionsOwned.length === 0 ? (
            <EmptyState compact title="None assigned to you" />
          ) : (
            <ul className="divide-y divide-[var(--c-border-subtle)]">
              {exceptionsOwned.map((e) => (
                <li key={e.id} className="px-4 py-2.5">
                  <Link href={`/analytics/exceptions/${e.id}`} className="group block">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mono text-[var(--c-accent-text)]">{e.number}</span>
                      <Badge tone={SEVERITY_TONE[e.severity] ?? "neutral"}>{humanize(e.severity)}</Badge>
                      {e.blocking && <Badge tone="danger">Blocking</Badge>}
                    </div>
                    <p className="mt-0.5 text-xs font-500 group-hover:underline">{e.title}</p>
                    <p className="text-2xs text-[var(--c-text-tertiary)]">
                      {e.documentRef} · raised {relativeTime(e.createdAt)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard
          title="Recent notifications"
          actions={
            <Link href="/alerts" className="btn btn-ghost btn-xs">
              All alerts
            </Link>
          }
          bodyClassName="px-0 py-0"
        >
          {notifications.length === 0 ? (
            <EmptyState compact title="No notifications" />
          ) : (
            <ul className="divide-y divide-[var(--c-border-subtle)]">
              {notifications.map((n) => (
                <li key={n.id} className="px-4 py-2.5">
                  {n.linkUrl ? (
                    <Link href={n.linkUrl} className="group block">
                      <NotificationBody n={n} />
                    </Link>
                  ) : (
                    <NotificationBody n={n} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="My recent activity"
          description="Actions you have taken, drawn from the audit trail"
          bodyClassName="px-0 py-0"
        >
          {recentActivity.length === 0 ? (
            <EmptyState compact title="No recorded activity yet" />
          ) : (
            <ul className="divide-y divide-[var(--c-border-subtle)]">
              {recentActivity.map((a) => (
                <li key={a.id} className="flex items-baseline justify-between gap-3 px-4 py-2">
                  <span className="min-w-0">
                    <span className="text-xs">{humanize(a.action)}</span>
                    {a.entityRef && (
                      <span className="mono ml-2 text-2xs text-[var(--c-text-tertiary)]">{a.entityRef}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-2xs text-[var(--c-text-tertiary)]">{fmtDateTime(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

function NotificationBody({
  n,
}: {
  n: { title: string; body: string | null; read: boolean; priority: string; createdAt: Date };
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {!n.read && (
          <span
            className="size-1.5 rounded-full"
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
        <span className={n.read ? "text-xs text-[var(--c-text-secondary)]" : "text-xs font-500"}>{n.title}</span>
        <span className="ml-auto text-2xs text-[var(--c-text-tertiary)]">{relativeTime(n.createdAt)}</span>
      </div>
      {n.body && <p className="mt-0.5 text-2xs leading-4 text-[var(--c-text-tertiary)]">{n.body}</p>}
    </>
  );
}
