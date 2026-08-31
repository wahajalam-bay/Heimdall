import { prisma, type DbClient } from "@/lib/db";
import { CONFIG_KEYS, getConfigArray } from "@/lib/config";
import { round2 } from "@/lib/format";

/**
 * Inventory ageing and expiry.
 *
 * Two different questions that look alike. Ageing asks how long money has been
 * sitting on a shelf; expiry asks how long the goods are still usable. Slow
 * stock is a working-capital problem, and near-expiry stock is a write-off
 * waiting to happen — the same carton can be one, the other, both or neither.
 *
 * Age is taken from the ledger rather than from a column on the bucket, because
 * the bucket has no received date and inventing one would mean back-filling a
 * guess. The earliest posted receipt into a bucket is when its stock arrived,
 * and that is a fact the ledger already holds.
 */

export type AgeingBand = { label: string; fromDays: number; toDays: number | null };

/** Shipped bands, overridable per entity. */
export const DEFAULT_AGEING_BANDS: AgeingBand[] = [
  { label: "0–30 days", fromDays: 0, toDays: 30 },
  { label: "31–60 days", fromDays: 31, toDays: 60 },
  { label: "61–90 days", fromDays: 61, toDays: 90 },
  { label: "91–180 days", fromDays: 91, toDays: 180 },
  { label: "181–365 days", fromDays: 181, toDays: 365 },
  { label: "Over a year", fromDays: 366, toDays: null },
];

export async function ageingBands(
  entityId: string | null,
  db: DbClient = prisma,
): Promise<AgeingBand[]> {
  const configured = await getConfigArray<AgeingBand>(CONFIG_KEYS.AGEING_BANDS, entityId, db);
  const usable = configured.filter(
    (b) => b && typeof b.fromDays === "number" && typeof b.label === "string",
  );
  return usable.length ? usable : DEFAULT_AGEING_BANDS;
}

export function bandFor(days: number, bands: AgeingBand[]): string {
  for (const b of bands) {
    if (days >= b.fromDays && (b.toDays === null || days <= b.toDays)) return b.label;
  }
  return bands.at(-1)?.label ?? "Unbanded";
}

export type AgeingRow = {
  id: string;
  itemId: string;
  sku: string;
  name: string;
  categoryName: string | null;
  storeName: string;
  locationName: string | null;
  projectName: string | null;
  batchNumber: string | null;
  serialNumber: string | null;
  quantity: number;
  reservedQty: number;
  unit: string;
  unitCost: number;
  totalValue: number;
  /** Earliest posted receipt into this bucket. Null when the ledger has none. */
  receivedAt: Date | null;
  ageDays: number | null;
  band: string;
  expiryDate: Date | null;
  daysToExpiry: number | null;
  expiryState: "EXPIRED" | "NEAR_EXPIRY" | "OK" | "NOT_TRACKED";
  /** Last time anything moved in or out of this bucket. */
  lastMovedAt: Date | null;
  daysSinceMovement: number | null;
  grnId: string | null;
  poId: string | null;
};

const DAY = 86400000;

/**
 * The ageing report.
 *
 * Three queries, not one per row: the buckets, then the earliest and latest
 * ledger dates for all of them at once. A per-row query here would be a hundred
 * round trips to draw one table.
 */
