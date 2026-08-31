import { prisma, type DbClient } from "./db";
import { CONFIG_KEYS, getConfigArray, getConfigNumber, getConfig } from "./config";
import { RuleViolationError } from "./errors";
import type { Disposition } from "./domain";

/**
 * Accounting treatment — asset or consumable — decided per transaction, not per item.
 *
 * The same air conditioner is a fixed asset in an office and a project cost on a
 * build-out. That is not an inconsistency to be tidied away: it is what the
 * accounting actually is, and an Item Master flag cannot express it. So the item
 * carries a **default** and the receipt carries the **decision**, with a reason
 * whenever the two differ.
 *
 * The capitalisation threshold is deliberately not a constant. The approved
 * requirements say two things that cannot both hold literally — that nothing
 * below PKR 15,000 should be treated as an asset, and that a coffee table below
 * PKR 15,000 may still be a fixed asset. Rather than pick one and hide the
 * choice, the threshold has a *mode*:
 *
 *   · `HARD_BAR` — below the threshold, asset treatment is refused outright.
 *   · `DEFAULT_WITH_EXCEPTION` — below it the default is consumable, and an
 *     approved, reasoned override can still capitalise. This is what ships,
 *     because it is the only reading under which both statements are true.
 *   · `ADVISORY` — the threshold warns and records, and never refuses.
 *
 * See `BD-002` in the business decision register.
 */

export const CAPITALISATION_MODES = ["HARD_BAR", "DEFAULT_WITH_EXCEPTION", "ADVISORY"] as const;
export type CapitalisationMode = (typeof CAPITALISATION_MODES)[number];

/** Treatments that put a line on the fixed asset register. */
export const ASSET_TREATMENTS: Disposition[] = ["ASSET"];

/** Treatments that expense or consume rather than capitalise. */
export const CONSUMABLE_TREATMENTS: Disposition[] = [
  "CONSUMABLE",
  "EXPENSE",
  "PROJECT_MATERIAL",
];

export type CapitalisationPolicy = {
  threshold: number;
  mode: CapitalisationMode;
  /** Category codes that may capitalise below the threshold without an override. */
  exemptCategories: string[];
};

export async function capitalisationPolicy(
  entityId: string | null,
  db: DbClient = prisma,
): Promise<CapitalisationPolicy> {
  const mode = String(
    await getConfig<string>(CONFIG_KEYS.CAPITALISATION_MODE, entityId, db),
  ) as CapitalisationMode;
  return {
    threshold: await getConfigNumber(CONFIG_KEYS.CAPITALISATION_THRESHOLD, entityId, db),
    mode: CAPITALISATION_MODES.includes(mode) ? mode : "DEFAULT_WITH_EXCEPTION",
    exemptCategories: await getConfigArray<string>(
      CONFIG_KEYS.CAPITALISATION_EXEMPT_CATEGORIES,
      entityId,
      db,
    ),
  };
}

export type TreatmentDecision = {
  /** What the item or its category says by default. */
  defaultTreatment: Disposition;
  /** What is actually being applied. */
  treatment: Disposition;
  overridden: boolean;
  /**
   * Capitalising below the threshold without a category exemption — the case
   * worth reviewing. An exempt category is doing what policy allows, so it is
   * not flagged.
   */
  belowThreshold: boolean;
  /** Set when the decision cannot stand as asked. */
  refusal: string | null;
  /** Set when it can stand but somebody should know. */
  warning: string | null;
  requiresReason: boolean;
  requiresApproval: boolean;
};

/**
 * Decides the treatment for one line and says what it needs to be legitimate.
 *
 * Returns rather than throws, so a form can show the whole picture at once
 * instead of failing on the first line. `refusal` is the caller's cue to stop.
 */
export function decideTreatment(input: {
  requested: Disposition | null | undefined;
  defaultTreatment: Disposition;
  lineValue: number;
  categoryCode?: string | null;
  policy: CapitalisationPolicy;
  reason?: string | null;
  approvedById?: string | null;
}): TreatmentDecision {
  const { policy } = input;
  const treatment = input.requested ?? input.defaultTreatment;
  const overridden = treatment !== input.defaultTreatment;
  const capitalising = ASSET_TREATMENTS.includes(treatment);
  const exempt = Boolean(
    input.categoryCode && policy.exemptCategories.includes(input.categoryCode),
  );
  // Below the threshold *and not exempt*. An exempt category capitalising a
  // low-value line is doing exactly what policy allows, so flagging it as
  // notable would bury the cases that are.
  const belowThreshold =
    capitalising && policy.threshold > 0 && input.lineValue < policy.threshold && !exempt;

  let refusal: string | null = null;
  let warning: string | null = null;
  let requiresReason = overridden;
  let requiresApproval = false;

  if (belowThreshold) {
    const money = `PKR ${input.lineValue.toLocaleString("en-PK")}`;
    const limit = `PKR ${policy.threshold.toLocaleString("en-PK")}`;
    if (policy.mode === "HARD_BAR") {
      refusal =
        `${money} is below the ${limit} capitalisation threshold, so it cannot be treated as an asset. ` +
        "Record it as a consumable, or have the threshold policy changed.";
    } else if (policy.mode === "DEFAULT_WITH_EXCEPTION") {
      requiresReason = true;
      requiresApproval = true;
      if (!input.reason?.trim()) {
        refusal =
          `${money} is below the ${limit} capitalisation threshold. It can still be capitalised — a low-value item can be a genuine fixed asset — but the reason has to be recorded and approved.`;
      } else if (!input.approvedById) {
        refusal =
          `Capitalising below ${limit} needs approval as well as a reason. The reason is recorded; the approval is not.`;
      }
    } else {
      warning =
        `${money} is below the ${limit} capitalisation threshold. It is being capitalised anyway, which is recorded.`;
    }
  }

  if (overridden && !input.reason?.trim() && !refusal) {
    refusal =
      `This line's default treatment is ${input.defaultTreatment.replace(/_/g, " ").toLowerCase()} and it is being recorded as ${treatment.replace(/_/g, " ").toLowerCase()}. ` +
      "State why — an override with no reason cannot be reviewed later.";
  }

  return {
    defaultTreatment: input.defaultTreatment,
    treatment,
    overridden,
    belowThreshold,
    refusal,
    warning,
    requiresReason,
    requiresApproval,
  };
}

/** Throws the first refusal across a set of lines, naming the line. */
export function assertTreatments(
  decisions: Array<{ lineNo: number; description: string; decision: TreatmentDecision }>,
): void {
  const bad = decisions.filter((d) => d.decision.refusal);
  if (!bad.length) return;
  throw new RuleViolationError(
    bad
      .map((d) => `Line ${d.lineNo} (${d.description}): ${d.decision.refusal}`)
      .join("  "),
  );
}

/** Which side of the Expense Book a treatment falls on. */
export function treatmentClass(treatment: string): "ASSET" | "CONSUMABLE" | "INVENTORY" {
  if (ASSET_TREATMENTS.includes(treatment as Disposition)) return "ASSET";
  if (CONSUMABLE_TREATMENTS.includes(treatment as Disposition)) return "CONSUMABLE";
  return "INVENTORY";
}
