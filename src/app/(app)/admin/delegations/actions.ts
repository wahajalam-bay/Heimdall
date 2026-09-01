"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import { createDelegation, revokeDelegation } from "@/server/delegation";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const raw = blank(v);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

export async function createDelegationAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const delegatorId = blank(formData.get("delegatorId")) ?? user.id;
    const delegateId = blank(formData.get("delegateId"));
    if (!delegateId) throw new ValidationError("Choose who the authority goes to.");

    const from = blank(formData.get("validFrom"));
    const to = blank(formData.get("validTo"));
    if (!from || !to) throw new ValidationError("A delegation needs a start and an end date.");

    const permissions = formData.getAll("permission").map(String).filter(Boolean);
    const documentTypes = formData.getAll("documentType").map(String).filter(Boolean);

    const d = await createDelegation(user, {
      delegatorId,
      delegateId,
      permissions,
      documentTypes,
      valueLimit: num(formData.get("valueLimit")),
      validFrom: new Date(from),
      validTo: new Date(to),
      reason: String(formData.get("reason") ?? ""),
      entityId: blank(formData.get("entityId")),
    });

    revalidatePath("/admin/delegations");
    return {
      ok: true,
      data: { id: d.id },
      message:
        d.status === "PENDING"
          ? "Recorded. It comes into force on its start date."
          : "Recorded and in force. Every act taken under it will name both people.",
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function revokeDelegationAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await revokeDelegation(user, {
      delegationId: String(formData.get("delegationId") ?? ""),
      reason: String(formData.get("reason") ?? ""),
    });
    revalidatePath("/admin/delegations");
    return { ok: true, data: null, message: "Revoked." };
  } catch (e) {
    return toActionError(e);
  }
}
