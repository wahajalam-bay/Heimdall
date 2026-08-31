import { prisma, type DbClient } from "./db";
import { CONFIG_KEYS, getConfig, getConfigArray, getConfigBool, getConfigNumber } from "./config";
import { ENTITY_CODES } from "./domain";

/**
 * The Policy Pack.
 *
 * **Scope: Zameen Media (ZAM/PUR/SOP-01).** ZD/PRO/SOP-01 is reference material
 * for future expansion, not a source of Zameen Media rules. Where a value below
 * differs by entity, the *shipped default* is always the Zameen Media reading —
 * a ZD figure must never become the fallback ZAM inherits when no override is
 * set. ZD values are held as entity overrides on the ZD entity only.
 *
 * The two SOPs disagree with each other, and in six places a document disagrees
 * with its own annexure. Nothing here reconciles those disagreements by picking
 * a winner in code. Instead every contested value becomes a policy setting with:
 *
 *   · the **variants** the sources actually state, named and cited;
 *   · a **per-entity default** taken from the SOP that governs that entity —
 *     which is what "as per policy" means when the two entities have different
 *     policies;
 *   · a `confirm` flag where the value came from a document contradicting
 *     itself, so a screen can show what is running on an unconfirmed reading.
 *
 * Per-entity resolution needs no new table: `ConfigSetting` already carries an
 * optional `entityId`, and `getConfig` resolves entity override → global →
 * seeded default. So a ZAM value and a ZD value for the same key coexist, and
 * every read is entity-scoped by construction.
 *
 * Where a rule differs by entity because each SOP is explicit for its own
 * entity (PC-001, PC-007, PC-019, PC-021), there is no conflict to resolve —
 * both are implemented, and the only reason they looked like a conflict is that
 * the system used to hold one global value.
 */

/* ── Keys ────────────────────────────────────────────────────────────────── */

/**
 * Storage keys. These are the same rows `CONFIG_KEYS` declares, aliased here so
 * that policy code reads in policy terms and there is still exactly one key per
 * setting — a second, parallel key set is how a policy pack quietly stops
 * governing anything.
 */
export const POLICY_KEYS = {
  /** PC-001 · ZAM 3 months, ZD 12 months. Both explicit; both seeded. */
  VENDOR_EVALUATION_INTERVAL_MONTHS: CONFIG_KEYS.POLICY_VENDOR_EVALUATION_INTERVAL_MONTHS,
  /** PC-002 · which performance instrument is authoritative. */
  VENDOR_PERFORMANCE_INSTRUMENT: CONFIG_KEYS.POLICY_VENDOR_PERFORMANCE_INSTRUMENT,
  /** PC-003 · which rating scale that instrument uses. */
  VENDOR_RATING_SCALE: CONFIG_KEYS.POLICY_VENDOR_RATING_SCALE,
  /** PC-004 · how the quality criterion is scored. */
  VENDOR_QUALITY_SCORING: CONFIG_KEYS.POLICY_VENDOR_QUALITY_SCORING,
  /** PC-005 · internal reference marks. */
  VENDOR_INTERNAL_REFERENCE_SCALE: CONFIG_KEYS.POLICY_VENDOR_INTERNAL_REFERENCE_SCALE,
  /** PC-006 · the pre-qualification maximum and qualifying score. */
  VENDOR_PQ_MAX_SCORE: CONFIG_KEYS.POLICY_VENDOR_PQ_MAX_SCORE,
  VENDOR_PQ_MIN_SCORE: CONFIG_KEYS.POLICY_VENDOR_PQ_MIN_SCORE,
  /** PC-021 · ZD two years, ZAM silent and therefore inactive. */
  PQ_VALIDITY_MONTHS: CONFIG_KEYS.POLICY_PQ_VALIDITY_MONTHS,
  /** PC-018 · what to do with a vendor that has no performance rating yet. */
  UNRATED_VENDOR_TREATMENT: CONFIG_KEYS.POLICY_UNRATED_VENDOR_TREATMENT,
  /** PC-020 · blocking, ZD only until ZAM adopts it. */
  BLOCKING_ENABLED: CONFIG_KEYS.POLICY_BLOCKING_ENABLED,
  /** PC-007 · ZAM Wednesday, ZD Thursday. */
  CPC_MEETING_WEEKDAY: CONFIG_KEYS.POLICY_CPC_MEETING_WEEKDAY,
  /** PC-009 · how quorum counts, and whether the third member type binds it. */
  COMMITTEE_QUORUM_PERMANENT_MIN: CONFIG_KEYS.POLICY_COMMITTEE_QUORUM_PERMANENT_MIN,
  COMMITTEE_QUORUM_REQUIRES_MANDATORY: CONFIG_KEYS.POLICY_COMMITTEE_QUORUM_REQUIRES_MANDATORY,
  COMMITTEE_OBSERVERS_COUNT: CONFIG_KEYS.POLICY_COMMITTEE_OBSERVERS_COUNT,
  /** PC-024 · per-region quorum; North and South unset by design. */
  RNC_QUORUM_BY_REGION: CONFIG_KEYS.POLICY_RNC_QUORUM_BY_REGION,
  /** PC-022 · committee threshold per transaction type. */
  CPC_THRESHOLDS_BY_TYPE: CONFIG_KEYS.POLICY_CPC_THRESHOLDS_BY_TYPE,
  /** PC-023 · the CEO value tier, and the undefined classification trigger. */
  CEO_APPROVAL_THRESHOLD: CONFIG_KEYS.POLICY_CEO_APPROVAL_THRESHOLD,
  EXCEPTIONAL_PURCHASE_DEFINED: CONFIG_KEYS.POLICY_EXCEPTIONAL_PURCHASE_DEFINED,
  /** PC-010 · which payment chain governs. */
  PAYMENT_ROUTE: CONFIG_KEYS.POLICY_PAYMENT_ROUTE,
  /** PC-011 · which Cost Analysis layout governs. */
  COST_ANALYSIS_FORM_VERSION: CONFIG_KEYS.POLICY_COST_ANALYSIS_FORM_VERSION,
  /** PC-012 · effective-dated tax rates. Empty by default; no silent fallback. */
  TAX_RATES: CONFIG_KEYS.POLICY_TAX_RATES,
  /** PC-016 · per-entity petty cash approval route. */
  PETTY_CASH_ROUTE: CONFIG_KEYS.POLICY_PETTY_CASH_ROUTE,
  /** PC-017 · the recurring market check, separate from the per-PR rule. */
  PRICE_REVIEW_INTERVAL_MONTHS: CONFIG_KEYS.POLICY_PRICE_REVIEW_INTERVAL_MONTHS,
  PRICE_REVIEW_QUOTES: CONFIG_KEYS.POLICY_PRICE_REVIEW_QUOTES,
  /** PC-014 · which system is the book of record, per document type. */
  SYSTEM_OF_RECORD: CONFIG_KEYS.POLICY_SYSTEM_OF_RECORD,
  /** PC-025 · whether the printed form pairs qualitative with technical. */
  INSPECTION_FORM_PAIRS_QUAL_TECH: CONFIG_KEYS.POLICY_INSPECTION_FORM_PAIRS_QUAL_TECH,
  /** PC-026 · who owns each monthly repeat requisition. */
  MONTHLY_REQUISITION_OWNERS: CONFIG_KEYS.POLICY_MONTHLY_REQUISITION_OWNERS,
  /** PC-027 · what happens when no approver can be identified. */
  NO_APPROVER_BEHAVIOUR: CONFIG_KEYS.POLICY_NO_APPROVER_BEHAVIOUR,
} as const;

