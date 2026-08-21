import { prisma, type DbClient } from "@/lib/db";
import { nextNumber, prefixForProcurementType } from "@/lib/numbering";
import { CONFIG_KEYS, getConfigBool, getConfigNumber } from "@/lib/config";
import { RuleViolationError, NotFoundError, ForbiddenError, ValidationError } from "@/lib/errors";
import { writeAudit, diffFields } from "@/lib/audit";
import { notify, createTask, cancelTasks } from "@/lib/notify";
import { raiseException, autoResolveExceptions } from "@/lib/exceptions-service";
import { startApproval, actOnApproval, getPendingApproval, type ApprovalDecision } from "@/lib/approvals";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { PR_TRANSITIONS, type PrStatus, type Disposition } from "@/lib/domain";
import { round2 } from "@/lib/format";

/**
 * Purchase Requisition / ZD Material Demand service.
 * All state changes funnel through `transitionPr`, which enforces the allowed
 * transition map and writes audit for every move.
 */

export type PrItemInput = {
  itemId?: string | null;
  categoryId: string;
  description: string;
  brand?: string | null;
  model?: string | null;
  make?: string | null;
  specification?: string | null;
  quantity: number;
  unit: string;
  estimatedUnitPrice?: number | null;
  requiredDate?: Date | null;
  disposition?: Disposition;
  notes?: string | null;
};

export type PrInput = {
  entityId: string;
  departmentId: string;
  procurementType: string;
  title: string;
  justification?: string | null;
  projectId?: string | null;
  siteId?: string | null;
  costCenter?: string | null;
  deliveryStoreId?: string | null;
  deliveryLocationNote?: string | null;
  requiredDate: Date;
  priority?: string;
  budgetAmount?: number | null;
  budgetCode?: string | null;
  pmOwnerId?: string | null;
  boqReference?: string | null;
  drawingReference?: string | null;
  technicalNotes?: string | null;
  items: PrItemInput[];
};

function computeItemTotals(items: PrItemInput[]) {
  return items.map((it, i) => ({
    ...it,
    lineNo: i + 1,
    estimatedTotal: round2((it.estimatedUnitPrice ?? 0) * it.quantity),
  }));
}

/**
 * Chooses the default receiving location.
 * ZD Material Demand is routed to the project's site store rather than being
 * pushed through the central warehouse — configurable per entity.
 */
export async function suggestDeliveryStore(
  entityId: string,
  procurementType: string,
  siteId: string | null | undefined,
  projectId: string | null | undefined,
  db: DbClient = prisma,
): Promise<string | null> {
  const routeToSite = await getConfigBool(CONFIG_KEYS.MD_ROUTE_TO_SITE_STORE, entityId, db);
  if (procurementType === "MATERIAL_DEMAND" && routeToSite) {
    if (siteId) {
      const siteStore = await db.store.findFirst({
        where: { entityId, siteId, active: true, kind: { in: ["SITE_STORE", "PROJECT_STORE"] } },
      });
      if (siteStore) return siteStore.id;
    }
    if (projectId) {
      const projStore = await db.store.findFirst({
        where: { entityId, projectId, active: true, kind: { in: ["SITE_STORE", "PROJECT_STORE"] } },
      });
      if (projStore) return projStore.id;
    }
  }
  const central = await db.store.findFirst({
    where: { entityId, active: true, kind: "CENTRAL_WAREHOUSE" },
  });
  if (central) return central.id;
  const anyStore = await db.store.findFirst({ where: { entityId, active: true } });
  return anyStore?.id ?? null;
}

export type ValidationIssue = string;

/**
 * Submission gate. Returns every blocking issue so the UI can show them all at
 * once rather than one at a time.
 */
