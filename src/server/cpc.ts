import { prisma, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { CONFIG_KEYS, getConfigArray, getConfigBool, getConfigNumber } from "@/lib/config";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify, createTask, completeTasks } from "@/lib/notify";
import { PERMISSIONS as P } from "@/lib/permissions";
import { assertEntityAccess, userHasPermission, type SessionUser } from "@/lib/rbac";
import { DOMAIN_ACTIONS, assertAuthority, type Actor, type Authority } from "@/lib/actor";
import { transitionPr } from "./pr";
import { round2 } from "@/lib/format";

/**
 * Central Procurement Committee.
 *
 * Whether a case needs CPC is decided by configuration (threshold + enabled
 * flag) and by the matched approval rule's `requiresCpc`, never by a literal in
 * code.
 */

export type CpcRequirement = {
  required: boolean;
  threshold: number;
  reason: string;
  /** PC-023 · above the CEO value tier, so the Office of the CEO must approve. */
  ceoRequired: boolean;
  ceoThreshold: number;
  /** PC-022 · the committee category the threshold was read from. */
  transactionType: string;
};

export async function cpcRequirement(
  entityId: string,
  amount: number,
  procurementType: string,
  db: DbClient = prisma,
): Promise<CpcRequirement> {
  const enabled = await getConfigBool(CONFIG_KEYS.CPC_ENABLED, entityId, db);

  // PC-022. The committee's engagement limit names "Procurement of Goods" at
  // PKR 500,000; its mandate names "any transaction" including SLAs, service
  // contracts, AMCs, build-outs and one-time purchases. The two readings differ
  // in what a service contract does, so the threshold is held per transaction
  // type and the seeded policy applies the mandate reading — the wider one, so
  // that a service contract is referred rather than routed around a committee
  // whose own mandate names it.
  const byType = await getConfigArray<{ type: string; threshold: number }>(
    CONFIG_KEYS.POLICY_CPC_THRESHOLDS_BY_TYPE,
    entityId,
    db,
  );
  const typeKey = cpcTransactionType(procurementType);
  const matched = byType.find((t) => t.type === typeKey);
  const threshold =
    matched?.threshold ?? (await getConfigNumber(CONFIG_KEYS.CPC_THRESHOLD, entityId, db));

  // PC-023. "All purchases above PKR 1,500,000 are to be approved by Office of
  // CEO" is unambiguous and is applied. The separate "Exceptional Purchases
  // (Must be approved by CEO)" trigger has no stated definition, so it is not
  // applied until the business supplies one — see EXCEPTIONAL_PURCHASE_DEFINED.
  const ceoThreshold = await getConfigNumber(CONFIG_KEYS.POLICY_CEO_APPROVAL_THRESHOLD, entityId, db);
  const ceoRequired = ceoThreshold > 0 && amount > ceoThreshold;

  if (!enabled) {
    return { required: false, threshold, ceoRequired, ceoThreshold, transactionType: typeKey, reason: "CPC review is disabled for this entity." };
  }
  // Recurring/monthly buying is routine and does not go to committee on value alone.
  if (procurementType === "MONTHLY_RECURRING") {
    return {
      required: false,
      threshold,
      ceoRequired,
      ceoThreshold,
      transactionType: typeKey,
      reason: "Monthly recurring procurement is routine and exempt from value-based CPC review.",
    };
  }
  if (amount >= threshold) {
    return {
      required: true,
      threshold,
      ceoRequired,
      ceoThreshold,
      transactionType: typeKey,
      reason:
        `Case value PKR ${amount.toLocaleString("en-PK")} is at or above the ${typeKey.replace(/_/g, " ").toLowerCase()} threshold of PKR ${threshold.toLocaleString("en-PK")}.` +
        (ceoRequired
          ? ` It also exceeds PKR ${ceoThreshold.toLocaleString("en-PK")}, so the Office of the CEO must approve it.`
          : ""),
    };
  }
  return {
    required: false,
    threshold,
    ceoRequired,
    ceoThreshold,
    transactionType: typeKey,
    reason:
      `Case value PKR ${amount.toLocaleString("en-PK")} is below the ${typeKey.replace(/_/g, " ").toLowerCase()} threshold of PKR ${threshold.toLocaleString("en-PK")}.` +
      (ceoRequired
        ? ` It nevertheless exceeds PKR ${ceoThreshold.toLocaleString("en-PK")}, so the Office of the CEO must approve it.`
        : ""),
  };
}

