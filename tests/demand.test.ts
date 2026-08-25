import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { CONFIG_KEYS, setConfig } from "@/lib/config";
import { PERMISSIONS as P } from "@/lib/permissions";
import { round2 } from "@/lib/format";
import {
  checkAvailability,
  createRequirement,
  decideFulfilment,
  runStockCheck,
} from "@/server/requirements";
import { freeQuantity, releaseReservation, reserveStock } from "@/server/reservations";
import { allocate, requisitionCoverage, unallocatedQuantity } from "@/server/allocations";
import { sessionFor, without } from "./helpers";

/**
 * The inventory-first rule.
 *
 * These tests are about the one thing the demand layer exists to guarantee: that
 * nothing is bought before the stores have been read. Each case drives the real
 * services against the seeded database, so passing means the rule holds where it
 * is enforced rather than where it is described.
 */

const ACTOR = "system.admin@zameen.com";

/** A store holding free stock, and the item it holds — the fixture the rule needs. */
async function stockedBucket() {
  const rows = await prisma.inventoryItem.findMany({
    where: { quantity: { gt: 1 } },
    include: { item: { select: { id: true, sku: true, unit: true, categoryId: true, name: true } }, store: true },
    orderBy: { quantity: "desc" },
    take: 10,
  });
  const usable = rows.find((r) => r.quantity - r.reservedQty > 1);
  if (!usable) throw new Error("No store holds free stock; the demand tests need one.");
  return usable;
}

async function raise(
  opts: { quantity: number; itemId?: string | null; categoryId?: string | null; storeId: string; entityId: string },
) {
  const user = await sessionFor(ACTOR);
  const department = await prisma.department.findFirstOrThrow({
    where: { entityId: opts.entityId, active: true },
    orderBy: { name: "asc" },
  });
  return createRequirement(user, {
    entityId: opts.entityId,
    departmentId: department.id,
    title: `Test requirement ${Date.now()}`,
    requiredDate: new Date(Date.now() + 14 * 86400000),
    storeId: opts.storeId,
    items: [
      {
        itemId: opts.itemId ?? null,
        categoryId: opts.categoryId ?? null,
        description: "Test line",
        quantity: opts.quantity,
        unit: "EA",
      },
    ],
    submit: true,
  });
}

