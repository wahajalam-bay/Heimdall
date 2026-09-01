import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { assertEntityAccess, userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { round2 } from "@/lib/format";
import { checklistLines } from "@/server/buildout-checklist";

/**
 * Build-outs — ZAM/PUR/SOP-01's Build-Outs section.
 *
 * The SOP describes a sequence, and the sequence is the control: management
 * decides, Admin gathers requirements, timelines are set early, the Cross
 * Functional Committee is called and hands every department its checklist, the
 * departments work to weekly deadlines reviewed each Friday, and the project
 * closes with a lesson-learnt report and a budget-versus-actual variance.
 *
 * What the module refuses is skipping a step: convening the committee before
 * requirements exist, or closing a project that never had its variance worked
 * out. Those refusals are the whole of the coordination the objective (BO-001)
 * asks for — a build-out that runs without them is ten departments guessing.
 */

export const BUILD_OUT_STATES = [
  "DRAFT",
  "PENDING_MANAGEMENT",
  "REQUIREMENTS",
  "TIMELINES",
  "CFC_PRESENTED",
  "IN_EXECUTION",
  "COMPLETED",
  "CLOSED",
  "CANCELLED",
] as const;
export type BuildOutState = (typeof BUILD_OUT_STATES)[number];

export const BUILD_OUT_STATE_LABELS: Record<BuildOutState, string> = {
  DRAFT: "Draft",
  PENDING_MANAGEMENT: "Awaiting management's go-ahead",
  REQUIREMENTS: "Gathering requirements",
  TIMELINES: "Setting timelines",
  CFC_PRESENTED: "Presented to the committee",
  IN_EXECUTION: "In execution",
  COMPLETED: "Complete, pending closure",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

export const BUILD_OUT_REGIONS = ["CENTRAL", "NORTH", "SOUTH"] as const;

export const TASK_STATES = ["NOT_STARTED", "IN_PROGRESS", "BLOCKED", "DONE", "NOT_APPLICABLE"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/* ── Raising one ──────────────────────────────────────────── */

export async function createBuildOut(
  user: SessionUser,
  input: {
    entityId: string;
    name: string;
    region: string;
    city?: string | null;
    projectId?: string | null;
    siteId?: string | null;
    budgetAmount?: number | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.BUILD_OUT_CREATE)) {
    throw new RuleViolationError("You do not have permission to raise a build-out.");
  }
  assertEntityAccess(user, input.entityId);
  if (!input.name.trim()) throw new ValidationError("Name the build-out.");
  if (!BUILD_OUT_REGIONS.includes(input.region as (typeof BUILD_OUT_REGIONS)[number])) {
    throw new ValidationError("Choose the region: Central, North or South.");
  }

  const number = await nextNumber(SEQ.BUILD_OUT, db);
  const buildOut = await db.buildOut.create({
    data: {
      number,
      name: input.name.trim(),
      entityId: input.entityId,
      region: input.region,
      city: input.city ?? null,
      projectId: input.projectId ?? null,
      siteId: input.siteId ?? null,
      budgetAmount: input.budgetAmount ?? null,
      status: "DRAFT",
      createdById: user.id,
    },
  });

  await writeAudit(
    {
      entityType: "BuildOut",
      entityId: buildOut.id,
      entityRef: buildOut.number,
      action: "BUILD_OUT_CREATED",
      newValue: { name: buildOut.name, region: buildOut.region },
      caseKey: buildOut.number,
      actor: user,
    },
    db,
  );
  return buildOut;
}

/* ── BO-002 · management's go-ahead ───────────────────────── */

/**
 * "Management gives go-ahead for a new project."
 *
 * A separate permission from raising one, and deliberately so: the first step
 * of the SOP is a decision by somebody other than the person who wants the
 * office built.
 */
export async function approveBuildOut(
  user: SessionUser,
  input: { buildOutId: string; note?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.BUILD_OUT_MANAGEMENT_APPROVE)) {
    throw new RuleViolationError("Only management can give the go-ahead for a build-out.");
  }
  const buildOut = await db.buildOut.findUnique({ where: { id: input.buildOutId } });
  if (!buildOut) throw new NotFoundError("Build-out");
  assertEntityAccess(user, buildOut.entityId);
  if (buildOut.managementApprovedAt) {
    throw new RuleViolationError(`${buildOut.number} already has management's go-ahead.`);
  }
  if (buildOut.createdById === user.id) {
    throw new RuleViolationError(
      "You raised this build-out, so you cannot also give it management's go-ahead. " +
        "The first step of the SOP is a decision by somebody else.",
    );
  }

  const updated = await db.buildOut.update({
    where: { id: buildOut.id },
    data: {
      managementApprovedById: user.id,
      managementApprovedAt: new Date(),
      managementNote: input.note?.trim() || null,
      status: "REQUIREMENTS",
    },
  });
  await writeAudit(
    {
      entityType: "BuildOut",
      entityId: buildOut.id,
      entityRef: buildOut.number,
      action: "BUILD_OUT_MANAGEMENT_APPROVED",
      newValue: { note: input.note ?? null },
      caseKey: buildOut.number,
      actor: user,
    },
    db,
  );
  return updated;
}

/* ── BO-004 · requirement gathering ───────────────────────── */

export async function recordRequirements(
  user: SessionUser,
  input: {
    buildOutId: string;
    headcount?: number | null;
    requirementsSummary: string;
    specialRequirements?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.BUILD_OUT_EDIT)) {
    throw new RuleViolationError("You do not have permission to edit a build-out.");
  }
  const buildOut = await db.buildOut.findUnique({ where: { id: input.buildOutId } });
  if (!buildOut) throw new NotFoundError("Build-out");
  assertEntityAccess(user, buildOut.entityId);
  if (!buildOut.managementApprovedAt) {
    throw new RuleViolationError(
      `${buildOut.number} has no management go-ahead yet. BO-002 puts that first, before requirements are gathered.`,
    );
  }
  if (!input.requirementsSummary.trim()) {
    throw new ValidationError(
      "Say what the departments asked for. BO-004 makes requirement gathering Admin's own step, and an empty summary is not one.",
    );
  }

  const updated = await db.buildOut.update({
    where: { id: buildOut.id },
    data: {
      headcount: input.headcount ?? null,
      requirementsSummary: input.requirementsSummary.trim(),
      specialRequirements: input.specialRequirements?.trim() || null,
      requirementsGatheredById: user.id,
      requirementsGatheredAt: new Date(),
      status: buildOut.status === "REQUIREMENTS" ? "TIMELINES" : buildOut.status,
    },
  });
  await writeAudit(
    {
      entityType: "BuildOut",
      entityId: buildOut.id,
      entityRef: buildOut.number,
      action: "BUILD_OUT_REQUIREMENTS_RECORDED",
      newValue: { headcount: input.headcount ?? null },
      caseKey: buildOut.number,
      actor: user,
    },
    db,
  );
  return updated;
}

