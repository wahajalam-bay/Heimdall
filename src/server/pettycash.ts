import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify, createTask, completeTasks } from "@/lib/notify";
import { raiseException, autoResolveExceptions } from "@/lib/exceptions-service";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { STORE_ENTRY_DISPOSITIONS, type Disposition, type PettyCashStatus } from "@/lib/domain";
import { round2 } from "@/lib/format";
import { postMovement } from "./inventory";

/**
 * Petty cash procurement.
 *
 * The known operational gap this module closes: a petty cash purchase must not
 * be closeable while an item with an inventory-bearing disposition has no store
 * transaction. `assertStoreEntryComplete` is the gate, and it is checked again
 * at closure and at reconciliation.
 */

const PC_FLOW: Record<PettyCashStatus, PettyCashStatus[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["UNDER_EVALUATION", "REJECTED", "CANCELLED"],
  UNDER_EVALUATION: ["QUOTES_PENDING", "REJECTED", "CANCELLED"],
  QUOTES_PENDING: ["QUOTES_COMPARED", "REJECTED", "CANCELLED"],
  QUOTES_COMPARED: ["PENDING_APPROVAL", "QUOTES_PENDING", "REJECTED", "CANCELLED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "QUOTES_COMPARED", "CANCELLED"],
  APPROVED: ["PURCHASED", "CANCELLED"],
  PURCHASED: ["RECEIPT_UPLOADED", "CANCELLED"],
  RECEIPT_UPLOADED: ["VOUCHER_GENERATED"],
  VOUCHER_GENERATED: ["VOUCHER_APPROVED", "REJECTED"],
  VOUCHER_APPROVED: ["STORE_ENTRY_PENDING", "RECONCILED"],
  STORE_ENTRY_PENDING: ["STORE_ENTRY_DONE"],
  STORE_ENTRY_DONE: ["RECONCILED"],
  RECONCILED: ["CLOSED"],
  CLOSED: [],
  REJECTED: [],
  CANCELLED: [],
};

export type PettyCashItemInput = {
  itemId?: string | null;
  description: string;
  quantity: number;
  unit: string;
  estimatedUnitPrice?: number | null;
  disposition?: Disposition;
};

export type PettyCashInput = {
  entityId: string;
  departmentId: string;
  purpose: string;
  justification?: string | null;
  requiredDate?: Date | null;
  storeId?: string | null;
  items: PettyCashItemInput[];
};

/** Any item whose disposition requires a store transaction. */
export function requiresStoreEntry(items: Array<{ disposition: string }>) {
  return items.some((i) => STORE_ENTRY_DISPOSITIONS.includes(i.disposition as Disposition));
}

export async function createPettyCash(user: SessionUser, input: PettyCashInput, db: DbClient = prisma) {
  if (!userHasPermission(user, P.PETTY_CASH_CREATE)) {
    throw new ForbiddenError("You do not have permission to raise petty cash requests.");
  }
  if (!input.items.length) throw new ValidationError("Add at least one item.");
  if (!input.purpose.trim()) throw new ValidationError("State the purpose of this petty cash request.");

  const items = input.items.map((it, i) => ({
    ...it,
    lineNo: i + 1,
    lineTotal: round2((it.estimatedUnitPrice ?? 0) * it.quantity),
    disposition: it.disposition ?? "EXPENSE",
  }));
  const estimatedAmount = round2(items.reduce((a, i) => a + i.lineTotal, 0));

  const limit = await getConfigNumber(CONFIG_KEYS.PETTY_CASH_LIMIT, input.entityId, db);
  if (estimatedAmount > limit) {
    throw new RuleViolationError(
      `PKR ${estimatedAmount.toLocaleString("en-PK")} exceeds the petty cash limit of PKR ${limit.toLocaleString("en-PK")}. Raise a purchase requisition instead.`,
    );
  }

  const storeRequired = requiresStoreEntry(items);
  if (storeRequired && !input.storeId) {
    throw new ValidationError(
      "One or more items will enter inventory — select the receiving store so the stock entry can be completed.",
    );
  }

  const number = await nextNumber(SEQ.PETTY_CASH, db);
  const request = await db.pettyCashRequest.create({
    data: {
      number,
      entityId: input.entityId,
      departmentId: input.departmentId,
      requesterId: user.id,
      purpose: input.purpose.trim(),
      justification: input.justification ?? null,
      estimatedAmount,
      requiredDate: input.requiredDate ?? null,
      status: "DRAFT",
      disposition: items[0].disposition,
      storeRequired,
      storeId: input.storeId ?? null,
      items: {
        create: items.map((it) => ({
          lineNo: it.lineNo,
          itemId: it.itemId ?? null,
          description: it.description.trim(),
          quantity: it.quantity,
          unit: it.unit,
          estimatedUnitPrice: it.estimatedUnitPrice ?? null,
          lineTotal: it.lineTotal,
          disposition: it.disposition,
        })),
      },
    },
  });

  await writeAudit(
    {
      entityType: "PettyCashRequest",
      entityId: request.id,
      entityRef: request.number,
      action: "PETTY_CASH_CREATED",
      newValue: { purpose: request.purpose, estimatedAmount, storeRequired, lines: items.length },
      caseKey: request.number,
      actor: user,
    },
    db,
  );

  return request;
}

async function transitionPc(
  user: SessionUser | null,
  id: string,
  to: PettyCashStatus,
  opts: { reason?: string | null; force?: boolean; extra?: Record<string, unknown> } = {},
  db: DbClient = prisma,
) {
  const pc = await db.pettyCashRequest.findUnique({ where: { id } });
  if (!pc) throw new NotFoundError("Petty cash request");
  const from = pc.status as PettyCashStatus;
  if (from === to) return pc;
  if (!opts.force) {
    const allowed = PC_FLOW[from] ?? [];
    if (!allowed.includes(to)) {
      throw new RuleViolationError(
        `Cannot move petty cash request ${pc.number} from ${from} to ${to}. Permitted: ${allowed.join(", ") || "none"}.`,
      );
    }
  }
  const updated = await db.pettyCashRequest.update({
    where: { id },
    data: { status: to, ...(opts.extra ?? {}) },
  });
  await writeAudit(
    {
      entityType: "PettyCashRequest",
      entityId: id,
      entityRef: pc.number,
      action: `PETTY_CASH_${to}`,
      changes: { status: { from, to } },
      reason: opts.reason ?? null,
      caseKey: pc.number,
      actor: user,
    },
    db,
  );
  return updated;
}

export async function submitPettyCash(user: SessionUser, id: string, db: DbClient = prisma) {
  const pc = await db.pettyCashRequest.findUnique({ where: { id }, include: { items: true } });
  if (!pc) throw new NotFoundError("Petty cash request");
  if (pc.requesterId !== user.id && !userHasPermission(user, P.PETTY_CASH_EVALUATE)) {
    throw new ForbiddenError("Only the requester may submit this request.");
  }
  const limit = await getConfigNumber(CONFIG_KEYS.PETTY_CASH_LIMIT, pc.entityId, db);
  if (pc.estimatedAmount > limit) {
    throw new RuleViolationError(
      `PKR ${pc.estimatedAmount.toLocaleString("en-PK")} exceeds the petty cash limit of PKR ${limit.toLocaleString("en-PK")}.`,
    );
  }

  await transitionPc(user, id, "SUBMITTED", {}, db);
  await createTask(
    {
      title: `Evaluate petty cash request ${pc.number}`,
      description: pc.purpose,
      taskType: "REVIEW",
      assignedRoleCode: "PROCUREMENT_OFFICER",
      entityId: pc.entityId,
      documentType: "PETTY_CASH",
      documentId: pc.id,
      documentRef: pc.number,
      slaHours: 24,
      linkUrl: `/petty-cash/${pc.id}`,
    },
    db,
  );
  await notify(
    {
      roleCodes: ["PROCUREMENT_OFFICER", "ADMIN_FLOOR_MANAGER"],
      entityId: pc.entityId,
      type: "APPROVAL_REQUIRED",
      title: `Petty cash ${pc.number} submitted`,
      body: `${pc.purpose} · PKR ${pc.estimatedAmount.toLocaleString("en-PK")}`,
      linkType: "PETTY_CASH",
      linkId: pc.id,
      linkUrl: `/petty-cash/${pc.id}`,
    },
    db,
  );
  return transitionPc(user, id, "UNDER_EVALUATION", { force: true }, db);
}

export async function beginQuoteCollection(user: SessionUser, id: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.PETTY_CASH_EVALUATE)) throw new ForbiddenError("Not permitted.");
  return transitionPc(user, id, "QUOTES_PENDING", {}, db);
}

