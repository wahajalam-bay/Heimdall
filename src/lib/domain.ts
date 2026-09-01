/**
 * Domain vocabulary for Heimdall.
 * SQLite has no native enums, so statuses live here as const unions and every
 * write path validates against these lists.
 */

import { PERMISSIONS } from "./permissions";

export const ENTITY_CODES = { ZM: "ZM", ZD: "ZD" } as const;

// ── Procurement types ────────────────────────────────────────
export const PROCUREMENT_TYPES = [
  "MONTHLY_RECURRING",
  "ON_DEMAND",
  "MATERIAL_DEMAND",
  "SERVICE",
] as const;
export type ProcurementType = (typeof PROCUREMENT_TYPES)[number];

export const PROCUREMENT_TYPE_LABELS: Record<ProcurementType, string> = {
  MONTHLY_RECURRING: "Monthly / Recurring",
  ON_DEMAND: "Purchase on Demand",
  MATERIAL_DEMAND: "Material Demand (MD)",
  SERVICE: "Service",
};

// ── PR lifecycle ─────────────────────────────────────────────
export const PR_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_DEPARTMENT_APPROVAL",
  "APPROVED",
  "PROCUREMENT_REVIEW",
  "SOURCING",
  "CPC_REVIEW",
  "PO_PREPARATION",
  "PO_APPROVED",
  "PO_ISSUED",
  "PARTIALLY_RECEIVED",
  "FULLY_RECEIVED",
  "GRN_COMPLETED",
  "INVOICE_VERIFICATION",
  "FINANCE_HANDOFF",
  "CLOSED",
  "REJECTED",
  "RETURNED",
  "CANCELLED",
  "ON_HOLD",
] as const;
export type PrStatus = (typeof PR_STATUSES)[number];

/**
 * Two lifecycles on one record.
 *
 * The requisition lifecycle runs from raising the demand to the order being
 * approved; the purchase order lifecycle takes over from the order being issued
 * and runs to closure. They live on one case because that is what makes the
 * whole thing traceable, but they are two pieces of work owned by two teams, so
 * the boundary is named here and every rail and gate reads it from one place.
 *
 * `PR_MODULE_BOUNDARY` is the last status of the requisition lifecycle.
 * `PO_MODULE_GATE` is a different thing: the earliest status at which the
 * sourcing team may act at all. Sourcing has to be able to start long before an
 * order exists, so the gate sits at approval while the lifecycle runs on to the
 * approved order.
 */
export const PR_MODULE_BOUNDARY: PrStatus = "PO_APPROVED";
export const PO_MODULE_GATE: PrStatus = "APPROVED";

/** The requisition lifecycle: raising the demand through to an approved order. */
export const REQUISITION_STAGE: PrStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_DEPARTMENT_APPROVAL",
  "RETURNED",
  "APPROVED",
  "PROCUREMENT_REVIEW",
  "SOURCING",
  "CPC_REVIEW",
  "PO_PREPARATION",
  "PO_APPROVED",
];

/** The purchase order lifecycle: the issued order through to financial closure. */
export const PO_MODULE_STAGE: PrStatus[] = [
  "PO_ISSUED",
  "PARTIALLY_RECEIVED",
  "FULLY_RECEIVED",
  "GRN_COMPLETED",
  "INVOICE_VERIFICATION",
  "FINANCE_HANDOFF",
];

/**
 * True once the requisition is approved and the sourcing team may act.
 *
 * This is the gate, not the lifecycle boundary — an RFQ has to be possible
 * before an order exists, or no order could ever be raised.
 */
export function requisitionComplete(status: string): boolean {
  const i = PR_STATUSES.indexOf(status as PrStatus);
  const gate = PR_STATUSES.indexOf(PO_MODULE_GATE);
  if (status === "CLOSED") return true;
  if (["DRAFT", "SUBMITTED", "UNDER_DEPARTMENT_APPROVAL", "RETURNED", "REJECTED", "CANCELLED"].includes(status)) {
    return false;
  }
  return i >= gate;
}

