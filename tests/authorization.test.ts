import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { PERMISSIONS as P, ROLE_DEFINITIONS } from "@/lib/permissions";
import { canAccessEntity, userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { decidePr, submitPr } from "@/server/pr";
import { createRfq } from "@/server/sourcing";
import { decidePo } from "@/server/po";
import { postGrn } from "@/server/grn";
import { approveInvoiceException, handoffToFinance, recordPayment } from "@/server/invoice";
import { createStoreIssue, decideStoreIssue } from "@/server/stores";
import { openBlacklistCase } from "@/server/vendors";
import { createPettyCash } from "@/server/pettycash";
import { expectRejection, only, sessionFor, userWithPermission, userWithoutPermission, without } from "./helpers";

/**
 * Authorisation is enforced on the server, on every call. These tests strip a
 * permission from an otherwise-valid session and assert the service refuses —
 * hiding a button is never the control.
 */
describe("server-side authorisation", () => {
  it("refuses to approve a requisition without the approval permission", async () => {
    const pr = await prisma.purchaseRequisition.findFirst({
      where: { status: "PENDING_APPROVAL" },
      select: { id: true, number: true },
    });
    if (!pr) {
      // Nothing pending in the seeded data: assert the guard directly instead.
      const stripped = only(await userWithPermission(P.PR_APPROVE), P.PR_VIEW);
      expect(userHasPermission(stripped, P.PR_APPROVE)).toBe(false);
      return;
    }
    const approver = await userWithPermission(P.PR_APPROVE);
    const stripped = without(approver, P.PR_APPROVE);
    const error = await expectRejection(decidePr(stripped, pr.id, "APPROVED", "Looks fine to me."));
    expect(error.message).toMatch(/permission|not permitted/i);
  });

  it("refuses to submit a requisition raised by somebody else", async () => {
    const pr = await prisma.purchaseRequisition.findFirst({
      where: { status: "DRAFT" },
      select: { id: true, requesterId: true },
    });
    if (!pr) return;
    const other = await prisma.user.findFirstOrThrow({
      where: { active: true, id: { not: pr.requesterId } },
      select: { email: true },
    });
    const session = without(await sessionFor(other.email), P.PR_APPROVE, P.PR_VIEW_ALL);
    const error = await expectRejection(submitPr(session, pr.id));
    expect(error.message).toBeTruthy();
  });

  it("refuses to issue an RFQ without the sourcing permission", async () => {
    const pr = await prisma.purchaseRequisition.findFirst({
      where: { status: { in: ["APPROVED", "SOURCING"] } },
      select: { id: true },
    });
    if (!pr) return;
    const buyer = await userWithPermission(P.RFQ_ISSUE);
    const stripped = without(buyer, P.RFQ_ISSUE);
    const error = await expectRejection(
      createRfq(stripped, {
        prId: pr.id,
        title: "Refused before anything is written",
        vendorIds: [],
        responseDeadline: new Date(Date.now() + 7 * 86400000),
      }),
    );
    expect(error.message).toMatch(/permission|not permitted/i);
  });

  it("refuses to approve a purchase order without the approval permission", async () => {
    const po = await prisma.purchaseOrder.findFirst({
      where: { status: "PENDING_APPROVAL" },
      select: { id: true },
    });
    if (!po) return;
    const approver = await userWithPermission(P.PO_APPROVE);
    const stripped = without(approver, P.PO_APPROVE);
    const error = await expectRejection(decidePo(stripped, po.id, "APPROVED", null));
    expect(error.message).toMatch(/permission|not permitted/i);
  });

  it("refuses to post a GRN without the posting permission", async () => {
    const grn = await prisma.grn.findFirst({ where: { status: { not: "POSTED" } }, select: { id: true } });
    if (!grn) return;
    const keeper = await userWithPermission(P.GRN_POST);
    const stripped = without(keeper, P.GRN_POST);
    const error = await expectRejection(postGrn(stripped, grn.id));
    expect(error.message).toMatch(/permission|not permitted/i);
  });

  it("refuses to waive an invoice mismatch without the override permission", async () => {
    const invoice = await prisma.invoice.findFirst({ where: { matchStatus: "FAILED" }, select: { id: true } });
    if (!invoice) return;
    const approver = await userWithPermission(P.INVOICE_EXCEPTION_APPROVE);
    const stripped = without(approver, P.INVOICE_EXCEPTION_APPROVE);
    const error = await expectRejection(
      approveInvoiceException(stripped, invoice.id, "Accepting the shortfall as agreed with the vendor."),
    );
    expect(error.message).toMatch(/authorised|permission|not permitted/i);
  });

  it("refuses to hand an invoice to finance without the handoff permission", async () => {
    const invoice = await prisma.invoice.findFirst({ select: { id: true } });
    if (!invoice) return;
    const finance = await userWithPermission(P.FINANCE_HANDOFF);
    const stripped = without(finance, P.FINANCE_HANDOFF);
    const error = await expectRejection(handoffToFinance(stripped, invoice.id, null));
    expect(error.message).toMatch(/permission|not permitted/i);
  });

  it("refuses to record a payment without the payment permission", async () => {
    const handoff = await prisma.paymentHandoff.findFirst({ select: { id: true } });
    if (!handoff) return;
    const finance = await userWithPermission(P.PAYMENT_RECORD);
    const stripped = without(finance, P.PAYMENT_RECORD);
    const error = await expectRejection(
      recordPayment(stripped, handoff.id, { paymentReference: "TEST-REFUSED" }),
    );
    expect(error.message).toMatch(/permission|not permitted/i);
  });

  it("refuses to raise a store issue without the issue permission", async () => {
    const store = await prisma.store.findFirstOrThrow({ where: { active: true }, select: { id: true } });
    const keeper = await userWithPermission(P.STORE_ISSUE);
    const stripped = without(keeper, P.STORE_ISSUE);
    const error = await expectRejection(
      createStoreIssue(stripped, {
        storeId: store.id,
        recipientName: "Test recipient",
        items: [{ itemId: "does-not-matter", requestedQty: 1, unit: "EA" }],
      }),
    );
    expect(error.message).toMatch(/permission|not permitted/i);
  });

  it("refuses to approve a store issue without the approval permission", async () => {
    const issue = await prisma.storeIssue.findFirst({ where: { status: "PENDING_APPROVAL" }, select: { id: true } });
    if (!issue) return;
    const approver = await userWithPermission(P.STORE_ISSUE_APPROVE);
    const stripped = without(approver, P.STORE_ISSUE_APPROVE);
    const error = await expectRejection(decideStoreIssue(stripped, { issueId: issue.id, approve: true }));
    expect(error.message).toMatch(/permission|not permitted/i);
  });

  it("refuses to open a vendor investigation without the issue-raising permission", async () => {
    const vendor = await prisma.vendor.findFirstOrThrow({ where: { status: "APPROVED" }, select: { id: true } });
    const raiser = await userWithPermission(P.VENDOR_ISSUE_RAISE);
    const stripped = without(raiser, P.VENDOR_ISSUE_RAISE, P.VENDOR_BLACKLIST);
    const error = await expectRejection(
      openBlacklistCase(stripped, {
        vendorId: vendor.id,
        reason: "Testing that this is refused.",
        reasonCode: "OTHER",
      }),
    );
    expect(error.message).toMatch(/permission|not permitted/i);
  });

  it("refuses to raise petty cash without the create permission", async () => {
    const entity = await prisma.entity.findFirstOrThrow({ select: { id: true } });
    const department = await prisma.department.findFirstOrThrow({
      where: { entityId: entity.id },
      select: { id: true },
    });
    const requester = await userWithPermission(P.PETTY_CASH_CREATE);
    const stripped = without(requester, P.PETTY_CASH_CREATE);
    const error = await expectRejection(
      createPettyCash(stripped, {
        entityId: entity.id,
        departmentId: department.id,
        purpose: "Testing that this is refused.",
        items: [{ description: "Test item", quantity: 1, unit: "EA", estimatedUnitPrice: 100 }],
      }),
    );
    expect(error.message).toMatch(/permission|not permitted/i);
  });
});

describe("entity scoping", () => {
  it("restricts a single-entity user to their own entity", async () => {
    const entities = await prisma.entity.findMany({ select: { id: true, code: true } });
    expect(entities.length).toBeGreaterThanOrEqual(2);

    const candidates = await prisma.user.findMany({
      where: { active: true },
      include: { entityAccess: true },
    });
    const single = candidates.find(
      (u) => u.primaryEntityId && u.entityAccess.filter((a) => a.entityId !== u.primaryEntityId).length === 0,
    );
    if (!single) return;

    const session = await sessionFor(single.email);
    const scoped = visibleEntityIds(session);
    expect(scoped).not.toBeNull();
    expect(scoped).toContain(single.primaryEntityId);

    const foreign = entities.find((e) => e.id !== single.primaryEntityId);
    if (foreign) expect(canAccessEntity(session, foreign.id)).toBe(false);
  });

  it("gives a user with explicit access to both entities a wider scope", async () => {
    const entities = await prisma.entity.count();
    const users = await prisma.user.findMany({ where: { active: true }, include: { entityAccess: true } });
    const multi = users.find((u) => u.entityAccess.length >= entities && entities >= 2);
    if (!multi) return;
    const session = await sessionFor(multi.email);
    expect(session.entityIds.length).toBeGreaterThanOrEqual(2);
  });
});

describe("role definitions", () => {
  it("gives every seeded role at least one permission", async () => {
    const roles = await prisma.role.findMany({ include: { permissions: true } });
    expect(roles.length).toBeGreaterThan(0);
    const empty = roles.filter((r) => r.permissions.length === 0);
    expect(empty.map((r) => r.code)).toEqual([]);
  });

  it("keeps every shipped role definition resolvable in the database", async () => {
    const codes = (await prisma.role.findMany({ select: { code: true } })).map((r) => r.code);
    for (const def of ROLE_DEFINITIONS) {
      expect(codes).toContain(def.code);
    }
  });

  it("ensures every permission a role references actually exists", async () => {
    const permissions = new Set((await prisma.permission.findMany({ select: { code: true } })).map((p) => p.code));
    const missing: string[] = [];
    for (const def of ROLE_DEFINITIONS) {
      for (const code of def.permissions) if (!permissions.has(code)) missing.push(`${def.code}:${code}`);
    }
    expect(missing).toEqual([]);
  });

  it("separates the ability to raise an exception from the ability to waive a blocking one", async () => {
    const raiser = await userWithoutPermission(P.INVOICE_EXCEPTION_APPROVE);
    expect(userHasPermission(raiser, P.INVOICE_EXCEPTION_APPROVE)).toBe(false);

    const approver = await userWithPermission(P.INVOICE_EXCEPTION_APPROVE);
    expect(userHasPermission(approver, P.INVOICE_EXCEPTION_APPROVE)).toBe(true);
  });
});
