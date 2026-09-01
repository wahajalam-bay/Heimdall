import { prisma, type DbClient } from "@/lib/db";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { assertEntityAccess, userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";

/**
 * CPC composition, attendance and quorum — CP-003, CP-006, CP-007, CP-016.
 *
 * Case membership already existed, resolved from roles, and it answers a
 * different question: who ought to look at this. Whether the committee was
 * *properly constituted* to decide it is CP-006, and that needs counting:
 *
 *   "At least 3 permanent committee members present in addition to the Head of
 *    the requisitioner department. Alternatively all cases presented by the head
 *    or nominated proxy of the requisitioner department, failing which the case
 *    is deferred to the next CPC."
 *
 * Two things in that sentence do real work. The requisitioner's department head
 * is required *in addition to* the three, so counting them among the three would
 * let a committee of three sit as though it were four. And the stated remedy for
 * a short committee is deferral — not a decision taken anyway.
 *
 * CP-007 is why the roster carries a member type: an observer attends, and
 * neither votes nor counts toward the three.
 */

export const CPC_MEMBER_TYPES = ["PERMANENT_MANDATORY", "PERMANENT", "OBSERVER"] as const;
export type CpcMemberType = (typeof CPC_MEMBER_TYPES)[number];

export const CPC_MEMBER_TYPE_LABELS: Record<CpcMemberType, string> = {
  PERMANENT_MANDATORY: "Permanent — mandatory",
  PERMANENT: "Permanent",
  OBSERVER: "Observer (attends, does not vote or count)",
};

/** CP-006's figure. */
export const CPC_PERMANENT_QUORUM = 3;

export type CpcQuorumState = {
  /** Seats that count: permanent and permanent-mandatory, excluding observers. */
  votingSeats: number;
  observerSeats: number;
  required: number;
  present: number;
  /** CP-006's separate condition. */
  requisitionerHeadPresent: boolean;
  requisitionerHeadName: string | null;
  /** Present by a nominated proxy rather than in person. */
  presentByProxy: number;
  mandatoryAbsent: string[];
  quorate: boolean;
  reason: string;
  /** True when no standing roster exists for the entity at all. */
  rosterMissing: boolean;
};

/**
 * The quorum for one case, counted from the roster and the attendance sheet.
 *
 * Where no roster has been seeded the state says so rather than reporting a
 * quorum of zero as satisfied — an unconstituted committee is not a quorate one,
 * and silently passing would be the worst of the available answers.
 */
export async function cpcQuorumFor(caseId: string, db: DbClient = prisma): Promise<CpcQuorumState> {
  const kase = await db.cpcCase.findUnique({
    where: { id: caseId },
    include: {
      pr: { select: { entityId: true, department: { select: { name: true, headId: true } } } },
      attendance: { include: { member: true } },
    },
  });
  if (!kase) throw new NotFoundError("CPC case");

  const roster = await db.cpcRosterMember.findMany({
    where: { entityId: kase.pr.entityId, active: true },
  });

  const voting = roster.filter((m) => m.memberType !== "OBSERVER");
  const observers = roster.filter((m) => m.memberType === "OBSERVER");

  const attendedIds = new Set(
    kase.attendance
      .filter((a) => a.attendance === "PRESENT" || a.attendance === "PROXY")
      .map((a) => a.memberId),
  );
  const presentByProxy = kase.attendance.filter((a) => a.attendance === "PROXY").length;

  // The requisitioner's department head is a separate condition, so they are
  // excluded from the count of three even when they hold a roster seat.
  const headId = kase.pr.department.headId;
  const headSeat = headId ? roster.find((m) => m.userId === headId) : undefined;
  const requisitionerHeadPresent = headSeat
    ? attendedIds.has(headSeat.id)
    : // Where the head holds no roster seat, their attendance is recorded on the
      // case's own member list rather than the roster, and CP-006 is satisfied by
      // the case having been presented by them or their proxy.
      kase.attendance.some((a) => a.attendance !== "ABSENT" && a.member.userId === headId);

  const countableIds = new Set(voting.filter((m) => m.id !== headSeat?.id).map((m) => m.id));
  const present = [...attendedIds].filter((id) => countableIds.has(id)).length;

  const mandatoryAbsent = roster
    .filter((m) => m.memberType === "PERMANENT_MANDATORY" && !attendedIds.has(m.id))
    .map((m) => m.memberName);

  const rosterMissing = roster.length === 0;
  // Cap at what the entity can actually field, and say so, rather than demanding
  // a figure the composition cannot reach.
  const required = Math.min(CPC_PERMANENT_QUORUM, Math.max(countableIds.size, 0));

  const quorate =
    !rosterMissing &&
    required >= CPC_PERMANENT_QUORUM &&
    present >= required &&
    requisitionerHeadPresent &&
    mandatoryAbsent.length === 0;

  const reason = rosterMissing
    ? "No standing CPC composition is seeded for this company, so CP-003's nine seats do not exist and CP-006 cannot be counted."
    : required < CPC_PERMANENT_QUORUM
      ? `The roster can field only ${required} permanent member(s) besides the requisitioner's head; CP-006 asks for ${CPC_PERMANENT_QUORUM}.`
      : !requisitionerHeadPresent
        ? `The Head of the requisitioner department (${kase.pr.department.name}) is neither present nor represented by a nominated proxy. CP-006 requires them in addition to the three.`
        : mandatoryAbsent.length
          ? `Mandatory member(s) absent: ${mandatoryAbsent.join(", ")}.`
          : present < required
            ? `${present} permanent member(s) present besides the requisitioner's head; ${required} are required.`
            : `${present} permanent member(s) present besides the requisitioner's head, against ${required} required` +
              (presentByProxy ? `, ${presentByProxy} by nominated proxy` : "") +
              ".";

  return {
    votingSeats: voting.length,
    observerSeats: observers.length,
    required,
    present,
    requisitionerHeadPresent,
    requisitionerHeadName: kase.pr.department.name,
    presentByProxy,
    mandatoryAbsent,
    quorate,
    reason,
    rosterMissing,
  };
}

/** Creates an attendance row per roster seat, so absence is recorded not missing. */
export async function seedCpcAttendance(caseId: string, db: DbClient = prisma) {
  const kase = await db.cpcCase.findUnique({
    where: { id: caseId },
    select: { id: true, pr: { select: { entityId: true } } },
  });
  if (!kase) throw new NotFoundError("CPC case");

  const [roster, existing] = await Promise.all([
    db.cpcRosterMember.findMany({
      where: { entityId: kase.pr.entityId, active: true },
      select: { id: true },
    }),
    db.cpcAttendance.findMany({ where: { caseId }, select: { memberId: true } }),
  ]);
  const held = new Set(existing.map((e) => e.memberId));
  const missing = roster.filter((m) => !held.has(m.id));
  if (missing.length) {
    await db.cpcAttendance.createMany({
      data: missing.map((m) => ({ caseId, memberId: m.id })),
    });
  }
  return missing.length;
}

export async function recordCpcAttendance(
  user: SessionUser,
  input: {
    caseId: string;
    rows: Array<{
      memberId: string;
      attendance: "PRESENT" | "PROXY" | "ABSENT";
      proxyName?: string | null;
      note?: string | null;
    }>;
  },
  db: DbClient = prisma,
): Promise<CpcQuorumState> {
  if (!userHasPermission(user, P.CPC_MANAGE, P.CPC_DECIDE)) {
    throw new RuleViolationError("You do not have permission to record committee attendance.");
  }
  const kase = await db.cpcCase.findUnique({
    where: { id: input.caseId },
    select: { id: true, number: true, status: true, pr: { select: { entityId: true } } },
  });
  if (!kase) throw new NotFoundError("CPC case");
  assertEntityAccess(user, kase.pr.entityId);
  if (["APPROVED", "REJECTED", "RETURNED"].includes(kase.status)) {
    throw new RuleViolationError(
      `${kase.number} is already decided. Its attendance is the record of who decided it.`,
    );
  }

  for (const row of input.rows) {
    if (row.attendance === "PROXY" && !row.proxyName?.trim()) {
      throw new ValidationError(
        "A seat attended by proxy needs the proxy named — CP-006 admits a nominated proxy, not an anonymous one.",
      );
    }
    await db.cpcAttendance.updateMany({
      where: { caseId: kase.id, memberId: row.memberId },
      data: {
        attendance: row.attendance,
        proxyName: row.attendance === "PROXY" ? row.proxyName!.trim() : null,
        note: row.note ?? null,
      },
    });
  }
  return cpcQuorumFor(kase.id, db);
}

/**
 * CP-016 — circulates the committee's decision.
 *
 * "Once quorum finalises a decision, HOD Procurement shares it." The vote is not
 * the end: a decision nobody was told of cannot be acted on, and the people who
 * act on it are procurement, finance and the requisitioning department.
 *
 * Recorded rather than sent, because the system does not own the mailbox. What it
 * can insist on is that the circulation happened and can be found again.
 */
export async function circulateCpcDecision(
  user: SessionUser,
  input: { caseId: string; circularRef: string; ceoOfficeCopied: boolean; sentAt?: Date | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.CPC_MANAGE, P.CPC_DECIDE)) {
    throw new RuleViolationError("You do not have permission to circulate a committee decision.");
  }
  if (!input.circularRef.trim()) {
    throw new ValidationError(
      "Reference the circulation — a message id, subject line or filing reference. A trail nobody can find is not one.",
    );
  }
  // CP-016 names the Office of the CEO on copy. Circulating without them is a
  // different act from the one the clause describes, so it is refused rather
  // than recorded as though it were the same.
  if (!input.ceoOfficeCopied) {
    throw new ValidationError(
      "CP-016 requires the Office of the CEO on copy. Send it again with them copied — this email is the trail Finance initiates payment against, and an incomplete distribution list is not that trail.",
    );
  }

  const kase = await db.cpcCase.findUnique({
    where: { id: input.caseId },
    include: { pr: { select: { id: true, number: true, entityId: true, departmentId: true } } },
  });
  if (!kase) throw new NotFoundError("CPC case");
  assertEntityAccess(user, kase.pr.entityId);
  if (!["APPROVED", "REJECTED", "RETURNED", "PENDING_CEO"].includes(kase.status)) {
    throw new RuleViolationError(
      `${kase.number} has not been decided, so there is no decision to circulate.`,
    );
  }
  if (kase.decisionCirculatedAt) {
    throw new RuleViolationError(`${kase.number}'s decision has already been circulated.`);
  }

  const updated = await db.cpcCase.update({
    where: { id: kase.id },
    data: {
      decisionCircularRef: input.circularRef.trim(),
      decisionCirculatedAt: input.sentAt ?? new Date(),
      decisionCirculatedById: user.id,
      decisionCeoOfficeCopied: true,
    },
  });

  await notify(
    {
      roleCodes: ["PROCUREMENT_OFFICER", "BUYER", "FINANCE_APPROVER", "HOD"],
      entityId: kase.pr.entityId,
      type: "CPC_DECISION_CIRCULATED",
      title: `${kase.number} — committee decision circulated`,
      body: `${kase.title}. Status ${kase.status.toLowerCase().replace(/_/g, " ")}. Trail ${input.circularRef.trim()}.`,
      priority: "NORMAL",
      linkType: "CPC_CASE",
      linkId: kase.id,
      linkUrl: `/cpc/cases/${kase.id}`,
    },
    db,
  );

  await writeAudit(
    {
      entityType: "CpcCase",
      entityId: kase.id,
      entityRef: kase.number,
      action: "CPC_DECISION_CIRCULATED",
      newValue: { ref: input.circularRef.trim(), status: kase.status },
      caseKey: kase.pr.number,
      actor: user,
    },
    db,
  );
  return updated;
}

