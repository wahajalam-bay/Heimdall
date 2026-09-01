import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { round2 } from "@/lib/format";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { DOMAIN_ACTIONS, assertAuthority, type Actor, type Authority } from "@/lib/actor";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { createTask, completeTasks } from "@/lib/notify";
import { postMovement } from "./inventory";

/**
 * What happens when a receipt does not match the order.
 *
 * The specification says a PO-to-GRN mismatch is "zeroed out". Read literally
 * that would mean the difference disappears, which is the one thing it must not
 * do. It is read here as: the transaction is squared off so the order can close,
 * and the difference becomes a record — typed, owned, dated and reasoned. The
 * order still says what was ordered and the receipt still says what came.
 *
 * Rejections and returns are separate from that. A rejection is the finding; a
 * return is the goods going back. Goods refused before they were taken into stock
 * never increase inventory at all, and goods refused afterwards are adjusted out
 * — those are different events with different consequences for the vendor.
 */

/* ── Variances ────────────────────────────────────────────── */

export type VarianceInput = {
  poId: string;
  grnId?: string | null;
  type: "QUANTITY" | "PRICE" | "TAX" | "TOTAL" | "SPECIFICATION";
  poQuantity?: number | null;
  grnQuantity?: number | null;
  poValue?: number | null;
  grnValue?: number | null;
  reasonCode: string;
  reason?: string | null;
};

/** Records a difference. Never called to make one go away. */
export async function recordVariance(
  actor: Actor,
  input: VarianceInput,
  db: DbClient = prisma,
  /**
   * Reconciliation runs as part of posting a receipt, so the poster's grounds
   * are named rather than requiring them to also hold `variance.resolve`.
   */
  authority: Authority = { permission: [P.VARIANCE_RESOLVE, P.GRN_POST] },
) {
  assertAuthority(actor, DOMAIN_ACTIONS.VARIANCE_RECORD, authority);
  const createdById = actor.id;
  const variance = round2(
    input.type === "QUANTITY"
      ? (input.grnQuantity ?? 0) - (input.poQuantity ?? 0)
      : (input.grnValue ?? 0) - (input.poValue ?? 0),
  );
  const base = input.type === "QUANTITY" ? (input.poQuantity ?? 0) : (input.poValue ?? 0);

  const row = await db.poVariance.create({
    data: {
      number: await nextNumber(SEQ.VARIANCE, db),
      poId: input.poId,
      grnId: input.grnId ?? null,
      type: input.type,
      poQuantity: input.poQuantity ?? null,
      grnQuantity: input.grnQuantity ?? null,
      poValue: input.poValue ?? null,
      grnValue: input.grnValue ?? null,
      variance,
      variancePct: base > 0 ? round2((variance / base) * 100) : null,
      reasonCode: input.reasonCode,
      reason: input.reason ?? null,
      status: "OPEN",
    },
  });

  await writeAudit(
    {
      entityType: "PoVariance",
      entityId: row.id,
      entityRef: row.number,
      action: "VARIANCE_RECORDED",
      newValue: { type: input.type, variance, reasonCode: input.reasonCode },
      actor: createdById ? { id: createdById, name: "" } : null,
    },
    db,
  );
  return row;
}

/**
 * Compares a posted receipt against its order and records what differs.
 *
 * Differences inside the configured tolerance are still recorded — a tolerance
 * decides whether somebody is asked to act, not whether the difference happened.
 */
