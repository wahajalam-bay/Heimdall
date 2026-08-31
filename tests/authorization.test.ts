import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { PERMISSIONS as P, ROLE_DEFINITIONS } from "@/lib/permissions";
import { PR_TRANSITION_AUTHORITY } from "@/lib/domain";
import { canAccessEntity, userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { decidePr, submitPr, transitionPr } from "@/server/pr";
import { createRfq } from "@/server/sourcing";
import { decidePo, recomputePoFulfilment } from "@/server/po";
import { postGrn } from "@/server/grn";
import { approveInvoiceException, handoffToFinance, recordPayment } from "@/server/invoice";
import { createStoreIssue, decideStoreIssue } from "@/server/stores";
import { computeVendorPerformance, openBlacklistCase } from "@/server/vendors";
import { createPettyCash } from "@/server/pettycash";
import { createCpcCase, resolveCpcCase } from "@/server/cpc";
import { scheduleInspection } from "@/server/receiving";
import { tagAssetsFromGrn } from "@/server/assets";
import { MOVEMENT_AUTHORITY, postMovement } from "@/server/inventory";
import { reserveStock } from "@/server/reservations";
import { verifyCostAnalysis } from "@/server/cost-analysis";
import { DOMAIN_ACTIONS, assertAuthority, isSystemActor, systemActor } from "@/lib/actor";
import { SOD_RULES, SOD_RULE_DEFS, assertNoRoleConflict, assertSeparation, roleConflicts } from "@/lib/sod";
import {
  ACTORS,
  expectRejection,
  only,
  sessionFor,
  userWithPermission,
  userWithoutPermission,
  without,
} from "./helpers";

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

/**
 * The domain layer is the enforcement point.
 *
 * Everything above tests a function that already refused. These tests cover the
 * functions that did not: a mutation reachable with nothing but a signed-in
 * session. They call the domain function directly, with no page and no server
 * action in the way, because that is exactly the path an authorization bug takes.
 */
describe("domain-level authorization", () => {
  it("refuses to resolve a CPC case without the committee decision permission", async () => {
    const caseId = (
      await prisma.cpcCase.findFirst({
        where: { status: { in: ["PENDING", "SCHEDULED", "IN_MEETING"] } },
        select: { id: true },
      })
    )?.id ?? (await prisma.cpcCase.findFirst({ select: { id: true } }))?.id;
    if (!caseId) return;

    const before = await prisma.cpcCase.findUniqueOrThrow({ where: { id: caseId } });
    // Somebody with no CPC authority at all, not a stripped committee member.
    const outsider = await userWithoutPermission(P.CPC_DECIDE, P.CPC_MANAGE);
    const error = await expectRejection(
      resolveCpcCase(outsider, caseId, "APPROVED", "Should never be recorded."),
    );
    expect(error.message).toMatch(/permission|authoriz|authoris/i);

    // A refusal that half-applies is worse than none, so the case is re-read.
    const after = await prisma.cpcCase.findUniqueOrThrow({ where: { id: caseId } });
    expect(after.status).toBe(before.status);
    expect(after.decidedAt?.toISOString() ?? null).toBe(before.decidedAt?.toISOString() ?? null);
  });

  it("records a refused CPC decision, so the attempt is not invisible", async () => {
    const kase = await prisma.cpcCase.findFirst({ select: { id: true } });
    if (!kase) return;
    const outsider = await userWithoutPermission(P.CPC_DECIDE, P.CPC_MANAGE);
    const before = await prisma.auditLog.count({
      where: { entityId: kase.id, action: "CPC_DECISION_REFUSED" },
    });
    await expectRejection(resolveCpcCase(outsider, kase.id, "APPROVED", null));
    const after = await prisma.auditLog.count({
      where: { entityId: kase.id, action: "CPC_DECISION_REFUSED" },
    });
    expect(after).toBe(before + 1);

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: kase.id, action: "CPC_DECISION_REFUSED" },
      orderBy: { createdAt: "desc" },
    });
    expect(row.actorId).toBe(outsider.id);
    expect(row.reason).toBeTruthy();
  });

  it("refuses every CPC outcome, not only approval", async () => {
    const caseId = (await prisma.cpcCase.findFirst({ select: { id: true } }))?.id;
    if (!caseId) return;
    const outsider = await userWithoutPermission(P.CPC_DECIDE, P.CPC_MANAGE);
    for (const outcome of ["APPROVED", "REJECTED", "RETURNED", "CLARIFICATION", "DEFERRED"] as const) {
      const error = await expectRejection(resolveCpcCase(outsider, caseId, outcome, "Refused."));
      expect(error.message).toMatch(/permission|authoriz|authoris/i);
    }
  });

  it("refuses to raise a CPC case without the raising permission", async () => {
    const comparative = await prisma.comparative.findFirst({ select: { id: true } });
    if (!comparative) return;
    const outsider = await userWithoutPermission(P.CPC_CASE_RAISE, P.CPC_MANAGE);
    const error = await expectRejection(createCpcCase(outsider, { comparativeId: comparative.id }));
    expect(error.message).toMatch(/permission|authoriz|authoris/i);
  });

  it("refuses to move a requisition between states without the state's permission", async () => {
    const pr = await prisma.purchaseRequisition.findFirst({
      where: { status: { in: ["SUBMITTED", "UNDER_DEPARTMENT_APPROVAL"] } },
      select: { id: true, status: true, requesterId: true },
    });
    if (!pr) return;
    const requester = await prisma.user.findUniqueOrThrow({
      where: { id: pr.requesterId },
      select: { email: true },
    });
    // The requester themselves, stripped of approval rights: the state machine
    // permits the move, so only the permission check can stop it.
    const session = without(await sessionFor(requester.email), P.PR_APPROVE, P.PR_SUBMIT);
    const error = await expectRejection(transitionPr(session, pr.id, "APPROVED"));
    expect(error.message).toMatch(/permission|authoriz|authoris/i);

    const after = await prisma.purchaseRequisition.findUniqueOrThrow({ where: { id: pr.id } });
    expect(after.status).toBe(pr.status);
  });

  it("does not let `force` skip the permission check as well as the state machine", async () => {
    const pr = await prisma.purchaseRequisition.findFirst({ select: { id: true, status: true } });
    if (!pr) return;
    const outsider = await userWithoutPermission(P.PR_APPROVE, P.PO_APPROVE, P.PO_ISSUE, P.PR_CANCEL);
    const error = await expectRejection(
      transitionPr(outsider, pr.id, "PO_ISSUED", { force: true, reason: "Forcing it." }),
    );
    expect(error.message).toMatch(/permission|authoriz|authoris/i);
    const after = await prisma.purchaseRequisition.findUniqueOrThrow({ where: { id: pr.id } });
    expect(after.status).toBe(pr.status);
  });

  it("refuses to schedule an inspection without the scheduling permission", async () => {
    const delivery = await prisma.delivery.findFirst({
      select: { id: true, poId: true, items: { select: { poItemId: true } } },
    });
    if (!delivery) return;
    const outsider = await userWithoutPermission(P.INSPECTION_SCHEDULE, P.INSPECTION_PERFORM);
    const error = await expectRejection(
      scheduleInspection(outsider, {
        deliveryId: delivery.id,
        poId: delivery.poId,
        poItemIds: delivery.items.map((i) => i.poItemId),
      }),
    );
    expect(error.message).toMatch(/permission|authoriz|authoris/i);
  });

  it("refuses to tag assets from a receipt without asset authority", async () => {
    const grn = await prisma.grn.findFirst({ where: { status: "POSTED" }, select: { id: true } });
    if (!grn) return;
    const outsider = await userWithoutPermission(P.ASSET_MANAGE, P.GRN_POST);
    const error = await expectRejection(tagAssetsFromGrn(outsider, grn.id));
    expect(error.message).toMatch(/permission|authoriz|authoris/i);
  });

  it("refuses to recompute purchase order fulfilment without order authority", async () => {
    const po = await prisma.purchaseOrder.findFirst({ select: { id: true } });
    if (!po) return;
    const outsider = await userWithoutPermission(P.PO_EDIT, P.PO_APPROVE, P.GRN_POST, P.GRN_CANCEL);
    const error = await expectRejection(recomputePoFulfilment(po.id, outsider));
    expect(error.message).toMatch(/permission|authoriz|authoris/i);
  });

  it("refuses to move stock without the movement's own permission", async () => {
    const bucket = await prisma.inventoryItem.findFirst({
      where: { quantity: { gt: 0 } },
      select: { itemId: true, storeId: true, item: { select: { unit: true } } },
    });
    if (!bucket) return;
    const outsider = await userWithoutPermission(P.STORE_ISSUE, P.SR_ISSUE);
    const error = await expectRejection(
      postMovement(
        "ISSUE",
        {
          itemId: bucket.itemId,
          storeId: bucket.storeId,
          quantity: 1,
          unit: bucket.item.unit,
          source: { kind: "ISSUE", id: "authz-check", ref: "AUTHZ-CHECK" },
          performedById: outsider.id,
        },
        undefined,
        outsider,
      ),
    );
    expect(error.message).toMatch(/permission|authoriz|authoris/i);
  });

  it("refuses to reserve stock without the reservation permission", async () => {
    const bucket = await prisma.inventoryItem.findFirst({
      where: { quantity: { gt: 0 } },
      select: { itemId: true, storeId: true, item: { select: { unit: true } } },
    });
    if (!bucket) return;
    const outsider = await userWithoutPermission(P.INVENTORY_RESERVE);
    const error = await expectRejection(
      reserveStock(outsider, {
        itemId: bucket.itemId,
        storeId: bucket.storeId,
        quantity: 1,
        unit: bucket.item.unit,
        createdById: outsider.id,
      }),
    );
    expect(error.message).toMatch(/permission|authoriz|authoris/i);
  });

  it("refuses to write vendor performance scores without evaluation authority", async () => {
    const vendor = await prisma.vendor.findFirstOrThrow({ select: { id: true } });
    const outsider = await userWithoutPermission(P.VENDOR_EVALUATE, P.VENDOR_APPROVE);
    const end = new Date();
    const error = await expectRejection(
      computeVendorPerformance(outsider, vendor.id, new Date(end.getTime() - 86400000 * 90), end),
    );
    expect(error.message).toMatch(/permission|authoriz|authoris/i);
  });

  it("leaves no exported mutation in the domain layer without a check", async () => {
    // The guard for the whole sweep: a new mutating export that authorizes
    // nothing fails here rather than in production. Read from source so it
    // cannot drift from what the modules actually do.
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = "src/server";
    const writes =
      /\b(?:tx|db|prisma|client)\.[a-zA-Z]\w*\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
    const checks =
      /\b(?:assertAuthority|assertPermission|userHasPermission|userHasAllPermissions|assertEntityAccess|canAccessEntity|canViewDocument)\b|\bneed\(/;

    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const lines = readFileSync(`${dir}/${file}`, "utf8").split("\n");
      let i = 0;
      while (i < lines.length) {
        const head = /^export\s+(?:async\s+)?function\s+(\w+)/.exec(lines[i]);
        if (!head) {
          i += 1;
          continue;
        }
        // Body starts at the first brace seen outside the parameter list, so a
        // brace inside an inline parameter type does not end the function early.
        let paren = 0;
        let brace = 0;
        let inBody = false;
        let end = i;
        const body: string[] = [];
        for (let j = i; j < lines.length; j++) {
          body.push(lines[j]);
          const bare = lines[j].replace(/"[^"]*"|'[^']*'|`[^`]*`|\/\/.*$/g, "");
          for (const ch of bare) {
            if (!inBody) {
              if (ch === "(") paren += 1;
              else if (ch === ")") paren -= 1;
              else if (ch === "{" && paren === 0) {
                inBody = true;
                brace = 1;
              }
            } else if (ch === "{") brace += 1;
            else if (ch === "}") {
              brace -= 1;
              if (brace === 0) {
                end = j;
                j = lines.length;
                break;
              }
            }
          }
        }
        const text = body.join("\n");
        if (writes.test(text) && !checks.test(text)) offenders.push(`${file}:${head[1]}`);
        i = end + 1;
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The cascade and system-actor mechanisms exist so that inner steps can be
 * authorized honestly rather than skipped. These tests hold them to that: a
 * cascade must still verify the actor, and a system actor must be refused
 * anything outside its declared grant.
 */
describe("authority grounds", () => {
  it("re-verifies the originating permission on a cascade instead of trusting the caller", () => {
    const holder = { id: "u1", name: "Holder", roleNames: ["Store Manager"], permissions: [P.GRN_POST] };
    const bystander = { id: "u2", name: "Bystander", roleNames: [], permissions: [] };
    const grounds = { cascade: "goods receipt posted", from: [P.GRN_POST] } as const;

    expect(() =>
      assertAuthority(holder as never, DOMAIN_ACTIONS.PO_FULFILMENT_RECOMPUTE, grounds),
    ).not.toThrow();
    expect(() =>
      assertAuthority(bystander as never, DOMAIN_ACTIONS.PO_FULFILMENT_RECOMPUTE, grounds),
    ).toThrow(/follows from|not authorized/i);
  });

  it("refuses an empty permission requirement rather than treating it as open", () => {
    const anyone = { id: "u3", name: "Anyone", roleNames: [], permissions: [P.PR_APPROVE] };
    expect(() =>
      assertAuthority(anyone as never, DOMAIN_ACTIONS.PR_TRANSITION, { permission: [] }),
    ).toThrow(/no permission requirement/i);
  });

  it("allows the record's owner and refuses everybody else without the fallback permission", () => {
    const owner = { id: "owner", name: "Owner", roleNames: [], permissions: [] };
    const other = { id: "other", name: "Other", roleNames: [], permissions: [] };
    const grounds = { ownRecord: "Submitting a requisition", orPermission: [P.PR_SUBMIT] } as const;

    expect(() =>
      assertAuthority(owner as never, DOMAIN_ACTIONS.PR_TRANSITION, grounds, { ownerId: "owner" }),
    ).not.toThrow();
    expect(() =>
      assertAuthority(other as never, DOMAIN_ACTIONS.PR_TRANSITION, grounds, { ownerId: "owner" }),
    ).toThrow(/owner/i);
  });

  it("holds a system actor to its declared grant", () => {
    const scheduler = systemActor("SCHEDULER");
    // Granted: the nightly rollup is what this principal exists for.
    expect(() =>
      assertAuthority(scheduler, DOMAIN_ACTIONS.VENDOR_PERFORMANCE_COMPUTE, { permission: [] }),
    ).not.toThrow();
    // Not granted — and refused despite its permission list being empty, so the
    // action grant is doing the work rather than a blanket bypass.
    for (const action of [
      DOMAIN_ACTIONS.CPC_CASE_RESOLVE,
      DOMAIN_ACTIONS.PR_TRANSITION,
      DOMAIN_ACTIONS.POLICY_LAPSE_EXPIRED,
    ]) {
      expect(() => assertAuthority(scheduler, action, { permission: [P.CPC_DECIDE] })).toThrow(
        /not authorized for/i,
      );
    }
  });

  it("does not block the person who actually does the work", async () => {
    // The risk in a cascade is the opposite of the risk it fixes: set the
    // grounds too tight and receiving stops. A site store user holds `grn.post`
    // and none of `asset.manage`, `po.edit`, `inventory.adjust` or
    // `variance.resolve` — yet posting a receipt legitimately tags assets,
    // recomputes the order, moves stock and records variances. Every ground
    // `postGrn` passes is checked against that real permission set.
    const keeper = await userWithPermission(P.GRN_POST);
    const postGrounds = { cascade: "goods receipt posted", from: [P.GRN_POST] } as const;

    for (const action of [
      DOMAIN_ACTIONS.ASSET_TAG_FROM_GRN,
      DOMAIN_ACTIONS.PO_FULFILMENT_RECOMPUTE,
      DOMAIN_ACTIONS.PR_TRANSITION,
      DOMAIN_ACTIONS.VARIANCE_RECORD,
    ]) {
      expect(() => assertAuthority(keeper, action, postGrounds)).not.toThrow();
    }

    // And the movement it posts is authorised by the receipt permission on its
    // own, with no cascade needed.
    expect(() =>
      assertAuthority(keeper, DOMAIN_ACTIONS.INVENTORY_MOVEMENT_POST, {
        permission: MOVEMENT_AUTHORITY.RECEIPT,
      }),
    ).not.toThrow();
  });

  it("keeps a cancellation's grounds separate from a posting's", async () => {
    // `grn.cancel` is a different permission from `grn.post`, and the reversal
    // it causes travels on its own grounds rather than borrowing the poster's.
    const canceller = await userWithPermission(P.GRN_CANCEL);
    expect(() =>
      assertAuthority(canceller, DOMAIN_ACTIONS.PO_FULFILMENT_RECOMPUTE, {
        cascade: "goods receipt cancelled",
        from: [P.GRN_CANCEL],
      }),
    ).not.toThrow();

    const poster = await userWithoutPermission(P.GRN_CANCEL);
    expect(() =>
      assertAuthority(poster, DOMAIN_ACTIONS.PO_FULFILMENT_RECOMPUTE, {
        cascade: "goods receipt cancelled",
        from: [P.GRN_CANCEL],
      }),
    ).toThrow(/follows from|not authorized/i);
  });

  it("lets a requisition travel its whole approved path on real permission sets", async () => {
    // Each state entered by the ordinary flow, checked against a session that
    // actually holds the permission the map names — so a typo in
    // PR_TRANSITION_AUTHORITY that locks out a legitimate role fails here.
    for (const [state, required] of Object.entries(PR_TRANSITION_AUTHORITY)) {
      if (!required.length) continue;
      const holder = await userWithPermission(required[0]);
      expect(() =>
        assertAuthority(holder, DOMAIN_ACTIONS.PR_TRANSITION, { permission: required }),
      ).not.toThrow();
      expect(state).toBeTruthy();
    }
  });

  it("grants a system actor only what a wired job actually calls", () => {
    // An unused grant is authority nobody asked for. The migration principal
    // exists for one backfill; it must not be able to move a requisition.
    const migration = systemActor("MIGRATION");
    expect(migration.allowedActions).toEqual([DOMAIN_ACTIONS.ALLOCATION_BACKFILL]);
    expect(() =>
      assertAuthority(migration, DOMAIN_ACTIONS.PR_TRANSITION, { permission: [P.PR_APPROVE] }),
    ).toThrow(/not authorized for/i);
  });

  it("gives a system actor no human permissions to inherit", () => {
    for (const purpose of ["SCHEDULER", "MIGRATION", "SEED"] as const) {
      expect(systemActor(purpose).permissions).toEqual([]);
    }
  });

  it("cannot be presented by a request: a session user is never a system actor", async () => {
    const admin = await sessionFor(ACTORS.admin);
    expect(isSystemActor(admin)).toBe(false);
    expect(admin.system).toBeUndefined();
  });
});

/** Segregation of duties: one person must not hold both sides of a document. */
describe("segregation of duties", () => {
  it("refuses to approve a requisition the actor raised themselves", async () => {
    const pr = await prisma.purchaseRequisition.findFirst({
      where: { status: { in: ["SUBMITTED", "UNDER_DEPARTMENT_APPROVAL"] } },
      select: { id: true, requesterId: true, status: true },
    });
    if (!pr) return;
    const requester = await prisma.user.findUniqueOrThrow({
      where: { id: pr.requesterId },
      select: { email: true },
    });
    // Given every approval right, so only the separation can refuse.
    const session = await sessionFor(requester.email);
    const armed = { ...session, permissions: [...new Set([...session.permissions, P.PR_APPROVE])] };
    const error = await expectRejection(decidePr(armed, pr.id, "APPROVED", "Approving my own."));
    expect(error.message).toMatch(/raised it|other than the person|approval pending/i);
    const after = await prisma.purchaseRequisition.findUniqueOrThrow({ where: { id: pr.id } });
    expect(after.status).toBe(pr.status);
  });

  it("names a source for every rule it enforces", () => {
    expect(SOD_RULE_DEFS.length).toBeGreaterThan(0);
    for (const rule of SOD_RULE_DEFS) {
      expect(rule.source).toBeTruthy();
      expect(rule.message.length).toBeGreaterThan(20);
    }
  });

  it("ships no prohibited role combinations, because the source states none", async () => {
    const everyRole = ROLE_DEFINITIONS.map((r) => r.code);
    expect(await roleConflicts(everyRole)).toEqual([]);
  });

  it("resolves cleanly when no combination is configured", async () => {
    await expect(assertNoRoleConflict(["REQUESTER", "PROCUREMENT_DIRECTOR"])).resolves.toBeUndefined();
  });
});

/**
 * The separation rules themselves, tested directly.
 *
 * The workflow test above can pass for the wrong reason — a seeded requisition
 * with no approval pending fails earlier, on a different rule. These call
 * `assertSeparation` with the counterpart set explicitly, so nothing else can
 * account for the refusal.
 */
describe("segregation of duties rules", () => {
  const someone = (id: string) => ({ id, name: `User ${id}`, roleNames: [], permissions: [] }) as never;

  it("refuses when the counterpart is the actor, for every registered rule", async () => {
    const pr = await prisma.purchaseRequisition.findFirstOrThrow({
      select: { id: true, number: true, entityId: true },
    });
    for (const rule of SOD_RULE_DEFS) {
      const actor = someone("sod-actor");
      const error = await expectRejection(
        assertSeparation(actor, rule.code, "sod-actor", {
          entityId: pr.entityId,
          documentType: "PurchaseRequisition",
          documentId: pr.id,
          documentRef: pr.number,
        }),
      );
      expect(error.message).toBe(rule.message);
    }
  });

  it("permits when the counterpart is somebody else", async () => {
    const pr = await prisma.purchaseRequisition.findFirstOrThrow({
      select: { id: true, number: true, entityId: true },
    });
    for (const rule of SOD_RULE_DEFS) {
      await expect(
        assertSeparation(someone("actor-a"), rule.code, "actor-b", {
          entityId: pr.entityId,
          documentType: "PurchaseRequisition",
          documentId: pr.id,
          documentRef: pr.number,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it("permits when there is no counterpart recorded at all", async () => {
    const pr = await prisma.purchaseRequisition.findFirstOrThrow({ select: { id: true, entityId: true } });
    for (const rule of SOD_RULE_DEFS) {
      await expect(
        assertSeparation(someone("actor-a"), rule.code, null, {
          entityId: pr.entityId,
          documentType: "PurchaseRequisition",
          documentId: pr.id,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it("records the block, so a suppressed control is not an invisible one", async () => {
    const pr = await prisma.purchaseRequisition.findFirstOrThrow({
      select: { id: true, number: true, entityId: true },
    });
    const before = await prisma.auditLog.count({
      where: { entityId: pr.id, action: "SOD_RULE_BLOCKED" },
    });
    await expectRejection(
      assertSeparation(someone("audited-actor"), SOD_RULES.PR_RAISE_APPROVE, "audited-actor", {
        entityId: pr.entityId,
        documentType: "PurchaseRequisition",
        documentId: pr.id,
        documentRef: pr.number,
      }),
    );
    const after = await prisma.auditLog.count({
      where: { entityId: pr.id, action: "SOD_RULE_BLOCKED" },
    });
    expect(after).toBe(before + 1);
  });

  it("enforces the cost analysis separation through the real verify path", async () => {
    // The one rule with a pre-existing implementation, now routed through the
    // registry: the preparer is refused even holding the verify permission.
    const c = await prisma.comparative.findFirst({
      where: { verifiedById: null },
      select: { id: true, preparedById: true },
    });
    if (!c?.preparedById) return;
    const preparer = await prisma.user.findUniqueOrThrow({
      where: { id: c.preparedById },
      select: { email: true },
    });
    const session = await sessionFor(preparer.email);
    const armed = { ...session, permissions: [...new Set([...session.permissions, P.COMPARATIVE_VERIFY])] };
    const error = await expectRejection(verifyCostAnalysis(armed, c.id));
    expect(error.message).toMatch(/other than the person who prepared/i);
  });
});
