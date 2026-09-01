"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/errors";
import { setApplicability, verifyPackItem, waivePackItem } from "@/server/payment-pack";

/**
 * The three things a person can do to a payment pack item.
 *
 * Attaching a document is not one of them — that goes through the documents
 * panel, and the pack picks it up. What is left is the judgement: whether a
 * conditional requirement bites, whether the document has actually been looked
 * at, and whether a mandatory one is being released without it.
 */

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

type Target = {
  documentType: "INVOICE" | "PETTY_CASH";
  documentId: string;
  documentTypeCode: string;
};

function target(formData: FormData): Target {
  return {
    documentType: String(formData.get("packDocumentType") ?? "INVOICE") as Target["documentType"],
    documentId: String(formData.get("packDocumentId") ?? ""),
    documentTypeCode: String(formData.get("documentTypeCode") ?? ""),
  };
}

function touch(t: Target) {
  const base = t.documentType === "INVOICE" ? "/invoices" : "/petty-cash";
  revalidatePath(base);
  revalidatePath(`${base}/${t.documentId}`);
}

export async function verifyPackItemAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const t = target(formData);
    await verifyPackItem(user, t);
    touch(t);
    return { ok: true, data: null, message: "Marked as checked, against your name." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function setPackApplicabilityAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const t = target(formData);
    const applicable = String(formData.get("applicable") ?? "") === "true";
    await setApplicability(user, {
      ...t,
      applicable,
      note: blank(formData.get("reason")),
    });
    touch(t);
    return {
      ok: true,
      data: null,
      message: applicable
        ? "Marked as required for this payment."
        : "Marked as not applicable, with your note on the record.",
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function waivePackItemAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const t = target(formData);
    await waivePackItem(user, { ...t, reason: String(formData.get("reason") ?? "") });
    touch(t);
    return {
      ok: true,
      data: null,
      message: "Released with a recorded exception. It shows on the pack as waived, not as supplied.",
    };
  } catch (e) {
    return toActionError(e);
  }
}
