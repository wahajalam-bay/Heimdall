/**
 * Annexure 4's two signature blocks — ZAM/PUR/SOP-01 §3.2, §4.7, image17.png.
 *
 *   npx tsx scripts/verify-annexure4.ts
 */
import { prisma } from "../src/lib/db";
import { PERMISSIONS as P } from "../src/lib/permissions";
import { sessionFor, withPermissions, withoutPermissions, refused } from "./lib/actors";
import { signAnnexure4, annexure4Signatures } from "../src/server/receiving";

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
  const receiver = await withPermissions([P.RECEIVE_GOODS]);
  const inspector = await withPermissions([P.INSPECTION_PERFORM]);
  const outsider = await withoutPermissions(P.RECEIVE_GOODS, P.GRN_POST, P.PR_APPROVE);

  const pocUser = await prisma.user.findFirst({
    where: { active: true, id: { notIn: [receiver.id, inspector.id, outsider.id] } },
  });
  if (!pocUser) throw new Error("no fourth user");
  const poc = await sessionFor(pocUser.email);

  const po = await prisma.purchaseOrder.findFirst({
    where: { items: { some: {} } },
    include: { items: { take: 1 } },
    orderBy: { createdAt: "desc" },
  });
  if (!po?.items.length) throw new Error("no purchase order");

  const created: string[] = [];
  const mk = async (pocId: string | null) => {
    const insp = await prisma.inspection.create({
      data: {
        number: `TEST-A4-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        poId: po.id,
        inspectionType: "GENERAL",
        result: "PENDING",
        receivedDate: new Date(),
        concernedPocId: pocId,
        items: {
          create: [
            {
              poItemId: po.items[0]!.id,
              itemId: po.items[0]!.itemId,
              lineNo: 1,
              description: po.items[0]!.description,
              quantityInspected: 10,
              quantityPassed: 8,
              quantityFailed: 2,
              verdict: "CONDITIONAL",
            },
          ],
        },
      },
    });
    created.push(insp.id);
    return insp;
  };

  const insp = await mk(pocUser.id);

  // Logistics block.
  const noReceive = await refused(signAnnexure4(outsider, { inspectionId: insp.id, block: "LOGISTICS" }));
  check("the Logistics block needs receiving authority", !!noReceive, noReceive ?? "");

  const log = await signAnnexure4(receiver, { inspectionId: insp.id, block: "LOGISTICS" });
  check("whoever received the goods can sign it", log.attestationType === "PREPARED");
  check("the block is named on the signature", !!log.comment?.includes("Logistics"), log.comment ?? "");
  check("the office held at signing is captured", !!log.roleAtSigning || !!log.designation, log.designation ?? log.roleAtSigning ?? "");
  check("the line totals are hashed as signed", !!log.documentHash, log.documentHash?.slice(0, 12));

  const twice = await refused(signAnnexure4(receiver, { inspectionId: insp.id, block: "LOGISTICS" }));
  check("a block cannot be signed twice", !!twice, twice ?? "");

  // Department block — the POC, not the inspector.
  const notPoc = await refused(signAnnexure4(inspector, { inspectionId: insp.id, block: "DEPARTMENT" }));
  check("the inspector cannot sign the department's block", !!notPoc, notPoc ?? "");

  const alsoNotReceiver = await refused(
    signAnnexure4(receiver, { inspectionId: insp.id, block: "DEPARTMENT" }),
  );
  check("nor can the person who received the goods", !!alsoNotReceiver);

  const dept = await signAnnexure4(poc, { inspectionId: insp.id, block: "DEPARTMENT" });
  check("the named POC can sign it", dept.attestationType === "REVIEWED" && dept.signedById === pocUser.id);

  const sigs = await annexure4Signatures(insp.id);
  check("both blocks read back separately", !!sigs.logistics && !!sigs.department);
  check(
    "and they are different people",
    sigs.logistics?.name !== sigs.department?.name,
    `${sigs.logistics?.name} / ${sigs.department?.name}`,
  );

  const audited = await prisma.auditLog.count({
    where: { entityType: "Inspection", entityId: insp.id, action: { startsWith: "ANNEXURE_4_" } },
  });
  check("both signatures are audited", audited === 2, `${audited} entries`);

  // With no POC appointed, the department head may sign, and only them.
  const noPocInsp = await mk(null);
  // `outsider` is built without pr.approve, so this exercises the rule rather
  // than whichever permissions the inspector fixture happens to carry.
  const stillNo = await refused(signAnnexure4(outsider, { inspectionId: noPocInsp.id, block: "DEPARTMENT" }));
  check("with no POC appointed, somebody without approval authority is still refused", !!stillNo, stillNo ?? "");

  const hod = await withPermissions([P.PR_APPROVE]);
  const byHod = await signAnnexure4(hod, { inspectionId: noPocInsp.id, block: "DEPARTMENT" });
  check("the department head can stand in when no POC exists", byHod.attestationType === "REVIEWED");

  // Cleanup.
  await prisma.attestation.deleteMany({ where: { documentType: "INSPECTION", documentId: { in: created } } });
  await prisma.auditLog.deleteMany({ where: { entityType: "Inspection", entityId: { in: created } } });
  await prisma.inspectionItem.deleteMany({ where: { inspectionId: { in: created } } });
  await prisma.inspection.deleteMany({ where: { id: { in: created } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