/**
 * Maps a procurement type onto the committee's own transaction vocabulary.
 *
 * The committee names its categories in its mandate — SLA, Service Contracts,
 * AMC, Buildouts, Onetime Purchases — and the system's `procurementType` uses
 * different words. Anything the mandate does not name falls to GOODS, which is
 * the only category its engagement limit does name.
 */
export function cpcTransactionType(procurementType: string): string {
  switch (procurementType) {
    case "SERVICE":
    case "SERVICES":
      return "SERVICES";
    case "SLA":
      return "SLA";
    case "AMC":
    case "MAINTENANCE":
      return "AMC";
    case "BUILDOUT":
    case "BUILD_OUT":
    case "PROJECT":
      return "BUILDOUT";
    case "ONE_TIME":
    case "ONETIME":
      return "ONE_TIME";
    default:
      return "GOODS";
  }
}

/**
 * Composes the committee: requesting department head, Procurement Director,
 * a finance representative and the relevant functional director for the
 * dominant category (e.g. IT Director for laptops).
 */
async function resolveMembers(
  prId: string,
  db: DbClient,
): Promise<Array<{ userId: string; roleLabel: string; required: boolean }>> {
  const pr = await db.purchaseRequisition.findUnique({
    where: { id: prId },
    include: { department: true, items: { include: { category: true } } },
  });
  if (!pr) return [];

  const members: Array<{ userId: string; roleLabel: string; required: boolean }> = [];
  const seen = new Set<string>();
  const push = (userId: string | null | undefined, roleLabel: string, required = true) => {
    if (!userId || seen.has(userId)) return;
    seen.add(userId);
    members.push({ userId, roleLabel, required });
  };

  // Requesting department head.
  push(pr.department.headId, `HOD — ${pr.department.name}`);

  const byRole = async (code: string) => {
    const u = await db.user.findFirst({
      where: {
        active: true,
        roles: { some: { role: { code } } },
        OR: [{ primaryEntityId: pr.entityId }, { entityAccess: { some: { entityId: pr.entityId } } }],
      },
      orderBy: { name: "asc" },
    });
    return u ?? (await db.user.findFirst({ where: { active: true, roles: { some: { role: { code } } } } }));
  };

  push((await byRole("PROCUREMENT_DIRECTOR"))?.id, "Procurement Director");
  push((await byRole("FINANCE_APPROVER"))?.id, "Finance Representative");

  // Functional director derived from the dominant spend category.
  const byValue = new Map<string, { value: number; code: string; name: string }>();
  for (const it of pr.items) {
    const cur = byValue.get(it.categoryId) ?? { value: 0, code: it.category.code, name: it.category.name };
    cur.value += it.estimatedTotal;
    byValue.set(it.categoryId, cur);
  }
  const dominant = [...byValue.values()].sort((a, b) => b.value - a.value)[0];
  if (dominant) {
    const code = dominant.code.toUpperCase();
    let functionalRole: string | null = null;
    if (code.startsWith("IT")) functionalRole = "IT_USER";
    else if (code.startsWith("CONSTR") || code.startsWith("MEP") || code.startsWith("FITOUT")) functionalRole = "PM_USER";
    else if (code.startsWith("MKT")) functionalRole = "MANAGEMENT_COMMITTEE";
    else if (code.startsWith("FURN") || code.startsWith("OFF")) functionalRole = "ADMIN_FLOOR_MANAGER";
    if (functionalRole) {
      const u = await byRole(functionalRole);
      push(u?.id, `Functional Director — ${dominant.name}`, false);
    }
  }

  // Fill from standing CPC members if the committee is thin.
  if (members.length < 3) {
    const standing = await db.user.findMany({
      where: { active: true, roles: { some: { role: { code: "CPC_MEMBER" } } } },
      take: 4,
    });
    for (const u of standing) push(u.id, "CPC Member", false);
  }

  return members;
}

