"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/errors";
import { recordAccessReview } from "@/server/access-review";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

export async function recordAccessReviewAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await recordAccessReview(user, {
      periodLabel: String(formData.get("periodLabel") ?? ""),
      notes: String(formData.get("notes") ?? ""),
      entityId: blank(formData.get("entityId")),
    });
    revalidatePath("/admin/access-review");
    revalidatePath("/analytics/controls");
    return {
      ok: true,
      data: null,
      message:
        "Review recorded with the figures as they stood. Mark the control performed on the calendar to close the period.",
    };
  } catch (e) {
    return toActionError(e);
  }
}
