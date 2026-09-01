/**
 * FIFO cost layers, checked against the worked example in the meeting brief:
 *   Receipt 1: 10 @ 100 · Receipt 2: 10 @ 120 · Issue 12 → 10@100 + 2@120 = 1240
 * and against the weighted average it replaces (12 @ 110 = 1320).
 */
import { prisma } from "../src/lib/db";
import { postMovement } from "../src/server/inventory";
import {
  consumeLayers,
  costingPolicy,
  fifoValuation,
  consumptionsFor,
  returnToLayers,
  layerBalance,
} from "../src/server/costing";
import { CONFIG_KEYS } from "../src/lib/config";
import { PERMISSIONS as P } from "../src/lib/permissions";
import { withPermissions } from "./lib/actors";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const store = await prisma.store.findFirst({ where: { active: true } });
  const user = await prisma.user.findFirst({ where: { active: true } });
  if (!store || !user) throw new Error("no store/user");

  const sku = `FIFO-TEST-${Date.now()}`;
  const cat = await prisma.category.findFirst();
  const item = await prisma.item.create({
    data: {
      sku,
      name: "FIFO worked example",
      unit: "EA",
      categoryId: cat!.id,
    },
  });

  // A real signed-in user holding exactly the two movement permissions, so the
  // run goes through the real authorization path rather than around it.
  const sys = await withPermissions([P.INVENTORY_ADJUST, P.STORE_ISSUE]);

  // Layers on, from yesterday.
  const from = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await prisma.configSetting.deleteMany({ where: { key: CONFIG_KEYS.COST_LAYERS_FROM, entityId: null } });
  await prisma.configSetting.create({
    data: {
      key: CONFIG_KEYS.COST_LAYERS_FROM,
      value: JSON.stringify(from),
      valueType: "string",
      label: "Cost layers begin (YYYY-MM-DD)",
      group: "Stores",
    },
  });

  const pol = await costingPolicy(null);
  check("layers active once a start date is set", pol.active, `from ${pol.from?.toISOString().slice(0, 10)}, method ${pol.method}`);
  check("method ships weighted average", pol.method === "WEIGHTED_AVERAGE");

  const base = {
    itemId: item.id,
    storeId: store.id,
    unit: "EA",
    performedById: user.id,
  };

  await postMovement(
    "RECEIPT",
    { ...base, quantity: 10, unitCost: 100, source: { kind: "ADJUSTMENT", ref: "TEST-R1" } },
    prisma,
    sys,
  );
  await postMovement(
    "RECEIPT",
    { ...base, quantity: 10, unitCost: 120, source: { kind: "ADJUSTMENT", ref: "TEST-R2" } },
    prisma,
    sys,
  );

  const layers = await prisma.costLayer.findMany({
    where: { itemId: item.id },
    orderBy: [{ receivedAt: "asc" }, { sequence: "asc" }],
  });
  check("two layers opened", layers.length === 2, layers.map((l) => `${l.quantityRemaining}@${l.unitCost}`).join(" then "));
  check("layers ordered oldest first", layers[0]?.unitCost === 100 && layers[1]?.unitCost === 120);
  check("layers carry a stable sequence", layers[0]!.sequence < layers[1]!.sequence);

  const bucket = await prisma.inventoryItem.findFirst({ where: { itemId: item.id, storeId: store.id } });
  check("weighted average is 110", bucket?.unitCost === 110, `bucket unitCost ${bucket?.unitCost}`);

  // The worked example: issue 12.
  const issue = await postMovement(
    "ISSUE",
    { ...base, quantity: 12, source: { kind: "ADJUSTMENT", ref: "TEST-I1" } },
    prisma,
    sys,
  );

  check("FIFO cost is 1240", issue.fifoValue === 1240, `fifoValue ${issue.fifoValue}`);
  check(
    "weighted average would have said 1320",
    issue.value === 1320,
    `ledger value ${issue.value} under ${issue.costingMethod}`,
  );
  check("the ledger says which method it used", issue.costingMethod === "WEIGHTED_AVERAGE");

  const cons = await consumptionsFor(issue.id);
  check("consumption split across two layers", cons.length === 2, cons.map((c) => `${c.quantity}@${c.unitCost}`).join(" + "));
  check(
    "consumption sums to the FIFO figure",
    Math.abs(cons.reduce((a, c) => a + c.value, 0) - 1240) < 0.01,
  );
  check("each consumption names its receipt", cons.every((c) => !!c.layer.sourceRef));

  const after = await prisma.costLayer.findMany({ where: { itemId: item.id }, orderBy: { receivedAt: "asc" } });
  check("first layer exhausted and closed", after[0]!.quantityRemaining === 0 && after[0]!.closedAt !== null);
  check("second layer holds the remaining 8", after[1]!.quantityRemaining === 8);

  const bal = await layerBalance({ itemId: item.id, storeId: store.id });
  check("layer balance is 8 @ 120 = 960", bal.quantity === 8 && bal.value === 960, `${bal.quantity} @ ${bal.unitCost}`);

  // A dry run must not move anything.
  const before = await prisma.costLayer.findMany({ where: { itemId: item.id }, select: { quantityRemaining: true } });
  const dry = await consumeLayers({ itemId: item.id, storeId: store.id }, 5, { dryRun: true });
  const unchanged = await prisma.costLayer.findMany({ where: { itemId: item.id }, select: { quantityRemaining: true } });
  check("dry run computes 5 @ 120 = 600", dry.value === 600, `value ${dry.value}`);
  check(
    "dry run writes nothing",
    JSON.stringify(before) === JSON.stringify(unchanged),
  );

  // Over-drawing reports the shortfall rather than valuing it at zero.
  const over = await consumeLayers({ itemId: item.id, storeId: store.id }, 20, { dryRun: true });
  check("over-draw reports what it could not cover", over.uncovered === 12 && over.covered === 8, `covered ${over.covered}, uncovered ${over.uncovered}`);
  check("over-draw values only the covered part", over.value === 960);

  // A return restores the original cost, not today's price.
  const restored = await returnToLayers(issue.id, 2);
  check("return restores 2 @ 120 = 240", restored === 240, `restored ${restored}`);
  const reopened = await prisma.costLayer.findMany({ where: { itemId: item.id }, orderBy: { receivedAt: "asc" } });
  check("the layer the units left is the one they go back to", reopened[1]!.quantityRemaining === 10);

  // The valuation report shows the gap.
  const val = await fifoValuation({ storeId: store.id });
  const row = val.find((r) => r.itemId === item.id);
  check("valuation lists the item", !!row, row ? `FIFO ${row.fifoValue} vs average ${row.averageValue}` : "");

  // Cleanup.
  await prisma.costLayerConsumption.deleteMany({ where: { layer: { itemId: item.id } } });
  await prisma.costLayer.deleteMany({ where: { itemId: item.id } });
  await prisma.auditLog.deleteMany({
    where: { entityType: "InventoryTransaction", entityId: { in: (await prisma.inventoryTransaction.findMany({ where: { itemId: item.id }, select: { id: true } })).map((t) => t.id) } },
  });
  await prisma.inventoryTransaction.deleteMany({ where: { itemId: item.id } });
  await prisma.inventoryItem.deleteMany({ where: { itemId: item.id } });
  await prisma.item.delete({ where: { id: item.id } });
  await prisma.configSetting.deleteMany({ where: { key: CONFIG_KEYS.COST_LAYERS_FROM, entityId: null } });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