/** Next scheduled or newly created meeting for the configured cadence. */
export async function ensureUpcomingMeeting(
  actor: Actor,
  entityId: string,
  db: DbClient = prisma,
  authority: Authority = { permission: [P.CPC_MANAGE] },
) {
  assertAuthority(actor, DOMAIN_ACTIONS.CPC_MEETING_ENSURE, authority);
  const existing = await db.cpcMeeting.findFirst({
    where: { entityId, status: "SCHEDULED", scheduledAt: { gte: new Date() } },
    orderBy: { scheduledAt: "asc" },
  });
  if (existing) return existing;

  // PC-007. ZAM's committee meets every Wednesday, ZD's every Thursday. Both are
  // explicit for their own entity, so the weekday comes from the entity's policy
  // rather than one global value — which used to make every entity meet on ZAM's
  // Wednesday.
  const weekday = await getConfigNumber(CONFIG_KEYS.POLICY_CPC_MEETING_WEEKDAY, entityId, db);
  const now = new Date();
  const target = new Date(now);
  const day = Number.isFinite(weekday) ? weekday : 3;
  const diff = (day - now.getDay() + 7) % 7 || 7;
  target.setDate(now.getDate() + diff);
  target.setHours(11, 0, 0, 0);

  const number = await nextNumber(SEQ.CPC_MEETING, db);
  const entity = await db.entity.findUnique({ where: { id: entityId } });
  return db.cpcMeeting.create({
    data: {
      number,
      entityId,
      title: `CPC — ${entity?.code ?? ""} — ${target.toISOString().slice(0, 10)}`,
      scheduledAt: target,
      meetingType: "WEEKLY",
      status: "SCHEDULED",
    },
  });
}

/**
 * Creates (or returns) the CPC case for a recommended comparative and moves the
 * PR into committee review.
 */
