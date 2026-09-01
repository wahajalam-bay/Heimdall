import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { notify, createTask, completeTasks } from "@/lib/notify";
import { round2 } from "@/lib/format";
import { attest } from "./attestation";
import { cpcRequirement } from "./cpc";

/**
 * Work Orders.
 *
 * ZAM/PUR/SOP-01 gives them two clauses, and both are controls.
 *
 * **§4.6** — "Work order is to be issued by the **Admin department** on the
 * basis of **rates negotiated by Procurement**." Two departments in one
 * sentence: procurement gets the rate, admin raises the order. That separation
 * is the point, and it is what makes a work order something other than a
 * purchase order with a different heading.
 *
 * **CPC Terms of Reference, Services Acquisition for Admin** — "Any acquisition
 * of services not falling under the domain of Central Purchase Committee (CPC)
 * will fall under the domain of admin. However, **before raising any work order
 * it needs to be reviewed and approved by Internal Audit Department before the
 * finalization of the order.**"
 *
 * ## Where the Internal Audit gate applies
 *
 * On what falls *outside* CPC's domain — which is what the sentence says. Above
 * the committee threshold the CPC case is the review, and adding Internal Audit
 * on top would be inventing a second gate the SOP does not ask for. Below it,
 * the order has no committee behind it, and the IA review is the only thing
 * standing between an admin department and a signed commitment.
 *
 * The decision is taken from the value at the moment the order is raised and
 * then held on the row. A threshold changed next year must not make an order
 * signed this year look as though it was never gated.
 *
 * ## The separation is enforced, not assumed
 *
 * Admin holds create, edit, issue and close. Internal Audit holds the review and
 * nothing else. Neither role holds the other's permission by default, and the
 * review refuses a signer who raised the order — a department clearing its own
 * work order is the control failing silently.
 */

export const WORK_ORDER_STATES = [
  "DRAFT",
  "PENDING_INTERNAL_AUDIT",
  "PENDING_APPROVAL",
  "APPROVED",
  "ISSUED",
  "IN_PROGRESS",
  "COMPLETED",
  "CLOSED",
  "CANCELLED",
] as const;
export type WorkOrderState = (typeof WORK_ORDER_STATES)[number];

export type WorkOrderLineInput = {
  description: string;
  quantity?: number;
  unit?: string;
  rate: number;
  sourceRef?: string | null;
};

/**
 * Raises a work order.
 *
 * The Internal Audit requirement is decided here, from the value against the
 * committee threshold for services, and written onto the row.
 */
export async function createWorkOrder(
  user: SessionUser,
  input: {
    entityId: string;
    vendorId: string;
    title: string;
    scopeOfWork: string;
    prId?: string | null;
    rfqId?: string | null;
    comparativeId?: string | null;
    negotiationMinuteId?: string | null;
    departmentId?: string | null;
    projectId?: string | null;
    siteId?: string | null;
    currency?: string;
    taxAmount?: number;
    startDate?: Date | null;
    endDate?: Date | null;
    items: WorkOrderLineInput[];
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.WORK_ORDER_CREATE)) {
      throw new RuleViolationError(
        "ZAM/PUR/SOP-01 §4.6 puts the raising of a work order with the Admin department.",
      );
    }
    if (!input.title?.trim()) throw new ValidationError("Give the work order a title.");
    if (!input.scopeOfWork?.trim()) {
      throw new ValidationError(
        "Describe the scope of work. A work order without a scope cannot be checked against what was delivered.",
      );
    }
    if (!input.items?.length) throw new ValidationError("A work order needs at least one line.");

    const lines = input.items.map((l, i) => {
      if (!l.description?.trim()) throw new ValidationError(`Line ${i + 1}: describe the work.`);
      const quantity = round2(l.quantity ?? 1);
      const rate = round2(l.rate);
      if (quantity <= 0) throw new ValidationError(`Line ${i + 1}: quantity must be greater than zero.`);
      if (rate < 0) throw new ValidationError(`Line ${i + 1}: a rate cannot be negative.`);
      return {
        lineNo: i + 1,
        description: l.description.trim(),
        quantity,
        unit: l.unit?.trim() || "JOB",
        rate,
        amount: round2(quantity * rate),
        sourceRef: l.sourceRef?.trim() || null,
      };
    });

    const subtotal = round2(lines.reduce((a, l) => a + l.amount, 0));
    const taxAmount = round2(input.taxAmount ?? 0);
    const total = round2(subtotal + taxAmount);

    // Whether this falls outside CPC's domain is not a second opinion about the
    // threshold — it is the same question the committee module already answers,
    // asked through the same function. Duplicating the threshold logic here
    // would let the two drift, and a work order gated on one reading while the
    // committee uses another is exactly the gap the IA review exists to close.
    const cpc = await cpcRequirement(input.entityId, total, "SERVICE", tx);
    const outsideCpc = !cpc.required;

    const wo = await tx.workOrder.create({
      data: {
        number: await nextNumber(SEQ.WORK_ORDER, tx),
        entityId: input.entityId,
        vendorId: input.vendorId,
        prId: input.prId ?? null,
        rfqId: input.rfqId ?? null,
        comparativeId: input.comparativeId ?? null,
        negotiationMinuteId: input.negotiationMinuteId ?? null,
        title: input.title.trim(),
        scopeOfWork: input.scopeOfWork.trim(),
        departmentId: input.departmentId ?? null,
        projectId: input.projectId ?? null,
        siteId: input.siteId ?? null,
        currency: input.currency ?? "PKR",
        subtotal,
        taxAmount,
        total,
        status: "DRAFT",
        internalAuditRequired: outsideCpc,
        internalAuditStatus: outsideCpc ? "PENDING" : "NOT_REQUIRED",
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        createdById: user.id,
        items: { create: lines },
      },
    });

    await writeAudit(
      {
        entityType: "WorkOrder",
        entityId: wo.id,
        entityRef: wo.number,
        action: "WORK_ORDER_CREATED",
        newValue: {
          total,
          lines: lines.length,
          internalAuditRequired: outsideCpc,
          cpcThreshold: cpc.threshold,
          cpcTransactionType: cpc.transactionType,
        },
        actor: user,
      },
      tx,
    );
    return wo;
  });
}