/* ── BO-005, BO-006 · timelines defined early ─────────────── */

export async function setTimelines(
  user: SessionUser,
  input: { buildOutId: string; plannedStartDate: Date; plannedEndDate: Date },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.BUILD_OUT_EDIT)) {
    throw new RuleViolationError("You do not have permission to edit a build-out.");
  }
  const buildOut = await db.buildOut.findUnique({ where: { id: input.buildOutId } });
  if (!buildOut) throw new NotFoundError("Build-out");
  assertEntityAccess(user, buildOut.entityId);
  if (input.plannedEndDate <= input.plannedStartDate) {
    throw new ValidationError("The planned end date must come after the planned start.");
  }

  const updated = await db.buildOut.update({
    where: { id: buildOut.id },
    data: {
      plannedStartDate: input.plannedStartDate,
      plannedEndDate: input.plannedEndDate,
      timelinesSharedAt: new Date(),
      status: buildOut.status === "TIMELINES" ? "TIMELINES" : buildOut.status,
    },
  });
  await writeAudit(
    {
      entityType: "BuildOut",
      entityId: buildOut.id,
      entityRef: buildOut.number,
      action: "BUILD_OUT_TIMELINES_SET",
      newValue: {
        start: input.plannedStartDate.toISOString(),
        end: input.plannedEndDate.toISOString(),
      },
      caseKey: buildOut.number,
      actor: user,
    },
    db,
  );
  return updated;
}