export async function reconcileGrnToPo(
  actor: Actor,
  grnId: string,
  db: DbClient = prisma,
  authority: Authority = { permission: [P.VARIANCE_RESOLVE, P.GRN_POST] },
) {
  const grn = await db.grn.findUnique({
    where: { id: grnId },
    include: {
      po: { select: { id: true, number: true, entityId: true } },
      items: {
        select: {
          lineNo: true,
          description: true,
          acceptedQty: true,
          rejectedQty: true,
          orderedQty: true,
          unitPrice: true,
          poItemId: true,
        },
      },
    },
  });
  if (!grn?.po) return [];

  const tolerance = await getConfigNumber(CONFIG_KEYS.VARIANCE_TOLERANCE_PERCENT, grn.po.entityId, db);
  const created: string[] = [];

  for (const line of grn.items) {
    const ordered = line.orderedQty ?? 0;
    if (ordered <= 0) continue;
    const received = round2(line.acceptedQty);
    const diff = round2(received - ordered);
    if (Math.abs(diff) < 1e-9) continue;

    const pct = Math.abs((diff / ordered) * 100);
    const row = await recordVariance(
      actor,
      {
        poId: grn.po.id,
        grnId: grn.id,
        type: "QUANTITY",
        poQuantity: ordered,
        grnQuantity: received,
        poValue: round2(ordered * line.unitPrice),
        grnValue: round2(received * line.unitPrice),
        reasonCode: diff < 0 ? "SHORT_SUPPLY" : "OVER_SUPPLY",
        reason:
          pct <= tolerance
            ? `Within the ${tolerance}% tolerance; recorded for the record rather than for action.`
            : `Line ${line.lineNo} (${line.description}) differs by ${diff} against ${ordered} ordered.`,
      },
      db,
      authority,
    );
    created.push(row.number);

    // Beyond tolerance somebody has to decide what happens to the difference.
    if (pct > tolerance) {
      await createTask(
        {
          title: `Resolve receipt variance ${row.number}`,
          taskType: "ACTION",
          assignedRoleCode: "PROCUREMENT_OFFICER",
          entityId: grn.po.entityId,
          documentType: "PO_VARIANCE",
          documentId: row.id,
          documentRef: row.number,
          slaHours: 72,
          linkUrl: `/receiving/variances/${row.id}`,
        },
        db,
      );
    }
  }
  return created;
}

export async function resolveVariance(
  user: SessionUser,
  input: { varianceId: string; status: "ACCEPTED" | "RECOVERED" | "WRITTEN_OFF" | "DISPUTED"; resolution: string },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.VARIANCE_RESOLVE)) {
    throw new ForbiddenError("You do not have permission to resolve receipt variances.");
  }
  if (!input.resolution?.trim()) {
    throw new ValidationError("Record how the variance was resolved — this is the audit answer.");
  }
  const variance = await db.poVariance.findUnique({ where: { id: input.varianceId } });
  if (!variance) throw new NotFoundError("Variance");
  if (variance.status !== "OPEN") {
    throw new RuleViolationError(`Variance ${variance.number} is already ${variance.status}.`);
  }

  const updated = await db.poVariance.update({
    where: { id: input.varianceId },
    data: {
      status: input.status,
      resolution: input.resolution.trim(),
      resolvedById: user.id,
      resolvedAt: new Date(),
    },
  });
  await completeTasks("PO_VARIANCE", input.varianceId, user.id, db);
  await writeAudit(
    {
      entityType: "PoVariance",
      entityId: input.varianceId,
      entityRef: variance.number,
      action: `VARIANCE_${input.status}`,
      reason: input.resolution.trim(),
      actor: user,
    },
    db,
  );
  return updated;
}

/* ── Rejections ───────────────────────────────────────────── */

export type RejectionInput = {
  deliveryId?: string | null;
  inspectionId?: string | null;
  grnId?: string | null;
  itemId?: string | null;
  description: string;
  quantity: number;
  unit: string;
  reasonCode: string;
  reason?: string | null;
  /** ADJUSTED_OUT means it had already been taken into stock. */
  disposition?: "SPOT_REJECTION" | "ADJUSTED_OUT";
  storeId?: string | null;
};

/**
 * Records goods refused.
 *
 * Where the goods had already been taken into stock, inventory is reduced through
 * the ledger as part of the same act — leaving it to a later manual adjustment is
 * how stock records come to disagree with the shelf.
 */