/* ── Variants ────────────────────────────────────────────────────────────── */

/**
 * A contested setting: the readings the sources support, which one each entity
 * runs on, and why. `confirm: true` marks a value taken from a document that
 * contradicts itself — running, but on a reading nobody has signed off.
 */
export type PolicyVariant = {
  code: string;
  label: string;
  /** Verbatim or near-verbatim source, so a reader can check the reading. */
  source: string;
};

export type PolicyChoice = {
  key: string;
  conflict: string;
  question: string;
  variants: PolicyVariant[];
  /** Per-entity default, by entity code. */
  defaults: Record<string, string>;
  /** True when the default rests on an unconfirmed reading of a contradiction. */
  confirm: boolean;
  /** Why this default, in one sentence a non-engineer can check. */
  rationale: string;
};

export const POLICY_CHOICES: readonly PolicyChoice[] = [
  {
    key: POLICY_KEYS.VENDOR_PERFORMANCE_INSTRUMENT,
    conflict: "PC-002",
    question: "Which vendor performance instrument is authoritative?",
    variants: [
      {
        code: "PERF-6CRIT-TEXT",
        label: "6 criteria — 40/20/20/10/5/5",
        source:
          "Narrative table §5.9: Quality 40% · Delivery Lead Time 20% · Price Competitiveness 20% · Order Fulfillment 10% · After Sales Service 5% · Credit Offered 5%",
      },
      {
        code: "PERF-5CRIT-ANNEX",
        label: "5 criteria — 40/20/30/5/5",
        source:
          "image11.png 'Vendor Evaluation Criterion Weighted Average': Quality 40% · Delivery Lead Time 20% · Competitiveness of Price 30% · Technical Support Staff's Expertise 5% · After Sale Services 5%",
      },
    ],
    defaults: { [ENTITY_CODES.ZM]: "PERF-5CRIT-ANNEX", [ENTITY_CODES.ZD]: "PERF-5CRIT-ANNEX" },
    confirm: true,
    rationale:
      "The annexure is the sheet an evaluator actually fills in, so it is the instrument in use; the narrative table describes it. Both are seeded and either can be selected.",
  },
  {
    key: POLICY_KEYS.VENDOR_RATING_SCALE,
    conflict: "PC-003",
    question: "Which rating scale does the performance instrument use?",
    variants: [
      {
        code: "SCALE-4BAND",
        label: "4 bands — Unsatisfactory scores 0",
        source:
          "Narrative table 'Scoring Criteria for Evaluating Vendor's Performance': Unsatisfactory 0 · Development Needed 1 · Satisfactory 3 · Exceptional 5",
      },
      {
        code: "SCALE-5BAND",
        label: "5 bands — Unsatisfactory scores 1",
        source:
          "image13.png: Unsatisfactory 1 · Development Needed 2 · Satisfactory 3 · Above Expectations 4 · Exceptional 5",
      },
    ],
    defaults: { [ENTITY_CODES.ZM]: "SCALE-5BAND", [ENTITY_CODES.ZD]: "SCALE-5BAND" },
    confirm: true,
    rationale:
      "Paired with the annexure instrument above, since the 5-band scale is the one printed on it. Selecting the 6-criteria instrument should normally also select the 4-band scale.",
  },
  {
    key: POLICY_KEYS.VENDOR_QUALITY_SCORING,
    conflict: "PC-004",
    question: "How is the quality criterion scored?",
    variants: [
      {
        code: "QUALITY-BY-COMPLAINTS",
        label: "By complaint count",
        source: "Narrative table: 0–1 complaint = 40 · 2–3 = 30 · 4–5 = 20 · 6–7 = 10 · 7–10 = 0",
      },
      {
        code: "QUALITY-BY-ACCEPTED-PCT",
        label: "By accepted quantity percentage",
        source:
          "image12.png: ≥95% = 5 · ≥90% = 4 · 70–80% = 3 · below 50–70% = 2 · below 50% = 1. NOTE: 80–90% is unscored on the form.",
      },
    ],
    defaults: { [ENTITY_CODES.ZM]: "QUALITY-BY-COMPLAINTS", [ENTITY_CODES.ZD]: "QUALITY-BY-COMPLAINTS" },
    confirm: true,
    rationale:
      "The accepted-quantity method leaves 80–90% with no band at all, so it cannot be used until management closes that gap. The complaint method is complete and is therefore the default until then.",
  },
  {
    key: POLICY_KEYS.VENDOR_INTERNAL_REFERENCE_SCALE,
    conflict: "PC-005",
    question: "What marks does an internal reference carry?",
    variants: [
      {
        code: "IREF-3-4-5",
        label: "Manager 3 · Senior Manager 4 · Director+ 5",
        source: "image10.png 'Scoring Criteria for Internal Reference'; §5.8 says points are awarded out of five",
      },
      {
        code: "IREF-1-2-4",
        label: "Manager 1 · Senior Manager 2 · Director+ 4",
        source: "image20.png Annexure 6 Vendor Selection Form, section headed 'Marks (4)'",
      },
    ],
    defaults: { [ENTITY_CODES.ZM]: "IREF-1-2-4", [ENTITY_CODES.ZD]: "IREF-1-2-4" },
    confirm: true,
    rationale:
      "Annexure 6 is the form being completed and its section maximum of 4 is consistent with its own values; the image10 scale maxes at 5 and would break the form's arithmetic.",
  },
  {
    key: POLICY_KEYS.VENDOR_PQ_MAX_SCORE,
    conflict: "PC-006",
    question: "What is the pre-qualification maximum — the printed 60, or the sections' 61?",
    variants: [
      {
        code: "PQ-MAX-60",
        label: "60 — as printed in the header",
        source: "image20.png Annexure 6 header: 'Min. Qualifying Score: 30/60'",
      },
      {
        code: "PQ-MAX-61",
        label: "61 — the sum of the printed section maxima",
        source: "Tax status 10 + Company History 10 + Key Client Reference 12 + Payment Mode 10 + Company Registration 5 + Company Setup 10 + Internal Reference 4 = 61",
      },
    ],
    defaults: { [ENTITY_CODES.ZM]: "PQ-MAX-61", [ENTITY_CODES.ZD]: "PQ-MAX-61" },
    confirm: true,
    rationale:
      "The section maxima are what an evaluator adds up, so a sheet scored against them totals 61. Keeping 60 would mean a vendor could score 61 out of 60. The qualifying threshold stays at the printed 30 either way.",
  },
  {
    key: POLICY_KEYS.PAYMENT_ROUTE,
    conflict: "PC-010",
    question: "Which payment chain governs?",
    variants: [
      {
        code: "PAY-ZAM-ANNEXA",
        label: "ZAM Annexure A — 2 audit checkpoints, cheque collection Tue & Fri",
        source:
          "image14.PNG: Invoice → Procurement compiles → KPMG calculates taxes → Audit crosscheck → Accounts books A/P → Finance prepares cheque → Audit crosscheck → Finance signs & informs Procurement → vendor collects (Tue & Fri)",
      },
      {
        code: "PAY-ZD-JEFFI",
        label: "ZD — PV + JEFFI, single IA checkpoint with resubmission loop",
        source:
          "image14.png: Invoice (Performa or Final) → Procurement compiles, makes PV, enters JEFFI → Finance → KPMG tax working → cheque prep / portal upload → IA compliance → approved for signatories or rejected for correction → Finance signs & informs SC",
      },
    ],
    defaults: { [ENTITY_CODES.ZM]: "PAY-ZAM-ANNEXA", [ENTITY_CODES.ZD]: "PAY-ZD-JEFFI" },
    confirm: false,
    rationale:
      "Not a contradiction: each entity's own flow diagram governs that entity. Both are implemented.",
  },
  {
    key: POLICY_KEYS.COST_ANALYSIS_FORM_VERSION,
    conflict: "PC-011",
    question: "Which Cost Analysis layout governs?",
    variants: [
      {
        code: "CA-ANNEX3",
        label: "Annexure 3 — 3 vendor columns, no computed tax",
        source:
          "image16.png 'Cost Analysis Summary': 3 vendor columns (Option A/B/C), 3 line rows, per vendor Rate · Qty/Unit · Total. No subtotal, no tax line, no net total. Terms: Delivery Time Period · Payment Terms · Quotation Validity · GST/Tax · After Sale Services/Warranties · Other Pertinent Details",
      },
      {
        code: "CA-XLSX-5COL",
        label: "Supplied spreadsheet — 5 vendor columns, computed tax and net total",
        source: "CS SAMPLE (2).xlsx: 5 vendor columns, 5 line rows, Tax @ 16% and Net Total rows",
      },
    ],
    defaults: { [ENTITY_CODES.ZM]: "CA-ANNEX3", [ENTITY_CODES.ZD]: "CA-ANNEX3" },
    confirm: true,
    rationale:
      "The SOP annexure is the policy instrument; the spreadsheet carries no entity marking and no policy reference. Both layouts are available, and the spreadsheet version keeps the computed rows for whoever needs them.",
  },
  {
    key: POLICY_KEYS.CPC_THRESHOLDS_BY_TYPE,
    conflict: "PC-022",
    question: "Does the PKR 500,000 committee threshold apply to goods only, or to every transaction?",
    variants: [
      {
        code: "CPC-GOODS-ONLY",
        label: "Engagement limit reading — 500,000 for goods, services always reviewed",
        source: "CPC 'Engagement Limit: Procurement of Goods — Greater than or Equal to PKR 500,000'",
      },
      {
        code: "CPC-ALL-TYPES",
        label: "Mandate reading — 500,000 for every transaction type",
        source:
          "CPC 'Mandate: Any transaction including but not limited to SLA · Service Contracts · AMC · Buildouts · Onetime Purchases · Exceptional Purchases'",
      },
    ],
    defaults: { [ENTITY_CODES.ZM]: "CPC-ALL-TYPES", [ENTITY_CODES.ZD]: "CPC-ALL-TYPES" },
    confirm: true,
    rationale:
      "The mandate reading is the wider of the two, so it refers more cases to the committee rather than fewer. Choosing the narrower reading by default would route service contracts and AMCs around a committee whose own mandate names them.",
  },
  {
    key: POLICY_KEYS.UNRATED_VENDOR_TREATMENT,
    conflict: "PC-018",
    question: "A vendor has no performance rating yet. May business be transacted?",
    variants: [
      { code: "UNRATED-ALLOW", label: "Allow", source: "No source. The SOPs are silent." },
      {
        code: "UNRATED-ALLOW-WITH-EXCEPTION",
        label: "Allow, and raise an exception case",
        source: "No source. Preserves throughput while making the gap visible.",
      },
      {
        code: "UNRATED-BLOCK",
        label: "Block",
        source: 'ZD §2.3.3 ii read strictly: "No business shall be transacted with vendors not having satisfactory performance rating"',
      },
    ],
    defaults: {
      [ENTITY_CODES.ZM]: "UNRATED-ALLOW-WITH-EXCEPTION",
      [ENTITY_CODES.ZD]: "UNRATED-ALLOW-WITH-EXCEPTION",
    },
    confirm: true,
    rationale:
      "Blocking would stop every newly approved vendor from trading until their first evaluation, which no passage asks for. Allowing silently hides the gap. The middle option is the only one that neither invents a bar nor conceals the absence.",
  },
  {
    key: POLICY_KEYS.NO_APPROVER_BEHAVIOUR,
    conflict: "PC-027",
    question: "No approver matches a submitted requisition. What happens?",
    variants: [
      {
        code: "NOAPPR-AUTO-APPROVE",
        label: "Approve it (current behaviour)",
        source: "No source. This is what the system does today.",
      },
      {
        code: "NOAPPR-ESCALATE",
        label: "Escalate up the organogram to the first holder of pr.approve",
        source: "No source, but uses the reporting lines loaded from the supplied organograms.",
      },
      {
        code: "NOAPPR-REFUSE",
        label: "Refuse the submission and name the missing rule",
        source: "No source. Safest; blocks work whenever an approval matrix has a gap.",
      },
    ],
    defaults: { [ENTITY_CODES.ZM]: "NOAPPR-ESCALATE", [ENTITY_CODES.ZD]: "NOAPPR-ESCALATE" },
    confirm: true,
    rationale:
      "Escalation turns a silent auto-approval into a real approval by a real person, using reporting lines that already exist for all 24 loaded staff. It falls back to refusal when the chain runs out.",
  },
];

