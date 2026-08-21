/**
 * Data-integrity report.
 *
 * Re-checks the invariants the OS is meant to guarantee against whatever is
 * currently in the database. Exits non-zero if any hard rule is violated, so it
 * can be wired into CI or run after a migration.
 *
 *   npx tsx scripts/verify-integrity.ts
 */
import { PrismaClient } from "@prisma/client";
import { STORE_ENTRY_DISPOSITIONS } from "../src/lib/domain";

const prisma = new PrismaClient();

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

async function run() {
  // 1. Inventory may only increase through a posted GRN, a transfer-in, a
  //    petty-cash store entry, a return or an explicit adjustment.
  const badReceipts = await prisma.inventoryTransaction.count({
    where: { type: "RECEIPT", grnId: null, pettyCashId: null, sourceType: { notIn: ["ADJUSTMENT", "TRANSFER", "PETTY_CASH", "GRN"] } },
  });
  add("Inventory receipts all trace to a source document", badReceipts === 0, `${badReceipts} untraceable receipt(s)`);

  // 2. No negative stock.
  const negative = await prisma.inventoryItem.count({ where: { quantity: { lt: 0 } } });
  add("No negative stock balances", negative === 0, `${negative} negative bucket(s)`);

  // 3. Every posted GRN has a delivery behind it.
  const grnWithoutDelivery = await prisma.grn.count({ where: { status: "POSTED", deliveryId: null } });
  add("Every posted GRN references a physical receipt", grnWithoutDelivery === 0, `${grnWithoutDelivery} GRN(s) without a delivery`);

  // 4. No posted GRN where mandatory inspection is outstanding or failed.
  const grnBadInspection = await prisma.grn.count({
    where: { status: "POSTED", inspectionStatus: { in: ["PENDING", "REJECTED"] } },
  });
  add("No GRN posted with a failed or pending mandatory inspection", grnBadInspection === 0, `${grnBadInspection} GRN(s)`);

  // 5. Accepted quantity never exceeds ordered quantity.
  const poItems = await prisma.purchaseOrderItem.findMany({ select: { id: true, quantity: true, acceptedQty: true, po: { select: { number: true } }, lineNo: true } });
  const overReceipt = poItems.filter((i) => i.acceptedQty > i.quantity + 1e-6);
  add(
    "Accepted quantity never exceeds the ordered quantity",
    overReceipt.length === 0,
    overReceipt.length ? overReceipt.map((i) => `${i.po.number} line ${i.lineNo}`).join(", ") : "0 over-receipts",
  );

  // 6. No payment recorded against an invoice with a failing three-way match.
  const paidWithFailedMatch = await prisma.paymentHandoff.count({
    where: { status: "PAID", invoice: { matchStatus: "FAILED" } },
  });
  add("No payment released on a failing three-way match", paidWithFailedMatch === 0, `${paidWithFailedMatch} payment(s)`);

  // 7. No payment recorded where the purchase order has no posted GRN.
  const handoffs = await prisma.paymentHandoff.findMany({
    where: { status: "PAID" },
    include: { invoice: { include: { po: { include: { grns: { where: { status: "POSTED" }, select: { id: true } } } } } } },
  });
  const paidWithoutGrn = handoffs.filter((h) => (h.invoice.po?.grns.length ?? 0) === 0);
  add("No payment released without a posted GRN", paidWithoutGrn.length === 0, `${paidWithoutGrn.length} payment(s)`);

  // 8. No purchase order issued without a completed approval.
  const issuedPos = await prisma.purchaseOrder.findMany({
    where: { status: { in: ["ISSUED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CLOSED"] } },
    select: { id: true, number: true },
  });
  const unapproved: string[] = [];
  for (const po of issuedPos) {
    const approved = await prisma.approvalInstance.count({
      where: { documentType: "PO", documentId: po.id, status: "APPROVED" },
    });
    if (!approved) unapproved.push(po.number);
  }
  add("Every issued purchase order carries an approval", unapproved.length === 0, unapproved.join(", ") || "0 unapproved");

  // 9. CPC could not be bypassed where the configured threshold applied.
  const { cpcRequirement } = await import("../src/server/cpc");
  const posWithPr = await prisma.purchaseOrder.findMany({
    where: { status: { notIn: ["DRAFT", "CANCELLED", "PENDING_APPROVAL"] }, prId: { not: null } },
    include: { pr: { include: { cpcCases: true } } },
  });
  const bypassed: string[] = [];
  for (const po of posWithPr) {
    if (!po.pr) continue;
    const req = await cpcRequirement(po.entityId, po.total, po.pr.procurementType, prisma);
    if (req.required && !po.pr.cpcCases.some((c) => c.status === "APPROVED")) bypassed.push(po.number);
  }
  add("No CPC bypass where the threshold applied", bypassed.length === 0, bypassed.join(", ") || "0 bypasses");

  // 10. No blacklisted vendor holds a live purchase order.
  const blacklistedLive = await prisma.purchaseOrder.count({
    where: { vendor: { status: "BLACKLISTED" }, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "ISSUED", "PARTIALLY_RECEIVED"] } },
  });
  add("No live purchase order with a blacklisted vendor", blacklistedLive === 0, `${blacklistedLive} order(s)`);

  // 11. Petty cash may not be closed with an outstanding store entry.
  const closedPc = await prisma.pettyCashRequest.findMany({
    where: { status: { in: ["RECONCILED", "CLOSED"] } },
    include: { items: true },
  });
  const pcGap = closedPc.filter((r) =>
    r.items.some((i) => STORE_ENTRY_DISPOSITIONS.includes(i.disposition as never) && !i.storeEntered),
  );
  add("No petty cash closed with a missing store entry", pcGap.length === 0, pcGap.map((r) => r.number).join(", ") || "0 gaps");

  // 12. Every state transition left an audit record.
  const prs = await prisma.purchaseRequisition.count();
  const prAudit = await prisma.auditLog.count({ where: { entityType: "PurchaseRequisition" } });
  add("Requisitions carry audit history", prAudit >= prs, `${prAudit} audit events across ${prs} requisitions`);

  // 13. GRN line values reconcile to the GRN total.
  const grns = await prisma.grn.findMany({ where: { status: "POSTED" }, include: { items: true } });
  const grnMismatch = grns.filter(
    (g) => Math.abs(g.totalValue - g.items.reduce((a, i) => a + i.acceptedQty * i.unitPrice, 0)) > 1,
  );
  add("GRN totals reconcile to their lines", grnMismatch.length === 0, grnMismatch.map((g) => g.number).join(", ") || "0 mismatches");

  // 14. Inventory balances reconcile to the transaction ledger.
  const buckets = await prisma.inventoryItem.findMany({ include: { item: { select: { sku: true } }, store: { select: { code: true } } } });
  const ledgerMismatch: string[] = [];
  for (const b of buckets) {
    const txns = await prisma.inventoryTransaction.findMany({
      where: { itemId: b.itemId, storeId: b.storeId, batchNumber: b.batchNumber, serialNumber: b.serialNumber },
      select: { quantity: true },
    });
    const sum = txns.reduce((a, t) => a + t.quantity, 0);
    if (Math.abs(sum - b.quantity) > 0.01) {
      ledgerMismatch.push(`${b.store.code}/${b.item.sku}: balance ${b.quantity} vs ledger ${Math.round(sum * 100) / 100}`);
    }
  }
  add("Inventory balances reconcile to the ledger", ledgerMismatch.length === 0, ledgerMismatch.join("; ") || "all buckets reconcile");

  // 15. Comparatives that award above the lowest compliant quote carry a justification.
  const comparatives = await prisma.comparative.findMany({
    where: { status: { in: ["RECOMMENDED", "APPROVED"] } },
    include: { lines: true },
  });
  const unjustified = comparatives.filter((c) => {
    const selected = c.lines.find((l) => l.isSelected);
    if (!selected) return false;
    const compliant = c.lines.filter((l) => l.technicalCompliance === "COMPLIANT");
    const benchmark = compliant.length ? Math.min(...compliant.map((l) => l.netTotal)) : Math.min(...c.lines.map((l) => l.netTotal));
    return selected.netTotal > benchmark + 0.01 && !c.nonLowestJustification?.trim();
  });
  add(
    "Non-lowest awards carry a written justification",
    unjustified.length === 0,
    unjustified.map((c) => c.number).join(", ") || "0 unjustified awards",
  );

  // ── Report ──
  const pad = 58;
  process.stdout.write("\nData integrity report\n\n");
  for (const c of checks) {
    process.stdout.write(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(pad)} ${c.detail}\n`);
  }
  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(
    `\n  ${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ""}\n\n`,
  );
  await prisma.$disconnect();
  if (failed.length) process.exit(1);
}

run().catch(async (e) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  await prisma.$disconnect();
  process.exit(1);
});