export async function addPettyCashQuote(
  user: SessionUser,
  input: {
    requestId: string;
    vendorName: string;
    vendorId?: string | null;
    channel?: string;
    contactRef?: string | null;
    amount: number;
    taxIncluded?: boolean;
    deliveryDays?: number | null;
    notes?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.PETTY_CASH_EVALUATE)) {
    throw new ForbiddenError("You do not have permission to record petty cash market quotes.");
  }
  const pc = await db.pettyCashRequest.findUnique({ where: { id: input.requestId } });
  if (!pc) throw new NotFoundError("Petty cash request");
  if (["CLOSED", "REJECTED", "CANCELLED", "RECONCILED"].includes(pc.status)) {
    throw new RuleViolationError(`Request ${pc.number} is ${pc.status} — quotes cannot be added.`);
  }
  if (input.amount <= 0) throw new ValidationError("Quoted amount must be greater than zero.");
  if (!input.vendorName.trim()) throw new ValidationError("Record the vendor or shop name.");

  const q = await db.pettyCashQuote.create({
    data: {
      requestId: input.requestId,
      vendorName: input.vendorName.trim(),
      vendorId: input.vendorId ?? null,
      channel: input.channel ?? "PHYSICAL",
      contactRef: input.contactRef ?? null,
      amount: input.amount,
      taxIncluded: Boolean(input.taxIncluded),
      deliveryDays: input.deliveryDays ?? null,
      notes: input.notes ?? null,
    },
  });
  if (pc.status === "UNDER_EVALUATION" || pc.status === "SUBMITTED") {
    await transitionPc(user, pc.id, "QUOTES_PENDING", { force: true }, db);
  }
  await writeAudit(
    {
      entityType: "PettyCashRequest",
      entityId: pc.id,
      entityRef: pc.number,
      action: "PETTY_CASH_QUOTE_RECORDED",
      newValue: { vendor: q.vendorName, amount: q.amount, channel: q.channel },
      caseKey: pc.number,
      actor: user,
    },
    db,
  );
  return q;
}

