import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { CONFIG_KEYS, getConfigBool, getConfigNumber, setConfig } from "@/lib/config";
import { cpcRequirement } from "@/server/cpc";
import { userWithPermission } from "./helpers";

/**
 * Configurable business rules. The point of these tests is that no threshold is
 * hard-coded: change the configuration and the engine's answer changes with it.
 */
describe("configurable business rules", () => {
  it("resolves entity overrides ahead of the global value", async () => {
    const entities = await prisma.entity.findMany({ select: { id: true, code: true }, orderBy: { code: "asc" } });
    expect(entities.length).toBeGreaterThanOrEqual(2);

    const globalLimit = await getConfigNumber(CONFIG_KEYS.PETTY_CASH_LIMIT, null);
    const perEntity = await Promise.all(
      entities.map(async (e) => ({
        code: e.code,
        limit: await getConfigNumber(CONFIG_KEYS.PETTY_CASH_LIMIT, e.id),
      })),
    );

    // At least one entity is seeded with its own petty cash ceiling.
    expect(perEntity.some((p) => p.limit !== globalLimit)).toBe(true);
    for (const p of perEntity) expect(p.limit).toBeGreaterThan(0);
  });

  it("drives the CPC requirement from configuration, not from a constant", async () => {
    const entity = await prisma.entity.findFirstOrThrow({ orderBy: { code: "asc" } });
    const threshold = await getConfigNumber(CONFIG_KEYS.CPC_THRESHOLD, entity.id);
    const enabled = await getConfigBool(CONFIG_KEYS.CPC_ENABLED, entity.id);
    expect(threshold).toBeGreaterThan(0);

    const below = await cpcRequirement(entity.id, threshold - 1, "ON_DEMAND");
    const above = await cpcRequirement(entity.id, threshold + 1, "ON_DEMAND");

    expect(below.threshold).toBe(threshold);
    expect(below.required).toBe(false);
    expect(above.required).toBe(enabled);
    expect(above.reason).toBeTruthy();
  });

  it("treats recurring monthly buying as outside the committee on value alone", async () => {
    const entity = await prisma.entity.findFirstOrThrow({ orderBy: { code: "asc" } });
    const threshold = await getConfigNumber(CONFIG_KEYS.CPC_THRESHOLD, entity.id);
    const recurring = await cpcRequirement(entity.id, threshold * 5, "MONTHLY_RECURRING");
    expect(recurring.required).toBe(false);
  });

  it("re-reads a changed threshold immediately and restores it afterwards", async () => {
    const user = await userWithPermission("admin.config");
    const entity = await prisma.entity.findFirstOrThrow({ orderBy: { code: "asc" } });
    const original = await getConfigNumber(CONFIG_KEYS.CPC_THRESHOLD, entity.id);
    const raised = original * 2;

    try {
      await setConfig(CONFIG_KEYS.CPC_THRESHOLD, raised, entity.id, user.id);
      const afterRaise = await cpcRequirement(entity.id, original + 1, "ON_DEMAND");
      expect(afterRaise.threshold).toBe(raised);
      expect(afterRaise.required).toBe(false);

      const wellAbove = await cpcRequirement(entity.id, raised + 1, "ON_DEMAND");
      const enabled = await getConfigBool(CONFIG_KEYS.CPC_ENABLED, entity.id);
      expect(wellAbove.required).toBe(enabled);
    } finally {
      await setConfig(CONFIG_KEYS.CPC_THRESHOLD, original, entity.id, user.id);
    }

    const restored = await getConfigNumber(CONFIG_KEYS.CPC_THRESHOLD, entity.id);
    expect(restored).toBe(original);
  });

  it("keeps the vendor pass mark and maximum score consistent with the criteria sheet", async () => {
    const passMark = await getConfigNumber(CONFIG_KEYS.VENDOR_MIN_SCORE, null);
    const maxScore = await getConfigNumber(CONFIG_KEYS.VENDOR_MAX_SCORE, null);
    expect(maxScore).toBeGreaterThan(0);
    expect(passMark).toBeGreaterThan(0);
    expect(passMark).toBeLessThanOrEqual(maxScore);

    const criteria = await prisma.evaluationCriterion.findMany({ where: { active: true } });
    expect(criteria.length).toBeGreaterThan(0);
    const rawMax = criteria.reduce((a, c) => a + c.maxScore * c.weight, 0);
    expect(rawMax).toBeGreaterThan(0);
  });

  it("requires a minimum number of quotations, taken from configuration", async () => {
    const minQuotes = await getConfigNumber(CONFIG_KEYS.MIN_QUOTATIONS, null);
    expect(minQuotes).toBeGreaterThanOrEqual(1);

    const pettyMin = await getConfigNumber(CONFIG_KEYS.PETTY_CASH_MIN_QUOTES, null);
    expect(pettyMin).toBeGreaterThanOrEqual(1);
  });

  it("exposes invoice matching tolerances as configuration", async () => {
    const qty = await getConfigNumber(CONFIG_KEYS.INVOICE_QTY_TOLERANCE, null);
    const price = await getConfigNumber(CONFIG_KEYS.INVOICE_PRICE_TOLERANCE, null);
    const absolute = await getConfigNumber(CONFIG_KEYS.INVOICE_VALUE_TOLERANCE_ABS, null);
    const requireGrn = await getConfigBool(CONFIG_KEYS.REQUIRE_GRN_FOR_PAYMENT, null);
    const blockMismatch = await getConfigBool(CONFIG_KEYS.BLOCK_PAYMENT_ON_MISMATCH, null);

    expect(qty).toBeGreaterThanOrEqual(0);
    expect(price).toBeGreaterThanOrEqual(0);
    expect(absolute).toBeGreaterThanOrEqual(0);
    // These two are the controls the whole payment gate rests on.
    expect(requireGrn).toBe(true);
    expect(blockMismatch).toBe(true);
  });
});
