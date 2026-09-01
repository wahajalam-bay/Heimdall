import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";

/**
 * The Price Competitiveness Policy.
 *
 * ZAM/PUR/SOP-01 gives this a heading, a purpose and a nine-step procedure, and
 * the system implemented none of it as a control. Quotation counts were checked;
 * the last buying price, the market studies, the sourcing basis and the vendor
 * prerequisites were not, and single sourcing was a tick-box on the cost
 * analysis form with nothing behind it.
 *
 * ## Three readings that shape this
 *
 * **Some steps are conditional on the goods.** The international-price studies
 * apply "for imported items" and to nothing else. A checklist that demanded them
 * on a local stationery purchase would be ignored inside a week, and an ignored
 * checklist is worse than no checklist.
 *
 * **Single and multiple sourcing are both legitimate.** The SOP says which
 * applies is "evaluated based on the volumes" — so the basis is recorded with its
 * reasoning, rather than single sourcing being treated as a deviation to be
 * justified away. What the SOP does not permit is silence, and a single-sourced
 * award with no volume rationale is the one case this refuses outright.
 *
 * **Emergency relaxes; it does not waive.** "For emergency purchases price
 * competitiveness may not be considered in detail" excuses the *detailed
 * analysis* — the international and local market studies and the three-quotation
 * minimum. It is not permission to skip the last buying price, the cost
 * analysis, or the vendor prerequisites, and it is certainly not permission to
 * skip saying why. The exemption is named, approved, and records exactly which
 * steps it excused, so a later change to what emergency covers cannot rewrite
 * what a past award was excused from.
 */

export const PC_STEPS = [
  "LAST_BUYING_PRICE",
  "SOURCING_BASIS",
  "INTERNATIONAL_PRICES",
  "LOCAL_PRICES",
  "QUOTATION_MINIMUM",
  "COST_ANALYSIS",
  "NEW_VENDOR_PREREQUISITES",
] as const;
export type PcStep = (typeof PC_STEPS)[number];

/** The SOP's own words for each step, so the screen reads as the policy does. */
export const PC_STEP_LABELS: Record<PcStep, string> = {
  LAST_BUYING_PRICE: "Last buying price reviewed",
  SOURCING_BASIS: "Sourcing route evaluated on the volumes",
  INTERNATIONAL_PRICES: "International prices checked (imported items)",
  LOCAL_PRICES: "Prices checked from local vendors / clients",
  QUOTATION_MINIMUM: "Minimum quotations from approved vendors",
  COST_ANALYSIS: "Cost Analysis Summary",
  NEW_VENDOR_PREREQUISITES: "New vendor prerequisites complete",
};

/**
 * What an emergency excuses.
 *
 * The detailed market analysis and the quotation minimum — nothing else. Read
 * narrowly on purpose: "may not be considered in detail" is a relaxation of
 * depth, and reading it as a blanket waiver would turn the emergency
 * classification into a way around the whole policy.
 */
export const EMERGENCY_EXCUSES: PcStep[] = [
  "INTERNATIONAL_PRICES",
  "LOCAL_PRICES",
  "QUOTATION_MINIMUM",
];

export type PcItem = {
  step: PcStep;
  label: string;
  /** Whether this step bites on this exercise at all. */
  applicable: boolean;
  applicableNote: string | null;
  satisfied: boolean;
  detail: string | null;
  /** Excused by the emergency classification rather than satisfied. */
  excused: boolean;
  blocking: boolean;
};

export type PcState = {
  reviewId: string | null;
  items: PcItem[];
  complete: boolean;
  blockers: string[];
  excused: string[];
  emergency: boolean;
  emergencyReason: string | null;
  emergencyApprovedByName: string | null;
  sourcingBasis: "SINGLE" | "MULTIPLE";
  quotationsObtained: number;
  minimumRequired: number;
};

/**
 * The review as it stands, with each step resolved.
 *
 * With no review recorded at all, every applicable step is reported as
 * unsatisfied rather than the whole thing being treated as not started. A
 * sourcing exercise nobody has price-checked has not passed the policy by
 * default.
 */