/** Selects the winning market quote after checking the minimum-quote rule. */
export async function selectPettyCashQuote(
  user: SessionUser,
  input: { requestId: string; quoteId: string; justification?: string | null },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.PETTY_CASH_EVALUATE)) throw new ForbiddenError("Not permitted.");
    const pc = await tx.pettyCashRequest.findUnique({
      where: { id: input.requestId },
      include: { quotes: true },
    });
    if (!pc) throw new NotFoundError("Petty cash request");

    const minQuotes = await getConfigNumber(CONFIG_KEYS.PETTY_CASH_MIN_QUOTES, pc.entityId, tx);
    if (pc.quotes.length < minQuotes) {
      throw new RuleViolationError(
        `Procurement policy requires at least ${minQuotes} written market quotation(s); only ${pc.quotes.length} recorded.`,
      );
    }
    const chosen = pc.quotes.find((q) => q.id === input.quoteId);
    if (!chosen) throw new ValidationError("The selected quote does not belong to this request.");

    const lowest = Math.min(...pc.quotes.map((q) => q.amount));
    if (chosen.amount > lowest + 0.01 && !input.justification?.trim()) {
      throw new RuleViolationError(
        `${chosen.vendorName} at PKR ${chosen.amount.toLocaleString("en-PK")} is not the lowest quote (PKR ${lowest.toLocaleString("en-PK")}). A justification is required.`,
      );
    }

    await tx.pettyCashQuote.updateMany({ where: { requestId: pc.id }, data: { isSelected: false } });
    await tx.pettyCashQuote.update({ where: { id: input.quoteId }, data: { isSelected: true } });

    await transitionPc(
      user,
      pc.id,
      "QUOTES_COMPARED",
      {
        force: true,
        extra: { selectedQuoteId: input.quoteId, approvedAmount: chosen.amount, evaluatedById: user.id },
      },
      tx,
    );

    await writeAudit(
      {
        entityType: "PettyCashRequest",
        entityId: pc.id,
        entityRef: pc.number,
        action: "PETTY_CASH_QUOTE_SELECTED",
        newValue: { vendor: chosen.vendorName, amount: chosen.amount, lowest, quotes: pc.quotes.length },
        reason: input.justification ?? null,
        caseKey: pc.number,
        actor: user,
      },
      tx,
    );

    await transitionPc(user, pc.id, "PENDING_APPROVAL", { force: true }, tx);
    await createTask(
      {
        title: `Approve cash purchase ${pc.number}`,
        description: `${chosen.vendorName} · PKR ${chosen.amount.toLocaleString("en-PK")}`,
        taskType: "APPROVAL",
        assignedRoleCode: "PROCUREMENT_SENIOR_MANAGER",
        entityId: pc.entityId,
        documentType: "PETTY_CASH",
        documentId: pc.id,
        documentRef: pc.number,
        priority: "NORMAL",
        slaHours: 24,
        linkUrl: `/petty-cash/${pc.id}`,
      },
      tx,
    );
    return chosen;
  });
}

