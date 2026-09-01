"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import { recordPolicyReview, type ReviewKind } from "@/server/policy-review";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

export async function recordPolicyReviewAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const policyId = String(formData.get("policyId") ?? "");
    if (!policyId) throw new ValidationError("Choose the policy.");
    const reviewedAt = blank(formData.get("reviewedAt"));
    const attendees = blank(formData.get("attendeeCount"));

    await recordPolicyReview(user, {
      policyId,
      kind: String(formData.get("kind") ?? "TEAM_REVIEW") as ReviewKind,
      departmentId: blank(formData.get("departmentId")),
      attendeeCount: attendees === null ? null : Number(attendees),
      attendeeNames: blank(formData.get("attendeeNames")),
      notes: String(formData.get("notes") ?? ""),
      findings: blank(formData.get("findings")),
      reviewedAt: reviewedAt ? new Date(reviewedAt) : null,
    });

    revalidatePath("/policies/reviews");
    revalidatePath("/policies");
    return { ok: true, data: null, message: "Review recorded against this version of the policy." };
  } catch (e) {
    return toActionError(e);
  }
}
