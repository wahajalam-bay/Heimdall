"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/errors";
import { saveCostAnalysis, verifyCostAnalysis } from "@/server/cost-analysis";

/**
 * A yes/no question that has not been answered yet.
 *
 * "" is not "no": the form distinguishes an unanswered question from a negative
 * answer, because only one of the two blocks a signature.
 */
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
