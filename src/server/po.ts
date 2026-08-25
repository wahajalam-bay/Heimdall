import { prisma, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { CONFIG_KEYS, getConfigBool, getConfigNumber } from "@/lib/config";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { writeAudit, diffFields } from "@/lib/audit";
import { notify, createTask, completeTasks, cancelTasks } from "@/lib/notify";
import { raiseException } from "@/lib/exceptions-service";
import { startApproval, actOnApproval, getPendingApproval, type ApprovalDecision } from "@/lib/approvals";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { PO_LIFECYCLE, type PoStatus } from "@/lib/domain";
import { round2 } from "@/lib/format";
import { transitionPr } from "./pr";
import { checkVendorEligibility, effectiveQuoteTotal } from "./sourcing";
import { allocate } from "./allocations";
import { cpcRequirement } from "./cpc";

/**
 * Purchase orders.
 *
 * A PO can only be raised from a case whose governance is complete: the PR is
 * approved, a vendor is recommended, and CPC has cleared the case when the
 * configured threshold requires it.
 */

const PO_TRANSITIONS: Record<PoStatus, PoStatus[]> = {
  DRAFT: ["PENDING_APPROVAL", "APPROVED", "CANCELLED"],
  PENDING_APPROVAL: ["APPROVED", "DRAFT", "CANCELLED"],
  APPROVED: ["ISSUED", "CANCELLED", "ON_HOLD"],
  ISSUED: ["PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CLOSED", "CANCELLED", "ON_HOLD"],
  PARTIALLY_RECEIVED: ["PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CLOSED", "ON_HOLD"],
  FULLY_RECEIVED: ["CLOSED", "ON_HOLD"],
  CLOSED: [],
  CANCELLED: [],
  ON_HOLD: ["ISSUED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "APPROVED", "CANCELLED", "CLOSED"],
};

export type PoReadiness = { ready: boolean; issues: string[]; cpcRequired: boolean; cpcCleared: boolean };

export async function poReadiness(prId: string, db: DbClient = prisma): Promise<PoReadiness> {
  const pr = await db.purchaseRequisition.findUnique({
    where: { id: prId },
    include: {
      comparatives: {
        where: { status: { in: ["RECOMMENDED", "APPROVED"] } },
        orderBy: { preparedAt: "desc" },
        include: { lines: { where: { isSelected: true } } },
      },
      cpcCases: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!pr) throw new NotFoundError("Requisition");

  const issues: string[] = [];
  if (!["SOURCING", "CPC_REVIEW", "PO_PREPARATION", "APPROVED", "PROCUREMENT_REVIEW"].includes(pr.status)) {
    issues.push(`Requisition ${pr.number} is ${pr.status} and cannot generate a purchase order.`);
  }
  const comparative = pr.comparatives[0];
  const selected = comparative?.lines[0];
  if (!comparative || !selected) {
    issues.push("No recommended vendor — complete the comparative analysis and record a recommendation.");
  }

  const amount = selected?.netTotal ?? pr.estimatedValue;
  const cpc = await cpcRequirement(pr.entityId, amount, pr.procurementType, db);
  const cpcCase = pr.cpcCases.find((c) => c.status === "APPROVED");
  const cpcCleared = !cpc.required || Boolean(cpcCase);
  if (cpc.required && !cpcCase) {
    const pendingCase = pr.cpcCases.find((c) =>
      ["PENDING", "SCHEDULED", "UNDER_REVIEW", "CLARIFICATION", "DEFERRED"].includes(c.status),
    );
    issues.push(
      pendingCase
        ? `CPC case ${pendingCase.number} is ${pendingCase.status.toLowerCase()} — a purchase order cannot be raised until the committee approves.`
        : `${cpc.reason} A CPC case must be raised and approved before a purchase order.`,
    );
  }

  return { ready: issues.length === 0, issues, cpcRequired: cpc.required, cpcCleared };
}

export type PoInput = {
  prId: string;
  deliveryStoreId?: string | null;
  deliveryAddress?: string | null;
  deliveryDate?: Date | null;
  paymentTerms?: string | null;
  creditDays?: number | null;
  warrantyTerms?: string | null;
  termsConditions?: string | null;
  incoterms?: string | null;
  advanceRequired?: boolean;
  advancePercent?: number | null;
  collateralType?: string | null;
  collateralRef?: string | null;
  collateralNotes?: string | null;
  /** Line-level override of quantity actually ordered. */
  quantities?: Record<string, number>;
};

/** Creates a draft PO from the approved procurement case. */
export async function createPoFromCase(user: SessionUser, input: PoInput, db: DbClient = prisma) {
  if (!userHasPermission(user, P.PO_CREATE)) {
    throw new ForbiddenError("You do not have permission to create purchase orders.");
  }
  const readiness = await poReadiness(input.prId, db);
  if (!readiness.ready) {
    throw new RuleViolationError("This case is not ready for a purchase order.", readiness.issues);
  }

  const pr = await db.purchaseRequisition.findUnique({
    where: { id: input.prId },
    include: {
      items: { include: { category: true } },
      comparatives: {
        where: { status: { in: ["RECOMMENDED", "APPROVED"] } },
        orderBy: { preparedAt: "desc" },
        include: { lines: { where: { isSelected: true }, include: { vendor: true, quote: { include: { items: true } } } }, rfq: true },
      },
      deliveryStore: true,
    },
  });
  if (!pr) throw new NotFoundError("Requisition");
  const comparative = pr.comparatives[0];
  const selected = comparative.lines[0];
  const quote = selected.quote;
  const vendor = selected.vendor;

  const eligibility = await checkVendorEligibility(vendor.id, pr.entityId, db);
  if (!eligibility.eligible) {
    throw new RuleViolationError(eligibility.reason ?? "The awarded vendor is not eligible.");
  }

  // Apply the negotiated outcome proportionally so the PO reflects the final price.
  const negotiated = await effectiveQuoteTotal(quote.id, db);
  const factor = quote.total > 0 ? negotiated / quote.total : 1;

  const inspectionCategories = await (await import("@/lib/config")).getConfigArray<string>(
    CONFIG_KEYS.REQUIRE_INSPECTION_CATEGORIES,
    pr.entityId,
    db,
  );

  const lines = quote.items.map((qi, idx) => {
    const prItem = pr.items.find((p) => p.id === qi.prItemId) ?? pr.items[idx] ?? pr.items[0];
    const qty = input.quantities?.[qi.id] ?? qi.quantity;
    const unitPrice = round2(qi.unitPrice * factor);
    const net = round2(unitPrice * qty);
    const taxAmount = round2(net * (qi.taxRate / 100));
    const category = prItem?.category;
    const requiresInspection =
      Boolean(category?.requiresInspection) ||
      (category ? inspectionCategories.includes(category.code) : false);
    return {
      lineNo: idx + 1,
      itemId: qi.itemId ?? prItem?.itemId ?? null,
      prItemId: prItem?.id ?? null,
      description: qi.description,
      brand: qi.brand ?? prItem?.brand ?? null,
      model: qi.model ?? prItem?.model ?? null,
      specification: qi.specification ?? prItem?.specification ?? null,
      quantity: qty,
      unit: qi.unit,
      unitPrice,
      taxRate: qi.taxRate,
      taxAmount,
      lineTotal: round2(net + taxAmount),
      disposition: prItem?.disposition ?? category?.defaultDisposition ?? "INVENTORY",
      requiresInspection,
      net,
    };
  });

  const subtotal = round2(lines.reduce((a, l) => a + l.net, 0));
  const taxAmount = round2(lines.reduce((a, l) => a + l.taxAmount, 0));
  const deliveryCharges = round2(quote.deliveryCharges * factor);
  const otherCharges = round2(quote.otherCharges * factor);
  const discount = round2(quote.discount * factor);
  const total = round2(subtotal + taxAmount + deliveryCharges + otherCharges - discount);

  // Advance payment governance.
  let advanceAmount: number | null = null;
  if (input.advanceRequired) {
    const allowed = await getConfigBool(CONFIG_KEYS.ADVANCE_PAYMENT_ALLOWED, pr.entityId, db);
    if (!allowed) throw new RuleViolationError("Advance payments are not permitted for this entity.");
    const maxPct = await getConfigNumber(CONFIG_KEYS.ADVANCE_MAX_PERCENT, pr.entityId, db);
    const pct = input.advancePercent ?? maxPct;
    if (pct > maxPct) {
      throw new RuleViolationError(`Advance of ${pct}% exceeds the maximum permitted ${maxPct}%.`);
    }
    const needsCollateral = await getConfigBool(CONFIG_KEYS.ADVANCE_REQUIRES_COLLATERAL, pr.entityId, db);
    if (needsCollateral && (!input.collateralType || input.collateralType === "NONE" || !input.collateralRef?.trim())) {
      throw new RuleViolationError(
        "An advance payment requires collateral — record the security cheque or bank guarantee reference.",
      );
    }
    advanceAmount = round2((total * pct) / 100);
  }

  const number = await nextNumber(SEQ.PO, db);
  const po = await db.purchaseOrder.create({
    data: {
      number,
      entityId: pr.entityId,
      prId: pr.id,
      rfqId: comparative.rfqId,
      quoteId: quote.id,
      vendorId: vendor.id,
      vendorAddress: vendor.address,
      vendorContact: [vendor.contactPerson, vendor.contactPhone, vendor.contactEmail].filter(Boolean).join(" · ") || null,
      deliveryStoreId: input.deliveryStoreId ?? pr.deliveryStoreId,
      deliveryAddress: input.deliveryAddress ?? pr.deliveryStore?.address ?? pr.deliveryLocationNote,
      deliveryDate:
        input.deliveryDate ??
        (quote.deliveryDays ? new Date(Date.now() + quote.deliveryDays * 86400000) : pr.requiredDate),
      paymentTerms: input.paymentTerms ?? quote.paymentTerms ?? vendor.paymentTerms,
      creditDays: input.creditDays ?? quote.creditDays ?? vendor.creditDays,
      warrantyTerms: input.warrantyTerms ?? quote.warrantyTerms,
      termsConditions: input.termsConditions ?? null,
      incoterms: input.incoterms ?? null,
      subtotal,
      taxAmount,
      deliveryCharges,
      otherCharges,
      discount,
      total,
      advanceRequired: Boolean(input.advanceRequired),
      advanceAmount,
      advancePercent: input.advancePercent ?? null,
      advanceStatus: input.advanceRequired ? "PENDING" : null,
      collateralType: input.collateralType ?? null,
      collateralRef: input.collateralRef ?? null,
      collateralNotes: input.collateralNotes ?? null,
      status: "DRAFT",
      createdById: user.id,
      items: {
        create: lines.map((l) => ({
          lineNo: l.lineNo,
          itemId: l.itemId,
          prItemId: l.prItemId,
          description: l.description,
          brand: l.brand,
          model: l.model,
          specification: l.specification,
          quantity: l.quantity,
          unit: l.unit,
          unitPrice: l.unitPrice,
          taxRate: l.taxRate,
          taxAmount: l.taxAmount,
          lineTotal: l.lineTotal,
          disposition: l.disposition,
          requiresInspection: l.requiresInspection,
        })),
      },
    },
  });

  // What this order took from each requisition line. One line can be split
  // across several orders, so the placed quantity is recorded rather than
  // inferred from the order's own header.
  const created = await db.purchaseOrder.findUniqueOrThrow({
    where: { id: po.id },
    select: { items: { select: { id: true, prItemId: true, quantity: true, unit: true } } },
  });
  await allocate(
    created.items
      .filter((i) => i.prItemId)
      .map((i) => ({
        prId: pr.id,
        prItemId: i.prItemId as string,
        poId: po.id,
        poItemId: i.id,
        quantity: i.quantity,
        unit: i.unit,
      })),
    user.id,
    db,
  );

  if (pr.status !== "PO_PREPARATION") {
    await transitionPr(user, pr.id, "PO_PREPARATION", { force: true }, db);
  }
  await db.vendorQuote.update({ where: { id: quote.id }, data: { status: "SELECTED" } });
  await db.rfq.update({ where: { id: comparative.rfqId }, data: { status: "AWARDED" } });

  await writeAudit(
    {
      entityType: "PurchaseOrder",
      entityId: po.id,
      entityRef: po.number,
      action: "PO_CREATED",
      newValue: {
        pr: pr.number,
        vendor: vendor.name,
        total,
        lines: lines.length,
        negotiatedFactor: round2(factor),
        advanceAmount,
      },
      caseKey: pr.number,
      actor: user,
    },
    db,
  );

  return po;
}

async function transitionPo(
  user: SessionUser | null,
  poId: string,
  to: PoStatus,
  opts: { reason?: string | null; force?: boolean; extra?: Record<string, unknown> } = {},
  db: DbClient = prisma,
) {
  const po = await db.purchaseOrder.findUnique({ where: { id: poId }, include: { pr: true } });
  if (!po) throw new NotFoundError("Purchase order");
  const from = po.status as PoStatus;
  if (from === to && to !== "PARTIALLY_RECEIVED") return po;

  if (!opts.force) {
    const allowed = PO_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new RuleViolationError(
        `Cannot move purchase order ${po.number} from ${from} to ${to}. Permitted: ${allowed.join(", ") || "none"}.`,
      );
    }
  }

  const data: Record<string, unknown> = { status: to, ...(opts.extra ?? {}) };
  if (to === "APPROVED") data.approvedAt = new Date();
  if (to === "ISSUED") data.issuedAt = new Date();
  if (to === "CLOSED") data.closedAt = new Date();
  if (to === "CANCELLED") data.cancelledAt = new Date();

  const updated = await db.purchaseOrder.update({ where: { id: poId }, data });
  await writeAudit(
    {
      entityType: "PurchaseOrder",
      entityId: poId,
      entityRef: po.number,
      action: `PO_STATUS_${to}`,
      changes: { status: { from, to } },
      reason: opts.reason ?? null,
      caseKey: po.pr?.number ?? null,
      actor: user,
    },
    db,
  );
  return updated;
}

export async function submitPoForApproval(user: SessionUser, poId: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.PO_CREATE, P.PO_EDIT)) {
    throw new ForbiddenError("You do not have permission to submit purchase orders.");
  }
  const po = await db.purchaseOrder.findUnique({
    where: { id: poId },
    include: { items: true, pr: { include: { items: true } }, vendor: true },
  });
  if (!po) throw new NotFoundError("Purchase order");
  if (po.status !== "DRAFT") {
    throw new RuleViolationError(`Purchase order ${po.number} is already ${po.status}.`);
  }
  if (!po.items.length) throw new RuleViolationError("A purchase order needs at least one line.");
  if (!po.deliveryStoreId && !po.deliveryAddress?.trim()) {
    throw new RuleViolationError("Record a delivery location before submitting the purchase order.");
  }

  const primaryCategoryId = po.pr?.items[0]?.categoryId ?? null;
  const approval = await startApproval(
    {
      documentType: "PO",
      documentId: po.id,
      documentRef: po.number,
      entityId: po.entityId,
      departmentId: po.pr?.departmentId ?? null,
      categoryId: primaryCategoryId,
      procurementType: po.pr?.procurementType ?? null,
      amount: po.total,
      caseKey: po.pr?.number ?? null,
      linkUrl: `/po/${po.id}`,
      actor: user,
    },
    db,
  );

  if (approval.autoApproved) {
    await transitionPo(user, poId, "APPROVED", { reason: "No approval rule matched — auto-approved" }, db);
    if (po.prId) await transitionPr(user, po.prId, "PO_APPROVED", { force: true }, db);
  } else {
    await transitionPo(user, poId, "PENDING_APPROVAL", {}, db);
  }
  return approval;
}

export async function decidePo(
  user: SessionUser,
  poId: string,
  decision: ApprovalDecision,
  comment: string | null,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.PO_APPROVE)) {
    throw new ForbiddenError("You do not have permission to approve purchase orders.");
  }
  const po = await db.purchaseOrder.findUnique({ where: { id: poId }, include: { pr: true, vendor: true } });
  if (!po) throw new NotFoundError("Purchase order");

  const instance = await getPendingApproval("PO", poId, db);
  if (!instance) throw new RuleViolationError(`Purchase order ${po.number} has no approval pending.`);

  const result = await actOnApproval(
    {
      instanceId: instance.id,
      decision,
      comment,
      actor: user,
      caseKey: po.pr?.number ?? null,
      linkUrl: `/po/${po.id}`,
    },
    db,
  );

  if (decision === "REJECTED") {
    await transitionPo(user, poId, "CANCELLED", { reason: comment }, db);
    if (po.prId) await transitionPr(user, po.prId, "SOURCING", { reason: comment, force: true }, db);
  } else if (decision === "RETURNED" || decision === "CLARIFICATION_REQUESTED") {
    await transitionPo(user, poId, "DRAFT", { reason: comment }, db);
    await createTask(
      {
        title: `Revise purchase order ${po.number}`,
        description: comment ?? undefined,
        taskType: "ACTION",
        assigneeId: po.createdById,
        entityId: po.entityId,
        documentType: "PO",
        documentId: po.id,
        documentRef: po.number,
        priority: "HIGH",
        slaHours: 24,
        linkUrl: `/po/${po.id}`,
      },
      db,
    );
  } else if (result.completed) {
    await transitionPo(user, poId, "APPROVED", { reason: comment }, db);
    if (po.prId) await transitionPr(user, po.prId, "PO_APPROVED", { force: true }, db);
    await createTask(
      {
        title: `Issue purchase order ${po.number} to ${po.vendor.name}`,
        taskType: "ACTION",
        assignedRoleCode: "PROCUREMENT_OFFICER",
        entityId: po.entityId,
        documentType: "PO",
        documentId: po.id,
        documentRef: po.number,
        slaHours: 24,
        linkUrl: `/po/${po.id}`,
      },
      db,
    );
    await notify(
      {
        roleCodes: ["PROCUREMENT_OFFICER", "BUYER"],
        entityId: po.entityId,
        type: "PO_APPROVAL",
        title: `${po.number} approved — ready to issue`,
        body: `${po.vendor.name} · PKR ${po.total.toLocaleString("en-PK")}`,
        linkType: "PO",
        linkId: po.id,
        linkUrl: `/po/${po.id}`,
      },
      db,
    );
  }

  return result;
}

