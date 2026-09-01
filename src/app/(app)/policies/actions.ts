"use server";

import { revalidatePath } from "next/cache";
import { requestContext, requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import { acknowledgePolicy, publishPolicy } from "@/server/policy-acknowledgement";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

/**
 * Acknowledges a policy version.
 *
 * The reader's own, always. `acknowledgePolicy` takes the acting user rather
 * than an id from the form, so nobody can enter an acknowledgement on somebody
 * else's behalf — which is the one thing this register exists to prevent.
 */
export async function acknowledgePolicyAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const ctx = await requestContext();
    await acknowledgePolicy(user, {
      policyId: String(formData.get("policyId") ?? ""),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    revalidatePath("/policies");
    return { ok: true, data: null, message: "Acknowledged, against this exact version." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function publishPolicyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const effective = blank(formData.get("effectiveFrom"));
    if (!effective) throw new ValidationError("State when the version takes effect.");

    const p = await publishPolicy(user, {
      code: String(formData.get("code") ?? ""),
      version: String(formData.get("version") ?? ""),
      title: String(formData.get("title") ?? ""),
      summary: blank(formData.get("summary")),
      changeNote: blank(formData.get("changeNote")),
      effectiveFrom: new Date(effective),
      requiredRoleCodes: formData.getAll("roleCode").map(String).filter(Boolean),
      entityId: blank(formData.get("entityId")),
    });

    revalidatePath("/policies");
    return {
      ok: true,
      data: { id: p.id },
      message: `${p.code} version ${p.version} published. Earlier versions keep their acknowledgements; nobody has signed this one yet.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}
