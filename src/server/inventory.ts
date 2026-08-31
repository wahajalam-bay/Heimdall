import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { RuleViolationError, NotFoundError } from "@/lib/errors";
import { writeAudit, type AuditActor } from "@/lib/audit";
import { round2 } from "@/lib/format";
import { PERMISSIONS as P } from "@/lib/permissions";
import { DOMAIN_ACTIONS, assertAuthority, type Actor, type Authority } from "@/lib/actor";

/**
 * Inventory ledger.
 *
 * Every balance change is an immutable `inventory_transactions` row plus an
 * updated `inventory` bucket — inventory can never move without a transaction,
 * and every transaction names its source document.
 */

export type MovementSource =
  | { kind: "GRN"; id: string; ref: string }
  | { kind: "ISSUE"; id: string; ref: string }
  | { kind: "TRANSFER"; id: string; ref: string }
  | { kind: "DISPOSAL"; id: string; ref: string }
  | { kind: "ADJUSTMENT"; id?: string; ref: string }
  | { kind: "PETTY_CASH"; id: string; ref: string };

export type MovementInput = {
  itemId: string;
  storeId: string;
  quantity: number;
  unit: string;
  unitCost?: number;
  batchNumber?: string | null;
  serialNumber?: string | null;
  expiryDate?: Date | null;
  warrantyMonths?: number | null;
  locationId?: string | null;
  projectId?: string | null;
  entityId?: string | null;
  source: MovementSource;
  reason?: string | null;
  performedById: string;
};

/** The ledger row a movement produces. */
export type InventoryTransactionRow = Awaited<ReturnType<DbClient["inventoryTransaction"]["create"]>>;

const INBOUND = new Set(["RECEIPT", "TRANSFER_IN", "RETURN"]);
const OUTBOUND = new Set(["ISSUE", "TRANSFER_OUT", "DISPOSAL"]);

/**
 * Which permission entitles an actor to move stock in each direction.
 *
 * Every stock write in the system funnels through `postMovement`, which made it
 * the single most valuable place to enforce and the one place that enforced
 * nothing. Callers that arrive as a consequence of an authorized operation
 * elsewhere — posting a receipt, issuing against a requisition, disposing of an
 * asset — name their grounds instead, and those are re-verified.
 */
export const MOVEMENT_AUTHORITY: Record<string, readonly string[]> = {
  RECEIPT: [P.GRN_POST, P.RECEIVE_GOODS, P.INVENTORY_ADJUST],
  ISSUE: [P.STORE_ISSUE],
  TRANSFER_OUT: [P.STORE_TRANSFER],
  TRANSFER_IN: [P.STORE_TRANSFER, P.RECEIVE_GOODS],
  ADJUSTMENT: [P.INVENTORY_ADJUST],
  RETURN: [P.RETURN_CREATE, P.RECEIVE_GOODS, P.INVENTORY_ADJUST],
  DISPOSAL: [P.DISPOSAL_APPROVE, P.DISPOSAL_MANAGEMENT_APPROVE],
};

export type MovementType =
  | "RECEIPT"
  | "ISSUE"
  | "TRANSFER_OUT"
  | "TRANSFER_IN"
  | "ADJUSTMENT"
  | "RETURN"
  | "DISPOSAL";

function bucketKey(i: MovementInput) {
  return { batchNumber: i.batchNumber ?? null, serialNumber: i.serialNumber ?? null };
}

/**
 * Consumes an unbatched outbound movement across the buckets that actually hold
 * the stock, earliest expiry first and otherwise in the order the buckets were
 * created. Returns null when a
 * plain bucket alone can satisfy the movement, so the ordinary single-bucket
 * path handles it and nothing changes for untracked items.
 */
