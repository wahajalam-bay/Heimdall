import { prisma, type DbClient } from "./db";
import { RuleViolationError, NotFoundError, ForbiddenError } from "./errors";
import { writeAudit, type AuditActor } from "./audit";
import { notify, createTask, completeTasks, usersForRoles } from "./notify";
import { raiseException } from "./exceptions-service";
import type { SessionUser } from "./rbac";
import { lineManager, peopleAtOrAbove } from "@/server/org";

/**
 * Configurable approval engine.
 *
 * Rules are data (`approval_rules` + `approval_rule_steps`), matched on
 * document type, entity, department, category, procurement type and amount
 * band. The most specific active rule with the lowest priority wins. Nothing
 * here knows about a 500,000 threshold — that lives in configuration and in the
 * seeded rule set.
 */

export const APPROVAL_DOC_TYPES = {
  PR: "PR",
  MATERIAL_DEMAND: "MATERIAL_DEMAND",
  PO: "PO",
  INVOICE: "INVOICE",
  PETTY_CASH: "PETTY_CASH",
  DISPOSAL: "DISPOSAL",
  VENDOR: "VENDOR",
  STORE_TRANSFER: "STORE_TRANSFER",
  STORE_ISSUE: "STORE_ISSUE",
} as const;

export type ApprovalDocType = (typeof APPROVAL_DOC_TYPES)[keyof typeof APPROVAL_DOC_TYPES];

export type RuleMatchInput = {
  documentType: string;
  entityId?: string | null;
  departmentId?: string | null;
  categoryId?: string | null;
  procurementType?: string | null;
  amount: number;
};

/**
 * Scores candidate rules by specificity so a category-and-entity rule beats a
 * bare entity rule, which beats a global fallback.
 */
export async function findApprovalRule(input: RuleMatchInput, db: DbClient = prisma) {
  const candidates = await db.approvalRule.findMany({
    where: {
      documentType: input.documentType,
      active: true,
      minAmount: { lte: input.amount },
      AND: [{ OR: [{ maxAmount: null }, { maxAmount: { gte: input.amount } }] }],
      OR: [{ entityId: null }, { entityId: input.entityId ?? undefined }],
    },
    include: { steps: { orderBy: { sequence: "asc" }, include: { role: true } } },
  });

  const viable = candidates.filter((r) => {
    if (r.departmentId && r.departmentId !== input.departmentId) return false;
    if (r.categoryId && r.categoryId !== input.categoryId) return false;
    if (r.procurementType && r.procurementType !== input.procurementType) return false;
    return true;
  });

  if (!viable.length) return null;

  const specificity = (r: (typeof viable)[number]) =>
    (r.entityId ? 8 : 0) + (r.departmentId ? 4 : 0) + (r.categoryId ? 2 : 0) + (r.procurementType ? 1 : 0);

  viable.sort((a, b) => {
    const s = specificity(b) - specificity(a);
    if (s !== 0) return s;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.minAmount - a.minAmount;
  });

  return viable[0];
}

type StepAssignment = { userIds: string[]; roleCode: string | null; label: string };

async function resolveStepAssignees(
  step: {
    approverType: string;
    roleId: string | null;
    specificUserId: string | null;
    gradeCode?: string | null;
    name: string;
    role?: { code: string; name: string } | null;
  },
  ctx: { entityId?: string | null; departmentId?: string | null; requesterId?: string | null },
  db: DbClient,
): Promise<StepAssignment> {
  if (step.approverType === "SPECIFIC_USER" && step.specificUserId) {
    return { userIds: [step.specificUserId], roleCode: null, label: step.name };
  }
  if (step.approverType === "DEPARTMENT_HEAD") {
    if (ctx.departmentId) {
      const dept = await db.department.findUnique({ where: { id: ctx.departmentId } });
      if (dept?.headId) return { userIds: [dept.headId], roleCode: "HOD", label: step.name };
    }
    const hods = await usersForRoles(["HOD"], ctx.entityId, db);
    return { userIds: hods, roleCode: "HOD", label: step.name };
  }
  if (step.approverType === "CPC") {
    // CPC is handled by the CPC module; the approval step is informational.
    return { userIds: [], roleCode: "CPC_MEMBER", label: step.name };
  }
  // The organogram, rather than a role. A rule that says "this goes to the
  // requester's line manager" names one person; the same rule expressed as a
  // role names everybody who holds it and is decided by whoever looks first.
  if (step.approverType === "LINE_MANAGER" && ctx.requesterId) {
    const boss = await lineManager(ctx.requesterId, db);
    if (boss) return { userIds: [boss.id], roleCode: null, label: step.name };
    // Nobody above them on the chart: fall through to the role on the step, so
    // the document waits with somebody rather than with nobody.
  }
  if (step.approverType === "GRADE" && step.gradeCode) {
    const people = await peopleAtOrAbove(step.gradeCode, db);
    if (people.length) return { userIds: people.map((p) => p.id), roleCode: null, label: step.name };
  }
  const roleCode = step.role?.code ?? null;
  const userIds = roleCode ? await usersForRoles([roleCode], ctx.entityId, db) : [];
  return { userIds, roleCode, label: step.name };
}

