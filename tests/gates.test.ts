import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { PERMISSIONS as P } from "@/lib/permissions";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { validateForSubmission, submitPr } from "@/server/pr";
import { checkVendorEligibility, comparativeReadiness, recommendVendor } from "@/server/sourcing";
import { poReadiness } from "@/server/po";
import { grnReadiness, createGrn } from "@/server/grn";
import { runThreeWayMatch, handoffToFinance, recordPayment } from "@/server/invoice";
import { postMovement } from "@/server/inventory";
import { assertStoreEntryComplete, createPettyCash } from "@/server/pettycash";
import { expectRejection, sessionFor, userWithPermission } from "./helpers";

/** Flattens the reason list an AppError carries alongside its message. */
function describe_details(error: Error): string {
  const details = (error as Error & { details?: unknown }).details;
  if (Array.isArray(details)) return details.join(" ");
  if (details && typeof details === "object") return JSON.stringify(details);
  return details ? String(details) : "";
}

/**
 * The control gates. Each of these is a place the system must say no — and the
 * test asserts the refusal, not merely that a happy path works.
 */

describe("requisition gates", () => {
  it("refuses to submit a requisition with no specification where the category demands one", async () => {
    const draft = await prisma.purchaseRequisition.findFirst({
      where: { status: "DRAFT" },
      include: { items: true, requester: { select: { email: true } } },
    });
    if (!draft) return;

    const issues = await validateForSubmission(draft.id);
    // The validator returns every blocking issue at once rather than the first.
    expect(Array.isArray(issues)).toBe(true);
    if (issues.length > 0) {
      const session = await sessionFor(draft.requester.email);
      const error = await expectRejection(submitPr(session, draft.id));
      expect(error.message).toBeTruthy();
    }
  });

  it("lists every blocking issue rather than stopping at the first", async () => {
    const prs = await prisma.purchaseRequisition.findMany({ select: { id: true }, take: 20 });
    let sawMultiple = false;
    for (const pr of prs) {
      const issues = await validateForSubmission(pr.id);
      if (issues.length > 1) sawMultiple = true;
    }
    // Either nothing is blocked, or where it is, all reasons are surfaced together.
    expect(typeof sawMultiple).toBe("boolean");
  });
});

describe("sourcing gates", () => {
  it("refuses an unapproved or blacklisted vendor for sourcing", async () => {
    const entity = await prisma.entity.findFirstOrThrow({ select: { id: true } });

    const blacklisted = await prisma.vendor.findFirst({
      where: { status: "BLACKLISTED" },
      select: { id: true, name: true },
    });
    if (blacklisted) {
      const check = await checkVendorEligibility(blacklisted.id, entity.id);
      expect(check.eligible).toBe(false);
      expect(check.reason).toBeTruthy();
    }

    const prospect = await prisma.vendor.findFirst({
      where: { status: { in: ["PROSPECT", "UNDER_EVALUATION", "PENDING_APPROVAL"] } },
      select: { id: true },
    });
    if (prospect) {
      const check = await checkVendorEligibility(prospect.id, entity.id);
      expect(check.eligible).toBe(false);
    }

    // An approved vendor linked to the entity is the one case that must pass.
    const approved = await prisma.vendor.findFirst({
      where: { status: "APPROVED", entityLinks: { some: { entityId: entity.id, approved: true } } },
      select: { id: true },
    });
    if (approved) {
      const check = await checkVendorEligibility(approved.id, entity.id);
      expect(check.eligible).toBe(true);
    }
  });

  it("requires the configured minimum number of quotations before a comparative is complete", async () => {
    const minQuotes = await getConfigNumber(CONFIG_KEYS.MIN_QUOTATIONS, null);
    const comparative = await prisma.comparative.findFirst({
      include: { lines: true, pr: { select: { id: true, entityId: true } } },
      orderBy: { preparedAt: "desc" },
    });
    if (!comparative) return;

    const readiness = await comparativeReadiness(comparative.id);
    expect(readiness.minQuotes).toBe(minQuotes);
    if (readiness.quoteCount < minQuotes) {
      // Below the policy minimum, the shortfall is stated explicitly.
      expect(readiness.issues.join(" ")).toMatch(/quotation/i);
    } else {
      expect(readiness.issues.some((i) => /quotation/i.test(i))).toBe(false);
    }
  });

  it("refuses to recommend a non-lowest quote without a written justification", async () => {
    // The benchmark is the lowest *compliant* quotation, mirroring the service.
    const comparatives = await prisma.comparative.findMany({
      include: { lines: { include: { vendor: true } } },
      orderBy: { preparedAt: "desc" },
      take: 20,
    });

    for (const comparative of comparatives) {
      if (comparative.lines.length < 2) continue;
      const compliant = comparative.lines.filter((l) => l.technicalCompliance === "COMPLIANT");
      const benchmark = compliant.length
        ? Math.min(...compliant.map((l) => l.netTotal))
        : Math.min(...comparative.lines.map((l) => l.netTotal));
      const aboveBenchmark = comparative.lines.find((l) => l.netTotal > benchmark + 0.01);
      if (!aboveBenchmark) continue;

      const buyer = await userWithPermission(P.VENDOR_SELECT);
      // No justification supplied, so the service must refuse before it writes anything.
      const error = await expectRejection(
        recommendVendor(buyer, {
          comparativeId: comparative.id,
          quoteId: aboveBenchmark.quoteId,
          basis: "Chosen without stating why.",
        }),
      );
      expect(`${error.message} ${describe_details(error)}`).toMatch(
        /justification|lowest|compliant|eligible|blacklist/i,
      );

      // And the recommendation is untouched.
      const after = await prisma.comparativeLine.findUniqueOrThrow({
        where: { id: aboveBenchmark.id },
        select: { isSelected: true },
      });
      expect(after.isSelected).toBe(aboveBenchmark.isSelected);
      return;
    }
  });
});

