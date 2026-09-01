import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, prefixForProcurementType } from "@/lib/numbering";
import { CONFIG_KEYS, getConfig, getConfigBool, getConfigNumber } from "@/lib/config";
import { RuleViolationError, NotFoundError, ForbiddenError, ValidationError } from "@/lib/errors";
import { writeAudit, diffFields } from "@/lib/audit";
import { notify, createTask, cancelTasks } from "@/lib/notify";
import { raiseException, autoResolveExceptions } from "@/lib/exceptions-service";
import { startApproval, actOnApproval, getPendingApproval, type ApprovalDecision } from "@/lib/approvals";
import { PERMISSIONS as P } from "@/lib/permissions";
import { SOD_RULES, assertSeparation } from "@/lib/sod";
import { assertEntityAccess, userHasPermission, type SessionUser } from "@/lib/rbac";
import { DOMAIN_ACTIONS, assertAuthority, type Actor, type Authority } from "@/lib/actor";
import {
  PR_MODULE_BOUNDARY,
  PR_TRANSITIONS,
  PR_TRANSITION_AUTHORITY,
  inRequisitionStage,
  requisitionComplete,
  type PrStatus,
  type Disposition,
} from "@/lib/domain";
import { round2 } from "@/lib/format";
import {
  PROCUREMENT_KIND_LABELS,
  assertHomogeneousKind,
  kindFromProcurementType,
  kindOfLines,
  type ProcurementKind,
} from "@/lib/kind";
import { escalationChain } from "@/server/org";
import { availableQuantity } from "@/server/inventory";
import { attest } from "@/server/attestation";

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
  /** GOODS or SERVICES. Omitted, the requisition's kind applies. */
  procurementKind?: ProcurementKind;
  /**
   * Annexure 1 "Item Code".
   *
   * A catalogue line has one already, through `item.sku`. This carries the code
   * for something not in the catalogue, which the form has a column for and
   * which is most of what a requisition asks for.
   */
  itemCode?: string | null;
};