describe("inventory-first fulfilment", () => {
  it("meets a requirement from stock without raising a purchase requisition", async () => {
    const user = await sessionFor(ACTOR);
    const bucket = await stockedBucket();
    const free = await freeQuantity(bucket.itemId, bucket.storeId);
    const want = Math.max(1, Math.floor(free.available / 2));

    const req = await raise({
      quantity: want,
      itemId: bucket.itemId,
      categoryId: bucket.item.categoryId,
      storeId: bucket.storeId,
      entityId: bucket.store.entityId,
    });
    const check = await runStockCheck(user, req.id);
    expect(check.lines[0].fromStockQty).toBe(want);
    expect(check.lines[0].procureQty).toBe(0);

    const outcome = await decideFulfilment(user, req.id, {
      lines: check.lines.map((l) => ({
        requirementItemId: l.requirementItemId,
        fromStockQty: l.fromStockQty,
        procureQty: l.procureQty,
      })),
    });

    expect(outcome.status).toBe("FULFILLED_FROM_STOCK");
    expect(outcome.storeIssueId).toBeTruthy();
    // The point of the whole layer: nothing was bought.
    expect(outcome.requisitionId).toBeNull();
  });

  // This one raises, checks, routes and then reads the requisition back — the
  // longest chain of round trips in the suite. It needs its own budget when the
  // database is not local; the 60s default is fine beside it.
  it("splits a partly available line between the store and procurement", async () => {
    const user = await sessionFor(ACTOR);
    const bucket = await stockedBucket();
    await setConfig(CONFIG_KEYS.PARTIAL_AVAILABILITY_MODE, "SPLIT", null, user.id);
    // Cross-store sourcing is a separate rule, and with it on the engine can
    // rightly cover more than the requesting store holds — which would make this
    // assertion about the split depend on stock in a store the test never chose.
    await setConfig(CONFIG_KEYS.CROSS_STORE_ENABLED, false, null, user.id);

    try {
      const free = await freeQuantity(bucket.itemId, bucket.storeId);
      const shortfall = 7;
      const want = round2(free.available + shortfall);

      const req = await raise({
        quantity: want,
        itemId: bucket.itemId,
        categoryId: bucket.item.categoryId,
        storeId: bucket.storeId,
        entityId: bucket.store.entityId,
      });
      const check = await runStockCheck(user, req.id);
      expect(check.lines[0].fromStockQty).toBeCloseTo(free.available, 2);
      expect(check.lines[0].procureQty).toBeCloseTo(shortfall, 2);

      const outcome = await decideFulfilment(user, req.id, {
        lines: check.lines.map((l) => ({
          requirementItemId: l.requirementItemId,
          fromStockQty: l.fromStockQty,
          procureQty: l.procureQty,
        })),
      });
      expect(outcome.status).toBe("SPLIT");
      expect(outcome.storeIssueId).toBeTruthy();
      expect(outcome.requisitionId).toBeTruthy();

      // The requisition carries only the shortfall, not the whole line.
      const pr = await prisma.purchaseRequisition.findUniqueOrThrow({
        where: { id: outcome.requisitionId! },
        include: { items: true },
      });
      expect(pr.items[0].quantity).toBeCloseTo(shortfall, 2);
    } finally {
      await setConfig(CONFIG_KEYS.CROSS_STORE_ENABLED, true, null, user.id);
    }
  }, 240_000);

  it("sends the whole line to procurement when configuration says so", async () => {
    const user = await sessionFor(ACTOR);
    const bucket = await stockedBucket();
    await setConfig(CONFIG_KEYS.PARTIAL_AVAILABILITY_MODE, "ALL_TO_PROCUREMENT", null, user.id);
    try {
      const free = await freeQuantity(bucket.itemId, bucket.storeId);
      const req = await raise({
        quantity: round2(free.available + 3),
        itemId: bucket.itemId,
        categoryId: bucket.item.categoryId,
        storeId: bucket.storeId,
        entityId: bucket.store.entityId,
      });
      const check = await checkAvailability(req.id);
      expect(check.mode).toBe("ALL_TO_PROCUREMENT");
      expect(check.lines[0].fromStockQty).toBe(0);
      expect(check.lines[0].procureQty).toBe(check.lines[0].quantity);
    } finally {
      await setConfig(CONFIG_KEYS.PARTIAL_AVAILABILITY_MODE, "SPLIT", null, user.id);
    }
  });

  it("refuses to route a requirement whose stock was never checked", async () => {
    const user = await sessionFor(ACTOR);
    const bucket = await stockedBucket();
    await setConfig(CONFIG_KEYS.REQUIRE_INVENTORY_CHECK, true, null, user.id);

    const req = await raise({
      quantity: 1,
      itemId: bucket.itemId,
      categoryId: bucket.item.categoryId,
      storeId: bucket.storeId,
      entityId: bucket.store.entityId,
    });

    await expect(
      decideFulfilment(user, req.id, {
        lines: [{ requirementItemId: (await prisma.requirementItem.findFirstOrThrow({ where: { requirementId: req.id } })).id, fromStockQty: 0, procureQty: 1 }],
      }),
    ).rejects.toThrow(/stock must be checked/i);
  });

  it("demands a reason before buying what the store already holds", async () => {
    const user = await sessionFor(ACTOR);
    const bucket = await stockedBucket();
    const free = await freeQuantity(bucket.itemId, bucket.storeId);
    const want = Math.max(1, Math.floor(free.available / 2));

    const req = await raise({
      quantity: want,
      itemId: bucket.itemId,
      categoryId: bucket.item.categoryId,
      storeId: bucket.storeId,
      entityId: bucket.store.entityId,
    });
    const check = await runStockCheck(user, req.id);

    // Overriding the split downwards, with no explanation.
    await expect(
      decideFulfilment(user, req.id, {
        lines: check.lines.map((l) => ({
          requirementItemId: l.requirementItemId,
          fromStockQty: 0,
          procureQty: l.quantity,
        })),
      }),
    ).rejects.toThrow(/record why/i);

    // With one, it goes through.
    const outcome = await decideFulfilment(user, req.id, {
      lines: check.lines.map((l) => ({
        requirementItemId: l.requirementItemId,
        fromStockQty: 0,
        procureQty: l.quantity,
      })),
      note: "Stock is earmarked for the scheduled shutdown.",
    });
    expect(outcome.status).toBe("SENT_TO_PROCUREMENT");
  });

  it("refuses to issue from stock that is not there", async () => {
    const user = await sessionFor(ACTOR);
    const bucket = await stockedBucket();
    const free = await freeQuantity(bucket.itemId, bucket.storeId);

    const req = await raise({
      quantity: round2(free.available + 10),
      itemId: bucket.itemId,
      categoryId: bucket.item.categoryId,
      storeId: bucket.storeId,
      entityId: bucket.store.entityId,
    });
    const check = await runStockCheck(user, req.id);

    await expect(
      decideFulfilment(user, req.id, {
        lines: check.lines.map((l) => ({
          requirementItemId: l.requirementItemId,
          fromStockQty: round2(free.available + 10),
          procureQty: 0,
        })),
      }),
    ).rejects.toThrow(/unreserved/i);
  });

  it("refuses the decision to a user without the permission", async () => {
    const user = await sessionFor(ACTOR);
    const bucket = await stockedBucket();
    const req = await raise({
      quantity: 1,
      itemId: bucket.itemId,
      categoryId: bucket.item.categoryId,
      storeId: bucket.storeId,
      entityId: bucket.store.entityId,
    });
    const stripped = without(user, P.REQUIREMENT_DECIDE);
    await expect(decideFulfilment(stripped, req.id, { lines: [] })).rejects.toThrow(/permission/i);
  });
});