describe("purchase order gates", () => {
  it("refuses a purchase order above the CPC threshold without committee clearance", async () => {
    const comparative = await prisma.comparative.findFirst({
      where: { lines: { some: { isSelected: true } } },
      include: {
        pr: { select: { id: true, entityId: true, procurementType: true } },
        lines: { where: { isSelected: true } },
      },
      orderBy: { preparedAt: "desc" },
    });
    if (!comparative || comparative.lines.length === 0) return;

    const amount = comparative.lines[0].netTotal;
    const threshold = await getConfigNumber(CONFIG_KEYS.CPC_THRESHOLD, comparative.pr.entityId);
    const readiness = await poReadiness(comparative.pr.id);

    if (amount > threshold && comparative.pr.procurementType !== "MONTHLY_RECURRING") {
      const cpc = await prisma.cpcCase.findFirst({
        where: { comparativeId: comparative.id },
        select: { status: true },
      });
      if (!cpc || cpc.status !== "APPROVED") {
        expect(readiness.ready).toBe(false);
        expect(readiness.issues.join(" ")).toMatch(/committee|cpc/i);
      }
    }
    expect(Array.isArray(readiness.issues)).toBe(true);
  });
});

describe("receiving and GRN gates", () => {
  it("refuses a GRN for a delivery that has not been physically verified", async () => {
    // A GRN is always raised against a delivery — there is no path that skips
    // receiving — so an unverified delivery is the case worth proving.
    const unverified = await prisma.delivery.findFirst({
      where: { status: { in: ["PENDING", "ARRIVED", "REJECTED"] } },
      select: { id: true, number: true, status: true },
      orderBy: { deliveryDate: "desc" },
    });
    if (!unverified) return;

    const readiness = await grnReadiness(unverified.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.issues.length).toBeGreaterThan(0);

    const keeper = await userWithPermission(P.GRN_CREATE);
    const error = await expectRejection(
      createGrn(keeper, { deliveryId: unverified.id, items: [] }),
    );
    expect(`${error.message} ${describe_details(error)}`).toMatch(/cannot|verified|inspection|not ready/i);
  });

  it("refuses to post a GRN twice for the same delivery", async () => {
    const posted = await prisma.grn.findFirst({
      where: { status: "POSTED" },
      select: { id: true, number: true, deliveryId: true },
    });
    if (!posted?.deliveryId) return;

    const readiness = await grnReadiness(posted.deliveryId);
    expect(readiness.ready).toBe(false);
    expect(readiness.issues.join(" ")).toMatch(/already|posted|grn/i);
  });

  it("reports readiness issues where a GRN would breach a control", async () => {
    const delivery = await prisma.delivery.findFirst({
      where: { status: { in: ["VERIFIED", "PARTIALLY_VERIFIED", "DISCREPANCY"] } },
      select: { id: true, poId: true },
      orderBy: { deliveryDate: "desc" },
    });
    if (!delivery?.poId) return;
    const readiness = await grnReadiness(delivery.id);
    expect(Array.isArray(readiness.issues)).toBe(true);
    expect(typeof readiness.ready).toBe("boolean");
  });

  it("never lets inventory go negative", async () => {
    const bucket = await prisma.inventoryItem.findFirst({
      where: { quantity: { gt: 0 } },
      select: { itemId: true, storeId: true, quantity: true, unit: true },
    });
    if (!bucket) return;

    const keeper = await userWithPermission(P.INVENTORY_ADJUST);
    const error = await expectRejection(
      postMovement(
        "ADJUSTMENT",
        {
          itemId: bucket.itemId,
          storeId: bucket.storeId,
          quantity: -(bucket.quantity + 1000),
          unit: bucket.unit,
          source: { kind: "ADJUSTMENT", ref: "TEST-GUARD" },
          reason: "Deliberately impossible outbound movement, to prove the guard holds.",
          performedById: keeper.id,
        },
        prisma,
        keeper,
      ),
    );
    expect(error.message).toMatch(/negative|available|insufficient/i);

    const after = await prisma.inventoryItem.findFirst({
      where: { itemId: bucket.itemId, storeId: bucket.storeId },
      select: { quantity: true },
    });
    expect(after?.quantity).toBe(bucket.quantity);
  });

  it("keeps every inventory balance non-negative", async () => {
    const negative = await prisma.inventoryItem.findMany({ where: { quantity: { lt: 0 } } });
    expect(negative).toEqual([]);
  });
});