export const POLICY_CHOICE_BY_KEY = new Map(POLICY_CHOICES.map((c) => [c.key, c]));

/* ── Resolvers ───────────────────────────────────────────────────────────── */

/** The selected variant code for a contested setting, for one entity. */
export async function policyVariant(
  key: string,
  entityId: string | null,
  db: DbClient = prisma,
): Promise<string> {
  return String(await getConfig<string>(key, entityId, db));
}

export type ResolvedPolicy = {
  choice: PolicyChoice;
  selected: string;
  variant: PolicyVariant | null;
  /** True when the running value is still the unconfirmed default. */
  awaitingConfirmation: boolean;
};

/**
 * Every contested setting with its running value, for one entity. This is what
 * the policy screen renders, and what the final compliance report reads: a
 * question nobody has answered is visible rather than buried in a default.
 */
export async function resolvedPolicies(
  entityId: string | null,
  db: DbClient = prisma,
): Promise<ResolvedPolicy[]> {
  const out: ResolvedPolicy[] = [];
  for (const choice of POLICY_CHOICES) {
    const selected = await policyVariant(choice.key, entityId, db);
    const explicit = await db.configSetting.findFirst({
      where: { key: choice.key, entityId: entityId ?? undefined },
      select: { id: true },
    });
    out.push({
      choice,
      selected,
      variant: choice.variants.find((v) => v.code === selected) ?? null,
      awaitingConfirmation: choice.confirm && !explicit,
    });
  }
  return out;
}

