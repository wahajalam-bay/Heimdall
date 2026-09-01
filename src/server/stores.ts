import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify, createTask, completeTasks } from "@/lib/notify";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { round2 } from "@/lib/format";
import { availableQuantity, postMovement, requireStore, stockUnitCost } from "./inventory";
import { CONFIG_KEYS, getConfigBool, getConfigNumber } from "@/lib/config";
import { consumeReservation, releaseFor } from "./reservations";
import { alertBelowMinimum } from "./replenishment";

/**
 * Store issuance, inter-store transfers and stock adjustments.
 * Every movement is mediated by the inventory ledger — nothing edits balances
 * directly.
 */

/* ── Issuance ─────────────────────────────────────────────── */

/**
 * The gates a store requisition passes, and who may open each one.
 *
 * `PENDING_APPROVAL` is the status requisitions carried before the department and
 * head decisions were separated; rows created then still have to be workable, so
 * it maps onto the first gate.
 */
const APPROVAL_STAGES: Array<{ from: string; permission: string; denied: string }> = [
  {
    from: "PENDING_APPROVAL",
    permission: P.STORE_ISSUE_APPROVE,
    denied: "You do not have permission to approve stock issues.",
  },
  {
    from: "PENDING_DEPARTMENT_APPROVAL",
    permission: P.SR_APPROVE,
    denied: "You do not have permission to approve store requisitions.",
  },
  {
    from: "PENDING_HOD_APPROVAL",
    permission: P.SR_APPROVE_HOD,
    denied: "Only a department head may give this approval.",
  },
  {
    from: "PENDING_CROSS_STORE_APPROVAL",
    permission: P.SR_APPROVE_CROSS_STORE,
    denied: "Only the holding store's authority may release stock to another store.",
  },
];

/** Every status from which a requisition is still awaiting a decision. */
export const SR_PENDING_STATUSES = APPROVAL_STAGES.map((s) => s.from);

export type IssueItemInput = {
  itemId: string;
  requestedQty: number;
  unit: string;
  serialNumber?: string | null;
  batchNumber?: string | null;
  assetTag?: string | null;
  custodianUserId?: string | null;
  notes?: string | null;
};

export async function createStoreIssue(
  user: SessionUser,
  input: {
    storeId: string;
    recipientName: string;
    recipientUserId?: string | null;
    departmentId?: string | null;
    projectId?: string | null;
    purpose?: string | null;
    items: IssueItemInput[];
    submit?: boolean;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.STORE_ISSUE)) {
    throw new ForbiddenError("You do not have permission to raise store issues.");
  }
  if (!input.items.length) throw new ValidationError("Add at least one item to issue.");
  const store = await requireStore(input.storeId, db);

  const lines = [];
  let lineNo = 0;
  for (const it of input.items) {
    if (it.requestedQty <= 0) throw new ValidationError("Requested quantity must be greater than zero.");
    lineNo += 1;
    const available = await availableQuantity(it.itemId, input.storeId, db);
    lines.push({ ...it, lineNo, availableQty: available });
  }

  const number = await nextNumber(SEQ.ISSUE, db);
  const issue = await db.storeIssue.create({
    data: {
      number,
      storeId: input.storeId,
      requestedById: user.id,
      recipientName: input.recipientName.trim(),
      recipientUserId: input.recipientUserId ?? null,
      departmentId: input.departmentId ?? null,
      projectId: input.projectId ?? null,
      purpose: input.purpose ?? null,
      status: input.submit ? "PENDING_APPROVAL" : "DRAFT",
      items: {
        create: lines.map((l) => ({
          itemId: l.itemId,
          lineNo: l.lineNo,
          requestedQty: l.requestedQty,
          unit: l.unit,
          availableQty: l.availableQty,
          serialNumber: l.serialNumber ?? null,
          batchNumber: l.batchNumber ?? null,
          assetTag: l.assetTag ?? null,
          custodianUserId: l.custodianUserId ?? null,
          notes: l.notes ?? null,
        })),
      },
    },
  });

  if (input.submit) {
    await createTask(
      {
        title: `Approve stock issue ${issue.number}`,
        description: `${input.recipientName} · ${store.name}`,
        taskType: "APPROVAL",
        assigneeId: store.managerId ?? null,
        assignedRoleCode: store.managerId ? null : "STORE_MANAGER",
        entityId: store.entityId,
        documentType: "STORE_ISSUE",
        documentId: issue.id,
        documentRef: issue.number,
        slaHours: 24,
        linkUrl: `/issuance/${issue.id}`,
      },
      db,
    );
  }

  await writeAudit(
    {
      entityType: "StoreIssue",
      entityId: issue.id,
      entityRef: issue.number,
      action: "STORE_ISSUE_CREATED",
      newValue: { store: store.name, recipient: input.recipientName, lines: lines.length },
      actor: user,
    },
    db,
  );

  return issue;
}

