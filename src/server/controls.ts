import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { DOMAIN_ACTIONS, assertAuthority, type Actor } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { notify, usersForRoles } from "@/lib/notify";
import { raiseException } from "@/lib/exceptions-service";

/**
 * The control calendar, and escalation of things nobody has picked up.
 *
 * ## The calendar
 *
 * The SOP scatters recurring obligations through its text — the internal auditor
 * audits the store monthly, monthly repeat requisitions are compiled, vendor
 * performance is evaluated, pre-qualifications lapse — and nothing in the system
 * knew any of them were due. Each depended on somebody remembering, which is not
 * a control.
 *
 * Two decisions shape it.
 *
 * **A run exists for the period, not for the act.** The row is created when the
 * period opens and sits there empty until somebody performs the control. A
 * calendar that only records what was done cannot tell you what was not, which
 * is the only question worth asking of it.
 *
 * **Controls are owned by a role, not a person.** People leave and the
 * obligation does not. The run names the individual who performed it; the
 * definition names the office that owes it.
 *
 * ## Escalation
 *
 * An exception with an owner and a due date is a record. It becomes a control
 * when somebody has to say they have seen it and when saying nothing has a
 * consequence.
 *
 * Acknowledgement is deliberately separate from resolution. "I know about this"
 * and "this is dealt with" are different claims, and collapsing them means an
 * owner cannot tell you they are on it without also telling you it is finished.
 */

export const FREQUENCIES = [
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "HALF_YEARLY",
  "ANNUAL",
] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  DAILY: "Daily",
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  HALF_YEARLY: "Every six months",
  ANNUAL: "Annually",
};

/** The period a date falls in, for a given frequency. */
export function periodFor(
  frequency: Frequency,
  at: Date = new Date(),
): { label: string; start: Date; end: Date } {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const d = at.getUTCDate();

  const utc = (year: number, month: number, day: number) => new Date(Date.UTC(year, month, day));

  switch (frequency) {
    case "DAILY": {
      const start = utc(y, m, d);
      return {
        label: start.toISOString().slice(0, 10),
        start,
        end: new Date(start.getTime() + 86400000 - 1),
      };
    }
    case "WEEKLY": {
      // ISO weeks start Monday. getUTCDay() gives 0 for Sunday, so Sunday is
      // day 7 of the week that began six days earlier, not the start of a new one.
      const dow = at.getUTCDay() === 0 ? 7 : at.getUTCDay();
      const start = utc(y, m, d - (dow - 1));
      const end = new Date(start.getTime() + 7 * 86400000 - 1);
      return { label: `${start.toISOString().slice(0, 10)} week`, start, end };
    }
    case "MONTHLY": {
      const start = utc(y, m, 1);
      const end = new Date(utc(y, m + 1, 1).getTime() - 1);
      return { label: `${y}-${String(m + 1).padStart(2, "0")}`, start, end };
    }
    case "QUARTERLY": {
      const q = Math.floor(m / 3);
      const start = utc(y, q * 3, 1);
      const end = new Date(utc(y, q * 3 + 3, 1).getTime() - 1);
      return { label: `${y}-Q${q + 1}`, start, end };
    }
    case "HALF_YEARLY": {
      const h = m < 6 ? 0 : 1;
      const start = utc(y, h * 6, 1);
      const end = new Date(utc(y, h * 6 + 6, 1).getTime() - 1);
      return { label: `${y}-H${h + 1}`, start, end };
    }
    case "ANNUAL": {
      const start = utc(y, 0, 1);
      const end = new Date(utc(y + 1, 0, 1).getTime() - 1);
      return { label: String(y), start, end };
    }
  }
}

/**
 * Opens the run for the current period of every active control, and closes off
 * periods that have passed unperformed.
 *
 * Idempotent: a run already open for a period is left alone, so this can run as
 * often as anybody likes. A period that has passed its grace with nothing
 * recorded becomes `MISSED` — not deleted, and not quietly rolled forward,
 * because a missed control is the finding.
 */
