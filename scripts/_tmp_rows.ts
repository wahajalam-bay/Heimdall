import { prisma } from "../src/lib/db";
async function main() {
  const pairs: Array<[string, Promise<number>]> = [
    ["permissions", prisma.permission.count()],
    ["users", prisma.user.count()],
    ["vendors", prisma.vendor.count()],
    ["requisitions", prisma.purchaseRequisition.count()],
    ["purchase orders", prisma.purchaseOrder.count()],
    ["audit events", prisma.auditLog.count()],
  ];
  for (const [k, v] of pairs) console.log(`  ${k.padEnd(16)} ${await v}`);
  await prisma.$disconnect();
}
main();
