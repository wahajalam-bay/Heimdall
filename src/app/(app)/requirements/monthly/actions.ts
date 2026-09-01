"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import { draftMonthlyRequirement } from "@/server/monthly-repeat";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

/**
 * Turns the chosen proposal lines into a draft requirement.
 *
 * Quantities are not posted from here. `draftMonthlyRequirement` recomputes the
 * projection and takes its own figures — a quantity that arrived in a form is not
 * evidence of anything, and trusting one would turn the projection into a
 * free-text order form.
 */
export async function draftMonthlyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const entityId = blank(formData.get("entityId"));
    const departmentId = blank(formData.get("departmentId"));
    if (!entityId) throw new ValidationError("No company was named.");
    if (!departmentId) throw new ValidationError("Choose the department the requirement belongs to.");

    const itemIds = formData.getAll("itemId").map(String).filter(Boolean);
    if (!itemIds.length) throw new ValidationError("Choose at least one line to include.");

    const req = await draftMonthlyRequirement(user, {
      entityId,
      departmentId,
      storeId: blank(formData.get("storeId")),
      ownerRole: blank(formData.get("ownerRole")),
      itemIds,
      title: blank(formData.get("title")),
    });

    revalidatePath("/requirements");
    revalidatePath("/requirements/monthly");
    return {
      ok: true,
      data: { id: req.id },
      message: `${req.number} created as a draft with ${itemIds.length} line(s). Review it and submit — §4.1 has the team raise the requisition, not the system.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}
