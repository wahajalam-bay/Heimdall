"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission, requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import type { AssetStatus, DisposalStage } from "@/lib/domain";
import {
  addDisposalBid,
  advanceDisposal,
  createDisposalCase,
  tagAssetsFromGrn,
  updateAsset,
  type DisposalItemInput,
} from "@/server/assets";
import { PERMISSIONS as P } from "@/lib/permissions";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const s = blank(v);
  return s === null ? null : Number(s);
};

/* ── Assets ───────────────────────────────────────────────── */

export async function updateAssetAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const assetId = String(formData.get("assetId") ?? "");
    const reason = blank(formData.get("reason"));
    if (!reason) throw new ValidationError("Record why this asset is changing.");
    const asset = await updateAsset(
      user,
      assetId,
      {
        status: (blank(formData.get("status")) ?? undefined) as AssetStatus | undefined,
        custodianId: formData.has("custodianId") ? blank(formData.get("custodianId")) : undefined,
        location: formData.has("location") ? blank(formData.get("location")) : undefined,
        office: formData.has("office") ? blank(formData.get("office")) : undefined,
        departmentId: formData.has("departmentId") ? blank(formData.get("departmentId")) : undefined,
        conditionNotes: formData.has("conditionNotes") ? blank(formData.get("conditionNotes")) : undefined,
        currentValue: formData.has("currentValue") ? num(formData.get("currentValue")) : undefined,
      },
      reason,
    );
    revalidatePath("/assets");
    revalidatePath(`/assets/${assetId}`);
    return { ok: true, data: null, message: `${asset.tag} updated.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function tagFromGrnAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission(P.ASSET_MANAGE);
    const grnId = String(formData.get("grnId") ?? "");
    const assets = await tagAssetsFromGrn(user, grnId);
    revalidatePath("/assets");
    revalidatePath(`/grn/${grnId}`);
    return {
      ok: true,
      data: null,
      message: assets.length
        ? `${assets.length} asset(s) tagged and added to the register.`
        : "No asset-tracked items were found on this receipt.",
    };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Disposal ─────────────────────────────────────────────── */

export async function createDisposalAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const entityId = String(formData.get("entityId") ?? "");
    const title = String(formData.get("title") ?? "").trim();
    if (!entityId) throw new ValidationError("Select the entity that owns these items.");
    if (!title) throw new ValidationError("Give the case a title.");

    let items: DisposalItemInput[];
    try {
      items = JSON.parse(String(formData.get("items") ?? "[]")) as DisposalItemInput[];
    } catch {
      throw new ValidationError("Disposal lines could not be read.");
    }
    items = items.filter((i) => i.description?.trim() && Number(i.quantity) > 0);
    if (!items.length) throw new ValidationError("Add at least one item with a quantity.");

    const kase = await createDisposalCase(user, {
      entityId,
      title,
      disposalCategory: String(formData.get("disposalCategory") ?? "OTHER"),
      recommendedAction: blank(formData.get("recommendedAction")),
      assessmentNotes: blank(formData.get("assessmentNotes")),
      estimatedValue: num(formData.get("estimatedValue")),
      items: items.map((i) => ({
        assetId: i.assetId || null,
        itemId: i.itemId || null,
        storeId: i.storeId || null,
        description: i.description.trim(),
        quantity: Number(i.quantity),
        unit: i.unit || "EA",
        condition: i.condition || "OBSOLETE",
        bookValue: i.bookValue === null || i.bookValue === undefined ? null : Number(i.bookValue),
        estimatedValue:
          i.estimatedValue === null || i.estimatedValue === undefined ? null : Number(i.estimatedValue),
        notes: i.notes ?? null,
      })),
    });
    revalidatePath("/disposal");
    return {
      ok: true,
      data: { id: kase.id, number: kase.number },
      message: `${kase.number} raised. Assessment and audit review come before any approval to dispose.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function advanceDisposalAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    const to = String(formData.get("to") ?? "") as DisposalStage;
    if (!to) throw new ValidationError("Select the stage to move to.");
    const deadlineRaw = blank(formData.get("bidDeadline"));
    const kase = await advanceDisposal(user, caseId, to, {
      notes: blank(formData.get("notes")),
      finalAction: blank(formData.get("finalAction")),
      assessmentNotes: blank(formData.get("assessmentNotes")),
      auditNotes: blank(formData.get("auditNotes")),
      bidDeadline: deadlineRaw ? new Date(deadlineRaw) : null,
      winningBidId: blank(formData.get("winningBidId")),
      paymentReference: blank(formData.get("paymentReference")),
      realisedValue: num(formData.get("realisedValue")),
    });
    revalidatePath("/disposal");
    revalidatePath(`/disposal/${caseId}`);
    revalidatePath("/assets");
    revalidatePath("/inventory");
    return { ok: true, data: null, message: `${kase.number} moved to ${to.replace(/_/g, " ").toLowerCase()}.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function addBidAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    const amount = num(formData.get("amount"));
    if (amount === null) throw new ValidationError("Enter the bid amount.");
    const bid = await addDisposalBid(user, {
      caseId,
      bidderName: String(formData.get("bidderName") ?? ""),
      vendorId: blank(formData.get("vendorId")),
      contactPhone: blank(formData.get("contactPhone")),
      amount,
      notes: blank(formData.get("notes")),
    });
    revalidatePath(`/disposal/${caseId}`);
    return { ok: true, data: null, message: `Bid from ${bid.bidderName} recorded.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Options ──────────────────────────────────────────────── */

export async function assetOptions(entityId: string | null) {
  const user = await requireUser();
  const scope = entityId ? { entityId } : { entityId: { in: user.entityIds } };
  const [entities, departments, users] = await Promise.all([
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
    prisma.user.findMany({
      where: { active: true },
      select: { id: true, name: true, title: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return { entities, departments, users };
}

/** Assets and slow stock a disposal case can legitimately be raised against. */
export async function disposalCandidates(entityId: string | null) {
  const user = await requireUser();
  const scope = entityId ? { entityId } : { entityId: { in: user.entityIds } };
  const [assets, stock, vendors, entities] = await Promise.all([
    prisma.asset.findMany({
      where: { status: { in: ["IDLE", "OBSOLETE", "UNDER_REPAIR", "IN_STORAGE", "LOST"] }, ...scope },
      select: {
        id: true,
        tag: true,
        name: true,
        status: true,
        cost: true,
        currentValue: true,
        entityId: true,
        category: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 400,
    }),
    prisma.inventoryItem.findMany({
      where: { quantity: { gt: 0 }, store: scope },
      select: {
        id: true,
        quantity: true,
        unit: true,
        unitCost: true,
        itemId: true,
        storeId: true,
        item: { select: { sku: true, name: true, unit: true } },
        store: { select: { name: true, entityId: true } },
      },
      orderBy: { item: { name: "asc" } },
      take: 500,
    }),
    prisma.vendor.findMany({
      where: { status: { in: ["APPROVED", "CONDITIONAL"] } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.entity.findMany({
      where: { active: true, id: { in: user.entityIds } },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);
  return { assets, stock, vendors, entities };
}
