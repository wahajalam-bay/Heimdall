import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { notify, createTask, completeTasks } from "@/lib/notify";
import { round2 } from "@/lib/format";
import { postMovement } from "./inventory";

/**
 * Physical stock counts.
 *
 * ZAM/PUR/SOP-01: "Internal auditor audits the store on monthly basis, to
 * monitor stock and inventory status." The system had no count of any kind, so
 * the ledger had never been checked against a shelf — and checking it against a
 * shelf is the only thing that establishes whether it is true.
 *
 * ## Three decisions worth stating
 *
 * **The expected quantity is frozen when the sheet is cut.** Counting takes
 * hours and stock keeps moving. Comparing a hand count taken at ten against a
 * balance read at four manufactures variances that are really just movements —
 * so every line carries the ledger figure as at the snapshot, and anything that
 * moves afterwards shows up as a movement rather than a discrepancy.
 *
 * **A variance is not an adjustment.** Finding a difference and correcting the
 * ledger are two acts, and the SOP puts the count with Internal Audit precisely
 * so they are two people. The count records what was found; the correction posts
 * through `postMovement` like every other stock change, with a reason, and only
 * after approval. A count that silently corrected the ledger would destroy the
 * evidence it exists to produce.
 *
 * **Zero is a count; blank is not.** A line counted as zero has been counted. A
 * line left blank has not. Collapsing the two would let an uncounted shelf read
 * as an empty one, which is the single most useful thing a count can catch.
 */

export const COUNT_TYPES = ["FULL", "CYCLE", "SPOT"] as const;
export type CountType = (typeof COUNT_TYPES)[number];

export const COUNT_STATUSES = [
  "DRAFT",
  "COUNTING",
  "REVIEW",
  "APPROVED",
  "ADJUSTED",
  "CLOSED",
  "CANCELLED",
] as const;
export type CountStatus = (typeof COUNT_STATUSES)[number];

/**
 * Opens a count sheet and freezes the ledger against it.
 *
 * The sheet is cut from the buckets that exist now. A bucket created after the
 * snapshot is not on the sheet, which is correct: it was not there to be
 * counted, and adding it later would mean counting stock that arrived during the
 * count.
 */
export async function openStockCount(
  user: SessionUser,
  input: {
    storeId: string;
    countType?: CountType;
    categoryId?: string | null;
    locationId?: string | null;
    scopeNote?: string | null;
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.INVENTORY_ADJUST, P.AUDIT_VIEW, P.STORE_ISSUE)) {
      throw new RuleViolationError("You do not have permission to open a stock count.");
    }
    const store = await tx.store.findUnique({
      where: { id: input.storeId },
      select: { id: true, name: true, entityId: true, active: true },
    });
    if (!store) throw new NotFoundError("Store");
    if (!store.active) throw new RuleViolationError(`${store.name} is not active.`);

    const open = await tx.stockCount.findFirst({
      where: { storeId: store.id, status: { in: ["DRAFT", "COUNTING", "REVIEW", "APPROVED"] } },
      select: { number: true, status: true },
    });
    if (open) {
      throw new RuleViolationError(
        `${open.number} is already open on ${store.name} (${open.status.toLowerCase()}). ` +
          "Two counts running on one store at once produce two sets of expected quantities, and neither can be trusted.",
      );
    }

    const buckets = await tx.inventoryItem.findMany({
      where: {
        storeId: store.id,
        ...(input.categoryId ? { item: { categoryId: input.categoryId } } : {}),
        ...(input.locationId ? { locationId: input.locationId } : {}),
      },
      include: { item: { select: { unit: true } } },
      orderBy: [{ itemId: "asc" }],
      take: 3000,
    });
    if (!buckets.length) {
      throw new RuleViolationError(
        `Nothing to count: ${store.name} holds no stock matching that scope.`,
      );
    }

    const snapshotAt = new Date();
    const count = await tx.stockCount.create({
      data: {
        number: await nextNumber(SEQ.STOCK_COUNT, tx),
        storeId: store.id,
        entityId: store.entityId,
        countType: input.countType ?? "CYCLE",
        status: "COUNTING",
        categoryId: input.categoryId ?? null,
        locationId: input.locationId ?? null,
        scopeNote: input.scopeNote?.trim() || null,
        snapshotAt,
        createdById: user.id,
        lines: {
          create: buckets.map((b, i) => ({
            lineNo: i + 1,
            itemId: b.itemId,
            inventoryItemId: b.id,
            batchNumber: b.batchNumber,
            serialNumber: b.serialNumber,
            locationId: b.locationId,
            unit: b.unit || b.item.unit,
            expectedQty: round2(b.quantity),
            expectedCost: round2(b.unitCost),
          })),
        },
      },
    });

    await writeAudit(
      {
        entityType: "StockCount",
        entityId: count.id,
        entityRef: count.number,
        action: "STOCK_COUNT_OPENED",
        newValue: {
          store: store.name,
          type: count.countType,
          lines: buckets.length,
          snapshotAt,
        },
        reason: input.scopeNote?.trim() ?? null,
        actor: user,
      },
      tx,
    );

    // The SOP puts the monthly store audit with Internal Audit, so they are told
    // a sheet is open rather than discovering it later.
    await createTask(
      {
        title: `Stock count open — ${count.number}`,
        description: `${store.name} · ${buckets.length} line(s) · ${count.countType.toLowerCase()} count`,
        taskType: "VERIFICATION",
        assignedRoleCode: "AUDIT_USER",
        entityId: store.entityId,
        documentType: "STOCK_COUNT",
        documentId: count.id,
        documentRef: count.number,
        linkUrl: `/inventory/counts/${count.id}`,
      },
      tx,
    );
    return count;
  });
}