export async function rollControlCalendar(
  actor: Actor,
  db: DbClient = prisma,
): Promise<{ opened: number; missed: number; notified: number }> {
  assertAuthority(actor, DOMAIN_ACTIONS.CONTROL_CALENDAR_ROLL, {
    permission: [P.AUDIT_VIEW, P.CONFIG_MANAGE],
  });

  const definitions = await db.controlDefinition.findMany({
    where: { active: true, awaitingRollout: false },
  });
  const now = new Date();

  let opened = 0;
  for (const def of definitions) {
    const period = periodFor(def.frequency as Frequency, now);
    const dueAt = new Date(period.end.getTime() + def.graceDays * 86400000);
    const existing = await db.controlRun.findFirst({
      where: { definitionId: def.id, periodLabel: period.label },
      select: { id: true },
    });
    if (existing) continue;
    await db.controlRun.create({
      data: {
        definitionId: def.id,
        periodLabel: period.label,
        periodStart: period.start,
        periodEnd: period.end,
        dueAt,
        status: "DUE",
      },
    });
    opened += 1;
  }

  // Anything still DUE past its due date has been missed. Marked, not moved.
  const overdue = await db.controlRun.findMany({
    where: { status: "DUE", dueAt: { lt: now } },
    include: { definition: { select: { name: true, ownerRoleCode: true, entityId: true } } },
    take: 500,
  });
  for (const run of overdue) {
    await db.controlRun.update({ where: { id: run.id }, data: { status: "MISSED" } });
  }

  let notified = 0;
  if (overdue.length) {
    const roles = [
      ...new Set(overdue.map((r) => r.definition.ownerRoleCode).filter((x): x is string => !!x)),
    ];
    notified = await notify(
      {
        roleCodes: roles.length ? roles : ["AUDIT_USER"],
        type: "GENERAL",
        priority: "HIGH",
        title: `${overdue.length} control${overdue.length === 1 ? "" : "s"} missed`,
        body: overdue
          .slice(0, 8)
          .map((r) => `${r.definition.name} (${r.periodLabel})`)
          .join(", "),
        linkType: "CONTROL",
        linkUrl: "/analytics/controls",
      },
      db,
    );
  }

  return { opened, missed: overdue.length, notified };
}

/** Records that a control was performed. */
export async function performControl(
  user: SessionUser,
  input: { runId: string; evidenceRef?: string | null; notes?: string | null },
  db: DbClient = prisma,
) {
  const run = await db.controlRun.findUnique({
    where: { id: input.runId },
    include: { definition: { select: { name: true, code: true, ownerRoleCode: true } } },
  });
  if (!run) throw new NotFoundError("Control run");
  if (["COMPLETED", "WAIVED", "NOT_APPLICABLE"].includes(run.status)) {
    throw new RuleViolationError(
      `${run.definition.name} for ${run.periodLabel} is already ${run.status.replace(/_/g, " ").toLowerCase()}.`,
    );
  }

  // Whoever owns the control performs it. Where a role is named, holding that
  // role is what counts; otherwise audit or config authority stands in, so a
  // control with no owner yet is not unperformable.
  const owns = run.definition.ownerRoleCode
    ? user.roleCodes.includes(run.definition.ownerRoleCode)
    : false;
  if (!owns && !userHasPermission(user, P.AUDIT_VIEW, P.CONFIG_MANAGE)) {
    throw new RuleViolationError(
      run.definition.ownerRoleCode
        ? `${run.definition.name} is owned by ${run.definition.ownerRoleCode.replace(/_/g, " ").toLowerCase()}.`
        : "You do not have permission to record this control.",
    );
  }

  const updated = await db.controlRun.update({
    where: { id: run.id },
    data: {
      status: "COMPLETED",
      performedById: user.id,
      performedAt: new Date(),
      evidenceRef: input.evidenceRef?.trim() || null,
      notes: input.notes?.trim() || null,
    },
  });
  await writeAudit(
    {
      entityType: "ControlRun",
      entityId: run.id,
      entityRef: `${run.definition.code} ${run.periodLabel}`,
      action: "CONTROL_PERFORMED",
      newValue: { by: user.name, evidence: input.evidenceRef?.trim() ?? null },
      reason: input.notes?.trim() ?? null,
      actor: user,
    },
    db,
  );
  return updated;
}

/**
 * Excuses a control for one period.
 *
 * Needs a reason, and stays visible as a waiver rather than becoming
 * indistinguishable from a control that was performed. The two are different
 * facts about the period.
 */
