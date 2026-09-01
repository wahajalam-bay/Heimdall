import { prisma, type DbClient } from "@/lib/db";
import { CONFIG_KEYS, getConfigBundle } from "@/lib/config";
import { RuleViolationError, ValidationError, NotFoundError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { round2 } from "@/lib/format";

/**
 * Minimum stock, and what happens when it is reached.
 *
 * ZAM/PUR/SOP-01 §3.3 makes Manager Logistics responsible for maintaining the
 * stock list "with specifications and minimum stock level **defined on the basis
 * of past history (consumption) or on advice of concerned departmental POCs**".
 * The Store Flow then says what the minimum is for: when it is reached, the
 * Store Manager "alerts the relevant procurement associate and a PR/PO is
 * issued".
 *
 * The system had the number and neither half of the sentence. `reorderLevel` was
 * a figure somebody typed with no record of where it came from, and reaching it
 * coloured a row on a screen nobody was obliged to open.
 *
 * So two things:
 *
 *   · **A basis.** The minimum records which of the SOP's two grounds it rests
 *     on. A number nobody can attribute is a number nobody defends when the
 *     store runs out, and the two grounds are not interchangeable — consumption
 *     is evidence, POC advice is judgement, and a reviewer is entitled to know
 *     which one they are looking at.
 *   · **A consumption figure to set it from.** Issues are already in the ledger.
 *     Averaging them over a window and multiplying by the replenishment lead
 *     time is arithmetic the system can do, so nobody has to guess.
 *
 * What it deliberately does not do is raise the requisition by itself. The SOP
 * says a PR is issued; it does not say the system issues it, and a purchase
 * requisition that nobody chose to raise is a commitment nobody owns. The queue
 * names what has fallen short and how much to order; a person raises it.
 */

export const MIN_STOCK_BASES = ["MANUAL", "CONSUMPTION", "POC_ADVICE"] as const;
export type MinStockBasis = (typeof MIN_STOCK_BASES)[number];

export const MIN_STOCK_BASIS_LABELS: Record<MinStockBasis, string> = {
  MANUAL: "Set by hand",
  CONSUMPTION: "Derived from consumption history",
  POC_ADVICE: "On the advice of the department POC",
};

export type ConsumptionStat = {
  itemId: string;
  /** Total issued in the window. */
  issued: number;
  /** Days the window actually covers. */
  days: number;
  perDay: number;
  perMonth: number;
  /** How many separate issues — one big issue is not a consumption pattern. */
  movements: number;
  /** The earliest issue seen, so a short history is visible as such. */
  firstIssueAt: Date | null;
};

/**
 * What has actually left the store, per item, over a window.
 *
 * Issues and disposals both take stock off the shelf, but only issues are
 * demand: writing off expired stock says nothing about how much anybody needs.
 * Transfers out are excluded for the same reason — the goods moved, they were
 * not consumed.
 */
export async function consumption(
  filter: { itemIds?: string[]; storeId?: string | null; days?: number } = {},
  db: DbClient = prisma,
): Promise<Map<string, ConsumptionStat>> {
  const days = filter.days ?? 180;
  const since = new Date(Date.now() - days * 86400000);

  const rows = await db.inventoryTransaction.findMany({
    where: {
      type: "ISSUE",
      performedAt: { gte: since },
      ...(filter.itemIds?.length ? { itemId: { in: filter.itemIds } } : {}),
      ...(filter.storeId ? { storeId: filter.storeId } : {}),
    },
    select: { itemId: true, quantity: true, performedAt: true },
  });

  const out = new Map<string, ConsumptionStat>();
  for (const r of rows) {
    const slot =
      out.get(r.itemId) ??
      ({
        itemId: r.itemId,
        issued: 0,
        days,
        perDay: 0,
        perMonth: 0,
        movements: 0,
        firstIssueAt: null,
      } satisfies ConsumptionStat);
    slot.issued = round2(slot.issued + Math.abs(r.quantity));
    slot.movements += 1;
    if (!slot.firstIssueAt || r.performedAt < slot.firstIssueAt) slot.firstIssueAt = r.performedAt;
    out.set(r.itemId, slot);
  }

  for (const slot of out.values()) {
    // Rate over the window asked for, not over the span of the issues seen.
    // Dividing by the observed span would report an item issued twice in one
    // week as consuming that much every week forever.
    slot.perDay = round2(slot.issued / days);
    slot.perMonth = round2(slot.perDay * 30);
  }
  return out;
}

export type MinStockSuggestion = {
  itemId: string;
  suggested: number | null;
  perDay: number;
  leadTimeDays: number;
  safetyDays: number;
  movements: number;
  /** Why no figure could be suggested, when none could. */
  withheld: string | null;
};

/**
 * A minimum stock level derived from what the store actually issues.
 *
 * `lead time + safety` days of average consumption. Deliberately arithmetic
 * rather than a forecast: the SOP asks for a level based on past history, and a
 * number a storekeeper can reproduce on paper is one they will trust.
 *
 * It withholds a figure rather than inventing one. An item issued once has no
 * consumption pattern, and a suggestion drawn from a single movement would look
 * exactly as authoritative as one drawn from a year of them.
 */
export async function suggestMinimums(
  itemIds: string[],
  opts: { entityId?: string | null; storeId?: string | null } = {},
  db: DbClient = prisma,
): Promise<Map<string, MinStockSuggestion>> {
  const cfg = await getConfigBundle(
    [
      CONFIG_KEYS.MIN_STOCK_WINDOW_DAYS,
      CONFIG_KEYS.MIN_STOCK_LEAD_DAYS,
      CONFIG_KEYS.MIN_STOCK_SAFETY_DAYS,
      CONFIG_KEYS.MIN_STOCK_MIN_MOVEMENTS,
    ],
    opts.entityId ?? null,
    db,
  );
  const num = (k: string, d: number) => {
    const n = Number(cfg[k]);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const windowDays = num(CONFIG_KEYS.MIN_STOCK_WINDOW_DAYS, 180);
  const leadTimeDays = num(CONFIG_KEYS.MIN_STOCK_LEAD_DAYS, 14);
  const safetyDays = num(CONFIG_KEYS.MIN_STOCK_SAFETY_DAYS, 7);
  const minMovements = num(CONFIG_KEYS.MIN_STOCK_MIN_MOVEMENTS, 3);

  const stats = await consumption({ itemIds, storeId: opts.storeId, days: windowDays }, db);
  const out = new Map<string, MinStockSuggestion>();

  for (const itemId of itemIds) {
    const s = stats.get(itemId);
    const base: MinStockSuggestion = {
      itemId,
      suggested: null,
      perDay: s?.perDay ?? 0,
      leadTimeDays,
      safetyDays,
      movements: s?.movements ?? 0,
      withheld: null,
    };
    if (!s || s.movements === 0) {
      out.set(itemId, { ...base, withheld: `No issues in the last ${windowDays} days.` });
      continue;
    }
    if (s.movements < minMovements) {
      out.set(itemId, {
        ...base,
        withheld: `Only ${s.movements} issue${s.movements === 1 ? "" : "s"} in ${windowDays} days — too few to call it a pattern.`,
      });
      continue;
    }
    out.set(itemId, { ...base, suggested: round2(s.perDay * (leadTimeDays + safetyDays)) });
  }
  return out;
}

/**
 * Records a minimum stock level and the ground it rests on.
 *
 * The note is required for POC advice and optional otherwise: consumption cites
 * the ledger, and a hand-set figure at least says a person chose it, but "the
 * POC said so" without saying which POC or when is not advice, it is hearsay.
 */
export async function setMinimumStock(
  user: SessionUser,
  input: { itemId: string; level: number | null; basis: MinStockBasis; note?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.MASTER_MANAGE, P.MASTER_DATA_MANAGE, P.INVENTORY_ADJUST)) {
    throw new RuleViolationError("You do not have permission to set minimum stock levels.");
  }
  if (!MIN_STOCK_BASES.includes(input.basis)) {
    throw new ValidationError("Say what the minimum is based on: consumption history, POC advice, or a manual figure.");
  }
  if (input.level !== null && !(input.level >= 0)) {
    throw new ValidationError("A minimum stock level cannot be negative.");
  }
  if (input.basis === "POC_ADVICE" && !input.note?.trim()) {
    throw new ValidationError(
      "Name the POC and what they advised. ZAM/PUR/SOP-01 §3.3 allows a minimum set on a POC's advice; an unattributed one is not advice.",
    );
  }

  const item = await db.item.findUnique({ where: { id: input.itemId }, select: { id: true, sku: true, name: true, reorderLevel: true } });
  if (!item) throw new NotFoundError("Item");

  const updated = await db.item.update({
    where: { id: input.itemId },
    data: {
      reorderLevel: input.level,
      minStockBasis: input.basis,
      minStockBasisNote: input.note?.trim() || null,
      minStockSetAt: new Date(),
      minStockSetById: user.id,
    },
  });

  await writeAudit(
    {
      entityType: "Item",
      entityId: item.id,
      entityRef: item.sku,
      action: "MIN_STOCK_SET",
      oldValue: { reorderLevel: item.reorderLevel },
      newValue: { reorderLevel: input.level, basis: input.basis },
      reason: input.note?.trim() || null,
      actor: user,
    },
    db,
  );
  return updated;
}

export type ReplenishmentRow = {
  itemId: string;
  sku: string;
  name: string;
  unit: string;
  categoryName: string | null;
  storeId: string;
  storeName: string;
  onHand: number;
  reserved: number;
  available: number;
  minimum: number;
  basis: MinStockBasis | null;
  basisNote: string | null;
  /** How much to order to come back up to the minimum plus the lead-time cover. */
  suggestedOrderQty: number;
  perMonth: number;
  /** True when the shelf is empty, not merely low. */
  outOfStock: boolean;
  lastIssuedAt: Date | null;
};

/**
 * What has reached its minimum and by how much.
 *
 * Availability, not the raw balance: stock already reserved against an approved
 * requisition is spoken for, and counting it as cover is how a store reports
 * itself healthy right up to the moment somebody collects.
 */
export async function replenishmentQueue(
  filter: { entityIds?: string[] | null; storeId?: string | null } = {},
  db: DbClient = prisma,
): Promise<ReplenishmentRow[]> {
  const buckets = await db.inventoryItem.findMany({
    where: {
      ...(filter.storeId ? { storeId: filter.storeId } : {}),
      ...(filter.entityIds
        ? { OR: [{ entityId: { in: filter.entityIds } }, { entityId: null }] }
        : {}),
      item: { reorderLevel: { not: null }, active: true },
    },
    include: {
      item: {
        select: {
          sku: true,
          name: true,
          unit: true,
          reorderLevel: true,
          minStockBasis: true,
          minStockBasisNote: true,
          category: { select: { name: true } },
        },
      },
      store: { select: { name: true } },
    },
    take: 4000,
  });
  if (!buckets.length) return [];

  // Roll the buckets up per item and store first — a batch-tracked item sits in
  // several buckets, and each one on its own is always below the minimum.
  const rolled = new Map<string, ReplenishmentRow>();
  for (const b of buckets) {
    const key = `${b.itemId}|${b.storeId}`;
    const row =
      rolled.get(key) ??
      ({
        itemId: b.itemId,
        sku: b.item.sku,
        name: b.item.name,
        unit: b.item.unit,
        categoryName: b.item.category?.name ?? null,
        storeId: b.storeId,
        storeName: b.store.name,
        onHand: 0,
        reserved: 0,
        available: 0,
        minimum: b.item.reorderLevel ?? 0,
        basis: (b.item.minStockBasis as MinStockBasis | null) ?? null,
        basisNote: b.item.minStockBasisNote,
        suggestedOrderQty: 0,
        perMonth: 0,
        outOfStock: false,
        lastIssuedAt: null,
      } satisfies ReplenishmentRow);
    row.onHand = round2(row.onHand + b.quantity);
    row.reserved = round2(row.reserved + b.reservedQty);
    rolled.set(key, row);
  }

  const short = [...rolled.values()]
    .map((r) => ({ ...r, available: round2(r.onHand - r.reserved) }))
    .filter((r) => r.minimum > 0 && r.available <= r.minimum + 1e-9);
  if (!short.length) return [];

  const stats = await consumption({ itemIds: [...new Set(short.map((r) => r.itemId))] }, db);

  const rows = short.map((r) => {
    const s = stats.get(r.itemId);
    return {
      ...r,
      perMonth: s?.perMonth ?? 0,
      // Back up to the minimum, plus a month of cover where consumption says
      // what a month is. Without that history the shortfall alone is the honest
      // answer — padding it with a number nobody measured is a guess wearing a
      // recommendation's clothes.
      suggestedOrderQty: round2(Math.max(0, r.minimum - r.available) + (s?.perMonth ?? 0)),
      outOfStock: r.available <= 1e-9,
      lastIssuedAt: null,
    };
  });

  // Empty shelves first, then the deepest shortfall.
  rows.sort((a, b) => {
    if (a.outOfStock !== b.outOfStock) return a.outOfStock ? -1 : 1;
    return b.minimum - b.available - (a.minimum - a.available);
  });
  return rows;
}

/**
 * Raises the alert the Store Flow requires when a minimum is reached.
 *
 * Returns the number of people told, so a caller can record that the alert
 * happened rather than assuming it did.
 *
 * Called after the movement has committed, never inside it. An alert is not
 * worth rolling back an issue for, and a notification sent inside a transaction
 * that later aborts is a message about something that did not happen.
 */
export async function alertBelowMinimum(
  itemId: string,
  storeId: string,
  opts: { entityId?: string | null; triggeredBy?: string } = {},
  db: DbClient = prisma,
): Promise<number> {
  const [item, buckets, store] = await Promise.all([
    db.item.findUnique({
      where: { id: itemId },
      select: { sku: true, name: true, unit: true, reorderLevel: true, active: true },
    }),
    db.inventoryItem.findMany({
      where: { itemId, storeId },
      select: { quantity: true, reservedQty: true },
    }),
    db.store.findUnique({ where: { id: storeId }, select: { name: true, entityId: true } }),
  ]);
  if (!item?.active || item.reorderLevel === null || !store) return 0;

  const available = round2(
    buckets.reduce((a, b) => a + b.quantity - b.reservedQty, 0),
  );
  if (available > item.reorderLevel + 1e-9) return 0;

  const empty = available <= 1e-9;
  return notify(
    {
      roleCodes: ["PROCUREMENT_OFFICER", "PROCUREMENT_SENIOR_MANAGER", "STORE_MANAGER", "WAREHOUSE_MANAGER"],
      entityId: opts.entityId ?? store.entityId ?? null,
      type: "STOCK_BELOW_MINIMUM",
      priority: empty ? "HIGH" : "NORMAL",
      title: empty
        ? `${item.name} is out of stock at ${store.name}`
        : `${item.name} has reached its minimum at ${store.name}`,
      body:
        `${item.sku} — ${available} ${item.unit} available against a minimum of ${item.reorderLevel} ${item.unit}.` +
        (opts.triggeredBy ? ` Reached on ${opts.triggeredBy}.` : "") +
        " ZAM/PUR/SOP-01 Store Flow: raise a requisition.",
      linkType: "REPLENISHMENT",
      linkUrl: `/inventory/replenishment?store=${storeId}`,
    },
    db,
  );
}