/* ── Instruments ─────────────────────────────────────────────────────────── */

export type PerformanceCriterion = { code: string; name: string; weightPercent: number };

/** PC-002. Both instruments, verbatim from their sources. */
export const PERFORMANCE_INSTRUMENTS: Record<string, PerformanceCriterion[]> = {
  "PERF-6CRIT-TEXT": [
    { code: "QUALITY", name: "Quality of Product / Service", weightPercent: 40 },
    { code: "DELIVERY", name: "Delivery Lead Time", weightPercent: 20 },
    { code: "PRICE", name: "Price Competitiveness", weightPercent: 20 },
    { code: "FULFILMENT", name: "Order Fulfillment", weightPercent: 10 },
    { code: "AFTER_SALES", name: "After Sales Service", weightPercent: 5 },
    { code: "CREDIT", name: "Credit Offered", weightPercent: 5 },
  ],
  "PERF-5CRIT-ANNEX": [
    { code: "QUALITY", name: "Quality of Parts / Products / Materials", weightPercent: 40 },
    { code: "DELIVERY", name: "Delivery Lead Time", weightPercent: 20 },
    { code: "PRICE", name: "Competitiveness of Price", weightPercent: 30 },
    { code: "TECH_SUPPORT", name: "Technical Support Staff's Expertise", weightPercent: 5 },
    { code: "AFTER_SALES", name: "After Sale Services", weightPercent: 5 },
  ],
};