export async function createCpcCase(
  user: SessionUser,
  input: { comparativeId: string; recommendation?: string | null; riskNotes?: string | null; scheduleMeeting?: boolean },
  db: DbClient = prisma,
) {
  // Putting a case to the committee is a procurement act, and distinct from
  // deciding one — see `CPC_CASE_RAISE` vs `CPC_DECIDE`.
  assertAuthority(user, DOMAIN_ACTIONS.CPC_CASE_CREATE, {
    permission: [P.CPC_CASE_RAISE, P.CPC_MANAGE],
  });
  const comparative = await db.comparative.findUnique({
    where: { id: input.comparativeId },
    include: { pr: true, lines: { include: { vendor: true } } },
  });
  if (!comparative) throw new NotFoundError("Comparative");

  const selected = comparative.lines.find((l) => l.isSelected);
  if (!selected) {
    throw new RuleViolationError("Recommend a vendor before raising a CPC case.");
  }

  const existing = await db.cpcCase.findFirst({
    where: { comparativeId: comparative.id, status: { notIn: ["REJECTED"] } },
  });
  if (existing) return existing;

  const number = await nextNumber(SEQ.CPC_CASE, db);
  const members = await resolveMembers(comparative.prId, db);

  const meeting = input.scheduleMeeting === false ? null : await ensureUpcomingMeeting(user, comparative.pr.entityId, db, {
          cascade: "case raised for the committee",
          from: [P.CPC_CASE_RAISE, P.CPC_MANAGE],
        });

  const kase = await db.cpcCase.create({
    data: {
      number,
      prId: comparative.prId,
      comparativeId: comparative.id,
      meetingId: meeting?.id ?? null,
      title: `${comparative.pr.number} — ${comparative.pr.title}`,
      amount: selected.netTotal,
      savingsAmount: comparative.savingsAmount,
      recommendation:
        input.recommendation ??
        `Award to ${selected.vendor.name} at PKR ${selected.netTotal.toLocaleString("en-PK")}. ${comparative.recommendationBasis ?? ""}`.trim(),
      riskNotes: input.riskNotes ?? comparative.nonLowestJustification ?? null,
      status: meeting ? "SCHEDULED" : "PENDING",
      members: { create: members.map((m) => ({ userId: m.userId, roleLabel: m.roleLabel, required: m.required })) },
    },
  });

  if (comparative.pr.status !== "CPC_REVIEW") {
    await transitionPr(user, comparative.prId, "CPC_REVIEW", {}, db);
  }

  const slaHours = await getConfigNumber(CONFIG_KEYS.SLA_CPC_HOURS, comparative.pr.entityId, db);
  for (const m of members) {
    await createTask(
      {
        title: `CPC decision required — ${kase.number}`,
        description: `${comparative.pr.title} · PKR ${selected.netTotal.toLocaleString("en-PK")}`,
        taskType: "APPROVAL",
        assigneeId: m.userId,
        entityId: comparative.pr.entityId,
        documentType: "CPC_CASE",
        documentId: kase.id,
        documentRef: kase.number,
        priority: "HIGH",
        slaHours,
        linkUrl: `/cpc/cases/${kase.id}`,
      },
      db,
    );
  }
  await notify(
    {
      userIds: members.map((m) => m.userId),
      entityId: comparative.pr.entityId,
      type: "CPC_PENDING",
      title: `CPC case ${kase.number} awaiting your decision`,
      body: `${comparative.pr.number} — PKR ${selected.netTotal.toLocaleString("en-PK")}${meeting ? ` · meeting ${meeting.scheduledAt.toISOString().slice(0, 10)}` : ""}`,
      priority: "HIGH",
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
      action: "CPC_CASE_CREATED",
      newValue: {
        pr: comparative.pr.number,
        amount: selected.netTotal,
        vendor: selected.vendor.name,
        members: members.length,
        meeting: meeting?.number ?? null,
      },
      caseKey: comparative.pr.number,
      actor: user,
    },
    db,
  );

  return kase;
}

export type CpcVote = "APPROVE" | "REJECT" | "RETURN" | "REQUEST_CLARIFICATION" | "ABSTAIN";

/**
 * Records one member's vote. Once every required member has voted (or the
 * chair records a final decision), the case resolves and the PR advances.
 */