/** True while the requisition is still being raised or approved. */
export function inRequisitionStage(status: string): boolean {
  return ["DRAFT", "SUBMITTED", "UNDER_DEPARTMENT_APPROVAL", "RETURNED"].includes(status);
}

/** Which lifecycle owns this case now. */
export function caseModule(status: string): "REQUISITION" | "PURCHASE_ORDER" | "CLOSED" {
  if (["CLOSED", "REJECTED", "CANCELLED"].includes(status)) return "CLOSED";
  return PO_MODULE_STAGE.includes(status as PrStatus) ? "PURCHASE_ORDER" : "REQUISITION";
}

/**
 * The requisition rail: what the requisition screen shows.
 *
 * It ends at the approved order, because that is where the requisition
 * lifecycle ends. What happens to the order afterwards is the order's own
 * lifecycle and belongs on the order's own screen — showing both here made the
 * requisition screen answer a question nobody had asked it.
 */
export const REQUISITION_RAIL: PrStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_DEPARTMENT_APPROVAL",
  "APPROVED",
  "PROCUREMENT_REVIEW",
  "SOURCING",
  "CPC_REVIEW",
  "PO_PREPARATION",
  "PO_APPROVED",
];

/** Ordered happy-path lifecycle used by the workflow visualiser. */
export const PR_LIFECYCLE: PrStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_DEPARTMENT_APPROVAL",
  "APPROVED",
  "PROCUREMENT_REVIEW",
  "SOURCING",
  "CPC_REVIEW",
  "PO_PREPARATION",
  "PO_APPROVED",
  "PO_ISSUED",
  "PARTIALLY_RECEIVED",
  "FULLY_RECEIVED",
  "GRN_COMPLETED",
  "INVOICE_VERIFICATION",
  "FINANCE_HANDOFF",
  "CLOSED",
];

export const PR_TERMINAL_STATUSES: PrStatus[] = ["CLOSED", "REJECTED", "CANCELLED"];

/** Allowed PR transitions. Anything not listed is rejected server-side. */
/**
 * Which permission entitles an actor to move a requisition *into* a state.
 *
 * The state machine above says which moves are legal; this says who may make
 * them. They are separate questions and were previously only half-answered —
 * `transitionPr` validated the move and never the mover, so any signed-in user
 * who reached it could advance a requisition to any adjacent state.
 *
 * Keyed on the target state because that is what the move means: entering
 * APPROVED *is* approving, entering PO_ISSUED *is* issuing. Several of these
 * states are normally reached as a consequence of an operation in another
 * module — posting a GRN, verifying an invoice — and those callers declare a
 * cascade whose originating permission is re-verified instead (see
 * `lib/actor.ts`). The entry here is the authority required to make the move
 * *directly*, which is the case this map has to get right.
 */
export const PR_TRANSITION_AUTHORITY: Record<PrStatus, readonly string[]> = {
  DRAFT: [PERMISSIONS.PR_EDIT, PERMISSIONS.PR_CREATE],
  SUBMITTED: [PERMISSIONS.PR_SUBMIT, PERMISSIONS.PR_CREATE],
  UNDER_DEPARTMENT_APPROVAL: [PERMISSIONS.PR_APPROVE, PERMISSIONS.PR_SUBMIT],
  APPROVED: [PERMISSIONS.PR_APPROVE],
  PROCUREMENT_REVIEW: [PERMISSIONS.PR_APPROVE, PERMISSIONS.RFQ_ISSUE],
  SOURCING: [PERMISSIONS.RFQ_ISSUE],
  CPC_REVIEW: [PERMISSIONS.CPC_CASE_RAISE, PERMISSIONS.CPC_MANAGE],
  PO_PREPARATION: [PERMISSIONS.PO_CREATE, PERMISSIONS.CPC_DECIDE],
  PO_APPROVED: [PERMISSIONS.PO_APPROVE],
  PO_ISSUED: [PERMISSIONS.PO_ISSUE],
  PARTIALLY_RECEIVED: [PERMISSIONS.GRN_POST],
  FULLY_RECEIVED: [PERMISSIONS.GRN_POST],
  GRN_COMPLETED: [PERMISSIONS.GRN_POST],
  INVOICE_VERIFICATION: [PERMISSIONS.INVOICE_VERIFY],
  FINANCE_HANDOFF: [PERMISSIONS.FINANCE_HANDOFF],
  CLOSED: [PERMISSIONS.PO_CLOSE, PERMISSIONS.PR_CANCEL],
  REJECTED: [PERMISSIONS.PR_REJECT, PERMISSIONS.PR_APPROVE, PERMISSIONS.CPC_DECIDE],
  RETURNED: [PERMISSIONS.PR_RETURN, PERMISSIONS.PR_APPROVE],
  CANCELLED: [PERMISSIONS.PR_CANCEL],
  ON_HOLD: [PERMISSIONS.PR_HOLD],
};