export type RatingBand = { label: string; score: number };

/** PC-003. */
export const RATING_SCALES: Record<string, RatingBand[]> = {
  "SCALE-4BAND": [
    { label: "Unsatisfactory", score: 0 },
    { label: "Development Needed", score: 1 },
    { label: "Satisfactory", score: 3 },
    { label: "Exceptional", score: 5 },
  ],
  "SCALE-5BAND": [
    { label: "Unsatisfactory", score: 1 },
    { label: "Development Needed", score: 2 },
    { label: "Satisfactory", score: 3 },
    { label: "Above Expectations", score: 4 },
    { label: "Exceptional", score: 5 },
  ],
};

/**
 * PC-004. Quality bands.
 *
 * The accepted-quantity variant reproduces the form exactly, **including the
 * gap**: nothing on `image12.png` covers 80–90%. `qualityScore` returns null
 * there rather than inventing a band, and the caller must surface that as an
 * unscored criterion.
 */
export type QualityBand = { from: number; to: number; score: number };

export const QUALITY_METHODS: Record<
  string,
  { basis: "COMPLAINTS" | "ACCEPTED_PERCENT"; bands: QualityBand[]; gaps: string[] }
> = {
  "QUALITY-BY-COMPLAINTS": {
    basis: "COMPLAINTS",
    bands: [
      { from: 0, to: 1, score: 40 },
      { from: 2, to: 3, score: 30 },
      { from: 4, to: 5, score: 20 },
      { from: 6, to: 7, score: 10 },
      { from: 8, to: 10, score: 0 },
    ],
    gaps: [],
  },
  "QUALITY-BY-ACCEPTED-PCT": {
    basis: "ACCEPTED_PERCENT",
    bands: [
      { from: 95, to: 100, score: 5 },
      { from: 90, to: 95, score: 4 },
      { from: 70, to: 80, score: 3 },
      { from: 50, to: 70, score: 2 },
      { from: 0, to: 50, score: 1 },
    ],
    gaps: ["80–90% carries no band on Annexure image12.png and cannot be scored."],
  },
};