/**
 * Records what was found on one or more lines.
 *
 * A line that differs needs a reason. Not because the counter necessarily knows
 * why, but because "found 8 where the ledger said 10" with nothing beside it is
 * a number nobody downstream can act on — and "no idea, recount requested" is
 * itself a useful answer.
 */
export async function recordCount(
  user: SessionUser,
  input: {
    countId: string;
    lines: Array<{ lineId: string; countedQty: number; reason?: string | null; notes?: string | null }>;
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.INVENTORY_ADJUST, P.AUDIT_VIEW, P.STORE_ISSUE)) {
      throw new RuleViolationError("You do not have permission to record a stock count.");
    }
    const count = await tx.stockCount.findUnique({
      where: { id: input.countId },
      include: { lines: true },
    });
    if (!count) throw new NotFoundError("Stock count");
    if (!["COUNTING", "DRAFT"].includes(count.status)) {
      throw new RuleViolationError(
        `${count.number} is ${count.status.toLowerCase()}. A count is recorded while it is being counted, not after it has been reviewed.`,
      );
    }

    const byId = new Map(count.lines.map((l) => [l.id, l]));
    for (const entry of input.lines) {
      const line = byId.get(entry.lineId);
      if (!line) throw new ValidationError("A counted line does not belong to this count.");
      if (!(entry.countedQty >= 0)) {
        throw new ValidationError(`Line ${line.lineNo}: a counted quantity cannot be negative.`);
      }

      const varianceQty = round2(entry.countedQty - line.expectedQty);
      if (Math.abs(varianceQty) > 1e-9 && !entry.reason?.trim()) {
        throw new ValidationError(
          `Line ${line.lineNo}: found ${entry.countedQty} where the ledger says ${line.expectedQty}. ` +
            "Say what you think happened — even 'unknown, recount requested' is an answer somebody can act on.",
        );
      }

      await tx.stockCountLine.update({
        where: { id: line.id },
        data: {
          countedQty: round2(entry.countedQty),
          varianceQty,
          varianceValue: round2(varianceQty * line.expectedCost),
          varianceReason: entry.reason?.trim() || null,
          notes: entry.notes?.trim() || null,
        },
      });
    }

    await tx.stockCount.update({
      where: { id: count.id },
      data: { countedById: user.id, countedAt: new Date(), status: "COUNTING" },
    });
    return tx.stockCount.findUnique({ where: { id: count.id } });
  });
}

/**
 * Submits the sheet for review.
 *
 * Refuses while a line is uncounted. A partially counted sheet reviewed as
 * though it were complete is how an uncounted shelf becomes a clean audit.
 */