async function allocateOutbound(
  type: MovementType,
  input: MovementInput,
  db: DbClient,
  actor: Actor,
  authority: Authority,
): Promise<InventoryTransactionRow | null> {
  const buckets = await db.inventoryItem.findMany({
    where: { itemId: input.itemId, storeId: input.storeId },
    orderBy: [{ expiryDate: "asc" }, { id: "asc" }],
  });
  const free = (b: { quantity: number; reservedQty: number }) => b.quantity - b.reservedQty;
  const plain = buckets.find((b) => b.batchNumber === null && b.serialNumber === null);
  const need = Math.abs(input.quantity);

  // Nothing tracked, or the plain bucket covers it: leave it to the normal path.
  const tracked = buckets.filter((b) => b.batchNumber !== null || b.serialNumber !== null);
  if (!tracked.length || (plain && free(plain) + 1e-9 >= need)) return null;

  const totalFree = round2(buckets.reduce((a, b) => a + Math.max(0, free(b)), 0));
  if (totalFree + 1e-9 < need) {
    const item = await db.item.findUnique({
      where: { id: input.itemId },
      select: { name: true, sku: true },
    });
    throw new RuleViolationError(
      `Insufficient stock for ${item?.sku ?? input.itemId} — available ${totalFree} ${input.unit}, requested ${round2(need)} ${input.unit}.`,
    );
  }

  // Draw down the plain bucket first, then each tracked bucket in turn. Every
  // draw is its own ledger transaction, so the batch each unit left is recorded.
  const order = [...(plain ? [plain] : []), ...tracked];
  let remaining = need;
  let last: InventoryTransactionRow | null = null;
  for (const bucket of order) {
    if (remaining <= 1e-9) break;
    const take = Math.min(Math.max(0, free(bucket)), remaining);
    if (take <= 1e-9) continue;
    last = await postMovement(
      type,
      {
        ...input,
        // The issue types carry their direction in the type; an adjustment
        // carries it in the sign, so the sign has to survive the split.
        quantity: type === "ADJUSTMENT" ? -round2(take) : round2(take),
        batchNumber: bucket.batchNumber,
        serialNumber: bucket.serialNumber,
        locationId: input.locationId ?? bucket.locationId,
      },
      db,
      actor,
      authority,
    );
    remaining = round2(remaining - take);
  }
  return last;
}

/**
 * Applies a stock movement. Outbound movements are refused when the bucket
 * holds insufficient free quantity — inventory can never go negative.
 */