/**
 * Sends the order for its Internal Audit review.
 *
 * Where the value puts it inside CPC's domain there is no IA gate, and it goes
 * straight to approval — the committee case is the review, and stacking a
 * second one would be inventing a control the SOP does not name.
 */
export async function submitWorkOrder(
  user: SessionUser,
  workOrderId: string,
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.WORK_ORDER_CREATE, P.WORK_ORDER_EDIT)) {
      throw new RuleViolationError("You do not have permission to submit work orders.");
    }
    const wo = await tx.workOrder.findUnique({
      where: { id: workOrderId },
      include: { vendor: { select: { name: true } } },
    });
    if (!wo) throw new NotFoundError("Work order");
    if (wo.status !== "DRAFT") {
      throw new RuleViolationError(
        `${wo.number} is ${wo.status.replace(/_/g, " ").toLowerCase()}, not a draft.`,
      );
    }

    const next = wo.internalAuditRequired ? "PENDING_INTERNAL_AUDIT" : "PENDING_APPROVAL";
    const updated = await tx.workOrder.update({
      where: { id: wo.id },
      data: { status: next },
    });

    if (wo.internalAuditRequired) {
      await createTask(
        {
          title: `Internal Audit review — ${wo.number}`,
          description: `${wo.vendor.name} · ${wo.currency} ${wo.total.toLocaleString()} · ${wo.title}`,
          taskType: "VERIFICATION",
          assignedRoleCode: "AUDIT_USER",
          entityId: wo.entityId,
          documentType: "WORK_ORDER",
          documentId: wo.id,
          documentRef: wo.number,
          priority: "HIGH",
          linkUrl: `/work-orders/${wo.id}`,
        },
        tx,
      );
      await notify(
        {
          roleCodes: ["AUDIT_USER"],
          entityId: wo.entityId,
          type: "GENERAL",
          priority: "HIGH",
          title: `${wo.number} awaits Internal Audit review`,
          body:
            "The CPC Terms of Reference require Internal Audit to review and approve a work order " +
            "outside the committee's domain before the order is finalised.",
          linkType: "WORK_ORDER",
          linkId: wo.id,
          linkUrl: `/work-orders/${wo.id}`,
        },
        tx,
      );
    }

    await writeAudit(
      {
        entityType: "WorkOrder",
        entityId: wo.id,
        entityRef: wo.number,
        action: "WORK_ORDER_SUBMITTED",
        changes: { status: { from: "DRAFT", to: next } },
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/**
 * The Internal Audit review the CPC Terms of Reference require.
 *
 * Refuses a reviewer who raised the order. A department clearing its own work
 * order is not a review, and the SOP names Internal Audit precisely because the
 * raising department should not be the one signing it off.
 */
export async function internalAuditReview(
  user: SessionUser,
  input: { workOrderId: string; decision: "APPROVED" | "REJECTED"; notes?: string | null },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.WORK_ORDER_AUDIT_REVIEW)) {
      throw new RuleViolationError(
        "The CPC Terms of Reference put this review with the Internal Audit Department.",
      );
    }
    if (input.decision === "REJECTED" && !input.notes?.trim()) {
      throw new ValidationError("Record why Internal Audit is not clearing this order.");
    }

    const wo = await tx.workOrder.findUnique({
      where: { id: input.workOrderId },
      include: { vendor: { select: { name: true } } },
    });
    if (!wo) throw new NotFoundError("Work order");
    if (wo.status !== "PENDING_INTERNAL_AUDIT") {
      throw new RuleViolationError(
        wo.internalAuditRequired
          ? `${wo.number} is ${wo.status.replace(/_/g, " ").toLowerCase()} and is not awaiting Internal Audit.`
          : `${wo.number} falls within the committee's domain, where the CPC case is the review. There is no separate Internal Audit gate on it.`,
      );
    }
    if (wo.createdById === user.id) {
      throw new RuleViolationError(
        "You raised this work order, so you cannot be the Internal Audit review of it. " +
          "The SOP names Internal Audit precisely so the raising department is not the one clearing it.",
      );
    }

    const updated = await tx.workOrder.update({
      where: { id: wo.id },
      data: {
        internalAuditStatus: input.decision,
        internalAuditById: user.id,
        internalAuditAt: new Date(),
        internalAuditNotes: input.notes?.trim() || null,
        status: input.decision === "APPROVED" ? "PENDING_APPROVAL" : "DRAFT",
      },
    });

    await attest(
      user,
      {
        documentType: "WORK_ORDER",
        documentId: wo.id,
        documentRef: wo.number,
        attestationType: input.decision === "APPROVED" ? "REVIEWED" : "REJECTED",
        decision: input.decision,
        comment:
          `Internal Audit review — ${input.decision.toLowerCase()}` +
          (input.notes?.trim() ? `: ${input.notes.trim()}` : ""),
        signedContent: { total: wo.total, scope: wo.scopeOfWork, vendor: wo.vendor.name },
      },
      tx,
    );

    await writeAudit(
      {
        entityType: "WorkOrder",
        entityId: wo.id,
        entityRef: wo.number,
        action: `WORK_ORDER_IA_${input.decision}`,
        newValue: { decision: input.decision, by: user.name },
        reason: input.notes?.trim() ?? null,
        actor: user,
      },
      tx,
    );
    await completeTasks("WORK_ORDER", wo.id, user.id, tx);
    return updated;
  });
}

