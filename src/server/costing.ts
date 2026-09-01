import { prisma, type DbClient } from "@/lib/db";
import { CONFIG_KEYS, getConfigBundle, registerConfigInvalidator } from "@/lib/config";
import { round2 } from "@/lib/format";

/**
 * FIFO cost layers.
 *
 * The inventory bucket holds one weighted-average `unitCost`. That answers "what
 * is this stock worth on average" and cannot answer "what did the units we just
 * issued actually cost". Ten at 100 then ten at 120 averages to 110, so an issue
 * of twelve is carried at 1,320 — where FIFO says 10x100 + 2x120 = 1,240. Eighty
 * rupees of that difference lands in cost of sales, and it compounds every time
 * prices move.
 *
 * ## FIFO is not FEFO
 *
 * They are separate questions and the system must not conflate them:
 *
 *   · **FEFO** — which physical carton leaves the shelf. Earliest expiry first,
 *     because issuing cheap stock while the short-dated stock rots is a worse
 *     outcome than a costing discrepancy. `allocateOutbound` keeps doing this.
 *   · **FIFO** — what that carton is carried at. Oldest receipt first.
 *
 * They can legitimately disagree: a carton picked for expiry may be valued
 * against an older, cheaper layer. That is correct, and it is why the
 * consumption rows exist — so the disagreement is visible rather than hidden
 * behind an averaged number.
 *
 * ## Not restating history
 *
 * Layers begin on a stated date. Nothing before it is rewritten: those movements
 * carry the weighted-average figure they were posted with and their `fifoValue`
 * stays null, which reads as "not computed" rather than as zero. Opening
 * balances at the cutover are not invented either — an issue after the cutover
 * that finds no layer is reported as uncovered rather than silently valued at
 * nothing.
 */

export const COSTING_METHODS = ["WEIGHTED_AVERAGE", "FIFO"] as const;
export type CostingMethod = (typeof COSTING_METHODS)[number];

export type LayerKey = {
  itemId: string;
  storeId: string;
  batchNumber?: string | null;
  serialNumber?: string | null;
};

export type CostingPolicy = {
  method: CostingMethod;
  /** The date layers begin. Null means not started, and nothing is layered. */
  from: Date | null;
  /** True when a movement on this date should be layered at all. */
  active: boolean;
};

/**
 * Both costing settings in one read.
 *
 * `postMovement` runs inside a transaction that already issues around forty
 * statements against a database a second away, so two separate config lookups
 * per movement is not a rounding error — it is two more round trips holding a
 * pooled connection open. One query answers both.
 */
/**
 * A short in-process memo on the two settings.
 *
 * `postMovement` calls this once per movement, and a purchase order that posts
 * twenty lines is twenty extra round trips inside a transaction that already
 * holds a pooled connection open. These two values change by hand, perhaps
 * twice in the system's life; reading them afresh for every line is not caution,
 * it is latency. Short enough that a change takes effect while somebody is still
 * looking at the screen they changed it on.
 */
const POLICY_TTL_MS = 30_000;
const policyMemo = new Map<string, { at: number; value: Omit<CostingPolicy, "active"> }>();

export function clearCostingPolicyCache() {
  policyMemo.clear();
}

// A change on the Business rules screen takes effect on the next movement, not
// when the memo happens to expire.
registerConfigInvalidator(clearCostingPolicyCache);

export async function costingPolicy(
  entityId: string | null | undefined,
  at: Date = new Date(),
  db: DbClient = prisma,
): Promise<CostingPolicy> {
  const key = entityId ?? "__global__";
  const held = policyMemo.get(key);
  if (held && Date.now() - held.at < POLICY_TTL_MS) {
    const { method, from } = held.value;
    return { method, from, active: from !== null && at.getTime() >= from.getTime() };
  }

  const bundle = await getConfigBundle(
    [CONFIG_KEYS.COSTING_METHOD, CONFIG_KEYS.COST_LAYERS_FROM],
    entityId ?? null,
    db,
  );
  const rawMethod = String(bundle[CONFIG_KEYS.COSTING_METHOD] ?? "");
  const method: CostingMethod = COSTING_METHODS.includes(rawMethod as CostingMethod)
    ? (rawMethod as CostingMethod)
    : "WEIGHTED_AVERAGE";

  const rawFrom = bundle[CONFIG_KEYS.COST_LAYERS_FROM];
  let from: Date | null = null;
  if (typeof rawFrom === "string" && rawFrom.trim()) {
    const d = new Date(rawFrom.trim());
    if (!Number.isNaN(d.getTime())) from = d;
  }

  policyMemo.set(key, { at: Date.now(), value: { method, from } });
  return { method, from, active: from !== null && at.getTime() >= from.getTime() };
}