export async function postMovement(
  type: MovementType,
  input: MovementInput,
  db: DbClient = prisma,
  actor: Actor,
  /**
   * Grounds, when this movement follows from an authorized operation in another
   * module. Omitted, the actor must hold the movement's own permission.
   */
  authority: Authority = { permission: MOVEMENT_AUTHORITY[type] ?? [] },
): Promise<InventoryTransactionRow> {
  // The authorization check stays outside the transaction: it must not be able
  // to hold a pool slot, and refusing is not a database operation.
  assertAuthority(actor, DOMAIN_ACTIONS.INVENTORY_MOVEMENT_POST, authority);
  if (input.quantity <= 0 && type !== "ADJUSTMENT") {
    throw new RuleViolationError("Movement quantity must be greater than zero.");
  }

  // A movement is a bucket update *and* a ledger row, and the two must not come
  // apart: a bucket without its transaction is stock that appeared from nowhere,
  // and a transaction without its bucket is a ledger that does not reconcile.
  // Callers that are already inside a transaction — posting a receipt, issuing
  // against a requisition — join theirs rather than opening a second one.
  return withTransaction(db, async (tx) => {
    const key = bucketKey(input);

    // Outbound with no batch or serial named: the caller wants "this quantity of
    // this item from this store" and does not care which receipt it came from.
    // Availability is reported across every bucket, so consumption has to work the
    // same way — otherwise batch-tracked stock could be seen but never issued.
    // A negative adjustment is outbound in every way that matters: it takes stock
    // off the shelf. Without this, goods found faulty after receipt could not be
    // adjusted out of batch-tracked stock at all without naming the exact batch —
    // which the person holding the broken item does not know.
    const outboundAdjustment = type === "ADJUSTMENT" && input.quantity < 0;
    if ((OUTBOUND.has(type) || outboundAdjustment) && key.batchNumber === null && key.serialNumber === null) {
      const allocated = await allocateOutbound(type, input, tx, actor, authority);
      if (allocated) return allocated;
    }

    const existing = await tx.inventoryItem.findFirst({
      where: {
        itemId: input.itemId,
        storeId: input.storeId,
        batchNumber: key.batchNumber,
        serialNumber: key.serialNumber,
      },
    });

    const signed =
      type === "ADJUSTMENT"
        ? input.quantity
        : INBOUND.has(type)
          ? Math.abs(input.quantity)
          : -Math.abs(input.quantity);

    const currentQty = existing?.quantity ?? 0;
    const reserved = existing?.reservedQty ?? 0;

    if (signed < 0) {
      const free = currentQty - reserved;
      if (free + signed < -1e-9) {
        const item = await tx.item.findUnique({ where: { id: input.itemId }, select: { name: true, sku: true } });
        throw new RuleViolationError(
          `Insufficient stock for ${item?.sku ?? input.itemId} — available ${round2(free)} ${input.unit}, requested ${round2(Math.abs(signed))} ${input.unit}.`,
        );
      }
    }

    const newQty = round2(currentQty + signed);
    // Weighted-average costing on inbound movements.
    const inCost = input.unitCost ?? existing?.unitCost ?? 0;
    let unitCost = existing?.unitCost ?? inCost;
    if (signed > 0 && input.unitCost !== undefined && input.unitCost > 0) {
      const prevValue = currentQty * (existing?.unitCost ?? 0);
      const addValue = signed * input.unitCost;
      unitCost = newQty > 0 ? round2((prevValue + addValue) / newQty) : input.unitCost;
    }

    const warrantyUntil =
      input.warrantyMonths && input.warrantyMonths > 0
        ? new Date(Date.now() + input.warrantyMonths * 30 * 86400000)
        : (existing?.warrantyUntil ?? null);

    if (existing) {
      await tx.inventoryItem.update({
        where: { id: existing.id },
        data: {
          quantity: newQty,
          unitCost,
          totalValue: round2(newQty * unitCost),
          unit: input.unit,
          locationId: input.locationId ?? existing.locationId,
          projectId: input.projectId ?? existing.projectId,
          expiryDate: input.expiryDate ?? existing.expiryDate,
          warrantyMonths: input.warrantyMonths ?? existing.warrantyMonths,
          warrantyUntil,
          entityId: input.entityId ?? existing.entityId,
          ...(input.source.kind === "GRN" ? { lastGrnId: input.source.id } : {}),
        },
      });
    } else {
      if (signed < 0) {
        throw new RuleViolationError("Cannot issue from a store where this item has no stock record.");
      }
      await tx.inventoryItem.create({
        data: {
          itemId: input.itemId,
          storeId: input.storeId,
          locationId: input.locationId ?? null,
          projectId: input.projectId ?? null,
          batchNumber: key.batchNumber,
          serialNumber: key.serialNumber,
          expiryDate: input.expiryDate ?? null,
          quantity: newQty,
          unit: input.unit,
          unitCost: inCost,
          totalValue: round2(newQty * inCost),
          warrantyMonths: input.warrantyMonths ?? null,
          warrantyUntil,
          entityId: input.entityId ?? null,
          ...(input.source.kind === "GRN" ? { lastGrnId: input.source.id } : {}),
        },
      });
      unitCost = inCost;
    }

    const number = await nextNumber(SEQ.INV_TXN, tx);
    const txn = await tx.inventoryTransaction.create({
      data: {
        number,
        itemId: input.itemId,
        storeId: input.storeId,
        type,
        quantity: round2(Math.abs(signed)) * (signed < 0 ? -1 : 1),
        unit: input.unit,
        unitCost,
        value: round2(Math.abs(signed) * unitCost),
        balanceAfter: newQty,
        batchNumber: key.batchNumber,
        serialNumber: key.serialNumber,
        sourceType: input.source.kind,
        sourceId: input.source.id ?? null,
        sourceRef: input.source.ref,
        grnId: input.source.kind === "GRN" ? input.source.id : null,
        issueId: input.source.kind === "ISSUE" ? input.source.id : null,
        transferId: input.source.kind === "TRANSFER" ? input.source.id : null,
        disposalId: input.source.kind === "DISPOSAL" ? input.source.id : null,
        pettyCashId: input.source.kind === "PETTY_CASH" ? input.source.id : null,
        reason: input.reason ?? null,
        performedById: input.performedById,
      },
    });

    await writeAudit(
      {
        entityType: "InventoryTransaction",
        entityId: txn.id,
        entityRef: txn.number,
        action: `INVENTORY_${type}`,
        newValue: {
          itemId: input.itemId,
          storeId: input.storeId,
          quantity: txn.quantity,
          balanceAfter: newQty,
          source: `${input.source.kind}:${input.source.ref}`,
        },
        reason: input.reason ?? null,
        actor: actor ?? null,
      },
      tx,
    );

    return txn;
  });
}

/**
 * The cost to move a unit out of a store. With a batch named it is that bucket's
 * cost; without one the stock may sit across several buckets, so it is the
 * quantity-weighted average of what is actually available — never zero merely
 * because no bucket matches a null batch.
 */
