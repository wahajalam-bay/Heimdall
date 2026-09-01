"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import {
  createContract,
  signContract,
  transitionContract,
  type ContractState,
  type ContractType,
} from "@/server/contracts";

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
const date = (v: FormDataEntryValue | null) => {
  const raw = blank(v);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

export async function createContractAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const entityId = blank(formData.get("entityId"));
    const vendorId = blank(formData.get("vendorId"));
    if (!entityId || !vendorId) throw new ValidationError("Choose the company and the vendor.");

    const c = await createContract(user, {
      entityId,
      vendorId,
      title: String(formData.get("title") ?? ""),
      description: blank(formData.get("description")),
      contractType: (blank(formData.get("contractType")) ?? "SERVICE_CONTRACT") as ContractType,
      contractValue: num(formData.get("contractValue")),
      currency: blank(formData.get("currency")) ?? "PKR",
      startDate: date(formData.get("startDate")),
      endDate: date(formData.get("endDate")),
      noticeDays: num(formData.get("noticeDays")) ?? 60,
      autoRenew: String(formData.get("autoRenew") ?? "") === "true",
      paymentTerms: blank(formData.get("paymentTerms")),
      deliveryLocation: blank(formData.get("deliveryLocation")),
      legalTerms: blank(formData.get("legalTerms")),
      slaTerms: blank(formData.get("slaTerms")),
      prId: blank(formData.get("prId")),
    });

    revalidatePath("/contracts");
    return {
      ok: true,
      data: { id: c.id },
      message: c.committeeRequired
        ? `${c.number} raised. Its value takes it to the committee, whose mandate names contracts specifically.`
        : `${c.number} raised.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function transitionContractAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const contractId = String(formData.get("contractId") ?? "");
    const to = String(formData.get("to") ?? "") as ContractState;
    const c = await transitionContract(user, {
      contractId,
      to,
      reason: blank(formData.get("reason")),
      vendorSignatoryName: blank(formData.get("vendorSignatoryName")),
    });
    revalidatePath(`/contracts/${contractId}`);
    revalidatePath("/contracts");
    return {
      ok: true,
      data: null,
      message: `${c.number} is now ${c.status.replace(/_/g, " ").toLowerCase()}.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function signContractAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const contractId = String(formData.get("contractId") ?? "");
    await signContract(user, { contractId, note: blank(formData.get("reason")) });
    revalidatePath(`/contracts/${contractId}`);
    return {
      ok: true,
      data: null,
      message: "Signed. §4.6's authorised signature is on the record.",
    };
  } catch (e) {
    return toActionError(e);
  }
}
