import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { CONFIG_KEYS, setConfig } from "@/lib/config";
import { PERMISSIONS as P } from "@/lib/permissions";
import { round2 } from "@/lib/format";
import { generateVoucher, signVoucher, signatoryLadder, voucherReadiness } from "@/server/vouchers";
import { budgetPosition, checkBudget, upsertBudget } from "@/server/budget";
import { convertQuantity, deriveItemCode, pocFor, setDepartmentPoc } from "@/server/masters";
import { advanceReturn, recordVariance, resolveVariance } from "@/server/receiving-exceptions";
import { assertRequisitionComplete } from "@/server/pr";
import { PR_STATUSES, inRequisitionStage, requisitionComplete } from "@/lib/domain";
import { sessionFor, userWithPermission, without } from "./helpers";

/**
 * The finance chain and the receiving exceptions.
 *
 * The rules under test are the ones that stop money leaving on a document that
 * does not stand up: no voucher without a passing match, no payment without every
 * signature, no signature out of turn, and no difference between order and
 * receipt quietly disappearing.
 */

const ADMIN = "system.admin@zameen.com";

describe("payment vouchers", () => {
  it("refuses a voucher for an invoice whose match has not passed", async () => {
    const bad = await prisma.invoice.findFirst({
      where: { matchStatus: { in: ["FAILED", "PENDING"] } },
      select: { id: true },
    });
    if (!bad) return;
    const readiness = await voucherReadiness(bad.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join(" ")).toMatch(/match/i);
  });

  it("refuses a second voucher while one is already live", async () => {
    const withVoucher = await prisma.voucher.findFirst({
      where: { status: { notIn: ["CANCELLED", "REJECTED"] } },
      select: { invoiceId: true, number: true },
    });
    if (!withVoucher) return;
    const readiness = await voucherReadiness(withVoucher.invoiceId);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join(" ")).toContain(withVoucher.number);
  });

  it("builds a ladder from configuration, and only the rungs the amount reaches", async () => {
    const entity = await prisma.entity.findFirstOrThrow({ select: { id: true } });
    const user = await sessionFor(ADMIN);
    await setConfig(
      CONFIG_KEYS.SIGNATORY_LADDER,
      JSON.stringify([
        { roleCode: "FINANCE_USER", above: 0 },
        { roleCode: "FINANCE_APPROVER", above: 1_000_000 },
      ]),
      null,
      user.id,
    );

    const small = await signatoryLadder(entity.id, 50_000);
    const large = await signatoryLadder(entity.id, 5_000_000);
    expect(small).toHaveLength(1);
    expect(small[0].roleCode).toBe("FINANCE_USER");
    expect(large).toHaveLength(2);
    expect(large[1].roleCode).toBe("FINANCE_APPROVER");
  });

  it("refuses a signature from somebody who does not hold the rung", async () => {
    const voucher = await prisma.voucher.findFirst({
      where: { status: "PENDING_SIGNATORIES" },
      include: { signatures: { where: { status: "PENDING" }, orderBy: { sequence: "asc" } } },
    });
    if (!voucher?.signatures.length) return;
    const step = voucher.signatures[0];

    const outsider = await prisma.user.findFirst({
      where: { active: true, roles: { none: { role: { code: step.roleCode } } } },
      select: { email: true },
    });
    if (!outsider) return;
    const session = without(await sessionFor(outsider.email), P.VOUCHER_SIGN_ANY);
    await expect(signVoucher(session, { voucherId: voucher.id, approve: true })).rejects.toThrow(
      /do not hold that role|permission/i,
    );
  });

  it("keeps net equal to gross less withholding and deductions", async () => {
    const vouchers = await prisma.voucher.findMany({
      select: { grossAmount: true, withholdingTax: true, deductions: true, netAmount: true },
    });
    for (const v of vouchers) {
      expect(round2(v.grossAmount - v.withholdingTax - v.deductions)).toBeCloseTo(v.netAmount, 2);
    }
  });

  it("refuses to generate without the permission", async () => {
    const user = without(await sessionFor(ADMIN), P.VOUCHER_GENERATE);
    const invoice = await prisma.invoice.findFirstOrThrow({ select: { id: true } });
    await expect(generateVoucher(user, { invoiceId: invoice.id })).rejects.toThrow(/permission/i);
  });
});

