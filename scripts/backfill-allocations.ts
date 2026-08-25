/**
 * Fills in the PR↔PO allocation table for orders raised before it existed.
 *
 *   npx tsx scripts/backfill-allocations.ts
 */
import { prisma } from "../src/lib/db";
import { backfillAllocations } from "../src/server/allocations";

async function main() {
  const result = await backfillAllocations();
  console.log(`\nScanned ${result.scanned} order line(s) carrying a requisition line.`);
  console.log(`  created  ${result.created} allocation(s)`);
  console.log(`  skipped  ${result.skipped} (no requisition could be resolved)`);

  const total = await prisma.prPoAllocation.count();
  const spread = await prisma.prPoAllocation.groupBy({ by: ["prId"], _count: { _all: true } });
  const multi = spread.filter((s) => s._count._all > 1).length;
  console.log(`\n${total} allocation(s) on file; ${multi} requisition(s) span more than one order line.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
