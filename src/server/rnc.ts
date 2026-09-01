import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { assertEntityAccess, userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { round2 } from "@/lib/format";

/**
 * The Rental & Negotiation Committee — `image22.PNG` and the RNC Terms of
 * Reference.
 *
 * Two things here are the substance, and both were absent:
 *
 * **Quorum (RN-004).** "At least 3 permanent members for central region present
 * in addition to the Head of the Committee. Alternatively presented by head or
 * nominated proxy, failing which deferred to next RNC." That is a rule a system
 * can count, and counting it is the difference between a committee decision and
 * a conversation. Observers attend and do not count — the roster separates the
 * three member types precisely so the arithmetic can.
 *
 * **The decision trail (RN-010).** The decision is not the vote; it is "a
 * detailed email of the decision to members copying the CEO's office, attached
 * with the documentation trail required to initiate payment through Finance".
 * So a case is not decided until that email is recorded, and Finance has
 * something to pay against.
 *
 * The quorum figures are snapshotted onto the case when it is decided. The
 * roster changes; whether *this* decision was quorate must not.
 */

export const RNC_REGIONS = ["CENTRAL", "NORTH", "SOUTH"] as const;
export const RNC_MEMBER_TYPES = ["PERMANENT_MANDATORY", "PERMANENT", "OBSERVER"] as const;
export type RncMemberType = (typeof RNC_MEMBER_TYPES)[number];

export const RNC_MEMBER_TYPE_LABELS: Record<RncMemberType, string> = {
  PERMANENT_MANDATORY: "Permanent — mandatory",
  PERMANENT: "Permanent",
  OBSERVER: "Observer (attends, does not vote)",
};

export const RNC_CASE_STATES = [
  "DRAFT",
  "PENDING_RNC",
  "DEFERRED",
  "APPROVED",
  "REJECTED",
  "AGREEMENT_SIGNED",
  "CLOSED",
] as const;
export type RncCaseState = (typeof RNC_CASE_STATES)[number];

export const RNC_CASE_STATE_LABELS: Record<RncCaseState, string> = {
  DRAFT: "Draft",
  PENDING_RNC: "With the committee",
  DEFERRED: "Deferred to the next RNC",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  AGREEMENT_SIGNED: "Agreement signed",
  CLOSED: "Closed",
};

/**
 * How many permanent members a region needs present, beside the Head.
 *
 * RN-004 states three for Central. It does not state a figure for North or
 * South, and those regions are listed with three members in total including a
 * Country Head shared with the other — so requiring three *besides* the head is
 * arithmetically impossible there as the document is worded. Rather than invent
 * a smaller number, the requirement is the region's own permanent headcount
 * capped at three, and the case records what was actually required.
 */
export const CENTRAL_QUORUM = 3;

export type QuorumState = {
  region: string;
  /** Permanent and permanent-mandatory seats, which are the ones that count. */
  votingSeats: number;
  required: number;
  present: number;
  headPresent: boolean;
  /** Mandatory members neither present nor proxied. */
  mandatoryAbsent: string[];
  quorate: boolean;
  reason: string;
};

/** The quorum as it stands for one case, counted rather than assumed. */
export async function quorumFor(caseId: string, db: DbClient = prisma): Promise<QuorumState> {
  const kase = await db.rncCase.findUnique({
    where: { id: caseId },
    include: { attendance: { include: { member: true } } },
  });
  if (!kase) throw new NotFoundError("RNC case");

  const roster = await db.rncMember.findMany({
    where: { entityId: kase.entityId, region: kase.region, active: true },
  });
  const voting = roster.filter((m) => m.memberType !== "OBSERVER");
  const head = roster.find((m) => m.isHead) ?? null;

  const attendedIds = new Set(
    kase.attendance.filter((a) => a.attendance === "PRESENT" || a.attendance === "PROXY").map((a) => a.memberId),
  );
  // The head is counted separately: RN-004 wants three permanent members *in
  // addition to* the head, so counting the head among the three would let a
  // committee of three sit as though it were four.
  const presentVoting = voting.filter((m) => !m.isHead && attendedIds.has(m.id)).length;
  const headPresent = head ? attendedIds.has(head.id) : false;

  const nonHeadVoting = voting.filter((m) => !m.isHead).length;
  const required =
    kase.region === "CENTRAL" ? CENTRAL_QUORUM : Math.min(CENTRAL_QUORUM, nonHeadVoting);

  const mandatoryAbsent = roster
    .filter((m) => m.memberType === "PERMANENT_MANDATORY" && !attendedIds.has(m.id))
    .map((m) => m.memberName);

  const quorate = headPresent && presentVoting >= required && mandatoryAbsent.length === 0;

  const reason = !head
    ? "No Head of the Committee is named on the roster for this region, so RN-004's condition cannot be met."
    : !headPresent
      ? `The Head of the Committee (${head.memberName}) is neither present nor proxied. RN-004 requires the head in addition to the permanent members.`
      : mandatoryAbsent.length
        ? `Mandatory member(s) absent: ${mandatoryAbsent.join(", ")}.`
        : presentVoting < required
          ? `${presentVoting} permanent member(s) present beside the head; ${required} are required.`
          : `${presentVoting} permanent member(s) present beside the head, against ${required} required.`;

  return {
    region: kase.region,
    votingSeats: voting.length,
    required,
    present: presentVoting,
    headPresent,
    mandatoryAbsent,
    quorate,
    reason,
  };
}

/* ── Raising a case ───────────────────────────────────────── */

export async function createRncCase(
  user: SessionUser,
  input: {
    entityId: string;
    region: string;
    title: string;
    needAssessment?: string | null;
    locationNote?: string | null;
    buildOutId?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.RNC_CASE_RAISE, P.RNC_MANAGE)) {
    throw new RuleViolationError("You do not have permission to raise a rental committee case.");
  }
  assertEntityAccess(user, input.entityId);
  if (!input.title.trim()) throw new ValidationError("Name the case.");
  if (!RNC_REGIONS.includes(input.region as (typeof RNC_REGIONS)[number])) {
    throw new ValidationError("Choose the region: Central, North or South.");
  }

  const number = await nextNumber(SEQ.RNC_CASE, db);
  const kase = await db.rncCase.create({
    data: {
      number,
      entityId: input.entityId,
      region: input.region,
      title: input.title.trim(),
      needAssessment: input.needAssessment?.trim() || null,
      locationNote: input.locationNote?.trim() || null,
      buildOutId: input.buildOutId ?? null,
      status: "DRAFT",
      createdById: user.id,
    },
  });

  // Every seat gets an attendance row, so an absence is recorded rather than
  // merely missing — the quorum count depends on the difference.
  const roster = await db.rncMember.findMany({
    where: { entityId: input.entityId, region: input.region, active: true },
    select: { id: true },
  });
  if (roster.length) {
    await db.rncAttendance.createMany({
      data: roster.map((m) => ({ caseId: kase.id, memberId: m.id })),
    });
  }

  await writeAudit(
    {
      entityType: "RncCase",
      entityId: kase.id,
      entityRef: kase.number,
      action: "RNC_CASE_CREATED",
      newValue: { region: kase.region, seats: roster.length },
      caseKey: kase.number,
      actor: user,
    },
    db,
  );
  return kase;
}