export async function decideStoreIssue(
  user: SessionUser,
  input: {
    issueId: string;
    approve: boolean;
    reason?: string | null;
    approvedQuantities?: Record<string, number>;
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    const issue = await tx.storeIssue.findUnique({
      where: { id: input.issueId },
      include: { items: { include: { item: true } }, store: true },
    });
    if (!issue) throw new NotFoundError("Store issue");

    // A requisition passes three gates before the counter acts on it: the
    // department that wants the goods, the head who owns the budget, and — only
    // when the stock sits in somebody else's store — that store's authority. Each
    // gate is a distinct permission, so one person holding two of them still has
    // to make two decisions.
    const stage = APPROVAL_STAGES.find((st) => st.from === issue.status);
    if (!stage) {
      throw new RuleViolationError(`Issue ${issue.number} is ${issue.status} — it is not awaiting approval.`);
    }
    if (!userHasPermission(user, stage.permission)) {
      throw new ForbiddenError(stage.denied);
    }

    if (!input.approve) {
      if (!input.reason?.trim()) throw new ValidationError("Record the reason for rejection.");
      const rejected = await tx.storeIssue.update({
        where: { id: issue.id },
        data: { status: "REJECTED", rejectReason: input.reason, remarks: input.reason },
      });
      // Stock held for a requisition nobody approved goes back on the shelf.
      await releaseFor(user, { storeIssueId: issue.id }, `Requisition ${issue.number} rejected`, tx, {
        cascade: "store requisition rejected",
        from: [P.SR_APPROVE, P.SR_APPROVE_HOD, P.STORE_ISSUE_APPROVE],
      });
      await completeTasks("STORE_ISSUE", issue.id, user.id, tx);
      await writeAudit(
        {
          entityType: "StoreIssue",
          entityId: issue.id,
          entityRef: issue.number,
          action: "STORE_ISSUE_REJECTED",
          reason: input.reason,
          actor: user,
        },
        tx,
      );
      return rejected;
    }

    const problems: string[] = [];
    for (const li of issue.items) {
      const qty = input.approvedQuantities?.[li.id] ?? li.requestedQty;
      if (qty < 0) problems.push(`Line ${li.lineNo}: approved quantity cannot be negative.`);
      if (qty > li.requestedQty + 1e-9) {
        problems.push(`Line ${li.lineNo}: approved quantity exceeds the requested quantity.`);
      }
      const available = await availableQuantity(li.itemId, issue.storeId, tx);
      if (qty > available + 1e-9) {
        problems.push(
          `Line ${li.lineNo} (${li.item.name}): only ${available} ${li.unit} available at ${issue.store.name}.`,
        );
      }
    }
    if (problems.length) throw new RuleViolationError("This issue cannot be approved.", problems);

    for (const li of issue.items) {
      const qty = input.approvedQuantities?.[li.id] ?? li.requestedQty;
      await tx.storeIssueItem.update({ where: { id: li.id }, data: { approvedQty: qty } });
    }

    // Where the next gate lies depends on the requisition: a head's approval can be
    // switched off, and cross-store authority only applies when the stock is not
    // ours to give.
    const requireHod = await getConfigBool(CONFIG_KEYS.SR_REQUIRE_HOD, issue.store.entityId, tx);
    const needsCrossStore = Boolean(issue.sourceStoreId) && !issue.crossStoreApprovedAt;
    let nextStatus = "APPROVED";
    if (stage.from !== "PENDING_HOD_APPROVAL" && requireHod && !issue.hodApprovedAt) {
      nextStatus = "PENDING_HOD_APPROVAL";
    } else if (needsCrossStore && stage.from !== "PENDING_CROSS_STORE_APPROVAL") {
      nextStatus = "PENDING_CROSS_STORE_APPROVAL";
    }

    const stamp: Record<string, unknown> = {};
    if (stage.from === "PENDING_HOD_APPROVAL") {
      stamp.hodApprovedById = user.id;
      stamp.hodApprovedAt = new Date();
    } else if (stage.from === "PENDING_CROSS_STORE_APPROVAL") {
      stamp.crossStoreApprovedById = user.id;
      stamp.crossStoreApprovedAt = new Date();
    } else {
      stamp.departmentApprovedById = user.id;
      stamp.departmentApprovedAt = new Date();
    }

    const approved = await tx.storeIssue.update({
      where: { id: issue.id },
      data: {
        status: nextStatus,
        ...stamp,
        approvedAt: nextStatus === "APPROVED" ? new Date() : null,
        remarks: input.reason ?? issue.remarks,
      },
    });
    await completeTasks("STORE_ISSUE", issue.id, user.id, tx);

    if (nextStatus !== "APPROVED") {
      await createTask(
        {
          title:
            nextStatus === "PENDING_HOD_APPROVAL"
              ? `Approve store requisition — ${issue.number}`
              : `Authorise cross-store issue — ${issue.number}`,
          taskType: "APPROVAL",
          assignedRoleCode: nextStatus === "PENDING_HOD_APPROVAL" ? "HOD" : "STORE_MANAGER",
          entityId: issue.store.entityId,
          documentType: "STORE_ISSUE",
          documentId: issue.id,
          documentRef: issue.number,
          slaHours: await getConfigNumber(CONFIG_KEYS.SLA_SR_APPROVAL_HOURS, issue.store.entityId, tx),
          linkUrl: `/issuance/${issue.id}`,
        },
        tx,
      );
      await writeAudit(
        {
          entityType: "StoreIssue",
          entityId: issue.id,
          entityRef: issue.number,
          action: "STORE_ISSUE_STAGE_APPROVED",
          reason: input.reason ?? null,
          newValue: { stage: stage.from, next: nextStatus },
          actor: user,
        },
        tx,
      );
      return approved;
    }

    await createTask(
      {
        title: `Issue stock — ${issue.number}`,
        taskType: "ACTION",
        assigneeId: issue.store.managerId ?? user.id,
        entityId: issue.store.entityId,
        documentType: "STORE_ISSUE",
        documentId: issue.id,
        documentRef: issue.number,
        slaHours: 24,
        linkUrl: `/issuance/${issue.id}`,
      },
      tx,
    );
    await writeAudit(
      {
        entityType: "StoreIssue",
        entityId: issue.id,
        entityRef: issue.number,
        action: "STORE_ISSUE_APPROVED",
        reason: input.reason ?? null,
        actor: user,
      },
      tx,
    );
    return approved;
  });
}

