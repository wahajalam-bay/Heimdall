"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import {
  adjustStock,
  createStoreIssue,
  createTransfer,
  decideStoreIssue,
  decideTransfer,
  dispatchTransfer,
  issueStock,
  receiveTransfer,
} from "@/server/stores";
import { availableQuantity } from "@/server/inventory";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const s = blank(v);
  return s === null ? null : Number(s);
};

type LinePayload = {
  itemId: string;
  requestedQty: number;
  unit: string;
  serialNumber?: string | null;
  batchNumber?: string | null;
  assetTag?: string | null;
  custodianUserId?: string | null;
  notes?: string | null;
};

function parseLines(formData: FormData, field = "items"): LinePayload[] {
  try {
    const arr = JSON.parse(String(formData.get(field) ?? "[]")) as LinePayload[];
    const clean = arr.filter((l) => l.itemId && Number(l.requestedQty) > 0);
    if (!clean.length) throw new ValidationError("Add at least one line with a quantity.");
    return clean.map((l) => ({
      itemId: l.itemId,
      requestedQty: Number(l.requestedQty),
      unit: l.unit || "EA",
      serialNumber: l.serialNumber ?? null,
      batchNumber: l.batchNumber ?? null,
      assetTag: l.assetTag ?? null,
      custodianUserId: l.custodianUserId ?? null,
      notes: l.notes ?? null,
    }));
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError("Lines could not be read.");
  }
}

/* ── Issuance ─────────────────────────────────────────────── */

export async function createIssueAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const storeId = String(formData.get("storeId") ?? "");
    if (!storeId) throw new ValidationError("Select the issuing store.");
    const recipientName = String(formData.get("recipientName") ?? "").trim();
    if (!recipientName) throw new ValidationError("State who the stock is being issued to.");

    const issue = await createStoreIssue(user, {
      storeId,
      recipientName,
      recipientUserId: blank(formData.get("recipientUserId")),
      departmentId: blank(formData.get("departmentId")),
      projectId: blank(formData.get("projectId")),
      purpose: blank(formData.get("purpose")),
      items: parseLines(formData),
      submit: formData.get("submit") === "true",
    });
    revalidatePath("/issuance");
    return {
      ok: true,
      data: { id: issue.id, number: issue.number },
      message:
        formData.get("submit") === "true"
          ? `${issue.number} submitted for store approval.`
          : `${issue.number} saved as a draft.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function decideIssueAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const issueId = String(formData.get("issueId") ?? "");
    const approve = formData.get("approve") === "true";
    await decideStoreIssue(user, { issueId, approve, reason: blank(formData.get("reason")) });
    revalidatePath(`/issuance/${issueId}`);
    revalidatePath("/issuance");
    return { ok: true, data: null, message: approve ? "Issue approved." : "Issue rejected." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function issueStockAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const issueId = String(formData.get("issueId") ?? "");
    const issue = await issueStock(user, { issueId });
    revalidatePath(`/issuance/${issueId}`);
    revalidatePath("/inventory");
    return {
      ok: true,
      data: null,
      message: `${issue.number} issued. Inventory has been reduced and any asset custody transferred.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Transfers ────────────────────────────────────────────── */

export async function createTransferAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const fromStoreId = String(formData.get("fromStoreId") ?? "");
    const toStoreId = String(formData.get("toStoreId") ?? "");
    if (!fromStoreId || !toStoreId) throw new ValidationError("Select both the source and destination store.");

    const transfer = await createTransfer(user, {
      fromStoreId,
      toStoreId,
      reason: blank(formData.get("reason")),
      items: parseLines(formData).map((l) => ({
        itemId: l.itemId,
        requestedQty: l.requestedQty,
        unit: l.unit,
        batchNumber: l.batchNumber,
        serialNumber: l.serialNumber,
        notes: l.notes,
      })),
      submit: formData.get("submit") === "true",
    });
    revalidatePath("/transfers");
    return {
      ok: true,
      data: { id: transfer.id, number: transfer.number },
      message:
        formData.get("submit") === "true"
          ? `${transfer.number} submitted for approval.`
          : `${transfer.number} saved as a draft.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function decideTransferAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const transferId = String(formData.get("transferId") ?? "");
    const approve = formData.get("approve") === "true";
    await decideTransfer(user, { transferId, approve, reason: blank(formData.get("reason")) });
    revalidatePath(`/transfers/${transferId}`);
    revalidatePath("/transfers");
    return { ok: true, data: null, message: approve ? "Transfer approved." : "Transfer rejected." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function dispatchTransferAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const transferId = String(formData.get("transferId") ?? "");
    const t = await dispatchTransfer(user, {
      transferId,
      vehicleNumber: blank(formData.get("vehicleNumber")),
      gatePassRef: blank(formData.get("gatePassRef")),
    });
    revalidatePath(`/transfers/${transferId}`);
    revalidatePath("/inventory");
    return {
      ok: true,
      data: null,
      message: `${t.number} dispatched. Stock has left the source store and the destination has been notified.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function receiveTransferAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const transferId = String(formData.get("transferId") ?? "");
    const t = await receiveTransfer(user, { transferId, remarks: blank(formData.get("reason")) });
    revalidatePath(`/transfers/${transferId}`);
    revalidatePath("/inventory");
    return { ok: true, data: null, message: `${t.number} received into the destination store.` };
  } catch (e) {
    return toActionError(e);
  }
}