export async function priceCompetitivenessState(
  comparativeId: string,
  db: DbClient = prisma,
): Promise<PcState> {
  const comparative = await db.comparative.findUnique({
    where: { id: comparativeId },
    select: {
      id: true,
      prId: true,
      pr: { select: { entityId: true } },
      priceCompetitiveness: {
        include: { emergencyApprovedBy: { select: { name: true } } },
      },
      _count: { select: { lines: true } },
    },
  });
  if (!comparative) throw new NotFoundError("Comparative");

  const r = comparative.priceCompetitiveness;
  const minimumRequired =
    r?.minimumRequired ??
    (await getConfigNumber(CONFIG_KEYS.MIN_QUOTATIONS, comparative.pr?.entityId ?? null, db));
  const quotationsObtained = r?.quotationsObtained ?? comparative._count.lines;
  const imported = r?.imported ?? false;
  const sourcingBasis = (r?.sourcingBasis as "SINGLE" | "MULTIPLE") ?? "MULTIPLE";
  const emergency = Boolean(r?.emergencyExempt && r?.emergencyReason && r?.emergencyApprovedById);

  let excusedSteps: PcStep[] = [];
  if (emergency) {
    // The steps the exemption excused when it was granted, not what emergency
    // happens to excuse today.
    try {
      const parsed = JSON.parse(r?.emergencyExcused ?? "[]");
      if (Array.isArray(parsed)) excusedSteps = parsed.filter((x) => PC_STEPS.includes(x));
    } catch {
      excusedSteps = [];
    }
    if (!excusedSteps.length) excusedSteps = EMERGENCY_EXCUSES;
  }

  const items: PcItem[] = PC_STEPS.map((step) => {
    let applicable = true;
    let applicableNote: string | null = null;
    let satisfied = false;
    let detail: string | null = null;

    switch (step) {
      case "LAST_BUYING_PRICE":
        satisfied = Boolean(r?.lastBuyingPriceReviewed);
        detail =
          r?.lastBuyingPrice != null
            ? `PKR ${r.lastBuyingPrice.toLocaleString("en-PK")}${r.lastBuyingPriceSource ? ` — ${r.lastBuyingPriceSource}` : ""}`
            : (r?.lastBuyingPriceSource ?? null);
        break;
      case "SOURCING_BASIS":
        // Multiple sourcing is the default route and needs no argument; single
        // sourcing does, because the SOP grounds it on the volumes.
        satisfied = sourcingBasis === "MULTIPLE" || Boolean(r?.volumeRationale?.trim());
        detail = r?.volumeRationale ?? (sourcingBasis === "MULTIPLE" ? "Multiple sourcing" : null);
        applicableNote =
          sourcingBasis === "SINGLE"
            ? "Single sourcing — the SOP grounds this on the volumes, so the reasoning is required."
            : null;
        break;
      case "INTERNATIONAL_PRICES":
        applicable = imported;
        applicableNote = imported ? null : "Applies to imported items only.";
        satisfied = Boolean(r?.internationalPricesChecked);
        detail = r?.internationalPriceNote ?? null;
        break;
      case "LOCAL_PRICES":
        satisfied = Boolean(r?.localPricesChecked);
        detail = r?.localPriceNote ?? null;
        break;
      case "QUOTATION_MINIMUM":
        satisfied = quotationsObtained >= minimumRequired;
        detail = `${quotationsObtained} of ${minimumRequired} required`;
        break;
      case "COST_ANALYSIS":
        satisfied = Boolean(r?.costAnalysisAttached);
        break;
      case "NEW_VENDOR_PREREQUISITES":
        applicable = Boolean(r?.newVendorInvolved);
        applicableNote = r?.newVendorInvolved ? null : "No newly inducted vendor in this exercise.";
        satisfied = r?.newVendorPrerequisitesMet === true;
        break;
    }

    const excused = !satisfied && applicable && excusedSteps.includes(step);
    return {
      step,
      label: PC_STEP_LABELS[step],
      applicable,
      applicableNote,
      satisfied,
      detail,
      excused,
      blocking: applicable && !satisfied && !excused,
    };
  });

  return {
    reviewId: r?.id ?? null,
    items,
    complete: items.every((i) => !i.blocking),
    blockers: items.filter((i) => i.blocking).map((i) => i.label),
    excused: items.filter((i) => i.excused).map((i) => i.label),
    emergency,
    emergencyReason: r?.emergencyReason ?? null,
    emergencyApprovedByName: r?.emergencyApprovedBy?.name ?? null,
    sourcingBasis,
    quotationsObtained,
    minimumRequired,
  };
}