/* ── BO-007 · call the committee and hand out the checklist ─ */

/**
 * Convenes the Cross Functional Committee and copies the checklist onto the
 * build-out.
 *
 * The SOP's order matters here: the committee is shown "project details and
 * scope", which means the requirements have to exist, and it is shown timelines,
 * which means those have to exist too. Calling it before either is the
 * coordination failure the whole section is written against.
 *
 * The checklist is copied, not referenced. A later revision of the document must
 * not rewrite what this project's departments were asked to do.
 */
export async function conveneCfc(
  user: SessionUser,
  input: { buildOutId: string; scheduledAt: Date; location?: string | null; agenda?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.BUILD_OUT_MEETING_MANAGE)) {
    throw new RuleViolationError("You do not have permission to call a committee meeting.");
  }
  return withTransaction(db, async (tx) => {
    const buildOut = await tx.buildOut.findUnique({
      where: { id: input.buildOutId },
      include: { tasks: { select: { id: true } } },
    });
    if (!buildOut) throw new NotFoundError("Build-out");
    assertEntityAccess(user, buildOut.entityId);

    const missing: string[] = [];
    if (!buildOut.managementApprovedAt) missing.push("management's go-ahead (BO-002)");
    if (!buildOut.requirementsGatheredAt) missing.push("the requirement gathering (BO-004)");
    if (!buildOut.plannedStartDate || !buildOut.plannedEndDate) missing.push("the timelines (BO-006)");
    if (missing.length) {
      throw new RuleViolationError(
        `${buildOut.number} cannot be presented to the committee without ${missing.join(", ")}. ` +
          "BO-007 presents project details, scope and timelines — there is nothing to present yet.",
      );
    }

    // Copy the checklist once. Convening again for a follow-up meeting must not
    // duplicate every department's tasks.
    let seeded = 0;
    if (buildOut.tasks.length === 0) {
      const lines = checklistLines();
      const departments = await tx.department.findMany({ select: { id: true, name: true } });
      const byName = new Map(departments.map((d) => [d.name.toLowerCase(), d.id]));
      await tx.buildOutTask.createMany({
        data: lines.map((l) => ({
          buildOutId: buildOut.id,
          departmentName: l.department,
          departmentId: byName.get(l.department.toLowerCase()) ?? null,
          responsibility: l.responsibility,
          sequence: l.sequence,
          dueDate: buildOut.plannedEndDate,
        })),
      });
      seeded = lines.length;
    }

    const number = await nextNumber(SEQ.CFC_MEETING, tx);
    const meeting = await tx.cfcMeeting.create({
      data: {
        number,
        buildOutId: buildOut.id,
        meetingType: "KICKOFF",
        scheduledAt: input.scheduledAt,
        location: input.location ?? null,
        agenda:
          input.agenda?.trim() ||
          "Project details and scope; departmental checklist handed out; stakeholders to add requirements or feedback.",
        calledById: user.id,
        status: "SCHEDULED",
      },
    });

    // Every seat on the roster gets an attendance row, so an absence is a
    // recorded fact rather than a missing one.
    const roster = await tx.cfcMember.findMany({
      where: { entityId: buildOut.entityId, active: true },
      select: { id: true },
    });
    if (roster.length) {
      await tx.cfcAttendance.createMany({
        data: roster.map((m) => ({ meetingId: meeting.id, memberId: m.id })),
      });
    }

    await tx.buildOut.update({
      where: { id: buildOut.id },
      data: { status: "CFC_PRESENTED" },
    });

    await writeAudit(
      {
        entityType: "BuildOut",
        entityId: buildOut.id,
        entityRef: buildOut.number,
        action: "BUILD_OUT_CFC_CONVENED",
        newValue: { meeting: meeting.number, checklistLines: seeded, seats: roster.length },
        caseKey: buildOut.number,
        actor: user,
      },
      tx,
    );
    return { meeting, checklistLines: seeded, seats: roster.length };
  });
}

