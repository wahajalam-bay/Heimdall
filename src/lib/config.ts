import { prisma, type DbClient } from "./db";

/**
 * Configuration / business-rule engine.
 *
 * Nothing in the procurement engine hard-codes a threshold. Values resolve
 * entity-specific first, then global, then the seeded default below.
 */

export type ConfigValueType = "number" | "boolean" | "string" | "json";

export type ConfigDef = {
  key: string;
  label: string;
  description: string;
  group: string;
  valueType: ConfigValueType;
  default: unknown;
};

export const CONFIG_KEYS = {
  // Payment document pack — see server/payment-pack.ts.
  ENFORCE_PAYMENT_PACK: "invoice.enforce_payment_document_pack",
  // Minimum stock and replenishment — see server/replenishment.ts, ZAM §3.3.
  MIN_STOCK_WINDOW_DAYS: "inventory.min_stock_window_days",
  MIN_STOCK_LEAD_DAYS: "inventory.min_stock_lead_days",
  MIN_STOCK_SAFETY_DAYS: "inventory.min_stock_safety_days",
  MIN_STOCK_MIN_MOVEMENTS: "inventory.min_stock_min_movements",
  // Scrap Material Policy evidence — ZAM/PUR/SOP-01 disposal procedure.
  ENFORCE_DISPOSAL_EVIDENCE: "disposal.enforce_evidence",
  // PO splitting detector.
  SPLIT_WINDOW_DAYS: "compliance.split_window_days",
  SPLIT_MIN_ORDERS: "compliance.split_min_orders",
  // Price Competitiveness Policy — ZAM/PUR/SOP-01.
  ENFORCE_PRICE_COMPETITIVENESS: "sourcing.enforce_price_competitiveness",
  // Purchase order acknowledgement — ZAM §4.6.
  PO_ACKNOWLEDGEMENT_DAYS: "po.acknowledgement_days",
  // Inventory costing — see server/costing.ts and BD-008.
  COSTING_METHOD: "inventory.costing_method",
  COST_LAYERS_FROM: "inventory.cost_layers_from",
  // Inventory ageing bands and the near-expiry window.
  AGEING_BANDS: "inventory.ageing_bands",
  NEAR_EXPIRY_DAYS: "inventory.near_expiry_days",
  // Accounting treatment — see lib/treatment.ts and BD-002.
  CAPITALISATION_THRESHOLD: "treatment.capitalisation_threshold",
  CAPITALISATION_MODE: "treatment.capitalisation_mode",
  CAPITALISATION_EXEMPT_CATEGORIES: "treatment.capitalisation_exempt_categories",
  // Policy Pack — every contested value from the two SOPs. The catalogue,
  // variants and per-entity defaults live in `lib/policy.ts`; these are the
  // storage keys, so an entity override is an ordinary ConfigSetting row.
  POLICY_VENDOR_EVALUATION_INTERVAL_MONTHS: "policy.vendor_evaluation_interval_months",
  POLICY_VENDOR_PERFORMANCE_INSTRUMENT: "policy.vendor_performance_instrument",
  POLICY_VENDOR_RATING_SCALE: "policy.vendor_rating_scale",
  POLICY_VENDOR_QUALITY_SCORING: "policy.vendor_quality_scoring",
  POLICY_VENDOR_INTERNAL_REFERENCE_SCALE: "policy.vendor_internal_reference_scale",
  POLICY_VENDOR_PQ_MAX_SCORE: "policy.vendor_pq_max_score",
  POLICY_VENDOR_PQ_MIN_SCORE: "policy.vendor_pq_min_score",
  POLICY_CPC_MEETING_WEEKDAY: "policy.cpc_meeting_weekday",
  POLICY_COMMITTEE_QUORUM_PERMANENT_MIN: "policy.committee_quorum_permanent_min",
  POLICY_COMMITTEE_QUORUM_REQUIRES_MANDATORY: "policy.committee_quorum_requires_mandatory",
  POLICY_COMMITTEE_OBSERVERS_COUNT: "policy.committee_observers_count_toward_quorum",
  POLICY_PAYMENT_ROUTE: "policy.payment_route",
  POLICY_COST_ANALYSIS_FORM_VERSION: "policy.cost_analysis_form_version",
  POLICY_TAX_RATES: "policy.tax_rates",
  POLICY_SYSTEM_OF_RECORD: "policy.system_of_record",
  POLICY_PETTY_CASH_ROUTE: "policy.petty_cash_route",
  POLICY_PRICE_REVIEW_INTERVAL_MONTHS: "policy.price_review_interval_months",
  POLICY_PRICE_REVIEW_QUOTES: "policy.price_review_quote_count",
  POLICY_UNRATED_VENDOR_TREATMENT: "policy.unrated_vendor_treatment",
  POLICY_BLOCKING_ENABLED: "policy.vendor_blocking_enabled",
  POLICY_PQ_VALIDITY_MONTHS: "policy.pq_validity_months",
  POLICY_CPC_THRESHOLDS_BY_TYPE: "policy.cpc_thresholds_by_transaction_type",
  POLICY_CEO_APPROVAL_THRESHOLD: "policy.ceo_approval_threshold",
  POLICY_EXCEPTIONAL_PURCHASE_DEFINED: "policy.exceptional_purchase_definition_confirmed",
  POLICY_RNC_QUORUM_BY_REGION: "policy.rnc_quorum_by_region",
  POLICY_INSPECTION_FORM_PAIRS_QUAL_TECH: "policy.inspection_form_pairs_qualitative_technical",
  POLICY_MONTHLY_REQUISITION_OWNERS: "policy.monthly_requisition_owners",
  POLICY_NO_APPROVER_BEHAVIOUR: "policy.no_approver_behaviour",
  // Segregation of duties — see lib/sod.ts for what each one separates.
  SOD_COST_ANALYSIS_PREPARE_VERIFY: "sod.cost_analysis_prepare_verify",
  SOD_PR_RAISE_APPROVE: "sod.pr_raise_approve",
  SOD_GRN_POST_INVOICE_APPROVE: "sod.grn_post_invoice_approve",
  SOD_PROHIBITED_ROLE_COMBINATIONS: "sod.prohibited_role_combinations",
  CPC_THRESHOLD: "procurement.cpc_threshold_amount",
  CPC_ENABLED: "procurement.cpc_enabled",
  CPC_MEETING_DAY: "procurement.cpc_meeting_day",
  CPC_MEETING_CADENCE: "procurement.cpc_meeting_cadence",
  PETTY_CASH_LIMIT: "procurement.petty_cash_limit",
  PETTY_CASH_MIN_QUOTES: "procurement.petty_cash_min_quotes",
  MIN_QUOTATIONS: "procurement.minimum_quotations",
  MIN_QUOTATIONS_WAIVER_BELOW: "procurement.minimum_quotations_waiver_below",
  DEPT_APPROVAL_REQUIRED: "approval.department_approval_required",
  PO_APPROVAL_THRESHOLD_SM: "approval.po_senior_manager_threshold",
  PO_APPROVAL_THRESHOLD_DIR: "approval.po_director_threshold",
  INVOICE_APPROVAL_THRESHOLD_SM: "approval.invoice_senior_manager_threshold",
  INVOICE_APPROVAL_THRESHOLD_DIR: "approval.invoice_director_threshold",
  VENDOR_MIN_SCORE: "vendor.minimum_qualification_score",
  VENDOR_MAX_SCORE: "vendor.maximum_qualification_score",
  VENDOR_REEVALUATION_MONTHS: "vendor.reevaluation_interval_months",
  INVOICE_QTY_TOLERANCE: "invoice.quantity_tolerance_percent",
  INVOICE_PRICE_TOLERANCE: "invoice.price_tolerance_percent",
  INVOICE_VALUE_TOLERANCE_ABS: "invoice.value_tolerance_absolute",
  REQUIRE_GRN_FOR_PAYMENT: "invoice.require_grn_before_payment",
  BLOCK_PAYMENT_ON_MISMATCH: "invoice.block_payment_on_mismatch",
  REQUIRE_INSPECTION_CATEGORIES: "receiving.mandatory_inspection_categories",
  ALLOW_EXCESS_RECEIPT_PERCENT: "receiving.allow_excess_receipt_percent",
  MD_ROUTE_TO_SITE_STORE: "receiving.md_route_to_site_store",
  MD_REQUIRE_BOQ: "requisition.md_require_boq",
  MD_REQUIRE_DRAWING: "requisition.md_require_drawing",
  MD_REQUIRE_PM: "requisition.md_require_pm_owner",
  PR_REQUIRE_JUSTIFICATION_ABOVE: "requisition.require_justification_above",
  PR_REQUIRE_SPEC: "requisition.require_specification",
  SLA_DEPT_APPROVAL_HOURS: "sla.department_approval_hours",
  SLA_PROCUREMENT_REVIEW_HOURS: "sla.procurement_review_hours",
  SLA_RFQ_RESPONSE_HOURS: "sla.rfq_response_hours",
  SLA_COMPARATIVE_HOURS: "sla.comparative_hours",
  SLA_CPC_HOURS: "sla.cpc_hours",
  SLA_PO_APPROVAL_HOURS: "sla.po_approval_hours",
  SLA_GRN_HOURS: "sla.grn_after_delivery_hours",
  SLA_INSPECTION_HOURS: "sla.inspection_hours",
  SLA_INVOICE_VERIFICATION_HOURS: "sla.invoice_verification_hours",
  SIGNATORY_LADDER: "finance.signatory_ladder",
  SLA_SIGNATORY_HOURS: "sla.signatory_hours",
  SLA_PAYMENT_HOURS: "sla.payment_hours",
  BUDGET_CONTROL: "finance.budget_control",
  BUDGET_WARN_PERCENT: "finance.budget_warn_percent",
  TAX_VERIFICATION_REQUIRED: "finance.tax_verification_required",
  VARIANCE_TOLERANCE_PERCENT: "receiving.variance_tolerance_percent",
  RETURN_REPLACEMENT_DAYS: "receiving.return_replacement_days",
  ITEM_CODE_AUTOGENERATE: "masters.item_code_autogenerate",
  REQUIRE_INVENTORY_CHECK: "demand.require_inventory_check",
  PARTIAL_AVAILABILITY_MODE: "demand.partial_availability_mode",
  CROSS_STORE_ENABLED: "demand.cross_store_enabled",
  CROSS_STORE_RADIUS_KM: "demand.cross_store_radius_km",
  CROSS_STORE_APPROVER_ROLE: "demand.cross_store_approver_role",
  RESERVE_ON_DECISION: "demand.reserve_on_decision",
  RESERVATION_EXPIRY_DAYS: "demand.reservation_expiry_days",
  SR_REQUIRE_HOD: "demand.sr_require_hod_approval",
  SLA_SR_APPROVAL_HOURS: "sla.sr_approval_hours",
  SLA_SR_ISSUE_HOURS: "sla.sr_issue_hours",
  OPEN_PO_STALE_DAYS: "monitoring.open_po_stale_days",
  MISSING_GRN_DAYS: "monitoring.missing_grn_alert_days",
  ADVANCE_PAYMENT_ALLOWED: "payment.advance_payment_allowed",
  ADVANCE_REQUIRES_COLLATERAL: "payment.advance_requires_collateral",
  ADVANCE_MAX_PERCENT: "payment.advance_max_percent",
  DEFAULT_TAX_RATE: "finance.default_tax_rate_percent",
  WITHHOLDING_TAX_RATE: "finance.withholding_tax_rate_percent",
  NON_LOWEST_REQUIRES_JUSTIFICATION: "sourcing.non_lowest_requires_justification",
  BLOCK_BLACKLISTED_VENDORS: "sourcing.block_blacklisted_vendors",
  ALLOW_BLACKLIST_OVERRIDE: "sourcing.allow_blacklist_override",
  PRICE_VARIANCE_ALERT_PERCENT: "sourcing.price_variance_alert_percent",
  TRADER_MOQ_TRACKING: "sourcing.track_trader_moq_cases",
  DISPOSAL_REQUIRES_AUDIT: "disposal.requires_audit_review",
  DISPOSAL_BIDDING_THRESHOLD: "disposal.bidding_required_above",
  DISPOSAL_MGMT_APPROVAL_THRESHOLD: "disposal.management_approval_above",
} as const;