export async function validateForSubmission(
  prId: string,
  db: DbClient = prisma,
): Promise<ValidationIssue[]> {
  const pr = await db.purchaseRequisition.findUnique({
    where: { id: prId },
    include: { items: { include: { category: true } }, project: true, site: true },
  });
  if (!pr) throw new NotFoundError("Requisition");

  const issues: ValidationIssue[] = [];
  const [requireSpec, justifyAbove, mdBoq, mdDrawing, mdPm] = await Promise.all([
    getConfigBool(CONFIG_KEYS.PR_REQUIRE_SPEC, pr.entityId, db),
    getConfigNumber(CONFIG_KEYS.PR_REQUIRE_JUSTIFICATION_ABOVE, pr.entityId, db),
    getConfigBool(CONFIG_KEYS.MD_REQUIRE_BOQ, pr.entityId, db),
    getConfigBool(CONFIG_KEYS.MD_REQUIRE_DRAWING, pr.entityId, db),
    getConfigBool(CONFIG_KEYS.MD_REQUIRE_PM, pr.entityId, db),
  ]);

  if (!pr.items.length) issues.push("At least one requisition line is required.");
  if (!pr.title.trim()) issues.push("A requisition title is required.");
  if (!pr.requiredDate) issues.push("A required delivery date is required.");
  if (!pr.deliveryStoreId && !pr.deliveryLocationNote?.trim()) {
    issues.push("A preferred delivery location (store or written location) is required.");
  }

  for (const it of pr.items) {
    const l = `Line ${it.lineNo}`;
    if (!it.description.trim()) issues.push(`${l}: description is required.`);
    if (!(it.quantity > 0)) issues.push(`${l}: quantity must be greater than zero.`);
    if (!it.unit.trim()) issues.push(`${l}: unit of measure is required.`);
    if (requireSpec && !it.specification?.trim()) {
      issues.push(`${l}: technical specification is required before submission.`);
    }
  }

  const estimated = round2(pr.items.reduce((a, i) => a + i.estimatedTotal, 0));
  if (estimated >= justifyAbove && !pr.justification?.trim()) {
    issues.push(
      `A written business justification is required for requisitions at or above PKR ${justifyAbove.toLocaleString("en-PK")}.`,
    );
  }
  if (pr.budgetAmount !== null && pr.budgetAmount !== undefined && estimated > pr.budgetAmount) {
    issues.push(
      `Estimated value (PKR ${estimated.toLocaleString("en-PK")}) exceeds the stated budget (PKR ${pr.budgetAmount.toLocaleString("en-PK")}).`,
    );
  }

  // ZD Material Demand carries additional mandatory technical context.
  if (pr.procurementType === "MATERIAL_DEMAND") {
    if (!pr.projectId) issues.push("Material Demand requires a project.");
    if (!pr.siteId) issues.push("Material Demand requires a site.");
    if (mdPm && !pr.pmOwnerId) issues.push("Material Demand requires a named project manager (PM owner).");
    if (mdBoq && !pr.boqReference?.trim()) issues.push("Material Demand requires a BOQ reference.");
    if (mdDrawing && !pr.drawingReference?.trim()) {
      issues.push("Material Demand requires a drawing reference.");
    }
    const docs = await db.document.count({
      where: { linkedType: "PR", linkedId: pr.id, archived: false, category: { in: ["BOQ", "Drawing"] } },
    });
    if (mdBoq && docs === 0) {
      issues.push("Material Demand requires the BOQ and drawing files to be attached.");
    }
  }

  return issues;
}

