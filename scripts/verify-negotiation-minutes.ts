/**
 * Negotiation Minutes — ZAM/PUR/SOP-01 §4.5.1.
 *
 *   npx tsx scripts/verify-negotiation-minutes.ts
 */
import { prisma } from "../src/lib/db";
import { PERMISSIONS as P } from "../src/lib/permissions";
import { withPermissions, withoutPermissions, refused } from "./lib/actors";
import {
  createNegotiationMinute,
  recordBasis,
  finaliseNegotiationMinute,
  minutesFor,
  minuteSignatures,
  SOP_BASES,
} from "../src/server/negotiation-minutes";

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
  const buyer = await withPermissions([P.NEGOTIATE]);
  const outsider = await withoutPermissions(P.NEGOTIATE);

  const rfq = await prisma.rfq.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true, prId: true } });
  const vendor = await prisma.vendor.findFirst({ select: { id: true, name: true } });
  if (!rfq || !vendor) throw new Error("no rfq/vendor");

  const people = [
    { side: "COMPANY" as const, userId: buyer.id, name: buyer.name, designation: "Procurement" },
    { side: "VENDOR" as const, vendorId: vendor.id, name: "Imran Sheikh", designation: "Sales Manager" },
  ];
  const base = { rfqId: rfq.id, heldAt: new Date(Date.now() - 3600_000), participants: people };

  const noPerm = await refused(createNegotiationMinute(outsider, base));
  check("recording minutes needs the negotiate permission", !!noPerm, noPerm ?? "");

  const noVendor = await refused(
    createNegotiationMinute(buyer, { ...base, participants: [people[0]!] }),
  );
  check("minutes need somebody on each side", !!noVendor, noVendor ?? "");

  const future = await refused(
    createNegotiationMinute(buyer, { ...base, heldAt: new Date(Date.now() + 86400000) }),
  );
  check("a future date is refused — these are minutes, not a plan", !!future, future ?? "");

  const noParent = await refused(
    createNegotiationMinute(buyer, { ...base, rfqId: null, prId: null }),
  );
  check("minutes must belong to an RFQ or requisition", !!noParent);

  const minute = await createNegotiationMinute(buyer, base);
  check("minutes are opened as a draft", minute.status === "DRAFT", minute.number);

  const bases = await prisma.negotiationBasisNote.findMany({ where: { minuteId: minute.id } });
  check("the SOP's six bases are laid out ready", bases.length === SOP_BASES.length, `${bases.length} bases`);
  check("and all start unanswered", bases.every((b) => !b.discussed && !b.notes));

  const parts = await prisma.negotiationParticipant.findMany({ where: { minuteId: minute.id } });
  check("both sides are recorded as rows, not a sentence", parts.length === 2);
  check("the vendor representative is captured by name", parts.some((p) => p.name === "Imran Sheikh" && p.side === "VENDOR"));

  const earlyClose = await refused(
    finaliseNegotiationMinute(buyer, { minuteId: minute.id, conclusion: "Agreed." }),
  );
  check("finalising over unanswered bases is refused", !!earlyClose, earlyClose ?? "");
  check("and the refusal names which bases", !!earlyClose?.includes("Payment terms"));

  const tickOnly = await refused(
    recordBasis(buyer, { minuteId: minute.id, basis: "PRICE", discussed: true }),
  );
  check("a basis ticked with nothing written is refused", !!tickOnly, tickOnly ?? "");

  const unnamedOther = await refused(
    recordBasis(buyer, { minuteId: minute.id, basis: "OTHER", discussed: true, notes: "x" }),
  );
  check("an OTHER basis must be named", !!unnamedOther, unnamedOther ?? "");

  await recordBasis(buyer, { minuteId: minute.id, basis: "PRICE", discussed: true, notes: "3.2% off list against a 30-day term." });
  await recordBasis(buyer, { minuteId: minute.id, basis: "PAYMENT_TERMS", discussed: true, notes: "30 days from GRN." });
  await recordBasis(buyer, { minuteId: minute.id, basis: "QUALITY", discussed: true, notes: "Grade 60 certificate per lot." });
  await recordBasis(buyer, { minuteId: minute.id, basis: "DELIVERY", discussed: true, notes: "Two lots, 10 days apart." });
  await recordBasis(buyer, { minuteId: minute.id, basis: "AFTER_SALES", discussed: false, notes: "Not applicable to bar stock." });
  await recordBasis(buyer, { minuteId: minute.id, basis: "WARRANTY", discussed: false, notes: "Not raised." });
  await recordBasis(buyer, {
    minuteId: minute.id,
    basis: "OTHER",
    label: "Freight to site",
    discussed: true,
    notes: "Vendor absorbs freight to Multan Road.",
  });

  const noConclusion = await refused(
    finaliseNegotiationMinute(buyer, { minuteId: minute.id, conclusion: "   " }),
  );
  check("a conclusion is required", !!noConclusion, noConclusion ?? "");

  const done = await finaliseNegotiationMinute(buyer, {
    minuteId: minute.id,
    conclusion: "Award to the vendor at the negotiated rate, freight included.",
    recommendedVendorId: vendor.id,
  });
  check("minutes finalise once every basis is answered", done.status === "FINALISED");
  check("the conclusion is stored", !!done.conclusion?.includes("freight included"));
  check("the recommended vendor is recorded", done.recommendedVendorId === vendor.id);

  const sigs = await minuteSignatures(minute.id);
  check("finalising signs the minutes", sigs.length === 1, sigs[0]?.attestationType);
  check("and hashes what was signed", !!sigs[0]?.documentHash, sigs[0]?.documentHash?.slice(0, 12));

  const frozen = await refused(
    recordBasis(buyer, { minuteId: minute.id, basis: "PRICE", discussed: true, notes: "changed my mind" }),
  );
  check("finalised minutes cannot be edited", !!frozen, frozen ?? "");

  const twice = await refused(
    finaliseNegotiationMinute(buyer, { minuteId: minute.id, conclusion: "again" }),
  );
  check("they cannot be finalised twice", !!twice);

  const listed = await minutesFor({ rfqId: rfq.id });
  check("minutes read back against the RFQ", listed.some((m) => m.id === minute.id));
  check(
    "the OTHER basis is listed alongside the six",
    (listed.find((m) => m.id === minute.id)?.bases.length ?? 0) === SOP_BASES.length + 1,
  );

  // Cleanup.
  await prisma.attestation.deleteMany({ where: { documentType: "NEGOTIATION_MINUTE", documentId: minute.id } });
  await prisma.auditLog.deleteMany({ where: { entityType: "NegotiationMinute", entityId: minute.id } });
  await prisma.negotiationBasisNote.deleteMany({ where: { minuteId: minute.id } });
  await prisma.negotiationParticipant.deleteMany({ where: { minuteId: minute.id } });
  await prisma.negotiationMinute.delete({ where: { id: minute.id } });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