/** Physically issues the approved stock, deducting inventory and moving custody. */
export async function issueStock(
  user: SessionUser,
  input: { issueId: string; issuedQuantities?: Record<string, number> },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx, defer) => {
    if (!userHasPermission(user, P.STORE_ISSUE)) throw new ForbiddenError("Not permitted.");
    const issue = await tx.storeIssue.findUnique({
      where: { id: input.issueId },
      include: { items: { include: { item: true } }, store: true },
    });
    if (!issue) throw new NotFoundError("Store issue");
    if (!["APPROVED", "PARTIALLY_ISSUED"].includes(issue.status)) {
      throw new RuleViolationError(`Issue ${issue.number} must be approved before stock is released.`);
    }

    // The reservation exists to stop anyone else taking this stock; at the counter
    // it has done its job. Dropping the hold before the movement is what lets the
    // issue consume the very quantity the hold was protecting.
    const held = await tx.inventoryReservation.findMany({
      where: { storeIssueId: issue.id, status: "ACTIVE" },
      select: { id: true },
    });
    for (const h of held) {
      await consumeReservation(user, h.id, tx, {
        cascade: "stock issued against the requisition",
        from: [P.STORE_ISSUE, P.SR_ISSUE],
      });
    }

    let anyIssued = false;
    let allIssued = true;

    for (const li of issue.items) {
      const target = li.approvedQty ?? li.requestedQty;
      const already = li.issuedQty;
      const qty = round2(input.issuedQuantities?.[li.id] ?? target - already);
      if (qty <= 0) {
        if (already + 1e-9 < target) allIssued = false;
        continue;
      }
      if (already + qty > target + 1e-9) {
        throw new RuleViolationError(
          `Line ${li.lineNo} (${li.item.name}): issuing ${qty} would exceed the approved quantity of ${target}.`,
        );
      }

      await postMovement(
        "ISSUE",
        {
          itemId: li.itemId,
          storeId: issue.storeId,
          quantity: qty,
          unit: li.unit,
          batchNumber: li.batchNumber,
          serialNumber: li.serialNumber,
          entityId: issue.store.entityId,
          source: { kind: "ISSUE", id: issue.id, ref: issue.number },
          reason: `Issued to ${issue.recipientName}`,
          performedById: user.id,
        },
        tx,
        user,
      );

      await tx.storeIssueItem.update({ where: { id: li.id }, data: { issuedQty: round2(already + qty) } });
      anyIssued = true;
      // ZAM/PUR/SOP-01 Store Flow (c) and (d): after the exit is recorded, the
      // balance is checked against the minimum, and reaching it alerts the
      // procurement associate. Deferred until the issue has committed — an
      // alert is not worth rolling an issue back for, and a notification sent
      // inside a transaction that later aborts announces something that did not
      // happen.
      const alertItemId = li.itemId;
      defer({
        label: `below-minimum check for ${li.item.sku}`,
        run: () =>
          alertBelowMinimum(alertItemId, issue.storeId, {
            entityId: issue.store.entityId,
            triggeredBy: issue.number,
          }),
      });
      if (already + qty + 1e-9 < target) allIssued = false;

      // Move asset custody where a tag was named.
      if (li.assetTag) {
        const asset = await tx.asset.findFirst({ where: { tag: li.assetTag } });
        if (asset) {
          await tx.asset.update({
            where: { id: asset.id },
            data: {
              status: "ISSUED",
              custodianId: li.custodianUserId ?? issue.recipientUserId ?? null,
              location: issue.recipientName,
            },
          });
          await tx.assetTransaction.create({
            data: {
              assetId: asset.id,
              type: "ISSUED",
              fromStatus: asset.status,
              toStatus: "ISSUED",
              fromCustodianId: asset.custodianId,
              toCustodianId: li.custodianUserId ?? issue.recipientUserId ?? null,
              fromLocation: asset.location,
              toLocation: issue.recipientName,
              reference: issue.number,
              performedById: user.id,
            },
          });
        }
      }
    }

    if (!anyIssued) throw new RuleViolationError("Nothing was issued — every line is already fully issued.");

    const updated = await tx.storeIssue.update({
      where: { id: issue.id },
      data: {
        status: allIssued ? "ISSUED" : "PARTIALLY_ISSUED",
        issuedAt: new Date(),
        issuedById: user.id,
      },
    });
    if (allIssued) await completeTasks("STORE_ISSUE", issue.id, user.id, tx);

    await writeAudit(
      {
        entityType: "StoreIssue",
        entityId: issue.id,
        entityRef: issue.number,
        action: allIssued ? "STORE_ISSUE_ISSUED" : "STORE_ISSUE_PARTIALLY_ISSUED",
        newValue: { recipient: issue.recipientName, store: issue.store.name },
        actor: user,
      },
      tx,
    );

    return updated;
  });
}