export async function waiveControl(
  user: SessionUser,
  input: { runId: string; reason: string; notApplicable?: boolean },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.AUDIT_VIEW, P.CONFIG_MANAGE)) {
    throw new RuleViolationError("Excusing a control needs audit or configuration authority.");
  }
  if (!input.reason?.trim() || input.reason.trim().length < 8) {
    throw new ValidationError(
      "Say why the control was not performed. A waiver with no reason is indistinguishable from an oversight.",
    );
  }
  const run = await db.controlRun.findUnique({
    where: { id: input.runId },
    include: { definition: { select: { name: true, code: true } } },
  });
  if (!run) throw new NotFoundError("Control run");
  if (run.status === "COMPLETED") {
    throw new RuleViolationError(
      `${run.definition.name} for ${run.periodLabel} was performed. There is nothing to excuse.`,
    );
  }

  const updated = await db.controlRun.update({
    where: { id: run.id },
    data: {
      status: input.notApplicable ? "NOT_APPLICABLE" : "WAIVED",
      waivedById: user.id,
      waivedAt: new Date(),
      waiverReason: input.reason.trim(),
    },
  });
  await writeAudit(
    {
      entityType: "ControlRun",
      entityId: run.id,
      entityRef: `${run.definition.code} ${run.periodLabel}`,
      action: input.notApplicable ? "CONTROL_NOT_APPLICABLE" : "CONTROL_WAIVED",
      newValue: { by: user.name },
      reason: input.reason.trim(),
      actor: user,
    },
    db,
  );
  return updated;
}

export type CalendarRow = {
  runId: string;
  code: string;
  name: string;
  sourceReference: string | null;
  frequency: string;
  frequencyLabel: string;
  ownerRoleCode: string | null;
  periodLabel: string;
  dueAt: Date;
  status: string;
  performedByName: string | null;
  performedAt: Date | null;
  evidenceRef: string | null;
  waiverReason: string | null;
  actionUrl: string | null;
  overdueDays: number | null;
};

/** The calendar as it stands, worst first. */
export async function controlCalendar(
  filter: { entityId?: string | null; status?: string | null; periods?: number } = {},
  db: DbClient = prisma,
): Promise<{ rows: CalendarRow[]; awaitingRollout: Array<{ code: string; name: string; sourceReference: string | null }> }> {
  const runs = await db.controlRun.findMany({
    where: {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.entityId
        ? { definition: { OR: [{ entityId: filter.entityId }, { entityId: null }] } }
        : {}),
    },
    include: {
      definition: true,
      performedBy: { select: { name: true } },
    },
    orderBy: [{ dueAt: "desc" }],
    take: (filter.periods ?? 6) * 40,
  });

  const now = Date.now();
  const rank: Record<string, number> = {
    MISSED: 0,
    DUE: 1,
    WAIVED: 2,
    NOT_APPLICABLE: 3,
    COMPLETED: 4,
  };

  const rows: CalendarRow[] = runs
    .map((r) => ({
      runId: r.id,
      code: r.definition.code,
      name: r.definition.name,
      sourceReference: r.definition.sourceReference,
      frequency: r.definition.frequency,
      frequencyLabel:
        FREQUENCY_LABELS[r.definition.frequency as Frequency] ?? r.definition.frequency,
      ownerRoleCode: r.definition.ownerRoleCode,
      periodLabel: r.periodLabel,
      dueAt: r.dueAt,
      status: r.status,
      performedByName: r.performedBy?.name ?? null,
      performedAt: r.performedAt,
      evidenceRef: r.evidenceRef,
      waiverReason: r.waiverReason,
      actionUrl: r.definition.actionUrl,
      overdueDays:
        r.status === "MISSED" || (r.status === "DUE" && r.dueAt.getTime() < now)
          ? Math.floor((now - r.dueAt.getTime()) / 86400000)
          : null,
    }))
    .sort(
      (a, b) =>
        (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.dueAt.getTime() - a.dueAt.getTime(),
    );

  // Controls that exist in policy but are not being run. Shown rather than
  // hidden: a calendar that silently omits what it is not doing is worse than
  // one that admits it.
  const awaitingRollout = await db.controlDefinition.findMany({
    where: { active: true, awaitingRollout: true },
    select: { code: true, name: true, sourceReference: true },
    orderBy: { code: "asc" },
  });

  return { rows, awaitingRollout };
}

/* ── Exception acknowledgement and escalation ───────────────── */

/**
 * The owner says they have seen it.
 *
 * Only the owner, and only where there is one. An exception acknowledged by
 * somebody who does not own it tells you nothing about whether the person who
 * has to act knows.
 */