/* ── BO-008, BO-009 · the weekly Friday review ────────────── */

/** The next Friday on or after a date, since BO-009 names Friday specifically. */
export function nextFriday(from: Date = new Date()): Date {
  const d = new Date(from);
  d.setHours(11, 0, 0, 0);
  const delta = (5 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + delta);
  return d;
}

export async function scheduleWeeklyReview(
  user: SessionUser,
  input: { buildOutId: string; scheduledAt?: Date | null; agenda?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.BUILD_OUT_MEETING_MANAGE)) {
    throw new RuleViolationError("You do not have permission to call a committee meeting.");
  }
  return withTransaction(db, async (tx) => {
    const buildOut = await tx.buildOut.findUnique({ where: { id: input.buildOutId } });
    if (!buildOut) throw new NotFoundError("Build-out");
    assertEntityAccess(user, buildOut.entityId);
    if (!["CFC_PRESENTED", "IN_EXECUTION"].includes(buildOut.status)) {
      throw new RuleViolationError(
        `${buildOut.number} is ${BUILD_OUT_STATE_LABELS[buildOut.status as BuildOutState] ?? buildOut.status}. ` +
          "The weekly review belongs to a project the committee has already been shown.",
      );
    }

    const number = await nextNumber(SEQ.CFC_MEETING, tx);
    const meeting = await tx.cfcMeeting.create({
      data: {
        number,
        buildOutId: buildOut.id,
        meetingType: "WEEKLY",
        scheduledAt: input.scheduledAt ?? nextFriday(),
        agenda: input.agenda?.trim() || "Weekly progress against the departmental checklist.",
        calledById: user.id,
        status: "SCHEDULED",
      },
    });
    const roster = await tx.cfcMember.findMany({
      where: { entityId: buildOut.entityId, active: true },
      select: { id: true },
    });
    if (roster.length) {
      await tx.cfcAttendance.createMany({
        data: roster.map((m) => ({ meetingId: meeting.id, memberId: m.id })),
      });
    }
    if (buildOut.status === "CFC_PRESENTED") {
      await tx.buildOut.update({ where: { id: buildOut.id }, data: { status: "IN_EXECUTION" } });
    }
    return meeting;
  });
}