export async function submitStockCount(
  user: SessionUser,
  countId: string,
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    const count = await tx.stockCount.findUnique({
      where: { id: countId },
      include: { lines: true, store: { select: { name: true, entityId: true } } },
    });
    if (!count) throw new NotFoundError("Stock count");
    if (count.status !== "COUNTING") {
      throw new RuleViolationError(`${count.number} is ${count.status.toLowerCase()}.`);
    }

    const uncounted = count.lines.filter((l) => l.countedQty === null);
    if (uncounted.length) {
      throw new RuleViolationError(
        `${count.number} has ${uncounted.length} line${uncounted.length === 1 ? "" : "s"} not yet counted ` +
          `(line${uncounted.length === 1 ? "" : "s"} ${uncounted.slice(0, 8).map((l) => l.lineNo).join(", ")}${uncounted.length > 8 ? "…" : ""}). ` +
          "Count them, or record zero where the shelf is empty — a blank line and an empty shelf are not the same thing.",
      );
    }

    const updated = await tx.stockCount.update({
      where: { id: count.id },
      data: { status: "REVIEW" },
    });

    const variances = count.lines.filter((l) => Math.abs(l.varianceQty ?? 0) > 1e-9);
    await notify(
      {
        roleCodes: ["AUDIT_USER", "WAREHOUSE_MANAGER", "STORE_MANAGER"],
        entityId: count.store.entityId,
        type: "GENERAL",
        priority: variances.length ? "HIGH" : "NORMAL",
        title: `${count.number} ready for review — ${variances.length} variance${variances.length === 1 ? "" : "s"}`,
        body: `${count.store.name} · ${count.lines.length} line(s) counted`,
        linkType: "STOCK_COUNT",
        linkId: count.id,
        linkUrl: `/inventory/counts/${count.id}`,
      },
      tx,
    );

    await writeAudit(
      {
        entityType: "StockCount",
        entityId: count.id,
        entityRef: count.number,
        action: "STOCK_COUNT_SUBMITTED",
        newValue: { lines: count.lines.length, variances: variances.length },
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/**
 * Internal Audit's review of the sheet.
 *
 * Refuses the person who counted it. The SOP puts the store audit with Internal
 * Audit precisely so the count and its review are two people; a storekeeper
 * reviewing their own count is the control doing nothing.
 */
export async function reviewStockCount(
  user: SessionUser,
  input: { countId: string; notes?: string | null },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.AUDIT_VIEW, P.INVENTORY_ADJUST)) {
      throw new RuleViolationError("Reviewing a stock count needs audit or inventory-adjustment authority.");
    }
    const count = await tx.stockCount.findUnique({ where: { id: input.countId } });
    if (!count) throw new NotFoundError("Stock count");
    if (count.status !== "REVIEW") {
      throw new RuleViolationError(`${count.number} is not awaiting review.`);
    }
    if (count.countedById === user.id) {
      throw new RuleViolationError(
        "You counted this sheet, so you cannot review it. ZAM/PUR/SOP-01 puts the monthly store audit with Internal Audit so the count and its review are two people.",
      );
    }

    const updated = await tx.stockCount.update({
      where: { id: count.id },
      data: {
        status: "APPROVED",
        reviewedById: user.id,
        reviewedAt: new Date(),
        reviewNotes: input.notes?.trim() || null,
        approvedById: user.id,
        approvedAt: new Date(),
      },
    });
    await completeTasks("STOCK_COUNT", count.id, user.id, tx);
    await writeAudit(
      {
        entityType: "StockCount",
        entityId: count.id,
        entityRef: count.number,
        action: "STOCK_COUNT_REVIEWED",
        newValue: { by: user.name },
        reason: input.notes?.trim() ?? null,
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/**
 * Posts the adjustments an approved count calls for.
 *
 * Through `postMovement`, so every correction lands in the same immutable ledger
 * as every other stock change and carries the count's number as its reason. The
 * count is not the adjustment; this is.
 *
 * Each line is posted once. A line that already has an adjustment is skipped
 * rather than posted twice, so re-running this after a partial failure corrects
 * the rest instead of doubling the ones that worked.
 */
export async function adjustFromCount(
  user: SessionUser,
  countId: string,
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.INVENTORY_ADJUST)) {
      throw new RuleViolationError("Correcting the ledger needs inventory-adjustment authority.");
    }
    const count = await tx.stockCount.findUnique({
      where: { id: countId },
      include: { lines: true, store: { select: { name: true, entityId: true } } },
    });
    if (!count) throw new NotFoundError("Stock count");
    if (!["APPROVED", "ADJUSTED"].includes(count.status)) {
      throw new RuleViolationError(
        `${count.number} must be reviewed and approved before the ledger is corrected from it.`,
      );
    }

    const toPost = count.lines.filter(
      (l) => Math.abs(l.varianceQty ?? 0) > 1e-9 && !l.adjustmentTxnId,
    );

    let posted = 0;
    for (const line of toPost) {
      const txn = await postMovement(
        "ADJUSTMENT",
        {
          itemId: line.itemId,
          storeId: count.storeId,
          quantity: line.varianceQty!,
          unit: line.unit,
          batchNumber: line.batchNumber,
          serialNumber: line.serialNumber,
          locationId: line.locationId,
          entityId: count.entityId,
          source: { kind: "ADJUSTMENT", id: count.id, ref: count.number },
          reason:
            `Stock count ${count.number} line ${line.lineNo}: counted ${line.countedQty}, ledger ${line.expectedQty}` +
            (line.varianceReason ? ` — ${line.varianceReason}` : ""),
          performedById: user.id,
        },
        tx,
        user,
        // The adjustment follows from an approved count, and the approval is
        // re-verified rather than assumed.
        { cascade: `approved stock count ${count.number}`, from: [P.INVENTORY_ADJUST] },
      );
      await tx.stockCountLine.update({
        where: { id: line.id },
        data: { adjustmentTxnId: txn.id },
      });
      posted += 1;
    }

    const remaining = count.lines.filter(
      (l) => Math.abs(l.varianceQty ?? 0) > 1e-9 && !l.adjustmentTxnId,
    ).length;

    const updated = await tx.stockCount.update({
      where: { id: count.id },
      data: {
        status: remaining - posted <= 0 ? "ADJUSTED" : "APPROVED",
        adjustedAt: new Date(),
      },
    });

    await writeAudit(
      {
        entityType: "StockCount",
        entityId: count.id,
        entityRef: count.number,
        action: "STOCK_COUNT_ADJUSTED",
        newValue: { movements: posted, store: count.store.name },
        actor: user,
      },
      tx,
    );
    return { count: updated, posted };
  });
}

