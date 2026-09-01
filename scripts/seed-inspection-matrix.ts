/**
 * Seeds the inspection responsibility chart from ZAM/PUR/SOP-01.
 *
 *   npx tsx scripts/seed-inspection-matrix.ts
 *
 * Store – Process Flow, Goods Receiving Flow step 2 prints twenty-one cells:
 * three inspection types by seven category groups, with Store, Admin or IT in
 * each. All twenty-one are written; none is inferred.
 *
 * The mapping from the system's own categories onto the chart's columns is a
 * separate question, and a harder one. Seven of the seventeen categories have an
 * obvious column; the rest — construction, MEP, machinery, vehicles, services —
 * are not on the chart at all. Those are left unmapped and reported, because the
 * chart having a Store column is not the same thing as the SOP saying Store
 * inspects rebar.
 *
 * Idempotent.
 */
import { prisma } from "../src/lib/db";
import {
  FUNCTION_ROLE_CODES,
  SOP_INSPECTION_MATRIX,
  type InspectionFunction,
} from "../src/server/inspection-matrix";

/**
 * System category code → the chart's column.
 *
 * Only where the correspondence is plain. `Giveaways` and `Electronic
 * Appliances` are columns on the chart with no category in the system, and most
 * of the system's categories are absent from the chart — both gaps are printed
 * rather than papered over.
 */
const CATEGORY_TO_GROUP: Record<string, string> = {
  "OFF-SUPPLY": "Stationery",
  FURN: "Furniture",
  PANTRY: "Housekeeping & Grocery",
  "IT-EQUIP": "IT / Network / Mobiles",
  "IT-PERIPH": "IT / Network / Mobiles",
  "MKT-MAT": "Printed Collateral",
};

const SOURCE = "ZAM/PUR/SOP-01 Store – Process Flow, Goods Receiving Flow step 2";

async function main() {
  let written = 0;
  let seq = 0;

  for (const row of SOP_INSPECTION_MATRIX) {
    const cells: Array<[string, InspectionFunction]> = [
      ["TECHNICAL", row.technical],
      ["QUALITATIVE", row.qualitative],
      ["QUANTITATIVE", row.quantitative],
    ];
    for (const [type, fn] of cells) {
      seq += 1;
      const data = {
        categoryGroup: row.group,
        inspectionType: type,
        ownerFunction: fn,
        ownerRoleCode: FUNCTION_ROLE_CODES[fn],
        sequence: seq,
        active: true,
        sourceReference: `${SOURCE} — ${row.group} / ${type.toLowerCase()} = ${fn}`,
      };
      const existing = await prisma.inspectionResponsibility.findFirst({
        where: { entityId: null, categoryGroup: row.group, inspectionType: type },
      });
      if (existing) {
        await prisma.inspectionResponsibility.update({ where: { id: existing.id }, data });
      } else {
        await prisma.inspectionResponsibility.create({ data: { ...data, entityId: null } });
      }
      written += 1;
    }
  }

  console.log(`${written} chart cells written.\n`);
  for (const row of SOP_INSPECTION_MATRIX) {
    console.log(
      `  ${row.group.padEnd(24)} technical ${row.technical.padEnd(6)} qualitative ${row.qualitative.padEnd(6)} quantitative ${row.quantitative}`,
    );
  }

  // Map the categories the chart actually covers.
  const categories = await prisma.category.findMany({
    select: { id: true, code: true, name: true, inspectionGroup: true },
    orderBy: { code: "asc" },
  });

  const mapped: string[] = [];
  const unmapped: string[] = [];
  for (const c of categories) {
    const group = CATEGORY_TO_GROUP[c.code];
    if (group) {
      if (c.inspectionGroup !== group) {
        await prisma.category.update({ where: { id: c.id }, data: { inspectionGroup: group } });
      }
      mapped.push(`  ${c.code.padEnd(14)} → ${group}`);
    } else {
      unmapped.push(`  ${c.code.padEnd(14)} ${c.name}`);
    }
  }

  console.log(`\n${mapped.length} categories mapped onto the chart:`);
  for (const m of mapped) console.log(m);

  const groupsWithoutCategory = SOP_INSPECTION_MATRIX.map((r) => r.group).filter(
    (g) => !Object.values(CATEGORY_TO_GROUP).includes(g),
  );

  console.log(`\n${unmapped.length} categories are NOT on the chart:`);
  for (const u of unmapped) console.log(u);
  console.log(
    "\nThese fall back to the existing template routing, and the inspection screen says so.\n" +
      "The chart covers office and consumable groups; it says nothing about construction,\n" +
      "MEP, machinery, vehicles or professional services, which is most of what this\n" +
      "business buys. Extending it is a business decision, not something to infer.",
  );

  if (groupsWithoutCategory.length) {
    console.log(`\n${groupsWithoutCategory.length} chart columns have no category in the system:`);
    for (const g of groupsWithoutCategory) console.log(`  ${g}`);
    console.log("Add a category and re-run this to point it at the column.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