export const PR_TRANSITIONS: Record<PrStatus, PrStatus[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["UNDER_DEPARTMENT_APPROVAL", "RETURNED", "REJECTED", "CANCELLED", "ON_HOLD"],
  UNDER_DEPARTMENT_APPROVAL: ["APPROVED", "RETURNED", "REJECTED", "CANCELLED", "ON_HOLD"],
  APPROVED: ["PROCUREMENT_REVIEW", "RETURNED", "CANCELLED", "ON_HOLD"],
  PROCUREMENT_REVIEW: ["SOURCING", "RETURNED", "REJECTED", "CANCELLED", "ON_HOLD"],
  SOURCING: ["CPC_REVIEW", "PO_PREPARATION", "RETURNED", "CANCELLED", "ON_HOLD"],
  CPC_REVIEW: ["PO_PREPARATION", "SOURCING", "RETURNED", "REJECTED", "CANCELLED", "ON_HOLD"],
  PO_PREPARATION: ["PO_APPROVED", "SOURCING", "RETURNED", "CANCELLED", "ON_HOLD"],
  PO_APPROVED: ["PO_ISSUED", "CANCELLED", "ON_HOLD"],
  PO_ISSUED: ["PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CANCELLED", "ON_HOLD"],
  PARTIALLY_RECEIVED: ["FULLY_RECEIVED", "GRN_COMPLETED", "ON_HOLD", "CLOSED"],
  FULLY_RECEIVED: ["GRN_COMPLETED", "ON_HOLD"],
  GRN_COMPLETED: ["INVOICE_VERIFICATION", "ON_HOLD"],
  INVOICE_VERIFICATION: ["FINANCE_HANDOFF", "ON_HOLD"],
  FINANCE_HANDOFF: ["CLOSED", "ON_HOLD"],
  CLOSED: [],
  REJECTED: [],
  RETURNED: ["DRAFT", "SUBMITTED", "CANCELLED"],
  CANCELLED: [],
  ON_HOLD: [
    "SUBMITTED",
    "UNDER_DEPARTMENT_APPROVAL",
    "APPROVED",
    "PROCUREMENT_REVIEW",
    "SOURCING",
    "CPC_REVIEW",
    "PO_PREPARATION",
    "PO_APPROVED",
    "PO_ISSUED",
    "PARTIALLY_RECEIVED",
    "FULLY_RECEIVED",
    "GRN_COMPLETED",
    "INVOICE_VERIFICATION",
    "FINANCE_HANDOFF",
    "CANCELLED",
  ],
};

// ── PO lifecycle ─────────────────────────────────────────────
export const PO_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "ISSUED",
  "PARTIALLY_RECEIVED",
  "FULLY_RECEIVED",
  "CLOSED",
  "CANCELLED",
  "ON_HOLD",
] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