export async function stockUnitCost(
  itemId: string,
  storeId: string,
  batchNumber: string | null | undefined,
  db: DbClient = prisma,
): Promise<number> {
  if (batchNumber) {
    const exact = await db.inventoryItem.findFirst({ where: { itemId, storeId, batchNumber } });
    return round2(exact?.unitCost ?? 0);
  }
  const buckets = await db.inventoryItem.findMany({ where: { itemId, storeId } });
  const free = buckets.map((b) => ({ qty: Math.max(0, b.quantity - b.reservedQty), cost: b.unitCost }));
  const total = free.reduce((a, b) => a + b.qty, 0);
  if (total <= 0) {
    // No free stock to average over — fall back to the last known bucket cost.
    const last = buckets.find((b) => b.unitCost > 0);
    return round2(last?.unitCost ?? 0);
  }
  return round2(free.reduce((a, b) => a + b.qty * b.cost, 0) / total);
}

export async function availableQuantity(
  itemId: string,
  storeId: string,
  db: DbClient = prisma,
): Promise<number> {
  const rows = await db.inventoryItem.findMany({ where: { itemId, storeId } });
  return round2(rows.reduce((a, r) => a + (r.quantity - r.reservedQty), 0));
}

export type StockLine = {
  id: string;
  itemId: string;
  sku: string;
  itemName: string;
  categoryName: string;
  storeId: string;
  storeName: string;
  storeKind: string;
  locationLabel: string | null;
  batchNumber: string | null;
  serialNumber: string | null;
  expiryDate: Date | null;
  quantity: number;
  reservedQty: number;
  available: number;
  unit: string;
  unitCost: number;
  totalValue: number;
  projectName: string | null;
  warrantyUntil: Date | null;
  reorderLevel: number | null;
  belowReorder: boolean;
  expiringSoon: boolean;
};

export async function listStock(
  where: { storeIds?: string[]; itemId?: string; categoryId?: string; onlyPositive?: boolean },
  db: DbClient = prisma,
): Promise<StockLine[]> {
  const rows = await db.inventoryItem.findMany({
    where: {
      ...(where.storeIds ? { storeId: { in: where.storeIds } } : {}),
      ...(where.itemId ? { itemId: where.itemId } : {}),
      ...(where.categoryId ? { item: { categoryId: where.categoryId } } : {}),
      ...(where.onlyPositive ? { quantity: { gt: 0 } } : {}),
    },
    include: {
      item: { include: { category: { select: { name: true } } } },
      store: { select: { name: true, kind: true } },
      location: { select: { label: true } },
      project: { select: { name: true } },
    },
    orderBy: [{ item: { name: "asc" } }],
  });
  const soon = Date.now() + 60 * 86400000;
  return rows.map((r) => ({
    id: r.id,
    itemId: r.itemId,
    sku: r.item.sku,
    itemName: r.item.name,
    categoryName: r.item.category.name,
    storeId: r.storeId,
    storeName: r.store.name,
    storeKind: r.store.kind,
    locationLabel: r.location?.label ?? null,
    batchNumber: r.batchNumber,
    serialNumber: r.serialNumber,
    expiryDate: r.expiryDate,
    quantity: r.quantity,
    reservedQty: r.reservedQty,
    available: round2(r.quantity - r.reservedQty),
    unit: r.unit,
    unitCost: r.unitCost,
    totalValue: r.totalValue,
    projectName: r.project?.name ?? null,
    warrantyUntil: r.warrantyUntil,
    reorderLevel: r.item.reorderLevel,
    belowReorder: r.item.reorderLevel !== null && r.quantity < r.item.reorderLevel,
    expiringSoon: !!r.expiryDate && r.expiryDate.getTime() < soon,
  }));
}

export async function itemLedger(itemId: string, storeId?: string, db: DbClient = prisma) {
  return db.inventoryTransaction.findMany({
    where: { itemId, ...(storeId ? { storeId } : {}) },
    orderBy: { performedAt: "desc" },
    take: 200,
    include: { store: { select: { name: true, code: true } }, item: { select: { sku: true, name: true } } },
  });
}

export async function requireStore(storeId: string, db: DbClient = prisma) {
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store) throw new NotFoundError("Store");
  if (!store.active) throw new RuleViolationError(`Store ${store.name} is inactive.`);
  return store;
}