/**
 * Opens a layer for an inbound movement.
 *
 * A receipt with no price is not a layer. Valuing it at zero would let the next
 * issue draw free stock and quietly understate cost of sales, which is exactly
 * the failure this module exists to prevent — so it is skipped, and the movement
 * keeps its weighted-average treatment.
 */
export async function openLayer(
  key: LayerKey,
  input: {
    quantity: number;
    unitCost: number;
    receivedAt?: Date;
    sourceType: string;
    sourceId?: string | null;
    sourceRef?: string | null;
    transactionId?: string | null;
    grnId?: string | null;
    entityId?: string | null;
  },
  db: DbClient = prisma,
) {
  if (input.quantity <= 0 || !(input.unitCost > 0)) return null;

  const receivedAt = input.receivedAt ?? new Date();
  // Receipts landing in the same instant still need a stable order, or FIFO is
  // whatever the database felt like returning.
  const last = await db.costLayer.findFirst({
    where: { itemId: key.itemId, storeId: key.storeId },
    orderBy: [{ receivedAt: "desc" }, { sequence: "desc" }],
    select: { sequence: true },
  });

  return db.costLayer.create({
    data: {
      itemId: key.itemId,
      storeId: key.storeId,
      batchNumber: key.batchNumber ?? null,
      serialNumber: key.serialNumber ?? null,
      unitCost: round2(input.unitCost),
      quantityReceived: round2(input.quantity),
      quantityRemaining: round2(input.quantity),
      receivedAt,
      sequence: (last?.sequence ?? 0) + 1,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      sourceRef: input.sourceRef ?? null,
      transactionId: input.transactionId ?? null,
      grnId: input.grnId ?? null,
      entityId: input.entityId ?? null,
    },
  });
}

export type Consumption = {
  layerId: string;
  quantity: number;
  unitCost: number;
  value: number;
};

export type ConsumeResult = {
  consumptions: Consumption[];
  /** Quantity the layers covered. */
  covered: number;
  /** Quantity no layer could account for — pre-cutover stock, usually. */
  uncovered: number;
  /** Total FIFO cost of the covered part. */
  value: number;
  /** Weighted FIFO unit cost across the covered part, or null when none was. */
  unitCost: number | null;
};

/**
 * Draws a quantity from the oldest layers first.
 *
 * Returns what it could cover and what it could not, separately. A shortfall is
 * not an error here — stock received before the cutover has no layer and never
 * will — but it must never be passed off as covered at zero cost, so the caller
 * gets both numbers and decides.
 *
 * `dryRun` computes the same answer without writing, which is what a valuation
 * report wants.
 */
export async function consumeLayers(
  key: LayerKey,
  quantity: number,
  opts: { transactionId?: string | null; dryRun?: boolean; consumedAt?: Date } = {},
  db: DbClient = prisma,
): Promise<ConsumeResult> {
  const need = round2(Math.abs(quantity));
  const empty: ConsumeResult = {
    consumptions: [],
    covered: 0,
    uncovered: need,
    value: 0,
    unitCost: null,
  };
  if (need <= 0) return { ...empty, uncovered: 0 };

  const layers = await db.costLayer.findMany({
    where: {
      itemId: key.itemId,
      storeId: key.storeId,
      batchNumber: key.batchNumber ?? null,
      serialNumber: key.serialNumber ?? null,
      quantityRemaining: { gt: 0 },
    },
    orderBy: [{ receivedAt: "asc" }, { sequence: "asc" }],
  });
  if (!layers.length) return empty;

  const consumptions: Consumption[] = [];
  let remaining = need;
  let value = 0;

  for (const layer of layers) {
    if (remaining <= 1e-9) break;
    const take = Math.min(layer.quantityRemaining, remaining);
    if (take <= 1e-9) continue;
    const lineValue = round2(take * layer.unitCost);
    consumptions.push({
      layerId: layer.id,
      quantity: round2(take),
      unitCost: layer.unitCost,
      value: lineValue,
    });
    value = round2(value + lineValue);
    remaining = round2(remaining - take);
  }

  const covered = round2(need - remaining);

  if (!opts.dryRun && consumptions.length) {
    const consumedAt = opts.consumedAt ?? new Date();
    for (const c of consumptions) {
      const layer = layers.find((l) => l.id === c.layerId)!;
      const left = round2(layer.quantityRemaining - c.quantity);
      await db.costLayer.update({
        where: { id: c.layerId },
        data: {
          quantityRemaining: left,
          closedAt: left <= 1e-9 ? consumedAt : null,
        },
      });
      if (opts.transactionId) {
        await db.costLayerConsumption.create({
          data: {
            layerId: c.layerId,
            transactionId: opts.transactionId,
            quantity: c.quantity,
            unitCost: c.unitCost,
            value: c.value,
            consumedAt,
          },
        });
      }
    }
  }

  return {
    consumptions,
    covered,
    uncovered: round2(remaining),
    value,
    unitCost: covered > 0 ? round2(value / covered) : null,
  };
}

