import { prisma, type DbClient } from "@/lib/db";
import { humanize } from "@/lib/domain";
import type { TimelineEvent } from "@/components/ui/workflow";

/**
 * Case timeline. Every entry is generated from a real system event — audit rows
 * plus the transaction records themselves — never hand-authored.
 */

const TONE_BY_ACTION: Array<[RegExp, TimelineEvent["tone"]]> = [
  [/REJECTED|FAILED|CANCELLED|BLACKLIST/, "danger"],
  [/RETURNED|HOLD|MISMATCH|WAIVED|OVERRID|DISCREPANCY|SHORT/, "warning"],
  [/APPROVED|POSTED|PASSED|PAID|COMPLETED|CLOSED|ISSUED|RECEIVED/, "success"],
  [/CREATED|SUBMITTED|REGISTERED|RECORDED|SCHEDULED|RAISED/, "info"],
  [/CPC|NEGOTIATION|RECOMMENDED/, "accent"],
];

function toneFor(action: string): TimelineEvent["tone"] {
  for (const [re, tone] of TONE_BY_ACTION) if (re.test(action)) return tone;
  return "neutral";
}

const ACTION_LABELS: Record<string, string> = {
  PR_CREATED: "Requisition created",
  PR_UPDATED: "Requisition edited",
  PR_STATUS_SUBMITTED: "Requisition submitted",
  PR_STATUS_UNDER_DEPARTMENT_APPROVAL: "Sent for department approval",
  PR_STATUS_APPROVED: "Requisition approved",
  PR_STATUS_PROCUREMENT_REVIEW: "Under procurement review",
  PR_STATUS_SOURCING: "Sourcing started",
  PR_STATUS_CPC_REVIEW: "Referred to CPC",
  PR_STATUS_PO_PREPARATION: "Purchase order preparation",
  PR_STATUS_PO_APPROVED: "Purchase order approved",
  PR_STATUS_PO_ISSUED: "Purchase order issued",
  PR_STATUS_PARTIALLY_RECEIVED: "Partially received",
  PR_STATUS_FULLY_RECEIVED: "Fully received",
  PR_STATUS_GRN_COMPLETED: "GRN completed",
  PR_STATUS_INVOICE_VERIFICATION: "Invoice verification",
  PR_STATUS_FINANCE_HANDOFF: "Handed to finance",
  PR_STATUS_CLOSED: "Case closed",
  PR_STATUS_REJECTED: "Requisition rejected",
  PR_STATUS_RETURNED: "Requisition returned",
  PR_STATUS_CANCELLED: "Requisition cancelled",
  PR_STATUS_ON_HOLD: "Placed on hold",
  APPROVAL_STARTED: "Approval chain started",
  APPROVAL_APPROVED: "Approval step approved",
  APPROVAL_REJECTED: "Approval step rejected",
  APPROVAL_RETURNED: "Returned by approver",
  APPROVAL_CLARIFICATION_REQUESTED: "Clarification requested",
  RFQ_CREATED: "RFQ created",
  RFQ_ISSUED: "RFQ issued to vendors",
  RFQ_VENDOR_ADDED: "Vendor invited",
  RFQ_VENDOR_DECLINED: "Vendor declined",
  RFQ_CLOSED: "RFQ closed",
  QUOTE_RECEIVED: "Vendor quotation received",
  QUOTE_UPDATED: "Quotation revised",
  NEGOTIATION_RECORDED: "Negotiation round recorded",
  COMPARATIVE_CREATED: "Comparative analysis prepared",
  COMPARATIVE_RECOMMENDED: "Vendor recommended",
  CPC_CASE_CREATED: "CPC case raised",
  CPC_APPROVED: "CPC approved",
  CPC_REJECTED: "CPC rejected",
  CPC_RETURNED: "CPC returned the case",
  PO_CREATED: "Purchase order drafted",
  PO_UPDATED: "Purchase order edited",
  PO_STATUS_PENDING_APPROVAL: "Purchase order sent for approval",
  PO_STATUS_APPROVED: "Purchase order approved",
  PO_STATUS_ISSUED: "Purchase order issued",
  PO_STATUS_PARTIALLY_RECEIVED: "Purchase order partially received",
  PO_STATUS_FULLY_RECEIVED: "Purchase order fully received",
  PO_STATUS_CLOSED: "Purchase order closed",
  PO_STATUS_CANCELLED: "Purchase order cancelled",
  GATE_PASS_RECORDED: "Inward gate pass recorded",
  DELIVERY_VERIFIED: "Physical verification completed",
  INSPECTION_SCHEDULED: "Technical inspection raised",
  INSPECTION_APPROVED: "Technical inspection approved",
  INSPECTION_REJECTED: "Technical inspection rejected",
  INSPECTION_CONDITIONAL: "Technical inspection conditionally approved",
  GRN_CREATED: "GRN drafted",
  GRN_POSTED: "GRN posted to inventory",
  GRN_CANCELLED: "GRN cancelled",
  ASSETS_TAGGED: "Assets tagged",
  STACKING_RECORDED: "Goods stacking recorded",
  INVOICE_REGISTERED: "Vendor invoice registered",
  INVOICE_MATCH_PASSED: "Three-way match passed",
  INVOICE_MATCH_FAILED: "Three-way match failed",
  INVOICE_MISMATCH_WAIVED: "Invoice mismatch waived",
  INVOICE_APPROVED: "Invoice approved for payment",
  FINANCE_HANDOFF_CREATED: "Handed off to finance",
  FINANCE_HANDOFF_ACKNOWLEDGED: "Finance acknowledged handoff",
  PAYMENT_RECORDED: "Payment recorded",
  EXCEPTION_RAISED: "Exception raised",
  TRADER_CASE_RECORDED: "Trader / MOQ case recorded",
};

