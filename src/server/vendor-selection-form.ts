import { prisma, type DbClient } from "@/lib/db";

/**
 * Annexure 6 — the Vendor Selection Form, as a form.
 *
 * `image20` is a scoring sheet with a shape: seven named sections, each with its
 * own maximum, three mandatory documents, a related-party question, and three
 * signatures — Prepared By, Verified By, Approved By.
 *
 * The system's pre-qualification instrument is a flat list of weighted criteria
 * carrying a `group`. That is close enough to render the form's sections from
 * real data, and far enough that the two can disagree. Where they do, this says
 * so rather than reshaping one to fit the other:
 *
 *   · A section the form names and the instrument has no criteria for is
 *     reported as unscored, not as zero. Zero is a judgement; absent is a gap.
 *   · A section maximum that differs from the form's is reported as differing.
 *     The form's own seven maxima sum to 61 while it states a qualifying score
 *     out of 60 — a one-point discrepancy in the source that nothing here is
 *     entitled to resolve. See PCZ-06 and BD-006.
 *
 * Nothing in this file decides a score. It reads what was recorded and lays it
 * out the way the form does.
 */

/**
 * The seven sections Annexure 6 names, with the maximum printed on the form.
 *
 * Held here rather than in configuration because these are the form's own
 * headings — changing them would mean a different form, not a different policy.
 * The scores come from the instrument; only the layout comes from this list.
 */
export const ANNEXURE_6_SECTIONS = [
  { key: "TAX_STATUS", label: "Tax status", formMax: 10 },
  { key: "COMPANY_HISTORY", label: "Company history", formMax: 10 },
  { key: "CLIENT_REFERENCE", label: "Key client reference check", formMax: 12 },
  { key: "PAYMENT_MODE", label: "Payment mode", formMax: 10 },
  { key: "COMPANY_REGISTRATION", label: "Company registration", formMax: 5 },
  { key: "COMPANY_SETUP", label: "Company setup", formMax: 10 },
  { key: "INTERNAL_REFERENCE", label: "Internal reference", formMax: 4 },
] as const;

/** What the form states as its own pass mark, and what its sections add up to. */
export const ANNEXURE_6_STATED_PASS = 30;
export const ANNEXURE_6_STATED_TOTAL = 60;
export const ANNEXURE_6_SECTION_SUM = ANNEXURE_6_SECTIONS.reduce((a, s) => a + s.formMax, 0);

/**
 * Annexure 6's mandatory documents, and the `docType` each is held under.
 *
 * Two of the three had no document type before this form existed, because
 * neither is the same paper as its nearest neighbour — filer status is not the
 * NTN certificate, and a client's completion certificate is not a reference
 * letter. They were added rather than folded in, so the mandatory check cannot
 * pass on the wrong document.
 */
export const ANNEXURE_6_MANDATORY = [
  {
    docType: "FBR_ONLINE_STATUS",
    label: "FBR online status",
    note: "The filer-status verification, not the NTN certificate.",
  },
  {
    docType: "INCORPORATION",
    label: "Company registration",
    note: null,
  },
  {
    docType: "JOB_COMPLETION_CERTIFICATE",
    label: "Job completion certificate from clients",
    note: "From a client, not a reference letter written for the vendor.",
  },
] as const;

export type SectionState = {
  key: string;
  label: string;
  /** The maximum printed on Annexure 6. */
  formMax: number;
  /** The maximum the instrument's criteria for this section actually add to. */
  instrumentMax: number;
  /** What was scored, weighted as the instrument weights it. */
  scored: number;
  /** True when no criterion in the instrument belongs to this section. */
  unscored: boolean;
  /** True when the instrument's maximum and the form's do not agree. */
  maximumDiffers: boolean;
  lines: Array<{
    code: string;
    name: string;
    /** The instrument's own group name, which is not always a form section. */
    group: string;
    score: number;
    maxScore: number;
    weight: number;
    weightedScore: number;
    comment: string | null;
  }>;
};

export type MandatoryDocState = {
  docType: string;
  label: string;
  note: string | null;
  present: boolean;
  verified: boolean;
  name: string | null;
  expiryDate: Date | null;
};

export type SelectionFormState = {
  sections: SectionState[];
  /** Criteria whose group matches no section on the form. */
  offForm: SectionState | null;
  mandatory: MandatoryDocState[];
  missingMandatory: string[];
  /** Totals as the instrument computed them, not recomputed here. */
  totals: { scored: number; max: number; percentage: number; passMark: number; passed: boolean } | null;
};