/**
 * Puts a quantity back on the layers it came from.
 *
 * A return or a reversed issue should restore the original cost, not open a new
 * layer at today's price — otherwise returning goods quietly revalues them.
 */
export async function returnToLayers(
  transactionId: string,
  quantity: number,
  db: DbClient = prisma,
): Promise<number> {
  const rows = await db.costLayerConsumption.findMany({
    where: { transactionId },
    include: { layer: { select: { id: true, receivedAt: true, sequence: true, quantityRemaining: true } } },
  });
  if (!rows.length) return 0;

  // Newest layer back first, so a partial return undoes the last draw. Ordering
  // by `consumedAt` looks equivalent and is not: every consumption from one
  // movement carries the same timestamp, so the database is free to hand them
  // back in any order and a partial return would restore an arbitrary layer.
  // The layer's own FIFO position is the only deterministic key here.
  rows.sort((a, b) => {
    const d = b.layer.receivedAt.getTime() - a.layer.receivedAt.getTime();
    return d !== 0 ? d : b.layer.sequence - a.layer.sequence;
  });

  let remaining = round2(Math.abs(quantity));
  let restored = 0;
  for (const row of rows) {
    if (remaining <= 1e-9) break;
    const give = Math.min(row.quantity, remaining);
    if (give <= 1e-9) continue;
    await db.costLayer.update({
      where: { id: row.layer.id },
      data: { quantityRemaining: round2(row.layer.quantityRemaining + give), closedAt: null },
    });
    restored = round2(restored + give * row.unitCost);
    remaining = round2(remaining - give);
  }
  return restored;
}

/**
 * What one bucket's remaining layers are worth.
 *
 * Under FIFO the bucket has to reconcile to its layers, or the balance sheet and
 * the cost ledger drift apart a little on every movement until nobody can say
 * which is right. One aggregate, and only on the FIFO path.
 */
export async function layerBalance(
  key: LayerKey,
  db: DbClient = prisma,
): Promise<{ quantity: number; value: number; unitCost: number | null }> {
  const rows = await db.costLayer.findMany({
    where: {
      itemId: key.itemId,
      storeId: key.storeId,
      batchNumber: key.batchNumber ?? null,
      serialNumber: key.serialNumber ?? null,
      quantityRemaining: { gt: 0 },
    },
    select: { quantityRemaining: true, unitCost: true },
  });
  let quantity = 0;
  let value = 0;
  for (const r of rows) {
    quantity = round2(quantity + r.quantityRemaining);
    value = round2(value + r.quantityRemaining * r.unitCost);
  }
  return { quantity, value, unitCost: quantity > 0 ? round2(value / quantity) : null };
}

/** Layers still holding stock, oldest first. The basis for a FIFO valuation. */
export async function openLayers(
  filter: { itemId?: string; storeId?: string; entityIds?: string[] | null } = {},
  db: DbClient = prisma,
) {
  return db.costLayer.findMany({
    where: {
      quantityRemaining: { gt: 0 },
      ...(filter.itemId ? { itemId: filter.itemId } : {}),
      ...(filter.storeId ? { storeId: filter.storeId } : {}),
      ...(filter.entityIds
        ? { OR: [{ entityId: { in: filter.entityIds } }, { entityId: null }] }
        : {}),
    },
    include: {
      item: { select: { sku: true, name: true, unit: true } },
      store: { select: { name: true } },
    },
    orderBy: [{ receivedAt: "asc" }, { sequence: "asc" }],
    take: 4000,
  });
}