/** Closes the sheet out. */
export async function closeStockCount(
  user: SessionUser,
  input: { countId: string; reason?: string | null; cancel?: boolean },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.INVENTORY_ADJUST, P.AUDIT_VIEW)) {
      throw new RuleViolationError("You do not have permission to close a stock count.");
    }
    const count = await tx.stockCount.findUnique({ where: { id: input.countId } });
    if (!count) throw new NotFoundError("Stock count");
    if (["CLOSED", "CANCELLED"].includes(count.status)) {
      throw new RuleViolationError(`${count.number} is already ${count.status.toLowerCase()}.`);
    }
    if (input.cancel && !input.reason?.trim()) {
      throw new ValidationError("State why the count is being cancelled.");
    }

    const updated = await tx.stockCount.update({
      where: { id: count.id },
      data: {
        status: input.cancel ? "CANCELLED" : "CLOSED",
        closedAt: new Date(),
      },
    });
    await completeTasks("STOCK_COUNT", count.id, user.id, tx);
    await writeAudit(
      {
        entityType: "StockCount",
        entityId: count.id,
        entityRef: count.number,
        action: input.cancel ? "STOCK_COUNT_CANCELLED" : "STOCK_COUNT_CLOSED",
        reason: input.reason?.trim() ?? null,
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

export async function listStockCounts(
  filter: { entityIds?: string[] | null; storeId?: string | null; status?: string | null } = {},
  db: DbClient = prisma,
) {
  const counts = await db.stockCount.findMany({
    where: {
      ...(filter.entityIds ? { entityId: { in: filter.entityIds } } : {}),
      ...(filter.storeId ? { storeId: filter.storeId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    include: {
      store: { select: { name: true } },
      createdBy: { select: { name: true } },
      countedBy: { select: { name: true } },
      reviewedBy: { select: { name: true } },
      _count: { select: { lines: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  if (!counts.length) return [];

  // Variance totals in one grouped read rather than one per sheet.
  const grouped = await db.stockCountLine.groupBy({
    by: ["countId"],
    where: { countId: { in: counts.map((c) => c.id) } },
    _sum: { varianceValue: true },
    _count: { _all: true },
  });
  const varianceBy = new Map(grouped.map((g) => [g.countId, g._sum.varianceValue ?? 0]));

  const withVariances = await db.stockCountLine.groupBy({
    by: ["countId"],
    where: {
      countId: { in: counts.map((c) => c.id) },
      OR: [{ varianceQty: { gt: 0 } }, { varianceQty: { lt: 0 } }],
    },
    _count: { _all: true },
  });
  const varianceLines = new Map(withVariances.map((g) => [g.countId, g._count._all]));

  return counts.map((c) => ({
    ...c,
    varianceValue: round2(varianceBy.get(c.id) ?? 0),
    varianceLines: varianceLines.get(c.id) ?? 0,
  }));
}

export async function stockCountDetail(id: string, db: DbClient = prisma) {
  return db.stockCount.findUnique({
    where: { id },
    include: {
      store: { select: { id: true, name: true, entityId: true } },
      createdBy: { select: { name: true, title: true } },
      countedBy: { select: { id: true, name: true, title: true } },
      reviewedBy: { select: { name: true, title: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          item: { select: { sku: true, name: true } },
        },
      },
    },
  });
}