/* ── Store requisition transitions ────────────────────────── */

/**
 * Sends a requisition back to the requester to be corrected.
 *
 * Distinct from rejection: rejection ends the request, a return expects it to
 * come back. The stock is released either way, because holding goods against a
 * document nobody is acting on is how a store runs out of what it has.
 */
export async function returnStoreRequisition(
  user: SessionUser,
  input: { issueId: string; reason: string },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.SR_APPROVE, P.SR_APPROVE_HOD, P.STORE_ISSUE_APPROVE)) {
    throw new ForbiddenError("You do not have permission to return store requisitions.");
  }
  if (!input.reason?.trim()) throw new ValidationError("Say what needs correcting before returning it.");

  const issue = await db.storeIssue.findUnique({ where: { id: input.issueId } });
  if (!issue) throw new NotFoundError("Store requisition");
  if (!SR_PENDING_STATUSES.includes(issue.status)) {
    throw new RuleViolationError(`Requisition ${issue.number} is ${issue.status} — only one awaiting a decision can be returned.`);
  }

  const updated = await db.storeIssue.update({
    where: { id: issue.id },
    data: { status: "RETURNED", returnReason: input.reason.trim() },
  });
  await releaseFor(user, { storeIssueId: issue.id }, `Requisition ${issue.number} returned`, db, {
    cascade: "store requisition returned",
    from: [P.SR_APPROVE, P.SR_APPROVE_HOD, P.STORE_ISSUE_APPROVE],
  });
  await completeTasks("STORE_ISSUE", issue.id, user.id, db);
  await writeAudit(
    {
      entityType: "StoreIssue",
      entityId: issue.id,
      entityRef: issue.number,
      action: "STORE_ISSUE_RETURNED",
      reason: input.reason.trim(),
      actor: user,
    },
    db,
  );
  return updated;
}