export async function issuePo(user: SessionUser, poId: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.PO_ISSUE)) {
    throw new ForbiddenError("You do not have permission to issue purchase orders.");
  }
  const po = await db.purchaseOrder.findUnique({
    where: { id: poId },
    include: { vendor: true, pr: true, deliveryStore: true },
  });
  if (!po) throw new NotFoundError("Purchase order");
  if (po.status !== "APPROVED") {
    throw new RuleViolationError(
      `Purchase order ${po.number} must be approved before it is issued (current: ${po.status}).`,
    );
  }
  if (po.advanceRequired && po.advanceStatus === "PENDING") {
    const needsCollateral = await getConfigBool(CONFIG_KEYS.ADVANCE_REQUIRES_COLLATERAL, po.entityId, db);
    if (needsCollateral && !po.collateralRef?.trim()) {
      throw new RuleViolationError(
        "This purchase order carries an advance payment but no collateral reference has been recorded.",
      );
    }
  }

  const updated = await transitionPo(user, poId, "ISSUED", {}, db);
  await completeTasks("PO", poId, user.id, db);
  if (po.prId) await transitionPr(user, po.prId, "PO_ISSUED", { force: true }, db);

  await createTask(
    {
      title: `Await delivery for ${po.number}`,
      description: `${po.vendor.name} → ${po.deliveryStore?.name ?? po.deliveryAddress ?? "delivery location"}`,
      taskType: "RECEIVING",
      assignedRoleCode: po.deliveryStore?.kind === "SITE_STORE" ? "SITE_STORE_USER" : "STORE_RECEIVER",
      entityId: po.entityId,
      documentType: "PO",
      documentId: po.id,
      documentRef: po.number,
      slaHours: po.deliveryDate
        ? Math.max(1, Math.round((po.deliveryDate.getTime() - Date.now()) / 3600000))
        : 168,
      linkUrl: `/po/${po.id}`,
    },
    db,
  );
  await notify(
    {
      roleCodes: ["STORE_RECEIVER", "STORE_MANAGER", "SITE_STORE_USER", "WAREHOUSE_MANAGER", "SECURITY"],
      entityId: po.entityId,
      type: "GENERAL",
      title: `${po.number} issued — delivery expected`,
      body: `${po.vendor.name} → ${po.deliveryStore?.name ?? "—"}${po.deliveryDate ? ` by ${po.deliveryDate.toISOString().slice(0, 10)}` : ""}`,
      linkType: "PO",
      linkId: po.id,
      linkUrl: `/po/${po.id}`,
    },
    db,
  );

  // Advance payment goes to finance as its own handoff task.
  if (po.advanceRequired && po.advanceAmount) {
    await createTask(
      {
        title: `Process advance payment for ${po.number}`,
        description: `PKR ${po.advanceAmount.toLocaleString("en-PK")} advance · collateral ${po.collateralType ?? "none"} ${po.collateralRef ?? ""}`.trim(),
        taskType: "VERIFICATION",
        assignedRoleCode: "FINANCE_USER",
        entityId: po.entityId,
        documentType: "PO",
        documentId: po.id,
        documentRef: po.number,
        priority: "HIGH",
        slaHours: 48,
        linkUrl: `/po/${po.id}`,
      },
      db,
    );
  }

  return updated;
}

