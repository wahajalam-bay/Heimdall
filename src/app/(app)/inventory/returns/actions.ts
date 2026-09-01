"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import {
  closeEmployeeReturn,
  createEmployeeReturn,
  handOffToRepair,
  inspectEmployeeReturn,
  setDisposition,
  stackEmployeeReturn,
  type Disposition,
  type ReturnCondition,
  type ReturnLineInput,
  type ReturnReason,
} from "@/server/employee-returns";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

export async function createEmployeeReturnAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const storeId = blank(formData.get("storeId"));
    if (!storeId) throw new ValidationError("Choose the store receiving the equipment.");

    const descriptions = formData.getAll("lineDescription").map(String);
    const quantities = formData.getAll("lineQuantity").map(String);
    const units = formData.getAll("lineUnit").map(String);
    const itemIds = formData.getAll("lineItemId").map(String);
    const assetIds = formData.getAll("lineAssetId").map(String);
    const serials = formData.getAll("lineSerial").map(String);
    const conditions = formData.getAll("lineCondition").map(String);
    const conditionNotes = formData.getAll("lineConditionNote").map(String);

    const items: ReturnLineInput[] = descriptions
      .map((description, i) => ({
        description,
        quantity: Number(quantities[i] ?? 1) || 1,
        unit: units[i] || "EA",
        itemId: itemIds[i] || null,
        assetId: assetIds[i] || null,
        serialNumber: serials[i] || null,
        condition: (conditions[i] || "GOOD") as ReturnCondition,
        conditionNotes: conditionNotes[i] || null,
      }))
      .filter((l) => l.description.trim());

    if (!items.length) throw new ValidationError("Add at least one line.");

    const ret = await createEmployeeReturn(user, {
      storeId,
      returnedById: blank(formData.get("returnedById")),
      returnedByName: String(formData.get("returnedByName") ?? ""),
      department: blank(formData.get("department")),
      reason: (blank(formData.get("reason")) ?? "OTHER") as ReturnReason,
      reasonNote: blank(formData.get("reasonNote")),
      receiptNotes: blank(formData.get("receiptNotes")),
      items,
    });

    revalidatePath("/inventory/returns");
    return {
      ok: true,
      data: { id: ret.id },
      message: ret.inspectionRequired
        ? `${ret.number} received. It holds IT equipment, so it goes for inspection before anything is stacked.`
        : `${ret.number} received. No IT equipment, so no inspection applies.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function inspectReturnAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const returnId = String(formData.get("returnId") ?? "");

    const lineIds = formData.getAll("lineId").map(String);
    const verdicts = formData.getAll("verdict").map(String);
    const notes = formData.getAll("verdictNote").map(String);

    const lines = lineIds
      .map((lineId, i) => ({
        lineId,
        verdict: verdicts[i] as "PASS" | "FAIL",
        notes: notes[i] || null,
      }))
      .filter((l) => l.verdict === "PASS" || l.verdict === "FAIL");

    if (!lines.length) throw new ValidationError("Record a verdict on at least one line.");

    await inspectEmployeeReturn(user, {
      returnId,
      lines,
      notes: blank(formData.get("inspectionNotes")),
    });
    revalidatePath(`/inventory/returns/${returnId}`);
    return { ok: true, data: null, message: "Inspection recorded." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function handOffToRepairAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const returnId = String(formData.get("returnId") ?? "");
    await handOffToRepair(user, {
      returnId,
      reference: String(formData.get("reference") ?? ""),
      note: blank(formData.get("note")),
    });
    revalidatePath(`/inventory/returns/${returnId}`);
    return { ok: true, data: null, message: "Hand-off to Repair and Maintenance recorded." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function stackReturnAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const returnId = String(formData.get("returnId") ?? "");
    const { posted, custody } = await stackEmployeeReturn(user, returnId);
    revalidatePath(`/inventory/returns/${returnId}`);
    revalidatePath("/inventory");
    return {
      ok: true,
      data: null,
      message:
        posted || custody
          ? `${posted} line(s) back into stock, ${custody} asset(s) back in store custody.`
          : "Nothing was dispositioned for stacking.",
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function setDispositionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const returnId = String(formData.get("returnId") ?? "");
    await setDisposition(user, {
      returnId,
      lineId: String(formData.get("lineId") ?? ""),
      disposition: String(formData.get("disposition") ?? "STACK") as Disposition,
      note: blank(formData.get("reason")) ?? blank(formData.get("note")),
    });
    revalidatePath(`/inventory/returns/${returnId}`);
    return { ok: true, data: null, message: "Disposition recorded." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function closeReturnAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const returnId = String(formData.get("returnId") ?? "");
    const cancel = String(formData.get("cancel") ?? "") === "true";
    await closeEmployeeReturn(user, { returnId, cancel, reason: blank(formData.get("reason")) });
    revalidatePath(`/inventory/returns/${returnId}`);
    revalidatePath("/inventory/returns");
    return { ok: true, data: null, message: cancel ? "Return cancelled." : "Return closed." };
  } catch (e) {
    return toActionError(e);
  }
}
