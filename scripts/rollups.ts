/**
 * Recomputes the derived figures.
 *
 * Vendor performance and the missing-GRN sweep are rollups over recorded
 * transactions, not stored opinions — they have to be recomputed after any bulk
 * load, and they are the last thing the seed does. Kept as its own script so a
 * failed rollup never means re-seeding the whole database.
 *
 *   npx tsx scripts/rollups.ts
 */
import { prisma } from "../src/lib/db";
import { recomputeAllVendorPerformance } from "../src/server/vendors";
import { sweepMissingGrns } from "../src/server/grn";

async function main() {
  console.log("\nRecomputing rollups\n");

  await recomputeAllVendorPerformance(12, prisma);
  const scored = await prisma.vendorPerformance.count();
  console.log(`  vendor performance recomputed — ${scored} period record(s)`);

  const raised = await sweepMissingGrns(prisma);
  console.log(`  missing-GRN sweep: ${raised} order(s) flagged as received without a GRN`);

  console.log("");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  await prisma.$disconnect();
  process.exit(1);
});