/**
 * Which permission entitles an actor to move a purchase order *into* a state.
 *
 * The requisition equivalent is `PR_TRANSITION_AUTHORITY`, and the reasoning is
 * the same: the transition table says which moves are legal, this says who may
 * make them, and they are different questions. `transitionPo` is private to the
 * purchase order module and every exported function there authorizes before
 * calling it — but "the callers all check" is a property that holds until
 * somebody adds a caller, so the check belongs on the move itself.
 *
 * Keyed on the target state, because entering APPROVED *is* approving and
 * entering ISSUED *is* issuing. States normally reached as a consequence of work
 * in another module — a receipt posted, an order closed out — are reached with a
 * declared cascade whose originating permission is re-verified instead.
 */
export const PO_TRANSITION_AUTHORITY: Record<PoStatus, readonly string[]> = {
  DRAFT: [PERMISSIONS.PO_CREATE, PERMISSIONS.PO_EDIT],
  PENDING_APPROVAL: [PERMISSIONS.PO_CREATE, PERMISSIONS.PO_EDIT],
  APPROVED: [PERMISSIONS.PO_APPROVE],
  ISSUED: [PERMISSIONS.PO_ISSUE],
  PARTIALLY_RECEIVED: [PERMISSIONS.GRN_POST, PERMISSIONS.GRN_CANCEL],
  FULLY_RECEIVED: [PERMISSIONS.GRN_POST, PERMISSIONS.GRN_CANCEL],
  CLOSED: [PERMISSIONS.PO_CLOSE],
  CANCELLED: [PERMISSIONS.PO_CANCEL, PERMISSIONS.PO_CLOSE, PERMISSIONS.PO_APPROVE],
  ON_HOLD: [PERMISSIONS.PO_EDIT, PERMISSIONS.PO_APPROVE],
};

export const PO_LIFECYCLE: PoStatus[] = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "ISSUED",
  "PARTIALLY_RECEIVED",
  "FULLY_RECEIVED",
  "CLOSED",
];

/**
 * The order's own lifecycle, as the requirement lists it.
 *
 * It starts where the requisition lifecycle ends — at the approved order — so
 * draft, pending approval and approved are not repeated here; they belong to the
 * requisition and are shown there.
 *
 * Awaiting delivery, inspection pending and GRN pending are not statuses on the
 * order row and deliberately are not made into any: they are facts about the
 * deliveries, inspections and receipts underneath it. Turning each into a status
 * would mean a status machine that has to be kept in step with those documents,
 * and it would be wrong the first time somebody posted a receipt out of order.
 * They are derived instead, from the documents themselves.
 */
export const PO_RAIL = [
  "ISSUED",
  "AWAITING_DELIVERY",
  "PARTIALLY_RECEIVED",
  "INSPECTION_PENDING",
  "GRN_PENDING",
  "FULLY_RECEIVED",
  "CLOSED",
] as const;

export type PoRailStage = (typeof PO_RAIL)[number];

export type PoRailFacts = {
  status: string;
  issuedAt?: Date | null;
  closedAt?: Date | null;
  /** Deliveries physically recorded against the order. */
  deliveries: number;
  firstDeliveryAt?: Date | null;
  /** Inspections still awaiting a verdict. */
  inspectionsPending: number;
  /** Deliveries with no posted receipt behind them. */
  grnsPending: number;
  postedGrns: number;
  firstGrnAt?: Date | null;
  /** True once every ordered line has been received in full. */
  fullyReceived: boolean;
};

/**
 * Which stage of the order lifecycle the facts put it at.
 *
 * Read in the order the goods actually move, and it stops at the first stage
 * that is still outstanding — because that is the stage somebody has to act on.
 */
export function poRailStage(f: PoRailFacts): PoRailStage {
  if (f.status === "CLOSED") return "CLOSED";
  if (f.fullyReceived || f.status === "FULLY_RECEIVED") return "FULLY_RECEIVED";
  if (f.inspectionsPending > 0) return "INSPECTION_PENDING";
  if (f.grnsPending > 0) return "GRN_PENDING";
  if (f.postedGrns > 0) return "PARTIALLY_RECEIVED";
  if (f.deliveries > 0) return "PARTIALLY_RECEIVED";
  return "AWAITING_DELIVERY";
}

