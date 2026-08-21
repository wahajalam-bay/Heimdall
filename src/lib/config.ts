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
  { key: CONFIG_KEYS.DEFAULT_TAX_RATE, label: "Default sales tax %", description: "Applied to new quotation and PO lines.", group: "Finance", valueType: "number", default: 18 },
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
  if (existing) {
    return db.configSetting.update({
      where: { id: existing.id },
      data: { value: serialized, valueType, updatedBy },
    });
  }
  return db.configSetting.create({
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
}