export async function createPr(user: SessionUser, input: PrInput, db: DbClient = prisma) {
  if (!userHasPermission(user, P.PR_CREATE)) {
    throw new ForbiddenError("You do not have permission to create requisitions.");
  }
  if (!user.entityIds.includes(input.entityId) && !user.permissions.includes(P.ANALYTICS_VIEW_ALL_ENTITIES)) {
    throw new ForbiddenError("You cannot raise requisitions for that entity.");
  }
  if (!input.items.length) throw new ValidationError("Add at least one requisition line.");

  const items = computeItemTotals(input.items);
  const estimatedValue = round2(items.reduce((a, i) => a + i.estimatedTotal, 0));
  const number = await nextNumber(prefixForProcurementType(input.procurementType), db);

  const deliveryStoreId =
    input.deliveryStoreId ??
    (await suggestDeliveryStore(input.entityId, input.procurementType, input.siteId, input.projectId, db));

  const pr = await db.purchaseRequisition.create({
    data: {
      number,
      entityId: input.entityId,
      departmentId: input.departmentId,
      requesterId: user.id,
      procurementType: input.procurementType,
      title: input.title.trim(),
      justification: input.justification ?? null,
      projectId: input.projectId ?? null,
      siteId: input.siteId ?? null,
      costCenter: input.costCenter ?? null,
      deliveryStoreId,
      deliveryLocationNote: input.deliveryLocationNote ?? null,
      requiredDate: input.requiredDate,
      priority: input.priority ?? "NORMAL",
      budgetAmount: input.budgetAmount ?? null,
      budgetCode: input.budgetCode ?? null,
      estimatedValue,
      pmOwnerId: input.pmOwnerId ?? null,
      boqReference: input.boqReference ?? null,
      drawingReference: input.drawingReference ?? null,
      technicalNotes: input.technicalNotes ?? null,
      status: "DRAFT",
      items: {
        create: items.map((it) => ({
          lineNo: it.lineNo,
          itemId: it.itemId ?? null,
          categoryId: it.categoryId,
          description: it.description.trim(),
          brand: it.brand ?? null,
          model: it.model ?? null,
          make: it.make ?? null,
          specification: it.specification ?? null,
          quantity: it.quantity,
          unit: it.unit,
          estimatedUnitPrice: it.estimatedUnitPrice ?? null,
          estimatedTotal: it.estimatedTotal,
          requiredDate: it.requiredDate ?? null,
          disposition: it.disposition ?? "INVENTORY",
          notes: it.notes ?? null,
        })),
      },
    },
  });

  await writeAudit(
    {
      entityType: "PurchaseRequisition",
      entityId: pr.id,
      entityRef: pr.number,
      action: "PR_CREATED",
      newValue: {
        title: pr.title,
        procurementType: pr.procurementType,
        estimatedValue,
        lines: items.length,
      },
      caseKey: pr.number,
      actor: user,
    },
    db,
  );

  return pr;
}

