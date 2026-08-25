"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import {
  cancelRequirement,
  createRequirement,
  decideFulfilment,
  runStockCheck,
  submitRequirement,
} from "@/server/requirements";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const s = blank(v);
  return s === null ? null : Number(s);
};

function touch(id?: string) {
  revalidatePath("/requirements");
  revalidatePath("/issuance");
  revalidatePath("/pr");
  if (id) revalidatePath(`/requirements/${id}`);
}

type LinePayload = {
  itemId?: string | null;
  categoryId?: string | null;
  description: string;
  specification?: string | null;
  quantity: number;
  unit: string;
  estimatedUnitCost?: number | null;
};

function parseLines(formData: FormData): LinePayload[] {
  let arr: LinePayload[];
  try {
    arr = JSON.parse(String(formData.get("items") ?? "[]")) as LinePayload[];
  } catch {
    throw new ValidationError("The lines could not be read.");
  }
  const clean = arr.filter((l) => l.description?.trim() && Number(l.quantity) > 0);
  if (!clean.length) throw new ValidationError("Add at least one line with a description and a quantity.");
  return clean.map((l) => ({
    itemId: l.itemId || null,
    categoryId: l.categoryId || null,
    description: l.description.trim(),
    specification: l.specification?.trim() || null,
    quantity: Number(l.quantity),
    unit: l.unit || "EA",
    estimatedUnitCost:
      l.estimatedUnitCost === null || l.estimatedUnitCost === undefined ? null : Number(l.estimatedUnitCost),
  }));
}

export async function createRequirementAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const entityId = String(formData.get("entityId") ?? "");
    const departmentId = String(formData.get("departmentId") ?? "");
    const title = String(formData.get("title") ?? "").trim();
    const requiredDate = blank(formData.get("requiredDate"));
    if (!entityId) throw new ValidationError("Select the entity this requirement belongs to.");
    if (!departmentId) throw new ValidationError("Select the requesting department.");
    if (!title) throw new ValidationError("Give the requirement a title.");
    if (!requiredDate) throw new ValidationError("State the date the goods are needed by.");

    const submit = formData.get("submit") === "true";
    const requirement = await createRequirement(user, {
      entityId,
      departmentId,
      title,
      purpose: blank(formData.get("purpose")),
      justification: blank(formData.get("justification")),
      priority: String(formData.get("priority") ?? "NORMAL"),
      requiredDate: new Date(requiredDate),
      siteId: blank(formData.get("siteId")),
      projectId: blank(formData.get("projectId")),
      storeId: blank(formData.get("storeId")),
      costCenter: blank(formData.get("costCenter")),
      expenditureType: String(formData.get("expenditureType") ?? "OPEX"),
      items: parseLines(formData),
      submit,
    });

    touch(requirement.id);
    return {
      ok: true,
      data: { id: requirement.id, number: requirement.number },
      message: submit
        ? `${requirement.number} submitted. Stock will be checked before anything is bought.`
        : `${requirement.number} saved as a draft.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function submitRequirementAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = String(formData.get("id") ?? "");
    const r = await submitRequirement(user, id);
    touch(id);
    return { ok: true, data: null, message: `${r.number} submitted.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function checkStockAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = String(formData.get("id") ?? "");
    const result = await runStockCheck(user, id);
    touch(id);
    const covered = result.lines.filter((l) => l.procureQty <= 0).length;
    const partial = result.lines.filter((l) => l.fromStockQty > 0 && l.procureQty > 0).length;
    const none = result.lines.filter((l) => l.fromStockQty <= 0).length;
    return {
      ok: true,
      data: null,
      message: `Stock checked: ${covered} line(s) fully available, ${partial} partly, ${none} not in stock.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function decideFulfilmentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = String(formData.get("id") ?? "");
    let lines: Array<{ requirementItemId: string; fromStockQty: number; procureQty: number; sourceStoreId?: string | null }>;
    try {
      lines = JSON.parse(String(formData.get("lines") ?? "[]"));
    } catch {
      throw new ValidationError("The allocation could not be read.");
    }
    if (!lines.length) throw new ValidationError("Allocate at least one line.");

    const outcome = await decideFulfilment(user, id, {
      lines: lines.map((l) => ({
        requirementItemId: String(l.requirementItemId),
        fromStockQty: Number(l.fromStockQty) || 0,
        procureQty: Number(l.procureQty) || 0,
        sourceStoreId: l.sourceStoreId || null,
      })),
      note: blank(formData.get("note")),
    });

    touch(id);
    const parts = [
      outcome.storeIssueNumber && `store requisition ${outcome.storeIssueNumber}`,
      outcome.requisitionNumber && `purchase requisition ${outcome.requisitionNumber}`,
    ].filter(Boolean);
    return {
      ok: true,
      data: outcome as unknown as Record<string, unknown>,
      message: `Routed to ${parts.join(" and ")}${outcome.reservedLines ? `, holding stock on ${outcome.reservedLines} line(s)` : ""}.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function cancelRequirementAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = String(formData.get("id") ?? "");
    const reason = String(formData.get("reason") ?? "");
    const r = await cancelRequirement(user, id, reason);
    touch(id);
    return { ok: true, data: null, message: `${r.number} cancelled and any held stock released.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Options for the form ─────────────────────────────────── */

export async function requirementOptions(entityId: string | null) {
  const user = await requireUser();
  const scope = entityId ? { entityId } : { entityId: { in: user.entityIds } };
  const [entities, departments, stores, sites, projects, items, categories] = await Promise.all([
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
      select: { id: true, code: true, name: true, entityId: true },
      orderBy: { code: "asc" },
    }),
    prisma.site.findMany({
      where: { ...scope },
      select: { id: true, name: true, entityId: true },
      orderBy: { name: "asc" },
    }),
    prisma.project.findMany({
      where: { ...scope },
      select: { id: true, code: true, name: true, entityId: true },
      orderBy: { code: "asc" },
    }),
    prisma.item.findMany({
      where: { active: true },
      select: { id: true, sku: true, name: true, unit: true, categoryId: true },
      orderBy: { name: "asc" },
    }),
    prisma.category.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);
  return { entities, departments, stores, sites, projects, items, categories };
}