export type StartApprovalInput = {
  documentType: string;
  documentId: string;
  documentRef: string;
  entityId?: string | null;
  departmentId?: string | null;
  categoryId?: string | null;
  procurementType?: string | null;
  requesterId?: string | null;
  amount: number;
  caseKey?: string | null;
  linkUrl?: string | null;
  actor?: AuditActor | null;
};

export type StartApprovalResult = {
  instanceId: string | null;
  ruleCode: string | null;
  requiresCpc: boolean;
  steps: Array<{ sequence: number; name: string; roleCode: string | null; assignees: string[] }>;
  /** True when no rule matched and the document is auto-approved. */
  autoApproved: boolean;
};

/**
 * Instantiates the approval chain. Cancels any previous pending instance for
 * the same document so re-submission after a return does not leave orphans.
 */
export async function startApproval(
  input: StartApprovalInput,
  db: DbClient = prisma,
): Promise<StartApprovalResult> {
  await db.approvalInstance.updateMany({
    where: { documentType: input.documentType, documentId: input.documentId, status: "PENDING" },
    data: { status: "CANCELLED", completedAt: new Date() },
  });

  const rule = await findApprovalRule(
    {
      documentType: input.documentType,
      entityId: input.entityId,
      departmentId: input.departmentId,
      categoryId: input.categoryId,
      procurementType: input.procurementType,
      amount: input.amount,
    },
    db,
  );

  if (!rule || !rule.steps.length) {
    return { instanceId: null, ruleCode: null, requiresCpc: false, steps: [], autoApproved: true };
  }

  const instance = await db.approvalInstance.create({
    data: {
      ruleId: rule.id,
      documentType: input.documentType,
      documentId: input.documentId,
      documentRef: input.documentRef,
      entityId: input.entityId ?? null,
      amount: input.amount,
      status: "PENDING",
      currentSequence: rule.steps[0].sequence,
    },
  });

  const stepsOut: StartApprovalResult["steps"] = [];
  for (const step of rule.steps) {
    const assignment = await resolveStepAssignees(step, input, db);
    await db.approvalAction.create({
      data: {
        instanceId: instance.id,
        stepId: step.id,
        sequence: step.sequence,
        stepName: step.name,
        action: "PENDING",
        assignedRoleCode: assignment.roleCode,
        dueAt: new Date(Date.now() + step.slaHours * 3600 * 1000),
      },
    });
    stepsOut.push({
      sequence: step.sequence,
      name: step.name,
      roleCode: assignment.roleCode,
      assignees: assignment.userIds,
    });
  }

  const first = rule.steps[0];
  const firstAssignment = await resolveStepAssignees(first, input, db);
  await fanOutStep(
    {
      instanceId: instance.id,
      documentType: input.documentType,
      documentId: input.documentId,
      documentRef: input.documentRef,
      entityId: input.entityId ?? null,
      stepName: first.name,
      slaHours: first.slaHours,
      assignment: firstAssignment,
      linkUrl: input.linkUrl ?? null,
      amount: input.amount,
    },
    db,
  );

  await writeAudit(
    {
      entityType: "ApprovalInstance",
      entityId: instance.id,
      entityRef: input.documentRef,
      action: "APPROVAL_STARTED",
      newValue: { rule: rule.code, steps: rule.steps.map((s) => s.name), amount: input.amount },
      caseKey: input.caseKey ?? null,
      actor: input.actor ?? null,
    },
    db,
  );

  return {
    instanceId: instance.id,
    ruleCode: rule.code,
    requiresCpc: rule.requiresCpc,
    steps: stepsOut,
    autoApproved: false,
  };
}