export async function acknowledgeException(
  user: SessionUser,
  input: { exceptionId: string; note?: string | null },
  db: DbClient = prisma,
) {
  const ex = await db.exception.findUnique({
    where: { id: input.exceptionId },
    select: { id: true, number: true, ownerId: true, status: true, acknowledgedAt: true, title: true },
  });
  if (!ex) throw new NotFoundError("Exception");
  if (ex.acknowledgedAt) {
    throw new RuleViolationError(`${ex.number} has already been acknowledged.`);
  }
  if (["RESOLVED", "CLOSED", "WAIVED", "ACCEPTED"].includes(ex.status)) {
    throw new RuleViolationError(`${ex.number} is ${ex.status.toLowerCase()}.`);
  }
  if (ex.ownerId && ex.ownerId !== user.id && !userHasPermission(user, P.EXCEPTION_MANAGE)) {
    throw new RuleViolationError(
      "This exception is owned by somebody else. An acknowledgement from a third party says nothing about whether the person who has to act knows.",
    );
  }

  const updated = await db.exception.update({
    where: { id: ex.id },
    data: {
      acknowledgedById: user.id,
      acknowledgedAt: new Date(),
      status: ex.status === "OPEN" ? "IN_PROGRESS" : ex.status,
    },
  });
  await writeAudit(
    {
      entityType: "Exception",
      entityId: ex.id,
      entityRef: ex.number,
      action: "EXCEPTION_ACKNOWLEDGED",
      newValue: { by: user.name },
      reason: input.note?.trim() ?? null,
      actor: user,
    },
    db,
  );
  return updated;
}

/**
 * Tells somebody when an approval has sat past its SLA.
 *
 * Every approval step carries `slaHours`, and the due date it produced was read
 * in exactly one place: when an approver finally acted, to note that they were
 * late. That is the one moment lateness no longer matters. A step nobody touched
 * had no deadline at all in practice — it simply waited.
 *
 * What this does **not** do is move the approval. The assigned approver remains
 * the only person who can decide it. Delegation is the sanctioned way to hand
 * that over, with dates and a scope; letting a missed deadline transfer
 * authority would turn every SLA breach into a route around the approver, which
 * is the opposite of a control.
 *
 * So escalation here means: tell the approver's manager, count it on the step,
 * and raise a tracked APPROVAL_DELAY exception owned by the manager — which then
 * climbs the same ladder as every other exception through
 * `escalateOverdueExceptions`. One mechanism, not two.
 *
 * `stuck` counts steps whose approver has nobody above them in the organogram.
 * Reported, not hidden: a top-of-line approver sitting on a requisition is a
 * real situation and the sweep must not pretend it moved.
 */