export async function recordRejection(
  user: SessionUser,
  input: RejectionInput,
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.RECEIVE_GOODS, P.GRN_CREATE, P.INSPECTION_PERFORM)) {
      throw new ForbiddenError("You do not have permission to record a rejection.");
    }
    if (input.quantity <= 0) throw new ValidationError("A rejected quantity must be greater than zero.");

    const disposition = input.disposition ?? "SPOT_REJECTION";
    let adjusted = false;

    if (disposition === "ADJUSTED_OUT") {
      if (!input.itemId || !input.storeId) {
        throw new ValidationError(
          "Adjusting stock out needs the item and the store it was received into.",
        );
      }
      await postMovement(
        "ADJUSTMENT",
        {
          itemId: input.itemId,
          storeId: input.storeId,
          quantity: -Math.abs(input.quantity),
          unit: input.unit,
          source: { kind: "ADJUSTMENT", ref: "Rejection after receipt" },
          reason: `Rejected after receipt: ${input.reasonCode}${input.reason ? ` — ${input.reason}` : ""}`,
          performedById: user.id,
        },
        tx,
        user,
        {
          cascade: "goods rejected after receipt",
          from: [P.GRN_CREATE, P.INSPECTION_PERFORM, P.RECEIVE_GOODS],
        },
      );
      adjusted = true;
    }

    const row = await tx.rejectionRecord.create({
      data: {
        number: await nextNumber(SEQ.REJECTION, tx),
        deliveryId: input.deliveryId ?? null,
        inspectionId: input.inspectionId ?? null,
        grnId: input.grnId ?? null,
        itemId: input.itemId ?? null,
        description: input.description,
        quantity: round2(input.quantity),
        unit: input.unit,
        reasonCode: input.reasonCode,
        reason: input.reason ?? null,
        disposition,
        inventoryAdjusted: adjusted,
        raisedById: user.id,
      },
    });

    await writeAudit(
      {
        entityType: "RejectionRecord",
        entityId: row.id,
        entityRef: row.number,
        action: "REJECTION_RECORDED",
        newValue: { quantity: input.quantity, reasonCode: input.reasonCode, disposition, inventoryAdjusted: adjusted },
        actor: user,
      },
      tx,
    );
    return row;
  });
}

/* ── Returns to vendor ────────────────────────────────────── */

export type ReturnLineInput = {
  itemId?: string | null;
  description: string;
  quantity: number;
  unit: string;
  unitValue?: number | null;
  reasonCode?: string | null;
};