/* ── RN-007 · landlord quotes and the comparative ─────────── */

export async function addQuote(
  user: SessionUser,
  input: {
    caseId: string;
    landlordName: string;
    propertyRef?: string | null;
    areaSqft?: number | null;
    monthlyRent: number;
    annualEscalationPercent?: number | null;
    advanceMonths?: number | null;
    securityDeposit?: number | null;
    leaseYears?: number | null;
    technicalEvaluation?: string | null;
    environmentalImpact?: string | null;
    quoteAnalysisNote?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.RNC_CASE_RAISE, P.RNC_MANAGE)) {
    throw new RuleViolationError("You do not have permission to add a landlord quote.");
  }
  const kase = await db.rncCase.findUnique({ where: { id: input.caseId } });
  if (!kase) throw new NotFoundError("RNC case");
  assertEntityAccess(user, kase.entityId);
  if (!input.landlordName.trim()) throw new ValidationError("Name the landlord.");
  if (!(input.monthlyRent > 0)) throw new ValidationError("Enter the monthly rent.");

  return db.rncQuote.create({
    data: {
      caseId: kase.id,
      landlordName: input.landlordName.trim(),
      propertyRef: input.propertyRef?.trim() || null,
      areaSqft: input.areaSqft ?? null,
      monthlyRent: input.monthlyRent,
      annualEscalationPercent: input.annualEscalationPercent ?? null,
      advanceMonths: input.advanceMonths ?? null,
      securityDeposit: input.securityDeposit ?? null,
      leaseYears: input.leaseYears ?? null,
      technicalEvaluation: input.technicalEvaluation?.trim() || null,
      environmentalImpact: input.environmentalImpact?.trim() || null,
      quoteAnalysisNote: input.quoteAnalysisNote?.trim() || null,
    },
  });
}

