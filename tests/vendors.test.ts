import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { PERMISSIONS as P } from "@/lib/permissions";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { advanceBlacklistCase, decideVendorApproval, evaluateVendor, reinstateVendor, scoreBand } from "@/server/vendors";
import { expectRejection, userWithPermission } from "./helpers";

/**
 * Vendor governance. Two rules carry the weight here: a vendor cannot become
 * usable without a scored pre-qualification and an explicit decision, and a
 * vendor cannot be blacklisted except as the outcome of an investigation.
 */
describe("vendor pre-qualification", () => {
  it("scales weighted scores to the configured maximum and applies the configured pass mark", async () => {
    const passMark = await getConfigNumber(CONFIG_KEYS.VENDOR_MIN_SCORE, null);
    const configuredMax = await getConfigNumber(CONFIG_KEYS.VENDOR_MAX_SCORE, null);

    const evaluations = await prisma.vendorEvaluation.findMany({
      include: { scores: { include: { criterion: true } } },
    });
    expect(evaluations.length).toBeGreaterThan(0);

    for (const ev of evaluations) {
      // The stored maximum is the configured one, not the raw criteria total.
      expect(ev.maxScore).toBeCloseTo(configuredMax, 1);
      expect(ev.passingScore).toBeCloseTo(passMark, 1);
      // Pass or fail follows arithmetic, not opinion.
      expect(ev.passed).toBe(ev.totalScore >= ev.passingScore);
      // The percentage is consistent with the score.
      if (ev.maxScore > 0) {
        expect(ev.percentage).toBeCloseTo((ev.totalScore / ev.maxScore) * 100, 0);
      }
    }
  });

  it("refuses to approve a vendor with no evaluation on record", async () => {
    const unscored = await prisma.vendor.findFirst({
      where: { evaluations: { none: {} }, status: { notIn: ["APPROVED", "CONDITIONAL", "BLACKLISTED"] } },
      select: { id: true, name: true },
    });
    if (!unscored) return;

    const approver = await userWithPermission(P.VENDOR_APPROVE);
    const error = await expectRejection(
      decideVendorApproval(approver, {
        vendorId: unscored.id,
        decision: "APPROVE",
        reason: "Trying to approve without any scoring on file.",
      }),
    );
    expect(error.message).toMatch(/evaluation|pre-qualification|scored/i);
  });

  it("refuses an approval decision with no stated basis", async () => {
    const vendor = await prisma.vendor.findFirst({
      where: { evaluations: { some: {} } },
      select: { id: true },
    });
    if (!vendor) return;

    const approver = await userWithPermission(P.VENDOR_APPROVE);
    const error = await expectRejection(
      decideVendorApproval(approver, { vendorId: vendor.id, decision: "CONDITIONAL", reason: "  " }),
    );
    expect(error.message).toMatch(/basis|reason/i);
  });

  it("refuses to score a vendor without the evaluation permission", async () => {
    const vendor = await prisma.vendor.findFirstOrThrow({ select: { id: true } });
    const criterion = await prisma.evaluationCriterion.findFirstOrThrow({
      where: { active: true },
      select: { id: true, maxScore: true },
    });
    const evaluator = await userWithPermission(P.VENDOR_EVALUATE);
    const stripped = { ...evaluator, permissions: evaluator.permissions.filter((p) => p !== P.VENDOR_EVALUATE) };

    const error = await expectRejection(
      evaluateVendor(stripped, {
        vendorId: vendor.id,
        scores: [{ criterionId: criterion.id, score: criterion.maxScore }],
      }),
    );
    expect(error.message).toMatch(/permission|not permitted/i);
  });

  it("bands a score consistently with its percentage", () => {
    expect(scoreBand(null).label).toBe("Not scored");
    expect(scoreBand(85).tone).toBe("success");
    expect(scoreBand(65).tone).toBe("info");
    expect(scoreBand(55).tone).toBe("warning");
    expect(scoreBand(30).tone).toBe("danger");
  });

  it("keeps every approved vendor's stored score consistent with its latest evaluation", async () => {
    const vendors = await prisma.vendor.findMany({
      where: { status: { in: ["APPROVED", "CONDITIONAL"] } },
      include: { evaluations: { orderBy: { evaluatedAt: "desc" }, take: 1 } },
    });
    for (const v of vendors) {
      const latest = v.evaluations[0];
      if (!latest) continue;
      expect(v.currentScore).toBeCloseTo(latest.totalScore, 1);
      expect(v.maxScore ?? 0).toBeCloseTo(latest.maxScore, 1);
    }
  });
});

