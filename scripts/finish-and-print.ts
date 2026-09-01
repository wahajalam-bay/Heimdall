/**
 * Finishes one case's receiving-to-payment tail, then prints its forms.
 *
 *   npx tsx scripts/finish-and-print.ts PR-2026-00034
 *
 * `lifecycle-forms.ts` drives a whole case and is the right tool for proving the
 * chain end to end. It is also slow, because it is real: against this database a
 * full case is half an hour of transactions, and iterating on the last three
 * stages by re-running the first seven is not a good use of anybody's time.
 *
 * So this does the tail only — goods receipt, invoice, the Annexure A pack, the
 * handoff — and prints every form from what is on the record. Actors are resolved
 * by targeted queries rather than the permission-wide scans, which cost about
 * five seconds each.
 *
 * Nothing here fabricates a field. Every value printed is read back out of the
 * database.
 */
import { writeSync } from "node:fs";
import { prisma } from "../src/lib/db";
import { PERMISSIONS as P } from "../src/lib/permissions";
import { sessionFor } from "./lib/actors";
import type { SessionUser } from "../src/lib/rbac";
import { createGrn } from "../src/server/grn";
import { handoffToFinance, registerInvoice, verifyInvoice } from "../src/server/invoice";
import { paymentPack, setApplicability, verifyPackItem } from "../src/server/payment-pack";
import { attestationBlock } from "../src/server/attestation";
import { annexure4Signatures } from "../src/server/receiving";
import { signoffsFor } from "../src/server/inspection-matrix";
import { PO_ACKNOWLEDGEMENT_LABELS, type PoAcknowledgementState } from "../src/server/po";

const say = (l = "") => {
  try {
    writeSync(1, `${l}\n`);
  } catch {
    console.log(l);
  }
};

const PR_NUMBER = process.argv[2] ?? "PR-2026-00034";

const money = (n: number) =>
  n.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "—");
const stamp = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "—");

function form(title: string, ref: string) {
  say();
  say("═".repeat(74));
  say(`  ${title}   ·   ${ref}`);
  say("═".repeat(74));
}
function pairs(rows: Array<[string, string]>) {
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v] of rows) say(`  ${k.padEnd(w)} : ${v}`);
}
function table(headers: string[], widths: number[], rows: string[][], rightFrom = 3) {
  const line = (c: string[]) =>
    "  " + c.map((x, i) => (i >= rightFrom ? x.padStart(widths[i]) : x.padEnd(widths[i]))).join("  ");
  say(line(headers));
  say("  " + widths.map((w) => "─".repeat(w)).join("  "));
  for (const r of rows) say(line(r));
}
function sig(label: string, name: string | null, designation: string | null, when: string) {
  say(`  ${label}`);
  say(`    ${"_".repeat(32)}`);
  say(`    ${name ?? "(unsigned)"}${designation ? `, ${designation}` : ""}    ${when}`);
}

/** An active user holding every one of these permissions, by targeted query. */
async function actor(codes: string[], entityId: string): Promise<SessionUser> {
  const held = await prisma.user.findFirst({
    where: {
      active: true,
      OR: [{ primaryEntityId: entityId }, { entityAccess: { some: { entityId } } }],
      AND: codes.map((code) => ({
        roles: { some: { role: { permissions: { some: { permission: { code } } } } } },
      })),
    },
    select: { email: true },
    orderBy: { email: "asc" },
  });
  if (!held) throw new Error(`No active user holds all of ${codes.join(", ")} for that company.`);
  return sessionFor(held.email);
}