export async function escalateOverdueApprovals(
  actor: Actor,
  opts: { maxLevel?: number; graceHours?: number } = {},
  db: DbClient = prisma,
): Promise<{ escalated: number; stuck: number; raised: number; notified: number }> {
  assertAuthority(actor, DOMAIN_ACTIONS.APPROVAL_ESCALATE, {
    permission: [P.EXCEPTION_MANAGE, P.AUDIT_VIEW],
  });

  const maxLevel = opts.maxLevel ?? 3;
  // A step is not escalated the second it turns overdue. An approver an hour
  // late does not need their manager told; the grace is what separates "late"
  // from "stalled".
  const graceHours = opts.graceHours ?? 24;
  const cutoff = new Date(Date.now() - graceHours * 3_600_000);

  const overdue = await db.approvalAction.findMany({
    where: {
      action: "PENDING",
      dueAt: { not: null, lte: cutoff },
      escalationLevel: { lt: maxLevel },
    },
    include: {
      instance: {
        select: {
          id: true,
          documentType: true,
          documentId: true,
          documentRef: true,
          entityId: true,
          status: true,
          currentSequence: true,
        },
      },
    },
    take: 200,
  });

  let escalated = 0;
  let stuck = 0;
  let raised = 0;
  const told = new Set<string>();

  for (const step of overdue) {
    // Only the step actually being waited on. A later step in the same chain has
    // a due date too, and it is not late — nobody has been asked yet.
    if (step.instance.status !== "PENDING" || step.sequence !== step.instance.currentSequence) continue;

    // Who is waited on. A step assigned by role has no single person, so the
    // holders of that role are the ones sitting on it, and their managers are
    // who hears about it.
    const waitingOn = step.actorId
      ? await db.user.findMany({
          where: { id: step.actorId },
          select: { id: true, name: true, reportsToId: true },
        })
      : step.assignedRoleCode
        ? await db.user.findMany({
            where: {
              active: true,
              roles: { some: { role: { code: step.assignedRoleCode } } },
              ...(step.instance.entityId
                ? {
                    OR: [
                      { primaryEntityId: step.instance.entityId },
                      { entityAccess: { some: { entityId: step.instance.entityId } } },
                    ],
                  }
                : {}),
            },
            select: { id: true, name: true, reportsToId: true },
          })
        : [];

    const managerIds = [...new Set(waitingOn.map((u) => u.reportsToId).filter((v): v is string => Boolean(v)))];
    if (managerIds.length === 0) {
      stuck += 1;
      continue;
    }
    const managers = await db.user.findMany({
      where: { id: { in: managerIds }, active: true },
      select: { id: true, name: true },
    });
    if (managers.length === 0) {
      stuck += 1;
      continue;
    }

    const lateBy = step.dueAt ? Math.floor((Date.now() - step.dueAt.getTime()) / 3_600_000) : 0;
    const owner = managers[0];

    await db.approvalAction.update({
      where: { id: step.id },
      data: {
        escalationLevel: step.escalationLevel + 1,
        escalatedAt: new Date(),
        escalatedToId: owner.id,
      },
    });
    escalated += 1;

    // The tracked object, so this appears on the exceptions board rather than
    // only in a notification somebody may not read. `raiseException` will not
    // stack a second open APPROVAL_DELAY on the same document, so a repeat sweep
    // updates rather than multiplies.
    const ex = await raiseException(
      {
        type: "APPROVAL_DELAY",
        severity: step.escalationLevel >= 1 ? "HIGH" : "MEDIUM",
        title: `${step.instance.documentRef} — "${step.stepName}" overdue by ${lateBy}h`,
        description:
          `${step.instance.documentType} ${step.instance.documentRef} has waited at "${step.stepName}" since ` +
          `${step.assignedAt.toISOString().slice(0, 10)} and was due ${step.dueAt?.toISOString().slice(0, 10)}. ` +
          `Waiting on ${waitingOn.map((u) => u.name).join(", ") || step.assignedRoleCode || "an unassigned step"}. ` +
          `Escalated to ${owner.name}. The approval has not moved — only who has been told.`,
        documentType: step.instance.documentType,
        documentId: step.instance.documentId,
        documentRef: step.instance.documentRef,
        entityId: step.instance.entityId,
        ownerId: owner.id,
        blocking: false,
        dueInHours: 48,
      },
      db,
      actor,
    );
    if (ex) raised += 1;

    const fresh = managers.filter((m) => !told.has(m.id));
    for (const m of fresh) told.add(m.id);
    if (fresh.length) {
      await notify(
        {
          userIds: fresh.map((m) => m.id),
          entityId: step.instance.entityId,
          type: "APPROVAL_ESCALATED",
          priority: "HIGH",
          title: `Approval overdue: ${step.instance.documentRef}`,
          body:
            `"${step.stepName}" has been pending ${lateBy}h past its deadline. ` +
            `It still sits with ${waitingOn.map((u) => u.name).join(", ") || step.assignedRoleCode}; ` +
            `you are being told, not asked to decide it.`,
          linkType: step.instance.documentType,
          linkId: step.instance.documentId,
          linkUrl: linkFor(step.instance.documentType, step.instance.documentId),
        },
        db,
      );
    }

    await writeAudit(
      {
        entityType: "ApprovalAction",
        entityId: step.id,
        entityRef: step.instance.documentRef,
        action: "APPROVAL_ESCALATED",
        newValue: {
          step: step.stepName,
          overdueHours: lateBy,
          level: step.escalationLevel + 1,
          escalatedTo: owner.name,
          waitingOn: waitingOn.map((u) => u.name),
        },
        actor,
      },
      db,
    );
  }

  return { escalated, stuck, raised, notified: told.size };
}

/** Where a notification about an overdue approval should point. */
function linkFor(documentType: string, documentId: string): string {
  switch (documentType) {
    case "PR":
    case "MATERIAL_DEMAND":
      return `/pr/${documentId}`;
    case "PO":
      return `/po/${documentId}`;
    case "INVOICE":
      return `/invoices/${documentId}`;
    case "PETTY_CASH":
      return `/petty-cash/${documentId}`;
    default:
      return "/alerts";
  }
}

