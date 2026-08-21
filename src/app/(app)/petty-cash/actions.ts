"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import {
  addPettyCashQuote,
  approvePettyCash,
  beginQuoteCollection,
  closePettyCash,
  completeStoreEntry,
  createPettyCash,
  generateVoucher,
  recordPurchase,
  reconcilePettyCash,
  selectPettyCashQuote,
  signVoucher,
  submitPettyCash,
} from "@/server/pettycash";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const s = blank(v);
  return s === null ? null : Number(s);
};

function touch(id?: string) {
  revalidatePath("/petty-cash");
  if (id) revalidatePath(`/petty-cash/${id}`);
}

/* ── Request ──────────────────────────────────────────────── */

type ItemPayload = {
  itemId?: string | null;
  description: string;
  quantity: number;
  unit: string;
  estimatedUnitPrice?: number | null;
  disposition?: string;
};

function parseItems(formData: FormData): ItemPayload[] {
  let arr: ItemPayload[];
  try {
    arr = JSON.parse(String(formData.get("items") ?? "[]")) as ItemPayload[];
  } catch {
    throw new ValidationError("Lines could not be read.");
  }
  const clean = arr.filter((l) => l.description?.trim() && Number(l.quantity) > 0);
  if (!clean.length) throw new ValidationError("Add at least one line with a description and quantity.");
  return clean.map((l) => ({
    itemId: l.itemId || null,
    description: l.description.trim(),
    quantity: Number(l.quantity),
    unit: l.unit || "EA",
    estimatedUnitPrice: l.estimatedUnitPrice === null || l.estimatedUnitPrice === undefined ? null : Number(l.estimatedUnitPrice),
    disposition: (l.disposition || "EXPENSE") as ItemPayload["disposition"],
  }));
}