/** BO-009 — minute the meeting and record who was there. */
export async function recordMeetingOutcome(
  user: SessionUser,
  input: {
    meetingId: string;
    minutes: string;
    heldAt?: Date | null;
    attendance?: Array<{ memberId: string; attendance: "PRESENT" | "PROXY" | "ABSENT"; proxyUserId?: string | null; note?: string | null }>;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.BUILD_OUT_MEETING_MANAGE)) {
    throw new RuleViolationError("You do not have permission to minute a committee meeting.");
  }
  if (!input.minutes.trim()) {
    throw new ValidationError("Record what the meeting decided. A meeting with no minutes did not happen on the record.");
  }
  return withTransaction(db, async (tx) => {
    const meeting = await tx.cfcMeeting.findUnique({
      where: { id: input.meetingId },
      include: { buildOut: { select: { id: true, number: true, entityId: true } } },
    });
    if (!meeting) throw new NotFoundError("Meeting");
    assertEntityAccess(user, meeting.buildOut.entityId);

    for (const a of input.attendance ?? []) {
      if (a.attendance === "PROXY" && !a.proxyUserId) {
        throw new ValidationError(
          "A seat marked as attended by proxy needs the proxy named. The roster names one for exactly this.",
        );
      }
      await tx.cfcAttendance.updateMany({
        where: { meetingId: meeting.id, memberId: a.memberId },
        data: {
          attendance: a.attendance,
          proxyUserId: a.attendance === "PROXY" ? a.proxyUserId ?? null : null,
          note: a.note ?? null,
        },
      });
    }

    const updated = await tx.cfcMeeting.update({
      where: { id: meeting.id },
      data: { minutes: input.minutes.trim(), heldAt: input.heldAt ?? new Date(), status: "HELD" },
    });
    await writeAudit(
      {
        entityType: "CfcMeeting",
        entityId: meeting.id,
        entityRef: meeting.number,
        action: "CFC_MEETING_HELD",
        caseKey: meeting.buildOut.number,
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/* ── The checklist itself ─────────────────────────────────── */

export async function updateTask(
  user: SessionUser,
  input: {
    taskId: string;
    status: TaskState;
    progressNote?: string | null;
    notApplicableReason?: string | null;
    ownerId?: string | null;
    dueDate?: Date | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.BUILD_OUT_TASK_UPDATE, P.BUILD_OUT_EDIT)) {
    throw new RuleViolationError("You do not have permission to update a build-out checklist.");
  }
  if (!TASK_STATES.includes(input.status)) throw new ValidationError("Unknown task state.");
  // A line waved away with no reason cannot be told apart from one nobody read.
  if (input.status === "NOT_APPLICABLE" && !input.notApplicableReason?.trim()) {
    throw new ValidationError(
      "Say why this responsibility does not apply to this build-out. The checklist is the document's own, so dropping a line needs a reason.",
    );
  }
  if (input.status === "BLOCKED" && !input.progressNote?.trim()) {
    throw new ValidationError("Say what is blocking it, so the Friday meeting has something to act on.");
  }

  const task = await db.buildOutTask.findUnique({
    where: { id: input.taskId },
    include: { buildOut: { select: { id: true, number: true, entityId: true, status: true } } },
  });
  if (!task) throw new NotFoundError("Checklist task");
  assertEntityAccess(user, task.buildOut.entityId);
  if (["CLOSED", "CANCELLED"].includes(task.buildOut.status)) {
    throw new RuleViolationError(`${task.buildOut.number} is closed. Its checklist is the record of what happened.`);
  }

  const updated = await db.buildOutTask.update({
    where: { id: task.id },
    data: {
      status: input.status,
      progressNote: input.progressNote?.trim() || task.progressNote,
      notApplicableReason:
        input.status === "NOT_APPLICABLE" ? input.notApplicableReason!.trim() : null,
      ownerId: input.ownerId === undefined ? task.ownerId : input.ownerId,
      dueDate: input.dueDate === undefined ? task.dueDate : input.dueDate,
      completedAt: input.status === "DONE" ? new Date() : null,
      updatedById: user.id,
    },
  });
  return updated;
}

/* ── BO-014 · BOQ against actual ──────────────────────────── */

export async function upsertBoqLine(
  user: SessionUser,
  input: {
    buildOutId: string;
    lineNo: number;
    description: string;
    unit: string;
    budgetQty: number;
    budgetRate: number;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.BUILD_OUT_EDIT)) {
    throw new RuleViolationError("You do not have permission to edit a build-out.");
  }
  const buildOut = await db.buildOut.findUnique({ where: { id: input.buildOutId } });
  if (!buildOut) throw new NotFoundError("Build-out");
  assertEntityAccess(user, buildOut.entityId);

  const budgetTotal = round2(input.budgetQty * input.budgetRate);
  return db.buildOutBoqLine.upsert({
    where: { buildOutId_lineNo: { buildOutId: buildOut.id, lineNo: input.lineNo } },
    create: {
      buildOutId: buildOut.id,
      lineNo: input.lineNo,
      description: input.description.trim(),
      unit: input.unit.trim(),
      budgetQty: input.budgetQty,
      budgetRate: input.budgetRate,
      budgetTotal,
    },
    update: {
      description: input.description.trim(),
      unit: input.unit.trim(),
      budgetQty: input.budgetQty,
      budgetRate: input.budgetRate,
      budgetTotal,
    },
  });
}

/**
 * BO-014 — "finalising measurements per actual against the defined BOQ".
 *
 * The measured figures sit beside the budget rather than replacing it, because
 * the variance is the deliverable and overwriting the budget would destroy it.
 */
export async function measureBoqLine(
  user: SessionUser,
  input: { lineId: string; actualQty: number; actualRate: number; varianceNote?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.BUILD_OUT_EDIT)) {
    throw new RuleViolationError("You do not have permission to edit a build-out.");
  }
  const line = await db.buildOutBoqLine.findUnique({
    where: { id: input.lineId },
    include: { buildOut: { select: { id: true, entityId: true, number: true } } },
  });
  if (!line) throw new NotFoundError("BOQ line");
  assertEntityAccess(user, line.buildOut.entityId);

  const actualTotal = round2(input.actualQty * input.actualRate);
  const variance = round2(actualTotal - line.budgetTotal);
  // A line that lands materially over budget without a word is the thing the
  // "real-time monitoring" in BO-014 exists to surface.
  const materiallyOver = line.budgetTotal > 0 && variance > line.budgetTotal * 0.1;
  if (materiallyOver && !input.varianceNote?.trim()) {
    throw new ValidationError(
      `This line comes in ${variance.toLocaleString("en-PK")} over a budget of ${line.budgetTotal.toLocaleString("en-PK")}. ` +
        "Say why — the closing variance analysis is presented to management and needs the reason, not just the number.",
    );
  }

  return withTransaction(db, async (tx) => {
    const updated = await tx.buildOutBoqLine.update({
      where: { id: line.id },
      data: {
        actualQty: input.actualQty,
        actualRate: input.actualRate,
        actualTotal,
        varianceNote: input.varianceNote?.trim() || null,
        measuredById: user.id,
        measuredAt: new Date(),
      },
    });
    const sum = await tx.buildOutBoqLine.aggregate({
      where: { buildOutId: line.buildOutId },
      _sum: { actualTotal: true },
    });
    await tx.buildOut.update({
      where: { id: line.buildOutId },
      data: { actualAmount: round2(sum._sum.actualTotal ?? 0) },
    });
    return updated;
  });
}

/* ── BO-015 · the day-wise vendor schedule ────────────────── */

export async function addScheduleDay(
  user: SessionUser,
  input: {
    buildOutId: string;
    day: Date;
    activity: string;
    vendorId?: string | null;
    vendorName?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.BUILD_OUT_EDIT)) {
    throw new RuleViolationError("You do not have permission to edit a build-out.");
  }
  const buildOut = await db.buildOut.findUnique({ where: { id: input.buildOutId } });
  if (!buildOut) throw new NotFoundError("Build-out");
  assertEntityAccess(user, buildOut.entityId);
  if (!input.activity.trim()) throw new ValidationError("Say what happens that day.");

  return db.buildOutScheduleDay.create({
    data: {
      buildOutId: buildOut.id,
      day: input.day,
      activity: input.activity.trim(),
      vendorId: input.vendorId ?? null,
      vendorName: input.vendorName?.trim() || null,
    },
  });
}