/**
 * RN-007 — selects the landlord on the comparative.
 *
 * The clause names three grounds beside price: quote analysis, environmental
 * impact and technical evaluation. Selecting a landlord who is not the cheapest
 * therefore needs a reason, in the same way an award above the lowest compliant
 * quotation does on a purchase comparative — and for the same reason.
 */
export async function selectLandlord(
  user: SessionUser,
  input: { caseId: string; quoteId: string; selectionReason?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.RNC_CASE_RAISE, P.RNC_MANAGE)) {
    throw new RuleViolationError("You do not have permission to select a landlord.");
  }
  return withTransaction(db, async (tx) => {
    const kase = await tx.rncCase.findUnique({
      where: { id: input.caseId },
      include: { quotes: true },
    });
    if (!kase) throw new NotFoundError("RNC case");
    assertEntityAccess(user, kase.entityId);
    if (["APPROVED", "REJECTED", "CLOSED"].includes(kase.status)) {
      throw new RuleViolationError(`${kase.number} is already decided.`);
    }

    const chosen = kase.quotes.find((q) => q.id === input.quoteId);
    if (!chosen) throw new NotFoundError("Landlord quote");
    if (kase.quotes.length < 2) {
      throw new RuleViolationError(
        `${kase.number} has one quotation. RN-007 selects the landlord on a comparative, and a comparative of one is not one.`,
      );
    }

    const cheapest = kase.quotes.reduce((a, q) => (q.monthlyRent < a.monthlyRent ? q : a), kase.quotes[0]);
    if (chosen.id !== cheapest.id && !input.selectionReason?.trim()) {
      throw new ValidationError(
        `${chosen.landlordName} is not the lowest rent — ${cheapest.landlordName} is, at ` +
          `${cheapest.monthlyRent.toLocaleString("en-PK")} against ${chosen.monthlyRent.toLocaleString("en-PK")}. ` +
          "RN-007 allows selection on technical evaluation and environmental impact as well as price, but the reasoning has to be on the record.",
      );
    }

    await tx.rncQuote.updateMany({ where: { caseId: kase.id }, data: { isSelected: false } });
    const updated = await tx.rncQuote.update({
      where: { id: chosen.id },
      data: { isSelected: true, selectionReason: input.selectionReason?.trim() || null },
    });
    await writeAudit(
      {
        entityType: "RncCase",
        entityId: kase.id,
        entityRef: kase.number,
        action: "RNC_LANDLORD_SELECTED",
        newValue: {
          landlord: chosen.landlordName,
          monthlyRent: chosen.monthlyRent,
          lowest: chosen.id === cheapest.id,
          reason: input.selectionReason ?? null,
        },
        caseKey: kase.number,
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/* ── Convening, attendance and voting ─────────────────────── */

/** RN-003 — the committee convenes as needed; HOD Sales or Admin arranges it. */
export async function convene(
  user: SessionUser,
  input: { caseId: string },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.RNC_MANAGE, P.RNC_CASE_RAISE)) {
    throw new RuleViolationError("You do not have permission to convene the committee.");
  }
  const kase = await db.rncCase.findUnique({
    where: { id: input.caseId },
    include: { quotes: true },
  });
  if (!kase) throw new NotFoundError("RNC case");
  assertEntityAccess(user, kase.entityId);

  const blockers: string[] = [];
  if (!kase.needAssessment?.trim()) {
    blockers.push("the need assessment for the location (RN-006) is not recorded");
  }
  if (!kase.quotes.some((q) => q.isSelected)) {
    blockers.push("no landlord has been selected on the comparative (RN-007)");
  }
  if (blockers.length) {
    throw new RuleViolationError(
      `${kase.number} is not ready for the committee: ${blockers.join("; ")}.`,
    );
  }

  return db.rncCase.update({ where: { id: kase.id }, data: { status: "PENDING_RNC" } });
}

export async function recordAttendance(
  user: SessionUser,
  input: {
    caseId: string;
    rows: Array<{ memberId: string; attendance: "PRESENT" | "PROXY" | "ABSENT"; proxyName?: string | null; note?: string | null }>;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.RNC_MANAGE)) {
    throw new RuleViolationError("You do not have permission to record committee attendance.");
  }
  const kase = await db.rncCase.findUnique({ where: { id: input.caseId } });
  if (!kase) throw new NotFoundError("RNC case");
  assertEntityAccess(user, kase.entityId);

  for (const row of input.rows) {
    if (row.attendance === "PROXY" && !row.proxyName?.trim()) {
      throw new ValidationError(
        "A seat attended by proxy needs the proxy named — RN-004 admits a nominated proxy, not an anonymous one.",
      );
    }
    await db.rncAttendance.updateMany({
      where: { caseId: kase.id, memberId: row.memberId },
      data: {
        attendance: row.attendance,
        proxyName: row.attendance === "PROXY" ? row.proxyName!.trim() : null,
        note: row.note ?? null,
      },
    });
  }
  return quorumFor(kase.id, db);
}

export async function castRncVote(
  user: SessionUser,
  input: { caseId: string; vote: "APPROVE" | "REJECT" | "DEFER"; comment?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.RNC_DECIDE)) {
    throw new RuleViolationError("You do not have permission to vote on a rental committee case.");
  }
  const kase = await db.rncCase.findUnique({ where: { id: input.caseId } });
  if (!kase) throw new NotFoundError("RNC case");
  assertEntityAccess(user, kase.entityId);
  if (kase.status !== "PENDING_RNC") {
    throw new RuleViolationError(
      `${kase.number} is ${RNC_CASE_STATE_LABELS[kase.status as RncCaseState] ?? kase.status}, so it is not open for votes.`,
    );
  }

  const seat = await db.rncMember.findFirst({
    where: { entityId: kase.entityId, region: kase.region, userId: user.id, active: true },
  });
  if (!seat) {
    throw new RuleViolationError(
      `You do not hold a seat on the ${kase.region.toLowerCase()} rental committee, so you cannot vote on ${kase.number}.`,
    );
  }
  // Observers attend and do not vote. That is what makes them observers.
  if (seat.memberType === "OBSERVER") {
    throw new RuleViolationError(
      `${seat.memberName} sits as an observer. Observers attend and do not vote — image22 lists the seat that way.`,
    );
  }
  if (input.vote !== "APPROVE" && !input.comment?.trim()) {
    throw new ValidationError("Record your reasoning for anything other than a clean approval.");
  }

  return db.rncVote.upsert({
    where: { caseId_memberId: { caseId: kase.id, memberId: seat.id } },
    create: {
      caseId: kase.id,
      memberId: seat.id,
      vote: input.vote,
      comment: input.comment?.trim() || null,
    },
    update: { vote: input.vote, comment: input.comment?.trim() || null, castAt: new Date() },
  });
}

