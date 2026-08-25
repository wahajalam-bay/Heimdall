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
      where: {
        itemId: b.itemId,
        storeId: b.storeId,
        batchNumber: b.batchNumber,
        serialNumber: b.serialNumber,
        // A reservation moves no goods — it changes what is *available*, not what
        // is on the shelf. Counting it here would report a balance that has not
        // changed as drifting from its own ledger.
        type: { notIn: ["RESERVATION", "RELEASE"] },
      },
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

  // ── Demand layer ──

  // 16. Reserved quantity on the shelf equals the holds actually recorded. If
  //     these drift, available stock is a fiction in one direction or the other:
  //     either goods are invisible, or two people are promised the same carton.
  const reservedRows = await prisma.inventoryItem.findMany({
    where: { reservedQty: { not: 0 } },
    select: { itemId: true, storeId: true, reservedQty: true, item: { select: { sku: true } }, store: { select: { code: true } } },
  });
  const activeHolds = await prisma.inventoryReservation.groupBy({
    by: ["itemId", "storeId"],
    where: { status: "ACTIVE" },
    _sum: { quantity: true },
  });
  const holdMap = new Map(activeHolds.map((h) => [`${h.itemId}|${h.storeId}`, h._sum.quantity ?? 0]));
  const byBucket = new Map<string, { reserved: number; sku: string; store: string }>();
  for (const r of reservedRows) {
    const key = `${r.itemId}|${r.storeId}`;
    const entry = byBucket.get(key) ?? { reserved: 0, sku: r.item.sku, store: r.store.code };
    entry.reserved += r.reservedQty;
    byBucket.set(key, entry);
  }
  for (const [key, held] of holdMap) {
    if (!byBucket.has(key)) byBucket.set(key, { reserved: 0, sku: key.split("|")[0], store: "?" });
  }
  const drift = [...byBucket.entries()].filter(
    ([key, v]) => Math.abs(v.reserved - (holdMap.get(key) ?? 0)) > 1e-6,
  );
  add(
    "Reserved stock matches the reservations on record",
    drift.length === 0,
    drift.length
      ? drift.map(([k, v]) => `${v.sku} at ${v.store}: shelf ${v.reserved} vs holds ${holdMap.get(k) ?? 0}`).join("; ")
      : `${byBucket.size} bucket(s) reconcile`,
  );

  // 17. Nothing is reserved that is not physically there.
  const overReserved = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    'SELECT COUNT(*)::bigint AS count FROM inventory WHERE "reservedQty" > quantity + 1e-6',
  );
  const overReservedCount = Number(overReserved[0]?.count ?? 0);
  add(
    "Nothing is reserved beyond what is on the shelf",
    overReservedCount === 0,
    `${overReservedCount} over-reserved bucket(s)`,
  );

  // 18. An order can never take more of a requisition line than the line holds.
  const prLines = await prisma.purchaseRequisitionItem.findMany({
    select: { id: true, lineNo: true, quantity: true, unit: true, pr: { select: { number: true } } },
  });
  const allocSums = await prisma.prPoAllocation.groupBy({
    by: ["prItemId"],
    _sum: { quantity: true },
  });
  const allocMap = new Map(allocSums.map((a) => [a.prItemId, a._sum.quantity ?? 0]));
  const overAllocated = prLines.filter((l) => (allocMap.get(l.id) ?? 0) > l.quantity + 1e-6);
  add(
    "No requisition line is ordered beyond its quantity",
    overAllocated.length === 0,
    overAllocated.length
      ? overAllocated.map((l) => `${l.pr.number} line ${l.lineNo}: ${allocMap.get(l.id)} of ${l.quantity} ${l.unit}`).join("; ")
      : `${prLines.length} line(s) within their ordered quantity`,
  );

  // 19. Every decided requirement produced something. A requirement recorded as
  //     routed with no store requisition and no purchase requisition behind it
  //     means somebody's demand vanished silently.
  const decided = await prisma.requirement.findMany({
    where: { decidedAt: { not: null }, status: { notIn: ["CANCELLED"] } },
    select: {
      number: true,
      _count: { select: { storeIssues: true, requisitions: true } },
    },
  });
  const vanished = decided.filter((r) => r._count.storeIssues + r._count.requisitions === 0);
  add(
    "Every routed requirement produced a document",
    vanished.length === 0,
    vanished.length ? vanished.map((r) => r.number).join(", ") : `${decided.length} routed requirement(s) accounted for`,
  );

  // 20. The inventory-first rule itself: a requirement cannot have become a
  //     purchase requisition without its stock having been read first.
  const unchecked = await prisma.requirement.findMany({
    where: { checkedAt: null, requisitions: { some: {} } },
    select: { number: true },
  });
  add(
    "No requirement reached procurement without a stock check",
    unchecked.length === 0,
    unchecked.length ? unchecked.map((r) => r.number).join(", ") : "0 requirements bypassed the check",
  );

  // ── Finance chain ──

  // 21. No voucher exists for an invoice that has not passed or been waived. A
  //     voucher is the last document before money moves; if one can be raised on
  //     a failed match, every control upstream was decoration.
  const badVouchers = await prisma.voucher.findMany({
    where: {
      status: { notIn: ["CANCELLED", "REJECTED"] },
      invoice: { matchStatus: { in: ["PENDING", "FAILED"] }, exceptionApprovedAt: null },
    },
    select: { number: true, invoice: { select: { number: true, matchStatus: true } } },
  });
  add(
    "No voucher raised on an unmatched invoice",
    badVouchers.length === 0,
    badVouchers.length
      ? badVouchers.map((v) => `${v.number} on ${v.invoice.number} (${v.invoice.matchStatus})`).join(", ")
      : "0 vouchers on unmatched invoices",
  );

  // 22. An approved voucher has every signature its ladder demanded.
  const approvedVouchers = await prisma.voucher.findMany({
    where: { status: { in: ["APPROVED", "PAID"] } },
    select: { number: true, signatures: { select: { status: true } } },
  });
  const unsigned = approvedVouchers.filter((v) => v.signatures.some((s) => s.status === "PENDING"));
  add(
    "Every approved voucher is fully signed",
    unsigned.length === 0,
    unsigned.length ? unsigned.map((v) => v.number).join(", ") : `${approvedVouchers.length} voucher(s) fully signed`,
  );

  // 23. Signatures were given in sequence. A ladder climbed from the top is not a
  //     ladder, and out-of-order approval is the classic way a large payment
  //     bypasses the person meant to question it.
  const ladders = await prisma.voucher.findMany({
    where: { signatures: { some: { status: "APPROVED" } } },
    select: { number: true, signatures: { orderBy: { sequence: "asc" }, select: { sequence: true, status: true } } },
  });
  const outOfOrder = ladders.filter((v) => {
    const seen = v.signatures.map((s) => s.status === "APPROVED");
    // Once a pending step appears, nothing after it may be approved.
    const firstPending = seen.indexOf(false);
    return firstPending !== -1 && seen.slice(firstPending).some(Boolean);
  });
  add(
    "Voucher signatures were given in order",
    outOfOrder.length === 0,
    outOfOrder.length ? outOfOrder.map((v) => v.number).join(", ") : `${ladders.length} ladder(s) climbed in order`,
  );

  // 24. Voucher arithmetic. Gross less withholding less deductions is the net, or
  //     somebody is being paid a figure the document does not support.
  const voucherMaths = await prisma.voucher.findMany({
    select: { number: true, grossAmount: true, withholdingTax: true, deductions: true, netAmount: true },
  });
  const wrongMaths = voucherMaths.filter(
    (v) => Math.abs(v.grossAmount - v.withholdingTax - v.deductions - v.netAmount) > 0.01,
  );
  add(
    "Voucher net equals gross less deductions",
    wrongMaths.length === 0,
    wrongMaths.length ? wrongMaths.map((v) => v.number).join(", ") : `${voucherMaths.length} voucher(s) reconcile`,
  );

  // ── Receiving exceptions ──

  // 25. Rejected goods that were adjusted out actually moved. A rejection marked
  //     as adjusted with no compensating movement means stock records still show
  //     goods that were sent back.
  const adjustedRejections = await prisma.rejectionRecord.findMany({
    where: { inventoryAdjusted: true },
    select: { number: true, itemId: true, quantity: true, raisedAt: true },
  });
  const withoutMovement: string[] = [];
  for (const r of adjustedRejections) {
    if (!r.itemId) continue;
    const moved = await prisma.inventoryTransaction.count({
      where: {
        itemId: r.itemId,
        type: "ADJUSTMENT",
        quantity: { lt: 0 },
        performedAt: { gte: new Date(r.raisedAt.getTime() - 60_000) },
      },
    });
    if (!moved) withoutMovement.push(r.number);
  }
  add(
    "Rejections marked adjusted have a matching movement",
    withoutMovement.length === 0,
    withoutMovement.length ? withoutMovement.join(", ") : `${adjustedRejections.length} adjusted rejection(s) reconcile`,
  );

  // 26. A closed return did not quietly abandon a replacement the vendor owed.
  const abandoned = await prisma.vendorReturn.findMany({
    where: { status: "CLOSED", replacementRequired: true, replacementStatus: "AWAITED" },
    select: { number: true },
  });
  add(
    "No return closed with a replacement still owed",
    abandoned.length === 0,
    abandoned.length ? abandoned.map((r) => r.number).join(", ") : "0 returns closed with goods outstanding",
  );

  // 27. Utilisation can never exceed commitment: goods cannot be received against
  //     an order that was never placed. When this fails, the two figures are being
  //     drawn from different sets of documents — which is exactly the bug that
  //     reported a department utilising millions against a commitment of nought.
  const { budgetPositions } = await import("../src/server/budget");
  const positions = await budgetPositions({ entityIds: null });
  const impossible = positions.filter((p) => p.utilised > p.committed + 0.01);
  add(
    "Budget utilisation never exceeds commitment",
    impossible.length === 0,
    impossible.length
      ? impossible
          .map((p) => `${p.departmentName ?? p.entityCode}: utilised ${p.utilised} vs committed ${p.committed}`)
          .join("; ")
      : `${positions.length} budget line(s) consistent`,
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