export async function updatePr(user: SessionUser, prId: string, input: PrInput, db: DbClient = prisma) {
  const pr = await db.purchaseRequisition.findUnique({ where: { id: prId }, include: { items: true } });
  if (!pr) throw new NotFoundError("Requisition");

  const editable = ["DRAFT", "RETURNED"];
  if (!editable.includes(pr.status)) {
    throw new RuleViolationError(
      `A requisition can only be edited while it is a draft or has been returned (current status: ${pr.status}).`,
    );
  }
  const isOwner = pr.requesterId === user.id;
  if (!isOwner && !userHasPermission(user, P.PR_EDIT)) {
    throw new ForbiddenError("Only the requester or a procurement officer may edit this requisition.");
  }

  const items = computeItemTotals(input.items);
  const estimatedValue = round2(items.reduce((a, i) => a + i.estimatedTotal, 0));

  const before = {
    title: pr.title,
    justification: pr.justification,
    requiredDate: pr.requiredDate,
    priority: pr.priority,
    estimatedValue: pr.estimatedValue,
    boqReference: pr.boqReference,
    drawingReference: pr.drawingReference,
    deliveryStoreId: pr.deliveryStoreId,
  };

  await db.purchaseRequisitionItem.deleteMany({ where: { prId } });
  const updated = await db.purchaseRequisition.update({
    where: { id: prId },
    data: {
      departmentId: input.departmentId,
      procurementType: input.procurementType,
      title: input.title.trim(),
      justification: input.justification ?? null,
      projectId: input.projectId ?? null,
      siteId: input.siteId ?? null,
      costCenter: input.costCenter ?? null,
      deliveryStoreId: input.deliveryStoreId ?? null,
      deliveryLocationNote: input.deliveryLocationNote ?? null,
      requiredDate: input.requiredDate,
      priority: input.priority ?? "NORMAL",
      budgetAmount: input.budgetAmount ?? null,
      budgetCode: input.budgetCode ?? null,
      estimatedValue,
      pmOwnerId: input.pmOwnerId ?? null,
      boqReference: input.boqReference ?? null,
      drawingReference: input.drawingReference ?? null,
      technicalNotes: input.technicalNotes ?? null,
      items: {
        create: items.map((it) => ({
          lineNo: it.lineNo,
          itemId: it.itemId ?? null,
          categoryId: it.categoryId,
          description: it.description.trim(),
          brand: it.brand ?? null,
          model: it.model ?? null,
          make: it.make ?? null,
          specification: it.specification ?? null,
          quantity: it.quantity,
          unit: it.unit,
          estimatedUnitPrice: it.estimatedUnitPrice ?? null,
          estimatedTotal: it.estimatedTotal,
          requiredDate: it.requiredDate ?? null,
          disposition: it.disposition ?? "INVENTORY",
          notes: it.notes ?? null,
        })),
      },
    },
  });

  await writeAudit(
    {
      entityType: "PurchaseRequisition",
      entityId: prId,
      entityRef: pr.number,
      action: "PR_UPDATED",
      changes: diffFields(before, {
        title: updated.title,
        justification: updated.justification,
        requiredDate: updated.requiredDate,
        priority: updated.priority,
        estimatedValue: updated.estimatedValue,
        boqReference: updated.boqReference,
        drawingReference: updated.drawingReference,
        deliveryStoreId: updated.deliveryStoreId,
      }),
      caseKey: pr.number,
      actor: user,
    },
    db,
  );

  return updated;
}

/**
 * Central transition guard. Rejects any move that is not in the allowed map and
 * records the change with its reason.
 */
export async function transitionPr(
  user: SessionUser | null,
  prId: string,
  to: PrStatus,
  opts: { reason?: string | null; force?: boolean; extraData?: Record<string, unknown> } = {},
  db: DbClient = prisma,
) {
  const pr = await db.purchaseRequisition.findUnique({ where: { id: prId } });
  if (!pr) throw new NotFoundError("Requisition");
  const from = pr.status as PrStatus;
  if (from === to) return pr;

  if (!opts.force) {
    const allowed = PR_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new RuleViolationError(
        `Cannot move requisition ${pr.number} from ${from} to ${to}. Permitted next states: ${allowed.join(", ") || "none"}.`,
      );
    }
  }

  const data: Record<string, unknown> = { status: to, ...(opts.extraData ?? {}) };
  if (to === "SUBMITTED") data.submittedAt = new Date();
  if (to === "APPROVED") data.approvedAt = new Date();
  if (to === "CLOSED") data.closedAt = new Date();
  if (to === "CANCELLED") data.cancelledAt = new Date();
  if (to === "RETURNED") data.returnReason = opts.reason ?? null;
  if (to === "REJECTED") data.rejectReason = opts.reason ?? null;
  if (to === "ON_HOLD") data.holdReason = opts.reason ?? null;

  const updated = await db.purchaseRequisition.update({ where: { id: prId }, data });

  await writeAudit(
    {
      entityType: "PurchaseRequisition",
      entityId: prId,
      entityRef: pr.number,
      action: `PR_STATUS_${to}`,
      changes: { status: { from, to } },
      reason: opts.reason ?? null,
      caseKey: pr.number,
      actor: user,
    },
    db,
  );

  return updated;
}