export async function approvePettyCash(
  user: SessionUser,
  input: { requestId: string; approve: boolean; reason?: string | null; approvedAmount?: number | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.PETTY_CASH_APPROVE)) {
    throw new ForbiddenError("You do not have permission to approve cash purchases.");
  }
  const pc = await db.pettyCashRequest.findUnique({ where: { id: input.requestId }, include: { quotes: true } });
  if (!pc) throw new NotFoundError("Petty cash request");
  if (pc.status !== "PENDING_APPROVAL") {
    throw new RuleViolationError(`Request ${pc.number} is ${pc.status} — it is not awaiting approval.`);
  }
  if (!input.approve) {
    if (!input.reason?.trim()) throw new ValidationError("Record the reason for rejection.");
    await completeTasks("PETTY_CASH", pc.id, user.id, db);
    return transitionPc(user, pc.id, "REJECTED", { reason: input.reason }, db);
  }

  const amount = input.approvedAmount ?? pc.approvedAmount ?? pc.estimatedAmount;
  const limit = await getConfigNumber(CONFIG_KEYS.PETTY_CASH_LIMIT, pc.entityId, db);
  if (amount > limit) {
    throw new RuleViolationError(
      `Approved amount PKR ${amount.toLocaleString("en-PK")} exceeds the petty cash limit of PKR ${limit.toLocaleString("en-PK")}.`,
    );
  }

  await completeTasks("PETTY_CASH", pc.id, user.id, db);
  const updated = await transitionPc(
    user,
    pc.id,
    "APPROVED",
    {
      reason: input.reason,
      extra: { approvedAmount: amount, approvedById: user.id, approvedAt: new Date() },
    },
    db,
  );
  await createTask(
    {
      title: `Purchase and upload receipt — ${pc.number}`,
      taskType: "ACTION",
      assigneeId: pc.requesterId,
      entityId: pc.entityId,
      documentType: "PETTY_CASH",
      documentId: pc.id,
      documentRef: pc.number,
      slaHours: 72,
      linkUrl: `/petty-cash/${pc.id}`,
    },
    db,
  );
  await notify(
    {
      userIds: [pc.requesterId],
      type: "GENERAL",
      title: `Petty cash ${pc.number} approved`,
      body: `PKR ${amount.toLocaleString("en-PK")} approved for cash purchase.`,
      linkType: "PETTY_CASH",
      linkId: pc.id,
      linkUrl: `/petty-cash/${pc.id}`,
    },
    db,
  );
  return updated;
}

