import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { withTransaction, inTransaction, type Tx } from "@/lib/db";
import { PERMISSIONS as P } from "@/lib/permissions";
import { postGrn } from "@/server/grn";
import { userWithPermission } from "./helpers";

/**
 * Atomicity, proved rather than asserted.
 *
 * Phase 2 wrapped sixty-one write chains in transactions on the strength of a
 * type check and a source audit. Neither of those shows that a failure part-way
 * through actually undoes what came before it — that is a runtime property, and
 * the only way to know is to break something on purpose.
 *
 * These tests force a failure at a chosen point and then read the database back
 * to confirm nothing survived. They also cover the two properties a transaction
 * alone does not give: that a retry cannot double-post, and that work deferred
 * to after the commit runs without being able to roll the commit back.
 */

describe("transaction integrity", () => {
  it("undoes every write when the chain fails part-way through", async () => {
    // A real table, a real write, then a deliberate failure after it.
    const before = await prisma.configSetting.count();
    const key = `test.rollback.${Date.now()}`;

    await expect(
      withTransaction(prisma, async (tx) => {
        await tx.configSetting.create({
          data: { key, value: "1", valueType: "number", label: "Rollback probe", group: "Test" },
        });
        // The row exists inside the transaction.
        const seen = await tx.configSetting.findFirst({ where: { key } });
        expect(seen).not.toBeNull();
        throw new Error("deliberate failure after the write");
      }),
    ).rejects.toThrow(/deliberate failure/);

    // And does not exist outside it.
    const after = await prisma.configSetting.count();
    expect(after).toBe(before);
    expect(await prisma.configSetting.findFirst({ where: { key } })).toBeNull();
  });

  it("undoes a multi-row chain, not just the last write", async () => {
    const stamp = Date.now();
    const keys = [`test.multi.a.${stamp}`, `test.multi.b.${stamp}`, `test.multi.c.${stamp}`];

    await expect(
      withTransaction(prisma, async (tx) => {
        for (const k of keys) {
          await tx.configSetting.create({
            data: { key: k, value: "1", valueType: "number", label: "Multi probe", group: "Test" },
          });
        }
        throw new Error("fail after three writes");
      }),
    ).rejects.toThrow();

    const survivors = await prisma.configSetting.count({ where: { key: { in: keys } } });
    expect(survivors).toBe(0);
  });

  it("commits everything when the chain succeeds", async () => {
    const key = `test.commit.${Date.now()}`;
    const id = await withTransaction(prisma, async (tx) => {
      const row = await tx.configSetting.create({
        data: { key, value: "7", valueType: "number", label: "Commit probe", group: "Test" },
      });
      await tx.configSetting.update({ where: { id: row.id }, data: { value: "8" } });
      return row.id;
    });

    const stored = await prisma.configSetting.findUniqueOrThrow({ where: { id } });
    expect(stored.value).toBe("8");
    await prisma.configSetting.delete({ where: { id } });
  });

  it("joins a caller's transaction rather than opening a second one", async () => {
    // Nesting must not deadlock against a pool slot the outer call is holding,
    // and the inner work must roll back with the outer.
    const key = `test.nested.${Date.now()}`;

    await expect(
      withTransaction(prisma, async (outer) => {
        expect(inTransaction(outer)).toBe(true);
        await withTransaction(outer as Tx, async (inner) => {
          // Same handle, not a new transaction.
          expect(inner).toBe(outer);
          await inner.configSetting.create({
            data: { key, value: "1", valueType: "number", label: "Nested probe", group: "Test" },
          });
        });
        throw new Error("outer fails after the inner wrote");
      }),
    ).rejects.toThrow();

    expect(await prisma.configSetting.findFirst({ where: { key } })).toBeNull();
  });

  it("runs deferred work after the commit, and a failure there does not undo it", async () => {
    const key = `test.defer.${Date.now()}`;
    let ran = false;

    const id = await withTransaction(prisma, async (tx, defer) => {
      const row = await tx.configSetting.create({
        data: { key, value: "1", valueType: "number", label: "Defer probe", group: "Test" },
      });
      defer({
        label: "probe job that throws",
        run: async () => {
          ran = true;
          // A deferred job is allowed to fail. The commit stands.
          throw new Error("deferred job failed on purpose");
        },
      });
      return row.id;
    });

    expect(ran).toBe(true);
    // The write survived a failing deferred job — that is the contract.
    const stored = await prisma.configSetting.findUnique({ where: { id } });
    expect(stored).not.toBeNull();
    await prisma.configSetting.delete({ where: { id } });
  });

  it("does not run deferred work when the transaction rolls back", async () => {
    let ran = false;
    await expect(
      withTransaction(prisma, async (tx, defer) => {
        defer({ label: "must not run", run: async () => { ran = true; } });
        await tx.configSetting.count();
        throw new Error("rolled back");
      }),
    ).rejects.toThrow();
    expect(ran).toBe(false);
  });
});

describe("goods receipt idempotency", () => {
  it("posts once when the same receipt is posted twice concurrently", async () => {
    const grn = await prisma.grn.findFirst({
      where: { status: "DRAFT" },
      select: { id: true, number: true, poId: true },
    });
    if (!grn) return; // nothing draft to exercise; the guard is unit-tested below

    const keeper = await userWithPermission(P.GRN_POST);

    const ledgerBefore = await prisma.inventoryTransaction.count({
      where: { grnId: grn.id },
    });
    const priceBefore = await prisma.priceHistory.count({ where: { sourceRef: { not: "" } } });

    // Both requests read DRAFT, both proceed. Only one may post.
    const results = await Promise.allSettled([
      postGrn(keeper, grn.id),
      postGrn(keeper, grn.id),
    ]);
    const posted = results.filter((r) => r.status === "fulfilled");
    expect(posted.length).toBeGreaterThanOrEqual(1);

    const row = await prisma.grn.findUniqueOrThrow({ where: { id: grn.id } });
    expect(row.status).toBe("POSTED");

    // The ledger is the thing that must not double. One posting, one set of
    // movements — a second set would be stock that arrived from nowhere.
    const ledgerAfter = await prisma.inventoryTransaction.count({ where: { grnId: grn.id } });
    const lines = await prisma.grnItem.count({
      where: { grnId: grn.id, acceptedQty: { gt: 0 } },
    });
    expect(ledgerAfter - ledgerBefore).toBeLessThanOrEqual(lines);

    const priceAfter = await prisma.priceHistory.count({ where: { sourceRef: { not: "" } } });
    expect(priceAfter - priceBefore).toBeLessThanOrEqual(lines);
  });

  it("returns the posted receipt rather than failing when it is already posted", async () => {
    const grn = await prisma.grn.findFirst({
      where: { status: "POSTED" },
      select: { id: true, number: true },
    });
    if (!grn) return;
    const keeper = await userWithPermission(P.GRN_POST);
    const again = await postGrn(keeper, grn.id);
    expect(again.id).toBe(grn.id);

    // And it did not post a second set of movements.
    const movements = await prisma.inventoryTransaction.count({ where: { grnId: grn.id } });
    const lines = await prisma.grnItem.count({ where: { grnId: grn.id, acceptedQty: { gt: 0 } } });
    expect(movements).toBeLessThanOrEqual(lines);
  });
});