export async function submitPr(user: SessionUser, prId: string, db: DbClient = prisma) {
  const pr = await db.purchaseRequisition.findUnique({
    where: { id: prId },
    include: { items: true, department: true },
  });
  if (!pr) throw new NotFoundError("Requisition");

  const isOwner = pr.requesterId === user.id;
  if (!isOwner && !userHasPermission(user, P.PR_SUBMIT)) {
    throw new ForbiddenError("Only the requester may submit this requisition.");
  }
  if (!["DRAFT", "RETURNED"].includes(pr.status)) {
    throw new RuleViolationError(`Requisition ${pr.number} has already been submitted.`);
  }

  const issues = await validateForSubmission(prId, db);
  if (issues.length) {
    // Missing specification is a tracked exception, not just a form error.
    if (issues.some((i) => i.toLowerCase().includes("specification"))) {
      await raiseException(
        {
          type: "MISSING_SPECIFICATION",
          severity: "MEDIUM",
          title: `${pr.number} blocked: incomplete specification`,
          description: issues.join(" · "),
          documentType: "PR",
          documentId: pr.id,
          documentRef: pr.number,
          caseKey: pr.number,
          entityId: pr.entityId,
          ownerId: pr.requesterId,
          raisedById: user.id,
        },
        db,
        user,
      );
    }
    throw new ValidationError("This requisition cannot be submitted yet.", issues);
  }

  await autoResolveExceptions("PR", pr.id, ["MISSING_SPECIFICATION"], "Specification completed at submission", db);

  const estimatedValue = round2(pr.items.reduce((a, i) => a + i.estimatedTotal, 0));
  await db.purchaseRequisition.update({ where: { id: prId }, data: { estimatedValue } });

  await transitionPr(user, prId, "SUBMITTED", {}, db);

  const deptApprovalRequired = await getConfigBool(CONFIG_KEYS.DEPT_APPROVAL_REQUIRED, pr.entityId, db);
  const primaryCategoryId = pr.items[0]?.categoryId ?? null;

  const approval = await startApproval(
    {
      documentType: pr.procurementType === "MATERIAL_DEMAND" ? "MATERIAL_DEMAND" : "PR",
      documentId: pr.id,
      documentRef: pr.number,
      entityId: pr.entityId,
      departmentId: pr.departmentId,
      categoryId: primaryCategoryId,
      procurementType: pr.procurementType,
      requesterId: pr.requesterId,
      amount: estimatedValue,
      caseKey: pr.number,
      linkUrl: `/pr/${pr.id}`,
      actor: user,
    },
    db,
  );

  if (approval.autoApproved || !deptApprovalRequired) {
    await transitionPr(user, prId, "UNDER_DEPARTMENT_APPROVAL", { force: true }, db);
    await transitionPr(user, prId, "APPROVED", {}, db);
    await transitionPr(user, prId, "PROCUREMENT_REVIEW", {}, db);
    await notify(
      {
        roleCodes: ["PROCUREMENT_OFFICER", "BUYER", "PROCUREMENT_SENIOR_MANAGER"],
        entityId: pr.entityId,
        type: "APPROVAL_REQUIRED",
        title: `${pr.number} ready for procurement review`,
        body: pr.title,
        priority: "NORMAL",
        linkType: "PR",
        linkId: pr.id,
        linkUrl: `/pr/${pr.id}`,
      },
      db,
    );
  } else {
    await transitionPr(user, prId, "UNDER_DEPARTMENT_APPROVAL", {}, db);
  }

  return { approval, estimatedValue };
}

/**
 * Records an approval decision and advances the PR through the lifecycle when
 * the chain completes.
 */
