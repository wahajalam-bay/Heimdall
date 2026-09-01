"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/errors";
import { performControl, waiveControl } from "@/server/controls";
import { acknowledgeException } from "@/server/controls";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

export async function performControlAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await performControl(user, {
      runId: String(formData.get("runId") ?? ""),
      evidenceRef: blank(formData.get("evidenceRef")),
      notes: blank(formData.get("notes")),
    });
    revalidatePath("/analytics/controls");
    return { ok: true, data: null, message: "Control recorded as performed." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function waiveControlAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const notApplicable = String(formData.get("notApplicable") ?? "") === "true";
    await waiveControl(user, {
      runId: String(formData.get("runId") ?? ""),
      reason: String(formData.get("reason") ?? ""),
      notApplicable,
    });
    revalidatePath("/analytics/controls");
    return {
      ok: true,
      data: null,
      message: notApplicable
        ? "Recorded as not applicable for this period."
        : "Waived for this period, with the reason on the record.",
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function acknowledgeExceptionAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await acknowledgeException(user, {
      exceptionId: String(formData.get("exceptionId") ?? ""),
      note: blank(formData.get("reason")),
    });
    revalidatePath("/analytics/exceptions");
    return {
      ok: true,
      data: null,
      message: "Acknowledged. It will not escalate while you are on it.",
    };
  } catch (e) {
    return toActionError(e);
  }
}