/** Approves the order once every gate that applies to it has cleared. */
export async function approveWorkOrder(
  user: SessionUser,
  input: { workOrderId: string; notes?: string | null },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.WORK_ORDER_APPROVE)) {
      throw new RuleViolationError("You do not have permission to approve work orders.");
    }
    const wo = await tx.workOrder.findUnique({ where: { id: input.workOrderId } });
    if (!wo) throw new NotFoundError("Work order");
    if (wo.status !== "PENDING_APPROVAL") {
      throw new RuleViolationError(
        `${wo.number} is ${wo.status.replace(/_/g, " ").toLowerCase()} and is not awaiting approval.`,
      );
    }
    // Belt and braces: the state machine already routes through the review, but
    // the gate is re-checked here because this is the last point before the
    // order becomes a commitment.
    if (wo.internalAuditRequired && wo.internalAuditStatus !== "APPROVED") {
      throw new RuleViolationError(
        `${wo.number} has not been cleared by Internal Audit. The CPC Terms of Reference require that review before the order is finalised.`,
      );
    }

    const updated = await tx.workOrder.update({
      where: { id: wo.id },
      data: { status: "APPROVED" },
    });
    await writeAudit(
      {
        entityType: "WorkOrder",
        entityId: wo.id,
        entityRef: wo.number,
        action: "WORK_ORDER_APPROVED",
        newValue: { total: wo.total },
        reason: input.notes?.trim() ?? null,
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/** Issues the order to the vendor — §4.6 puts this with Admin. */
export async function issueWorkOrder(
  user: SessionUser,
  workOrderId: string,
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.WORK_ORDER_ISSUE)) {
      throw new RuleViolationError("ZAM/PUR/SOP-01 §4.6 puts the issuing of a work order with Admin.");
    }
    const wo = await tx.workOrder.findUnique({
      where: { id: workOrderId },
      include: { vendor: { select: { name: true } } },
    });
    if (!wo) throw new NotFoundError("Work order");
    if (wo.status !== "APPROVED") {
      throw new RuleViolationError(
        `${wo.number} must be approved before it is issued (currently ${wo.status.replace(/_/g, " ").toLowerCase()}).`,
      );
    }
    if (wo.internalAuditRequired && wo.internalAuditStatus !== "APPROVED") {
      throw new RuleViolationError(
        `${wo.number} has not been cleared by Internal Audit and cannot be issued.`,
      );
    }

    const updated = await tx.workOrder.update({
      where: { id: wo.id },
      data: { status: "ISSUED", issuedById: user.id, issuedAt: new Date() },
    });
    await writeAudit(
      {
        entityType: "WorkOrder",
        entityId: wo.id,
        entityRef: wo.number,
        action: "WORK_ORDER_ISSUED",
        newValue: { vendor: wo.vendor.name, total: wo.total },
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/** Marks the work done, or closes the order out. */
export async function closeWorkOrder(
  user: SessionUser,
  input: {
    workOrderId: string;
    to: "IN_PROGRESS" | "COMPLETED" | "CLOSED" | "CANCELLED";
    reason?: string | null;
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.WORK_ORDER_CLOSE)) {
      throw new RuleViolationError("You do not have permission to close work orders.");
    }
    const wo = await tx.workOrder.findUnique({ where: { id: input.workOrderId } });
    if (!wo) throw new NotFoundError("Work order");

    const allowed: Record<string, string[]> = {
      ISSUED: ["IN_PROGRESS", "COMPLETED", "CANCELLED"],
      IN_PROGRESS: ["COMPLETED", "CANCELLED"],
      COMPLETED: ["CLOSED"],
      DRAFT: ["CANCELLED"],
      PENDING_INTERNAL_AUDIT: ["CANCELLED"],
      PENDING_APPROVAL: ["CANCELLED"],
      APPROVED: ["CANCELLED"],
    };
    if (!allowed[wo.status]?.includes(input.to)) {
      throw new RuleViolationError(
        `${wo.number} cannot go from ${wo.status.replace(/_/g, " ").toLowerCase()} to ${input.to.replace(/_/g, " ").toLowerCase()}.`,
      );
    }
    if (input.to === "CANCELLED" && !input.reason?.trim()) {
      throw new ValidationError("State why the work order is being cancelled.");
    }

    const updated = await tx.workOrder.update({
      where: { id: wo.id },
      data: {
        status: input.to,
        ...(input.to === "COMPLETED" ? { completedAt: new Date() } : {}),
        ...(input.to === "CLOSED" ? { closedAt: new Date() } : {}),
        ...(input.to === "CANCELLED"
          ? { cancelledAt: new Date(), closureReason: input.reason?.trim() ?? null }
          : {}),
      },
    });
    await writeAudit(
      {
        entityType: "WorkOrder",
        entityId: wo.id,
        entityRef: wo.number,
        action: `WORK_ORDER_${input.to}`,
        changes: { status: { from: wo.status, to: input.to } },
        reason: input.reason?.trim() ?? null,
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

export async function listWorkOrders(
  filter: { entityIds?: string[] | null; status?: string | null } = {},
  db: DbClient = prisma,
) {
  return db.workOrder.findMany({
    where: {
      ...(filter.entityIds ? { entityId: { in: filter.entityIds } } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    include: {
      vendor: { select: { id: true, name: true } },
      entity: { select: { code: true } },
      createdBy: { select: { name: true } },
      internalAuditBy: { select: { name: true } },
      _count: { select: { items: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
}

export async function workOrderDetail(id: string, db: DbClient = prisma) {
  return db.workOrder.findUnique({
    where: { id },
    include: {
      vendor: true,
      entity: { select: { code: true, name: true } },
      items: { orderBy: { lineNo: "asc" } },
      createdBy: { select: { name: true, title: true } },
      issuedBy: { select: { name: true, title: true } },
      internalAuditBy: { select: { name: true, title: true } },
      pr: { select: { id: true, number: true, title: true } },
      rfq: { select: { id: true, number: true } },
      comparative: { select: { id: true, number: true } },
    },
  });
}