/**
 * Whether a case's decision has been circulated as CP-016 requires.
 *
 * The clause makes this email "attached with the standard documentation trail
 * required to initiate any payment request through Finance" — so for a purchase
 * that went to committee, it is a payment prerequisite in the same way the
 * requisition and the order are. The payment pack reads this.
 */
export async function cpcDecisionTrail(
  prId: string,
  db: DbClient = prisma,
): Promise<{ required: boolean; circulated: boolean; ref: string | null; caseNumber: string | null; caseId: string | null }> {
  const kase = await db.cpcCase.findFirst({
    where: { prId, status: { in: ["APPROVED", "PENDING_CEO"] } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      number: true,
      decisionCircularRef: true,
      decisionCirculatedAt: true,
      decisionCeoOfficeCopied: true,
    },
  });
  if (!kase) return { required: false, circulated: false, ref: null, caseNumber: null, caseId: null };
  return {
    required: true,
    circulated: Boolean(kase.decisionCirculatedAt && kase.decisionCeoOfficeCopied),
    ref: kase.decisionCircularRef,
    caseNumber: kase.number,
    caseId: kase.id,
  };
}

/**
 * CP-004 — the committee meets every Wednesday, after the management committee.
 *
 * Returned as the next Wednesday rather than stored as a rule, so a meeting can
 * still be called on demand when a case cannot wait, which the same clause
 * allows.
 */
export function nextWednesday(from: Date = new Date()): Date {
  const d = new Date(from);
  d.setHours(15, 0, 0, 0);
  const delta = (3 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + delta);
  return d;
}