/**
 * Maps a criterion's `group` onto a section key.
 *
 * Matching is on a normalised form of the group name, so "Tax Status", "tax
 * status" and "TAX_STATUS" all land in the same section. A group that matches
 * nothing is not forced into the nearest section — it goes to `offForm`, where
 * it is visible as a criterion the form has no row for.
 */
function sectionKeyFor(group: string): string | null {
  const norm = group.trim().toUpperCase().replace(/[^A-Z]+/g, "_");
  for (const s of ANNEXURE_6_SECTIONS) {
    if (norm === s.key) return s.key;
    // "Key Client Reference Check" → CLIENT_REFERENCE; match on the distinctive
    // word rather than requiring the group to be named exactly as the key.
    const words = s.key.split("_");
    if (words.every((w) => norm.includes(w))) return s.key;
  }
  if (norm.includes("TAX")) return "TAX_STATUS";
  if (norm.includes("HISTORY")) return "COMPANY_HISTORY";
  if (norm.includes("REFERENCE") && norm.includes("CLIENT")) return "CLIENT_REFERENCE";
  if (norm.includes("PAYMENT")) return "PAYMENT_MODE";
  if (norm.includes("REGISTRATION")) return "COMPANY_REGISTRATION";
  if (norm.includes("SETUP")) return "COMPANY_SETUP";
  if (norm.includes("INTERNAL")) return "INTERNAL_REFERENCE";
  return null;
}

/** The form for one vendor, from its most recent pre-qualification evaluation. */
export async function selectionForm(
  vendorId: string,
  opts: { evaluationId?: string } = {},
  db: DbClient = prisma,
): Promise<SelectionFormState> {
  const [evaluation, documents] = await Promise.all([
    opts.evaluationId
      ? db.vendorEvaluation.findUnique({
          where: { id: opts.evaluationId },
          include: { scores: { include: { criterion: true } } },
        })
      : db.vendorEvaluation.findFirst({
          where: { vendorId, evaluationType: "PRE_QUALIFICATION" },
          orderBy: { evaluatedAt: "desc" },
          include: { scores: { include: { criterion: true } } },
        }),
    db.vendorDocument.findMany({ where: { vendorId } }),
  ]);

  const buckets = new Map<string, SectionState["lines"]>();
  const offFormLines: SectionState["lines"] = [];

  for (const s of evaluation?.scores ?? []) {
    const line = {
      code: s.criterion.code,
      name: s.criterion.name,
      group: s.criterion.group,
      score: s.score,
      maxScore: s.maxScore,
      weight: s.weight,
      weightedScore: s.weightedScore,
      comment: s.comment,
    };
    const key = sectionKeyFor(s.criterion.group);
    if (key === null) offFormLines.push(line);
    else {
      const held = buckets.get(key);
      if (held) held.push(line);
      else buckets.set(key, [line]);
    }
  }

  const sections: SectionState[] = ANNEXURE_6_SECTIONS.map((s) => {
    const lines = buckets.get(s.key) ?? [];
    const instrumentMax = lines.reduce((a, l) => a + l.maxScore * l.weight, 0);
    const scored = lines.reduce((a, l) => a + l.weightedScore, 0);
    return {
      key: s.key,
      label: s.label,
      formMax: s.formMax,
      instrumentMax,
      scored,
      unscored: lines.length === 0,
      maximumDiffers: lines.length > 0 && Math.abs(instrumentMax - s.formMax) > 0.001,
      lines,
    };
  });

  const offForm: SectionState | null = offFormLines.length
    ? {
        key: "OFF_FORM",
        label: "Scored but not on Annexure 6",
        formMax: 0,
        instrumentMax: offFormLines.reduce((a, l) => a + l.maxScore * l.weight, 0),
        scored: offFormLines.reduce((a, l) => a + l.weightedScore, 0),
        unscored: false,
        maximumDiffers: false,
        lines: offFormLines,
      }
    : null;

  const byType = new Map(documents.map((d) => [d.docType, d]));
  const mandatory: MandatoryDocState[] = ANNEXURE_6_MANDATORY.map((m) => {
    const held = byType.get(m.docType);
    return {
      docType: m.docType,
      label: m.label,
      note: m.note,
      present: Boolean(held),
      verified: Boolean(held?.verified),
      name: held?.name ?? null,
      expiryDate: held?.expiryDate ?? null,
    };
  });

  return {
    sections,
    offForm,
    mandatory,
    missingMandatory: mandatory.filter((m) => !m.present).map((m) => m.label),
    totals: evaluation
      ? {
          scored: evaluation.totalScore,
          max: evaluation.maxScore,
          percentage: evaluation.percentage,
          passMark: evaluation.passingScore,
          passed: evaluation.passed,
        }
      : null,
  };
}