describe("stock reservations", () => {
  it("takes a quantity out of availability without moving it", async () => {
    const user = await sessionFor(ACTOR);
    const bucket = await stockedBucket();
    const before = await freeQuantity(bucket.itemId, bucket.storeId);

    const hold = await reserveStock({
      itemId: bucket.itemId,
      storeId: bucket.storeId,
      quantity: 1,
      unit: bucket.item.unit,
      reason: "Test hold",
      createdById: user.id,
    });

    const during = await freeQuantity(bucket.itemId, bucket.storeId);
    expect(during.physical).toBeCloseTo(before.physical, 2);
    expect(during.available).toBeCloseTo(before.available - 1, 2);

    await releaseReservation(hold.id, user.id, "Test release");
    const after = await freeQuantity(bucket.itemId, bucket.storeId);
    expect(after.available).toBeCloseTo(before.available, 2);
  });

  it("will not reserve more than is unreserved", async () => {
    const user = await sessionFor(ACTOR);
    const bucket = await stockedBucket();
    const free = await freeQuantity(bucket.itemId, bucket.storeId);
    await expect(
      reserveStock({
        itemId: bucket.itemId,
        storeId: bucket.storeId,
        quantity: free.available + 5,
        unit: bucket.item.unit,
        createdById: user.id,
      }),
    ).rejects.toThrow(/only/i);
  });

  it("records a reservation in the ledger so the drop is explainable", async () => {
    const user = await sessionFor(ACTOR);
    const bucket = await stockedBucket();
    const hold = await reserveStock({
      itemId: bucket.itemId,
      storeId: bucket.storeId,
      quantity: 1,
      unit: bucket.item.unit,
      reason: "Ledger test",
      createdById: user.id,
    });
    const entry = await prisma.inventoryTransaction.findFirst({
      where: { sourceId: hold.id, type: "RESERVATION" },
    });
    expect(entry).toBeTruthy();
    expect(entry!.sourceType).toBe("REQUIREMENT");
    await releaseReservation(hold.id, user.id, "Ledger test done");
  });
});

describe("requisition to order allocation", () => {
  it("reports what is left to order on a line", async () => {
    const line = await prisma.purchaseRequisitionItem.findFirst({
      where: { allocations: { some: {} } },
      include: { allocations: true },
    });
    if (!line) return; // Nothing ordered yet in this database.
    const placed = line.allocations.reduce((a, x) => a + x.quantity, 0);
    const remaining = await unallocatedQuantity(line.id);
    expect(remaining).toBeCloseTo(Math.max(0, line.quantity - placed), 2);
  });

  it("refuses to order more of a line than it holds", async () => {
    const alloc = await prisma.prPoAllocation.findFirst({
      include: { prItem: true },
    });
    if (!alloc) return;
    await expect(
      allocate(
        [
          {
            prId: alloc.prId,
            prItemId: alloc.prItemId,
            poId: alloc.poId,
            poItemId: null,
            quantity: alloc.prItem.quantity + 100,
            unit: alloc.unit,
          },
        ],
        null,
      ),
    ).rejects.toThrow(/left to order/i);
  });

  it("reads coverage across every order a requisition was split over", async () => {
    const alloc = await prisma.prPoAllocation.findFirst({ select: { prId: true } });
    if (!alloc) return;
    const coverage = await requisitionCoverage(alloc.prId);
    expect(coverage.length).toBeGreaterThan(0);
    for (const line of coverage) {
      expect(line.ordered).toBeLessThanOrEqual(line.required + 1e-6);
      expect(line.outstanding).toBeCloseTo(Math.max(0, line.required - line.ordered), 2);
    }
  });
});