/* ── RN-004 + RN-010 · the decision ───────────────────────── */

/**
 * Resolves the case — and refuses when the committee was not quorate.
 *
 * RN-004's own remedy for a short committee is to defer to the next RNC, so
 * that is what a non-quorate case is offered: deferral, not a decision. The
 * quorum figures are written onto the case as they stood, because the roster
 * moves and the question "was this quorate" has to stay answerable.
 */
export async function resolveRncCase(
  user: SessionUser,
  input: {
    caseId: string;
    outcome: "APPROVED" | "REJECTED" | "DEFERRED";
    summary: string;
    deferredReason?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.RNC_MANAGE, P.RNC_DECIDE)) {
    throw new RuleViolationError("You do not have permission to resolve a rental committee case.");
  }
  if (!input.summary.trim()) {
    throw new ValidationError("Record what the committee decided and why.");
  }

  return withTransaction(db, async (tx) => {
    const kase = await tx.rncCase.findUnique({ where: { id: input.caseId } });
    if (!kase) throw new NotFoundError("RNC case");
    assertEntityAccess(user, kase.entityId);
    if (kase.status !== "PENDING_RNC") {
      throw new RuleViolationError(`${kase.number} is not with the committee.`);
    }

    const q = await quorumFor(kase.id, tx);
    if (input.outcome !== "DEFERRED" && !q.quorate) {
      throw new RuleViolationError(
        `${kase.number} is not quorate, so the committee cannot decide it. ${q.reason} ` +
          "RN-004's own remedy is to defer to the next RNC.",
      );
    }

    const updated = await tx.rncCase.update({
      where: { id: kase.id },
      data: {
        status: input.outcome === "DEFERRED" ? "DEFERRED" : input.outcome,
        decisionSummary: input.summary.trim(),
        deferredReason: input.outcome === "DEFERRED" ? (input.deferredReason?.trim() || q.reason) : null,
        quorumRequired: q.required,
        quorumPresent: q.present,
        headPresent: q.headPresent,
        decidedAt: input.outcome === "DEFERRED" ? null : new Date(),
      },
    });

    await writeAudit(
      {
        entityType: "RncCase",
        entityId: kase.id,
        entityRef: kase.number,
        action: `RNC_${input.outcome}`,
        newValue: {
          quorumRequired: q.required,
          quorumPresent: q.present,
          headPresent: q.headPresent,
        },
        reason: input.summary,
        caseKey: kase.number,
        actor: user,
      },
      tx,
    );
    return { kase: updated, quorum: q };
  });
}

