import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { round2 } from "@/lib/format";
import { RuleViolationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { DOMAIN_ACTIONS, assertAuthority, type Actor, type Authority } from "@/lib/actor";

/**
 * Stock reservations.
 *
 * Availability is physical stock less what has already been promised. Without a
 * record of who promised what, two requirements are told the same carton is
 * theirs and the second one finds out at the counter — so a reservation is a
 * row, not a decremented number.
 *
 * A reservation moves no goods. It raises `reservedQty` on the buckets it draws
 * on and writes a RESERVATION line to the ledger, so the item's history explains
 * why its available quantity fell without a movement. Releasing reverses both.
 */

/** Buckets are consumed the way an issue consumes them: soonest to expire first. */
async function bucketsFor(itemId: string, storeId: string, db: DbClient) {
  const rows = await db.inventoryItem.findMany({ where: { itemId, storeId } });
  return rows
    .map((r) => ({ row: r, free: round2(r.quantity - r.reservedQty) }))
    .filter((b) => b.free > 0)
    .sort((a, b) => {
      const ax = a.row.expiryDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bx = b.row.expiryDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return ax - bx || a.row.id.localeCompare(b.row.id);
    });
}

/** Free stock in a store: physical less everything already reserved. */
export async function freeQuantity(itemId: string, storeId: string, db: DbClient = prisma) {
  const rows = await db.inventoryItem.findMany({
    where: { itemId, storeId },
    select: { quantity: true, reservedQty: true },
  });
  return {
    physical: round2(rows.reduce((a, r) => a + r.quantity, 0)),
    reserved: round2(rows.reduce((a, r) => a + r.reservedQty, 0)),
    available: round2(rows.reduce((a, r) => a + (r.quantity - r.reservedQty), 0)),
  };
}

export type ReserveInput = {
  itemId: string;
  storeId: string;
  quantity: number;
  unit: string;
  requirementItemId?: string | null;
  storeIssueId?: string | null;
  reason?: string | null;
  createdById: string;
  expiresAt?: Date | null;
};

/**
 * Holds a quantity. Reserving more than is free is refused rather than allowed
 * to go negative — an over-promise found here costs an error message, and found
 * at the counter costs a delivery.
 */
export async function reserveStock(
  actor: Actor,
  input: ReserveInput,
  db: DbClient = prisma,
  authority: Authority = { permission: [P.INVENTORY_RESERVE] },
) {
  return withTransaction(db, async (tx) => {
    assertAuthority(actor, DOMAIN_ACTIONS.RESERVATION_CREATE, authority);
    if (input.quantity <= 0) throw new RuleViolationError("Reserved quantity must be greater than zero.");

    const buckets = await bucketsFor(input.itemId, input.storeId, tx);
    const free = round2(buckets.reduce((a, b) => a + b.free, 0));
    if (free + 1e-9 < input.quantity) {
      const item = await tx.item.findUnique({ where: { id: input.itemId }, select: { sku: true } });
      throw new RuleViolationError(
        `Cannot reserve ${input.quantity} ${input.unit} of ${item?.sku ?? input.itemId} — only ${free} ${input.unit} is unreserved.`,
      );
    }

    let remaining = input.quantity;
    for (const b of buckets) {
      if (remaining <= 1e-9) break;
      const take = Math.min(b.free, remaining);
      await tx.inventoryItem.update({
        where: { id: b.row.id },
        data: { reservedQty: round2(b.row.reservedQty + take) },
      });
      remaining = round2(remaining - take);
    }

    const reservation = await tx.inventoryReservation.create({
      data: {
        itemId: input.itemId,
        storeId: input.storeId,
        quantity: round2(input.quantity),
        unit: input.unit,
        requirementItemId: input.requirementItemId ?? null,
        storeIssueId: input.storeIssueId ?? null,
        status: "ACTIVE",
        reason: input.reason ?? null,
        createdById: input.createdById,
        expiresAt: input.expiresAt ?? null,
      },
    });

    const after = await freeQuantity(input.itemId, input.storeId, tx);
    await tx.inventoryTransaction.create({
      data: {
        number: await nextNumber(SEQ.INV_TXN, tx),
        itemId: input.itemId,
        storeId: input.storeId,
        type: "RESERVATION",
        quantity: round2(input.quantity),
        unit: input.unit,
        balanceAfter: after.physical,
        sourceType: "REQUIREMENT",
        sourceId: reservation.id,
        sourceRef: input.reason ?? "Reservation",
        reason: input.reason ?? null,
        performedById: input.createdById,
      },
    });

    return reservation;
  });
}

/** Gives the quantity back. Used when a requirement is cancelled or re-decided. */
export async function releaseReservation(
  actor: Actor,
  reservationId: string,
  reason: string | null = null,
  db: DbClient = prisma,
  authority: Authority = { permission: [P.INVENTORY_RESERVE] },
) {
  return withTransaction(db, async (tx) => {
    assertAuthority(actor, DOMAIN_ACTIONS.RESERVATION_RELEASE, authority);
    const performedById = actor.id;
    const res = await tx.inventoryReservation.findUnique({ where: { id: reservationId } });
    if (!res || res.status !== "ACTIVE") return null;

    const rows = await tx.inventoryItem.findMany({
      where: { itemId: res.itemId, storeId: res.storeId, reservedQty: { gt: 0 } },
      orderBy: { id: "asc" },
    });
    let remaining = res.quantity;
    for (const r of rows) {
      if (remaining <= 1e-9) break;
      const give = Math.min(r.reservedQty, remaining);
      await tx.inventoryItem.update({
        where: { id: r.id },
        data: { reservedQty: round2(r.reservedQty - give) },
      });
      remaining = round2(remaining - give);
    }

    const updated = await tx.inventoryReservation.update({
      where: { id: reservationId },
      data: { status: "RELEASED", releasedAt: new Date() },
    });

    const after = await freeQuantity(res.itemId, res.storeId, tx);
    await tx.inventoryTransaction.create({
      data: {
        number: await nextNumber(SEQ.INV_TXN, tx),
        itemId: res.itemId,
        storeId: res.storeId,
        type: "RELEASE",
        quantity: res.quantity,
        unit: res.unit,
        balanceAfter: after.physical,
        sourceType: "REQUIREMENT",
        sourceId: reservationId,
        sourceRef: reason ?? "Reservation released",
        reason,
        performedById,
      },
    });

    return updated;
  });
}

/**
 * Turns a reservation into an issue.
 *
 * The hold is dropped first so the movement can consume the stock it was
 * protecting — otherwise the issue would be refused for lack of *free* stock
 * that the reservation itself was holding.
 */
export async function consumeReservation(
  actor: Actor,
  reservationId: string,
  db: DbClient = prisma,
  authority: Authority = { permission: [P.INVENTORY_RESERVE] },
) {
  return withTransaction(db, async (tx) => {
    assertAuthority(actor, DOMAIN_ACTIONS.RESERVATION_CONSUME, authority);
    const performedById = actor.id;
    const res = await tx.inventoryReservation.findUnique({ where: { id: reservationId } });
    if (!res || res.status !== "ACTIVE") return null;

    const rows = await tx.inventoryItem.findMany({
      where: { itemId: res.itemId, storeId: res.storeId, reservedQty: { gt: 0 } },
      orderBy: { id: "asc" },
    });
    let remaining = res.quantity;
    for (const r of rows) {
      if (remaining <= 1e-9) break;
      const give = Math.min(r.reservedQty, remaining);
      await tx.inventoryItem.update({
        where: { id: r.id },
        data: { reservedQty: round2(r.reservedQty - give) },
      });
      remaining = round2(remaining - give);
    }

    return tx.inventoryReservation.update({
      where: { id: reservationId },
      data: { status: "CONSUMED", consumedAt: new Date() },
    });
  });
}

/** Releases every active hold attached to a requirement line or a requisition. */
export async function releaseFor(
  actor: Actor,
  where: { requirementItemIds?: string[]; storeIssueId?: string },
  reason: string,
  db: DbClient = prisma,
  authority: Authority = { permission: [P.INVENTORY_RESERVE] },
) {
  const active = await db.inventoryReservation.findMany({
    where: {
      status: "ACTIVE",
      ...(where.requirementItemIds ? { requirementItemId: { in: where.requirementItemIds } } : {}),
      ...(where.storeIssueId ? { storeIssueId: where.storeIssueId } : {}),
    },
    select: { id: true },
  });
  for (const r of active) await releaseReservation(actor, r.id, reason, db, authority);
  return active.length;
}

/**
 * Sweeps holds nobody consumed.
 *
 * A reservation with no expiry never lapses, which is correct for one attached to
 * an approved requisition; the expiry exists for the ones created at the moment a
 * requirement was decided and then abandoned.
 */
export async function expireStaleReservations(actor: Actor, db: DbClient = prisma) {
  const stale = await db.inventoryReservation.findMany({
    where: { status: "ACTIVE", expiresAt: { not: null, lt: new Date() } },
    select: { id: true },
  });
  for (const r of stale) {
    await releaseReservation(actor, r.id, "Reservation expired without being issued", db);
  }
  return stale.length;
}