/**
 * Form variant of dispatch, used by the dispatch modal so the storekeeper can
 * capture the vehicle and gate pass reference in the same step.
 */
export async function dispatchTransferFormAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return dispatchTransferAction(formData);
}

/** Form variant of receipt, capturing the receiving storekeeper's remarks. */
export async function receiveTransferFormAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return receiveTransferAction(formData);
}

/* ── Adjustments ──────────────────────────────────────────── */

export async function adjustStockAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const delta = num(formData.get("quantityDelta"));
    if (delta === null || delta === 0) throw new ValidationError("Enter a non-zero adjustment quantity.");
    const txn = await adjustStock(user, {
      itemId: String(formData.get("itemId") ?? ""),
      storeId: String(formData.get("storeId") ?? ""),
      quantityDelta: delta,
      unit: String(formData.get("unit") ?? "EA"),
      batchNumber: blank(formData.get("batchNumber")),
      serialNumber: blank(formData.get("serialNumber")),
      reason: String(formData.get("reason") ?? ""),
    });
    revalidatePath("/inventory");
    return {
      ok: true,
      data: null,
      message: `Adjustment ${txn.number} recorded — balance is now ${txn.balanceAfter}.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Options ──────────────────────────────────────────────── */

export async function storeOptions(entityId: string | null) {
  const user = await requireUser();
  const [stores, items, departments, projects, users] = await Promise.all([
    prisma.store.findMany({
      where: { active: true, ...(entityId ? { entityId } : { entityId: { in: user.entityIds } }) },
      select: { id: true, code: true, name: true, kind: true, entityId: true },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    }),
    prisma.item.findMany({
      where: { active: true },
      select: { id: true, sku: true, name: true, unit: true, category: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.department.findMany({
      where: { active: true, ...(entityId ? { entityId } : {}) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.project.findMany({
      where: { status: "Active", ...(entityId ? { entityId } : {}) },
      select: { id: true, code: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.user.findMany({
      where: { active: true },
      select: { id: true, name: true, title: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return { stores, items, departments, projects, users };
}

/** Live availability for a store, used by the issue and transfer editors. */
export async function stockForStore(storeId: string) {
  await requireUser();
  const rows = await prisma.inventoryItem.findMany({
    where: { storeId, quantity: { gt: 0 } },
    include: { item: { select: { id: true, sku: true, name: true, unit: true, trackSerial: true, trackBatch: true } } },
    orderBy: { item: { name: "asc" } },
  });
  const byItem = new Map<
    string,
    { itemId: string; sku: string; name: string; unit: string; available: number; trackSerial: boolean; trackBatch: boolean; batches: string[] }
  >();
  for (const r of rows) {
    const cur = byItem.get(r.itemId) ?? {
      itemId: r.itemId,
      sku: r.item.sku,
      name: r.item.name,
      unit: r.unit || r.item.unit,
      available: 0,
      trackSerial: r.item.trackSerial,
      trackBatch: r.item.trackBatch,
      batches: [] as string[],
    };
    cur.available += r.quantity - r.reservedQty;
    if (r.batchNumber && !cur.batches.includes(r.batchNumber)) cur.batches.push(r.batchNumber);
    byItem.set(r.itemId, cur);
  }
  return [...byItem.values()].map((v) => ({ ...v, available: Math.round(v.available * 100) / 100 }));
}

export async function checkAvailability(itemId: string, storeId: string) {
  await requireUser();
  return availableQuantity(itemId, storeId);
}