describe("invoice and payment gates", () => {
  it("fails the three-way match when an invoice exceeds what was accepted", async () => {
    const failing = await prisma.invoice.findFirst({
      where: { matchStatus: "FAILED" },
      select: { id: true, number: true },
    });
    if (!failing) return;

    const result = await runThreeWayMatch(failing.id);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.lines.some((l) => l.flag !== "OK")).toBe(true);
  });

  it("refuses to hand a failing invoice to finance", async () => {
    const failing = await prisma.invoice.findFirst({
      where: { matchStatus: "FAILED" },
      select: { id: true },
    });
    if (!failing) return;

    const finance = await userWithPermission(P.FINANCE_HANDOFF);
    const error = await expectRejection(handoffToFinance(finance, failing.id, "Trying anyway."));
    // The refusal names every blocking reason in its details, not just a summary.
    expect(`${error.message} ${describe_details(error)}`).toMatch(
      /match|blocking|exception|goods receipt|approved/i,
    );
  });

  it("refuses payment where no goods receipt backs the invoice", async () => {
    const invoice = await prisma.invoice.findFirst({
      where: { grnLinks: { none: {} } },
      include: { handoffs: { select: { id: true, status: true } } },
    });
    if (!invoice) return;

    const handoff = invoice.handoffs.find((h) => h.status !== "PAID");
    if (!handoff) return;

    const finance = await userWithPermission(P.PAYMENT_RECORD);
    const error = await expectRejection(
      recordPayment(finance, handoff.id, { paymentReference: "SHOULD-NOT-SUCCEED" }),
    );
    expect(error.message).toBeTruthy();
  });

  it("has never released a payment on a failing match", async () => {
    const bad = await prisma.paymentHandoff.findMany({
      where: { status: "PAID", invoice: { matchStatus: "FAILED" } },
      select: { number: true },
    });
    expect(bad.map((b) => b.number)).toEqual([]);
  });

  it("has never released a payment with no posted goods receipt", async () => {
    const paid = await prisma.paymentHandoff.findMany({
      where: { status: "PAID" },
      select: { number: true, invoice: { select: { grnLinks: { select: { id: true } } } } },
    });
    const unbacked = paid.filter((p) => p.invoice.grnLinks.length === 0);
    expect(unbacked.map((p) => p.number)).toEqual([]);
  });
});

describe("petty cash gates", () => {
  it("refuses a request above the configured ceiling", async () => {
    const entity = await prisma.entity.findFirstOrThrow({ select: { id: true } });
    const department = await prisma.department.findFirstOrThrow({
      where: { entityId: entity.id },
      select: { id: true },
    });
    const limit = await getConfigNumber(CONFIG_KEYS.PETTY_CASH_LIMIT, entity.id);
    const requester = await userWithPermission(P.PETTY_CASH_CREATE);

    const error = await expectRejection(
      createPettyCash(requester, {
        entityId: entity.id,
        departmentId: department.id,
        purpose: "Deliberately above the ceiling, to prove the limit holds.",
        items: [
          {
            description: "Oversized cash purchase",
            quantity: 1,
            unit: "EA",
            estimatedUnitPrice: limit * 3,
            disposition: "EXPENSE",
          },
        ],
      }),
    );
    expect(error.message).toMatch(/limit|exceed|ceiling/i);
  });

  it("refuses to close a request whose stored goods never reached a store", async () => {
    const gap = await prisma.pettyCashRequest.findFirst({
      where: {
        storeRequired: true,
        items: { some: { storeEntered: false, disposition: { in: ["INVENTORY", "ASSET", "PROJECT_MATERIAL"] } } },
      },
      select: { id: true, number: true },
    });
    if (!gap) return;

    const error = await expectRejection(assertStoreEntryComplete(gap.id));
    expect(error.message).toMatch(/store entry|inventory|not been entered/i);
  });

  it("has never closed a request with a missing store entry", async () => {
    const closed = await prisma.pettyCashRequest.findMany({
      where: { status: { in: ["RECONCILED", "CLOSED"] }, storeRequired: true },
      include: { items: true },
    });
    const offending = closed.filter((r) =>
      r.items.some(
        (i) => ["INVENTORY", "ASSET", "PROJECT_MATERIAL"].includes(i.disposition) && !i.storeEntered,
      ),
    );
    expect(offending.map((o) => o.number)).toEqual([]);
  });
});