describe("budgets", () => {
  it("derives committed and utilised from documents rather than a stored total", async () => {
    const budget = await prisma.budget.findFirst({ where: { active: true }, select: { id: true } });
    if (!budget) return;
    const position = await budgetPosition(budget.id);
    expect(position.committed).toBeGreaterThanOrEqual(0);
    expect(position.utilised).toBeGreaterThanOrEqual(0);
    // Utilisation can never exceed commitment: goods cannot be received against
    // an order that was never placed.
    expect(position.utilised).toBeLessThanOrEqual(position.committed + 0.01);
    expect(position.available).toBeCloseTo(round2(position.allocated - position.committed), 2);
  });

  it("blocks an over-commitment only when configuration says to", async () => {
    const user = await sessionFor(ADMIN);
    const budget = await prisma.budget.findFirst({
      where: { active: true },
      include: { entity: true },
    });
    if (!budget) return;
    const position = await budgetPosition(budget.id);
    const over = round2(position.available + 100_000);

    await setConfig(CONFIG_KEYS.BUDGET_CONTROL, "WARN", null, user.id);
    const warned = await checkBudget({
      entityId: budget.entityId,
      amount: over,
      departmentId: budget.departmentId,
      expenditureType: budget.expenditureType,
      year: budget.year,
    });
    expect(warned.blocked).toBe(false);

    await setConfig(CONFIG_KEYS.BUDGET_CONTROL, "BLOCK", null, user.id);
    try {
      const blocked = await checkBudget({
        entityId: budget.entityId,
        amount: over,
        departmentId: budget.departmentId,
        expenditureType: budget.expenditureType,
        year: budget.year,
      });
      if (blocked.budgetId) expect(blocked.blocked).toBe(true);
    } finally {
      await setConfig(CONFIG_KEYS.BUDGET_CONTROL, "WARN", null, user.id);
    }
  });

  it("refuses to set an allocation below what is already committed", async () => {
    const user = await sessionFor(ADMIN);
    const budget = await prisma.budget.findFirst({ where: { active: true } });
    if (!budget) return;
    const position = await budgetPosition(budget.id);
    if (position.committed <= 0) return;

    await expect(
      upsertBudget(user, {
        id: budget.id,
        entityId: budget.entityId,
        year: budget.year,
        departmentId: budget.departmentId,
        expenditureType: budget.expenditureType,
        allocated: round2(position.committed - 1),
      }),
    ).rejects.toThrow(/already committed/i);
  });
});

describe("receiving exceptions", () => {
  it("records a difference rather than letting it vanish", async () => {
    const po = await prisma.purchaseOrder.findFirst({ select: { id: true } });
    if (!po) return;
    const before = await prisma.poVariance.count({ where: { poId: po.id } });
    const v = await recordVariance(
      await userWithPermission(P.VARIANCE_RESOLVE),
      {
        poId: po.id,
        type: "QUANTITY",
        poQuantity: 100,
        grnQuantity: 95,
        poValue: 100_000,
        grnValue: 95_000,
        reasonCode: "SHORT_SUPPLY",
        reason: "Test variance",
      },
    );
    expect(v.variance).toBe(-5);
    expect(v.variancePct).toBeCloseTo(-5, 2);
    expect(v.status).toBe("OPEN");
    const after = await prisma.poVariance.count({ where: { poId: po.id } });
    expect(after).toBe(before + 1);

    // Cleaning up after itself, so the register is not littered with fixtures.
    await prisma.poVariance.delete({ where: { id: v.id } });
  });

  it("demands a resolution before a variance can be closed", async () => {
    const user = await sessionFor(ADMIN);
    const po = await prisma.purchaseOrder.findFirstOrThrow({ select: { id: true } });
    const v = await recordVariance(user, {
      poId: po.id,
      type: "QUANTITY",
      poQuantity: 10,
      grnQuantity: 9,
      reasonCode: "SHORT_SUPPLY",
    });
    try {
      await expect(
        resolveVariance(user, { varianceId: v.id, status: "ACCEPTED", resolution: "  " }),
      ).rejects.toThrow(/record how/i);

      const resolved = await resolveVariance(user, {
        varianceId: v.id,
        status: "RECOVERED",
        resolution: "Vendor supplied the balance on the next delivery.",
      });
      expect(resolved.status).toBe("RECOVERED");
      expect(resolved.resolvedById).toBe(user.id);
    } finally {
      await prisma.poVariance.delete({ where: { id: v.id } });
    }
  });

  it("will not close a return while a replacement is still owed", async () => {
    const user = await sessionFor(ADMIN);
    const ret = await prisma.vendorReturn.findFirst({
      where: { replacementRequired: true, replacementStatus: "AWAITED", status: "ACKNOWLEDGED" },
    });
    if (!ret) return;
    await expect(advanceReturn(user, { returnId: ret.id, to: "CLOSED" })).rejects.toThrow(/replacement/i);
  });

  it("refuses a return transition that skips a step", async () => {
    const user = await sessionFor(ADMIN);
    const draft = await prisma.vendorReturn.findFirst({ where: { status: "DRAFT" } });
    if (!draft) return;
    await expect(advanceReturn(user, { returnId: draft.id, to: "ACKNOWLEDGED" })).rejects.toThrow(/cannot move/i);
  });
});