/** Resubmits a returned requisition once the requester has corrected it. */
export async function resubmitStoreRequisition(
  user: SessionUser,
  issueId: string,
  db: DbClient = prisma,
) {
  const issue = await db.storeIssue.findUnique({ where: { id: issueId }, include: { store: true } });
  if (!issue) throw new NotFoundError("Store requisition");
  if (!["DRAFT", "RETURNED"].includes(issue.status)) {
    throw new RuleViolationError(`Requisition ${issue.number} is ${issue.status} — only a draft or returned one can be submitted.`);
  }
  if (issue.requestedById !== user.id && !userHasPermission(user, P.SR_CREATE)) {
    throw new ForbiddenError("Only the requester may resubmit this requisition.");
  }

  const updated = await db.storeIssue.update({
    where: { id: issueId },
    data: { status: "PENDING_DEPARTMENT_APPROVAL", submittedAt: new Date(), returnReason: null },
  });
  await createTask(
    {
      title: `Approve store requisition — ${issue.number}`,
      taskType: "APPROVAL",
      assignedRoleCode: "HOD",
      entityId: issue.store.entityId,
      documentType: "STORE_ISSUE",
      documentId: issue.id,
      documentRef: issue.number,
      slaHours: await getConfigNumber(CONFIG_KEYS.SLA_SR_APPROVAL_HOURS, issue.store.entityId, db),
      linkUrl: `/issuance/${issue.id}`,
    },
    db,
  );
  await writeAudit(
    {
      entityType: "StoreIssue",
      entityId: issue.id,
      entityRef: issue.number,
      action: "STORE_ISSUE_SUBMITTED",
      actor: user,
    },
    db,
  );
  return updated;
}

/**
 * Closes a requisition that will not be issued any further.
 *
 * A partially issued requisition otherwise sits open for ever, and the store
 * cannot tell the difference between one still being worked and one finished
 * short. Any remaining hold is released on the way out.
 */
export async function closeStoreRequisition(
  user: SessionUser,
  input: { issueId: string; reason?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.SR_ISSUE, P.STORE_ISSUE)) {
    throw new ForbiddenError("You do not have permission to close store requisitions.");
  }
  const issue = await db.storeIssue.findUnique({ where: { id: input.issueId }, include: { items: true } });
  if (!issue) throw new NotFoundError("Store requisition");
  if (!["ISSUED", "PARTIALLY_ISSUED", "APPROVED"].includes(issue.status)) {
    throw new RuleViolationError(`Requisition ${issue.number} is ${issue.status} — it cannot be closed from here.`);
  }
  const short = issue.items.some((i) => i.issuedQty + 1e-9 < (i.approvedQty ?? i.requestedQty));
  if (short && !input.reason?.trim()) {
    throw new ValidationError("This requisition was not issued in full. Record why it is being closed short.");
  }

  const updated = await db.storeIssue.update({
    where: { id: issue.id },
    data: { status: "CLOSED", closedAt: new Date(), remarks: input.reason ?? issue.remarks },
  });
  await releaseFor(user, { storeIssueId: issue.id }, `Requisition ${issue.number} closed`, db, {
    cascade: "store requisition closed",
    from: [P.SR_ISSUE, P.STORE_ISSUE],
  });
  await completeTasks("STORE_ISSUE", issue.id, user.id, db);
  await writeAudit(
    {
      entityType: "StoreIssue",
      entityId: issue.id,
      entityRef: issue.number,
      action: "STORE_ISSUE_CLOSED",
      reason: input.reason ?? null,
      newValue: { shortClosed: short },
      actor: user,
    },
    db,
  );
  return updated;
}

/* ── Transfers ────────────────────────────────────────────── */