export const CONFIG_DEFS: ConfigDef[] = [
  {
    key: CONFIG_KEYS.CPC_THRESHOLD,
    label: "CPC review threshold",
    description:
      "Non-routine procurement at or above this value must be reviewed by the Central Procurement Committee before a PO is raised.",
    group: "Thresholds",
    valueType: "number",
    default: 500000,
  },
  {
    key: CONFIG_KEYS.CPC_ENABLED,
    label: "CPC review enabled",
    description: "Master switch for CPC routing. Disabling it bypasses committee review entirely.",
    group: "Thresholds",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.CPC_MEETING_DAY,
    label: "CPC meeting day",
    description: "Default weekday for the recurring CPC meeting (0 = Sunday).",
    group: "CPC",
    valueType: "number",
    default: 3,
  },
  {
    key: CONFIG_KEYS.CPC_MEETING_CADENCE,
    label: "CPC meeting cadence",
    description: "WEEKLY or ON_DEMAND.",
    group: "CPC",
    valueType: "string",
    default: "WEEKLY",
  },
  {
    key: CONFIG_KEYS.PETTY_CASH_LIMIT,
    label: "Petty cash limit",
    description: "Maximum value that may be procured through the petty cash route.",
    group: "Thresholds",
    valueType: "number",
    default: 15000,
  },
  {
    key: CONFIG_KEYS.PETTY_CASH_MIN_QUOTES,
    label: "Petty cash minimum market quotes",
    description: "Written market quotations required before a cash purchase is approved.",
    group: "Sourcing",
    valueType: "number",
    default: 3,
  },
  {
    key: CONFIG_KEYS.MIN_QUOTATIONS,
    label: "Minimum quotations",
    description: "Quotations required before a comparative can be recommended.",
    group: "Sourcing",
    valueType: "number",
    default: 3,
  },
  {
    key: CONFIG_KEYS.MIN_QUOTATIONS_WAIVER_BELOW,
    label: "Waive minimum quotations below",
    description: "Cases below this value may proceed with fewer quotations.",
    group: "Sourcing",
    valueType: "number",
    default: 25000,
  },
  {
    key: CONFIG_KEYS.DEPT_APPROVAL_REQUIRED,
    label: "Department approval required",
    description: "Require department head approval before procurement review.",
    group: "Approvals",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.PO_APPROVAL_THRESHOLD_SM,
    label: "PO — Senior Manager approval above",
    description: "POs at or above this value require Procurement Senior Manager approval.",
    group: "Approvals",
    valueType: "number",
    default: 100000,
  },
  {
    key: CONFIG_KEYS.PO_APPROVAL_THRESHOLD_DIR,
    label: "PO — Director approval above",
    description: "POs at or above this value additionally require Procurement Director approval.",
    group: "Approvals",
    valueType: "number",
    default: 500000,
  },
  {
    key: CONFIG_KEYS.INVOICE_APPROVAL_THRESHOLD_SM,
    label: "Invoice — Senior Manager approval above",
    description: "Invoices at or above this value require Procurement Senior Manager approval.",
    group: "Approvals",
    valueType: "number",
    default: 100000,
  },
  {
    key: CONFIG_KEYS.INVOICE_APPROVAL_THRESHOLD_DIR,
    label: "Invoice — Director approval above",
    description: "Invoices at or above this value additionally require Procurement Director approval.",
    group: "Approvals",
    valueType: "number",
    default: 500000,
  },
  {
    key: CONFIG_KEYS.VENDOR_MIN_SCORE,
    label: "Vendor minimum qualification score",
    description: "Minimum pre-qualification score for a vendor to be approved.",
    group: "Vendors",
    valueType: "number",
    default: 30,
  },
  {
    key: CONFIG_KEYS.VENDOR_MAX_SCORE,
    label: "Vendor maximum qualification score",
    description: "Total achievable pre-qualification score.",
    group: "Vendors",
    valueType: "number",
    default: 60,
  },
  {
    key: CONFIG_KEYS.VENDOR_REEVALUATION_MONTHS,
    label: "Vendor re-evaluation interval (months)",
    description: "How often approved vendors must be re-evaluated.",
    group: "Vendors",
    valueType: "number",
    default: 12,
  },
  {
    key: CONFIG_KEYS.INVOICE_QTY_TOLERANCE,
    label: "Invoice quantity tolerance %",
    description: "Permitted quantity variance between invoice and accepted GRN quantity.",
    group: "Invoice Matching",
    valueType: "number",
    default: 0,
  },
  {
    key: CONFIG_KEYS.INVOICE_PRICE_TOLERANCE,
    label: "Invoice price tolerance %",
    description: "Permitted unit-price variance between invoice and PO.",
    group: "Invoice Matching",
    valueType: "number",
    default: 0.5,
  },
  {
    key: CONFIG_KEYS.INVOICE_VALUE_TOLERANCE_ABS,
    label: "Invoice value tolerance (absolute)",
    description: "Absolute rounding tolerance on total invoice value.",
    group: "Invoice Matching",
    valueType: "number",
    default: 10,
  },
  {
    key: CONFIG_KEYS.REQUIRE_GRN_FOR_PAYMENT,
    label: "Require GRN before payment",
    description: "Block payment handoff for goods with no posted GRN.",
    group: "Invoice Matching",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.BLOCK_PAYMENT_ON_MISMATCH,
    label: "Block payment on three-way mismatch",
    description: "Prevent invoice approval while a match failure is unresolved.",
    group: "Invoice Matching",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.REQUIRE_INSPECTION_CATEGORIES,
    label: "Categories requiring technical inspection",
    description: "Category codes whose receipts cannot be posted to a GRN without inspection sign-off.",
    group: "Receiving",
    valueType: "json",
    default: ["IT-EQUIP", "MACHINERY", "ELECTRICAL", "CONSTR-STEEL"],
  },
  {
    key: CONFIG_KEYS.ALLOW_EXCESS_RECEIPT_PERCENT,
    label: "Allowed over-receipt %",
    description: "Quantity above the ordered quantity that may be received without an override.",
    group: "Receiving",
    valueType: "number",
    default: 0,
  },
  {
    key: CONFIG_KEYS.MD_ROUTE_TO_SITE_STORE,
    label: "Route Material Demand to site store",
    description: "Material Demands default to the project's site store rather than the central warehouse.",
    group: "Receiving",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.MD_REQUIRE_BOQ,
    label: "Material Demand requires BOQ",
    description: "Block submission of a Material Demand without a BOQ reference.",
    group: "Requisitions",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.MD_REQUIRE_DRAWING,
    label: "Material Demand requires drawing",
    description: "Block submission of a Material Demand without a drawing reference.",
    group: "Requisitions",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.MD_REQUIRE_PM,
    label: "Material Demand requires PM owner",
    description: "Block submission of a Material Demand without a named project manager.",
    group: "Requisitions",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.PR_REQUIRE_JUSTIFICATION_ABOVE,
    label: "Require business justification above",
    description: "Requisitions at or above this value must carry a written justification.",
    group: "Requisitions",
    valueType: "number",
    default: 50000,
  },
  {
    key: CONFIG_KEYS.PR_REQUIRE_SPEC,
    label: "Require item specification",
    description: "Every requisition line must carry a specification before submission.",
    group: "Requisitions",
    valueType: "boolean",
    default: true,
  },
  { key: CONFIG_KEYS.SLA_DEPT_APPROVAL_HOURS, label: "SLA — department approval (h)", description: "Target turnaround for department head approval.", group: "SLA", valueType: "number", default: 24 },
  { key: CONFIG_KEYS.SLA_PROCUREMENT_REVIEW_HOURS, label: "SLA — procurement review (h)", description: "Target turnaround for procurement review.", group: "SLA", valueType: "number", default: 24 },
  { key: CONFIG_KEYS.SLA_RFQ_RESPONSE_HOURS, label: "SLA — RFQ vendor response (h)", description: "Expected vendor response window.", group: "SLA", valueType: "number", default: 72 },
  { key: CONFIG_KEYS.SLA_COMPARATIVE_HOURS, label: "SLA — comparative preparation (h)", description: "Target turnaround to prepare a comparative once quotes are in.", group: "SLA", valueType: "number", default: 24 },
  { key: CONFIG_KEYS.SLA_CPC_HOURS, label: "SLA — CPC decision (h)", description: "Target turnaround for a CPC decision.", group: "SLA", valueType: "number", default: 168 },
  { key: CONFIG_KEYS.SLA_PO_APPROVAL_HOURS, label: "SLA — PO approval (h)", description: "Target turnaround for PO approval.", group: "SLA", valueType: "number", default: 24 },
  { key: CONFIG_KEYS.SLA_GRN_HOURS, label: "SLA — GRN after delivery (h)", description: "GRN must be raised within this window of physical receipt.", group: "SLA", valueType: "number", default: 48 },
  { key: CONFIG_KEYS.SLA_INSPECTION_HOURS, label: "SLA — technical inspection (h)", description: "Target turnaround for technical inspection.", group: "SLA", valueType: "number", default: 48 },
  { key: CONFIG_KEYS.SLA_INVOICE_VERIFICATION_HOURS, label: "SLA — invoice verification (h)", description: "Target turnaround for invoice verification.", group: "SLA", valueType: "number", default: 72 },
  {
    key: CONFIG_KEYS.SIGNATORY_LADDER,
    label: "Signatory ladder",
    description:
      'Who signs a payment voucher, in order, as JSON: [{"roleCode":"FINANCE_USER","above":0},{"roleCode":"FINANCE_APPROVER","above":500000}]. A rung applies only above its amount. PENDING BUSINESS CONFIRMATION — the specification leaves the signatory hierarchy open, so this defaults to the two finance roles that exist.',
    group: "Finance",
    valueType: "string",
    default: '[{"roleCode":"FINANCE_USER","above":0},{"roleCode":"FINANCE_APPROVER","above":500000}]',
  },
  {
    key: CONFIG_KEYS.SLA_SIGNATORY_HOURS,
    label: "SLA — voucher signature (h)",
    description: "Target turnaround for each signature on a payment voucher.",
    group: "SLA",
    valueType: "number",
    default: 48,
  },
  {
    key: CONFIG_KEYS.SLA_PAYMENT_HOURS,
    label: "SLA — payment release (h)",
    description: "Target turnaround to release payment once a voucher is fully signed.",
    group: "SLA",
    valueType: "number",
    default: 72,
  },
  {
    key: CONFIG_KEYS.BUDGET_CONTROL,
    label: "Budget control",
    description:
      "OFF reports only. WARN flags an over-commitment but allows it. BLOCK refuses approval past the allocation. PENDING BUSINESS CONFIRMATION — the default warns, because blocking a budget nobody has loaded yet would stop the system.",
    group: "Finance",
    valueType: "string",
    default: "WARN",
  },
  {
    key: CONFIG_KEYS.BUDGET_WARN_PERCENT,
    label: "Budget warning threshold (%)",
    description: "Utilisation above which a budget line is flagged as close to exhausted.",
    group: "Finance",
    valueType: "number",
    default: 85,
  },
  {
    key: CONFIG_KEYS.TAX_VERIFICATION_REQUIRED,
    label: "Tax must be verified before a voucher",
    description: "Finance must verify every tax line on an invoice before a payment voucher can be raised.",
    group: "Finance",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.VARIANCE_TOLERANCE_PERCENT,
    label: "Receipt variance tolerance (%)",
    description:
      "Difference between ordered and received quantity that is recorded as a variance rather than blocking the receipt.",
    group: "Receiving",
    valueType: "number",
    default: 2,
  },
  {
    key: CONFIG_KEYS.RETURN_REPLACEMENT_DAYS,
    label: "Replacement expected within (days)",
    description: "Days a vendor has to replace returned goods before the return is flagged as overdue.",
    group: "Receiving",
    valueType: "number",
    default: 14,
  },
  {
    key: CONFIG_KEYS.ITEM_CODE_AUTOGENERATE,
    label: "Derive item codes from the rule",
    description:
      "New catalogue items take a code built from the configured pattern rather than one typed by hand.",
    group: "Masters",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.REQUIRE_INVENTORY_CHECK,
    label: "Check stock before procurement",
    description:
      "A requirement must pass an inventory availability check before it can become a purchase requisition.",
    group: "Demand",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.PARTIAL_AVAILABILITY_MODE,
    label: "When stock covers part of a requirement",
    description:
      "SPLIT issues what is on hand and buys the shortfall. ALL_TO_PROCUREMENT sends the whole line to procurement. PENDING BUSINESS CONFIRMATION — the default splits, because issuing stock that exists and buying only the gap is the cheaper of the two.",
    group: "Demand",
    valueType: "string",
    default: "SPLIT",
  },
  {
    key: CONFIG_KEYS.CROSS_STORE_ENABLED,
    label: "Allow fulfilment from another store",
    description: "Stock held in a different store may be drawn on, with approval.",
    group: "Demand",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.CROSS_STORE_RADIUS_KM,
    label: "Cross-store search radius (km)",
    description:
      "How far from the requesting site another store may be and still be offered. PENDING BUSINESS CONFIRMATION — 0 means every store the reader can see, which is the behaviour until a radius is agreed.",
    group: "Demand",
    valueType: "number",
    default: 0,
  },
  {
    key: CONFIG_KEYS.CROSS_STORE_APPROVER_ROLE,
    label: "Cross-store approver role",
    description:
      "Role that authorises drawing stock from another store. PENDING BUSINESS CONFIRMATION.",
    group: "Demand",
    valueType: "string",
    default: "STORE_MANAGER",
  },
  {
    key: CONFIG_KEYS.RESERVE_ON_DECISION,
    label: "Reserve stock on the fulfilment decision",
    description:
      "Holds the quantity against the requirement so a second requirement is not promised the same stock.",
    group: "Demand",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.RESERVATION_EXPIRY_DAYS,
    label: "Reservation expires after (days)",
    description: "A reservation not consumed by an issue within this window is released.",
    group: "Demand",
    valueType: "number",
    default: 14,
  },
  {
    key: CONFIG_KEYS.SR_REQUIRE_HOD,
    label: "Store requisitions need HOD approval",
    description:
      "Adds a department-head decision before the store is asked to issue. The approval sequence is configurable.",
    group: "Demand",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.SLA_SR_APPROVAL_HOURS,
    label: "SLA — store requisition approval (h)",
    description: "Target turnaround to approve a store requisition.",
    group: "SLA",
    valueType: "number",
    default: 24,
  },
  {
    key: CONFIG_KEYS.SLA_SR_ISSUE_HOURS,
    label: "SLA — store issuance (h)",
    description: "Target turnaround for the store to issue once approved.",
    group: "SLA",
    valueType: "number",
    default: 24,
  },
  {
    key: CONFIG_KEYS.OPEN_PO_STALE_DAYS,
    label: "Open PO stale after (days)",
    description: "POs issued longer ago than this with no full receipt are flagged long-outstanding.",
    group: "Monitoring",
    valueType: "number",
    default: 45,
  },
  {
    key: CONFIG_KEYS.MISSING_GRN_DAYS,
    label: "Missing GRN alert (days)",
    description: "Days past the promised delivery date before a missing-GRN exception is raised.",
    group: "Monitoring",
    valueType: "number",
    default: 7,
  },
  {
    key: CONFIG_KEYS.ADVANCE_PAYMENT_ALLOWED,
    label: "Advance payment allowed",
    description: "Whether POs may carry an advance payment.",
    group: "Payment",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.ADVANCE_REQUIRES_COLLATERAL,
    label: "Advance requires collateral",
    description: "Require a security cheque or bank guarantee against any advance.",
    group: "Payment",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.ADVANCE_MAX_PERCENT,
    label: "Maximum advance %",
    description: "Largest advance permitted as a percentage of PO value.",
    group: "Payment",
    valueType: "number",
    default: 30,
  },
  {
    key: CONFIG_KEYS.DEFAULT_TAX_RATE,
    label: "Default sales tax %",
    description:
      "PC-012. Pre-filled on new quotation and purchase order lines as a convenience — a data-entry default a buyer can overtype, not a rate the system asserts. 0 means no pre-fill. The 18% this used to ship with had no SOP authority and contradicted the 16% on the Cost Analysis Form; neither SOP states a percentage, because §4.8 defers to the Income Tax Ordinance and both payment flows route the computation to KPMG. The authoritative rates live in the policy pack under Tax rates (effective-dated) and are what a printed form reads.",
    group: "Finance",
    valueType: "number",
    default: 0,
  },
  { key: CONFIG_KEYS.WITHHOLDING_TAX_RATE, label: "Withholding tax %", description: "Deducted at payment handoff.", group: "Finance", valueType: "number", default: 4.5 },
  {
    key: CONFIG_KEYS.NON_LOWEST_REQUIRES_JUSTIFICATION,
    label: "Non-lowest award requires justification",
    description: "Selecting anything other than the lowest compliant quote requires a written justification.",
    group: "Sourcing",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.BLOCK_BLACKLISTED_VENDORS,
    label: "Block blacklisted vendors",
    description: "Prevent blacklisted or suspended vendors from being invited or awarded.",
    group: "Sourcing",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.ALLOW_BLACKLIST_OVERRIDE,
    label: "Allow authorised blacklist override",
    description: "Permit the Procurement Director to override a vendor block with a recorded reason.",
    group: "Sourcing",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.PRICE_VARIANCE_ALERT_PERCENT,
    label: "Price variance alert %",
    description: "Variance against previous or market price that raises a price-variance exception.",
    group: "Sourcing",
    valueType: "number",
    default: 15,
  },
  {
    key: CONFIG_KEYS.TRADER_MOQ_TRACKING,
    label: "Track trader / MOQ cases",
    description: "Capture why a trader was used instead of a principal vendor when MOQ does not suit.",
    group: "Sourcing",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.DISPOSAL_REQUIRES_AUDIT,
    label: "Disposal requires audit review",
    description: "Audit must review a disposal case before approval.",
    group: "Disposal",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.DISPOSAL_BIDDING_THRESHOLD,
    label: "Disposal bidding required above",
    description: "Disposals estimated at or above this value must go through a bidding process.",
    group: "Disposal",
    valueType: "number",
    default: 25000,
  },
  {
    key: CONFIG_KEYS.DISPOSAL_MGMT_APPROVAL_THRESHOLD,
    label: "Disposal management approval above",
    description: "Disposals realising at or above this value need management committee approval.",
    group: "Disposal",
    valueType: "number",
    default: 100000,
  },

  /* ── Segregation of duties ──────────────────────────────────────────────
   * One entry per stated separation, entity-overridable. Each defaults to
   * enforced because that is what the source documents say; switching one off
   * is a recorded decision rather than a silent gap. */
  {
    key: CONFIG_KEYS.SOD_COST_ANALYSIS_PREPARE_VERIFY,
    label: "Cost analysis: preparer cannot verify",
    description:
      "Annexure 3 carries Prepared By and Verified By as two signatures. With this on, the person who prepared a cost analysis cannot also verify it.",
    group: "Segregation of duties",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.SOD_PR_RAISE_APPROVE,
    label: "Requisition: requester cannot approve",
    description:
      "Departmental approval is assent given to the requester. With this on, nobody approves a requisition they raised themselves.",
    group: "Segregation of duties",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.SOD_GRN_POST_INVOICE_APPROVE,
    label: "Invoice: receipt poster cannot approve payment",
    description:
      "Keeps the three-way match an independent check: the person who posted the goods receipt does not also approve the invoice matched against it.",
    group: "Segregation of duties",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.SOD_PROHIBITED_ROLE_COMBINATIONS,
    label: "Prohibited role combinations",
    description:
      'Role pairs nobody may hold at once, as JSON: [{"roles":["A","B"],"reason":"..."}]. EMPTY BY DEFAULT — the supplied SOPs state no such combination, and inventing one would lock people out of work they do today. Populate it when the business states one.',
    group: "Segregation of duties",
    valueType: "json",
    default: [],
  },

  /* ── Policy Pack ────────────────────────────────────────────────────────
   * Each of these resolves a numbered policy conflict. The *global* value
   * below is the reading that applies where the two entities agree; where they
   * differ, the seeder writes an entity-scoped row for each, because a single
   * global value is exactly what made these look like conflicts in the first
   * place. `lib/policy.ts` holds the variants and the source citations. */
  {
    key: CONFIG_KEYS.POLICY_VENDOR_EVALUATION_INTERVAL_MONTHS,
    label: "Vendor evaluation interval (months)",
    description:
      "ZAM/PUR/SOP-01 §5.9: \"Vendor's performance will be evaluated after every three months\". Three is therefore both the Zameen Media value and the shipped default. ZD/PRO/SOP-01 states annually; that is held as an entity override for ZD and is FUTURE / ZD ONLY — it must not become the fallback Zameen Media inherits.",
    group: "Policy · Vendors",
    valueType: "number",
    default: 3,
  },
  {
    key: CONFIG_KEYS.POLICY_VENDOR_PERFORMANCE_INSTRUMENT,
    label: "Vendor performance instrument",
    description:
      "PC-002. PERF-5CRIT-ANNEX (image11.png, 40/20/30/5/5) or PERF-6CRIT-TEXT (narrative §5.9, 40/20/20/10/5/5). AWAITING CONFIRMATION — a document contradicts its own annexure.",
    group: "Policy · Vendors",
    valueType: "string",
    default: "PERF-5CRIT-ANNEX",
  },
  {
    key: CONFIG_KEYS.POLICY_VENDOR_RATING_SCALE,
    label: "Vendor rating scale",
    description:
      "PC-003. SCALE-5BAND (image13.png, Unsatisfactory = 1) or SCALE-4BAND (narrative, Unsatisfactory = 0). AWAITING CONFIRMATION.",
    group: "Policy · Vendors",
    valueType: "string",
    default: "SCALE-5BAND",
  },
  {
    key: CONFIG_KEYS.POLICY_VENDOR_QUALITY_SCORING,
    label: "Quality criterion scoring method",
    description:
      "PC-004. QUALITY-BY-COMPLAINTS (narrative) or QUALITY-BY-ACCEPTED-PCT (image12.png). The accepted-percentage form leaves 80–90% unscored, so it cannot be used until that gap is closed. AWAITING CONFIRMATION.",
    group: "Policy · Vendors",
    valueType: "string",
    default: "QUALITY-BY-COMPLAINTS",
  },
  {
    key: CONFIG_KEYS.POLICY_VENDOR_INTERNAL_REFERENCE_SCALE,
    label: "Internal reference marks",
    description:
      "PC-005. IREF-1-2-4 (Annexure 6, section maximum 4) or IREF-3-4-5 (image10.png, out of five). AWAITING CONFIRMATION.",
    group: "Policy · Vendors",
    valueType: "string",
    default: "IREF-1-2-4",
  },
  {
    key: CONFIG_KEYS.POLICY_VENDOR_PQ_MAX_SCORE,
    label: "Pre-qualification maximum score",
    description:
      "PC-006. Annexure 6 prints 'Min. Qualifying Score: 30/60', but its own section maxima sum to 61. 61 is seeded because that is what an evaluator adds up; a vendor cannot otherwise score 61 out of 60. AWAITING CONFIRMATION.",
    group: "Policy · Vendors",
    valueType: "number",
    default: 61,
  },
  {
    key: CONFIG_KEYS.POLICY_VENDOR_PQ_MIN_SCORE,
    label: "Pre-qualification qualifying score",
    description: "PC-006. The printed minimum, 30, which both readings of the maximum agree on.",
    group: "Policy · Vendors",
    valueType: "number",
    default: 30,
  },
  {
    key: CONFIG_KEYS.POLICY_PQ_VALIDITY_MONTHS,
    label: "Pre-qualification validity (months)",
    description:
      "PC-021. ZD §2.3.1 iii states two years. ZAM is silent, so ZAM is seeded with 0 — the control is inactive there until instructed, rather than ZD's rule being imposed on it.",
    group: "Policy · Vendors",
    valueType: "number",
    default: 0,
  },
  {
    key: CONFIG_KEYS.POLICY_UNRATED_VENDOR_TREATMENT,
    label: "Vendor with no performance rating",
    description:
      "PC-018. UNRATED-ALLOW-WITH-EXCEPTION, UNRATED-ALLOW or UNRATED-BLOCK. ZD §2.3.3 ii bars business without a satisfactory rating but neither SOP says what an unrated vendor is. SOURCE CLARIFICATION REQUIRED.",
    group: "Policy · Vendors",
    valueType: "string",
    default: "UNRATED-ALLOW-WITH-EXCEPTION",
  },
  {
    key: CONFIG_KEYS.POLICY_BLOCKING_ENABLED,
    label: "Temporary vendor blocking enabled",
    description:
      "PC-020. ZD §2.3.4 iv–vi defines blocking as distinct from blacklisting. ZAM has no such concept, so blocking is on for ZD and off for ZAM until ZAM adopts it.",
    group: "Policy · Vendors",
    valueType: "boolean",
    default: false,
  },
  {
    key: CONFIG_KEYS.POLICY_CPC_MEETING_WEEKDAY,
    label: "Committee meeting weekday",
    description:
      "PC-007. ZAM meets every Wednesday (3), ZD every Thursday (4). Both explicit; both seeded. 0 = Sunday.",
    group: "Policy · Committees",
    valueType: "number",
    default: 3,
  },
  {
    key: CONFIG_KEYS.POLICY_COMMITTEE_QUORUM_PERMANENT_MIN,
    label: "Quorum — minimum permanent members",
    description:
      "PC-009. 'At least 3 permanent committee members must be present in addition to the Head of the requisitioner department.'",
    group: "Policy · Committees",
    valueType: "number",
    default: 3,
  },
  {
    key: CONFIG_KEYS.POLICY_COMMITTEE_QUORUM_REQUIRES_MANDATORY,
    label: "Quorum — every mandatory member required",
    description:
      "PC-009. The RNC composition image adds a third type, Permanent Mandatory, whose effect on quorum is not stated. Seeded as required, which is the stricter reading. AWAITING CONFIRMATION.",
    group: "Policy · Committees",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.POLICY_COMMITTEE_OBSERVERS_COUNT,
    label: "Quorum — observers count",
    description:
      "PC-009. Observers are listed separately from permanent members in both committee tables, so they do not count and do not vote.",
    group: "Policy · Committees",
    valueType: "boolean",
    default: false,
  },
  {
    key: CONFIG_KEYS.POLICY_RNC_QUORUM_BY_REGION,
    label: "RNC quorum by region",
    description:
      'PC-024. JSON, e.g. [{"region":"CENTRAL","permanentMinimum":3}]. The ZAM RNC wording requires 3 permanent members plus the Head of the Committee, but image22.PNG shows North and South with only 3 members in total — so that quorum is arithmetically impossible there. North and South are seeded null pending a decision rather than given an invented number. SOURCE CLARIFICATION REQUIRED.',
    group: "Policy · Committees",
    valueType: "json",
    default: [
      { region: "CENTRAL", permanentMinimum: 3, requiresHeadOfCommittee: true },
      { region: "NORTH", permanentMinimum: null, requiresHeadOfCommittee: true },
      { region: "SOUTH", permanentMinimum: null, requiresHeadOfCommittee: true },
    ],
  },
  {
    key: CONFIG_KEYS.POLICY_CPC_THRESHOLDS_BY_TYPE,
    label: "Committee threshold by transaction type",
    description:
      'PC-022. JSON, e.g. [{"type":"GOODS","threshold":500000}]. The engagement limit names goods only; the mandate names any transaction. The wider mandate reading is seeded, so service contracts, AMCs and build-outs are referred rather than routed around a committee that names them. AWAITING CONFIRMATION.',
    group: "Policy · Committees",
    valueType: "json",
    default: [
      { type: "GOODS", threshold: 500000 },
      { type: "SERVICES", threshold: 500000 },
      { type: "SLA", threshold: 500000 },
      { type: "AMC", threshold: 500000 },
      { type: "BUILDOUT", threshold: 500000 },
      { type: "ONE_TIME", threshold: 500000 },
    ],
  },
  {
    key: CONFIG_KEYS.POLICY_CEO_APPROVAL_THRESHOLD,
    label: "CEO approval above",
    description:
      "PC-023. 'All purchases above PKR 1,500,000 are to be approved by Office of CEO' — unambiguous, so implemented. The separate 'Exceptional Purchases (Must be approved by CEO)' trigger has no stated definition and is held by the flag below.",
    group: "Policy · Committees",
    valueType: "number",
    default: 1500000,
  },
  {
    key: CONFIG_KEYS.POLICY_EXCEPTIONAL_PURCHASE_DEFINED,
    label: "Exceptional purchase definition confirmed",
    description:
      "PC-023. False until the business defines what makes a purchase exceptional. While false, the classification cannot be applied and only the value tier above routes to the CEO. SOURCE CLARIFICATION REQUIRED.",
    group: "Policy · Committees",
    valueType: "boolean",
    default: false,
  },
  {
    key: CONFIG_KEYS.POLICY_PAYMENT_ROUTE,
    label: "Payment processing route",
    description:
      "PC-010. PAY-ZAM-ANNEXA (2 Internal Audit checkpoints, KPMG tax step, cheque collection Tuesday and Friday, 7 documents) or PAY-ZD-JEFFI (PV plus JEFFI, single IA checkpoint with a resubmission loop, 9 documents). Each entity's own flow diagram governs; both are seeded.",
    group: "Policy · Finance",
    valueType: "string",
    default: "PAY-ZAM-ANNEXA",
  },
  {
    key: CONFIG_KEYS.POLICY_TAX_RATES,
    label: "Tax rates (effective-dated)",
    description:
      'PC-012. JSON, e.g. [{"code":"GST","label":"GST","percent":18,"effectiveFrom":"2026-01-01"}]. EMPTY BY DEFAULT AND DELIBERATELY SO: §4.8 defers to the Income Tax Ordinance and both payment flows route the computation to KPMG, so neither SOP states a percentage. The old 18% default and the Cost Analysis Form\'s 16% were both invented. Until a rate is entered here, a form shows tax as unset rather than printing a number nobody authorised.',
    group: "Policy · Finance",
    valueType: "json",
    default: [],
  },
  {
    key: CONFIG_KEYS.POLICY_COST_ANALYSIS_FORM_VERSION,
    label: "Cost Analysis form layout",
    description:
      "PC-011. CA-ANNEX3 (3 vendor columns, 6 terms rows, no computed tax) or CA-XLSX-5COL (5 vendor columns, computed tax and net total). The SOP annexure is seeded as authoritative; the supplied spreadsheet carries no entity marking or policy reference. AWAITING CONFIRMATION.",
    group: "Policy · Finance",
    valueType: "string",
    default: "CA-ANNEX3",
  },
  {
    key: CONFIG_KEYS.POLICY_PETTY_CASH_ROUTE,
    label: "Petty cash approval route",
    description:
      'PC-016. JSON list of steps. ZAM Annexure 2 shows HOD then Director Procurement. ZD adds a Sr. Manager Procurement step for the manual comparative that does not appear in the flow diagram, so ZD is seeded with three steps, flagged. AWAITING CONFIRMATION of the ZD chain.',
    group: "Policy · Finance",
    valueType: "json",
    default: [
      { seq: 1, role: "HOD", label: "Requester HOD approval" },
      { seq: 2, role: "PROCUREMENT_DIRECTOR", label: "Director Procurement approval" },
    ],
  },
  {
    key: CONFIG_KEYS.POLICY_PRICE_REVIEW_INTERVAL_MONTHS,
    label: "Price competitiveness review interval (months)",
    description:
      "PC-017. §5.11 requires a price comparison every two months with 3 quotes. That is a recurring market check, separate from the per-requisition 3-quotation rule in §4.5.1 — the two only looked contradictory because the second was implemented and the first was not.",
    group: "Policy · Sourcing",
    valueType: "number",
    default: 2,
  },
  {
    key: CONFIG_KEYS.POLICY_PRICE_REVIEW_QUOTES,
    label: "Price competitiveness review — quotes required",
    description: "PC-017. §5.11: 'by taking 3 quotes'.",
    group: "Policy · Sourcing",
    valueType: "number",
    default: 3,
  },
  {
    key: CONFIG_KEYS.POLICY_SYSTEM_OF_RECORD,
    label: "System of record by document type",
    description:
      'PC-014. JSON, e.g. [{"documentType":"PR","system":"HEIMDALL"}]. ZD names Sage in its text and SAP in its own annexure flow; ZAM names Sage 300. No integration is built on an ambiguous reference — this records the intent so it is visible. DECISION REQUIRED: is this system the book of record, or does it feed Sage/SAP?',
    group: "Policy · Platform",
    valueType: "json",
    default: [
      { documentType: "PR", system: "HEIMDALL" },
      { documentType: "PO", system: "HEIMDALL" },
      { documentType: "GRN", system: "HEIMDALL" },
      { documentType: "INVOICE", system: "HEIMDALL" },
      { documentType: "PAYMENT", system: "HEIMDALL" },
    ],
  },
  {
    key: CONFIG_KEYS.POLICY_INSPECTION_FORM_PAIRS_QUAL_TECH,
    label: "Inspection form pairs qualitative with technical",
    description:
      "PC-025. The Store Process Flow matrix names three inspection types; Annexure 4 prints only two columns, combining qualitative and technical. True keeps the printed layout while the three types stay distinct in data. SOURCE CLARIFICATION REQUIRED on whether the merge is intentional.",
    group: "Policy · Receiving",
    valueType: "boolean",
    default: true,
  },
  {
    key: CONFIG_KEYS.POLICY_MONTHLY_REQUISITION_OWNERS,
    label: "Monthly repeat requisition owners",
    description:
      'PC-026. JSON category-to-role mapping. §4.1 names procurement for IT equipment and logistics for grocery and housekeeping, then lists stationery among the monthly categories without naming an owner — so stationery is null, unassigned, rather than guessed. SOURCE CLARIFICATION REQUIRED.',
    group: "Policy · Requisitions",
    valueType: "json",
    default: [
      { category: "IT Equipment", ownerRole: "PROCUREMENT_OFFICER" },
      { category: "IT Accessories", ownerRole: "PROCUREMENT_OFFICER" },
      { category: "Grocery", ownerRole: "WAREHOUSE_MANAGER" },
      { category: "Housekeeping", ownerRole: "WAREHOUSE_MANAGER" },
      { category: "Stationery", ownerRole: null },
    ],
  },
  {
    key: CONFIG_KEYS.POLICY_NO_APPROVER_BEHAVIOUR,
    label: "When no approver matches a requisition",
    description:
      "PC-027. NOAPPR-ESCALATE walks the organogram to the first holder of pr.approve; NOAPPR-REFUSE blocks the submission and names the missing rule; NOAPPR-AUTO-APPROVE is the old behaviour, in which the submitter's own act approved their requisition. Escalation is seeded because the reporting lines already exist for every loaded member of staff. No SOP contemplates this case.",
    group: "Policy · Requisitions",
    valueType: "string",
    default: "NOAPPR-ESCALATE",
  },

  /* ── Accounting treatment ───────────────────────────────────────────────
   * The same item can be an asset in an office and a project cost on a
   * build-out, so treatment is decided per receipt. These govern when
   * capitalising needs a reason and an approval. See BD-002. */
  {
    key: CONFIG_KEYS.CAPITALISATION_THRESHOLD,
    label: "Capitalisation threshold",
    description:
      "Below this line value, asset treatment is not the default. The approved requirements name PKR 15,000. 0 disables the threshold entirely.",
    group: "Accounting treatment",
    valueType: "number",
    default: 15000,
  },
  {
    key: CONFIG_KEYS.CAPITALISATION_MODE,
    label: "Below-threshold capitalisation",
    description:
      "HARD_BAR refuses asset treatment below the threshold. DEFAULT_WITH_EXCEPTION makes consumable the default but allows an approved, reasoned override — this is what ships, because the approved requirements say both that nothing below PKR 15,000 should be an asset and that a coffee table below PKR 15,000 may still be a fixed asset, and this is the only reading under which both are true. ADVISORY warns and records without refusing. See BD-002.",
    group: "Accounting treatment",
    valueType: "string",
    default: "DEFAULT_WITH_EXCEPTION",
  },
  {
    key: CONFIG_KEYS.CAPITALISATION_EXEMPT_CATEGORIES,
    label: "Categories that capitalise below the threshold",
    description:
      'Category codes that may be capitalised below the threshold without an override, as JSON: ["FUR","ITE"]. Empty by default — no category is exempt until the business names one.',
    group: "Accounting treatment",
    valueType: "json",
    default: [],
  },

  /* ── Minimum stock ───────────────────────────────────────────────────── */
  {
    key: CONFIG_KEYS.MIN_STOCK_WINDOW_DAYS,
    label: "Consumption window for minimum stock (days)",
    description:
      "How far back the suggested minimum reads the issue history. ZAM/PUR/SOP-01 §3.3 allows a minimum level derived from past consumption; this is the span of past it looks at. Long enough to see a pattern, short enough that last year's usage does not govern this year's shelf.",
    group: "Stores",
    valueType: "number",
    default: 180,
  },
  {
    key: CONFIG_KEYS.MIN_STOCK_LEAD_DAYS,
    label: "Replenishment lead time (days)",
    description:
      "How long a requisition takes to become stock on a shelf. The suggested minimum is this many days of average consumption plus the safety days, so the store does not run out while the order is in flight.",
    group: "Stores",
    valueType: "number",
    default: 14,
  },
  {
    key: CONFIG_KEYS.MIN_STOCK_SAFETY_DAYS,
    label: "Safety cover (days)",
    description:
      "Extra days of consumption held on top of the lead time, for the weeks demand runs above average.",
    group: "Stores",
    valueType: "number",
    default: 7,
  },
  {
    key: CONFIG_KEYS.MIN_STOCK_MIN_MOVEMENTS,
    label: "Issues needed before a minimum is suggested",
    description:
      "Below this many issues in the window, no figure is suggested at all. An item issued once has no consumption pattern, and a suggestion drawn from a single movement would look exactly as authoritative as one drawn from a year of them.",
    group: "Stores",
    valueType: "number",
    default: 3,
  },

  {
    key: CONFIG_KEYS.PO_ACKNOWLEDGEMENT_DAYS,
    label: "Vendor acknowledgement window (days)",
    description:
      "How long a vendor has to acknowledge an issued order before silence is recorded as NO_RESPONSE. Zero switches the window off and orders stay PENDING until somebody records an answer. NO_RESPONSE is deliberately not the same state as PENDING: one is a window still open, the other is a fact about the vendor that belongs in their performance record.",
    group: "Purchase orders",
    valueType: "number",
    default: 3,
  },

  {
    key: CONFIG_KEYS.ENFORCE_PRICE_COMPETITIVENESS,
    label: "Block a recommendation on an incomplete price competitiveness review",
    description:
      "ZAM/PUR/SOP-01's Price Competitiveness Policy sets out nine steps before a buying decision. With this on, a comparative cannot be recommended while an applicable step is unanswered — unless the purchase is classified as an emergency, which relaxes the detailed market analysis and the quotation minimum and nothing else. It ships OFF: the review is a new record and no comparative in flight has one, so enforcing on day one would block every award. Switching it on is the go-live step for this control.",
    group: "Sourcing",
    valueType: "number",
    default: 0,
  },

  {
    key: CONFIG_KEYS.ENFORCE_DISPOSAL_EVIDENCE,
    label: "Block disposal completion on missing Scrap Material Policy evidence",
    description:
      "The SOP's disposal procedure is eight stages, each producing something: an inspection report, photographs, Finance's depreciated and residual values, approval or a business-head consultation, quotes, five named functions present at the sale, and the FAR update. With this on, a case cannot complete while any is missing. It ships OFF because cases already in flight have none of it. The witness requirement is the one that matters most — a sale conducted without the five functions present is the failure the SOP wrote that sentence for.",
    group: "Assets",
    valueType: "boolean",
    default: false,
  },

  {
    key: CONFIG_KEYS.SPLIT_WINDOW_DAYS,
    label: "Order-splitting window (days)",
    description:
      "How close together orders to one vendor have to be before the detector treats them as one pattern. Too long and every regular supplier looks like a split; too short and a genuine split slips between windows.",
    group: "Governance",
    valueType: "number",
    default: 30,
  },
  {
    key: CONFIG_KEYS.SPLIT_MIN_ORDERS,
    label: "Orders needed before a split is flagged",
    description:
      "How many below-threshold orders to one vendor inside the window before a compliance case is raised. Two is the minimum that can be a split at all.",
    group: "Governance",
    valueType: "number",
    default: 2,
  },

  /* ── Inventory costing ───────────────────────────────────────────────── */
  {
    key: CONFIG_KEYS.COSTING_METHOD,
    label: "Inventory costing method",
    description:
      "WEIGHTED_AVERAGE or FIFO — which figure an issue is valued at. Cost layers are maintained either way, so this can be switched without a back-fill and without restating a posted row. It ships WEIGHTED_AVERAGE because that is what every movement in the ledger was posted under; changing it changes what future issues cost, not what past ones did.",
    group: "Stores",
    valueType: "string",
    default: "WEIGHTED_AVERAGE",
  },
  {
    key: CONFIG_KEYS.COST_LAYERS_FROM,
    label: "Cost layers begin (YYYY-MM-DD)",
    description:
      "Receipts from this date open a FIFO cost layer. Blank means layers are off. Stock received before the date has no layer and never will, so the first issues after the cutover will report part of their quantity as uncovered — that is honest, and better than inventing an opening layer at a price nobody paid.",
    group: "Stores",
    valueType: "string",
    default: "",
  },

  /* ── Inventory ageing ─────────────────────────────────────────────────── */
  {
    key: CONFIG_KEYS.AGEING_BANDS,
    label: "Inventory ageing bands",
    description:
      'Bands the ageing report groups by, as JSON: [{"label":"0–30 days","fromDays":0,"toDays":30}]. A null toDays means open-ended. Empty falls back to the shipped six bands.',
    group: "Stores",
    valueType: "json",
    default: [],
  },
  {
    key: CONFIG_KEYS.NEAR_EXPIRY_DAYS,
    label: "Near-expiry window (days)",
    description:
      "Stock expiring within this many days is flagged as near expiry. Distinct from ageing: age is how long money has sat on a shelf, expiry is how long the goods remain usable.",
    group: "Stores",
    valueType: "number",
    default: 60,
  },

  {
    key: CONFIG_KEYS.ENFORCE_PAYMENT_PACK,
    label: "Block finance handoff on a short document pack",
    description:
      "ZAM/PUR/SOP-01 §3.4 requires the Annexure A documents before an invoice goes to finance. With this on, a handoff is refused while a required document is neither attached, marked not-applicable with a note, nor released by an authorised exception. It ships OFF: the requirements are seeded and the checklist is visible, but no invoice in the system has documents attached yet, so turning it on before the back-log is dealt with would stop every payment. Switching it on is the go-live step for this control.",
    group: "Finance",
    valueType: "boolean",
    default: false,
  },
];

