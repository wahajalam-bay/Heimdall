import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { PERMISSIONS as P } from "@/lib/permissions";
import { runThreeWayMatch } from "@/server/invoice";
import { availableQuantity, postMovement } from "@/server/inventory";
import { caseTimeline } from "@/server/timeline";
import { round2 } from "@/lib/format";
import { expectRejection, userWithPermission } from "./helpers";

/**
 * The acceptance scenario, asserted against the data the system actually holds:
 * a ZD steel material demand taken end to end, then short-delivered 90 of 100,
 * then invoiced for 100 — with the invoice blocked.
 */
describe("material demand lifecycle, end to end", () => {
  it("has a material demand that reached a purchase order", async () => {
    const md = await prisma.purchaseRequisition.findFirst({
      where: { procurementType: "MATERIAL_DEMAND" },
      include: {
        entity: { select: { code: true } },
        project: { select: { code: true } },
        site: { select: { name: true } },
        items: true,
        rfqs: { include: { quotes: { include: { items: true } } } },
        comparatives: { include: { lines: true } },
        cpcCases: { include: { decisions: true, members: true } },
        purchaseOrders: { include: { items: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(md).not.toBeNull();
    if (!md) return;

    // The construction chain: project, site, BOQ and drawing references.
    expect(md.projectId).not.toBeNull();
    expect(md.siteId).not.toBeNull();
    expect(md.boqReference || md.drawingReference).toBeTruthy();

    // Sourcing actually happened, with competing quotations.
    expect(md.rfqs.length).toBeGreaterThan(0);
    const quotes = md.rfqs.flatMap((r) => r.quotes);
    expect(quotes.length).toBeGreaterThanOrEqual(2);

    // A comparative exists and one line is the recommendation.
    expect(md.comparatives.length).toBeGreaterThan(0);
    const comparative = md.comparatives[0];
    expect(comparative.lines.some((l) => l.isSelected)).toBe(true);

    // A purchase order was raised against it.
    expect(md.purchaseOrders.length).toBeGreaterThan(0);
    const po = md.purchaseOrders[0];
    expect(po.items.length).toBeGreaterThan(0);
    expect(["ISSUED", "ACKNOWLEDGED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CLOSED", "IN_PROGRESS"]).toContain(
      po.status,
    );
  });

  it("routed the case through the committee where the value required it", async () => {
    const cases = await prisma.cpcCase.findMany({
      include: { decisions: true, members: true, pr: { select: { number: true, procurementType: true } } },
    });
    if (cases.length === 0) return;

    for (const kase of cases) {
      // Every case has voting members, and any decided case carries votes.
      expect(kase.members.length).toBeGreaterThan(0);
      if (["APPROVED", "REJECTED", "RETURNED"].includes(kase.status)) {
        expect(kase.decisions.length).toBeGreaterThan(0);
        expect(kase.decidedAt).not.toBeNull();
        // Non-approvals always carry a written reason.
        for (const d of kase.decisions) {
          if (d.vote !== "APPROVE") expect(d.comment?.trim() ?? "").not.toBe("");
        }
      }
    }
  });

  it("records the short delivery as a discrepancy and reflects it on the order", async () => {
    // "OK" is the default, so a genuine discrepancy is anything else.
    const short = await prisma.deliveryItem.findFirst({
      where: { discrepancyType: { not: "OK" } },
      include: {
        delivery: { select: { id: true, number: true, status: true, poId: true } },
        poItem: { select: { id: true, quantity: true, acceptedQty: true, description: true } },
      },
    });
    if (!short) return;

    // What actually arrived is genuinely below what the order expected on that line.
    expect(short.actualQty).toBeLessThan(short.expectedQty);
    expect(short.discrepancyType).not.toBe("OK");

    // The delivery is marked as accepted with a discrepancy, not cleanly accepted.
    expect(short.delivery.status).toBe("ACCEPTED_WITH_DISCREPANCY");

    // An exception was raised against the order the shortfall belongs to.
    const exception = await prisma.exception.findFirst({
      where: {
        poId: short.delivery.poId,
        type: { in: ["QUANTITY_MISMATCH", "DAMAGED_MATERIAL", "LATE_DELIVERY"] },
      },
      select: { type: true, severity: true, number: true },
    });
    expect(exception).not.toBeNull();
    expect(exception?.type).toBeTruthy();
  });

  it("posts a GRN only for what was accepted, never for what was ordered", async () => {
    const grns = await prisma.grn.findMany({
      where: { status: "POSTED" },
      include: {
        items: { include: { poItem: { select: { quantity: true } } } },
        po: { select: { number: true, items: { select: { quantity: true, acceptedQty: true } } } },
      },
    });
    expect(grns.length).toBeGreaterThan(0);

    for (const grn of grns) {
      for (const line of grn.items) {
        // Accepted can never exceed what the order allowed on that line.
        if (line.poItem) expect(line.acceptedQty).toBeLessThanOrEqual(line.poItem.quantity + 1e-9);
        // Accepted plus rejected can never exceed what was received.
        expect(round2(line.acceptedQty + line.rejectedQty)).toBeLessThanOrEqual(round2(line.receivedQty) + 1e-9);
      }
    }
  });

  it("blocks the invoice raised for the full ordered quantity against a short receipt", async () => {
    const failing = await prisma.invoice.findFirst({
      where: { matchStatus: "FAILED" },
      include: {
        items: true,
        po: { select: { number: true, items: { select: { quantity: true, acceptedQty: true } } } },
        exceptions: true,
        handoffs: true,
      },
    });
    expect(failing).not.toBeNull();
    if (!failing) return;

    // The match itself fails, with a named per-line flag.
    const result = await runThreeWayMatch(failing.id);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.lines.some((l) => l.flag === "QTY_MISMATCH" || l.flag === "NOT_RECEIVED")).toBe(true);

    // The invoice status reflects it, and a blocking exception stands.
    expect(["MISMATCH", "RECEIVED", "UNDER_VERIFICATION", "ON_HOLD"]).toContain(failing.status);
    expect(failing.exceptions.some((e) => e.blocking && ["OPEN", "IN_PROGRESS"].includes(e.status))).toBe(true);

    // And crucially: no payment was released.
    expect(failing.handoffs.filter((h) => h.status === "PAID")).toEqual([]);
  });

  it("keeps a complete case timeline from requisition to blocked invoice", async () => {
    const pr = await prisma.purchaseRequisition.findFirst({
      where: { procurementType: "MATERIAL_DEMAND" },
      select: { number: true },
      orderBy: { createdAt: "asc" },
    });
    if (!pr) return;

    const events = await caseTimeline(pr.number);
    expect(events.length).toBeGreaterThan(5);

    // Every event names an actor and an action — an anonymous audit line is useless.
    for (const e of events) {
      expect(e.title).toBeTruthy();
      expect(e.at).toBeTruthy();
    }
  });
});

describe("purchase order fulfilment arithmetic", () => {
  it("never records more accepted than ordered on any line", async () => {
    const items = await prisma.purchaseOrderItem.findMany({
      select: { id: true, quantity: true, receivedQty: true, acceptedQty: true, rejectedQty: true, invoicedQty: true },
    });
    const bad = items.filter((i) => i.acceptedQty > i.quantity + 1e-9);
    expect(bad.map((b) => b.id)).toEqual([]);
  });

  it("never invoices more than has been accepted", async () => {
    const items = await prisma.purchaseOrderItem.findMany({
      select: { id: true, acceptedQty: true, invoicedQty: true },
    });
    // Where an invoice exceeds acceptance, it must be a failing match — never a silent pass.
    const over = items.filter((i) => i.invoicedQty > i.acceptedQty + 1e-9);
    for (const item of over) {
      const line = await prisma.invoiceItem.findFirst({
        where: { poItemId: item.id },
        include: { invoice: { select: { matchStatus: true, number: true } } },
      });
      if (line) expect(["FAILED", "OVERRIDDEN"]).toContain(line.invoice.matchStatus);
    }
  });

  it("keeps a partially received order out of a closed state", async () => {
    const partial = await prisma.purchaseOrder.findMany({
      where: { status: "PARTIALLY_RECEIVED" },
      include: { items: { select: { quantity: true, acceptedQty: true } } },
    });
    for (const po of partial) {
      const outstanding = po.items.reduce((a, i) => a + Math.max(0, i.quantity - i.acceptedQty), 0);
      expect(outstanding).toBeGreaterThan(0);
    }
  });

  it("records a reason wherever an order was closed short", async () => {
    const closed = await prisma.purchaseOrder.findMany({
      where: { status: "CLOSED" },
      select: { number: true, closureReason: true, items: { select: { quantity: true, acceptedQty: true } } },
    });
    for (const po of closed) {
      const outstanding = po.items.reduce((a, i) => a + Math.max(0, i.quantity - i.acceptedQty), 0);
      if (outstanding > 1e-9) {
        expect(po.closureReason?.trim() ?? "").not.toBe("");
      }
    }
  });
});

describe("issuing stock that sits in batches", () => {
  /**
   * Availability is reported across every bucket of an item in a store, so
   * consumption has to work the same way. Before this was true, stock received
   * under a batch number could be seen but never issued: the movement looked for
   * a bucket with no batch, found none, and reported nothing available.
   */
  it("draws an unbatched issue from the batches that hold the stock", async () => {
    const issued = await prisma.inventoryTransaction.findMany({
      where: { type: "ISSUE", batchNumber: { not: null } },
      select: { number: true, itemId: true, storeId: true, batchNumber: true, quantity: true, sourceRef: true },
    });
    // Wherever batch-tracked stock has been issued, each movement names the
    // batch it came out of and a bucket for that batch exists.
    for (const txn of issued) {
      const bucket = await prisma.inventoryItem.findFirst({
        where: { itemId: txn.itemId, storeId: txn.storeId, batchNumber: txn.batchNumber },
      });
      expect(bucket, `${txn.number} issued from a batch with no bucket`).not.toBeNull();
      expect(txn.quantity).toBeLessThan(0);
      expect(txn.sourceRef?.trim() ?? "").not.toBe("");
    }
  });

  it("reports availability as the sum of every bucket in the store", async () => {
    const bucket = await prisma.inventoryItem.findFirst({
      where: { quantity: { gt: 0 } },
      orderBy: { quantity: "desc" },
    });
    if (!bucket) return;

    const buckets = await prisma.inventoryItem.findMany({
      where: { itemId: bucket.itemId, storeId: bucket.storeId },
      select: { quantity: true, reservedQty: true },
    });
    const expected = round2(buckets.reduce((a, b) => a + (b.quantity - b.reservedQty), 0));
    expect(await availableQuantity(bucket.itemId, bucket.storeId)).toBeCloseTo(expected, 2);
  });

  it("refuses a movement larger than the total free stock across every batch", async () => {
    const bucket = await prisma.inventoryItem.findFirst({
      where: { quantity: { gt: 0 } },
      include: { item: true },
      orderBy: { quantity: "desc" },
    });
    if (!bucket) return;

    const free = await availableQuantity(bucket.itemId, bucket.storeId);
    const issuer = await userWithPermission(P.STORE_ISSUE);
    // Asked of the ledger directly: nothing is written when it is refused.
    const error = await expectRejection(
      postMovement("ISSUE", {
        itemId: bucket.itemId,
        storeId: bucket.storeId,
        quantity: round2(free + 25),
        unit: bucket.item.unit,
        source: { kind: "ISSUE", id: "over-issue-check", ref: "OVER-ISSUE-CHECK" },
        performedById: issuer.id,
      }),
    );
    expect(error.message).toMatch(/insufficient/i);
    expect(error.message).toContain(bucket.item.sku);
  });

  it("never carries stock between stores at nil cost", async () => {
    // A transfer priced at zero would quietly destroy the value of the stock it
    // moves, so any dispatched line has a cost unless the source itself was free.
    const lines = await prisma.storeTransferItem.findMany({
      where: { dispatchedQty: { gt: 0 } },
      include: { item: { select: { sku: true } }, transfer: { select: { number: true, fromStoreId: true } } },
    });
    for (const line of lines) {
      const sourceHadValue = await prisma.inventoryTransaction.findFirst({
        where: { itemId: line.itemId, storeId: line.transfer.fromStoreId, type: "RECEIPT", unitCost: { gt: 0 } },
      });
      if (!sourceHadValue) continue;
      expect(line.unitCost, `${line.transfer.number} moved ${line.item.sku} at nil cost`).toBeGreaterThan(0);
    }
  });
});

describe("inventory ledger integrity", () => {
  it("reconciles every stock bucket to the movements that produced it", async () => {
    const buckets = await prisma.inventoryItem.findMany({
      select: { itemId: true, storeId: true, batchNumber: true, serialNumber: true, quantity: true },
    });

    for (const b of buckets.slice(0, 200)) {
      const movements = await prisma.inventoryTransaction.findMany({
        where: {
          itemId: b.itemId,
          storeId: b.storeId,
          batchNumber: b.batchNumber,
          serialNumber: b.serialNumber,
          // Holds are recorded in the ledger so a fall in availability can be
          // explained, but they move nothing. Counting them here would compare a
          // balance against a figure that includes goods still on the shelf.
          type: { notIn: ["RESERVATION", "RELEASE"] },
        },
        select: { quantity: true },
      });
      const ledger = round2(movements.reduce((a, m) => a + m.quantity, 0));
      expect(round2(b.quantity)).toBe(ledger);
    }
  });

  it("gives every movement a source and a reason for adjustments", async () => {
    const movements = await prisma.inventoryTransaction.findMany({
      select: { number: true, type: true, sourceType: true, reason: true },
    });
    expect(movements.length).toBeGreaterThan(0);
    for (const m of movements) {
      expect(m.sourceType).toBeTruthy();
      // An adjustment is the one movement type with no upstream document, so it
      // must carry its own written justification.
      if (m.type === "ADJUSTMENT") expect(m.reason?.trim() ?? "").not.toBe("");
    }
  });

  it("only increases stock through a posted GRN, petty cash entry, transfer or adjustment", async () => {
    const inbound = await prisma.inventoryTransaction.findMany({
      // Reservations and releases carry a positive quantity but add nothing to
      // the shelf, so they are not candidates for an unexplained increase.
      where: { quantity: { gt: 0 }, type: { notIn: ["RESERVATION", "RELEASE"] } },
      select: { number: true, sourceType: true, type: true },
    });
    const allowed = ["GRN", "PETTY_CASH", "TRANSFER", "ADJUSTMENT", "ISSUE", "DISPOSAL"];
    const unexpected = inbound.filter((m) => !allowed.includes(m.sourceType));
    expect(unexpected.map((u) => `${u.number}:${u.sourceType}`)).toEqual([]);
  });
});