/**
 * Pushes unacknowledged overdue exceptions up the reporting line.
 *
 * Walks the organogram from the current owner to their manager. Where there is
 * no manager to escalate to, the exception is left where it is and reported as
 * un-escalatable rather than silently marked escalated — a top-of-line owner
 * with an overdue exception is a real situation, and pretending it moved would
 * hide it.
 *
 * Only escalates what nobody has acknowledged. An owner who has said they are on
 * it does not need their manager told, and escalating anyway is how an
 * escalation stops meaning anything.
 */
export async function escalateOverdueExceptions(
  actor: Actor,
  opts: { maxLevel?: number } = {},
  db: DbClient = prisma,
): Promise<{ escalated: number; stuck: number; notified: number }> {
  assertAuthority(actor, DOMAIN_ACTIONS.EXCEPTION_ESCALATE, {
    permission: [P.EXCEPTION_MANAGE, P.AUDIT_VIEW],
  });

  const maxLevel = opts.maxLevel ?? 3;
  const due = await db.exception.findMany({
    where: {
      status: { in: ["OPEN", "IN_PROGRESS"] },
      acknowledgedAt: null,
      dueAt: { not: null, lte: new Date() },
      escalationLevel: { lt: maxLevel },
    },
    include: {
      // `reportsTo` is the organogram's own line, which may differ from a
      // grade's default parent — the org module treats that as authoritative and
      // so does this.
      owner: { select: { id: true, name: true, reportsToId: true } },
      escalatedTo: { select: { id: true, name: true, reportsToId: true } },
    },
    take: 300,
  });

  let escalated = 0;
  let stuck = 0;
  const told = new Set<string>();

  for (const ex of due) {
    // Escalate from wherever it currently sits: the last person it went to, or
    // the original owner.
    const from = ex.escalatedTo ?? ex.owner;
    const nextId = from?.reportsToId ?? null;
    if (!nextId) {
      stuck += 1;
      continue;
    }
    const next = await db.user.findUnique({
      where: { id: nextId },
      select: { id: true, name: true, active: true },
    });
    if (!next?.active) {
      stuck += 1;
      continue;
    }

    await db.exception.update({
      where: { id: ex.id },
      data: {
        escalationLevel: ex.escalationLevel + 1,
        escalatedToId: next.id,
        escalatedAt: new Date(),
        escalationNote:
          `Overdue since ${ex.dueAt?.toISOString().slice(0, 10)} and unacknowledged by ` +
          `${from?.name ?? "its owner"}.`,
      },
    });
    await writeAudit(
      {
        entityType: "Exception",
        entityId: ex.id,
        entityRef: ex.number,
        action: "EXCEPTION_ESCALATED",
        newValue: { level: ex.escalationLevel + 1, to: next.name, from: from?.name ?? null },
        actor,
      },
      db,
    );
    told.add(next.id);
    escalated += 1;
  }

  let notified = 0;
  if (told.size) {
    notified = await notify(
      {
        userIds: [...told],
        type: "EXCEPTION_RAISED",
        priority: "HIGH",
        title: `${escalated} overdue exception${escalated === 1 ? "" : "s"} escalated to you`,
        body: "Each was past its due date with no acknowledgement from its owner.",
        linkType: "EXCEPTION",
        linkUrl: "/analytics/exceptions",
      },
      db,
    );
  }

  return { escalated, stuck, notified };
}

/** Who currently holds an exception — the escalation target, or the owner. */
export async function exceptionHolders(
  exceptionIds: string[],
  db: DbClient = prisma,
): Promise<Map<string, string>> {
  if (!exceptionIds.length) return new Map();
  const rows = await db.exception.findMany({
    where: { id: { in: exceptionIds } },
    select: {
      id: true,
      owner: { select: { name: true } },
      escalatedTo: { select: { name: true } },
    },
  });
  return new Map(
    rows.map((r) => [r.id, r.escalatedTo?.name ?? r.owner?.name ?? "unassigned"]),
  );
}

/** Roles that hold a control, for the calendar screen. */
export async function controlOwners(
  roleCodes: string[],
  db: DbClient = prisma,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const code of [...new Set(roleCodes)]) {
    out.set(code, (await usersForRoles([code], null, db)).length);
  }
  return out;
}