export async function createTransfer(
  user: SessionUser,
  input: {
    fromStoreId: string;
    toStoreId: string;
    reason?: string | null;
    items: Array<{ itemId: string; requestedQty: number; unit: string; batchNumber?: string | null; serialNumber?: string | null; notes?: string | null }>;
    submit?: boolean;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.STORE_TRANSFER)) {
    throw new ForbiddenError("You do not have permission to raise store transfers.");
  }
  if (input.fromStoreId === input.toStoreId) {
    throw new ValidationError("The source and destination stores must be different.");
  }
  if (!input.items.length) throw new ValidationError("Add at least one item to transfer.");

  const [from, to] = await Promise.all([
    requireStore(input.fromStoreId, db),
    requireStore(input.toStoreId, db),
  ]);

  const problems: string[] = [];
  for (const [i, it] of input.items.entries()) {
    if (it.requestedQty <= 0) problems.push(`Line ${i + 1}: quantity must be greater than zero.`);
    const available = await availableQuantity(it.itemId, input.fromStoreId, db);
    if (it.requestedQty > available + 1e-9) {
      const item = await db.item.findUnique({ where: { id: it.itemId }, select: { name: true } });
      problems.push(
        `Line ${i + 1} (${item?.name ?? it.itemId}): only ${available} ${it.unit} available at ${from.name}.`,
      );
    }
  }
  if (problems.length) throw new RuleViolationError("This transfer cannot be raised.", problems);

  const number = await nextNumber(SEQ.TRANSFER, db);
  const transfer = await db.storeTransfer.create({
    data: {
      number,
      fromStoreId: input.fromStoreId,
      toStoreId: input.toStoreId,
      requestedById: user.id,
      reason: input.reason ?? null,
      status: input.submit ? "PENDING_APPROVAL" : "DRAFT",
      items: {
        create: input.items.map((it, i) => ({
          itemId: it.itemId,
          lineNo: i + 1,
          requestedQty: it.requestedQty,
          unit: it.unit,
          batchNumber: it.batchNumber ?? null,
          serialNumber: it.serialNumber ?? null,
          notes: it.notes ?? null,
        })),
      },
    },
  });

  if (input.submit) {
    await createTask(
      {
        title: `Approve store transfer ${transfer.number}`,
        description: `${from.name} → ${to.name}`,
        taskType: "APPROVAL",
        assignedRoleCode: "WAREHOUSE_MANAGER",
        entityId: from.entityId,
        documentType: "STORE_TRANSFER",
        documentId: transfer.id,
        documentRef: transfer.number,
        slaHours: 24,
        linkUrl: `/transfers/${transfer.id}`,
      },
      db,
    );
    await notify(
      {
        roleCodes: ["WAREHOUSE_MANAGER", "STORE_MANAGER"],
        entityId: from.entityId,
        type: "APPROVAL_REQUIRED",
        title: `Transfer ${transfer.number} awaiting approval`,
        body: `${from.name} → ${to.name}`,
        linkType: "STORE_TRANSFER",
        linkId: transfer.id,
        linkUrl: `/transfers/${transfer.id}`,
      },
      db,
    );
  }

  await writeAudit(
    {
      entityType: "StoreTransfer",
      entityId: transfer.id,
      entityRef: transfer.number,
      action: "TRANSFER_CREATED",
      newValue: { from: from.name, to: to.name, lines: input.items.length },
      actor: user,
    },
    db,
  );

  return transfer;
}

export async function decideTransfer(
  user: SessionUser,
  input: { transferId: string; approve: boolean; reason?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.STORE_TRANSFER_APPROVE)) {
    throw new ForbiddenError("You do not have permission to approve store transfers.");
  }
  const t = await db.storeTransfer.findUnique({
    where: { id: input.transferId },
    include: { fromStore: true, toStore: true },
  });
  if (!t) throw new NotFoundError("Transfer");
  if (t.status !== "PENDING_APPROVAL") {
    throw new RuleViolationError(`Transfer ${t.number} is ${t.status} — it is not awaiting approval.`);
  }
  if (!input.approve && !input.reason?.trim()) {
    throw new ValidationError("Record the reason for rejection.");
  }

  const updated = await db.storeTransfer.update({
    where: { id: t.id },
    data: {
      status: input.approve ? "APPROVED" : "REJECTED",
      approvedAt: input.approve ? new Date() : null,
      remarks: input.reason ?? t.remarks,
    },
  });
  await completeTasks("STORE_TRANSFER", t.id, user.id, db);

  if (input.approve) {
    await createTask(
      {
        title: `Dispatch transfer ${t.number}`,
        description: `${t.fromStore.name} → ${t.toStore.name}`,
        taskType: "ACTION",
        assigneeId: t.fromStore.managerId ?? null,
        assignedRoleCode: t.fromStore.managerId ? null : "STORE_MANAGER",
        entityId: t.fromStore.entityId,
        documentType: "STORE_TRANSFER",
        documentId: t.id,
        documentRef: t.number,
        slaHours: 48,
        linkUrl: `/transfers/${t.id}`,
      },
      db,
    );
  }

  await writeAudit(
    {
      entityType: "StoreTransfer",
      entityId: t.id,
      entityRef: t.number,
      action: input.approve ? "TRANSFER_APPROVED" : "TRANSFER_REJECTED",
      reason: input.reason ?? null,
      actor: user,
    },
    db,
  );
  return updated;
}