export async function createPettyCashAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const entityId = String(formData.get("entityId") ?? "");
    const departmentId = String(formData.get("departmentId") ?? "");
    const purpose = String(formData.get("purpose") ?? "").trim();
    if (!entityId) throw new ValidationError("Select the entity this spend belongs to.");
    if (!departmentId) throw new ValidationError("Select the requesting department.");
    if (!purpose) throw new ValidationError("State the purpose of this cash purchase.");

    const requiredDate = blank(formData.get("requiredDate"));
    const pc = await createPettyCash(user, {
      entityId,
      departmentId,
      purpose,
      justification: blank(formData.get("justification")),
      requiredDate: requiredDate ? new Date(requiredDate) : null,
      storeId: blank(formData.get("storeId")),
      items: parseItems(formData).map((l) => ({
        itemId: l.itemId,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        estimatedUnitPrice: l.estimatedUnitPrice,
        disposition: (l.disposition ?? "EXPENSE") as never,
      })),
    });

    if (formData.get("submit") === "true") {
      await submitPettyCash(user, pc.id);
    }
    touch(pc.id);
    return {
      ok: true,
      data: { id: pc.id, number: pc.number },
      message:
        formData.get("submit") === "true"
          ? `${pc.number} submitted for evaluation.`
          : `${pc.number} saved as a draft.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function submitPettyCashAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = String(formData.get("requestId") ?? "");
    const pc = await submitPettyCash(user, id);
    touch(id);
    return { ok: true, data: null, message: `${pc.number} submitted for evaluation.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function beginQuotesAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = String(formData.get("requestId") ?? "");
    await beginQuoteCollection(user, id);
    touch(id);
    return { ok: true, data: null, message: "Market quote collection started." };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Quotes ───────────────────────────────────────────────── */

export async function addQuoteAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const requestId = String(formData.get("requestId") ?? "");
    const amount = num(formData.get("amount"));
    if (amount === null) throw new ValidationError("Enter the quoted amount.");
    const q = await addPettyCashQuote(user, {
      requestId,
      vendorName: String(formData.get("vendorName") ?? ""),
      vendorId: blank(formData.get("vendorId")),
      channel: String(formData.get("channel") ?? "PHYSICAL"),
      contactRef: blank(formData.get("contactRef")),
      amount,
      taxIncluded: formData.get("taxIncluded") === "on" || formData.get("taxIncluded") === "true",
      deliveryDays: num(formData.get("deliveryDays")),
      notes: blank(formData.get("notes")),
    });
    touch(requestId);
    return { ok: true, data: null, message: `Quote from ${q.vendorName} recorded.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function selectQuoteAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const requestId = String(formData.get("requestId") ?? "");
    const quoteId = String(formData.get("quoteId") ?? "");
    if (!quoteId) throw new ValidationError("Select the winning quote.");
    const chosen = await selectPettyCashQuote(user, {
      requestId,
      quoteId,
      justification: blank(formData.get("justification")),
    });
    touch(requestId);
    return {
      ok: true,
      data: null,
      message: `${chosen.vendorName} selected — the request is now awaiting approval.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Approval and purchase ────────────────────────────────── */

export async function decidePettyCashAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const requestId = String(formData.get("requestId") ?? "");
    const approve = formData.get("approve") === "true";
    await approvePettyCash(user, {
      requestId,
      approve,
      reason: blank(formData.get("reason")),
      approvedAmount: num(formData.get("approvedAmount")),
    });
    touch(requestId);
    return { ok: true, data: null, message: approve ? "Cash purchase approved." : "Request rejected." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function recordPurchaseAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const requestId = String(formData.get("requestId") ?? "");
    const actualAmount = num(formData.get("actualAmount"));
    if (actualAmount === null) throw new ValidationError("Enter the amount actually spent.");
    const vendor = String(formData.get("purchasedFromVendor") ?? "").trim();
    if (!vendor) throw new ValidationError("Record who the purchase was made from.");

    let lineAmounts: Record<string, number> | undefined;
    const raw = blank(formData.get("lineAmounts"));
    if (raw) {
      try {
        lineAmounts = JSON.parse(raw) as Record<string, number>;
      } catch {
        throw new ValidationError("Line amounts could not be read.");
      }
    }

    const pc = await recordPurchase(user, {
      requestId,
      actualAmount,
      purchasedFromVendor: vendor,
      receiptRef: blank(formData.get("receiptRef")),
      lineAmounts,
    });
    touch(requestId);
    return { ok: true, data: null, message: `Purchase recorded against ${pc.number}.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Voucher ──────────────────────────────────────────────── */

export async function generateVoucherAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const requestId = String(formData.get("requestId") ?? "");
    const v = await generateVoucher(user, requestId);
    touch(requestId);
    return { ok: true, data: null, message: `Voucher ${v.number} generated and sent to the signatory.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function signVoucherAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const voucherId = String(formData.get("voucherId") ?? "");
    const approve = formData.get("approve") === "true";
    const v = await signVoucher(user, { voucherId, approve, notes: blank(formData.get("reason")) });
    touch(String(formData.get("requestId") ?? "") || undefined);
    return {
      ok: true,
      data: null,
      message: approve ? `Voucher ${v.number} signed.` : `Voucher ${v.number} rejected.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Store entry, reconciliation, closure ─────────────────── */

export async function completeStoreEntryAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const requestId = String(formData.get("requestId") ?? "");
    const storeId = String(formData.get("storeId") ?? "");
    if (!storeId) throw new ValidationError("Select the store the goods were entered into.");

    let lines: Array<{ pettyCashItemId: string; itemId: string; quantity: number; unitCost: number; locationId?: string | null }>;
    try {
      lines = JSON.parse(String(formData.get("lines") ?? "[]"));
    } catch {
      throw new ValidationError("Store entry lines could not be read.");
    }
    lines = lines.filter((l) => l.pettyCashItemId && l.itemId && Number(l.quantity) > 0);
    if (!lines.length) throw new ValidationError("Record at least one store entry line with a catalogue item.");

    await completeStoreEntry(user, {
      requestId,
      storeId,
      lines: lines.map((l) => ({
        pettyCashItemId: l.pettyCashItemId,
        itemId: l.itemId,
        quantity: Number(l.quantity),
        unitCost: Number(l.unitCost) || 0,
        locationId: l.locationId || null,
      })),
    });
    touch(requestId);
    revalidatePath("/inventory");
    return { ok: true, data: null, message: "Store entry recorded — the goods are now in inventory." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function reconcileAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const requestId = String(formData.get("requestId") ?? "");
    const pc = await reconcilePettyCash(user, requestId, blank(formData.get("reason")));
    touch(requestId);
    return { ok: true, data: null, message: `${pc.number} reconciled.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function closePettyCashAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const requestId = String(formData.get("requestId") ?? "");
    const pc = await closePettyCash(user, requestId);
    touch(requestId);
    return { ok: true, data: null, message: `${pc.number} closed.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Options ──────────────────────────────────────────────── */

export async function pettyCashOptions(entityId: string | null) {
  const user = await requireUser();
  const scope = entityId ? { entityId } : { entityId: { in: user.entityIds } };
  const [entities, departments, stores, items, vendors] = await Promise.all([
    prisma.entity.findMany({
      where: { active: true, id: { in: user.entityIds } },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    prisma.department.findMany({
      where: { active: true, ...scope },
      select: { id: true, name: true, entityId: true },
      orderBy: { name: "asc" },
    }),
    prisma.store.findMany({
      where: { active: true, ...scope },
      select: { id: true, code: true, name: true, kind: true, entityId: true },
      orderBy: { name: "asc" },
    }),
    prisma.item.findMany({
      where: { active: true },
      select: { id: true, sku: true, name: true, unit: true },
      orderBy: { name: "asc" },
    }),
    prisma.vendor.findMany({
      where: { status: { in: ["APPROVED", "CONDITIONAL"] } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return { entities, departments, stores, items, vendors };
}
