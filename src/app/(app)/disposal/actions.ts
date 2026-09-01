"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import {
  recordFarUpdate,
  recordFinanceValuation,
  recordInsignificantValue,
  recordPhysicalInspection,
  recordWitness,
  type DisposalWitnessFunction,
} from "@/server/disposal-evidence";

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

export async function recordPhysicalInspectionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    await recordPhysicalInspection(user, {
      caseId,
      report: String(formData.get("report") ?? ""),
    });
    revalidatePath(`/disposal/${caseId}`);
    return { ok: true, data: null, message: "Physical inspection report recorded." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function recordFinanceValuationAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    const nbv = num(formData.get("netBookValue"));
    const residual = num(formData.get("residualValue"));
    if (nbv === null || residual === null) {
      throw new ValidationError("Enter both the depreciated value and the residual value.");
    }
    await recordFinanceValuation(user, {
      caseId,
      netBookValue: nbv,
      residualValue: residual,
      notes: blank(formData.get("notes")),
    });
    revalidatePath(`/disposal/${caseId}`);
    return { ok: true, data: null, message: "Finance valuation recorded." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function recordInsignificantValueAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    const businessHeadId = blank(formData.get("businessHeadId"));
    if (!businessHeadId) throw new ValidationError("Name the business head consulted.");
    await recordInsignificantValue(user, {
      caseId,
      businessHeadId,
      justification: String(formData.get("justification") ?? ""),
    });
    revalidatePath(`/disposal/${caseId}`);
    return {
      ok: true,
      data: null,
      message: "Recorded. The committee route is replaced by the consultation, and both are on the record.",
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function recordWitnessAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    await recordWitness(user, {
      caseId,
      function: String(formData.get("function") ?? "") as DisposalWitnessFunction,
      userId: blank(formData.get("userId")),
      name: blank(formData.get("name")),
      designation: blank(formData.get("designation")),
      notes: blank(formData.get("notes")),
    });
    revalidatePath(`/disposal/${caseId}`);
    return { ok: true, data: null, message: "Witness recorded." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function recordFarUpdateAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    await recordFarUpdate(user, {
      caseId,
      reference: String(formData.get("reference") ?? ""),
      writeOffAmount: num(formData.get("writeOffAmount")),
    });
    revalidatePath(`/disposal/${caseId}`);
    return { ok: true, data: null, message: "FAR update recorded." };
  } catch (e) {
    return toActionError(e);
  }
}
