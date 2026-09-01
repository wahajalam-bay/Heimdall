/**
 * The receiver's signature on an issuance slip — ZAM/PUR/SOP-01 Store Flow (b).
 *
 *   npx tsx scripts/verify-issuance-slip.ts
 */
import { prisma } from "../src/lib/db";
import { PERMISSIONS as P } from "../src/lib/permissions";
import { sessionFor, withPermissions, withoutPermissions, refused } from "./lib/actors";
import { acknowledgeIssue, recordPaperAcknowledgement, issueAttestations } from "../src/server/stores";

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
  const store = await prisma.store.findFirst({ where: { active: true } });
  const cat = await prisma.category.findFirst();
  if (!store || !cat) throw new Error("no store/category");

  const keeper = await withPermissions([P.STORE_ISSUE]);
  const other = await withoutPermissions(P.STORE_ISSUE, P.SR_ISSUE);
  const recipient = await prisma.user.findFirst({
    where: { active: true, id: { notIn: [keeper.id, other.id] } },
  });
  if (!recipient) throw new Error("no third user");
  const recipientSession = await sessionFor(recipient.email);

  const item = await prisma.item.create({
    data: { sku: `SLIP-${Date.now()}`, name: "Slip test item", unit: "EA", categoryId: cat.id },
  });

  const mk = async (status: string, withUser: boolean) =>
    prisma.storeIssue.create({
      data: {
        number: `TEST-SLIP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        storeId: store.id,
        requestedById: keeper.id,
        recipientName: withUser ? recipient.name : "Ali from Facilities",
        recipientUserId: withUser ? recipient.id : null,
        status,
        issuedAt: status === "ISSUED" ? new Date() : null,
        issuedById: status === "ISSUED" ? keeper.id : null,
        items: {
          create: [
            { lineNo: 1, itemId: item.id, requestedQty: 5, approvedQty: 5, issuedQty: 5, unit: "EA" },
          ],
        },
      },
    });

  const created: string[] = [];

  // Not yet issued: nothing to sign for.
  const draft = await mk("APPROVED", true);
  created.push(draft.id);
  const early = await refused(acknowledgeIssue(recipientSession, { issueId: draft.id }));
  check("an unissued requisition has nothing to acknowledge", !!early, early ?? "");

  // The named recipient signs.
  const issued = await mk("ISSUED", true);
  created.push(issued.id);

  const wrongHand = await refused(acknowledgeIssue(keeper, { issueId: issued.id }));
  check("the storekeeper cannot sign for the receiver", !!wrongHand, wrongHand ?? "");

  const outsider = await refused(acknowledgeIssue(other, { issueId: issued.id }));
  check("nor can anybody else", !!outsider);

  const signed = await acknowledgeIssue(recipientSession, {
    issueId: issued.id,
    comment: "Collected in full.",
  });
  check("the named recipient can sign", signed.attestationType === "ACKNOWLEDGED");
  check("the signature names who signed", signed.signedById === recipient.id);
  check("and the office they held at the time", !!signed.roleAtSigning || !!signed.designation, signed.designation ?? signed.roleAtSigning ?? "");
  check(
    "the issued quantities are hashed, so a later edit is detectable",
    !!signed.documentHash,
    signed.documentHash?.slice(0, 12),
  );

  const twice = await refused(acknowledgeIssue(recipientSession, { issueId: issued.id }));
  check("it cannot be signed twice", !!twice, twice ?? "");

  const audited = await prisma.auditLog.findFirst({
    where: { entityType: "StoreIssue", entityId: issued.id, action: "STORE_ISSUE_ACKNOWLEDGED" },
  });
  check("the acknowledgement is audited", !!audited);

  // A receiver who is not a system user.
  const paper = await mk("ISSUED", false);
  created.push(paper.id);

  const cannotSign = await refused(acknowledgeIssue(recipientSession, { issueId: paper.id }));
  check("a non-user recipient cannot sign in the system", !!cannotSign, cannotSign ?? "");

  const noPerm = await refused(
    recordPaperAcknowledgement(other, { issueId: paper.id, signatoryName: "Ali" }),
  );
  check("recording a slip needs the issue permission", !!noPerm);

  const noName = await refused(
    recordPaperAcknowledgement(keeper, { issueId: paper.id, signatoryName: "  " }),
  );
  check("a slip with no signatory is refused", !!noName, noName ?? "");

  const transcribed = await recordPaperAcknowledgement(keeper, {
    issueId: paper.id,
    signatoryName: "Ali from Facilities",
    signedOn: new Date("2026-08-20"),
    slipRef: "SL-4471",
  });
  check("a signed paper slip can be recorded", transcribed.attestationType === "ACKNOWLEDGED");
  check("the slip reference is kept", transcribed.stampRef === "SL-4471");
  check(
    "the record says who signed and who transcribed it",
    !!transcribed.comment?.includes("Ali from Facilities") && !!transcribed.comment?.includes(keeper.name),
    transcribed.comment ?? "",
  );

  const sigs = await issueAttestations(paper.id);
  check("the slip's signatures read back", sigs.length === 1);

  // Cleanup.
  await prisma.attestation.deleteMany({ where: { documentType: "STORE_ISSUE", documentId: { in: created } } });
  await prisma.auditLog.deleteMany({ where: { entityType: "StoreIssue", entityId: { in: created } } });
  await prisma.storeIssueItem.deleteMany({ where: { issueId: { in: created } } });
  await prisma.storeIssue.deleteMany({ where: { id: { in: created } } });
  await prisma.item.delete({ where: { id: item.id } });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