export async function recordPurchase(
  user: SessionUser,
  input: {
    requestId: string;
    actualAmount: number;
    purchasedFromVendor: string;
    receiptRef?: string | null;
    lineAmounts?: Record<string, number>;
  },
  db: DbClient = prisma,
) {
  const pc = await db.pettyCashRequest.findUnique({ where: { id: input.requestId }, include: { items: true } });
  if (!pc) throw new NotFoundError("Petty cash request");
  if (pc.requesterId !== user.id && !userHasPermission(user, P.PETTY_CASH_EVALUATE)) {
    throw new ForbiddenError("Only the requester or procurement may record the purchase.");
  }
  if (pc.status !== "APPROVED") {
    throw new RuleViolationError(`Request ${pc.number} must be approved before a purchase is recorded.`);
  }
  if (input.actualAmount <= 0) throw new ValidationError("Actual amount must be greater than zero.");
  const limit = await getConfigNumber(CONFIG_KEYS.PETTY_CASH_LIMIT, pc.entityId, db);
  if (input.actualAmount > limit) {
    throw new RuleViolationError(
      `Actual spend PKR ${input.actualAmount.toLocaleString("en-PK")} exceeds the petty cash limit of PKR ${limit.toLocaleString("en-PK")}.`,
    );
  }

  if (input.lineAmounts) {
    for (const it of pc.items) {
      const amt = input.lineAmounts[it.id];
      if (amt === undefined) continue;
      await db.pettyCashItem.update({
        where: { id: it.id },
        data: {
          actualUnitPrice: it.quantity > 0 ? round2(amt / it.quantity) : amt,
          lineTotal: round2(amt),
        },
      });
    }
  }

  await transitionPc(
    user,
    pc.id,
    "PURCHASED",
    {
      extra: {
        actualAmount: round2(input.actualAmount),
        purchasedAt: new Date(),
        purchasedFromVendor: input.purchasedFromVendor.trim(),
        receiptRef: input.receiptRef ?? null,
      },
    },
    db,
  );

  // A variance against the approved amount is worth flagging, not blocking.
  const approved = pc.approvedAmount ?? pc.estimatedAmount;
  if (approved > 0 && Math.abs(input.actualAmount - approved) / approved > 0.1) {
    await raiseException(
      {
        type: "PRICE_VARIANCE",
        severity: "LOW",
        title: `${pc.number}: actual spend differs from approval by more than 10%`,
        description: `Approved PKR ${approved.toLocaleString("en-PK")}, spent PKR ${input.actualAmount.toLocaleString("en-PK")}.`,
        documentType: "PETTY_CASH",
        documentId: pc.id,
        documentRef: pc.number,
        caseKey: pc.number,
        entityId: pc.entityId,
        raisedById: user.id,
      },
      db,
      user,
    );
  }

  return transitionPc(user, pc.id, "RECEIPT_UPLOADED", { force: true, extra: { receiptRef: input.receiptRef ?? null } }, db);
}

/** Generates the petty cash voucher and routes it to the signatory. */
export async function generateVoucher(user: SessionUser, requestId: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.PETTY_CASH_EVALUATE, P.PETTY_CASH_APPROVE)) {
    throw new ForbiddenError("Not permitted.");
  }
  const pc = await db.pettyCashRequest.findUnique({
    where: { id: requestId },
    include: { items: true, requester: true, vouchers: true },
  });
  if (!pc) throw new NotFoundError("Petty cash request");
  if (!["RECEIPT_UPLOADED", "PURCHASED"].includes(pc.status)) {
    throw new RuleViolationError(`Request ${pc.number} is ${pc.status} — a voucher cannot be generated yet.`);
  }
  const receipts = await db.document.count({
    where: { linkedType: "PETTY_CASH", linkedId: pc.id, archived: false, category: { in: ["Receipt", "Invoice"] } },
  });
  if (receipts === 0 && !pc.receiptRef?.trim()) {
    throw new RuleViolationError(
      "Upload the purchase receipt (or record its reference) before generating the voucher.",
    );
  }
  if (pc.vouchers.some((v) => v.status !== "REJECTED")) {
    throw new RuleViolationError(`A voucher already exists for ${pc.number}.`);
  }

  const number = await nextNumber(SEQ.VOUCHER, db);
  const voucher = await db.pettyCashVoucher.create({
    data: {
      number,
      requestId: pc.id,
      amount: pc.actualAmount ?? pc.approvedAmount ?? pc.estimatedAmount,
      status: "PENDING_SIGNATORY",
      payeeName: pc.requester.name,
      receiptRef: pc.receiptRef,
      preparedById: user.id,
    },
  });

  await transitionPc(user, pc.id, "VOUCHER_GENERATED", { force: true }, db);
  await createTask(
    {
      title: `Sign petty cash voucher ${voucher.number}`,
      description: `${pc.purpose} · PKR ${voucher.amount.toLocaleString("en-PK")}`,
      taskType: "APPROVAL",
      assignedRoleCode: "FINANCE_APPROVER",
      entityId: pc.entityId,
      documentType: "PETTY_CASH",
      documentId: pc.id,
      documentRef: pc.number,
      slaHours: 48,
      linkUrl: `/petty-cash/${pc.id}`,
    },
    db,
  );
  await writeAudit(
    {
      entityType: "PettyCashVoucher",
      entityId: voucher.id,
      entityRef: voucher.number,
      action: "PETTY_CASH_VOUCHER_GENERATED",
      newValue: { amount: voucher.amount, payee: voucher.payeeName },
      caseKey: pc.number,
      actor: user,
    },
    db,
  );
  return voucher;
}