export async function dispatchTransfer(
  user: SessionUser,
  input: {
    transferId: string;
    vehicleNumber?: string | null;
    gatePassRef?: string | null;
    quantities?: Record<string, number>;
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.STORE_TRANSFER)) throw new ForbiddenError("Not permitted.");
    const t = await tx.storeTransfer.findUnique({
      where: { id: input.transferId },
      include: { items: { include: { item: true } }, fromStore: true, toStore: true },
    });
    if (!t) throw new NotFoundError("Transfer");
    if (t.status !== "APPROVED") {
      throw new RuleViolationError(`Transfer ${t.number} must be approved before dispatch.`);
    }

    for (const li of t.items) {
      const qty = round2(input.quantities?.[li.id] ?? li.requestedQty);
      if (qty <= 0) continue;
      if (qty > li.requestedQty + 1e-9) {
        throw new RuleViolationError(
          `Line ${li.lineNo} (${li.item.name}): dispatching ${qty} exceeds the approved ${li.requestedQty}.`,
        );
      }
      // Without a batch on the line the stock may span several buckets, so the
      // cost carried to the receiving store is the weighted average of what moves.
      const unitCost = await stockUnitCost(li.itemId, t.fromStoreId, li.batchNumber, tx);
      await postMovement(
        "TRANSFER_OUT",
        {
          itemId: li.itemId,
          storeId: t.fromStoreId,
          quantity: qty,
          unit: li.unit,
          unitCost,
          batchNumber: li.batchNumber,
          serialNumber: li.serialNumber,
          entityId: t.fromStore.entityId,
          source: { kind: "TRANSFER", id: t.id, ref: t.number },
          reason: `Dispatched to ${t.toStore.name}`,
          performedById: user.id,
        },
        tx,
        user,
      );
      await tx.storeTransferItem.update({
        where: { id: li.id },
        data: { dispatchedQty: qty, unitCost },
      });
    }

    const updated = await tx.storeTransfer.update({
      where: { id: t.id },
      data: {
        status: "DISPATCHED",
        dispatchedAt: new Date(),
        dispatchedById: user.id,
        vehicleNumber: input.vehicleNumber ?? null,
        gatePassRef: input.gatePassRef ?? null,
      },
    });

    await createTask(
      {
        title: `Confirm receipt of transfer ${t.number}`,
        description: `From ${t.fromStore.name}`,
        taskType: "RECEIVING",
        assigneeId: t.toStore.managerId ?? null,
        assignedRoleCode: t.toStore.managerId ? null : "STORE_RECEIVER",
        entityId: t.toStore.entityId,
        documentType: "STORE_TRANSFER",
        documentId: t.id,
        documentRef: t.number,
        priority: "HIGH",
        slaHours: 48,
        linkUrl: `/transfers/${t.id}`,
      },
      tx,
    );
    await notify(
      {
        userIds: t.toStore.managerId ? [t.toStore.managerId] : [],
        roleCodes: t.toStore.managerId ? [] : ["STORE_RECEIVER", "SITE_STORE_USER"],
        entityId: t.toStore.entityId,
        type: "GENERAL",
        title: `Transfer ${t.number} dispatched to ${t.toStore.name}`,
        body: input.vehicleNumber ? `Vehicle ${input.vehicleNumber}` : undefined,
        linkType: "STORE_TRANSFER",
        linkId: t.id,
        linkUrl: `/transfers/${t.id}`,
      },
      tx,
    );

    await writeAudit(
      {
        entityType: "StoreTransfer",
        entityId: t.id,
        entityRef: t.number,
        action: "TRANSFER_DISPATCHED",
        newValue: { vehicle: input.vehicleNumber, gatePass: input.gatePassRef },
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

export async function receiveTransfer(
  user: SessionUser,
  input: { transferId: string; quantities?: Record<string, number>; remarks?: string | null },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.STORE_TRANSFER, P.RECEIVE_GOODS)) throw new ForbiddenError("Not permitted.");
    const t = await tx.storeTransfer.findUnique({
      where: { id: input.transferId },
      include: { items: { include: { item: true } }, fromStore: true, toStore: true },
    });
    if (!t) throw new NotFoundError("Transfer");
    if (t.status !== "DISPATCHED") {
      throw new RuleViolationError(`Transfer ${t.number} must be dispatched before it can be received.`);
    }

    const shortfalls: string[] = [];
    for (const li of t.items) {
      const qty = round2(input.quantities?.[li.id] ?? li.dispatchedQty);
      if (qty <= 0) continue;
      if (qty > li.dispatchedQty + 1e-9) {
        throw new RuleViolationError(
          `Line ${li.lineNo} (${li.item.name}): receiving ${qty} exceeds the dispatched ${li.dispatchedQty}.`,
        );
      }
      await postMovement(
        "TRANSFER_IN",
        {
          itemId: li.itemId,
          storeId: t.toStoreId,
          quantity: qty,
          unit: li.unit,
          unitCost: li.unitCost,
          batchNumber: li.batchNumber,
          serialNumber: li.serialNumber,
          entityId: t.toStore.entityId,
          source: { kind: "TRANSFER", id: t.id, ref: t.number },
          reason: `Received from ${t.fromStore.name}`,
          performedById: user.id,
        },
        tx,
        user,
      );
      await tx.storeTransferItem.update({ where: { id: li.id }, data: { receivedQty: qty } });
      if (qty + 1e-9 < li.dispatchedQty) {
        shortfalls.push(`${li.item.name}: dispatched ${li.dispatchedQty} ${li.unit}, received ${qty} ${li.unit}`);
      }
    }

    const updated = await tx.storeTransfer.update({
      where: { id: t.id },
      data: {
        status: "RECEIVED",
        receivedAt: new Date(),
        receivedById: user.id,
        remarks: [t.remarks, input.remarks].filter(Boolean).join("\n") || null,
      },
    });
    await completeTasks("STORE_TRANSFER", t.id, user.id, tx);

    if (shortfalls.length) {
      const { raiseException } = await import("@/lib/exceptions-service");
      await raiseException(
        {
          type: "QUANTITY_MISMATCH",
          severity: "MEDIUM",
          title: `Transfer ${t.number}: in-transit shortfall`,
          description: shortfalls.join(" · "),
          documentType: "STORE_TRANSFER",
          documentId: t.id,
          documentRef: t.number,
          entityId: t.toStore.entityId,
          raisedById: user.id,
          notifyRoles: ["WAREHOUSE_MANAGER", "STORE_MANAGER", "AUDIT_USER"],
        },
        tx,
        user,
      );
    }

    await writeAudit(
      {
        entityType: "StoreTransfer",
        entityId: t.id,
        entityRef: t.number,
        action: "TRANSFER_RECEIVED",
        newValue: { shortfalls },
        reason: input.remarks ?? null,
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/* ── Adjustments ──────────────────────────────────────────── */

export async function adjustStock(
  user: SessionUser,
  input: {
    itemId: string;
    storeId: string;
    quantityDelta: number;
    unit: string;
    batchNumber?: string | null;
    serialNumber?: string | null;
    reason: string;
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.INVENTORY_ADJUST)) {
      throw new ForbiddenError("You do not have permission to adjust inventory.");
    }
    if (!input.reason?.trim() || input.reason.trim().length < 8) {
      throw new ValidationError("A substantive reason is required for every stock adjustment.");
    }
    if (input.quantityDelta === 0) throw new ValidationError("Adjustment quantity cannot be zero.");

    const store = await requireStore(input.storeId, tx);
    return postMovement(
      "ADJUSTMENT",
      {
        itemId: input.itemId,
        storeId: input.storeId,
        quantity: input.quantityDelta,
        unit: input.unit,
        batchNumber: input.batchNumber,
        serialNumber: input.serialNumber,
        entityId: store.entityId,
        source: { kind: "ADJUSTMENT", ref: `Manual adjustment by ${user.name}` },
        reason: input.reason.trim(),
        performedById: user.id,
      },
      tx,
      user,
    );
  });
}