async function fanOutStep(
  args: {
    instanceId: string;
    documentType: string;
    documentId: string;
    documentRef: string;
    entityId: string | null;
    stepName: string;
    slaHours: number;
    assignment: StepAssignment;
    linkUrl: string | null;
    amount: number;
  },
  db: DbClient,
) {
  const { assignment } = args;
  const title = `Approval required — ${args.documentRef}`;
  const body = `${args.stepName} · ${args.amount ? `PKR ${args.amount.toLocaleString("en-PK")}` : ""}`.trim();

  if (assignment.userIds.length) {
    for (const uid of assignment.userIds) {
      await createTask(
        {
          title: `${args.stepName}: ${args.documentRef}`,
          taskType: "APPROVAL",
          assigneeId: uid,
          entityId: args.entityId,
          documentType: args.documentType,
          documentId: args.documentId,
          documentRef: args.documentRef,
          slaHours: args.slaHours,
          linkUrl: args.linkUrl,
          priority: "HIGH",
        },
        db,
      );
    }
  } else if (assignment.roleCode) {
    await createTask(
      {
        title: `${args.stepName}: ${args.documentRef}`,
        taskType: "APPROVAL",
        assignedRoleCode: assignment.roleCode,
        entityId: args.entityId,
        documentType: args.documentType,
        documentId: args.documentId,
        documentRef: args.documentRef,
        slaHours: args.slaHours,
        linkUrl: args.linkUrl,
        priority: "HIGH",
      },
      db,
    );
  }

  await notify(
    {
      userIds: assignment.userIds,
      roleCodes: assignment.userIds.length ? [] : assignment.roleCode ? [assignment.roleCode] : [],
      entityId: args.entityId,
      type: "APPROVAL_REQUIRED",
      title,
      body,
      priority: "HIGH",
      linkType: args.documentType,
      linkId: args.documentId,
      linkUrl: args.linkUrl,
    },
    db,
  );
}

export type ApprovalDecision = "APPROVED" | "REJECTED" | "RETURNED" | "CLARIFICATION_REQUESTED";

export type ActOnApprovalInput = {
  instanceId: string;
  decision: ApprovalDecision;
  comment?: string | null;
  actor: SessionUser;
  caseKey?: string | null;
  linkUrl?: string | null;
  /** Skip role checks — used by CPC consolidation and system escalations. */
  system?: boolean;
};

export type ActOnApprovalResult = {
  instanceStatus: "PENDING" | "APPROVED" | "REJECTED" | "RETURNED" | "CLARIFICATION";
  /** True when the whole chain completed successfully. */
  completed: boolean;
  nextStepName: string | null;
  actedSequence: number;
};

/**
 * Records one approver's decision, advances or terminates the chain.
 * Authorization: the actor must either hold the step's role, be the named
 * assignee, or be a system administrator.
 */