export async function signVoucher(
  user: SessionUser,
  input: { voucherId: string; approve: boolean; notes?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.PETTY_CASH_APPROVE)) {
    throw new ForbiddenError("You are not an authorised petty cash signatory.");
  }
  const voucher = await db.pettyCashVoucher.findUnique({
    where: { id: input.voucherId },
    include: { request: { include: { items: true } } },
  });
  if (!voucher) throw new NotFoundError("Voucher");
  if (voucher.status !== "PENDING_SIGNATORY") {
    throw new RuleViolationError(`Voucher ${voucher.number} is already ${voucher.status}.`);
  }

  const updated = await db.pettyCashVoucher.update({
    where: { id: voucher.id },
    data: {
      status: input.approve ? "APPROVED" : "REJECTED",
      signatoryId: user.id,
      signedAt: new Date(),
      notes: input.notes ?? null,
    },
  });
  await completeTasks("PETTY_CASH", voucher.requestId, user.id, db, "APPROVAL");

  if (!input.approve) {
    await transitionPc(user, voucher.requestId, "REJECTED", { reason: input.notes, force: true }, db);
    return updated;
  }

  await transitionPc(user, voucher.requestId, "VOUCHER_APPROVED", { force: true }, db);

  // The gap-closing step: an inventory-bearing purchase goes to STORE_ENTRY_PENDING,
  // not straight to reconciliation.
  const needsStore = requiresStoreEntry(voucher.request.items);
  if (needsStore) {
    await transitionPc(user, voucher.requestId, "STORE_ENTRY_PENDING", { force: true }, db);
    await createTask(
      {
        title: `Store entry required — ${voucher.request.number}`,
        description: "Items purchased on petty cash must be booked into store before reconciliation.",
        taskType: "DATA_ENTRY",
        assignedRoleCode: "STORE_MANAGER",
        entityId: voucher.request.entityId,
        documentType: "PETTY_CASH",
        documentId: voucher.requestId,
        documentRef: voucher.request.number,
        priority: "HIGH",
        slaHours: 24,
        linkUrl: `/petty-cash/${voucher.requestId}`,
      },
      db,
    );
    await raiseException(
      {
        type: "STORE_ENTRY_MISSING",
        severity: "MEDIUM",
        title: `${voucher.request.number}: store entry outstanding`,
        description:
          "This petty cash purchase includes inventory-bearing items. The request cannot be reconciled or closed until a store transaction exists for each of them.",
        documentType: "PETTY_CASH",
        documentId: voucher.requestId,
        documentRef: voucher.request.number,
        caseKey: voucher.request.number,
        entityId: voucher.request.entityId,
        raisedById: user.id,
        blocking: true,
        notifyRoles: ["STORE_MANAGER", "WAREHOUSE_MANAGER", "PROCUREMENT_OFFICER"],
      },
      db,
      user,
    );
  } else {
    await createTask(
      {
        title: `Reconcile petty cash ${voucher.request.number}`,
        taskType: "VERIFICATION",
        assignedRoleCode: "FINANCE_USER",
        entityId: voucher.request.entityId,
        documentType: "PETTY_CASH",
        documentId: voucher.requestId,
        documentRef: voucher.request.number,
        slaHours: 72,
        linkUrl: `/petty-cash/${voucher.requestId}`,
      },
      db,
    );
  }

  return updated;
}

/**
 * Books petty cash items into store. This is the only way a
 * STORE_ENTRY_PENDING request can progress.
 */