/**
 * Recomputes received/pending quantities from posted GRNs and moves the PO (and
 * the PR) to the right state. Called after every GRN post or cancellation.
 */
export async function recomputePoFulfilment(poId: string, user: SessionUser | null, db: DbClient = prisma) {
  const po = await db.purchaseOrder.findUnique({
    where: { id: poId },
    include: { items: true, pr: true },
  });
  if (!po) throw new NotFoundError("Purchase order");

  const grnLines = await db.grnItem.findMany({
    where: { grn: { poId, status: "POSTED" } },
    select: { poItemId: true, receivedQty: true, acceptedQty: true, rejectedQty: true },
  });

  const byPoItem = new Map<string, { received: number; accepted: number; rejected: number }>();
  for (const l of grnLines) {
    const cur = byPoItem.get(l.poItemId) ?? { received: 0, accepted: 0, rejected: 0 };
    cur.received += l.receivedQty;
    cur.accepted += l.acceptedQty;
    cur.rejected += l.rejectedQty;
    byPoItem.set(l.poItemId, cur);
  }

  let allComplete = true;
  let anyReceived = false;
  for (const it of po.items) {
    const agg = byPoItem.get(it.id) ?? { received: 0, accepted: 0, rejected: 0 };
    await db.purchaseOrderItem.update({
      where: { id: it.id },
      data: {
        receivedQty: round2(agg.received),
        acceptedQty: round2(agg.accepted),
        rejectedQty: round2(agg.rejected),
      },
    });
    if (agg.accepted > 0 || agg.received > 0) anyReceived = true;
    if (round2(agg.accepted) + 1e-9 < it.quantity) allComplete = false;
  }

  let target: PoStatus | null = null;
  if (allComplete && po.items.length > 0) target = "FULLY_RECEIVED";
  else if (anyReceived) target = "PARTIALLY_RECEIVED";

  if (target && !["CLOSED", "CANCELLED"].includes(po.status)) {
    await transitionPo(user, poId, target, { force: true }, db);
    if (po.prId) {
      await transitionPr(
        user,
        po.prId,
        target === "FULLY_RECEIVED" ? "FULLY_RECEIVED" : "PARTIALLY_RECEIVED",
        { force: true },
        db,
      );
    }
  }

  return { allComplete, anyReceived };
}