export async function actOnApproval(
  input: ActOnApprovalInput,
  db: DbClient = prisma,
): Promise<ActOnApprovalResult> {
  const instance = await db.approvalInstance.findUnique({
    where: { id: input.instanceId },
    include: {
      actions: { orderBy: { sequence: "asc" }, include: { step: { include: { role: true } } } },
      rule: { include: { steps: { orderBy: { sequence: "asc" }, include: { role: true } } } },
    },
  });
  if (!instance) throw new NotFoundError("Approval instance");
  if (instance.status !== "PENDING") {
    throw new RuleViolationError(`This approval is already ${instance.status.toLowerCase()}.`);
  }

  const current = instance.actions.find(
    (a) => a.sequence === instance.currentSequence && a.action === "PENDING",
  );
  if (!current) throw new RuleViolationError("No pending approval step to act on.");

  if (!input.system) {
    const isSysAdmin = input.actor.roleCodes.includes("SYSTEM_ADMIN");
    const holdsRole = current.assignedRoleCode
      ? input.actor.roleCodes.includes(current.assignedRoleCode)
      : false;
    const isNamedAssignee = await db.task.findFirst({
      where: {
        documentType: instance.documentType,
        documentId: instance.documentId,
        assigneeId: input.actor.id,
        taskType: "APPROVAL",
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
      select: { id: true },
    });
    if (!isSysAdmin && !holdsRole && !isNamedAssignee) {
      throw new ForbiddenError(
        `This step (${current.stepName}) is assigned to ${current.assignedRoleCode ?? "a specific approver"}. You are not an authorised approver for it.`,
      );
    }
  }

  if (current.step?.commentRequired && !input.comment?.trim() && input.decision !== "APPROVED") {
    throw new RuleViolationError("A comment is required for this decision.");
  }
  if (input.decision !== "APPROVED" && !input.comment?.trim()) {
    throw new RuleViolationError("Please provide a reason for this decision.");
  }

  await db.approvalAction.update({
    where: { id: current.id },
    data: {
      action: input.decision,
      actorId: input.actor.id,
      comment: input.comment ?? null,
      actedAt: new Date(),
    },
  });

  await completeTasks(instance.documentType, instance.documentId, input.actor.id, db, "APPROVAL");

  // Flag SLA breaches so the bottleneck view has a durable record.
  if (current.dueAt && current.dueAt < new Date()) {
    await raiseException(
      {
        type: "APPROVAL_DELAY",
        severity: "MEDIUM",
        title: `Approval SLA breached at "${current.stepName}" on ${instance.documentRef}`,
        description: `Step was due ${current.dueAt.toISOString()} and actioned ${new Date().toISOString()}.`,
        documentType: instance.documentType,
        documentId: instance.documentId,
        documentRef: instance.documentRef,
        caseKey: input.caseKey ?? null,
        entityId: instance.entityId,
        ownerId: input.actor.id,
        raisedById: input.actor.id,
      },
      db,
      input.actor,
    );
  }

  let instanceStatus: ActOnApprovalResult["instanceStatus"] = "PENDING";
  let nextStepName: string | null = null;
  let completed = false;

  if (input.decision === "REJECTED") {
    instanceStatus = "REJECTED";
  } else if (input.decision === "RETURNED") {
    instanceStatus = "RETURNED";
  } else if (input.decision === "CLARIFICATION_REQUESTED") {
    instanceStatus = "CLARIFICATION";
  } else {
    const remaining = instance.actions
      .filter((a) => a.sequence > current.sequence && a.action === "PENDING")
      .sort((a, b) => a.sequence - b.sequence);
    if (!remaining.length) {
      instanceStatus = "APPROVED";
      completed = true;
    } else {
      const next = remaining[0];
      nextStepName = next.stepName;
      await db.approvalInstance.update({
        where: { id: instance.id },
        data: { currentSequence: next.sequence },
      });
      const ruleStep = instance.rule?.steps.find((s) => s.id === next.stepId);
      if (ruleStep) {
        const doc = await docContext(instance.documentType, instance.documentId, db);
        const assignment = await resolveStepAssignees(ruleStep, doc, db);
        await fanOutStep(
          {
            instanceId: instance.id,
            documentType: instance.documentType,
            documentId: instance.documentId,
            documentRef: instance.documentRef,
            entityId: instance.entityId,
            stepName: next.stepName,
            slaHours: ruleStep.slaHours,
            assignment,
            linkUrl: input.linkUrl ?? null,
            amount: instance.amount,
          },
          db,
        );
      }
    }
  }

  if (instanceStatus !== "PENDING") {
    await db.approvalInstance.update({
      where: { id: instance.id },
      data: { status: instanceStatus, completedAt: new Date() },
    });
    // Any still-pending later steps become moot.
    await db.approvalAction.updateMany({
      where: { instanceId: instance.id, action: "PENDING" },
      data: { action: "SKIPPED", actedAt: new Date() },
    });
  }

  await writeAudit(
    {
      entityType: "ApprovalInstance",
      entityId: instance.id,
      entityRef: instance.documentRef,
      action: `APPROVAL_${input.decision}`,
      newValue: { step: current.stepName, sequence: current.sequence, comment: input.comment ?? null },
      reason: input.comment ?? null,
      caseKey: input.caseKey ?? null,
      actor: input.actor,
    },
    db,
  );

  return { instanceStatus, completed, nextStepName, actedSequence: current.sequence };
}

async function docContext(
  documentType: string,
  documentId: string,
  db: DbClient,
): Promise<{ entityId?: string | null; departmentId?: string | null; requesterId?: string | null }> {
  if (documentType === "PR" || documentType === "MATERIAL_DEMAND") {
    const pr = await db.purchaseRequisition.findUnique({
      where: { id: documentId },
      select: { entityId: true, departmentId: true, requesterId: true },
    });
    return pr ?? {};
  }
  if (documentType === "PO") {
    const po = await db.purchaseOrder.findUnique({
      where: { id: documentId },
      select: { entityId: true, createdById: true, pr: { select: { departmentId: true } } },
    });
    return po ? { entityId: po.entityId, departmentId: po.pr?.departmentId ?? null, requesterId: po.createdById } : {};
  }
  if (documentType === "INVOICE") {
    const inv = await db.invoice.findUnique({
      where: { id: documentId },
      select: { po: { select: { entityId: true, pr: { select: { departmentId: true } } } } },
    });
    return inv ? { entityId: inv.po?.entityId ?? null, departmentId: inv.po?.pr?.departmentId ?? null } : {};
  }
  if (documentType === "PETTY_CASH") {
    const pc = await db.pettyCashRequest.findUnique({
      where: { id: documentId },
      select: { entityId: true, departmentId: true, requesterId: true },
    });
    return pc ?? {};
  }
  if (documentType === "DISPOSAL") {
    const dc = await db.disposalCase.findUnique({
      where: { id: documentId },
      select: { entityId: true, raisedById: true },
    });
    return dc ? { entityId: dc.entityId, requesterId: dc.raisedById } : {};
  }
  return {};
}

export type ApprovalTrail = {
  instanceId: string;
  status: string;
  amount: number;
  ruleName: string | null;
  currentSequence: number;
  startedAt: Date;
  completedAt: Date | null;
  steps: Array<{
    id: string;
    sequence: number;
    stepName: string;
    action: string;
    actorName: string | null;
    assignedRoleCode: string | null;
    comment: string | null;
    dueAt: Date | null;
    actedAt: Date | null;
    overdue: boolean;
  }>;
};

export async function getApprovalTrail(
  documentType: string,
  documentId: string,
  db: DbClient = prisma,
): Promise<ApprovalTrail[]> {
  const instances = await db.approvalInstance.findMany({
    where: { documentType, documentId },
    orderBy: { startedAt: "desc" },
    include: {
      rule: true,
      actions: { orderBy: { sequence: "asc" }, include: { actor: { select: { name: true } } } },
    },
  });
  const now = new Date();
  return instances.map((i) => ({
    instanceId: i.id,
    status: i.status,
    amount: i.amount,
    ruleName: i.rule?.name ?? null,
    currentSequence: i.currentSequence,
    startedAt: i.startedAt,
    completedAt: i.completedAt,
    steps: i.actions.map((a) => ({
      id: a.id,
      sequence: a.sequence,
      stepName: a.stepName,
      action: a.action,
      actorName: a.actor?.name ?? null,
      assignedRoleCode: a.assignedRoleCode,
      comment: a.comment,
      dueAt: a.dueAt,
      actedAt: a.actedAt,
      overdue: a.action === "PENDING" && !!a.dueAt && a.dueAt < now,
    })),
  }));
}

/** The pending approval instance for a document, if any. */
export async function getPendingApproval(documentType: string, documentId: string, db: DbClient = prisma) {
  return db.approvalInstance.findFirst({
    where: { documentType, documentId, status: "PENDING" },
    include: { actions: { orderBy: { sequence: "asc" } }, rule: true },
  });
}

/** Can this user act on the current step of a pending instance? */
export async function canUserActOnApproval(
  user: SessionUser,
  documentType: string,
  documentId: string,
  db: DbClient = prisma,
): Promise<{ can: boolean; instanceId: string | null; stepName: string | null; reason?: string }> {
  const instance = await getPendingApproval(documentType, documentId, db);
  if (!instance) return { can: false, instanceId: null, stepName: null, reason: "No approval pending." };
  const current = instance.actions.find((a) => a.sequence === instance.currentSequence && a.action === "PENDING");
  if (!current) return { can: false, instanceId: instance.id, stepName: null, reason: "No pending step." };
  if (user.roleCodes.includes("SYSTEM_ADMIN")) {
    return { can: true, instanceId: instance.id, stepName: current.stepName };
  }
  if (current.assignedRoleCode && user.roleCodes.includes(current.assignedRoleCode)) {
    return { can: true, instanceId: instance.id, stepName: current.stepName };
  }
  const task = await db.task.findFirst({
    where: {
      documentType,
      documentId,
      assigneeId: user.id,
      taskType: "APPROVAL",
      status: { in: ["OPEN", "IN_PROGRESS"] },
    },
    select: { id: true },
  });
  if (task) return { can: true, instanceId: instance.id, stepName: current.stepName };
  return {
    can: false,
    instanceId: instance.id,
    stepName: current.stepName,
    reason: `Awaiting ${current.assignedRoleCode ?? "assigned approver"}.`,
  };
}