export type CaseTimelineEvent = TimelineEvent & { entityType: string; action: string };

/**
 * Assembles the chronological timeline for a procurement case, keyed by the PR
 * number that every downstream document carries.
 */
export async function caseTimeline(caseKey: string, db: DbClient = prisma): Promise<CaseTimelineEvent[]> {
  const rows = await db.auditLog.findMany({
    where: { caseKey },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((r) => {
    let detail: string | null = null;
    if (r.changes) {
      try {
        const c = JSON.parse(r.changes) as Record<string, { from: unknown; to: unknown }>;
        const parts = Object.entries(c)
          .filter(([k]) => k !== "status")
          .slice(0, 4)
          .map(([k, v]) => `${k}: ${String(v.from ?? "—")} → ${String(v.to ?? "—")}`);
        if (parts.length) detail = parts.join(" · ");
      } catch {
        /* ignore malformed diff */
      }
    }
    if (!detail && r.newValue) {
      try {
        const v = JSON.parse(r.newValue) as Record<string, unknown>;
        const parts = Object.entries(v)
          .filter(([, val]) => val !== null && val !== undefined && typeof val !== "object")
          .slice(0, 4)
          .map(([k, val]) => `${k}: ${String(val)}`);
        if (parts.length) detail = parts.join(" · ");
      } catch {
        /* ignore */
      }
    }
    const reason = r.reason ? `“${r.reason}”` : null;

    return {
      id: r.id,
      at: r.createdAt,
      title: ACTION_LABELS[r.action] ?? humanize(r.action),
      detail: [reason, detail].filter(Boolean).join(" — ") || undefined,
      actor: r.actorName,
      actorRoles: r.actorRoles,
      tone: toneFor(r.action),
      ref: r.entityRef,
      entityType: r.entityType,
      action: r.action,
    };
  });
}

/** Timeline for a single document (not the whole case). */
export async function documentTimeline(
  entityType: string,
  entityId: string,
  db: DbClient = prisma,
): Promise<CaseTimelineEvent[]> {
  const rows = await db.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt,
    title: ACTION_LABELS[r.action] ?? humanize(r.action),
    detail: r.reason ?? undefined,
    actor: r.actorName,
    actorRoles: r.actorRoles,
    tone: toneFor(r.action),
    ref: r.entityRef,
    entityType: r.entityType,
    action: r.action,
  }));
}

/**
 * Everything attached to one procurement case, for the unified case view.
 */
export async function loadProcurementCase(prId: string, db: DbClient = prisma) {
  const pr = await db.purchaseRequisition.findUnique({
    where: { id: prId },
    include: {
      entity: true,
      department: true,
      requester: { select: { id: true, name: true, email: true, title: true } },
      project: true,
      site: true,
      deliveryStore: true,
      items: { include: { category: true, item: true }, orderBy: { lineNo: "asc" } },
      rfqs: {
        orderBy: { createdAt: "desc" },
        include: {
          vendors: { include: { vendor: { select: { id: true, name: true, status: true, city: true } } } },
          quotes: {
            include: {
              vendor: { select: { id: true, name: true, status: true, performanceScore: true, onTimePercent: true } },
              items: { orderBy: { lineNo: "asc" } },
              negotiations: { orderBy: { round: "asc" }, include: { negotiatedBy: { select: { name: true } } } },
            },
          },
          createdBy: { select: { name: true } },
        },
      },
      comparatives: {
        orderBy: { preparedAt: "desc" },
        include: {
          lines: { include: { vendor: true, quote: { include: { negotiations: true } } }, orderBy: { netTotal: "asc" } },
        },
      },
      cpcCases: {
        orderBy: { createdAt: "desc" },
        include: {
          members: { include: { user: { select: { id: true, name: true, title: true } } } },
          decisions: { include: { member: { select: { name: true } } }, orderBy: { decidedAt: "asc" } },
          meeting: true,
        },
      },
      purchaseOrders: {
        orderBy: { createdAt: "desc" },
        include: {
          vendor: true,
          items: { orderBy: { lineNo: "asc" } },
          deliveryStore: true,
          createdBy: { select: { name: true } },
          gatePasses: { include: { store: { select: { name: true } }, recordedBy: { select: { name: true } } } },
          deliveries: {
            include: {
              items: { orderBy: { lineNo: "asc" } },
              store: { select: { name: true } },
              receivedBy: { select: { name: true } },
              inspections: { include: { items: true, inspector: { select: { name: true } } } },
            },
          },
          grns: {
            include: {
              items: { orderBy: { lineNo: "asc" } },
              store: { select: { name: true } },
              receivedBy: { select: { name: true } },
              inspection: { select: { number: true, result: true } },
            },
          },
          invoices: {
            include: {
              items: { orderBy: { lineNo: "asc" } },
              vendor: { select: { name: true } },
              handoffs: { include: { handedOffBy: { select: { name: true } } } },
              verifiedBy: { select: { name: true } },
            },
          },
          inspections: true,
        },
      },
      exceptions: { orderBy: { createdAt: "desc" }, include: { owner: { select: { name: true } } } },
    },
  });
  return pr;
}

export type ProcurementCase = NonNullable<Awaited<ReturnType<typeof loadProcurementCase>>>;