/** Ordered / received / pending per line, for the PO detail and Open PO views. */
export async function poBalance(poId: string, db: DbClient = prisma) {
  const items = await db.purchaseOrderItem.findMany({ where: { poId }, orderBy: { lineNo: "asc" } });
  return items.map((i) => ({
    ...i,
    pendingQty: round2(Math.max(0, i.quantity - i.acceptedQty)),
    uninvoicedQty: round2(Math.max(0, i.acceptedQty - i.invoicedQty)),
    fullyReceived: i.acceptedQty + 1e-9 >= i.quantity,
  }));
}

/**
 * Closes a PO. A PO with pending quantity may only be short-closed with an
 * explicit written reason, which is recorded as an exception.
 */
export async function closePo(
  user: SessionUser,
  poId: string,
  reason: string | null,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.PO_CLOSE)) {
    throw new ForbiddenError("You do not have permission to close purchase orders.");
  }
  const po = await db.purchaseOrder.findUnique({
    where: { id: poId },
    include: { items: true, pr: true, invoices: true },
  });
  if (!po) throw new NotFoundError("Purchase order");
  if (po.status === "CLOSED") return po;
  if (po.status === "CANCELLED") throw new RuleViolationError("A cancelled purchase order cannot be closed.");

  const pending = po.items.filter((i) => i.acceptedQty + 1e-9 < i.quantity);
  if (pending.length && !reason?.trim()) {
    throw new RuleViolationError(
      `Purchase order ${po.number} still has pending quantity on ${pending.length} line(s). Short-closing requires a written reason.`,
      pending.map(
        (p) => `Line ${p.lineNo} ${p.description}: ordered ${p.quantity} ${p.unit}, accepted ${p.acceptedQty} ${p.unit}.`,
      ),
    );
  }

  const updated = await transitionPo(
    user,
    poId,
    "CLOSED",
    { reason, force: true, extra: { closureReason: reason ?? null } },
    db,
  );
  await cancelTasks("PO", poId, db);

  if (pending.length) {
    await raiseException(
      {
        type: "QUANTITY_MISMATCH",
        severity: "MEDIUM",
        title: `${po.number} short-closed with pending quantity`,
        description: pending
          .map((p) => `Line ${p.lineNo}: ordered ${p.quantity} ${p.unit}, accepted ${p.acceptedQty} ${p.unit}`)
          .join(" · "),
        reason,
        documentType: "PO",
        documentId: po.id,
        documentRef: po.number,
        poId: po.id,
        caseKey: po.pr?.number ?? null,
        entityId: po.entityId,
        raisedById: user.id,
        ownerId: user.id,
      },
      db,
      user,
    );
  }

  // Close the PR when the whole case is settled.
  if (po.prId) {
    const otherOpen = await db.purchaseOrder.count({
      where: { prId: po.prId, id: { not: po.id }, status: { notIn: ["CLOSED", "CANCELLED"] } },
    });
    const unpaid = await db.invoice.count({
      where: { poId: po.id, status: { notIn: ["PAID", "SENT_TO_FINANCE", "REJECTED"] } },
    });
    if (otherOpen === 0 && unpaid === 0) {
      await transitionPr(user, po.prId, "CLOSED", { reason: reason ?? "All purchase orders closed", force: true }, db);
    }
  }

  return updated;
}