export async function castCpcDecision(
  user: SessionUser,
  input: { caseId: string; vote: CpcVote; comment?: string | null; final?: boolean },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.CPC_DECIDE)) {
    throw new ForbiddenError("You are not a voting member of the Central Procurement Committee.");
  }
  const kase = await db.cpcCase.findUnique({
    where: { id: input.caseId },
    include: {
      members: true,
      decisions: true,
      pr: true,
      comparative: { include: { lines: { include: { vendor: true } } } },
    },
  });
  if (!kase) throw new NotFoundError("CPC case");
  if (["APPROVED", "REJECTED", "RETURNED"].includes(kase.status)) {
    throw new RuleViolationError(`CPC case ${kase.number} is already ${kase.status.toLowerCase()}.`);
  }

  const isMember = kase.members.some((m) => m.userId === user.id);
  const isChair = userHasPermission(user, P.CPC_MANAGE);
  if (!isMember && !isChair) {
    throw new ForbiddenError("You are not assigned to this CPC case.");
  }
  if (input.vote !== "APPROVE" && !input.comment?.trim()) {
    throw new ValidationError("A comment is required for anything other than an approval.");
  }

  const existing = kase.decisions.find((d) => d.memberId === user.id);
  if (existing) {
    await db.cpcDecision.update({
      where: { id: existing.id },
      data: { vote: input.vote, comment: input.comment ?? null, decidedAt: new Date() },
    });
  } else {
    await db.cpcDecision.create({
      data: {
        caseId: kase.id,
        memberId: user.id,
        vote: input.vote,
        comment: input.comment ?? null,
        isFinal: Boolean(input.final && isChair),
      },
    });
  }

  await db.task.updateMany({
    where: { documentType: "CPC_CASE", documentId: kase.id, assigneeId: user.id, status: { in: ["OPEN", "IN_PROGRESS"] } },
    data: { status: "DONE", completedAt: new Date(), completedById: user.id },
  });

  if (kase.status === "SCHEDULED" || kase.status === "PENDING") {
    await db.cpcCase.update({ where: { id: kase.id }, data: { status: "UNDER_REVIEW" } });
  }

  await writeAudit(
    {
      entityType: "CpcCase",
      entityId: kase.id,
      entityRef: kase.number,
      action: `CPC_VOTE_${input.vote}`,
      newValue: { member: user.name, vote: input.vote },
      reason: input.comment ?? null,
      caseKey: kase.pr.number,
      actor: user,
    },
    db,
  );

  // Re-read decisions and resolve if the committee has concluded.
  const decisions = await db.cpcDecision.findMany({ where: { caseId: kase.id } });
  const required = kase.members.filter((m) => m.required);
  const requiredVoted = required.every((m) => decisions.some((d) => d.memberId === m.userId));
  const anyReject = decisions.some((d) => d.vote === "REJECT");
  const anyReturn = decisions.some((d) => d.vote === "RETURN" || d.vote === "REQUEST_CLARIFICATION");
  const forcedFinal = Boolean(input.final && isChair);

  let outcome: "APPROVED" | "REJECTED" | "RETURNED" | "CLARIFICATION" | null = null;
  if (anyReject) outcome = "REJECTED";
  else if (anyReturn) outcome = decisions.some((d) => d.vote === "RETURN") ? "RETURNED" : "CLARIFICATION";
  else if (requiredVoted || forcedFinal) {
    const approvals = decisions.filter((d) => d.vote === "APPROVE").length;
    outcome = approvals > 0 ? "APPROVED" : null;
  }

  if (!outcome) return { kase, resolved: false as const, outcome: null };

  return resolveCpcCase(user, kase.id, outcome, input.comment ?? null, db);
}