export async function completeStoreEntry(
  user: SessionUser,
  input: {
    requestId: string;
    storeId: string;
    lines: Array<{ pettyCashItemId: string; itemId: string; quantity: number; unitCost: number; locationId?: string | null }>;
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.INVENTORY_ADJUST, P.STORE_ISSUE, P.GRN_POST)) {
      throw new ForbiddenError("You do not have permission to record store entries.");
    }
    const pc = await tx.pettyCashRequest.findUnique({
      where: { id: input.requestId },
      include: { items: true },
    });
    if (!pc) throw new NotFoundError("Petty cash request");
    if (!["STORE_ENTRY_PENDING", "VOUCHER_APPROVED"].includes(pc.status)) {
      throw new RuleViolationError(
        `Request ${pc.number} is ${pc.status} — a store entry is not expected at this stage.`,
      );
    }
    if (!input.lines.length) throw new ValidationError("Record at least one store entry line.");

    for (const l of input.lines) {
      const it = pc.items.find((x) => x.id === l.pettyCashItemId);
      if (!it) throw new ValidationError("A store entry line does not belong to this request.");
      if (l.quantity <= 0) throw new ValidationError(`Quantity must be greater than zero for "${it.description}".`);
      if (l.quantity > it.quantity + 1e-9) {
        throw new ValidationError(
          `Cannot book ${l.quantity} ${it.unit} of "${it.description}" — only ${it.quantity} ${it.unit} was purchased.`,
        );
      }

      await postMovement(
        "RECEIPT",
        {
          itemId: l.itemId,
          storeId: input.storeId,
          quantity: l.quantity,
          unit: it.unit,
          unitCost: l.unitCost,
          locationId: l.locationId ?? null,
          entityId: pc.entityId,
          source: { kind: "PETTY_CASH", id: pc.id, ref: pc.number },
          reason: `Petty cash purchase ${pc.number}`,
          performedById: user.id,
        },
        tx,
        user,
      );
      await tx.pettyCashItem.update({
        where: { id: it.id },
        data: { storeEntered: true, itemId: l.itemId },
      });
    }

    // Every inventory-bearing line must now be booked.
    const refreshed = await tx.pettyCashItem.findMany({ where: { requestId: pc.id } });
    const outstanding = refreshed.filter(
      (i) => STORE_ENTRY_DISPOSITIONS.includes(i.disposition as Disposition) && !i.storeEntered,
    );
    if (outstanding.length) {
      await writeAudit(
        {
          entityType: "PettyCashRequest",
          entityId: pc.id,
          entityRef: pc.number,
          action: "PETTY_CASH_STORE_ENTRY_PARTIAL",
          newValue: { outstanding: outstanding.map((o) => o.description) },
          caseKey: pc.number,
          actor: user,
        },
        tx,
      );
      return { complete: false, outstanding: outstanding.map((o) => o.description) };
    }

    await transitionPc(
      user,
      pc.id,
      "STORE_ENTRY_DONE",
      { force: true, extra: { storeId: input.storeId, storeEntryDoneAt: new Date() } },
      tx,
    );
    await autoResolveExceptions(
      "PETTY_CASH",
      pc.id,
      ["STORE_ENTRY_MISSING"],
      "All inventory-bearing items booked into store",
      tx,
    );
    await completeTasks("PETTY_CASH", pc.id, user.id, tx, "DATA_ENTRY");
    await createTask(
      {
        title: `Reconcile petty cash ${pc.number}`,
        taskType: "VERIFICATION",
        assignedRoleCode: "FINANCE_USER",
        entityId: pc.entityId,
        documentType: "PETTY_CASH",
        documentId: pc.id,
        documentRef: pc.number,
        slaHours: 72,
        linkUrl: `/petty-cash/${pc.id}`,
      },
      tx,
    );

    await writeAudit(
      {
        entityType: "PettyCashRequest",
        entityId: pc.id,
        entityRef: pc.number,
        action: "PETTY_CASH_STORE_ENTRY_DONE",
        newValue: { storeId: input.storeId, lines: input.lines.length },
        caseKey: pc.number,
        actor: user,
      },
      tx,
    );

    return { complete: true, outstanding: [] as string[] };
  });
}

/**
 * Hard gate: every inventory-bearing item must have a store transaction before
 * the request can be reconciled or closed.
 */