export async function decidePr(
  user: SessionUser,
  prId: string,
  decision: ApprovalDecision,
  comment: string | null,
  db: DbClient = prisma,
) {
  const pr = await db.purchaseRequisition.findUnique({ where: { id: prId }, include: { items: true } });
  if (!pr) throw new NotFoundError("Requisition");

  const permMap: Record<ApprovalDecision, string[]> = {
    APPROVED: [P.PR_APPROVE],
    REJECTED: [P.PR_REJECT, P.PR_APPROVE],
    RETURNED: [P.PR_RETURN, P.PR_APPROVE],
    CLARIFICATION_REQUESTED: [P.PR_CLARIFY, P.PR_APPROVE],
  };
  if (!userHasPermission(user, ...permMap[decision])) {
    throw new ForbiddenError(`You do not have permission to ${decision.toLowerCase()} requisitions.`);
  }

  const instance = await getPendingApproval(
    pr.procurementType === "MATERIAL_DEMAND" ? "MATERIAL_DEMAND" : "PR",
    pr.id,
    db,
  );
  if (!instance) {
    throw new RuleViolationError(`Requisition ${pr.number} has no approval pending a decision.`);
  }

  const result = await actOnApproval(
    {
      instanceId: instance.id,
      decision,
      comment,
      actor: user,
      caseKey: pr.number,
      linkUrl: `/pr/${pr.id}`,
    },
    db,
  );

  if (decision === "REJECTED") {
    await transitionPr(user, prId, "REJECTED", { reason: comment }, db);
    await cancelTasks("PR", pr.id, db);
    await notify(
      {
        userIds: [pr.requesterId],
        type: "PR_REJECTED",
        title: `${pr.number} was rejected`,
        body: comment ?? undefined,
        priority: "HIGH",
        linkType: "PR",
        linkId: pr.id,
        linkUrl: `/pr/${pr.id}`,
      },
      db,
    );
    return result;
  }

  if (decision === "RETURNED" || decision === "CLARIFICATION_REQUESTED") {
    await transitionPr(user, prId, "RETURNED", { reason: comment }, db);
    await cancelTasks("PR", pr.id, db);
    await createTask(
      {
        title: `Revise and resubmit ${pr.number}`,
        description: comment ?? undefined,
        taskType: "ACTION",
        assigneeId: pr.requesterId,
        entityId: pr.entityId,
        documentType: "PR",
        documentId: pr.id,
        documentRef: pr.number,
        priority: "HIGH",
        slaHours: 24,
        linkUrl: `/pr/${pr.id}/edit`,
      },
      db,
    );
    await notify(
      {
        userIds: [pr.requesterId],
        type: "PR_RETURNED",
        title: `${pr.number} returned for revision`,
        body: comment ?? undefined,
        priority: "HIGH",
        linkType: "PR",
        linkId: pr.id,
        linkUrl: `/pr/${pr.id}`,
      },
      db,
    );
    return result;
  }

  // APPROVED
  if (result.completed) {
    await transitionPr(user, prId, "APPROVED", { reason: comment }, db);
    await transitionPr(user, prId, "PROCUREMENT_REVIEW", {}, db);
    await createTask(
      {
        title: `Source ${pr.number} — ${pr.title}`,
        taskType: "REVIEW",
        assignedRoleCode: "PROCUREMENT_OFFICER",
        entityId: pr.entityId,
        documentType: "PR",
        documentId: pr.id,
        documentRef: pr.number,
        priority: pr.priority === "URGENT" ? "HIGH" : "NORMAL",
        slaHours: await getConfigNumber(CONFIG_KEYS.SLA_PROCUREMENT_REVIEW_HOURS, pr.entityId, db),
        linkUrl: `/pr/${pr.id}`,
      },
      db,
    );
    await notify(
      {
        roleCodes: ["PROCUREMENT_OFFICER", "BUYER"],
        entityId: pr.entityId,
        type: "APPROVAL_REQUIRED",
        title: `${pr.number} approved — ready for sourcing`,
        body: `${pr.title} · PKR ${pr.estimatedValue.toLocaleString("en-PK")}`,
        linkType: "PR",
        linkId: pr.id,
        linkUrl: `/pr/${pr.id}`,
      },
      db,
    );
    await notify(
      {
        userIds: [pr.requesterId],
        type: "GENERAL",
        title: `${pr.number} approved`,
        body: "Your requisition has been approved and moved to procurement.",
        linkType: "PR",
        linkId: pr.id,
        linkUrl: `/pr/${pr.id}`,
      },
      db,
    );
  }

  return result;
}