/** Records or updates the review. */
export async function recordPriceCompetitiveness(
  user: SessionUser,
  input: {
    comparativeId: string;
    imported?: boolean;
    sourcingBasis?: "SINGLE" | "MULTIPLE";
    volumeRationale?: string | null;
    lastBuyingPriceReviewed?: boolean;
    lastBuyingPrice?: number | null;
    lastBuyingPriceSource?: string | null;
    internationalPricesChecked?: boolean;
    internationalPriceNote?: string | null;
    localPricesChecked?: boolean;
    localPriceNote?: string | null;
    costAnalysisAttached?: boolean;
    newVendorInvolved?: boolean;
    newVendorPrerequisitesMet?: boolean | null;
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.COMPARATIVE_CREATE, P.NEGOTIATE)) {
      throw new RuleViolationError("You do not have permission to record a price competitiveness review.");
    }
    if (input.sourcingBasis === "SINGLE" && !input.volumeRationale?.trim()) {
      throw new ValidationError(
        "Say why the volumes point to a single source. ZAM/PUR/SOP-01's Price Competitiveness Policy grounds single sourcing on the volumes, so an unexplained one is not grounded at all.",
      );
    }

    const comparative = await tx.comparative.findUnique({
      where: { id: input.comparativeId },
      select: {
        id: true,
        number: true,
        prId: true,
        status: true,
        pr: { select: { entityId: true } },
        _count: { select: { lines: true } },
      },
    });
    if (!comparative) throw new NotFoundError("Comparative");
    if (["APPROVED", "SUPERSEDED"].includes(comparative.status)) {
      throw new RuleViolationError(
        `${comparative.number} is ${comparative.status.toLowerCase()}. The price competitiveness review belongs to the exercise as it was decided.`,
      );
    }

    const minimumRequired = await getConfigNumber(
      CONFIG_KEYS.MIN_QUOTATIONS,
      comparative.pr?.entityId ?? null,
      tx,
    );

    const data = {
      prId: comparative.prId,
      entityId: comparative.pr?.entityId ?? null,
      imported: input.imported ?? false,
      sourcingBasis: input.sourcingBasis ?? "MULTIPLE",
      volumeRationale: input.volumeRationale?.trim() || null,
      lastBuyingPriceReviewed: input.lastBuyingPriceReviewed ?? false,
      lastBuyingPrice: input.lastBuyingPrice ?? null,
      lastBuyingPriceSource: input.lastBuyingPriceSource?.trim() || null,
      internationalPricesChecked: input.internationalPricesChecked ?? false,
      internationalPriceNote: input.internationalPriceNote?.trim() || null,
      localPricesChecked: input.localPricesChecked ?? false,
      localPriceNote: input.localPriceNote?.trim() || null,
      // Snapshotted, so the review says what was true when it was taken.
      quotationsObtained: comparative._count.lines,
      minimumRequired,
      costAnalysisAttached: input.costAnalysisAttached ?? false,
      newVendorInvolved: input.newVendorInvolved ?? false,
      newVendorPrerequisitesMet:
        input.newVendorInvolved ? (input.newVendorPrerequisitesMet ?? null) : null,
      preparedById: user.id,
    };

    const existing = await tx.priceCompetitivenessReview.findUnique({
      where: { comparativeId: comparative.id },
      select: { id: true },
    });
    const row = existing
      ? await tx.priceCompetitivenessReview.update({ where: { id: existing.id }, data })
      : await tx.priceCompetitivenessReview.create({
          data: { ...data, comparativeId: comparative.id },
        });

    await writeAudit(
      {
        entityType: "Comparative",
        entityId: comparative.id,
        entityRef: comparative.number,
        action: "PRICE_COMPETITIVENESS_RECORDED",
        newValue: {
          sourcingBasis: data.sourcingBasis,
          imported: data.imported,
          quotations: `${data.quotationsObtained}/${minimumRequired}`,
        },
        reason: data.volumeRationale,
        actor: user,
      },
      tx,
    );
    return row;
  });
}