describe("master data", () => {
  it("derives an item code from the configured rule", async () => {
    const category = await prisma.category.findFirst({
      where: { active: true, parentId: { not: null } },
      select: { id: true, code: true, parent: { select: { code: true } } },
    });
    if (!category) return;
    const { code, reason } = await deriveItemCode({ categoryId: category.id });
    if (!code) {
      // No rule configured is a legitimate answer, but it must say so.
      expect(reason).toBeTruthy();
      return;
    }
    expect(code).toContain(category.parent!.code);
    expect(code).toMatch(/\d{4}$/);
  });

  it("converts between units that share a base and refuses those that do not", async () => {
    const box = await prisma.uom.findUnique({ where: { code: "BOX" } });
    const kg = await prisma.uom.findUnique({ where: { code: "KG" } });
    if (!box || !kg) return;
    expect(await convertQuantity(2, "BOX", "EA")).toBeCloseTo(24, 2);
    await expect(convertQuantity(1, "BOX", "KG")).rejects.toThrow(/measures/i);
  });

  it("keeps one primary contact per responsibility", async () => {
    const user = await sessionFor(ADMIN);
    const department = await prisma.department.findFirst({ where: { active: true }, select: { id: true } });
    if (!department) return;
    const members = await prisma.user.findMany({ where: { active: true }, select: { id: true }, take: 2 });
    if (members.length < 2) return;

    await setDepartmentPoc(user, {
      departmentId: department.id,
      userId: members[0].id,
      responsibility: "RFQ",
      primary: true,
    });
    await setDepartmentPoc(user, {
      departmentId: department.id,
      userId: members[1].id,
      responsibility: "RFQ",
      primary: true,
    });

    const primaries = await prisma.departmentPoc.count({
      where: { departmentId: department.id, responsibility: "RFQ", primary: true, active: true },
    });
    expect(primaries).toBe(1);

    const poc = await pocFor(department.id, "RFQ");
    expect(poc?.userId).toBe(members[1].id);
  });
});

describe("the requisition and purchase order modules", () => {
  it("refuses sourcing against a requisition that is not yet approved", async () => {
    const user = await sessionFor(ADMIN);
    const early = await prisma.purchaseRequisition.findFirst({
      where: { status: { in: ["DRAFT", "SUBMITTED", "UNDER_DEPARTMENT_APPROVAL", "RETURNED"] } },
      select: { id: true, number: true, status: true },
    });
    if (!early) return;
    await expect(assertRequisitionComplete(early.id, "Raising an RFQ")).rejects.toThrow(
      /begins once the requisition is approved/i,
    );
  });

  it("allows the order module once the requisition is approved", async () => {
    const approved = await prisma.purchaseRequisition.findFirst({
      where: { status: { in: ["APPROVED", "PROCUREMENT_REVIEW", "SOURCING", "PO_PREPARATION"] } },
      select: { id: true },
    });
    if (!approved) return;
    const pr = await assertRequisitionComplete(approved.id, "Raising an RFQ");
    expect(requisitionComplete(pr.status)).toBe(true);
  });

  it("puts every status on exactly one side of the boundary", async () => {
    for (const status of PR_STATUSES) {
      if (["CLOSED", "REJECTED", "CANCELLED", "ON_HOLD"].includes(status)) continue;
      const inRequisition = inRequisitionStage(status);
      const inOrder = requisitionComplete(status);
      // Never both, never neither — a status belonging to no module is a case
      // nobody owns.
      expect(inRequisition !== inOrder).toBe(true);
    }
  });

  it("records the handover as its own event, separate from the status change", async () => {
    const handovers = await prisma.auditLog.findMany({
      where: { action: "REQUISITION_COMPLETED" },
      select: { entityRef: true, newValue: true },
      take: 5,
    });
    for (const h of handovers) {
      expect(h.newValue).toContain("PURCHASE_ORDER_MODULE");
    }
  });
});