/** Human labels for the derived stages the status vocabulary has no word for. */
export const PO_RAIL_LABELS: Record<PoRailStage, string> = {
  ISSUED: "Issued",
  AWAITING_DELIVERY: "Awaiting delivery",
  PARTIALLY_RECEIVED: "Partially received",
  INSPECTION_PENDING: "Inspection pending",
  GRN_PENDING: "GRN pending",
  FULLY_RECEIVED: "Fully received",
  CLOSED: "Closed",
};

/** POs that count as "open" for the Open PO control tower. */
export const PO_OPEN_STATUSES: PoStatus[] = ["ISSUED", "PARTIALLY_RECEIVED", "APPROVED"];

// ── Other status vocabularies ────────────────────────────────
export const RFQ_STATUSES = ["DRAFT", "ISSUED", "RESPONSES_IN", "CLOSED", "AWARDED", "CANCELLED"] as const;
export const QUOTE_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "SHORTLISTED",
  "SELECTED",
  "REJECTED",
  "EXPIRED",
] as const;
export const COMPARATIVE_STATUSES = [
  "DRAFT",
  "UNDER_REVIEW",
  "RECOMMENDED",
  "APPROVED",
  "REJECTED",
  "SUPERSEDED",
] as const;
export const CPC_CASE_STATUSES = [
  "PENDING",
  "SCHEDULED",
  "UNDER_REVIEW",
  /**
   * The committee has approved it and the Office of the CEO has not.
   *
   * PC-023 puts a second approval above PKR 1.5m, and this is where a case waits
   * for it. Distinct from APPROVED because an approved case releases the
   * requisition to purchase order preparation and one still waiting must not.
   */
  "PENDING_CEO",
  "APPROVED",
  "REJECTED",
  "RETURNED",
  "CLARIFICATION",
  "DEFERRED",
] as const;
export const DELIVERY_STATUSES = [
  "PENDING_VERIFICATION",
  "ACCEPTED",
  "PARTIALLY_ACCEPTED",
  "REJECTED",
  "ACCEPTED_WITH_DISCREPANCY",
] as const;
export const INSPECTION_RESULTS = [
  "PENDING",
  "IN_PROGRESS",
  "APPROVED",
  "REJECTED",
  "CONDITIONAL",
  "RE_INSPECTION_REQUIRED",
] as const;
export const GRN_STATUSES = ["DRAFT", "POSTED", "CANCELLED"] as const;
export const INVOICE_STATUSES = [
  "RECEIVED",
  "UNDER_VERIFICATION",
  "MATCHED",
  "MISMATCH",
  "EXCEPTION_APPROVED",
  "PENDING_APPROVAL",
  "APPROVED",
  "SENT_TO_FINANCE",
  "PAID",
  "REJECTED",
  "ON_HOLD",
] as const;
export const VENDOR_STATUSES = [
  "PROSPECT",
  "UNDER_EVALUATION",
  "PENDING_APPROVAL",
  "APPROVED",
  "CONDITIONAL",
  "SUSPENDED",
  "BLACKLISTED",
  "INACTIVE",
] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

/** Vendor statuses that may be invited to RFQs / awarded POs without an override. */
export const VENDOR_SOURCEABLE_STATUSES: VendorStatus[] = ["APPROVED", "CONDITIONAL"];

export const PETTY_CASH_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_EVALUATION",
  "QUOTES_PENDING",
  "QUOTES_COMPARED",
  "PENDING_APPROVAL",
  "APPROVED",
  "PURCHASED",
  "RECEIPT_UPLOADED",
  "VOUCHER_GENERATED",
  "VOUCHER_APPROVED",
  "STORE_ENTRY_PENDING",
  "STORE_ENTRY_DONE",
  "RECONCILED",
  "CLOSED",
  "REJECTED",
  "CANCELLED",
] as const;
export type PettyCashStatus = (typeof PETTY_CASH_STATUSES)[number];

