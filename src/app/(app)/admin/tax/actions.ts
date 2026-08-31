"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { approveTaxRule, closeTaxRule, createTaxRule } from "@/server/tax";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const n = Number(typeof v === "string" ? v : NaN);
  return Number.isFinite(n) ? n : null;
};

export async function createTaxRuleAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requirePermission(P.TAX_MANAGE);
    const percent = num(formData.get("percent"));
    if (percent === null) throw new ValidationError("Enter the percentage.");
    const from = blank(formData.get("effectiveFrom"));
    if (!from) throw new ValidationError("State the date this rate takes effect.");
    const to = blank(formData.get("effectiveTo"));

    const appliesTo = String(formData.get("appliesTo") ?? "BOTH") as "GOODS" | "SERVICES" | "BOTH";

    const rule = await createTaxRule(user, {
      code: String(formData.get("code") ?? ""),
      name: String(formData.get("name") ?? ""),
      appliesTo,
      method: (String(formData.get("method") ?? "PERCENT") as "PERCENT" | "FIXED"),
      percent,
      withholding: formData.get("withholding") === "on",
      vendorTaxStatus: String(formData.get("vendorTaxStatus") ?? "ANY") as
        | "FILER"
        | "NON_FILER"
        | "ANY",
      entityId: blank(formData.get("entityId")),
      effectiveFrom: new Date(from),
      effectiveTo: to ? new Date(to) : null,
      sourceReference: blank(formData.get("sourceReference")),
    });

    revalidatePath("/admin/tax");
    return {
      ok: true,
      data: { id: rule.id },
      message: `${rule.code} at ${rule.percent}% recorded, effective ${rule.effectiveFrom.toISOString().slice(0, 10)}. It needs approving before it prices anything.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function closeTaxRuleAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requirePermission(P.TAX_MANAGE);
    const id = String(formData.get("id") ?? "");
    const to = blank(formData.get("effectiveTo"));
    if (!to) throw new ValidationError("State the date this rate stops applying.");
    const reason = String(formData.get("reason") ?? "");

    const rule = await closeTaxRule(user, id, new Date(to), reason);
    revalidatePath("/admin/tax");
    return {
      ok: true,
      data: null,
      message: `${rule.code} closed off at ${to}. Transactions it already priced keep that rate.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function approveTaxRuleAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission(P.TAX_VERIFY, P.TAX_MANAGE);
    const rule = await approveTaxRule(user, String(formData.get("id") ?? ""));
    revalidatePath("/admin/tax");
    return { ok: true, data: null, message: `${rule.code} approved for use.` };
  } catch (e) {
    return toActionError(e);
  }
}