/** Applies the committee's conclusion to the case and the requisition. */
export async function resolveCpcCase(
  user: SessionUser,
  caseId: string,
  outcome: "APPROVED" | "REJECTED" | "RETURNED" | "CLARIFICATION" | "DEFERRED",
  comment: string | null,
  db: DbClient = prisma,
) {
  // The committee's decision is the single most consequential act in the
  // system: it approves the award, releases the requisition to purchase order
  // preparation and marks the comparative approved. It was previously reachable
  // by any signed-in user, because the only check on the path was `requireUser`
  // in the server action. Roster membership and quorum are enforced with the
  // committee module; this is the authorization floor beneath it.
  //
  // The refusal is recorded. An attempt to decide a committee case without the
  // authority to do so is worth knowing about whether or not it succeeded, and
  // an exception that reaches only the browser console tells nobody.
  const kase = await db.cpcCase.findUnique({
    where: { id: caseId },
    include: { pr: true, comparative: { include: { lines: { include: { vendor: true } } } } },
  });
  if (!kase) throw new NotFoundError("CPC case");

  try {
    assertAuthority(user, DOMAIN_ACTIONS.CPC_CASE_RESOLVE, { permission: [P.CPC_DECIDE] });
    assertEntityAccess(user, kase.pr.entityId);
  } catch (e) {
    await writeAudit(
      {
        entityType: "CpcCase",
        entityId: kase.id,
        entityRef: kase.number,
        action: "CPC_DECISION_REFUSED",
        newValue: { attemptedOutcome: outcome, requires: P.CPC_DECIDE },
        reason: e instanceof Error ? e.message : "Not authorised to resolve this case.",
        caseKey: kase.pr.number,
        actor: user,
      },
      db,
    );
    throw e;
  }

  const updated = await db.cpcCase.update({
    where: { id: caseId },
    data: { status: outcome, decidedAt: outcome === "DEFERRED" ? null : new Date() },
  });
  await completeTasks("CPC_CASE", caseId, user.id, db);

  if (outcome === "APPROVED") {
    if (kase.comparativeId) {
      await db.comparative.update({ where: { id: kase.comparativeId }, data: { status: "APPROVED" } });
    }
    await transitionPr(user, kase.prId, "PO_PREPARATION", { reason: comment }, db);
    await createTask(
      {
        title: `Raise PO for ${kase.pr.number}`,
        taskType: "ACTION",
        assignedRoleCode: "PROCUREMENT_OFFICER",
        entityId: kase.pr.entityId,
        documentType: "PR",
        documentId: kase.prId,
        documentRef: kase.pr.number,
        priority: "HIGH",
        slaHours: 24,
        linkUrl: `/pr/${kase.prId}`,
      },
      db,
    );
    await notify(
      {
        roleCodes: ["PROCUREMENT_OFFICER", "BUYER"],
        userIds: [kase.pr.requesterId],
        entityId: kase.pr.entityId,
        type: "CPC_PENDING",
        title: `${kase.number} approved by CPC`,
        body: `${kase.pr.number} may now proceed to purchase order.`,
        linkType: "PR",
        linkId: kase.prId,
        linkUrl: `/pr/${kase.prId}`,
      },
      db,
    );
  } else if (outcome === "REJECTED") {
    if (kase.comparativeId) {
      await db.comparative.update({ where: { id: kase.comparativeId }, data: { status: "REJECTED" } });
    }
    await transitionPr(user, kase.prId, "REJECTED", { reason: comment ?? "Rejected by CPC" }, db);
    await notify(
      {
        userIds: [kase.pr.requesterId],
        type: "PR_REJECTED",
        title: `${kase.pr.number} rejected by CPC`,
        body: comment ?? undefined,
        priority: "HIGH",
        linkType: "PR",
        linkId: kase.prId,
        linkUrl: `/pr/${kase.prId}`,
      },
      db,
    );
  } else if (outcome === "RETURNED" || outcome === "CLARIFICATION") {
    // Back to sourcing so procurement can re-quote or clarify.
    await transitionPr(
      user,
      kase.prId,
      "SOURCING",
      {
        reason: comment,
        force: true,
        authority: { cascade: "committee returned the case for re-sourcing", from: [P.CPC_DECIDE] },
      },
      db,
    );
    await createTask(
      {
        title: `CPC returned ${kase.number} — action required`,
        description: comment ?? undefined,
        taskType: "ACTION",
        assignedRoleCode: "PROCUREMENT_OFFICER",
        entityId: kase.pr.entityId,
        documentType: "PR",
        documentId: kase.prId,
        documentRef: kase.pr.number,
        priority: "HIGH",
        slaHours: 24,
        linkUrl: `/pr/${kase.prId}`,
      },
      db,
    );
    await notify(
      {
        roleCodes: ["PROCUREMENT_OFFICER", "BUYER"],
        entityId: kase.pr.entityId,
        type: "CPC_PENDING",
        title: `${kase.number} returned by CPC`,
        body: comment ?? undefined,
        priority: "HIGH",
        linkType: "PR",
        linkId: kase.prId,
        linkUrl: `/pr/${kase.prId}`,
      },
      db,
    );
  }

  await writeAudit(
    {
      entityType: "CpcCase",
      entityId: caseId,
      entityRef: kase.number,
      action: `CPC_${outcome}`,
      newValue: { amount: kase.amount, savings: kase.savingsAmount },
      reason: comment,
      caseKey: kase.pr.number,
      actor: user,
    },
    db,
  );

  return { kase: updated, resolved: true as const, outcome };
}

