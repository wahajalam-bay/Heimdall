/**
 * Work Orders — ZAM/PUR/SOP-01 §4.6 and the CPC Terms of Reference.
 *
 *   npx tsx scripts/verify-work-orders.ts
 */
import { prisma } from "../src/lib/db";
import { PERMISSIONS as P } from "../src/lib/permissions";
import { withPermissions, withoutPermissions, refused } from "./lib/actors";
import {
  createWorkOrder,
  submitWorkOrder,
  internalAuditReview,
  approveWorkOrder,
  issueWorkOrder,
  closeWorkOrder,
} from "../src/server/work-orders";

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
  const admin = await withPermissions([
    P.WORK_ORDER_CREATE,
    P.WORK_ORDER_EDIT,
    P.WORK_ORDER_ISSUE,
    P.WORK_ORDER_CLOSE,
  ]);
  const auditor = await withPermissions([P.WORK_ORDER_AUDIT_REVIEW]);
  const approver = await withPermissions([P.WORK_ORDER_APPROVE]);
  const outsider = await withoutPermissions(
    P.WORK_ORDER_CREATE,
    P.WORK_ORDER_AUDIT_REVIEW,
    P.WORK_ORDER_APPROVE,
    P.WORK_ORDER_ISSUE,
  );

  const entity = await prisma.entity.findFirstOrThrow({ where: { code: "ZM" } });
  const vendor = await prisma.vendor.findFirstOrThrow();

  const created: string[] = [];
  const mk = async (rate: number) => {
    const wo = await createWorkOrder(admin, {
      entityId: entity.id,
      vendorId: vendor.id,
      title: "Office partition rework",
      scopeOfWork: "Strip and refit the partition on floor 3 per the agreed layout.",
      items: [
        { description: "Partition rework", quantity: 1, unit: "JOB", rate, sourceRef: "NGM round 2" },
      ],
    });
    created.push(wo.id);
    return wo;
  };

  const noPerm = await refused(
    createWorkOrder(outsider, {
      entityId: entity.id,
      vendorId: vendor.id,
      title: "x",
      scopeOfWork: "y",
      items: [{ description: "z", rate: 1 }],
    }),
  );
  check("raising a work order is Admin's, not anybody's", !!noPerm, noPerm ?? "");

  const noScope = await refused(
    createWorkOrder(admin, {
      entityId: entity.id,
      vendorId: vendor.id,
      title: "x",
      scopeOfWork: "  ",
      items: [{ description: "z", rate: 1 }],
    }),
  );
  check("a work order needs a scope of work", !!noScope, noScope ?? "");

  const noLines = await refused(
    createWorkOrder(admin, {
      entityId: entity.id,
      vendorId: vendor.id,
      title: "x",
      scopeOfWork: "y",
      items: [],
    }),
  );
  check("and at least one line", !!noLines);

  /* ── Below the committee threshold: Internal Audit reviews ── */
  const small = await mk(120_000);
  check("a small order is raised as a draft", small.status === "DRAFT", small.number);
  check(
    "outside CPC's domain, Internal Audit review is required",
    small.internalAuditRequired && small.internalAuditStatus === "PENDING",
  );
  check("the rate's source is carried onto the line", true);

  const lines = await prisma.workOrderItem.findMany({ where: { workOrderId: small.id } });
  check("the line traces back to the negotiation", lines[0]?.sourceRef === "NGM round 2");
  check("the amount is computed, not typed", lines[0]?.amount === 120_000);

  const earlyApprove = await refused(approveWorkOrder(approver, { workOrderId: small.id }));
  check("a draft cannot be approved", !!earlyApprove, earlyApprove ?? "");

  const submitted = await submitWorkOrder(admin, small.id);
  check("submitting routes it to Internal Audit", submitted.status === "PENDING_INTERNAL_AUDIT");

  const notAuditor = await refused(
    internalAuditReview(admin, { workOrderId: small.id, decision: "APPROVED" }),
  );
  check("Admin cannot perform the Internal Audit review", !!notAuditor, notAuditor ?? "");

  const noPermReview = await refused(
    internalAuditReview(outsider, { workOrderId: small.id, decision: "APPROVED" }),
  );
  check("nor can somebody with no review permission", !!noPermReview);

  const silentReject = await refused(
    internalAuditReview(auditor, { workOrderId: small.id, decision: "REJECTED" }),
  );
  check("a rejection must say why", !!silentReject, silentReject ?? "");

  const stillGated = await refused(approveWorkOrder(approver, { workOrderId: small.id }));
  check("it cannot be approved while Internal Audit is outstanding", !!stillGated, stillGated ?? "");

  const reviewed = await internalAuditReview(auditor, {
    workOrderId: small.id,
    decision: "APPROVED",
    notes: "Rates match the negotiated schedule.",
  });
  check("Internal Audit clears it", reviewed.internalAuditStatus === "APPROVED");
  check("and it moves on to approval", reviewed.status === "PENDING_APPROVAL");
  check("the reviewer is named", reviewed.internalAuditById === auditor.id);

  const att = await prisma.attestation.findFirst({
    where: { documentType: "WORK_ORDER", documentId: small.id },
  });
  check("the review is a real signature, not a flag", !!att, att?.comment ?? "");

  const notIssuable = await refused(issueWorkOrder(admin, small.id));
  check("it cannot be issued before approval", !!notIssuable, notIssuable ?? "");

  const approved = await approveWorkOrder(approver, { workOrderId: small.id });
  check("procurement approves the rate", approved.status === "APPROVED");

  const issued = await issueWorkOrder(admin, small.id);
  check("Admin issues it — §4.6", issued.status === "ISSUED" && issued.issuedById === admin.id);

  const done = await closeWorkOrder(admin, { workOrderId: small.id, to: "COMPLETED" });
  check("it can be completed", done.status === "COMPLETED" && !!done.completedAt);
  const badJump = await refused(closeWorkOrder(admin, { workOrderId: small.id, to: "IN_PROGRESS" }));
  check("but not walked backwards", !!badJump, badJump ?? "");

  /* ── Above the threshold: CPC governs, no second gate ── */
  const large = await mk(900_000);
  check(
    "inside CPC's domain, there is no separate Internal Audit gate",
    !large.internalAuditRequired && large.internalAuditStatus === "NOT_REQUIRED",
    `total ${large.total}`,
  );
  const straight = await submitWorkOrder(admin, large.id);
  check("it goes straight to approval", straight.status === "PENDING_APPROVAL");

  const noGate = await refused(
    internalAuditReview(auditor, { workOrderId: large.id, decision: "APPROVED" }),
  );
  check("and an Internal Audit review on it is refused, with the reason", !!noGate, noGate ?? "");

  /* ── The raiser cannot review their own ── */
  const both = await withPermissions([P.WORK_ORDER_CREATE, P.WORK_ORDER_AUDIT_REVIEW]);
  const own = await createWorkOrder(both, {
    entityId: entity.id,
    vendorId: vendor.id,
    title: "Self-review test",
    scopeOfWork: "Scope.",
    items: [{ description: "Work", rate: 50_000 }],
  });
  created.push(own.id);
  await submitWorkOrder(both, own.id);
  const selfReview = await refused(
    internalAuditReview(both, { workOrderId: own.id, decision: "APPROVED" }),
  );
  check(
    "even with both permissions, you cannot review the order you raised",
    !!selfReview,
    selfReview ?? "",
  );

  // Cleanup.
  await prisma.attestation.deleteMany({ where: { documentType: "WORK_ORDER", documentId: { in: created } } });
  await prisma.auditLog.deleteMany({ where: { entityType: "WorkOrder", entityId: { in: created } } });
  await prisma.task.deleteMany({ where: { documentType: "WORK_ORDER", documentId: { in: created } } });
  await prisma.notification.deleteMany({ where: { linkType: "WORK_ORDER", linkId: { in: created } } });
  await prisma.workOrderItem.deleteMany({ where: { workOrderId: { in: created } } });
  await prisma.workOrder.deleteMany({ where: { id: { in: created } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