export const PETTY_CASH_LIFECYCLE: PettyCashStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_EVALUATION",
  "QUOTES_PENDING",
  "QUOTES_COMPARED",
  "PENDING_APPROVAL",
  "APPROVED",
  "PURCHASED",
  "RECEIPT_UPLOADED",
  "VOUCHER_GENERATED",
  "VOUCHER_APPROVED",
  "STORE_ENTRY_PENDING",
  "STORE_ENTRY_DONE",
  "RECONCILED",
  "CLOSED",
];

export const DISPOSAL_STAGES = [
  "FLAGGED",
  "ASSESSMENT",
  "AUDIT_REVIEW",
  "PENDING_APPROVAL",
  "APPROVED",
  "BIDDING",
  "BID_EVALUATION",
  "MANAGEMENT_APPROVAL",
  "PAYMENT_PENDING",
  "PAYMENT_RECEIVED",
  "COMPLETED",
  "REJECTED",
  "CANCELLED",
] as const;
export type DisposalStage = (typeof DISPOSAL_STAGES)[number];

export const DISPOSAL_LIFECYCLE: DisposalStage[] = [
  "FLAGGED",
  "ASSESSMENT",
  "AUDIT_REVIEW",
  "PENDING_APPROVAL",
  "APPROVED",
  "BIDDING",
  "BID_EVALUATION",
  "MANAGEMENT_APPROVAL",
  "PAYMENT_PENDING",
  "PAYMENT_RECEIVED",
  "COMPLETED",
];

export const BLACKLIST_STAGES = [
  "RAISED",
  "EVIDENCE_COLLECTION",
  "INVESTIGATION",
  "VENDOR_RESPONSE_AWAITED",
  "PROCUREMENT_REVIEW",
  "AUDIT_REVIEW",
  "DECISION_PENDING",
  "BLACKLISTED",
  "WARNING_ISSUED",
  "RETAINED",
  "CLOSED",
] as const;
export type BlacklistStage = (typeof BLACKLIST_STAGES)[number];

export const BLACKLIST_LIFECYCLE: BlacklistStage[] = [
  "RAISED",
  "EVIDENCE_COLLECTION",
  "INVESTIGATION",
  "VENDOR_RESPONSE_AWAITED",
  "PROCUREMENT_REVIEW",
  "AUDIT_REVIEW",
  "DECISION_PENDING",
  "CLOSED",
];

export const DISPOSITIONS = ["INVENTORY", "CONSUMABLE", "EXPENSE", "ASSET", "PROJECT_MATERIAL"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** Dispositions that mandate a store/inventory transaction before closure. */
export const STORE_ENTRY_DISPOSITIONS: Disposition[] = ["INVENTORY", "ASSET", "PROJECT_MATERIAL"];

export const DISCREPANCY_TYPES = [
  "OK",
  "QUANTITY_MISMATCH",
  "DAMAGED",
  "WRONG_ITEM",
  "WRONG_SPEC",
  "EXPIRED",
  "MISSING_SERIAL",
  "MISSING_WARRANTY",
  "SHORT_DELIVERY",
  "EXCESS_DELIVERY",
] as const;
export type DiscrepancyType = (typeof DISCREPANCY_TYPES)[number];

export const EXCEPTION_TYPES = [
  "MISSING_SPECIFICATION",
  "APPROVAL_DELAY",
  "INSUFFICIENT_QUOTATIONS",
  "PRICE_VARIANCE",
  "NON_LOWEST_SELECTED",
  "LATE_DELIVERY",
  "QUANTITY_MISMATCH",
  "DAMAGED_MATERIAL",
  "FAILED_INSPECTION",
  "MISSING_GRN",
  "INVOICE_MISMATCH",
  "VENDOR_COMPLIANCE",
  "STORE_ENTRY_MISSING",
  "BUDGET_OVERRUN",
  "OTHER",
] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];