export async function scheduleMeeting(
  user: SessionUser,
  input: { entityId: string; title: string; scheduledAt: Date; meetingType?: string; location?: string | null; agenda?: string | null; caseIds?: string[] },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.CPC_MANAGE)) {
    throw new ForbiddenError("You do not have permission to manage CPC meetings.");
  }
  const number = await nextNumber(SEQ.CPC_MEETING, db);
  const meeting = await db.cpcMeeting.create({
    data: {
      number,
      entityId: input.entityId,
      title: input.title,
      scheduledAt: input.scheduledAt,
      meetingType: input.meetingType ?? "WEEKLY",
      location: input.location ?? null,
      agenda: input.agenda ?? null,
      status: "SCHEDULED",
    },
  });
  if (input.caseIds?.length) {
    await db.cpcCase.updateMany({
      where: { id: { in: input.caseIds } },
      data: { meetingId: meeting.id, status: "SCHEDULED" },
    });
  }
  await writeAudit(
    {
      entityType: "CpcMeeting",
      entityId: meeting.id,
      entityRef: meeting.number,
      action: "CPC_MEETING_SCHEDULED",
      newValue: { scheduledAt: input.scheduledAt, cases: input.caseIds?.length ?? 0 },
      actor: user,
    },
    db,
  );
  return meeting;
}

export async function recordMinutes(
  user: SessionUser,
  meetingId: string,
  minutes: string,
  complete: boolean,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.CPC_MANAGE)) throw new ForbiddenError("Not permitted.");
  const m = await db.cpcMeeting.update({
    where: { id: meetingId },
    data: { minutes, ...(complete ? { status: "COMPLETED" } : { status: "IN_PROGRESS" }) },
  });
  await writeAudit(
    {
      entityType: "CpcMeeting",
      entityId: meetingId,
      entityRef: m.number,
      action: complete ? "CPC_MEETING_COMPLETED" : "CPC_MINUTES_RECORDED",
      actor: user,
    },
    db,
  );
  return m;
}

/** Committee KPIs for the CPC dashboard. */
export async function cpcStats(entityIds: string[] | null, db: DbClient = prisma) {
  const prFilter = entityIds ? { pr: { entityId: { in: entityIds } } } : {};
  const [pending, approved, rejected, returned, agg, decided] = await Promise.all([
    db.cpcCase.count({ where: { status: { in: ["PENDING", "SCHEDULED", "UNDER_REVIEW"] }, ...prFilter } }),
    db.cpcCase.count({ where: { status: "APPROVED", ...prFilter } }),
    db.cpcCase.count({ where: { status: "REJECTED", ...prFilter } }),
    db.cpcCase.count({ where: { status: { in: ["RETURNED", "CLARIFICATION"] }, ...prFilter } }),
    db.cpcCase.aggregate({ _sum: { amount: true, savingsAmount: true }, where: prFilter }),
    db.cpcCase.findMany({
      where: { decidedAt: { not: null }, ...prFilter },
      select: { createdAt: true, decidedAt: true },
      take: 300,
      orderBy: { decidedAt: "desc" },
    }),
  ]);

  const hours = decided
    .filter((d) => d.decidedAt)
    .map((d) => (d.decidedAt!.getTime() - d.createdAt.getTime()) / 3600000);
  const avgApprovalHours = hours.length ? round2(hours.reduce((a, b) => a + b, 0) / hours.length) : 0;

  return {
    pending,
    approved,
    rejected,
    returned,
    totalValue: round2(agg._sum.amount ?? 0),
    totalSavings: round2(agg._sum.savingsAmount ?? 0),
    avgApprovalHours,
  };
}