/**
 * RN-010 — the decision email that makes the decision actionable.
 *
 * "HOD Sales or Admin shares a detailed email of the decision to members copying
 * the CEO's office; attached with the documentation trail required to initiate
 * payment through Finance."
 *
 * So an approved case is not finished at the vote. Until this is recorded,
 * Finance has nothing to pay against, and the case says so rather than looking
 * complete.
 */
export async function recordDecisionEmail(
  user: SessionUser,
  input: { caseId: string; emailRef: string; ceoOfficeCopied: boolean; sentAt?: Date | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.RNC_MANAGE)) {
    throw new RuleViolationError("You do not have permission to record the committee's decision email.");
  }
  const kase = await db.rncCase.findUnique({ where: { id: input.caseId } });
  if (!kase) throw new NotFoundError("RNC case");
  assertEntityAccess(user, kase.entityId);
  if (kase.status !== "APPROVED") {
    throw new RuleViolationError(
      `${kase.number} is ${RNC_CASE_STATE_LABELS[kase.status as RncCaseState] ?? kase.status}. The decision email follows an approval.`,
    );
  }
  if (!input.emailRef.trim()) {
    throw new ValidationError("Reference the email — a decision trail with no reference cannot be found later.");
  }
  if (!input.ceoOfficeCopied) {
    throw new ValidationError(
      "RN-010 requires the CEO's office to be copied. Send it again with them on copy, or say why not in the case summary first.",
    );
  }

  const updated = await db.rncCase.update({
    where: { id: kase.id },
    data: {
      decisionEmailRef: input.emailRef.trim(),
      decisionEmailSentAt: input.sentAt ?? new Date(),
      ceoOfficeCopied: true,
    },
  });
  await notify(
    {
      roleCodes: ["FINANCE_APPROVER", "FINANCE_USER"],
      entityId: kase.entityId,
      type: "RNC_DECISION",
      title: `${kase.number} approved — rental payment may be initiated`,
      body: `${kase.title}. Decision trail ${input.emailRef.trim()}, CEO's office copied.`,
      priority: "NORMAL",
      linkType: "RNC_CASE",
      linkId: kase.id,
      linkUrl: `/rnc/${kase.id}`,
    },
    db,
  );
  return updated;
}

/** RN-008, RN-009 — the commercial terms and the landlord's own obligations. */
export async function recordTerms(
  user: SessionUser,
  input: {
    caseId: string;
    commercialTerms?: string | null;
    marketPracticeNote?: string | null;
    landlordObligations?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.RNC_MANAGE, P.RNC_CASE_RAISE)) {
    throw new RuleViolationError("You do not have permission to record the terms.");
  }
  const kase = await db.rncCase.findUnique({ where: { id: input.caseId } });
  if (!kase) throw new NotFoundError("RNC case");
  assertEntityAccess(user, kase.entityId);

  return db.rncCase.update({
    where: { id: kase.id },
    data: {
      commercialTerms: input.commercialTerms?.trim() ?? kase.commercialTerms,
      marketPracticeNote: input.marketPracticeNote?.trim() ?? kase.marketPracticeNote,
      landlordObligations: input.landlordObligations?.trim() ?? kase.landlordObligations,
    },
  });
}

/** The comparative as the committee reads it, cheapest first. */
export async function comparative(caseId: string, db: DbClient = prisma) {
  const quotes = await db.rncQuote.findMany({
    where: { caseId },
    orderBy: { monthlyRent: "asc" },
  });
  const cheapest = quotes[0] ?? null;
  return quotes.map((q) => ({
    ...q,
    isLowest: cheapest?.id === q.id,
    /** Rent over the lease, so a low rent with a steep escalation is visible. */
    indicativeLeaseCost:
      q.leaseYears && q.leaseYears > 0
        ? round2(
            Array.from({ length: Math.ceil(q.leaseYears) }).reduce<number>(
              (a, _, year) =>
                a + q.monthlyRent * 12 * Math.pow(1 + (q.annualEscalationPercent ?? 0) / 100, year),
              0,
            ),
          )
        : null,
  }));
}
