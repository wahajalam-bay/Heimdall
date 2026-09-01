"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import {
  createLossReport,
  transitionLossReport,
  writeOffLoss,
  type LossLineInput,
  type LossState,
  type LossType,
} from "@/server/loss-reports";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const date = (v: FormDataEntryValue | null) => {
  const raw = blank(v);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

export async function createLossReportAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const entityId = blank(formData.get("entityId"));
    if (!entityId) throw new ValidationError("No company was named.");
    const discovered = date(formData.get("discoveredOn"));
    if (!discovered) throw new ValidationError("When was it discovered?");

    const descriptions = formData.getAll("lineDescription").map(String);
    const quantities = formData.getAll("lineQuantity").map(String);
    const units = formData.getAll("lineUnit").map(String);
    const itemIds = formData.getAll("lineItemId").map(String);
    const assetIds = formData.getAll("lineAssetId").map(String);
    const serials = formData.getAll("lineSerial").map(String);
    const values = formData.getAll("lineUnitValue").map(String);

    const items: LossLineInput[] = descriptions
      .map((description, i) => ({
        description,
        quantity: Number(quantities[i] ?? 1) || 1,
        unit: units[i] || "EA",
        itemId: itemIds[i] || null,
        assetId: assetIds[i] || null,
        serialNumber: serials[i] || null,
        unitValue: values[i] ? Number(values[i]) : null,
      }))
      .filter((l) => l.description.trim());

    if (!items.length) throw new ValidationError("List what is missing.");

    const r = await createLossReport(user, {
      entityId,
      storeId: blank(formData.get("storeId")),
      lossType: (blank(formData.get("lossType")) ?? "SHORTAGE_UNEXPLAINED") as LossType,
      title: String(formData.get("title") ?? ""),
      description: String(formData.get("description") ?? ""),
      occurredOn: date(formData.get("occurredOn")),
      discoveredOn: discovered,
      discoveryRoute: blank(formData.get("discoveryRoute")),
      policeReported: String(formData.get("policeReported") ?? "") === "true",
      policeReference: blank(formData.get("policeReference")),
      suspicionNote: blank(formData.get("suspicionNote")),
      items,
      submit: true,
    });

    revalidatePath("/inventory/losses");
    return {
      ok: true,
      data: { id: r.id },
      message: `${r.number} filed. Nothing has come off the ledger — that happens once the case is substantiated.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function transitionLossAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const reportId = String(formData.get("reportId") ?? "");
    const to = String(formData.get("to") ?? "") as LossState;
    // Conclusions post their findings through the reason field; cancellations
    // post their reason there too. Both are the same box on the screen.
    const note = blank(formData.get("reason"));
    const r = await transitionLossReport(user, {
      reportId,
      to,
      findings: ["SUBSTANTIATED", "UNSUBSTANTIATED"].includes(to) ? note : null,
      reason: note,
    });
    revalidatePath(`/inventory/losses/${reportId}`);
    revalidatePath("/inventory/losses");
    return {
      ok: true,
      data: null,
      message: `${r.number} is now ${r.status.replace(/_/g, " ").toLowerCase()}.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function writeOffLossAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const reportId = String(formData.get("reportId") ?? "");
    const { posted, flagged, writtenOff } = await writeOffLoss(user, reportId);
    revalidatePath(`/inventory/losses/${reportId}`);
    revalidatePath("/inventory");
    return {
      ok: true,
      data: null,
      message: `${posted} ledger adjustment(s) posted and ${flagged} asset(s) marked lost — ${writtenOff.toLocaleString("en-PK")} written off.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}