/**
 * What one outbound movement drew from where.
 *
 * The audit trail behind a FIFO figure. Without these rows the number is an
 * assertion; with them somebody can check it against the receipts.
 */
export async function consumptionsFor(transactionId: string, db: DbClient = prisma) {
  return db.costLayerConsumption.findMany({
    where: { transactionId },
    include: {
      layer: {
        select: {
          receivedAt: true,
          sourceRef: true,
          sourceType: true,
          grnId: true,
          batchNumber: true,
          quantityReceived: true,
        },
      },
    },
    orderBy: { consumedAt: "asc" },
  });
}

/**
 * FIFO against weighted average, per item and store, for the stock on hand.
 *
 * The point of the report is the gap. Where the two agree, prices have not moved
 * and the costing method does not matter; where they diverge, somebody is
 * carrying stock at a number that is not what it cost.
 */
export type ValuationRow = {
  itemId: string;
  storeId: string;
  sku: string;
  name: string;
  storeName: string;
  unit: string;
  layeredQty: number;
  fifoValue: number;
  bucketQty: number;
  averageValue: number;
  /** Positive means FIFO carries it higher than the average does. */
  difference: number;
  /** Stock with no layer behind it — pre-cutover, or received with no price. */
  unlayeredQty: number;
};

export async function fifoValuation(
  filter: { storeId?: string | null; entityIds?: string[] | null } = {},
  db: DbClient = prisma,
): Promise<ValuationRow[]> {
  const [layers, buckets] = await Promise.all([
    db.costLayer.findMany({
      where: {
        quantityRemaining: { gt: 0 },
        ...(filter.storeId ? { storeId: filter.storeId } : {}),
        ...(filter.entityIds
          ? { OR: [{ entityId: { in: filter.entityIds } }, { entityId: null }] }
          : {}),
      },
      select: { itemId: true, storeId: true, quantityRemaining: true, unitCost: true },
    }),
    db.inventoryItem.findMany({
      where: {
        quantity: { gt: 0 },
        ...(filter.storeId ? { storeId: filter.storeId } : {}),
        ...(filter.entityIds
          ? { OR: [{ entityId: { in: filter.entityIds } }, { entityId: null }] }
          : {}),
      },
      include: {
        item: { select: { sku: true, name: true } },
        store: { select: { name: true } },
      },
      take: 4000,
    }),
  ]);

  const k = (i: string, s: string) => `${i}|${s}`;
  const layered = new Map<string, { qty: number; value: number }>();
  for (const l of layers) {
    const slot = layered.get(k(l.itemId, l.storeId)) ?? { qty: 0, value: 0 };
    slot.qty = round2(slot.qty + l.quantityRemaining);
    slot.value = round2(slot.value + l.quantityRemaining * l.unitCost);
    layered.set(k(l.itemId, l.storeId), slot);
  }

  const rolled = new Map<string, ValuationRow>();
  for (const b of buckets) {
    const key = k(b.itemId, b.storeId);
    const row: ValuationRow = rolled.get(key) ?? {
      itemId: b.itemId,
      storeId: b.storeId,
      sku: b.item.sku,
      name: b.item.name,
      storeName: b.store.name,
      unit: b.unit,
      layeredQty: layered.get(key)?.qty ?? 0,
      fifoValue: layered.get(key)?.value ?? 0,
      bucketQty: 0,
      averageValue: 0,
      difference: 0,
      unlayeredQty: 0,
    };
    row.bucketQty = round2(row.bucketQty + b.quantity);
    row.averageValue = round2(row.averageValue + b.quantity * b.unitCost);
    rolled.set(key, row);
  }

  const rows = [...rolled.values()].map((r) => ({
    ...r,
    unlayeredQty: round2(Math.max(0, r.bucketQty - r.layeredQty)),
    difference: round2(r.fifoValue - r.averageValue),
  }));

  // Biggest disagreement first — that is what the report is for.
  rows.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
  return rows;
}
