import { prisma } from "@/lib/db";

/**
 * One-off correction: audit rows written by automated sweeps before the actor
 * default existed carry no actor name. The trail is append-only in the domain
 * sense — no row is removed and no action is rewritten — but an anonymous actor
 * field is filled in so every line names who or what acted.
 */
async function main() {
  const anonymous = await prisma.auditLog.findMany({
    where: { OR: [{ actorName: null }, { actorName: "" }] },
    select: { id: true, action: true, entityRef: true },
  });
  for (const row of anonymous) {
    await prisma.auditLog.update({
      where: { id: row.id },
      data: { actorName: "System", actorRoles: "Automated" },
    });
    console.log(`attributed ${row.action} on ${row.entityRef ?? "record"} to System`);
  }
  console.log(`${anonymous.length} audit row(s) corrected.`);
  await prisma.$disconnect();
}

main();