/**
 * Classifies the exercise as an emergency purchase.
 *
 * Needs exception-approval authority, a reason, and it records the exact steps
 * it excuses. The SOP's words are "price competitiveness may not be considered
 * in detail" — a relaxation of depth, not a waiver of the policy — so the last
 * buying price, the cost analysis and the vendor prerequisites still stand.
 */
export async function classifyEmergency(
  user: SessionUser,
  input: { comparativeId: string; reason: string },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.EXCEPTION_MANAGE, P.CPC_DECIDE, P.INVOICE_EXCEPTION_APPROVE)) {
      throw new RuleViolationError(
        "Classifying a purchase as an emergency relaxes a policy control, so it needs exception-approval authority.",
      );
    }
    if (!input.reason?.trim() || input.reason.trim().length < 12) {
      throw new ValidationError(
        "State the business criticality that makes this an emergency. The SOP's own example cites a renovation needed in the shortest possible time; a one-word reason is not that.",
      );
    }

    const comparative = await tx.comparative.findUnique({
      where: { id: input.comparativeId },
      select: { id: true, number: true, prId: true, pr: { select: { entityId: true } } },
    });
    if (!comparative) throw new NotFoundError("Comparative");

    const existing = await tx.priceCompetitivenessReview.findUnique({
      where: { comparativeId: comparative.id },
      select: { id: true },
    });

    const emergency = {
      emergencyExempt: true,
      emergencyReason: input.reason.trim(),
      emergencyApprovedById: user.id,
      emergencyApprovedAt: new Date(),
      emergencyExcused: JSON.stringify(EMERGENCY_EXCUSES),
    };

    const row = existing
      ? await tx.priceCompetitivenessReview.update({ where: { id: existing.id }, data: emergency })
      : await tx.priceCompetitivenessReview.create({
          data: {
            comparativeId: comparative.id,
            prId: comparative.prId,
            entityId: comparative.pr?.entityId ?? null,
            preparedById: user.id,
            ...emergency,
          },
        });

    await writeAudit(
      {
        entityType: "Comparative",
        entityId: comparative.id,
        entityRef: comparative.number,
        action: "EMERGENCY_PURCHASE_CLASSIFIED",
        newValue: {
          approvedBy: user.name,
          excused: EMERGENCY_EXCUSES,
        },
        reason: input.reason.trim(),
        actor: user,
      },
      tx,
    );
    return row;
  });
}

/**
 * Refuses a recommendation while the policy is short.
 *
 * Gated on configuration, off by default: the review is a new record and no
 * existing comparative has one, so enforcing on day one would block every award
 * in flight. Switching it on is the go-live step for this control.
 */
export async function assertPriceCompetitive(
  comparativeId: string,
  ref: string,
  entityId: string | null,
  db: DbClient = prisma,
): Promise<void> {
  const enforce = await getConfigNumber(CONFIG_KEYS.ENFORCE_PRICE_COMPETITIVENESS, entityId, db);
  if (!enforce) return;

  const state = await priceCompetitivenessState(comparativeId, db);
  if (state.complete) return;
  throw new RuleViolationError(
    `${ref} cannot be recommended: the Price Competitiveness Policy is short on ${state.blockers.join(", ")}. ` +
      "Record the review, or classify the purchase as an emergency with an approved reason — which relaxes the detailed market analysis and the quotation minimum, and nothing else.",
  );
}