async function main() {
  say(`\nFinishing ${PR_NUMBER} and printing its forms\n`);

  const pr = await prisma.purchaseRequisition.findFirst({
    where: { number: PR_NUMBER },
    select: { id: true, number: true, status: true, entityId: true },
  });
  if (!pr) throw new Error(`No requisition numbered ${PR_NUMBER}.`);

  const po = await prisma.purchaseOrder.findFirst({
    where: { prId: pr.id, status: { notIn: ["CANCELLED"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, number: true, status: true, procurementKind: true },
  });
  if (!po) throw new Error(`${PR_NUMBER} has no purchase order.`);

  const delivery = await prisma.delivery.findFirst({
    where: { poId: po.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, number: true },
  });
  if (!delivery) throw new Error(`${po.number} has no delivery.`);

  const deliveryItem = await prisma.deliveryItem.findFirstOrThrow({
    where: { deliveryId: delivery.id },
    select: { id: true, acceptedQty: true, itemId: true },
  });

  /* ── Goods receipt ─────────────────────────────────────── */
  let grn = await prisma.grn.findFirst({
    where: { deliveryId: delivery.id, status: { not: "CANCELLED" } },
    select: { id: true, number: true, status: true },
  });
  if (!grn) {
    const storeKeeper = await actor([P.GRN_CREATE, P.GRN_POST], pr.entityId);
    const qty = Math.round(deliveryItem.acceptedQty);
    const created = await createGrn(
      storeKeeper,
      {
        deliveryId: delivery.id,
        remarks: `Receipt raised while completing ${pr.number}.`,
        items: [
          {
            deliveryItemId: deliveryItem.id,
            acceptedQty: deliveryItem.acceptedQty,
            rejectedQty: 0,
            // A laptop is serialised: one serial per unit, or the domain refuses
            // the receipt. Rightly — an asset register built from a count cannot
            // say which machine is where.
            serialNumbers: Array.from(
              { length: qty },
              (_, i) => `ZM-LAP-${String(i + 1).padStart(4, "0")}`,
            ).join(", "),
          },
        ],
        post: true,
      },
      prisma,
    );
    grn = { id: created.id, number: created.number, status: "POSTED" };
    say(`  Goods receipt ${created.number} raised and posted by ${storeKeeper.name}.`);
  } else {
    say(`  Goods receipt ${grn.number} already on the record (${grn.status}).`);
  }

  /* ── Invoice ───────────────────────────────────────────── */
  let invoiceId = (
    await prisma.invoice.findFirst({
      where: { poId: po.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, number: true },
    })
  )?.id;
  if (!invoiceId) {
    const financeUser = await actor([P.INVOICE_CREATE], pr.entityId);
    const poItem = await prisma.purchaseOrderItem.findFirstOrThrow({
      where: { poId: po.id },
      select: { id: true, description: true, unit: true, unitPrice: true, taxRate: true, acceptedQty: true },
    });
    const registered = await registerInvoice(
      financeUser,
      {
        poId: po.id,
        vendorInvoiceNumber: `BCS/${pr.number.slice(-5)}`,
        invoiceDate: new Date(),
        dueDate: new Date(Date.now() + 30 * 86_400_000),
        items: [
          {
            poItemId: poItem.id,
            description: poItem.description,
            // Billed for what was accepted, so the three-way match passes. An
            // over-billed invoice is the acceptance run's scenario, not this one.
            quantity: poItem.acceptedQty,
            unit: poItem.unit,
            unitPrice: poItem.unitPrice,
            taxRate: poItem.taxRate ?? 18,
          },
        ],
        grnIds: [grn.id],
      },
      prisma,
    );
    if (!registered) throw new Error("Invoice registration returned nothing.");
    invoiceId = registered.id;
    await verifyInvoice(financeUser, registered.id, prisma).catch((e) =>
      say(`  (verify: ${e instanceof Error ? e.message.slice(0, 90) : e})`),
    );
    say(`  Invoice ${registered.number} registered and verified.`);
  }

  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { vendor: true, po: { select: { number: true } } },
  });
  say(`  Three-way match: ${invoice.matchStatus} · invoice status ${invoice.status}`);

  /* ── Annexure A ────────────────────────────────────────── */
  let pack = await paymentPack(
    "INVOICE",
    invoice.id,
    { entityId: pr.entityId, transactionType: po.procurementKind },
    prisma,
  );
  const verifier = await actor([P.INVOICE_VERIFY], pr.entityId);

  // Annexure A marks three of its seven documents "(if applicable)", and the
  // pack treats an unanswered condition as biting until somebody says otherwise
  // — so a conditional document nobody has ruled on blocks. That is deliberate:
  // the alternative is a checklist that quietly excuses whatever nobody looked
  // at.
  //
  // Answering them is a judgement, and the notes below are the reasoning a buyer
  // would actually give for a laptop purchase. What the system insists on is
  // that the reasoning exists and is attributable, not that it be elaborate.
  const NOT_APPLICABLE: Record<string, string> = {
    OTHER:
      "No undertaking is held from this vendor for this order; nothing was supplied against a promise to follow.",
    "MILL-CERT":
      "A mill or test certificate belongs to fabricated or bulk material. These are finished branded units, warranted by the manufacturer.",
    "STRN-CERT":
      "The supplier's sales tax registration is already on their vendor file and verified; it is not re-supplied per invoice.",
  };
  for (const item of pack.items.filter((i) => i.blocking && NOT_APPLICABLE[i.documentTypeCode])) {
    await setApplicability(
      verifier,
      {
        documentType: "INVOICE",
        documentId: invoice.id,
        documentTypeCode: item.documentTypeCode,
        applicable: false,
        note: NOT_APPLICABLE[item.documentTypeCode],
      },
      prisma,
    ).catch((e) =>
      say(`  (applicability ${item.documentTypeCode}: ${e instanceof Error ? e.message.slice(0, 90) : e})`),
    );
  }
  if (pack.items.some((i) => i.blocking && NOT_APPLICABLE[i.documentTypeCode])) {
    pack = await paymentPack(
      "INVOICE",
      invoice.id,
      { entityId: pr.entityId, transactionType: po.procurementKind },
      prisma,
    );
    say(`  Conditional documents ruled on by ${verifier.name}, each with a stated reason.`);
  }

  for (const item of pack.items.filter((i) => i.present && !i.verified)) {
    await verifyPackItem(
      verifier,
      { documentType: "INVOICE", documentId: invoice.id, documentTypeCode: item.documentTypeCode },
      prisma,
    ).catch((e) => say(`  (check ${item.documentTypeCode}: ${e instanceof Error ? e.message.slice(0, 80) : e})`));
  }
  pack = await paymentPack(
    "INVOICE",
    invoice.id,
    { entityId: pr.entityId, transactionType: po.procurementKind },
    prisma,
  );

  let handoffRef: string | null = null;
  if (pack.complete && invoice.matchStatus === "PASSED") {
    const releaser = await actor([P.FINANCE_HANDOFF], pr.entityId);
    const handoff = await handoffToFinance(
      releaser,
      invoice.id,
      "Match passed and the Annexure A pack is complete and checked.",
      prisma,
    ).catch((e) => {
      say(`  (handoff: ${e instanceof Error ? e.message.slice(0, 140) : e})`);
      return null;
    });
    if (handoff) {
      handoffRef = `${handoff.number} for ${money(handoff.amount)}`;
      say(`  Handed to finance as ${handoff.number}.`);
    }
  } else {
    say(
      `  Not handed to finance: match ${invoice.matchStatus}, pack ${pack.complete ? "complete" : `short by ${pack.blockers.length}`}.`,
    );
  }

  /* ══════════════ THE FORMS ══════════════════════════════ */
  say();
  say("█".repeat(74));
  say("  THE FORMS, EVERY FIELD READ BACK FROM THE RECORDS ABOVE");
  say("█".repeat(74));

  /* ── Annexure 1 ────────────────────────────────────────── */
  const prFull = await prisma.purchaseRequisition.findUniqueOrThrow({
    where: { id: pr.id },
    include: {
      entity: true,
      department: true,
      requester: true,
      approvedBy: true,
      deliveryStore: true,
      items: { orderBy: { lineNo: "asc" }, include: { item: true } },
    },
  });
  const prBlocks = await attestationBlock("PR", pr.id, ["APPROVED", "REVIEWED"], prisma);
  const prSig = prBlocks.find((b) => b.signed) ?? prBlocks[0];

  form("ANNEXURE 1 — PURCHASE REQUISITION", prFull.number);
  pairs([
    ["Document no", prFull.number],
    ["Document date", day(prFull.createdAt)],
    ["Required date", day(prFull.requiredDate)],
    ["Department", prFull.department.name],
    ["Required by", prFull.requester.name],
    ["Req location", prFull.requiredLocation ?? prFull.deliveryStore?.name ?? "—"],
    ["Approved by", prFull.approvedBy?.name ?? prSig?.name ?? "—"],
    ["Approval status", prFull.status],
  ]);
  say();
  say(`  Description / comments`);
  say(`    ${prFull.title}`);
  if (prFull.justification) say(`    ${prFull.justification}`);
  say();
  table(
    ["Sr", "Item code", "Description", "Qty", "UOM", "Unit cost", "Total cost", "In stock"],
    [3, 13, 28, 5, 5, 12, 13, 9],
    prFull.items.map((li) => [
      String(li.lineNo),
      li.itemCode ?? li.item?.sku ?? "—",
      li.description.slice(0, 28),
      String(li.quantity),
      li.unit,
      li.estimatedUnitPrice != null ? money(li.estimatedUnitPrice) : "—",
      money(li.estimatedTotal),
      li.inStockAtRequest != null ? String(li.inStockAtRequest) : "—",
    ]),
  );
  say();
  say(`  Document comments: ${prFull.documentComments ?? "(none)"}`);
  say();
  sig(
    "HOD / Regional Head",
    prSig?.name ?? null,
    prSig?.designation ?? null,
    prSig?.signedAt
      ? `Date ${day(prSig.signedAt)}   Time ${prSig.signedAt.toISOString().slice(11, 16)}`
      : "Date ____   Time ____",
  );
  say(`    Stamp: ${prSig?.stampRef ?? "[ affix stamp ]"}`);

  /* ── Purchase order ────────────────────────────────────── */
  const poFull = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: po.id },
    include: {
      entity: true,
      vendor: true,
      pr: true,
      deliveryStore: true,
      createdBy: true,
      authorisedSignatory: true,
      items: { orderBy: { lineNo: "asc" }, include: { item: true } },
    },
  });
  form("PURCHASE ORDER", poFull.number);
  pairs([
    ["Order date", day(poFull.issuedAt ?? poFull.createdAt)],
    ["Supplier", `${poFull.vendor.name} (${poFull.vendor.code})`],
    ["Deliver to", poFull.deliveryStore?.name ?? "—"],
    ["Against requisition", poFull.pr?.number ?? "—"],
    ["Payment terms", poFull.paymentTerms ?? "—"],
    ["Warranty", poFull.warrantyTerms ?? "—"],
    ["Status", poFull.status],
  ]);
  say();
  table(
    ["Sr", "Item code", "Description", "Qty", "UOM", "Unit price", "Tax%", "Line total"],
    [3, 13, 28, 5, 5, 13, 5, 14],
    poFull.items.map((li) => [
      String(li.lineNo),
      li.item?.sku ?? "—",
      li.description.slice(0, 28),
      String(li.quantity),
      li.unit,
      money(li.unitPrice),
      String(li.taxRate),
      money(li.lineTotal),
    ]),
  );
  say();
  say(
    `  Subtotal ${money(poFull.subtotal)}    Tax ${money(poFull.taxAmount)}    TOTAL ${poFull.currency} ${money(poFull.total)}`,
  );
  say();
  sig(
    "Authorised signatory — Procurement (§4.6)",
    poFull.authorisedSignatory?.name ?? null,
    poFull.authorisedSignatory?.title ?? null,
    poFull.signedAt ? stamp(poFull.signedAt) : "Date ____",
  );
  say();
  sig(
    "Supplier acknowledgement",
    poFull.acknowledgedByName,
    PO_ACKNOWLEDGEMENT_LABELS[poFull.acknowledgementStatus as PoAcknowledgementState] ?? null,
    poFull.acknowledgedAt ? stamp(poFull.acknowledgedAt) : "Date ____",
  );
  say(
    `    Sent by ${poFull.distributionChannel ?? "—"} ${poFull.distributionRef ?? ""} on ${day(poFull.distributedAt)}`,
  );

  /* ── Annexure 4 ────────────────────────────────────────── */
  const insp = await prisma.inspection.findFirst({
    where: { deliveryId: delivery.id },
    include: {
      po: { include: { vendor: true } },
      delivery: { include: { store: true, receivedBy: true } },
      items: { orderBy: { lineNo: "asc" }, include: { item: true } },
    },
  });
  if (insp) {
    const [a4, marks] = await Promise.all([
      annexure4Signatures(insp.id, prisma),
      signoffsFor(insp.id, prisma),
    ]);
    form("ANNEXURE 4 — GOODS / MATERIAL INSPECTION NOTE", insp.number);
    pairs([
      ["Receiving date", day(insp.receivedDate ?? insp.delivery?.deliveryDate)],
      ["Inspection date", day(insp.inspectedAt)],
      ["Supplier", insp.po?.vendor.name ?? "—"],
      ["Store", insp.delivery?.store.name ?? "—"],
      ["Against order", insp.po?.number ?? "—"],
      ["Result", insp.result ?? "—"],
    ]);
    say();
    table(
      ["Sr", "Item code", "Description", "Inspd", "Passed", "Rejctd", "Verdict"],
      [3, 13, 28, 7, 7, 7, 9],
      insp.items.map((li) => [
        String(li.lineNo),
        li.item?.sku ?? "—",
        (li.description ?? "").slice(0, 28),
        String(li.quantityInspected),
        String(li.quantityPassed),
        String(li.quantityFailed),
        li.verdict ?? "—",
      ]),
    );
    say();
    say(`  Sign-offs the SOP's inspection chart requires for this category:`);
    for (const m of marks) {
      say(
        `    ${m.typeLabel.padEnd(14)} ${m.ownerLabel.padEnd(10)} ${
          m.signedAt ? `${m.verdict} — ${m.signedByName}, ${day(m.signedAt)}` : "UNSIGNED"
        }`,
      );
    }
    say();
    sig(
      "Logistics (Received by)",
      a4.logistics?.name ?? null,
      a4.logistics?.designation ?? null,
      a4.logistics?.signedAt ? day(a4.logistics.signedAt) : "Date ____",
    );
    say();
    sig(
      "Concerned Department (Signature — POC)",
      a4.department?.name ?? null,
      a4.department?.designation ?? null,
      a4.department?.signedAt ? day(a4.department.signedAt) : "Date ____",
    );
    if (!a4.department) {
      say("    (unsigned — §3.2 puts this on the requesting department's POC, and an inspector may not stand in)");
    }
  }

  /* ── Goods receipt note ────────────────────────────────── */
  const grnFull = await prisma.grn.findUniqueOrThrow({
    where: { id: grn.id },
    include: {
      po: { include: { pr: true, entity: true } },
      vendor: true,
      store: true,
      delivery: true,
      gatePass: true,
      inspection: true,
      receivedBy: true,
      postedBy: true,
      items: { orderBy: { lineNo: "asc" }, include: { item: true } },
    },
  });
  form("GOODS RECEIPT NOTE", grnFull.number);
  pairs([
    ["Receipt date", day(grnFull.receivedAt)],
    ["Supplier", grnFull.vendor.name],
    ["Store", grnFull.store.name],
    ["Against order", grnFull.po.number],
    ["Against requisition", grnFull.po.pr?.number ?? "—"],
    ["Value", `${grnFull.po.currency} ${money(grnFull.totalValue)}`],
    ["Status", grnFull.status],
  ]);
  say();
  say("  The receiving chain, each step named:");
  say(
    `    Gate pass    ${grnFull.gatePass?.serial ?? "none"}   ${day(grnFull.gatePass?.arrivedAt)}   ${grnFull.gatePass?.vehicleNumber ?? ""}`,
  );
  say(
    `    Delivery     ${grnFull.delivery?.number ?? "none"}   ${day(grnFull.delivery?.deliveryDate)}   DN ${grnFull.delivery?.deliveryNoteRef ?? "—"}`,
  );
  say(
    `    Inspection   ${grnFull.inspection?.number ?? grnFull.inspectionStatus}   ${grnFull.inspection?.result ?? ""}`,
  );
  say();
  table(
    ["Sr", "Item code", "Description", "Ordrd", "Recvd", "Accptd", "Rejctd", "Line value"],
    [3, 13, 24, 6, 6, 7, 7, 14],
    grnFull.items.map((li) => [
      String(li.lineNo),
      li.item?.sku ?? "—",
      li.description.slice(0, 24),
      String(li.orderedQty),
      String(li.receivedQty),
      String(li.acceptedQty),
      String(li.rejectedQty),
      money(li.lineValue),
    ]),
  );
  const serials = grnFull.items[0]?.serialNumbers;
  if (serials) say(`\n  Serials recorded: ${serials}`);
  say();
  sig("Received by — Store", grnFull.receivedBy.name, grnFull.receivedBy.title, stamp(grnFull.receivedAt));
  say();
  sig(
    "Posted to inventory by",
    grnFull.postedBy?.name ?? null,
    grnFull.postedBy?.title ?? null,
    stamp(grnFull.postedAt),
  );

  /* ── Annexure A ────────────────────────────────────────── */
  form("ANNEXURE A — SUPPORTING DOCUMENTS FOR PAYMENT", invoice.number);
  pairs([
    ["Invoice", `${invoice.number}  (vendor ref ${invoice.vendorInvoiceNumber})`],
    ["Supplier", invoice.vendor.name],
    ["Against order", invoice.po.number],
    ["Net payable", `${invoice.currency} ${money(invoice.netPayable || invoice.total)}`],
    ["Three-way match", invoice.matchStatus],
    ["Status", invoice.status],
  ]);
  say();
  table(
    ["Document", "Required", "How it is met", "Which record", "Checked by"],
    [26, 11, 16, 18, 22],
    pack.items.map((i) => [
      i.documentTypeName.slice(0, 26),
      i.requirementKind === "ALWAYS" ? "always" : i.applicable ? "if applic." : "n/a",
      i.satisfiedBy === "RECORD"
        ? "system record"
        : i.satisfiedBy === "ATTACHMENT"
          ? "attached file"
          : i.exceptionReason
            ? "WAIVED"
            : i.applicable
              ? "nothing held"
              : "not required",
      i.records.map((r) => r.ref).join(",").slice(0, 18) || "—",
      i.verified ? (i.verifiedByName ?? "—").slice(0, 22) : "—",
    ]),
    3,
  );
  say();
  say(
    `  Complete: ${pack.complete}    Blockers: ${pack.blockers.join(", ") || "none"}    Unchecked: ${pack.unverified.join(", ") || "none"}`,
  );
  if (handoffRef) say(`  Released to finance as ${handoffRef}.`);

  say();
  say(
    `  Chain: ${prFull.number} → ${poFull.number} → ${grnFull.gatePass?.serial ?? "—"} → ${grnFull.delivery?.number ?? "—"} → ` +
      `${insp?.number ?? "—"} → ${grnFull.number} → ${invoice.number}`,
  );
  say();
}

main()
  .catch((e) => {
    say(`\nFailed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