/** BO-015 — "ensuring compliance at regular intervals". */
export async function checkScheduleDay(
  user: SessionUser,
  input: { dayId: string; status: "ON_TRACK" | "SLIPPED" | "DONE"; slipReason?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.BUILD_OUT_EDIT, P.BUILD_OUT_TASK_UPDATE)) {
    throw new RuleViolationError("You do not have permission to update a build-out schedule.");
  }
  if (input.status === "SLIPPED" && !input.slipReason?.trim()) {
    throw new ValidationError("Say why the day slipped. A slipped day with no reason cannot be chased.");
  }
  const day = await db.buildOutScheduleDay.findUnique({
    where: { id: input.dayId },
    include: { buildOut: { select: { entityId: true } } },
  });
  if (!day) throw new NotFoundError("Schedule day");
  assertEntityAccess(user, day.buildOut.entityId);

  return db.buildOutScheduleDay.update({
    where: { id: day.id },
    data: {
      status: input.status,
      slipReason: input.status === "SLIPPED" ? input.slipReason!.trim() : null,
      checkedById: user.id,
      checkedAt: new Date(),
    },
  });
}

/* ── BO-010 · lessons and closure ─────────────────────────── */

export async function addLesson(
  user: SessionUser,
  input: {
    buildOutId: string;
    category: string;
    finding: string;
    recommendation?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.BUILD_OUT_EDIT, P.BUILD_OUT_CLOSE)) {
    throw new RuleViolationError("You do not have permission to record a lesson.");
  }
  const buildOut = await db.buildOut.findUnique({ where: { id: input.buildOutId } });
  if (!buildOut) throw new NotFoundError("Build-out");
  assertEntityAccess(user, buildOut.entityId);
  if (!input.finding.trim()) throw new ValidationError("Say what the shortcoming was.");

  return db.buildOutLesson.create({
    data: {
      buildOutId: buildOut.id,
      category: input.category,
      finding: input.finding.trim(),
      recommendation: input.recommendation?.trim() || null,
      raisedById: user.id,
    },
  });
}

