/**
 * Purchase order issuance, distribution and vendor acknowledgement — ZAM §4.6.
 *
 *   npx tsx scripts/verify-po-acknowledgement.ts
 */
import { prisma } from "../src/lib/db";
import { PERMISSIONS as P } from "../src/lib/permissions";
import { withPermissions, withoutPermissions, refused } from "./lib/actors";
import {
  recordPoDistribution,
  recordPoAcknowledgement,
  lapsePoAcknowledgements,
} from "../src/server/po";
import { systemActor } from "../src/lib/actor";

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
  const buyer = await withPermissions([P.PO_ISSUE, P.PO_EDIT]);
  const outsider = await withoutPermissions(P.PO_ISSUE, P.PO_EDIT);

  const template = await prisma.purchaseOrder.findFirst({
    where: { status: { in: ["ISSUED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!template) throw new Error("no issued purchase order to clone from");

  const created: string[] = [];
  const mk = async (status: string, dueAt: Date | null) => {
    const po = await prisma.purchaseOrder.create({
      data: {
        number: `TEST-PO-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        vendorId: template.vendorId,
        entityId: template.entityId,
        createdById: buyer.id,
        status,
        currency: template.currency,
        subtotal: 0,
        taxAmount: 0,
        total: 0,
        acknowledgementStatus: "PENDING",
        acknowledgementDueAt: dueAt,
        issuedAt: new Date(),
      },
    });
    created.push(po.id);
    return po;
  };

  const draft = await mk("DRAFT", null);
  const notIssued = await refused(
    recordPoDistribution(buyer, { poId: draft.id, channel: "EMAIL" }),
  );
  check("a draft order cannot be recorded as sent", !!notIssued, notIssued ?? "");

  const notIssuedAck = await refused(
    recordPoAcknowledgement(buyer, { poId: draft.id, state: "ACKNOWLEDGED", byName: "X" }),
  );
  check("nor can a draft be acknowledged", !!notIssuedAck, notIssuedAck ?? "");

  const po = await mk("ISSUED", null);

  const noPerm = await refused(recordPoDistribution(outsider, { poId: po.id, channel: "EMAIL" }));
  check("recording distribution needs the issue permission", !!noPerm);

  const dist = await recordPoDistribution(buyer, {
    poId: po.id,
    channel: "EMAIL",
    reference: "msg-8841",
  });
  check("how the order was sent is recorded", dist.distributionChannel === "EMAIL");
  check("with the evidence that it went", dist.distributionRef === "msg-8841" && !!dist.distributedAt);

  const backToPending = await refused(
    recordPoAcknowledgement(buyer, { poId: po.id, state: "PENDING" }),
  );
  check("pending cannot be recorded as an outcome", !!backToPending, backToPending ?? "");

  const anonymous = await refused(
    recordPoAcknowledgement(buyer, { poId: po.id, state: "ACKNOWLEDGED" }),
  );
  check("an acknowledgement must name who gave it", !!anonymous, anonymous ?? "");

  const silentRejection = await refused(
    recordPoAcknowledgement(buyer, { poId: po.id, state: "REJECTED" }),
  );
  check("a rejection must say why", !!silentRejection, silentRejection ?? "");

  const ack = await recordPoAcknowledgement(buyer, {
    poId: po.id,
    state: "ACKNOWLEDGED",
    byName: "Imran Sheikh",
  });
  check("the vendor's acknowledgement is recorded", ack.acknowledgementStatus === "ACKNOWLEDGED");
  check("with the name of who gave it", ack.acknowledgedByName === "Imran Sheikh");

  const audited = await prisma.auditLog.findFirst({
    where: { entityType: "PurchaseOrder", entityId: po.id, action: "PO_ACK_ACKNOWLEDGED" },
  });
  check("the acknowledgement is audited", !!audited);

  // The lapse job: silence becomes NO_RESPONSE, delivery becomes DEEMED.
  const yesterday = new Date(Date.now() - 86400000);
  const silent = await mk("ISSUED", yesterday);
  const delivered = await mk("PARTIALLY_RECEIVED", yesterday);
  const notYetDue = await mk("ISSUED", new Date(Date.now() + 86400000));

  const noGrant = await refused(lapsePoAcknowledgements(systemActor("MIGRATION")));
  check("a system principal without the grant cannot run the lapse", !!noGrant, noGrant ?? "");

  const outcome = await lapsePoAcknowledgements(systemActor("SCHEDULER"));
  check("the lapse job runs and reports both outcomes", outcome.noResponse + outcome.deemed >= 2, JSON.stringify(outcome));

  const after = await prisma.purchaseOrder.findMany({
    where: { id: { in: [silent.id, delivered.id, notYetDue.id] } },
    select: { id: true, acknowledgementStatus: true, acknowledgementNotes: true },
  });
  const by = new Map(after.map((r) => [r.id, r]));
  check(
    "silence past the window becomes NO_RESPONSE, not acknowledged",
    by.get(silent.id)?.acknowledgementStatus === "NO_RESPONSE",
    by.get(silent.id)?.acknowledgementStatus,
  );
  check(
    "an order delivered without a reply is deemed accepted through execution",
    by.get(delivered.id)?.acknowledgementStatus === "DEEMED_ACCEPTED_THROUGH_EXECUTION",
    by.get(delivered.id)?.acknowledgementStatus,
  );
  check(
    "and the two are never collapsed into ACKNOWLEDGED",
    by.get(silent.id)?.acknowledgementStatus !== "ACKNOWLEDGED" &&
      by.get(delivered.id)?.acknowledgementStatus !== "ACKNOWLEDGED",
  );
  check(
    "an order still inside its window is left alone",
    by.get(notYetDue.id)?.acknowledgementStatus === "PENDING",
    by.get(notYetDue.id)?.acknowledgementStatus,
  );
  check("each lapse says why it happened", !!by.get(silent.id)?.acknowledgementNotes);

  console.log(`
${pass} passed, ${fail} failed`);

  // Cleanup.
  await prisma.auditLog.deleteMany({ where: { entityType: "PurchaseOrder", entityId: { in: created } } });
  await prisma.purchaseOrder.deleteMany({ where: { id: { in: created } } });
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