export async function createVendorReturn(
  user: SessionUser,
  input: {
    vendorId: string;
    poId?: string | null;
    grnId?: string | null;
    /** Set when the return follows a failed inspection. */
    inspectionId?: string | null;
    reason: string;
    replacementRequired?: boolean;
    items: ReturnLineInput[];
    rejectionIds?: string[];
  },
  db: DbClient = prisma,
  /**
   * Grounds, when the return follows from an authorized operation elsewhere.
   *
   * ZAM/PUR/SOP-01 Store Flow step 3 puts the RTV in the hands of "the relevant
   * inspector", who need not also hold the general returns permission. Omitted,
   * the caller must hold that permission in their own right; supplied, the
   * originating permission is re-verified rather than assumed.
   */
  authority: Authority = { permission: [P.RETURN_CREATE] },
) {
  return withTransaction(db, async (tx) => {
    assertAuthority(user, DOMAIN_ACTIONS.VENDOR_RETURN_CREATE, authority);
    if (!input.items.length) throw new ValidationError("A return needs at least one line.");
    if (!input.reason?.trim()) throw new ValidationError("State why the goods are going back.");

    const lines = input.items.map((l, i) => {
      if (l.quantity <= 0) throw new ValidationError(`Line ${i + 1}: quantity must be greater than zero.`);
      const unitValue = round2(l.unitValue ?? 0);
      return {
        lineNo: i + 1,
        itemId: l.itemId ?? null,
        description: l.description,
        quantity: round2(l.quantity),
        unit: l.unit,
        unitValue,
        lineValue: round2(unitValue * l.quantity),
        reasonCode: l.reasonCode ?? null,
      };
    });

    const days = await getConfigNumber(CONFIG_KEYS.RETURN_REPLACEMENT_DAYS, null, tx);
    const ret = await tx.vendorReturn.create({
      data: {
        number: await nextNumber(SEQ.VENDOR_RETURN, tx),
        vendorId: input.vendorId,
        poId: input.poId ?? null,
        grnId: input.grnId ?? null,
        inspectionId: input.inspectionId ?? null,
        status: "DRAFT",
        reason: input.reason.trim(),
        totalValue: round2(lines.reduce((a, l) => a + l.lineValue, 0)),
        replacementRequired: Boolean(input.replacementRequired),
        replacementStatus: input.replacementRequired ? "AWAITED" : "NOT_REQUIRED",
        replacementDueDate: input.replacementRequired ? new Date(Date.now() + days * 86400000) : null,
        raisedById: user.id,
        items: { create: lines },
      },
    });

    // Tie the findings to the goods going back, so the vendor record connects the two.
    if (input.rejectionIds?.length) {
      await tx.rejectionRecord.updateMany({
        where: { id: { in: input.rejectionIds } },
        data: { returnId: ret.id },
      });
    }

    await writeAudit(
      {
        entityType: "VendorReturn",
        entityId: ret.id,
        entityRef: ret.number,
        action: "RETURN_CREATED",
        newValue: { lines: lines.length, value: ret.totalValue, replacement: ret.replacementRequired },
        actor: user,
      },
      tx,
    );
    return ret;
  });
}

/** Authorises the return, which is what allows the goods off site. */
export async function authoriseReturn(user: SessionUser, returnId: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.RETURN_AUTHORISE)) {
    throw new ForbiddenError("You do not have permission to authorise vendor returns.");
  }
  const ret = await db.vendorReturn.findUnique({ where: { id: returnId }, include: { vendor: true } });
  if (!ret) throw new NotFoundError("Vendor return");
  if (ret.status !== "DRAFT") {
    throw new RuleViolationError(`Return ${ret.number} is ${ret.status} — only a draft can be authorised.`);
  }

  const updated = await db.vendorReturn.update({
    where: { id: returnId },
    data: { status: "AUTHORISED" },
  });
  await createTask(
    {
      title: `Dispatch return ${ret.number} to ${ret.vendor.name}`,
      taskType: "ACTION",
      assignedRoleCode: "STORE_MANAGER",
      documentType: "VENDOR_RETURN",
      documentId: ret.id,
      documentRef: ret.number,
      slaHours: 48,
      linkUrl: `/receiving/returns/${ret.id}`,
    },
    db,
  );
  await writeAudit(
    {
      entityType: "VendorReturn",
      entityId: returnId,
      entityRef: ret.number,
      action: "RETURN_AUTHORISED",
      actor: user,
    },
    db,
  );
  return updated;
}

