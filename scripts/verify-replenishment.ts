/**
 * Minimum stock and the replenishment loop — ZAM/PUR/SOP-01 §3.3 and Store Flow.
 *
 *   npx tsx scripts/verify-replenishment.ts
 */
import { prisma } from "../src/lib/db";
import { PERMISSIONS as P } from "../src/lib/permissions";
import { withPermissions, withoutPermissions, refused } from "./lib/actors";
import { postMovement } from "../src/server/inventory";
import {
  consumption,
  suggestMinimums,
  setMinimumStock,
  replenishmentQueue,
  alertBelowMinimum,
} from "../src/server/replenishment";

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
  const cat = await prisma.category.findFirst();
  if (!store || !cat) throw new Error("no store/category");

  const mover = await withPermissions([P.INVENTORY_ADJUST, P.STORE_ISSUE]);
  const setter = await withPermissions([P.MASTER_MANAGE]);
  const outsider = await withoutPermissions(P.MASTER_MANAGE, P.MASTER_DATA_MANAGE, P.INVENTORY_ADJUST);

  const stamp = Date.now();
  const item = await prisma.item.create({
    data: { sku: `REPL-${stamp}`, name: "Replenishment test item", unit: "EA", categoryId: cat.id },
  });
  const rare = await prisma.item.create({
    data: { sku: `REPL-RARE-${stamp}`, name: "Rarely issued item", unit: "EA", categoryId: cat.id },
  });

  const base = { storeId: store.id, unit: "EA", performedById: mover.id };
  const src = (ref: string) => ({ kind: "ADJUSTMENT" as const, ref });

  // 100 in, then four issues of 10 across the window.
  await postMovement("RECEIPT", { ...base, itemId: item.id, quantity: 100, unitCost: 50, source: src("REPL-IN") }, prisma, mover);
  for (let i = 0; i < 4; i++) {
    await postMovement("ISSUE", { ...base, itemId: item.id, quantity: 10, source: src(`REPL-OUT-${i}`) }, prisma, mover);
  }
  // The rare item moves once, which is not a pattern.
  await postMovement("RECEIPT", { ...base, itemId: rare.id, quantity: 20, unitCost: 10, source: src("RARE-IN") }, prisma, mover);
  await postMovement("ISSUE", { ...base, itemId: rare.id, quantity: 18, source: src("RARE-OUT") }, prisma, mover);

  const stats = await consumption({ itemIds: [item.id, rare.id], storeId: store.id });
  const s = stats.get(item.id);
  check("consumption counts what was issued", s?.issued === 40, `${s?.issued} issued over ${s?.days} days`);
  check("consumption counts the movements, not just the total", s?.movements === 4);
  check("a rate per day is derived", (s?.perDay ?? 0) > 0, `${s?.perDay}/day, ${s?.perMonth}/month`);

  const sug = await suggestMinimums([item.id, rare.id], { storeId: store.id });
  const forItem = sug.get(item.id)!;
  check("a minimum is suggested from history", forItem.suggested !== null, `${forItem.suggested} over ${forItem.leadTimeDays}+${forItem.safetyDays} days`);
  check(
    "the suggestion is lead time plus safety of average consumption",
    Math.abs((forItem.suggested ?? 0) - forItem.perDay * (forItem.leadTimeDays + forItem.safetyDays)) < 0.05,
  );
  const forRare = sug.get(rare.id)!;
  check("one issue is not a pattern, so no figure is offered", forRare.suggested === null, forRare.withheld ?? "");
  check("and it says why rather than going quiet", !!forRare.withheld);

  // Setting the minimum records its ground.
  const denied = await refused(
    setMinimumStock(outsider, { itemId: item.id, level: 25, basis: "CONSUMPTION" }),
  );
  check("setting a minimum needs permission", !!denied, denied ?? "");

  const noNote = await refused(
    setMinimumStock(setter, { itemId: item.id, level: 25, basis: "POC_ADVICE" }),
  );
  check("POC advice must name the POC", !!noNote, noNote ?? "");

  const badBasis = await refused(
    setMinimumStock(setter, { itemId: item.id, level: 25, basis: "GUESS" as never }),
  );
  check("an unnamed basis is refused", !!badBasis);

  const negative = await refused(
    setMinimumStock(setter, { itemId: item.id, level: -5, basis: "MANUAL" }),
  );
  check("a negative minimum is refused", !!negative);

  await setMinimumStock(setter, {
    itemId: item.id,
    level: 70,
    basis: "CONSUMPTION",
    note: "Four issues of 10 over the window.",
  });
  const saved = await prisma.item.findUnique({ where: { id: item.id } });
  check("the basis is stored with the number", saved?.minStockBasis === "CONSUMPTION" && saved?.reorderLevel === 70);
  check("and who set it, and when", saved?.minStockSetById === setter.id && !!saved?.minStockSetAt);

  const audited = await prisma.auditLog.findFirst({
    where: { entityType: "Item", entityId: item.id, action: "MIN_STOCK_SET" },
  });
  check("the change is audited", !!audited);

  // The queue.
  const queue = await replenishmentQueue({ storeId: store.id });
  const row = queue.find((r) => r.itemId === item.id);
  check("the item is below its minimum and listed", !!row, row ? `${row.available} available vs ${row.minimum}` : "");
  check("the queue carries the basis through", row?.basis === "CONSUMPTION");
  check(
    "the order quantity covers the shortfall plus a month",
    (row?.suggestedOrderQty ?? 0) > (row?.minimum ?? 0) - (row?.available ?? 0),
    `order ${row?.suggestedOrderQty}`,
  );

  // An item with no minimum set cannot be below one.
  const noMin = queue.find((r) => r.itemId === rare.id);
  check("an item with no minimum is not in the queue", !noMin);

  // Reserved stock does not count as cover.
  const bucket = await prisma.inventoryItem.findFirst({ where: { itemId: item.id, storeId: store.id } });
  await prisma.inventoryItem.update({ where: { id: bucket!.id }, data: { reservedQty: 30 } });
  const q2 = await replenishmentQueue({ storeId: store.id });
  const r2 = q2.find((r) => r.itemId === item.id);
  check("reserved stock is not counted as cover", r2?.available === (row?.available ?? 0) - 30, `available now ${r2?.available}`);
  await prisma.inventoryItem.update({ where: { id: bucket!.id }, data: { reservedQty: 0 } });

  // The alert.
  const told = await alertBelowMinimum(item.id, store.id, { triggeredBy: "TEST" });
  check("reaching the minimum alerts somebody", told > 0, `${told} notified`);

  // Above the minimum, nobody is told.
  await setMinimumStock(setter, { itemId: item.id, level: 5, basis: "MANUAL" });
  const quiet = await alertBelowMinimum(item.id, store.id, { triggeredBy: "TEST" });
  check("comfortable stock alerts nobody", quiet === 0);

  // Cleanup.
  const ids = (await prisma.inventoryTransaction.findMany({ where: { itemId: { in: [item.id, rare.id] } }, select: { id: true } })).map((t) => t.id);
  await prisma.notification.deleteMany({ where: { type: "STOCK_BELOW_MINIMUM", linkUrl: { contains: store.id } } });
  await prisma.costLayerConsumption.deleteMany({ where: { layer: { itemId: { in: [item.id, rare.id] } } } });
  await prisma.costLayer.deleteMany({ where: { itemId: { in: [item.id, rare.id] } } });
  await prisma.auditLog.deleteMany({ where: { entityType: "InventoryTransaction", entityId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { entityType: "Item", entityId: { in: [item.id, rare.id] } } });
  await prisma.inventoryTransaction.deleteMany({ where: { itemId: { in: [item.id, rare.id] } } });
  await prisma.inventoryItem.deleteMany({ where: { itemId: { in: [item.id, rare.id] } } });
  await prisma.item.deleteMany({ where: { id: { in: [item.id, rare.id] } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