/** Returns null when the value falls in a gap the source leaves unscored. */
export function qualityScore(method: string, value: number): number | null {
  const m = QUALITY_METHODS[method];
  if (!m) return null;
  for (const b of m.bands) {
    if (m.basis === "COMPLAINTS" ? value >= b.from && value <= b.to : value >= b.from && value < b.to) {
      return b.score;
    }
  }
  // Top of an ACCEPTED_PERCENT range is inclusive at 100.
  if (m.basis === "ACCEPTED_PERCENT" && value >= 100) return m.bands[0].score;
  return null;
}

/** PC-005. */
export const INTERNAL_REFERENCE_SCALES: Record<string, Record<string, number>> = {
  "IREF-3-4-5": { MANAGER: 3, SENIOR_MANAGER: 4, DIRECTOR_OR_ABOVE: 5 },
  "IREF-1-2-4": { MANAGER: 1, SENIOR_MANAGER: 2, DIRECTOR_OR_ABOVE: 4 },
};

/** PC-006. The form's own sections, with the printed maxima. */
export const PQ_SECTIONS = [
  { code: "TAX_STATUS", name: "Tax status", max: 10 },
  { code: "COMPANY_HISTORY", name: "Company History", max: 10 },
  { code: "CLIENT_REFERENCE", name: "Key Client Reference Check", max: 12 },
  { code: "PAYMENT_MODE", name: "Payment Mode", max: 10 },
  { code: "COMPANY_REGISTRATION", name: "Company Registration", max: 5 },
  { code: "COMPANY_SETUP", name: "Company Setup", max: 10 },
  { code: "INTERNAL_REFERENCE", name: "Internal Reference", max: 4 },
] as const;

export const PQ_SECTION_TOTAL = PQ_SECTIONS.reduce((a, s) => a + s.max, 0); // 61

/* ── Payment routes ──────────────────────────────────────────────────────── */

export type PaymentStep = {
  seq: number;
  actor: string;
  action: string;
  /** True for a checkpoint that can send the pack back rather than onward. */
  canReject?: boolean;
  /** Named external party, where the source names one. */
  external?: string;
};

/** PC-010. Both chains, step for step as drawn. */
export const PAYMENT_ROUTES: Record<
  string,
  { label: string; documents: Array<{ name: string; conditional: boolean }>; steps: PaymentStep[]; collectionDays: number[] }
> = {
  "PAY-ZAM-ANNEXA": {
    label: "ZAM Annexure A — Payment Process Flow",
    documents: [
      { name: "PR", conditional: false },
      { name: "PO", conditional: false },
      { name: "GRN", conditional: false },
      { name: "Invoice", conditional: false },
      { name: "Undertaking", conditional: true },
      { name: "GD", conditional: true },
      { name: "Exemptions", conditional: true },
    ],
    steps: [
      { seq: 1, actor: "Procurement", action: "Invoice received and pack compiled" },
      { seq: 2, actor: "External adviser", action: "Applicable taxes calculated", external: "KPMG" },
      { seq: 3, actor: "Internal Audit", action: "Crosscheck", canReject: true },
      { seq: 4, actor: "Accounts", action: "Booked to accounts payable" },
      { seq: 5, actor: "Finance", action: "Cheque prepared" },
      { seq: 6, actor: "Internal Audit", action: "Crosscheck complete processing", canReject: true },
      { seq: 7, actor: "Finance", action: "Cheque signed; Procurement informed" },
      { seq: 8, actor: "Procurement", action: "Vendor informed for collection" },
    ],
    // Tuesday and Friday.
    collectionDays: [2, 5],
  },
  "PAY-ZD-JEFFI": {
    label: "ZD — Process Flow for Payment Processing",
    documents: [
      { name: "Payment Voucher", conditional: false },
      { name: "PR", conditional: false },
      { name: "PO", conditional: false },
      { name: "MIR", conditional: false },
      { name: "GRN", conditional: false },
      { name: "Invoice", conditional: false },
      { name: "CPC Approval", conditional: false },
      { name: "Undertaking (GD)", conditional: true },
      { name: "Tax Exemption Certificate", conditional: true },
    ],
    steps: [
      { seq: 1, actor: "Procurement", action: "Invoice received (performa or final); pack compiled, PV made, JEFFI entered, scan kept" },
      { seq: 2, actor: "Procurement", action: "JEFFI and originals transferred to Finance" },
      { seq: 3, actor: "Finance", action: "JEFFI transferred for tax working", external: "KPMG" },
      { seq: 4, actor: "Finance", action: "Cheque prepared; portal uploading" },
      { seq: 5, actor: "Internal Audit", action: "Compliance review", canReject: true },
      { seq: 6, actor: "Finance", action: "Cheque signed; Supply Chain informed for vendor intimation" },
    ],
    // The ZD flow states no collection-day restriction.
    collectionDays: [],
  },
};