export async function assertStoreEntryComplete(requestId: string, db: DbClient = prisma) {
  const pc = await db.pettyCashRequest.findUnique({
    where: { id: requestId },
    include: { items: true, transactions: true },
  });
  if (!pc) throw new NotFoundError("Petty cash request");

  const needing = pc.items.filter((i) => STORE_ENTRY_DISPOSITIONS.includes(i.disposition as Disposition));
  if (!needing.length) return;

  const unbooked = needing.filter((i) => !i.storeEntered);
  if (unbooked.length) {
    throw new RuleViolationError(
      `Petty cash request ${pc.number} cannot be closed: ${unbooked.length} inventory-bearing item(s) have no store entry.`,
      unbooked.map((u) => `${u.description} (${u.quantity} ${u.unit}, disposition ${u.disposition})`),
    );
  }
  if (!pc.transactions.length) {
    throw new RuleViolationError(
      `Petty cash request ${pc.number} is marked as stored but no inventory transaction exists against it.`,
    );
  }
}

export async function reconcilePettyCash(
  user: SessionUser,
  requestId: string,
  notes: string | null,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.PETTY_CASH_RECONCILE)) {
    throw new ForbiddenError("You do not have permission to reconcile petty cash.");
  }
  const pc = await db.pettyCashRequest.findUnique({ where: { id: requestId }, include: { vouchers: true } });
  if (!pc) throw new NotFoundError("Petty cash request");
  if (!["VOUCHER_APPROVED", "STORE_ENTRY_DONE"].includes(pc.status)) {
    throw new RuleViolationError(
      `Request ${pc.number} is ${pc.status} — it is not ready for reconciliation.`,
    );
  }
  if (!pc.vouchers.some((v) => v.status === "APPROVED")) {
    throw new RuleViolationError("An approved voucher is required before reconciliation.");
  }

  await assertStoreEntryComplete(requestId, db);

  const updated = await transitionPc(
    user,
    requestId,
    "RECONCILED",
    { reason: notes, force: true, extra: { reconciledById: user.id, reconciledAt: new Date() } },
    db,
  );
  await db.pettyCashVoucher.updateMany({
    where: { requestId, status: "APPROVED" },
    data: { status: "RECONCILED" },
  });
  await completeTasks("PETTY_CASH", requestId, user.id, db);
  return updated;
}

export async function closePettyCash(user: SessionUser, requestId: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.PETTY_CASH_RECONCILE, P.PETTY_CASH_APPROVE)) {
    throw new ForbiddenError("Not permitted.");
  }
  const pc = await db.pettyCashRequest.findUnique({ where: { id: requestId } });
  if (!pc) throw new NotFoundError("Petty cash request");
  if (pc.status !== "RECONCILED") {
    throw new RuleViolationError(`Request ${pc.number} must be reconciled before it can be closed.`);
  }
  await assertStoreEntryComplete(requestId, db);
  return transitionPc(user, requestId, "CLOSED", { extra: { closedAt: new Date() } }, db);
}

/** Requests stuck without their store entry — the operational gap made visible. */
export async function pettyCashStoreEntryGap(entityIds: string[] | null, db: DbClient = prisma) {
  const rows = await db.pettyCashRequest.findMany({
    where: {
      status: { in: ["VOUCHER_APPROVED", "STORE_ENTRY_PENDING", "PURCHASED", "RECEIPT_UPLOADED", "VOUCHER_GENERATED"] },
      storeRequired: true,
      ...(entityIds ? { entityId: { in: entityIds } } : {}),
    },
    include: {
      items: true,
      requester: { select: { name: true } },
      entity: { select: { code: true } },
      department: { select: { name: true } },
    },
    orderBy: { updatedAt: "asc" },
  });
  return rows
    .map((r) => ({
      id: r.id,
      number: r.number,
      purpose: r.purpose,
      status: r.status,
      entityCode: r.entity.code,
      department: r.department.name,
      requester: r.requester.name,
      amount: r.actualAmount ?? r.approvedAmount ?? r.estimatedAmount,
      updatedAt: r.updatedAt,
      unbooked: r.items.filter(
        (i) => STORE_ENTRY_DISPOSITIONS.includes(i.disposition as Disposition) && !i.storeEntered,
      ).length,
    }))
    .filter((r) => r.unbooked > 0);
}