export type PrInput = {
  entityId: string;
  departmentId: string;
  procurementType: string;
  /**
   * GOODS or SERVICES. Omitted, it is derived from `procurementType` — which
   * only distinguishes the two for a SERVICE requisition, so anything else
   * defaults to goods and is corrected by the line kinds below.
   */
  procurementKind?: ProcurementKind;
  /** A sibling requisition raised from the same business need. */
  linkedPrId?: string | null;
  title: string;
  justification?: string | null;
  projectId?: string | null;
  siteId?: string | null;
  costCenter?: string | null;
  deliveryStoreId?: string | null;
  deliveryLocationNote?: string | null;
  /**
   * Annexure 1 "Req Location" — where the goods are wanted, which is not always
   * the store that receives them. Kept apart from `deliveryLocationNote`, which
   * is a note about the delivery rather than the requesting location.
   */
  requiredLocation?: string | null;
  /**
   * Annexure 1 "Document Comments" — a note about the requisition as a whole,
   * distinct from the business justification for buying.
   */
  documentComments?: string | null;
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
  // Goods and services diverge after the order and never rejoin, so a
  // requisition is one or the other. Where the caller has not said, the kind is
  // taken from the lines; where the lines disagree, the requisition is refused
  // rather than quietly filed as whichever kind came first.
  const lineKind = kindOfLines(items);
  const kind: ProcurementKind =
    input.procurementKind ?? lineKind ?? kindFromProcurementType(input.procurementType);
  assertHomogeneousKind(kind, items, `This ${PROCUREMENT_KIND_LABELS[kind].toLowerCase()} requisition`);

  const number = await nextNumber(prefixForProcurementType(input.procurementType), db);

  const deliveryStoreId =
    input.deliveryStoreId ??
    (await suggestDeliveryStore(input.entityId, input.procurementType, input.siteId, input.projectId, db));

  // What was on the shelf when this was raised.
  //
  // Only for a catalogue line with a delivery store — anything else has no
  // bucket to read, and a zero would read as "none in stock" rather than "not
  // checked". Available, not on-hand: stock already reserved against another
  // demand is not available to this one, and telling the requester otherwise is
  // how two people order the same thing.
  const checkedAt = new Date();
  const stockAtRequest = new Map<number, number>();
  if (deliveryStoreId) {
    for (const it of items) {
      if (!it.itemId) continue;
      try {
        stockAtRequest.set(it.lineNo, await availableQuantity(it.itemId, deliveryStoreId, db));
      } catch {
        // A missing bucket is not a reason to refuse the requisition. The column
        // stays blank, which is honest, and the form says why.
      }
    }
  }

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
      requiredLocation: input.requiredLocation ?? null,
      documentComments: input.documentComments ?? null,
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
      procurementKind: kind,
      linkedPrId: input.linkedPrId ?? null,
      items: {
        create: items.map((it) => ({
          lineNo: it.lineNo,
          procurementKind: it.procurementKind ?? kind,
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
          itemCode: it.itemCode ?? null,
          // Annexure 1's "In Stock" column, snapshotted here rather than read
          // live by the form. The column's whole point is what the requester
          // could see when they decided to buy — a live figure would answer a
          // different question, and would quietly rewrite the sheet every time
          // somebody reprinted it.
          inStockAtRequest: stockAtRequest.get(it.lineNo) ?? null,
          stockCheckedAt: stockAtRequest.has(it.lineNo) ? checkedAt : null,
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
  return withTransaction(db, async (tx) => {
    const pr = await tx.purchaseRequisition.findUnique({ where: { id: prId }, include: { items: true } });
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

    // The lines are replaced wholesale, so the stock snapshot has to be carried
    // across by line number. It records what the requester could see when the
    // requisition was raised; re-reading it on every edit would turn it into a
    // live figure, which is a different fact and a misleading one on a form
    // somebody signed.
    const priorStock = new Map<number, { qty: number | null; at: Date | null }>();
    for (const row of await tx.purchaseRequisitionItem.findMany({
      where: { prId },
      select: { lineNo: true, inStockAtRequest: true, stockCheckedAt: true },
    })) {
      priorStock.set(row.lineNo, { qty: row.inStockAtRequest, at: row.stockCheckedAt });
    }

    await tx.purchaseRequisitionItem.deleteMany({ where: { prId } });
    const updated = await tx.purchaseRequisition.update({
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
        requiredLocation: input.requiredLocation ?? null,
        documentComments: input.documentComments ?? null,
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
            itemCode: it.itemCode ?? null,
            inStockAtRequest: priorStock.get(it.lineNo)?.qty ?? null,
            stockCheckedAt: priorStock.get(it.lineNo)?.at ?? null,
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
      tx,
    );

    return updated;
  });
}

/**
 * Central transition guard. Rejects any move that is not in the allowed map and
 * records the change with its reason.
 */
/**
 * Refuses anything in the Purchase Order module against a requisition that has
 * not finished its own module first.
 *
 * Every sourcing and order operation goes through here rather than listing the
 * acceptable statuses itself, so the boundary cannot drift: one place decides
 * when the requisition is done, and one message explains why it is not.
 */
export async function assertRequisitionComplete(
  prId: string,
  what: string,
  db: DbClient = prisma,
) {
  const pr = await db.purchaseRequisition.findUnique({
    where: { id: prId },
    select: { id: true, number: true, status: true, approvedAt: true },
  });
  if (!pr) throw new NotFoundError("Requisition");

  if (["REJECTED", "CANCELLED"].includes(pr.status)) {
    throw new RuleViolationError(`${pr.number} was ${pr.status.toLowerCase()}; ${what} cannot proceed against it.`);
  }
  if (pr.status === "ON_HOLD") {
    throw new RuleViolationError(`${pr.number} is on hold; ${what} cannot proceed until the hold is lifted.`);
  }
  if (!requisitionComplete(pr.status)) {
    throw new RuleViolationError(
      `${what} belongs to the purchase order module, which begins once the requisition is approved. ${pr.number} is currently ${pr.status.replace(/_/g, " ").toLowerCase()}.`,
    );
  }
  return pr;
}

export async function transitionPr(
  actor: Actor,
  prId: string,
  to: PrStatus,
  opts: {
    reason?: string | null;
    force?: boolean;
    extraData?: Record<string, unknown>;
    /**
     * Set when this move is a consequence of an operation in another module
     * that the actor was already authorized for — posting a GRN, verifying an
     * invoice, a committee decision. The originating permission named here is
     * re-verified against the actor, so a caller cannot assert an authority the
     * actor does not hold.
     */
    authority?: Authority;
  } = {},
  db: DbClient = prisma,
) {
  const pr = await db.purchaseRequisition.findUnique({ where: { id: prId } });
  if (!pr) throw new NotFoundError("Requisition");
  const from = pr.status as PrStatus;
  if (from === to) return pr;

  // Who may make this move. Previously absent: the state machine was validated
  // and the mover was not, so anyone who reached this function could advance a
  // requisition. Entity scope is checked too — a requisition in an entity the
  // actor cannot see is not theirs to move.
  const authority: Authority = opts.authority ?? { permission: PR_TRANSITION_AUTHORITY[to] ?? [] };
  assertAuthority(actor, DOMAIN_ACTIONS.PR_TRANSITION, authority, { ownerId: pr.requesterId });
  assertEntityAccess(actor, pr.entityId);

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
      actor,
    },
    db,
  );

  // Approval is where one module ends and the next begins. Recording the handover
  // separately from the status change is what lets somebody ask "when did this
  // stop being the department's problem and become procurement's" and get an
  // answer — and it is what puts the case on procurement's queue rather than
  // leaving it to be noticed.
  if (to === PR_MODULE_BOUNDARY && inRequisitionStage(from)) {
    await writeAudit(
      {
        entityType: "PurchaseRequisition",
        entityId: prId,
        entityRef: pr.number,
        action: "REQUISITION_COMPLETED",
        newValue: { handedTo: "PURCHASE_ORDER_MODULE", estimatedValue: pr.estimatedValue },
        reason: "The requisition is approved. Sourcing and the purchase order begin here.",
        caseKey: pr.number,
        actor,
      },
      db,
    );
    await createTask(
      {
        title: `Start sourcing — ${pr.number}`,
        description:
          "The requisition is approved and belongs to the purchase order module now: raise the RFQ, collect quotations and prepare the comparative.",
        taskType: "ACTION",
        assignedRoleCode: "PROCUREMENT_OFFICER",
        entityId: pr.entityId,
        documentType: "PR",
        documentId: pr.id,
        documentRef: pr.number,
        slaHours: await getConfigNumber(CONFIG_KEYS.SLA_PROCUREMENT_REVIEW_HOURS, pr.entityId, db),
        linkUrl: `/pr/${pr.id}?tab=rfq`,
      },
      db,
    );
  }

  return updated;
}

/**
 * The first person in an escalation chain who actually holds `pr.approve`.
 *
 * Walks outward from the requester, so the nearest qualified manager is chosen
 * rather than the most senior. Returns null when nobody in the chain qualifies,
 * which the caller must treat as "no approver", not as permission to proceed.
 */
async function firstApprover(
  chain: Array<{ id: string; name: string }>,
  db: DbClient = prisma,
): Promise<{ id: string; name: string } | null> {
  if (!chain.length) return null;
  const holders = await db.user.findMany({
    where: {
      id: { in: chain.map((c) => c.id) },
      active: true,
      roles: { some: { role: { permissions: { some: { permission: { code: P.PR_APPROVE } } } } } },
    },
    select: { id: true, name: true },
  });
  const byId = new Map(holders.map((h) => [h.id, h]));
  for (const link of chain) {
    const hit = byId.get(link.id);
    if (hit) return hit;
  }
  return null;
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

  await transitionPr(
    user,
    prId,
    "SUBMITTED",
    { authority: { ownRecord: "Submitting a requisition", orPermission: [P.PR_SUBMIT] } },
    db,
  );

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
    // PC-027. The approval engine matched no approver, or departmental approval
    // is switched off for this entity. Neither SOP says what happens here: both
    // describe departmental approval as a step somebody performs, and no
    // passage authorises proceeding without one. So the behaviour is policy.
    const behaviour = String(
      await getConfig<string>(CONFIG_KEYS.POLICY_NO_APPROVER_BEHAVIOUR, pr.entityId, db),
    );

    if (behaviour === "NOAPPR-REFUSE") {
      throw new RuleViolationError(
        `No approver is configured for a ${pr.procurementType.replace(/_/g, " ").toLowerCase()} requisition of PKR ${estimatedValue.toLocaleString("en-PK")} in ${pr.department.name}. ` +
          "Add an approval rule that covers this entity, department, category and amount before submitting.",
      );
    }

    if (behaviour === "NOAPPR-ESCALATE") {
      // Walk the reporting lines loaded from the organograms until somebody who
      // can actually approve is found. That turns a silent auto-approval into a
      // real approval by a real person, using data the system already holds.
      const chain = await escalationChain(pr.requesterId, db);
      const approver = await firstApprover(chain, db);

      if (approver) {
        await transitionPr(
          user,
          prId,
          "UNDER_DEPARTMENT_APPROVAL",
          {
            force: true,
            authority: { cascade: "requisition submitted", from: [P.PR_SUBMIT, P.PR_CREATE] },
          },
          db,
        );
        await createTask(
          {
            title: `Approve ${pr.number} — escalated, no approval rule matched`,
            description:
              `No approval rule covered this requisition, so it was escalated to you as the first person above ` +
              `${pr.requesterId === approver.id ? "the requester" : "the requester in the reporting line"} who can approve it.`,
            taskType: "APPROVAL",
            assigneeId: approver.id,
            entityId: pr.entityId,
            documentType: "PR",
            documentId: pr.id,
            documentRef: pr.number,
            priority: "HIGH",
            slaHours: await getConfigNumber(CONFIG_KEYS.SLA_PROCUREMENT_REVIEW_HOURS, pr.entityId, db),
            linkUrl: `/pr/${pr.id}`,
          },
          db,
        );
        await notify(
          {
            userIds: [approver.id],
            entityId: pr.entityId,
            type: "APPROVAL_REQUIRED",
            title: `${pr.number} escalated to you for approval`,
            body: `${pr.title} · PKR ${estimatedValue.toLocaleString("en-PK")}. No approval rule matched, so it came up the reporting line.`,
            priority: "HIGH",
            linkType: "PR",
            linkId: pr.id,
            linkUrl: `/pr/${pr.id}`,
          },
          db,
        );
        await writeAudit(
          {
            entityType: "PurchaseRequisition",
            entityId: pr.id,
            entityRef: pr.number,
            action: "PR_APPROVAL_ESCALATED",
            newValue: { escalatedTo: approver.name, chain: chain.map((c) => c.name) },
            reason:
              "No approval rule matched this requisition. Escalated up the organogram rather than approved without an approver.",
            caseKey: pr.number,
            actor: user,
          },
          db,
        );
        return { approval, estimatedValue, escalatedTo: approver.name };
      }

      // The chain ran out. Refusing is the honest end state: there is nobody to
      // approve, and approving it anyway is the behaviour this policy replaced.
      throw new RuleViolationError(
        `No approval rule covered this requisition and no one above ${pr.department.name} in the reporting line holds approval authority. ` +
          "Add an approval rule, or set a reporting line for the requester, before submitting.",
      );
    }

    // NOAPPR-AUTO-APPROVE — the original behaviour, kept because it is what
    // some entities run on today. The requisition advances on the engine's
    // decision rather than on the submitter's authority, and the grounds are
    // named so the audit trail says so: searching for this phrase lists every
    // requisition that was approved by nobody.
    const engineDecision: Authority = {
      cascade: "approval engine: no applicable approver",
      from: [P.PR_SUBMIT, P.PR_CREATE, P.PR_APPROVE],
    };
    await transitionPr(user, prId, "UNDER_DEPARTMENT_APPROVAL", { force: true, authority: engineDecision }, db);
    await transitionPr(user, prId, "APPROVED", { authority: engineDecision }, db);
    await transitionPr(user, prId, "PROCUREMENT_REVIEW", { authority: engineDecision }, db);
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
    await transitionPr(
      user,
      prId,
      "UNDER_DEPARTMENT_APPROVAL",
      { authority: { cascade: "requisition submitted", from: [P.PR_SUBMIT, P.PR_CREATE] } },
      db,
    );
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
  if (decision === "APPROVED") {
    await assertSeparation(
      user,
      SOD_RULES.PR_RAISE_APPROVE,
      pr.requesterId,
      { entityId: pr.entityId, documentType: "PurchaseRequisition", documentId: pr.id, documentRef: pr.number },
      db,
    );
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

  // Annexure 1's signature block, recorded rather than implied.
  //
  // The form ends with the head of department's sign, stamp, date and time, and
  // the SOP says of those last three that they are "compulsory to ensure
  // compliance". A status change and a timestamp are not that: they say the
  // requisition moved, not who put their name to it in what office. The
  // attestation carries the designation held at the moment of signing, because
  // offices change and the record must not.
  await attest(
    user,
    {
      documentType: "PR",
      documentId: pr.id,
      documentRef: pr.number,
      attestationType: decision === "APPROVED" ? "APPROVED" : "REVIEWED",
      decision:
        decision === "APPROVED" ? "APPROVED" : decision === "REJECTED" ? "REJECTED" : "NOTED",
      comment,
      // What was signed, hashed — so a later change to the lines is detectable
      // rather than merely unlikely.
      signedContent: {
        number: pr.number,
        estimatedValue: pr.estimatedValue,
        lines: pr.items.map((i) => ({
          lineNo: i.lineNo,
          description: i.description,
          quantity: i.quantity,
          unit: i.unit,
          estimatedTotal: i.estimatedTotal,
        })),
      },
    },
    db,
  );

  if (decision === "APPROVED") {
    // Annexure 1 "Approved By" — the column that recorded when, and never who.
    await db.purchaseRequisition.update({
      where: { id: pr.id },
      data: { approvedById: user.id },
    });
  }


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
  return transitionPr(
    user,
    prId,
    to,
    {
      reason,
      force: true,
      extraData: { holdReason: null },
      authority: { cascade: "releasing a requisition from hold", from: [P.PR_HOLD] },
    },
    db,
  );
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
