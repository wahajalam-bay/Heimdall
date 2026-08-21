import { prisma } from "../src/lib/db";
async function main() {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    "SELECT count(*)::bigint AS n FROM information_schema.tables WHERE table_schema='public'",
  );
  console.log("tables in public:", Number(rows[0].n));
  for (const [label, count] of [
    ["permissions", prisma.permission.count()],
    ["roles", prisma.role.count()],
    ["users", prisma.user.count()],
    ["entities", prisma.entity.count()],
    ["vendors", prisma.vendor.count()],
    ["requisitions", prisma.purchaseRequisition.count()],
  ] as const) {
    console.log(`  ${label.padEnd(14)} ${await count}`);
  }
  await prisma.$disconnect();
}
main();