export const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const STORE_KINDS = [
  "CENTRAL_WAREHOUSE",
  "SITE_STORE",
  "OFFICE_STORE",
  "PROJECT_STORE",
  "OTHER",
] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

export const ASSET_STATUSES = [
  "ACTIVE",
  "IN_STORAGE",
  "ISSUED",
  "TRANSFERRED",
  "UNDER_REPAIR",
  "IDLE",
  "OBSOLETE",
  "DISPOSED",
  "SCRAPPED",
  "LOST",
] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const COMPLIANCE_LEVELS = ["COMPLIANT", "PARTIAL", "NON_COMPLIANT", "NOT_ASSESSED"] as const;
export type ComplianceLevel = (typeof COMPLIANCE_LEVELS)[number];

export const QUOTE_CHANNELS = ["EMAIL", "PORTAL", "WHATSAPP", "PHYSICAL", "SKYPE", "WALK_IN", "PHONE"] as const;

export const CONFIDENTIALITY_LEVELS = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"] as const;
export type Confidentiality = (typeof CONFIDENTIALITY_LEVELS)[number];

// ── Presentation helpers ─────────────────────────────────────

/** Turns SCREAMING_SNAKE into Title Case for display. */
/**
 * Acronyms the status vocabulary uses. Without this, PENDING_HOD_APPROVAL reads
 * back as "Pending Hod Approval", which is how nobody writes it.
 */
const ACRONYMS = new Set(["po", "pr", "grn", "rfq", "cpc", "hod", "sr", "srn", "uom", "boq", "far", "ap", "qc"]);

export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .toLowerCase()
    .split("_")
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

export type BadgeTone = "neutral" | "info" | "progress" | "success" | "warning" | "danger" | "accent";