export async function cancelPo(user: SessionUser, poId: string, reason: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.PO_CANCEL)) {
    throw new ForbiddenError("You do not have permission to cancel purchase orders.");
  }
  if (!reason?.trim()) throw new ValidationError("A cancellation reason is required.");
  const po = await db.purchaseOrder.findUnique({
    where: { id: poId },
    include: { grns: { where: { status: "POSTED" } }, pr: true },
  });
  if (!po) throw new NotFoundError("Purchase order");
  if (po.grns.length) {
    throw new RuleViolationError(
      `Purchase order ${po.number} has ${po.grns.length} posted GRN(s) — goods have already entered inventory. Close it with a reason instead of cancelling.`,
    );
  }
  await db.approvalInstance.updateMany({
    where: { documentType: "PO", documentId: poId, status: "PENDING" },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
  await cancelTasks("PO", poId, db);
  return transitionPo(user, poId, "CANCELLED", { reason, force: true, extra: { closureReason: reason } }, db);
}

export async function holdPo(user: SessionUser, poId: string, reason: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.PO_EDIT, P.PO_APPROVE)) throw new ForbiddenError("Not permitted.");
  if (!reason?.trim()) throw new ValidationError("A reason is required.");
  return transitionPo(user, poId, "ON_HOLD", { reason, force: true }, db);
}

