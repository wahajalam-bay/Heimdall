"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import {
  adjustFromCount,
  closeStockCount,
  openStockCount,
  recordCount,
  reviewStockCount,
  submitStockCount,
  type CountType,
} from "@/server/stock-count";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

export async function openStockCountAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const storeId = blank(formData.get("storeId"));
    if (!storeId) throw new ValidationError("Choose the store to count.");
    const count = await openStockCount(user, {
      storeId,
      countType: (blank(formData.get("countType")) ?? "CYCLE") as CountType,
      categoryId: blank(formData.get("categoryId")),
      locationId: blank(formData.get("locationId")),
      scopeNote: blank(formData.get("scopeNote")),
    });
    revalidatePath("/inventory/counts");
    return {
      ok: true,
      data: { id: count.id },
      message: `${count.number} opened. The ledger is frozen against this sheet as at now.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/**
 * Records the counted quantities from the sheet.
 *
 * Blank lines are left alone rather than posted as zero: a line nobody typed
 * into has not been counted, and treating it as an empty shelf is the mistake
 * this whole workflow exists to avoid.
 */
export async function recordCountAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const countId = String(formData.get("countId") ?? "");

    const lineIds = formData.getAll("lineId").map(String);
    const quantities = formData.getAll("countedQty").map(String);
    const reasons = formData.getAll("varianceReason").map(String);

    const lines = lineIds
      .map((lineId, i) => ({
        lineId,
        raw: quantities[i] ?? "",
        reason: reasons[i] || null,
      }))
      .filter((l) => l.raw.trim() !== "")
      .map((l) => ({
        lineId: l.lineId,
        countedQty: Number(l.raw),
        reason: l.reason,
      }));

    if (!lines.length) throw new ValidationError("Nothing was entered.");
    if (lines.some((l) => !Number.isFinite(l.countedQty))) {
      throw new ValidationError("Counted quantities must be numbers.");
    }

    await recordCount(user, { countId, lines });
    revalidatePath(`/inventory/counts/${countId}`);
    return { ok: true, data: null, message: `${lines.length} line(s) recorded.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function submitStockCountAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const countId = String(formData.get("countId") ?? "");
    await submitStockCount(user, countId);
    revalidatePath(`/inventory/counts/${countId}`);
    return { ok: true, data: null, message: "Submitted for review." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function reviewStockCountAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const countId = String(formData.get("countId") ?? "");
    await reviewStockCount(user, { countId, notes: blank(formData.get("reason")) });
    revalidatePath(`/inventory/counts/${countId}`);
    return { ok: true, data: null, message: "Reviewed and approved." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function adjustFromCountAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const countId = String(formData.get("countId") ?? "");
    const { posted } = await adjustFromCount(user, countId);
    revalidatePath(`/inventory/counts/${countId}`);
    revalidatePath("/inventory");
    return {
      ok: true,
      data: null,
      message: posted
        ? `${posted} ledger adjustment(s) posted, each carrying the count as its reason.`
        : "No variances left to correct.",
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function closeStockCountAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const countId = String(formData.get("countId") ?? "");
    const cancel = String(formData.get("cancel") ?? "") === "true";
    await closeStockCount(user, { countId, cancel, reason: blank(formData.get("reason")) });
    revalidatePath(`/inventory/counts/${countId}`);
    revalidatePath("/inventory/counts");
    return { ok: true, data: null, message: cancel ? "Count cancelled." : "Count closed." };
  } catch (e) {
    return toActionError(e);
  }
}