/* ── Cost Analysis form versions ─────────────────────────────────────────── */

export type CostAnalysisLayout = {
  label: string;
  vendorColumns: number;
  lineRows: number;
  computesTax: boolean;
  termsRows: string[];
};

/** PC-011. */
export const COST_ANALYSIS_LAYOUTS: Record<string, CostAnalysisLayout> = {
  "CA-ANNEX3": {
    label: "Annexure 3 · Cost Analysis Summary",
    vendorColumns: 3,
    lineRows: 3,
    computesTax: false,
    termsRows: [
      "Delivery Time Period",
      "Payment Terms",
      "Quotation Validity",
      "GST / Tax",
      "After Sale Services / Warranties",
      "Other Pertinent Details",
    ],
  },
  "CA-XLSX-5COL": {
    label: "Supplied spreadsheet layout",
    vendorColumns: 5,
    lineRows: 5,
    computesTax: true,
    termsRows: ["Payment Terms", "Specifications", "Delivery Commitment", "Tax Information"],
  },
};

/** PC-011. The bounded reasons for recommending above the lowest quotation. */
export const HIGHER_RATE_REASONS = [
  { code: "QUALITY", label: "Superior quality or specification match" },
  { code: "DELIVERY", label: "Shorter or more reliable delivery" },
  { code: "WARRANTY", label: "Better warranty or after-sale support" },
  { code: "PAST_PERFORMANCE", label: "Demonstrated past performance" },
  { code: "PAYMENT_TERMS", label: "More favourable payment terms" },
  { code: "SOLE_COMPLIANT", label: "Only technically compliant offer" },
  { code: "OTHERS", label: "Others — state the reason" },
] as const;

/* ── Tax ─────────────────────────────────────────────────────────────────── */

export type TaxRate = { code: string; label: string; percent: number; effectiveFrom: string };

/**
 * PC-012. Effective-dated, per entity, and **empty by default**.
 *
 * Neither SOP states a percentage — §4.8 defers to the Income Tax Ordinance and
 * both payment flows route the computation to KPMG. So there is no rate to seed,
 * and a form must show tax as unset rather than print a number nobody authorised.
 * `finance.default_tax_rate_percent = 18` and the Cost Analysis Form's 16 were
 * both invented; neither is used once a policy pack is in force.
 */
export async function taxRates(
  entityId: string | null,
  db: DbClient = prisma,
  on: Date = new Date(),
): Promise<TaxRate[]> {
  const all = await getConfigArray<TaxRate>(POLICY_KEYS.TAX_RATES, entityId, db);
  return all
    .filter((r) => r && typeof r.percent === "number" && new Date(r.effectiveFrom) <= on)
    .sort((a, b) => +new Date(b.effectiveFrom) - +new Date(a.effectiveFrom));
}

/** The rate in force, or null when none is configured. Never a fallback. */
export async function effectiveTaxRate(
  entityId: string | null,
  code = "GST",
  db: DbClient = prisma,
  on: Date = new Date(),
): Promise<TaxRate | null> {
  const rates = await taxRates(entityId, db, on);
  return rates.find((r) => r.code === code) ?? null;
}

/* ── Committees ──────────────────────────────────────────────────────────── */

/** PC-009. */
export const COMMITTEE_MEMBER_TYPES = [
  { code: "PERMANENT_MANDATORY", label: "Permanent Mandatory Member", counts: true, votes: true },
  { code: "PERMANENT", label: "Permanent Member", counts: true, votes: true },
  { code: "OBSERVER", label: "Observer", counts: false, votes: false },
] as const;

export type CommitteeMemberType = (typeof COMMITTEE_MEMBER_TYPES)[number]["code"];

export type QuorumRule = {
  permanentMinimum: number;
  requiresAllMandatory: boolean;
  observersCount: boolean;
  /** Whether the requisitioner department's head or a named proxy must present. */
  requiresPresenter: boolean;
};

export async function quorumRule(
  entityId: string | null,
  db: DbClient = prisma,
): Promise<QuorumRule> {
  return {
    permanentMinimum: await getConfigNumber(POLICY_KEYS.COMMITTEE_QUORUM_PERMANENT_MIN, entityId, db),
    requiresAllMandatory: await getConfigBool(POLICY_KEYS.COMMITTEE_QUORUM_REQUIRES_MANDATORY, entityId, db),
    observersCount: await getConfigBool(POLICY_KEYS.COMMITTEE_OBSERVERS_COUNT, entityId, db),
    requiresPresenter: true,
  };
}

/* ── Classification dimensions ───────────────────────────────────────────── */

