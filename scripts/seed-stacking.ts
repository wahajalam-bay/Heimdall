/**
 * Seeds Annexure 5's Table 1.1 — the ten main categories for stacking of goods.
 *
 *   npx tsx scripts/seed-stacking.ts
 *
 * RC-016 names all ten. This is a second taxonomy, not the procurement category
 * tree: the catalogue category decides who inspects a thing and how it is
 * accounted for, and the stacking category decides where in the warehouse it
 * goes and what it may sit beside. That is why the existing tree does not match
 * the table, and why folding one into the other would break both.
 *
 * The guidance on each row is Annexure 5's own text for that class of goods. Four
 * of the annexure's rules are checkable from what a stacking record says, so they
 * are flags; the rest is guidance shown to whoever is stacking.
 *
 * It also maps the catalogue's categories onto the table where the correspondence
 * is unambiguous, and reports the ones where it is not rather than guessing.
 *
 * Idempotent.
 */
import { prisma } from "../src/lib/db";

type Row = {
  code: string;
  name: string;
  guidance: string;
  requiresSecureStorage?: boolean;
  requiresPallet?: boolean;
  keepFromElectrical?: boolean;
  groundLevelOnly?: boolean;
  /** Catalogue category codes that clearly belong to this stacking class. */
  catalogueCodes?: string[];
};

const TABLE_1_1: Row[] = [
  {
    code: "STK-ELT",
    name: "Electronics",
    guidance:
      "Stack in designated stackable areas with category-wise indicators. Keep away from liquids. High-value electronics go to a strong cabinet or strong room with entry and exit management.",
    requiresSecureStorage: true,
    catalogueCodes: ["IT-PERIPH"],
  },
  {
    code: "STK-HDW",
    name: "Hardware",
    guidance:
      "Heavy hardware at ground level. Use hand-jack pallets for heavy loads and portable stairways where height is unavoidable.",
    groundLevelOnly: true,
    catalogueCodes: ["MEP-ELEC", "MEP-PLUMB"],
  },
  {
    code: "STK-GRO",
    name: "Grocery",
    guidance:
      "FIFO, and FEFO where an expiry date applies. Liquids on wooden pallets. Maintain distance from other categories to avoid mixing.",
    requiresPallet: true,
    catalogueCodes: ["PANTRY"],
  },
  {
    code: "STK-HKG",
    name: "Housekeeping",
    guidance:
      "Liquids and chemicals on wooden pallets, away from wires and electrical appliances. Not near doors or walkways.",
    requiresPallet: true,
    keepFromElectrical: true,
  },
  {
    code: "STK-STA",
    name: "Stationery",
    guidance:
      "FIFO. Slow-moving stationery to aisle storage, with the decision taken on historic consumption data.",
    catalogueCodes: ["OFF-SUPPLY"],
  },
  {
    code: "STK-GIV",
    name: "Giveaways",
    guidance:
      "Keep in designated areas with category-wise indicators. Branded giveaways are attractive stock — keep them where entry is controlled.",
    requiresSecureStorage: true,
  },
  {
    code: "STK-ITE",
    name: "IT Equipment",
    guidance:
      "Handsets, laptops and other high-value goods in strong cabinets or a strong room with entry and exit management. Only authorised persons in the stacking area.",
    requiresSecureStorage: true,
    catalogueCodes: ["IT-EQUIP"],
  },
  {
    code: "STK-FUR",
    name: "Furniture & Fixture",
    guidance:
      "Heavy items at ground level. Use in-house or packing services support when moving assembled furniture. Keep aisles clear.",
    groundLevelOnly: true,
    catalogueCodes: ["FURN"],
  },
  {
    code: "STK-BRD",
    name: "Branding Material",
    guidance:
      "Store flat or rolled as the material requires, away from damp. Keep empty boxes stacked separately.",
    catalogueCodes: ["MKT-MAT"],
  },
  {
    code: "STK-PRN",
    name: "Printing Material",
    guidance:
      "FIFO. Keep away from damp and from wires or electrical appliances. Communicate stacking instructions for new goods to all warehouses.",
    keepFromElectrical: true,
  },
];

async function main() {
  console.log("\nAnnexure 5 · Table 1.1 — Main Categories for Stacking of Goods\n");

  const byCode = new Map<string, string>();
  for (const [i, row] of TABLE_1_1.entries()) {
    const data = {
      name: row.name,
      guidance: row.guidance,
      requiresSecureStorage: row.requiresSecureStorage ?? false,
      requiresPallet: row.requiresPallet ?? false,
      keepFromElectrical: row.keepFromElectrical ?? false,
      groundLevelOnly: row.groundLevelOnly ?? false,
      sequence: (i + 1) * 10,
      active: true,
    };
    const existing = await prisma.stackingCategory.findUnique({ where: { code: row.code } });
    const saved = existing
      ? await prisma.stackingCategory.update({ where: { id: existing.id }, data })
      : await prisma.stackingCategory.create({ data: { ...data, code: row.code } });
    byCode.set(row.code, saved.id);

    const flags = [
      row.requiresSecureStorage ? "secure" : null,
      row.requiresPallet ? "pallet" : null,
      row.groundLevelOnly ? "ground level" : null,
      row.keepFromElectrical ? "away from electrical" : null,
    ].filter(Boolean);
    console.log(`  ${row.name.padEnd(22)} ${flags.length ? flags.join(", ") : "no checkable flags"}`);
  }
  console.log(`\n${TABLE_1_1.length} stacking categories written.\n`);

  // ── Map the catalogue onto the table where it is unambiguous ─────────────
  let mapped = 0;
  for (const row of TABLE_1_1) {
    if (!row.catalogueCodes?.length) continue;
    const stackingCategoryId = byCode.get(row.code)!;
    for (const code of row.catalogueCodes) {
      const category = await prisma.category.findFirst({ where: { code } });
      if (!category) continue;
      const result = await prisma.item.updateMany({
        where: { categoryId: category.id, stackingCategoryId: null },
        data: { stackingCategoryId },
      });
      if (result.count) {
        mapped += result.count;
        console.log(`  ${code.padEnd(12)} → ${row.name.padEnd(22)} ${result.count} item(s)`);
      }
    }
  }
  console.log(`\n${mapped} item(s) classified from an unambiguous catalogue match.`);

  const unclassified = await prisma.item.findMany({
    where: { active: true, stackingCategoryId: null },
    select: { sku: true, category: { select: { code: true, name: true } } },
  });
  if (unclassified.length) {
    const byCategory = new Map<string, number>();
    for (const u of unclassified) {
      byCategory.set(u.category.code, (byCategory.get(u.category.code) ?? 0) + 1);
    }
    console.log(`\n${unclassified.length} item(s) still unclassified, by catalogue category:`);
    for (const [code, count] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${code.padEnd(16)} ${count}`);
    }
    console.log(
      "\nThese have no unambiguous home in Table 1.1 — construction, MEP, machinery,",
    );
    console.log(
      "vehicles, safety equipment and services are not among the annexure's ten. Left",
    );
    console.log(
      "unclassified rather than forced into the nearest name: a wrong stacking category",
    );
    console.log("gives a storekeeper wrong guidance, which is worse than none.\n");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