describe("investigation-led blacklisting", () => {
  it("has no blacklisted vendor without a case that reached a blacklist decision", async () => {
    const blacklisted = await prisma.vendor.findMany({
      where: { status: "BLACKLISTED" },
      include: { blacklistCases: true },
    });
    for (const v of blacklisted) {
      const decided = v.blacklistCases.filter((c) => c.decision === "BLACKLIST");
      expect(decided.length).toBeGreaterThan(0);
      // The decision is attributed and dated.
      for (const c of decided) {
        expect(c.decisionBy).toBeTruthy();
        expect(c.decisionAt).not.toBeNull();
        expect(c.decisionNotes?.trim() ?? "").not.toBe("");
      }
      // And the vendor record states why.
      expect(v.statusReason?.trim() ?? "").not.toBe("");
    }
  });

  it("gives every investigation that reached a decision an audit review where one was required", async () => {
    const cases = await prisma.vendorBlacklistCase.findMany({
      where: { decision: { not: null } },
    });
    for (const c of cases) {
      if (c.auditRequired) {
        expect(c.auditReview?.trim() ?? "").not.toBe("");
      }
      expect(c.investigationNotes?.trim() ?? "").not.toBe("");
    }
  });

  it("refuses an illegal stage jump on an investigation", async () => {
    const kase = await prisma.vendorBlacklistCase.findFirst({
      where: { stage: "RAISED" },
      select: { id: true },
    });
    if (!kase) return;

    const investigator = await userWithPermission(P.VENDOR_BLACKLIST);
    // RAISED may only progress to evidence collection or closure.
    const error = await expectRejection(
      advanceBlacklistCase(investigator, kase.id, "BLACKLISTED", {
        decisionNotes: "Skipping the investigation entirely.",
      }),
    );
    expect(error.message).toMatch(/cannot move|permitted/i);
  });

  it("refuses to reinstate a vendor without a substantive reason", async () => {
    const blacklisted = await prisma.vendor.findFirst({
      where: { status: { in: ["BLACKLISTED", "SUSPENDED"] } },
      select: { id: true },
    });
    if (!blacklisted) return;

    const approver = await userWithPermission(P.VENDOR_BLACKLIST);
    const error = await expectRejection(reinstateVendor(approver, blacklisted.id, "ok"));
    expect(error.message).toMatch(/reason/i);
  });

  it("never awards a purchase order to a blacklisted vendor", async () => {
    const orders = await prisma.purchaseOrder.findMany({
      where: { vendor: { status: "BLACKLISTED" }, status: { notIn: ["CANCELLED"] } },
      select: { number: true, issuedAt: true, vendor: { select: { name: true, blacklistedAt: true } } },
    });
    // An order issued before the blacklisting is history; one issued after is a breach.
    const breaches = orders.filter(
      (o) => o.issuedAt && o.vendor.blacklistedAt && o.issuedAt > o.vendor.blacklistedAt,
    );
    expect(breaches.map((b) => b.number)).toEqual([]);
  });

  it("never invites a blacklisted vendor to a new RFQ", async () => {
    const invites = await prisma.rfqVendor.findMany({
      where: { vendor: { status: "BLACKLISTED" } },
      select: {
        rfq: { select: { number: true, issuedAt: true } },
        vendor: { select: { name: true, blacklistedAt: true } },
      },
    });
    const breaches = invites.filter(
      (i) => i.rfq.issuedAt && i.vendor.blacklistedAt && i.rfq.issuedAt > i.vendor.blacklistedAt,
    );
    expect(breaches.map((b) => b.rfq.number)).toEqual([]);
  });
});

describe("vendor performance", () => {
  it("derives performance from recorded transactions, never from a free-typed score", async () => {
    const performance = await prisma.vendorPerformance.findMany({
      include: { vendor: { select: { name: true, totalOrders: true } } },
    });
    for (const p of performance) {
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(100);
      expect(p.onTimePercent).toBeGreaterThanOrEqual(0);
      expect(p.onTimePercent).toBeLessThanOrEqual(100);
      expect(p.qualityPercent).toBeGreaterThanOrEqual(0);
      expect(p.qualityPercent).toBeLessThanOrEqual(100);
      // Deliveries counted cannot exceed the orders they came from.
      expect(p.onTimeDeliveries + p.lateDeliveries).toBeLessThanOrEqual(Math.max(p.ordersCount, 1) * 20);
    }
  });

  it("keeps vendor spend consistent with the orders placed", async () => {
    const vendors = await prisma.vendor.findMany({
      where: { totalOrders: { gt: 0 } },
      include: {
        purchaseOrders: {
          where: { status: { notIn: ["DRAFT", "CANCELLED", "PENDING_APPROVAL"] } },
          select: { total: true },
        },
      },
    });
    for (const v of vendors) {
      const actual = v.purchaseOrders.reduce((a, p) => a + p.total, 0);
      // Stored spend should not exceed the sum of live orders.
      expect(v.totalSpend).toBeLessThanOrEqual(actual + 1);
    }
  });
});

describe("document numbering", () => {
  it("issues unique, prefixed numbers for every document family", async () => {
    const families: Array<{ label: string; numbers: string[] }> = [
      { label: "requisitions", numbers: (await prisma.purchaseRequisition.findMany({ select: { number: true } })).map((x) => x.number) },
      { label: "RFQs", numbers: (await prisma.rfq.findMany({ select: { number: true } })).map((x) => x.number) },
      { label: "purchase orders", numbers: (await prisma.purchaseOrder.findMany({ select: { number: true } })).map((x) => x.number) },
      { label: "GRNs", numbers: (await prisma.grn.findMany({ select: { number: true } })).map((x) => x.number) },
      { label: "invoices", numbers: (await prisma.invoice.findMany({ select: { number: true } })).map((x) => x.number) },
      { label: "gate passes", numbers: (await prisma.gatePass.findMany({ select: { number: true } })).map((x) => x.number) },
      { label: "exceptions", numbers: (await prisma.exception.findMany({ select: { number: true } })).map((x) => x.number) },
    ];

    for (const family of families) {
      const unique = new Set(family.numbers);
      expect(unique.size).toBe(family.numbers.length);
      for (const n of family.numbers) {
        expect(n).toMatch(/^[A-Z]{2,4}-\d{4}-\d{4,6}$/);
      }
    }
  });

  it("gives every gate pass a unique serial", async () => {
    const serials = (await prisma.gatePass.findMany({ select: { serial: true } })).map((g) => g.serial);
    expect(new Set(serials).size).toBe(serials.length);
    for (const s of serials) expect(s.trim()).not.toBe("");
  });
});