/** Budget against actual, on cost and on time — the closing variance. */
export async function variance(buildOutId: string, db: DbClient = prisma) {
  const buildOut = await db.buildOut.findUnique({
    where: { id: buildOutId },
    include: { boqLines: true },
  });
  if (!buildOut) throw new NotFoundError("Build-out");

  const budget = round2(buildOut.boqLines.reduce((a, l) => a + l.budgetTotal, 0)) || buildOut.budgetAmount || 0;
  const actual = round2(buildOut.boqLines.reduce((a, l) => a + (l.actualTotal ?? 0), 0));
  const measured = buildOut.boqLines.filter((l) => l.actualTotal != null).length;

  const plannedDays =
    buildOut.plannedStartDate && buildOut.plannedEndDate
      ? Math.round(
          (buildOut.plannedEndDate.getTime() - buildOut.plannedStartDate.getTime()) / 86_400_000,
        )
      : null;
  const actualDays =
    buildOut.actualStartDate && buildOut.actualEndDate
      ? Math.round((buildOut.actualEndDate.getTime() - buildOut.actualStartDate.getTime()) / 86_400_000)
      : null;

  return {
    cost: {
      budget,
      actual,
      variance: round2(actual - budget),
      percent: budget > 0 ? round2(((actual - budget) / budget) * 100) : null,
      linesMeasured: measured,
      linesTotal: buildOut.boqLines.length,
    },
    timeline: {
      plannedDays,
      actualDays,
      variance: plannedDays != null && actualDays != null ? actualDays - plannedDays : null,
    },
  };
}

/**
 * BO-010 — closes the project with its report.
 *
 * Refuses while the checklist has open lines or the BOQ is unmeasured, because
 * the closing report is a variance analysis and a variance against an unmeasured
 * BOQ is a guess. A lesson-learnt report with no lessons is likewise not one.
 */