const DEFAULTS = new Map(CONFIG_DEFS.map((d) => [d.key, d.default]));

export function configDefault(key: string): unknown {
  return DEFAULTS.get(key);
}

function parseValue(raw: string, valueType: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    if (valueType === "number") return Number(raw);
    if (valueType === "boolean") return raw === "true";
    return raw;
  }
}

/**
 * Resolves a configuration value: entity override → global → seeded default.
 */
export async function getConfig<T = unknown>(
  key: string,
  entityId?: string | null,
  db: DbClient = prisma,
): Promise<T> {
  const rows = await db.configSetting.findMany({
    where: { key, OR: [{ entityId: entityId ?? undefined }, { entityId: null }] },
  });
  const entityRow = entityId ? rows.find((r) => r.entityId === entityId) : undefined;
  const globalRow = rows.find((r) => r.entityId === null);
  const row = entityRow ?? globalRow;
  if (!row) return DEFAULTS.get(key) as T;
  return parseValue(row.value, row.valueType) as T;
}

export async function getConfigNumber(key: string, entityId?: string | null, db: DbClient = prisma) {
  const v = await getConfig<number>(key, entityId, db);
  const n = Number(v);
  return Number.isFinite(n) ? n : (DEFAULTS.get(key) as number);
}

export async function getConfigBool(key: string, entityId?: string | null, db: DbClient = prisma) {
  const v = await getConfig<boolean>(key, entityId, db);
  return v === true || String(v) === "true";
}

