"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission, requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { saveCostAnalysis, verifyCostAnalysis } from "@/server/cost-analysis";
import {
  addManualComparison,
  removeManualComparison,
  type ManualSourceType,
} from "@/server/manual-comparison";

/**
 * A yes/no question that has not been answered yet.
 *
 * "" is not "no": the form distinguishes an unanswered question from a negative
 * answer, because only one of the two blocks a signature.
 */
const blank = (v: FormDataEntryValue | null) => {
  const t = typeof v === "string" ? v.trim() : "";
  return t === "" ? null : t;
};

const tristate = z
  .union([z.literal("yes"), z.literal("no"), z.literal("")])
  .transform((v) => (v === "" ? null : v === "yes"));

const schema = z.object({
  comparativeId: z.string().min(1),
  pocUserId: z.string().optional(),
  taxPercent: z.coerce.number().min(0).max(100).optional(),
  invoiceChargedTo: z.string().optional(),
  remarks: z.string().optional(),
  specialNotes: z.string().optional(),
  singleSourced: tristate.optional(),
  ratesLocked: tristate.optional(),
  vendorSelectionForm: tristate.optional(),
  higherRateReason: z.string().optional(),
});

export async function saveCostAnalysisAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const raw = Object.fromEntries(formData.entries());
    const parsed = schema.parse(raw);

    // Per-vendor terms arrive as terms.<lineId>.<field>, so a row of the grid
    // travels as its own set of named inputs rather than as an encoded blob.
    const terms: Record<string, Record<string, string>> = {};
    for (const [key, value] of formData.entries()) {
      const m = /^terms\.([^.]+)\.(\w+)$/.exec(key);
      if (!m) continue;
      (terms[m[1]] ??= {})[m[2]] = String(value);
    }

    const saved = await saveCostAnalysis(
      user,
      {
        comparativeId: parsed.comparativeId,
        pocUserId: parsed.pocUserId || null,
        taxPercent: parsed.taxPercent,
        invoiceChargedTo: parsed.invoiceChargedTo ?? null,
        remarks: parsed.remarks ?? null,
        specialNotes: parsed.specialNotes ?? null,
        singleSourced: parsed.singleSourced ?? null,
        ratesLocked: parsed.ratesLocked ?? null,
        vendorSelectionForm: parsed.vendorSelectionForm ?? null,
        higherRateReason: parsed.higherRateReason ?? null,
        terms,
      },
    );

    revalidatePath(`/comparatives/${parsed.comparativeId}/cost-analysis`);
    revalidatePath(`/comparatives/${parsed.comparativeId}`);
    return { ok: true, data: { id: saved.id }, message: "Cost analysis form saved." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function verifyCostAnalysisAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const comparativeId = String(formData.get("comparativeId") ?? "");
    const done = await verifyCostAnalysis(user, comparativeId);
    revalidatePath(`/comparatives/${comparativeId}/cost-analysis`);
    revalidatePath(`/comparatives/${comparativeId}`);
    return { ok: true, data: { id: done.id }, message: "Cost analysis form verified." };
  } catch (e) {
    return toActionError(e);
  }
}

/** Adds a comparison option that is not a vendor quotation. */
export async function addManualComparisonAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requirePermission(P.QUOTE_ENTER, P.COMPARATIVE_CREATE);
    const quantity = Number(formData.get("quantity"));
    const rate = Number(formData.get("rate"));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ValidationError("Enter the quantity this price covers.");
    }
    if (!Number.isFinite(rate) || rate < 0) throw new ValidationError("Enter the rate.");
    const validUntil = blank(formData.get("validUntil"));

    const entry = await addManualComparison(user, {
      comparativeId: String(formData.get("comparativeId") ?? ""),
      vendorId: blank(formData.get("vendorId")),
      sourceName: String(formData.get("sourceName") ?? ""),
      sourceType: String(formData.get("sourceType") ?? "OTHER") as ManualSourceType,
      description: String(formData.get("description") ?? ""),
      unit: String(formData.get("unit") ?? "EA"),
      quantity,
      rate,
      taxRuleId: blank(formData.get("taxRuleId")),
      taxNote: blank(formData.get("taxNote")),
      deliveryTerms: blank(formData.get("deliveryTerms")),
      paymentTerms: blank(formData.get("paymentTerms")),
      validUntil: validUntil ? new Date(validUntil) : null,
      evidenceRef: blank(formData.get("evidenceRef")),
      reason: String(formData.get("reason") ?? ""),
    });

    revalidatePath(`/comparatives/${entry.comparativeId}/cost-analysis`);
    return {
      ok: true,
      data: null,
      message: `${entry.sourceName} added as a manual option at ${entry.netValue.toLocaleString("en-PK")}. It is labelled MANUAL on the sheet.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/** Removes one, keeping what it said in the audit. */
export async function removeManualComparisonAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission(P.QUOTE_ENTER, P.COMPARATIVE_CREATE);
    const entry = await removeManualComparison(
      user,
      String(formData.get("id") ?? ""),
      String(formData.get("reason") ?? ""),
    );
    revalidatePath(`/comparatives/${entry.comparativeId}/cost-analysis`);
    return { ok: true, data: null, message: `${entry.sourceName} removed from the comparison.` };
  } catch (e) {
    return toActionError(e);
  }
}