export async function closeBuildOut(
  user: SessionUser,
  input: { buildOutId: string; actualEndDate?: Date | null; summary?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.BUILD_OUT_CLOSE)) {
    throw new RuleViolationError("You do not have permission to close a build-out.");
  }
  return withTransaction(db, async (tx) => {
    const buildOut = await tx.buildOut.findUnique({
      where: { id: input.buildOutId },
      include: { tasks: true, boqLines: true, lessons: true },
    });
    if (!buildOut) throw new NotFoundError("Build-out");
    assertEntityAccess(user, buildOut.entityId);
    if (buildOut.status === "CLOSED") throw new RuleViolationError(`${buildOut.number} is already closed.`);

    const blockers: string[] = [];
    const open = buildOut.tasks.filter((t) => !["DONE", "NOT_APPLICABLE"].includes(t.status));
    if (open.length) {
      blockers.push(
        `${open.length} checklist responsibilit${open.length === 1 ? "y is" : "ies are"} still open: ` +
          open.slice(0, 4).map((t) => `${t.departmentName} — ${t.responsibility}`).join("; ") +
          (open.length > 4 ? `, and ${open.length - 4} more` : ""),
      );
    }
    const unmeasured = buildOut.boqLines.filter((l) => l.actualTotal == null);
    if (buildOut.boqLines.length && unmeasured.length) {
      blockers.push(
        `${unmeasured.length} BOQ line(s) have no measured actual. BO-014 asks for measurement against the BOQ after completion, and the closing variance is meaningless without it.`,
      );
    }
    if (buildOut.lessons.length === 0) {
      blockers.push(
        "No lesson-learnt entries. BO-010 asks for a report identifying loopholes and shortcomings, and an empty report is not one.",
      );
    }
    if (blockers.length) {
      throw new RuleViolationError(`${buildOut.number} cannot be closed.`, blockers);
    }

    const updated = await tx.buildOut.update({
      where: { id: buildOut.id },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        actualEndDate: input.actualEndDate ?? buildOut.actualEndDate ?? new Date(),
      },
    });

    const v = await variance(buildOut.id, tx);
    await writeAudit(
      {
        entityType: "BuildOut",
        entityId: buildOut.id,
        entityRef: buildOut.number,
        action: "BUILD_OUT_CLOSED",
        newValue: {
          costVariance: v.cost.variance,
          timelineVarianceDays: v.timeline.variance,
          lessons: buildOut.lessons.length,
          summary: input.summary ?? null,
        },
        caseKey: buildOut.number,
        actor: user,
      },
      tx,
    );

    // BO-010 presents the variance to management, so management is told.
    await notify(
      {
        roleCodes: ["MANAGEMENT_COMMITTEE"],
        entityId: buildOut.entityId,
        type: "BUILD_OUT_CLOSED",
        title: `${buildOut.number} closed — ${buildOut.name}`,
        body:
          `Cost ${v.cost.actual.toLocaleString("en-PK")} against a budget of ${v.cost.budget.toLocaleString("en-PK")}` +
          (v.cost.percent != null ? ` (${v.cost.percent > 0 ? "+" : ""}${v.cost.percent}%)` : "") +
          (v.timeline.variance != null
            ? `; ${v.timeline.variance > 0 ? `${v.timeline.variance} days late` : `${-v.timeline.variance} days early`}`
            : "") +
          `. ${buildOut.lessons.length} lesson(s) recorded.`,
        priority: "NORMAL",
        linkType: "BUILD_OUT",
        linkId: buildOut.id,
        linkUrl: `/build-outs/${buildOut.id}`,
      },
      tx,
    );
    return updated;
  });
}

/* ── Reading ──────────────────────────────────────────────── */

/** Checklist completion by department, which is what the Friday meeting reads. */
export async function checklistProgress(buildOutId: string, db: DbClient = prisma) {
  const tasks = await db.buildOutTask.findMany({
    where: { buildOutId },
    orderBy: { sequence: "asc" },
    include: { owner: { select: { name: true } } },
  });
  const byDepartment = new Map<string, typeof tasks>();
  for (const t of tasks) {
    const held = byDepartment.get(t.departmentName);
    if (held) held.push(t);
    else byDepartment.set(t.departmentName, [t]);
  }
  return [...byDepartment.entries()].map(([department, rows]) => ({
    department,
    total: rows.length,
    done: rows.filter((r) => r.status === "DONE").length,
    blocked: rows.filter((r) => r.status === "BLOCKED").length,
    notApplicable: rows.filter((r) => r.status === "NOT_APPLICABLE").length,
    rows,
  }));
}