export async function advanceReturn(
  user: SessionUser,
  input: {
    returnId: string;
    to: "DISPATCHED" | "ACKNOWLEDGED" | "REPLACED" | "CREDITED" | "CLOSED" | "CANCELLED";
    gatePassRef?: string | null;
    creditNoteRef?: string | null;
    creditNoteAmount?: number | null;
    replacementGrnId?: string | null;
    note?: string | null;
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.RETURN_CREATE, P.RETURN_AUTHORISE)) {
      throw new ForbiddenError("You do not have permission to progress vendor returns.");
    }
    const ret = await tx.vendorReturn.findUnique({ where: { id: input.returnId } });
    if (!ret) throw new NotFoundError("Vendor return");

    // The order the states may be reached in. A return cannot be acknowledged
    // before it was sent, and cannot be closed while a replacement is still owed.
    const allowed: Record<string, string[]> = {
      AUTHORISED: ["DISPATCHED", "CANCELLED"],
      DISPATCHED: ["ACKNOWLEDGED", "CANCELLED"],
      ACKNOWLEDGED: ["REPLACED", "CREDITED", "CLOSED"],
      REPLACED: ["CLOSED"],
      CREDITED: ["CLOSED"],
    };
    if (!allowed[ret.status]?.includes(input.to)) {
      throw new RuleViolationError(`A return that is ${ret.status} cannot move to ${input.to}.`);
    }
    if (input.to === "CLOSED" && ret.replacementRequired && ret.replacementStatus === "AWAITED") {
      throw new RuleViolationError(
        "A replacement is still awaited. Record the replacement or the credit note before closing.",
      );
    }
    if (input.to === "CREDITED" && !input.creditNoteRef?.trim()) {
      throw new ValidationError("Record the credit note reference.");
    }

    const updated = await tx.vendorReturn.update({
      where: { id: input.returnId },
      data: {
        status: input.to,
        gatePassRef: input.gatePassRef ?? ret.gatePassRef,
        dispatchedAt: input.to === "DISPATCHED" ? new Date() : ret.dispatchedAt,
        acknowledgedAt: input.to === "ACKNOWLEDGED" ? new Date() : ret.acknowledgedAt,
        closedAt: input.to === "CLOSED" ? new Date() : ret.closedAt,
        replacementGrnId: input.replacementGrnId ?? ret.replacementGrnId,
        creditNoteRef: input.creditNoteRef ?? ret.creditNoteRef,
        creditNoteAmount: input.creditNoteAmount ?? ret.creditNoteAmount,
        replacementStatus:
          input.to === "REPLACED"
            ? "RECEIVED"
            : input.to === "CREDITED"
              ? "CREDIT_NOTE"
              : ret.replacementStatus,
      },
    });
    if (["CLOSED", "CANCELLED"].includes(input.to)) {
      await completeTasks("VENDOR_RETURN", input.returnId, user.id, tx);
    }
    await writeAudit(
      {
        entityType: "VendorReturn",
        entityId: input.returnId,
        entityRef: ret.number,
        action: `RETURN_${input.to}`,
        reason: input.note ?? null,
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/* ── Reading ──────────────────────────────────────────────── */

export async function receivingExceptionStats(entityIds: string[] | null, db: DbClient = prisma) {
  const poScope = entityIds ? { po: { entityId: { in: entityIds } } } : {};
  const [openVariances, varianceValue, openReturns, replacementOverdue] = await Promise.all([
    db.poVariance.count({ where: { status: "OPEN", ...poScope } }),
    db.poVariance.aggregate({ where: { status: "OPEN", ...poScope }, _sum: { variance: true } }),
    db.vendorReturn.count({ where: { status: { notIn: ["CLOSED", "CANCELLED"] } } }),
    db.vendorReturn.count({
      where: {
        replacementStatus: "AWAITED",
        replacementDueDate: { lt: new Date() },
        status: { notIn: ["CLOSED", "CANCELLED"] },
      },
    }),
  ]);
  return {
    openVariances,
    varianceValue: round2(varianceValue._sum.variance ?? 0),
    openReturns,
    replacementOverdue,
  };
}


/* ── Return to vendor, from a failed inspection ───────────── */

/**
 * Raises the RTV a failed inspection calls for, without re-entry.
 *
 * ZAM/PUR/SOP-01 Store – Process Flow, step 3: "If incoming goods pass
 * inspection, Store Manager will proceed to Step 4. **If inspection fails, a
 * Return-to-Vendor (RTV) document will be lodged by the relevant inspector
 * within the ERP.**"
 *
 * Vendor returns existed as a module and nothing connected them to an
 * inspection. Somebody who had just recorded a failure had to open another
 * screen and retype the vendor, the order, the lines, the quantities and the
 * prices — which is how a failed inspection quietly becomes no return at all,
 * and how the quantity on the return stops matching the quantity that failed.
 *
 * The failed quantities come from the inspection; the prices come from the
 * order. Neither is asked for again, so neither can drift.
 *
 * The inspector may lodge it, as the SOP says, whether or not they also hold the
 * general returns permission — the authority to condemn the goods is what the
 * SOP treats as the authority to send them back.
 */
export async function returnFromInspection(
  user: SessionUser,
  input: { inspectionId: string; reason?: string | null; replacementRequired?: boolean },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.RETURN_CREATE, P.INSPECTION_PERFORM)) {
      throw new ForbiddenError(
        "Lodging a return against a failed inspection needs either the returns permission or the authority to inspect.",
      );
    }

    const inspection = await tx.inspection.findUnique({
      where: { id: input.inspectionId },
      include: {
        items: { include: { poItem: { select: { unitPrice: true, unit: true } } } },
        po: { select: { id: true, number: true, vendorId: true, vendor: { select: { name: true } } } },
        delivery: { select: { grns: { select: { id: true } } } },
      },
    });
    if (!inspection) throw new NotFoundError("Inspection");
    if (!inspection.po) {
      throw new RuleViolationError(
        `${inspection.number} is not against a purchase order, so there is no vendor to return the goods to.`,
      );
    }
    if (!["REJECTED", "CONDITIONAL"].includes(inspection.result)) {
      throw new RuleViolationError(
        `${inspection.number} is ${inspection.result.toLowerCase()}. A return to vendor follows a failed inspection, not a passed one.`,
      );
    }

    const existing = await tx.vendorReturn.findFirst({
      where: { inspectionId: inspection.id, status: { not: "CANCELLED" } },
      select: { number: true },
    });
    if (existing) {
      throw new RuleViolationError(
        `${existing.number} has already been raised against ${inspection.number}. Amend that return rather than raising a second one.`,
      );
    }

    const failed = inspection.items.filter((i) => i.quantityFailed > 0);
    if (!failed.length) {
      throw new RuleViolationError(
        `Nothing on ${inspection.number} was recorded as failed, so there is nothing to send back. ` +
          "Record the failed quantities on the inspection first.",
      );
    }

    const lines: ReturnLineInput[] = failed.map((i) => ({
      itemId: i.itemId,
      description: i.description,
      quantity: round2(i.quantityFailed),
      unit: i.poItem?.unit ?? "EA",
      // The order's price, not a fresh entry. A return valued at a number
      // somebody typed is a number nobody can reconcile to the invoice.
      unitValue: i.poItem?.unitPrice ?? 0,
      reasonCode: i.verdict === "FAIL" ? "INSPECTION_FAIL" : "INSPECTION_CONDITIONAL",
    }));

    // The findings that condemned the goods, so the vendor record connects the
    // inspection, the rejection and the return rather than holding three
    // unrelated documents.
    const rejections = await tx.rejectionRecord.findMany({
      where: { inspectionId: inspection.id, returnId: null },
      select: { id: true },
    });

    const reason =
      input.reason?.trim() ||
      `Failed inspection ${inspection.number}` +
        (inspection.findings ? ` — ${inspection.findings}` : "");

    return createVendorReturn(
      user,
      {
        vendorId: inspection.po.vendorId,
        poId: inspection.po.id,
        grnId: inspection.delivery?.grns[0]?.id ?? null,
        inspectionId: inspection.id,
        reason,
        replacementRequired: input.replacementRequired ?? true,
        items: lines,
        rejectionIds: rejections.map((r) => r.id),
      },
      tx,
      // The authority to condemn the goods is what the SOP treats as the
      // authority to send them back. Named as grounds and re-verified, not
      // waved through.
      { cascade: `the failed inspection ${inspection.number}`, from: [P.RETURN_CREATE, P.INSPECTION_PERFORM] },
    );
  });
}