export async function updatePoTerms(
  user: SessionUser,
  poId: string,
  input: Partial<PoInput>,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.PO_EDIT)) throw new ForbiddenError("Not permitted.");
  const po = await db.purchaseOrder.findUnique({ where: { id: poId }, include: { pr: true } });
  if (!po) throw new NotFoundError("Purchase order");
  if (!["DRAFT", "PENDING_APPROVAL"].includes(po.status)) {
    throw new RuleViolationError(
      `Purchase order ${po.number} can only be edited while it is a draft or pending approval.`,
    );
  }
  const before = {
    deliveryStoreId: po.deliveryStoreId,
    deliveryDate: po.deliveryDate,
    paymentTerms: po.paymentTerms,
    creditDays: po.creditDays,
    warrantyTerms: po.warrantyTerms,
    termsConditions: po.termsConditions,
    incoterms: po.incoterms,
  };
  const updated = await db.purchaseOrder.update({
    where: { id: poId },
    data: {
      deliveryStoreId: input.deliveryStoreId ?? po.deliveryStoreId,
      deliveryAddress: input.deliveryAddress ?? po.deliveryAddress,
      deliveryDate: input.deliveryDate ?? po.deliveryDate,
      paymentTerms: input.paymentTerms ?? po.paymentTerms,
      creditDays: input.creditDays ?? po.creditDays,
      warrantyTerms: input.warrantyTerms ?? po.warrantyTerms,
      termsConditions: input.termsConditions ?? po.termsConditions,
      incoterms: input.incoterms ?? po.incoterms,
    },
  });
  await writeAudit(
    {
      entityType: "PurchaseOrder",
      entityId: poId,
      entityRef: po.number,
      action: "PO_UPDATED",
      changes: diffFields(before, {
        deliveryStoreId: updated.deliveryStoreId,
        deliveryDate: updated.deliveryDate,
        paymentTerms: updated.paymentTerms,
        creditDays: updated.creditDays,
        warrantyTerms: updated.warrantyTerms,
        termsConditions: updated.termsConditions,
        incoterms: updated.incoterms,
      }),
      caseKey: po.pr?.number ?? null,
      actor: user,
    },
    db,
  );
  return updated;
}

/** Rail steps for the PO lifecycle visualiser. */
export function poRailStatuses() {
  return PO_LIFECYCLE;
}

export async function setAdvanceStatus(
  user: SessionUser,
  poId: string,
  status: "PENDING" | "APPROVED" | "PAID" | "SETTLED",
  reference: string | null,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.PAYMENT_RECORD, P.INVOICE_APPROVE)) {
    throw new ForbiddenError("You do not have permission to update advance payment status.");
  }
  const po = await db.purchaseOrder.findUnique({ where: { id: poId }, include: { pr: true } });
  if (!po) throw new NotFoundError("Purchase order");
  if (!po.advanceRequired) throw new RuleViolationError("This purchase order does not carry an advance.");
  const updated = await db.purchaseOrder.update({
    where: { id: poId },
    data: { advanceStatus: status, collateralNotes: reference ?? po.collateralNotes },
  });
  await writeAudit(
    {
      entityType: "PurchaseOrder",
      entityId: poId,
      entityRef: po.number,
      action: `PO_ADVANCE_${status}`,
      newValue: { amount: po.advanceAmount, reference },
      caseKey: po.pr?.number ?? null,
      actor: user,
    },
    db,
  );
  return updated;
}
