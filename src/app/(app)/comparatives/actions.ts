"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import {
  classifyEmergency,
  recordPriceCompetitiveness,
} from "@/server/price-competitiveness";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const bool = (v: FormDataEntryValue | null) => String(v ?? "") === "true";
const num = (v: FormDataEntryValue | null) => {
  const raw = blank(v);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Records the Price Competitiveness review.
 *
 * Every rule that matters — the single-source rationale, which steps apply —
 * lives in `recordPriceCompetitiveness`. This only shapes the form data.
 */
export async function recordPriceCompetitivenessAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const comparativeId = String(formData.get("comparativeId") ?? "");
    if (!comparativeId) throw new ValidationError("No comparative was named.");

    const newVendorInvolved = bool(formData.get("newVendorInvolved"));
    await recordPriceCompetitiveness(user, {
      comparativeId,
      imported: bool(formData.get("imported")),
      sourcingBasis: String(formData.get("sourcingBasis") ?? "MULTIPLE") as "SINGLE" | "MULTIPLE",
      volumeRationale: blank(formData.get("volumeRationale")),
      lastBuyingPriceReviewed: bool(formData.get("lastBuyingPriceReviewed")),
      lastBuyingPrice: num(formData.get("lastBuyingPrice")),
      lastBuyingPriceSource: blank(formData.get("lastBuyingPriceSource")),
      internationalPricesChecked: bool(formData.get("internationalPricesChecked")),
      internationalPriceNote: blank(formData.get("internationalPriceNote")),
      localPricesChecked: bool(formData.get("localPricesChecked")),
      localPriceNote: blank(formData.get("localPriceNote")),
      costAnalysisAttached: bool(formData.get("costAnalysisAttached")),
      newVendorInvolved,
      newVendorPrerequisitesMet: newVendorInvolved
        ? bool(formData.get("newVendorPrerequisitesMet"))
        : null,
    });

    revalidatePath(`/comparatives/${comparativeId}`);
    return { ok: true, data: null, message: "Price competitiveness review recorded." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function classifyEmergencyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const comparativeId = String(formData.get("comparativeId") ?? "");
    await classifyEmergency(user, {
      comparativeId,
      reason: String(formData.get("reason") ?? ""),
    });
    revalidatePath(`/comparatives/${comparativeId}`);
    return {
      ok: true,
      data: null,
      message:
        "Classified as an emergency purchase. The market studies and the quotation minimum are excused; nothing else is.",
    };
  } catch (e) {
    return toActionError(e);
  }
}