/** Moves an approved PR into sourcing, which is where RFQs may be raised. */
export async function startSourcing(user: SessionUser, prId: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.RFQ_ISSUE, P.PR_VIEW_ALL)) {
    throw new ForbiddenError("You do not have permission to move requisitions into sourcing.");
  }
  const pr = await db.purchaseRequisition.findUnique({ where: { id: prId } });
  if (!pr) throw new NotFoundError("Requisition");
  if (pr.status === "SOURCING") return pr;
  if (pr.status !== "PROCUREMENT_REVIEW" && pr.status !== "APPROVED") {
    throw new RuleViolationError(
      `Requisition ${pr.number} must be approved and under procurement review before sourcing begins (current: ${pr.status}).`,
    );
  }
  if (pr.status === "APPROVED") await transitionPr(user, prId, "PROCUREMENT_REVIEW", {}, db);
  return transitionPr(user, prId, "SOURCING", {}, db);
}

export async function cancelPr(user: SessionUser, prId: string, reason: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.PR_CANCEL)) {
    const pr = await db.purchaseRequisition.findUnique({ where: { id: prId } });
    if (!pr || pr.requesterId !== user.id || pr.status !== "DRAFT") {
      throw new ForbiddenError("You do not have permission to cancel this requisition.");
    }
  }
  if (!reason?.trim()) throw new ValidationError("A cancellation reason is required.");

  const pr = await db.purchaseRequisition.findUnique({
    where: { id: prId },
    include: { purchaseOrders: { where: { status: { notIn: ["CANCELLED", "CLOSED"] } } } },
  });
  if (!pr) throw new NotFoundError("Requisition");
  if (pr.purchaseOrders.length) {
    throw new RuleViolationError(
      `Requisition ${pr.number} has ${pr.purchaseOrders.length} open purchase order(s). Cancel or close those first.`,
    );
  }

  await db.approvalInstance.updateMany({
    where: { documentId: prId, status: "PENDING" },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
  await cancelTasks("PR", prId, db);
  return transitionPr(user, prId, "CANCELLED", { reason, force: true }, db);
}

export async function holdPr(user: SessionUser, prId: string, reason: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.PR_HOLD)) {
    throw new ForbiddenError("You do not have permission to place requisitions on hold.");
  }
  if (!reason?.trim()) throw new ValidationError("A reason is required to place a requisition on hold.");
  return transitionPr(user, prId, "ON_HOLD", { reason, force: true }, db);
}

export async function releaseHold(
  user: SessionUser,
  prId: string,
  to: PrStatus,
  reason: string | null,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.PR_HOLD)) {
    throw new ForbiddenError("You do not have permission to release requisitions from hold.");
  }
  return transitionPr(user, prId, to, { reason, force: true, extraData: { holdReason: null } }, db);
}

/** PR list scoping: users without PR_VIEW_ALL only see their own or their department's. */
export function prVisibilityFilter(user: SessionUser) {
  if (userHasPermission(user, P.PR_VIEW_ALL)) return {};
  return {
    OR: [
      { requesterId: user.id },
      { pmOwnerId: user.id },
      ...(user.primaryDepartmentId ? [{ departmentId: user.primaryDepartmentId }] : []),
    ],
  };
}

export async function assertCanViewPr(user: SessionUser, prId: string, db: DbClient = prisma) {
  const pr = await db.purchaseRequisition.findUnique({
    where: { id: prId },
    select: { id: true, requesterId: true, departmentId: true, entityId: true, pmOwnerId: true },
  });
  if (!pr) throw new NotFoundError("Requisition");
  if (userHasPermission(user, P.PR_VIEW_ALL)) return pr;
  const own =
    pr.requesterId === user.id ||
    pr.pmOwnerId === user.id ||
    (user.primaryDepartmentId && pr.departmentId === user.primaryDepartmentId);
  if (!own) throw new ForbiddenError("You do not have access to this requisition.");
  return pr;
}