/** Aggregated per-store position for the Stores landing page. */
export async function storeSummaries(entityIds: string[] | null, db: DbClient = prisma) {
  const stores = await db.store.findMany({
    where: { ...(entityIds ? { entityId: { in: entityIds } } : {}) },
    include: {
      entity: { select: { code: true, name: true } },
      site: { select: { name: true } },
      project: { select: { name: true } },
      _count: { select: { locations: true, grns: true } },
    },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });

  const results = [];
  for (const s of stores) {
    const agg = await db.inventoryItem.aggregate({
      where: { storeId: s.id },
      _sum: { quantity: true, totalValue: true },
      _count: { _all: true },
    });
    const openIssues = await db.storeIssue.count({
      where: { storeId: s.id, status: { in: ["PENDING_APPROVAL", "APPROVED", "PARTIALLY_ISSUED"] } },
    });
    const inbound = await db.storeTransfer.count({ where: { toStoreId: s.id, status: "DISPATCHED" } });
    const manager = s.managerId
      ? await db.user.findUnique({ where: { id: s.managerId }, select: { name: true } })
      : null;
    results.push({
      id: s.id,
      code: s.code,
      name: s.name,
      kind: s.kind,
      city: s.city,
      active: s.active,
      entityCode: s.entity.code,
      siteName: s.site?.name ?? null,
      projectName: s.project?.name ?? null,
      managerName: manager?.name ?? null,
      locationCount: s._count.locations,
      grnCount: s._count.grns,
      skuCount: agg._count._all,
      totalQuantity: round2(agg._sum.quantity ?? 0),
      totalValue: round2(agg._sum.totalValue ?? 0),
      openIssues,
      inboundTransfers: inbound,
    });
  }
  return results;
}