const TONE_MAP: Record<string, BadgeTone> = {
  // neutral / draft
  DRAFT: "neutral",
  PROSPECT: "neutral",
  INACTIVE: "neutral",
  NOT_ASSESSED: "neutral",
  FLAGGED: "neutral",
  RECORDED: "neutral",
  OK: "success",
  // in-flight
  SUBMITTED: "info",
  RECEIVED: "info",
  ISSUED: "info",
  SCHEDULED: "info",
  ASSESSMENT: "info",
  RAISED: "info",
  OPEN: "info",
  INVITED: "info",
  ACKNOWLEDGED: "info",
  // progress
  UNDER_DEPARTMENT_APPROVAL: "progress",
  PROCUREMENT_REVIEW: "progress",
  SOURCING: "progress",
  CPC_REVIEW: "progress",
  PO_PREPARATION: "progress",
  PENDING: "progress",
  PENDING_APPROVAL: "progress",
  PENDING_VERIFICATION: "progress",
  UNDER_REVIEW: "progress",
  UNDER_EVALUATION: "progress",
  UNDER_VERIFICATION: "progress",
  IN_PROGRESS: "progress",
  RESPONSES_IN: "progress",
  QUOTES_PENDING: "progress",
  QUOTES_COMPARED: "progress",
  INVESTIGATION: "progress",
  EVIDENCE_COLLECTION: "progress",
  VENDOR_RESPONSE_AWAITED: "progress",
  DECISION_PENDING: "progress",
  BIDDING: "progress",
  BID_EVALUATION: "progress",
  MANAGEMENT_APPROVAL: "progress",
  AUDIT_REVIEW: "progress",
  PAYMENT_PENDING: "progress",
  DISPATCHED: "progress",
  ROUTED_TO_STORE: "progress",
  INVOICE_VERIFICATION: "progress",
  FINANCE_HANDOFF: "progress",
  SENT_TO_FINANCE: "progress",
  STORE_ENTRY_PENDING: "warning",
  VOUCHER_GENERATED: "progress",
  VOUCHER_APPROVED: "progress",
  RECEIPT_UPLOADED: "progress",
  PURCHASED: "progress",
  SHORTLISTED: "progress",
  QUOTED: "info",
  // success
  APPROVED: "success",
  PO_APPROVED: "success",
  MATCHED: "success",
  PASSED: "success",
  PASS: "success",
  POSTED: "success",
  CLOSED: "success",
  COMPLETED: "success",
  FULLY_RECEIVED: "success",
  GRN_COMPLETED: "success",
  ACCEPTED: "success",
  RECONCILED: "success",
  STORE_ENTRY_DONE: "success",
  PAID: "success",
  PAYMENT_RECEIVED: "success",
  COMPLIANT: "success",
  SELECTED: "success",
  WON: "success",
  RETAINED: "success",
  ACTIVE: "success",
  RESOLVED: "success",
  IN_STORAGE: "success",
  RECEIVED_STORE: "success",
  DONE: "success",
  AWARDED: "success",
  // warning
  RETURNED: "warning",
  ON_HOLD: "warning",
  CLARIFICATION: "warning",
  PARTIALLY_RECEIVED: "warning",
  PARTIALLY_ACCEPTED: "warning",
  PARTIALLY_ISSUED: "warning",
  ACCEPTED_WITH_DISCREPANCY: "warning",
  CONDITIONAL: "warning",
  RE_INSPECTION_REQUIRED: "warning",
  MISMATCH: "warning",
  EXCEPTION_APPROVED: "warning",
  DEFERRED: "warning",
  SUSPENDED: "warning",
  WARNING_ISSUED: "warning",
  IDLE: "warning",
  OBSOLETE: "warning",
  UNDER_REPAIR: "warning",
  PARTIAL: "warning",
  OVERDUE: "warning",
  ESCALATED: "warning",
  WAIVED: "warning",
  NO_RESPONSE: "warning",
  EXPIRED: "warning",
  // danger
  REJECTED: "danger",
  CANCELLED: "danger",
  FAILED: "danger",
  FAIL: "danger",
  BLACKLISTED: "danger",
  NON_COMPLIANT: "danger",
  DISPOSED: "danger",
  SCRAPPED: "danger",
  LOST: "danger",
  DECLINED: "danger",
  DISQUALIFIED: "danger",
  CRITICAL: "danger",
  OVERRIDDEN: "warning",
  // accent
  PO_ISSUED: "accent",
  APPROVED_PO: "accent",
  RECOMMENDED: "accent",
  SUPERSEDED: "neutral",
};

export function toneFor(status: string | null | undefined): BadgeTone {
  if (!status) return "neutral";
  return TONE_MAP[status] ?? "neutral";
}

export const SEVERITY_TONE: Record<string, BadgeTone> = {
  LOW: "neutral",
  MEDIUM: "info",
  HIGH: "warning",
  CRITICAL: "danger",
};

export const PRIORITY_TONE: Record<string, BadgeTone> = {
  LOW: "neutral",
  NORMAL: "info",
  HIGH: "warning",
  URGENT: "danger",
};

/**
 * Kinds of manual cost-comparison source.
 *
 * Lives here rather than beside the service that writes them, because the entry
 * form is a client component and the service imports Prisma — pulling that into
 * the browser bundle to read a list of labels would be a poor trade.
 */
export const MANUAL_SOURCE_TYPES = [
  { code: "PRICE_LIST", label: "Published price list" },
  { code: "RATE_CONTRACT", label: "Rate / framework contract" },
  { code: "PRIOR_PURCHASE", label: "Price of a prior purchase" },
  { code: "EMAIL", label: "Emailed indication" },
  { code: "VERBAL", label: "Verbal or telephone quote" },
  { code: "MARKET_SURVEY", label: "Market survey" },
  { code: "OTHER", label: "Other" },
] as const;

export type ManualSourceType = (typeof MANUAL_SOURCE_TYPES)[number]["code"];