/**
 * PC-015. Four taxonomies appear across the documents and no mapping between
 * them is supplied. They are held side by side as separate dimensions rather
 * than forced into one hierarchy, because merging them would require inventing
 * the mapping.
 */
export const CLASSIFICATION_DIMENSIONS = {
  SAGE_ITEM_GROUP: {
    label: "Sage item group",
    source: "ZAM image18.png",
    values: [
      "ELT Electronics",
      "HDW Hardware",
      "HKG Housekeeping & Grocery",
      "PNT Printing Material",
      "STA Stationary & Giveaways",
      "ACC Accessories",
      "ITE IT Equipment",
    ],
  },
  STACKING_CATEGORY: {
    label: "Stacking main category",
    source: "ZAM image19.emf Table 1.1",
    values: [
      "Electronics",
      "Hardware",
      "Grocery",
      "Housekeeping",
      "Stationery",
      "Giveaways",
      "IT Equipment",
      "Furniture & Fixture",
      "Branding Material",
      "Printing Material",
    ],
  },
  INSPECTION_CLASS: {
    label: "Inspection class",
    source: "ZAM/ZD Store Process Flow matrix",
    values: [
      "Stationery",
      "Giveaways",
      "Furniture",
      "Housekeeping & Grocery",
      "IT / Network / Mobiles",
      "Electronic Appliances",
      "Printed Collateral",
    ],
  },
  CONSTRUCTION_CLASS: {
    label: "Construction class",
    source: "ZD Annexure B",
    values: ["Civil", "MEP", "Finishing"],
  },
  CONSTRUCTION_FUNCTION: {
    label: "Construction function",
    source: "ZD Annexure B",
    values: ["Functional", "Non-functional"],
  },
} as const;

/* ── Inspection ──────────────────────────────────────────────────────────── */

/** PC-025. Three types from the matrix; the printed form pairs two of them. */
export const INSPECTION_TYPES = [
  { code: "QUANTITATIVE", label: "Quantitative", printedColumn: "QUANTITATIVE" },
  { code: "QUALITATIVE", label: "Qualitative", printedColumn: "QUALITATIVE/TECHNICAL" },
  { code: "TECHNICAL", label: "Technical", printedColumn: "QUALITATIVE/TECHNICAL" },
] as const;

/* ── Grounds ─────────────────────────────────────────────────────────────── */

/** PC-019. Each entity's own list, verbatim. Not merged. */
export const BLACKLIST_GROUNDS: Record<string, Array<{ code: string; label: string }>> = {
  [ENTITY_CODES.ZM]: [
    { code: "FORGED_DOCUMENTS", label: "Submission of forged documents" },
    { code: "QUALITY_COMPROMISE", label: "Consistent compromise on quality" },
    { code: "INVOICE_VARIANCE", label: "Variance in price on invoice and quantity" },
    { code: "LATE_DELIVERY", label: "Consistent partial or late deliveries" },
    { code: "OTHER", label: "Other reasons" },
  ],
  [ENTITY_CODES.ZD]: [
    { code: "CONVICTION", label: "Conviction of fraud, corruption, misappropriation, theft, forgery or bribery" },
    { code: "CORRUPT_PRACTICES", label: "Corrupt practices in obtaining a contract" },
    { code: "TAX_EVASION", label: "Court or tribunal finding of tax evasion" },
    { code: "WILFUL_FAILURE", label: "Wilful failure to perform in accordance with the contract" },
    { code: "UNREMEDIED", label: "Failure to remedy underperforming contracts" },
    { code: "DEBARRED", label: "Notified, suspended or debarred by Government or PPRA" },
  ],
};

/** PC-020. ZD only. Scopes and grounds as stated. */
export const BLOCKING_SCOPES = ["COMPANY", "DIVISION", "BUSINESS_UNIT"] as const;

export const BLOCKING_GROUNDS = [
  { code: "UNSATISFACTORY_RATING", label: "Unsatisfactory performance rating" },
  { code: "NO_BALANCE_CONFIRMATION", label: "Not responding to positive balance confirmation" },
  { code: "STATIC_BALANCE", label: "Static balance for over one year" },
] as const;

/* ── Monthly repeat requisitions ─────────────────────────────────────────── */

/**
 * PC-026. §4.1 names procurement for IT equipment and logistics for grocery and
 * housekeeping, then lists stationery among the monthly categories without
 * naming an owner. Stationery is therefore `null` — unassigned and pending a
 * decision — rather than guessed into one of the two teams.
 */
export const MONTHLY_REQUISITION_OWNERS: Array<{ category: string; ownerRole: string | null }> = [
  { category: "IT Equipment", ownerRole: "PROCUREMENT_OFFICER" },
  { category: "IT Accessories", ownerRole: "PROCUREMENT_OFFICER" },
  { category: "Grocery", ownerRole: "WAREHOUSE_MANAGER" },
  { category: "Housekeeping", ownerRole: "WAREHOUSE_MANAGER" },
  { category: "Stationery", ownerRole: null },
];
