"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { setMinimumStock, type MinStockBasis } from "@/server/replenishment";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

/**
 * Sets a minimum stock level and the ground it rests on.
 *
 * The permission gate here is the outer door; `setMinimumStock` checks again
 * inside the domain function, because a server action is a URL and the only
 * check that counts is the one the mutation itself makes.
 */
export async function setMinimumStockAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requirePermission(P.MASTER_MANAGE, P.INVENTORY_ADJUST);
    const itemId = blank(formData.get("itemId"));
    if (!itemId) throw new ValidationError("No item was named.");

    const raw = blank(formData.get("level"));
    const level = raw === null ? null : Number(raw);
    if (level !== null && !Number.isFinite(level)) {
      throw new ValidationError("The minimum must be a number, or blank to remove it.");
    }

    await setMinimumStock(user, {
      itemId,
      level,
      basis: String(formData.get("basis") ?? "MANUAL") as MinStockBasis,
      note: blank(formData.get("note")),
    });

    revalidatePath("/inventory/replenishment");
    revalidatePath("/inventory");
    return { ok: true, data: null, message: "Minimum stock level recorded." };
  } catch (e) {
    return toActionError(e);
  }
}
