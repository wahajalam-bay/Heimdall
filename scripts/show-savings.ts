/** Prints recorded procurement savings. npx tsx scripts/show-savings.ts */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function run() {
  const rows = await prisma.savingsRecord.findMany({ include: { po: { select: { number: true } } }, orderBy: { recordedAt: "desc" } });
  const m = (n: number | null) => (n === null ? "—" : `PKR ${Math.round(n).toLocaleString("en-PK")}`);
  process.stdout.write("\nProcurement savings\n\n");
  for (const s of rows) {
    process.stdout.write(
      `  ${(s.po?.number ?? "").padEnd(15)} ${s.itemDescription.slice(0, 40).padEnd(40)} market ${m(s.marketPrice).padStart(18)} prev ${m(s.previousPrice).padStart(18)} quote ${m(s.initialQuote).padStart(18)} final ${m(s.finalPrice).padStart(18)} saved ${m(s.totalSavings).padStart(14)} (${s.savingsPercent}%) ${s.savingsType}\n`,
    );
  }
  const total = rows.reduce((a, r) => a + r.totalSavings, 0);
  process.stdout.write(`\n  Total recorded savings: ${m(total)}\n\n`);
  const comps = await prisma.comparative.findMany({ where: { savingsAmount: { gt: 0 } }, select: { number: true, savingsAmount: true, savingsPercent: true } });
  process.stdout.write("Comparative-level savings\n");
  for (const c of comps) process.stdout.write(`  ${c.number} ${m(c.savingsAmount).padStart(16)} (${c.savingsPercent}%)\n`);
  process.stdout.write("\n");
  await prisma.$disconnect();
}
run();
