/**
 * Seeds the demand layer by driving the real services.
 *
 * Nothing here inserts rows directly: each requirement is created, checked and
 * routed through the same functions the screens call, so a green run is evidence
 * the rule works rather than evidence the fixture was written carefully.
 *
 * Three cases are built deliberately — one the stores can meet in full, one they
 * can only part-cover, and one held in no store at all — because those are the
 * three branches of the inventory-first rule and a demo that only shows the happy
 * one proves nothing.
 *
 *   npx tsx scripts/seed-requirements.ts
 */
import { prisma } from "../src/lib/db";
import { sessionFor } from "./lib/actors";
import { createRequirement, decideFulfilment, runStockCheck } from "../src/server/requirements";
import { round2 } from "../src/lib/format";

const ACTOR = process.env.SEED_ACTOR ?? "system.admin@zameen.com";

async function main() {
  const user = await sessionFor(ACTOR);

  const entityId = user.primaryEntityId ?? user.entityIds[0];
  if (!entityId) throw new Error("The seeding actor has no entity.");

  const department =
    (await prisma.department.findFirst({ where: { entityId, active: true }, orderBy: { name: "asc" } })) ?? null;
  if (!department) throw new Error("No department to raise against.");

  const store = await prisma.store.findFirst({ where: { entityId, active: true }, orderBy: { code: "asc" } });
  if (!store) throw new Error("No store in this entity.");

  // Items that actually have free stock in this store, so the "from stock" case
  // is real rather than asserted.
  const stocked = await prisma.inventoryItem.findMany({
    where: { storeId: store.id, quantity: { gt: 0 } },
    include: { item: { select: { id: true, sku: true, name: true, unit: true, categoryId: true } } },
    orderBy: { quantity: "desc" },
    take: 4,
  });
  const free = stocked
    .map((r) => ({ ...r, available: round2(r.quantity - r.reservedQty) }))
    .filter((r) => r.available > 0);

  if (!free.length) {
    console.log(`No free stock in ${store.code}. Seeding the procurement-only case alone.`);
  }

  const unstocked = await prisma.item.findFirst({
    where: { active: true, inventory: { none: { storeId: store.id, quantity: { gt: 0 } } } },
    select: { id: true, sku: true, name: true, unit: true, categoryId: true },
  });

  const required = new Date(Date.now() + 21 * 86400000);
  const made: Array<{ number: string; outcome: string; detail: string }> = [];

  /* ── 1. Fully met from stock ── */
  if (free[0]) {
    const line = free[0];
    const qty = Math.max(1, Math.floor(line.available / 2));
    const r = await createRequirement(
      user,
      {
        entityId,
        departmentId: department.id,
        title: `Replacement ${line.item.name.toLowerCase()} for ${department.name}`,
        purpose: "Routine replacement of worn items.",
        justification: "Existing units are past their serviceable life.",
        requiredDate: required,
        storeId: store.id,
        items: [
          {
            itemId: line.item.id,
            categoryId: line.item.categoryId,
            description: line.item.name,
            quantity: qty,
            unit: line.item.unit,
            estimatedUnitCost: line.unitCost || null,
          },
        ],
        submit: true,
      },
    );
    const check = await runStockCheck(user, r.id);
    const outcome = await decideFulfilment(user, r.id, {
      lines: check.lines.map((l) => ({
        requirementItemId: l.requirementItemId,
        fromStockQty: l.fromStockQty,
        procureQty: l.procureQty,
        sourceStoreId: l.sourceStoreId,
      })),
    });
    made.push({
      number: r.number,
      outcome: outcome.status,
      detail: `${qty} ${line.item.unit} of ${line.item.sku} → ${outcome.storeIssueNumber ?? "no requisition"}`,
    });
  }

  /* ── 2. Part stock, part purchase ── */
  if (free[1]) {
    const line = free[1];
    const qty = round2(line.available + 5);
    const r = await createRequirement(
      user,
      {
        entityId,
        departmentId: department.id,
        title: `Additional ${line.item.name.toLowerCase()} — partial stock cover`,
        purpose: "Expansion of the floor's seating.",
        justification: "Headcount growth for the new quarter.",
        requiredDate: required,
        storeId: store.id,
        priority: "HIGH",
        items: [
          {
            itemId: line.item.id,
            categoryId: line.item.categoryId,
            description: line.item.name,
            quantity: qty,
            unit: line.item.unit,
            estimatedUnitCost: line.unitCost || null,
          },
        ],
        submit: true,
      },
    );
    const check = await runStockCheck(user, r.id);
    const outcome = await decideFulfilment(user, r.id, {
      lines: check.lines.map((l) => ({
        requirementItemId: l.requirementItemId,
        fromStockQty: l.fromStockQty,
        procureQty: l.procureQty,
        sourceStoreId: l.sourceStoreId,
      })),
    });
    made.push({
      number: r.number,
      outcome: outcome.status,
      detail: `${qty} needed, ${check.lines[0].fromStockQty} from stock → ${[outcome.storeIssueNumber, outcome.requisitionNumber].filter(Boolean).join(" + ")}`,
    });
  }

  /* ── 3. Nothing on the shelf ── */
  if (unstocked) {
    const r = await createRequirement(
      user,
      {
        entityId,
        departmentId: department.id,
        title: `${unstocked.name} — not held in stock`,
        purpose: "Required for a new installation.",
        justification: "No equivalent item is carried by any store.",
        requiredDate: required,
        storeId: store.id,
        items: [
          {
            itemId: unstocked.id,
            categoryId: unstocked.categoryId,
            description: unstocked.name,
            quantity: 4,
            unit: unstocked.unit,
            estimatedUnitCost: 25000,
          },
        ],
        submit: true,
      },
    );
    const check = await runStockCheck(user, r.id);
    const outcome = await decideFulfilment(user, r.id, {
      lines: check.lines.map((l) => ({
        requirementItemId: l.requirementItemId,
        fromStockQty: l.fromStockQty,
        procureQty: l.procureQty,
        sourceStoreId: l.sourceStoreId,
      })),
    });
    made.push({
      number: r.number,
      outcome: outcome.status,
      detail: `4 ${unstocked.unit} of ${unstocked.sku} → ${outcome.requisitionNumber ?? "no requisition"}`,
    });
  }

  console.log(`\nSeeded ${made.length} requirement(s) as ${user.name} in ${store.code}:\n`);
  for (const m of made) {
    console.log(`  ${m.number.padEnd(16)} ${m.outcome.padEnd(22)} ${m.detail}`);
  }

  const holds = await prisma.inventoryReservation.count({ where: { status: "ACTIVE" } });
  const heldQty = await prisma.inventoryReservation.aggregate({
    where: { status: "ACTIVE" },
    _sum: { quantity: true },
  });
  console.log(`\n${holds} active reservation(s) holding ${round2(heldQty._sum.quantity ?? 0)} unit(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