export async function inventoryAgeing(
  filter: {
    entityIds?: string[] | null;
    storeId?: string | null;
    categoryId?: string | null;
    nearExpiryDays?: number;
    minAgeDays?: number | null;
  } = {},
  db: DbClient = prisma,
): Promise<{ rows: AgeingRow[]; bands: AgeingBand[]; nearExpiryDays: number }> {
  const nearExpiryDays = filter.nearExpiryDays ?? 60;

  const buckets = await db.inventoryItem.findMany({
    where: {
      quantity: { gt: 0 },
      ...(filter.storeId ? { storeId: filter.storeId } : {}),
      ...(filter.entityIds ? { OR: [{ entityId: { in: filter.entityIds } }, { entityId: null }] } : {}),
      ...(filter.categoryId ? { item: { categoryId: filter.categoryId } } : {}),
    },
    include: {
      item: { select: { sku: true, name: true, category: { select: { name: true } } } },
      store: { select: { name: true } },
      location: { select: { label: true } },
      project: { select: { name: true } },
    },
    take: 4000,
  });
  if (!buckets.length) {
    return { rows: [], bands: await ageingBands(null, db), nearExpiryDays };
  }

  const itemIds = [...new Set(buckets.map((b) => b.itemId))];
  const storeIds = [...new Set(buckets.map((b) => b.storeId))];

  // Earliest receipt and latest movement per bucket key, in two grouped reads.
  const [firstReceipts, lastMoves] = await Promise.all([
    db.inventoryTransaction.groupBy({
      by: ["itemId", "storeId", "batchNumber", "serialNumber"],
      where: { itemId: { in: itemIds }, storeId: { in: storeIds }, type: { in: ["RECEIPT", "TRANSFER_IN"] } },
      _min: { performedAt: true },
    }),
    db.inventoryTransaction.groupBy({
      by: ["itemId", "storeId", "batchNumber", "serialNumber"],
      where: { itemId: { in: itemIds }, storeId: { in: storeIds } },
      _max: { performedAt: true },
    }),
  ]);

  const key = (i: string, s: string, b: string | null, sn: string | null) =>
    `${i}|${s}|${b ?? ""}|${sn ?? ""}`;
  const firstBy = new Map(
    firstReceipts.map((r) => [key(r.itemId, r.storeId, r.batchNumber, r.serialNumber), r._min?.performedAt ?? null]),
  );
  const lastBy = new Map(
    lastMoves.map((r) => [key(r.itemId, r.storeId, r.batchNumber, r.serialNumber), r._max?.performedAt ?? null]),
  );

  const bands = await ageingBands(buckets[0]?.entityId ?? null, db);
  const now = Date.now();

  const rows: AgeingRow[] = buckets.map((b) => {
    const k = key(b.itemId, b.storeId, b.batchNumber, b.serialNumber);
    const receivedAt = firstBy.get(k) ?? null;
    const lastMovedAt = lastBy.get(k) ?? null;
    const ageDays = receivedAt ? Math.floor((now - receivedAt.getTime()) / DAY) : null;
    const daysToExpiry = b.expiryDate
      ? Math.floor((b.expiryDate.getTime() - now) / DAY)
      : null;

    return {
      id: b.id,
      itemId: b.itemId,
      sku: b.item.sku,
      name: b.item.name,
      categoryName: b.item.category?.name ?? null,
      storeName: b.store.name,
      locationName: b.location?.label ?? null,
      projectName: b.project?.name ?? null,
      batchNumber: b.batchNumber,
      serialNumber: b.serialNumber,
      quantity: round2(b.quantity),
      reservedQty: round2(b.reservedQty),
      unit: b.unit,
      unitCost: round2(b.unitCost),
      totalValue: round2(b.quantity * b.unitCost),
      receivedAt,
      ageDays,
      band: ageDays === null ? "Unknown" : bandFor(ageDays, bands),
      expiryDate: b.expiryDate,
      daysToExpiry,
      expiryState:
        daysToExpiry === null
          ? "NOT_TRACKED"
          : daysToExpiry < 0
            ? "EXPIRED"
            : daysToExpiry <= nearExpiryDays
              ? "NEAR_EXPIRY"
              : "OK",
      lastMovedAt,
      daysSinceMovement: lastMovedAt
        ? Math.floor((now - lastMovedAt.getTime()) / DAY)
        : null,
      grnId: b.lastGrnId,
      poId: b.lastPoId,
    };
  });

  const filtered =
    filter.minAgeDays != null
      ? rows.filter((r) => (r.ageDays ?? 0) >= filter.minAgeDays!)
      : rows;

  // Oldest money first, because that is what the report is for.
  filtered.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
  return { rows: filtered, bands, nearExpiryDays };
}

/** Value per band, for the summary strip. */
export function summariseByBand(rows: AgeingRow[], bands: AgeingBand[]) {
  const out = bands.map((b) => ({ label: b.label, quantity: 0, value: 0, lines: 0 }));
  const unknown = { label: "Unknown", quantity: 0, value: 0, lines: 0 };
  for (const r of rows) {
    const slot = out.find((o) => o.label === r.band) ?? unknown;
    slot.lines += 1;
    slot.quantity = round2(slot.quantity + r.quantity);
    slot.value = round2(slot.value + r.totalValue);
  }
  return unknown.lines ? [...out, unknown] : out;
}