export async function getConfigArray<T = string>(
  key: string,
  entityId?: string | null,
  db: DbClient = prisma,
): Promise<T[]> {
  const v = await getConfig<T[]>(key, entityId, db);
  return Array.isArray(v) ? v : [];
}

/** Bulk-resolve for screens that need many values at once. */
export async function getConfigBundle(
  keys: string[],
  entityId?: string | null,
  db: DbClient = prisma,
): Promise<Record<string, unknown>> {
  const rows = await db.configSetting.findMany({
    where: { key: { in: keys }, OR: [{ entityId: entityId ?? undefined }, { entityId: null }] },
  });
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = DEFAULTS.get(k);
  for (const r of rows.filter((r) => r.entityId === null)) out[r.key] = parseValue(r.value, r.valueType);
  if (entityId) {
    for (const r of rows.filter((r) => r.entityId === entityId)) out[r.key] = parseValue(r.value, r.valueType);
  }
  return out;
}

/**
 * Modules that memoise a setting register here, so a change takes effect at once
 * rather than when their cache happens to expire.
 *
 * A callback rather than an import, because the memoising module already imports
 * this one and a cycle between configuration and the things configured by it is
 * how a build starts returning `undefined` for constants.
 */
const invalidators: Array<() => void> = [];

export function registerConfigInvalidator(fn: () => void) {
  invalidators.push(fn);
}

export async function setConfig(
  key: string,
  value: unknown,
  entityId: string | null,
  updatedBy: string,
  db: DbClient = prisma,
) {
  const def = CONFIG_DEFS.find((d) => d.key === key);
  const valueType = def?.valueType ?? "string";
  const serialized = JSON.stringify(value);
  const existing = await db.configSetting.findFirst({ where: { key, entityId } });

  const row = existing
    ? await db.configSetting.update({
        where: { id: existing.id },
        data: { value: serialized, valueType, updatedBy },
      })
    : await db.configSetting.create({
        data: {
          key,
          value: serialized,
          valueType,
          label: def?.label ?? key,
          description: def?.description ?? null,
          group: def?.group ?? "General",
          entityId,
          updatedBy,
        },
      });

  // After the write, not before. Clearing first leaves a window in which another
  // request repopulates the memo from the value this call is about to replace,
  // which is the one outcome the invalidation exists to prevent.
  for (const fn of invalidators) fn();
  return row;
}
