"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { ForbiddenError, NotFoundError, toActionError, type ActionResult, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { notify } from "@/lib/notify";
import { writeAudit } from "@/lib/audit";
import { DISPOSITIONS, PRIORITIES, PROCUREMENT_TYPES } from "@/lib/domain";
import {
  cancelPr,
  createPr,
  decidePr,
  holdPr,
  releaseHold,
  startSourcing,
  submitPr,
  updatePr,
  validateForSubmission,
  type PrItemInput,
} from "@/server/pr";
import { uploadDocument } from "@/server/documents";

/** Requisition line items arrive as a JSON payload from the line editor. */
const itemSchema = z.object({
  itemId: z.string().optional().nullable(),
  categoryId: z.string().min(1, "Category is required"),
  description: z.string().trim().min(1, "Description is required"),
  brand: z.string().trim().optional().nullable(),
  model: z.string().trim().optional().nullable(),
  make: z.string().trim().optional().nullable(),
  specification: z.string().trim().optional().nullable(),
  quantity: z.coerce.number().positive("Quantity must be greater than zero"),
  unit: z.string().trim().min(1, "Unit is required"),
  estimatedUnitPrice: z.coerce.number().min(0).optional().nullable(),
  disposition: z.enum(DISPOSITIONS).optional(),
  notes: z.string().trim().optional().nullable(),
});

const prSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  departmentId: z.string().min(1, "Department is required"),
  procurementType: z.enum(PROCUREMENT_TYPES),
  procurementKind: z.enum(["GOODS", "SERVICES"]).default("GOODS"),
  title: z.string().trim().min(4, "Give the requisition a descriptive title"),
  justification: z.string().trim().optional().nullable(),
  projectId: z.string().optional().nullable(),
  siteId: z.string().optional().nullable(),
  costCenter: z.string().trim().optional().nullable(),
  deliveryStoreId: z.string().optional().nullable(),
  deliveryLocationNote: z.string().trim().optional().nullable(),
  requiredDate: z.string().min(1, "Required delivery date is required"),
  priority: z.enum(PRIORITIES).optional(),
  budgetAmount: z.coerce.number().min(0).optional().nullable(),
  budgetCode: z.string().trim().optional().nullable(),
  pmOwnerId: z.string().optional().nullable(),
  boqReference: z.string().trim().optional().nullable(),
  drawingReference: z.string().trim().optional().nullable(),
  technicalNotes: z.string().trim().optional().nullable(),
  items: z.string().min(2, "Add at least one requisition line"),
});

function blank(v: FormDataEntryValue | null): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
}

function parsePr(formData: FormData) {
  const raw = {
    entityId: String(formData.get("entityId") ?? ""),
    departmentId: String(formData.get("departmentId") ?? ""),
    procurementType: String(formData.get("procurementType") ?? "ON_DEMAND"),
    procurementKind: String(formData.get("procurementKind") ?? "GOODS"),
    title: String(formData.get("title") ?? ""),
    justification: blank(formData.get("justification")),
    projectId: blank(formData.get("projectId")),
    siteId: blank(formData.get("siteId")),
    costCenter: blank(formData.get("costCenter")),
    deliveryStoreId: blank(formData.get("deliveryStoreId")),
    deliveryLocationNote: blank(formData.get("deliveryLocationNote")),
    requiredDate: String(formData.get("requiredDate") ?? ""),
    priority: String(formData.get("priority") ?? "NORMAL"),
    budgetAmount: blank(formData.get("budgetAmount")),
    budgetCode: blank(formData.get("budgetCode")),
    pmOwnerId: blank(formData.get("pmOwnerId")),
    boqReference: blank(formData.get("boqReference")),
    drawingReference: blank(formData.get("drawingReference")),
    technicalNotes: blank(formData.get("technicalNotes")),
    items: String(formData.get("items") ?? "[]"),
  };
  const parsed = prSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues[0]?.message ?? "Please correct the highlighted fields.",
      parsed.error.issues.map((i) => `${i.path.join(".") || "form"}: ${i.message}`),
    );
  }
  let items: PrItemInput[];
  try {
    const arr = JSON.parse(parsed.data.items) as unknown[];
    const validated = z.array(itemSchema).min(1, "Add at least one requisition line").safeParse(arr);
    if (!validated.success) {
      throw new ValidationError(
        "One or more requisition lines are incomplete.",
        validated.error.issues.map((i) => `Line ${Number(i.path[0]) + 1}: ${i.message}`),
      );
    }
    items = validated.data.map((i) => ({
      itemId: i.itemId ?? null,
      categoryId: i.categoryId,
      description: i.description,
      brand: i.brand ?? null,
      model: i.model ?? null,
      make: i.make ?? null,
      specification: i.specification ?? null,
      quantity: i.quantity,
      unit: i.unit,
      estimatedUnitPrice: i.estimatedUnitPrice ?? null,
      disposition: i.disposition,
      notes: i.notes ?? null,
    }));
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError("Requisition lines could not be read. Please re-enter them.");
  }

  return {
    entityId: parsed.data.entityId,
    departmentId: parsed.data.departmentId,
    procurementType: parsed.data.procurementType,
    procurementKind: parsed.data.procurementKind,
    title: parsed.data.title,
    justification: parsed.data.justification,
    projectId: parsed.data.projectId,
    siteId: parsed.data.siteId,
    costCenter: parsed.data.costCenter,
    deliveryStoreId: parsed.data.deliveryStoreId,
    deliveryLocationNote: parsed.data.deliveryLocationNote,
    requiredDate: new Date(parsed.data.requiredDate),
    priority: parsed.data.priority,
    budgetAmount: parsed.data.budgetAmount === null ? null : Number(parsed.data.budgetAmount),
    budgetCode: parsed.data.budgetCode,
    pmOwnerId: parsed.data.pmOwnerId,
    boqReference: parsed.data.boqReference,
    drawingReference: parsed.data.drawingReference,
    technicalNotes: parsed.data.technicalNotes,
    items,
  };
}

export async function createPrAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const input = parsePr(formData);
    const pr = await createPr(user, input);
    const submitNow = formData.get("submitNow") === "on" || formData.get("submitNow") === "true";
    if (submitNow) {
      await submitPr(user, pr.id);
    }
    revalidatePath("/pr");
    revalidatePath("/workspace");
    return {
      ok: true,
      data: { id: pr.id, number: pr.number },
      message: submitNow ? `${pr.number} created and submitted for approval.` : `${pr.number} saved as a draft.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function updatePrAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const prId = String(formData.get("prId") ?? "");
    if (!prId) throw new ValidationError("Missing requisition reference.");
    const input = parsePr(formData);
    const pr = await updatePr(user, prId, input);
    const submitNow = formData.get("submitNow") === "on" || formData.get("submitNow") === "true";
    if (submitNow) await submitPr(user, prId);
    revalidatePath(`/pr/${prId}`);
    revalidatePath("/pr");
    return {
      ok: true,
      data: { id: pr.id, number: pr.number },
      message: submitNow ? `${pr.number} updated and resubmitted.` : `${pr.number} updated.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function submitPrAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const prId = String(formData.get("prId") ?? "");
    const result = await submitPr(user, prId);
    revalidatePath(`/pr/${prId}`);
    revalidatePath("/workspace");
    return {
      ok: true,
      data: result,
      message: result.approval.autoApproved
        ? "Submitted. No approval rule matched, so the requisition moved straight to procurement review."
        : `Submitted for approval — first step: ${result.approval.steps[0]?.name ?? "approval"}.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function validatePrAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const prId = String(formData.get("prId") ?? "");
    const issues = await validateForSubmission(prId);
    return {
      ok: true,
      data: { issues },
      message: issues.length
        ? `${issues.length} item(s) must be resolved before submission.`
        : "This requisition is complete and ready to submit.",
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function decidePrAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const prId = String(formData.get("prId") ?? "");
    const decision = String(formData.get("decision") ?? "") as
      | "APPROVED"
      | "REJECTED"
      | "RETURNED"
      | "CLARIFICATION_REQUESTED";
    const comment = blank(formData.get("reason")) ?? blank(formData.get("comment"));
    const result = await decidePr(user, prId, decision, comment);
    revalidatePath(`/pr/${prId}`);
    revalidatePath("/workspace");
    revalidatePath("/pr");
    const label: Record<string, string> = {
      APPROVED: "approved",
      REJECTED: "rejected",
      RETURNED: "returned to the requester",
      CLARIFICATION_REQUESTED: "returned with a clarification request",
    };
    return {
      ok: true,
      data: result,
      message: result.completed
        ? "Approval complete — the requisition has moved to procurement review."
        : `Requisition ${label[decision]}${result.nextStepName ? `. Next step: ${result.nextStepName}.` : "."}`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function startSourcingAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const prId = String(formData.get("prId") ?? "");
    await startSourcing(user, prId);
    revalidatePath(`/pr/${prId}`);
    return { ok: true, data: null, message: "Requisition moved into sourcing. You can now raise an RFQ." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function cancelPrAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const prId = String(formData.get("prId") ?? "");
    const reason = String(formData.get("reason") ?? "");
    await cancelPr(user, prId, reason);
    revalidatePath(`/pr/${prId}`);
    revalidatePath("/pr");
    return { ok: true, data: null, message: "Requisition cancelled." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function holdPrAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const prId = String(formData.get("prId") ?? "");
    const reason = String(formData.get("reason") ?? "");
    await holdPr(user, prId, reason);
    revalidatePath(`/pr/${prId}`);
    return { ok: true, data: null, message: "Requisition placed on hold." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function releaseHoldAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const prId = String(formData.get("prId") ?? "");
    const to = String(formData.get("to") ?? "PROCUREMENT_REVIEW");
    const reason = blank(formData.get("reason"));
    await releaseHold(user, prId, to as never, reason);
    revalidatePath(`/pr/${prId}`);
    return { ok: true, data: null, message: "Hold released." };
  } catch (e) {
    return toActionError(e);
  }
}

/** Attaches a document to any business object, enforcing the link requirement. */
export async function uploadDocumentAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const file = formData.get("file");
    if (!(file instanceof File)) throw new ValidationError("Select a file to upload.");
    const linkedType = String(formData.get("linkedType") ?? "");
    const linkedId = String(formData.get("linkedId") ?? "");
    const doc = await uploadDocument(user, {
      file,
      linkedType: linkedType as never,
      linkedId,
      caseKey: blank(formData.get("caseKey")),
      category: blank(formData.get("category")) ?? "General",
      documentTypeCode: blank(formData.get("documentTypeCode")),
      description: blank(formData.get("description")),
      confidentiality: (blank(formData.get("confidentiality")) ?? "INTERNAL") as never,
      entityId: blank(formData.get("entityId")),
      replacesDocumentId: blank(formData.get("replacesDocumentId")),
    });
    revalidatePath(`/${linkedType.toLowerCase()}/${linkedId}`);
    return { ok: true, data: { id: doc.id }, message: `${doc.name} uploaded.` };
  } catch (e) {
    return toActionError(e);
  }
}

/** Form option data for the requisition editor. */
export async function prFormOptions(entityId: string | null) {
  const user = await requireUser();
  const entityIds = userHasPermission(user, P.ANALYTICS_VIEW_ALL_ENTITIES) ? undefined : user.entityIds;
  const [entities, departments, projects, sites, stores, categories, items, pmUsers] = await Promise.all([
    prisma.entity.findMany({
      where: { active: true, ...(entityIds ? { id: { in: entityIds } } : {}) },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    prisma.department.findMany({
      where: { active: true, ...(entityId ? { entityId } : entityIds ? { entityId: { in: entityIds } } : {}) },
      select: { id: true, code: true, name: true, entityId: true, costCenter: true },
      orderBy: { name: "asc" },
    }),
    prisma.project.findMany({
      where: { status: "Active", ...(entityId ? { entityId } : entityIds ? { entityId: { in: entityIds } } : {}) },
      select: { id: true, code: true, name: true, entityId: true },
      orderBy: { name: "asc" },
    }),
    prisma.site.findMany({
      where: { active: true, ...(entityId ? { entityId } : entityIds ? { entityId: { in: entityIds } } : {}) },
      select: { id: true, code: true, name: true, entityId: true, projectId: true },
      orderBy: { name: "asc" },
    }),
    prisma.store.findMany({
      where: { active: true, ...(entityId ? { entityId } : entityIds ? { entityId: { in: entityIds } } : {}) },
      select: { id: true, code: true, name: true, kind: true, entityId: true, siteId: true },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    }),
    prisma.category.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true, defaultDisposition: true, requiresInspection: true },
      orderBy: { name: "asc" },
    }),
    prisma.item.findMany({
      where: { active: true },
      select: {
        id: true,
        sku: true,
        name: true,
        unit: true,
        brand: true,
        model: true,
        make: true,
        specification: true,
        standardPrice: true,
        categoryId: true,
      },
      orderBy: { name: "asc" },
    }),
    prisma.user.findMany({
      where: { active: true, roles: { some: { role: { code: { in: ["PM_USER", "HOD"] } } } } },
      select: { id: true, name: true, title: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return { entities, departments, projects, sites, stores, categories, items, pmUsers };
}

/* ── Bulk ─────────────────────────────────────────────────── */

/**
 * Nudges whoever currently owns each requisition's pending approval step. It
 * changes no state and grants no authority — it only makes the queue visible to
 * the person holding it, and records that the reminder was sent.
 */
export async function bulkRemindApprovers(ids: string[], reason: string | null) {
  const user = await requireUser();
  if (!userHasPermission(user, P.PR_VIEW_ALL, P.PR_APPROVE)) {
    throw new ForbiddenError("You do not have permission to chase approvals across the organisation.");
  }

  const results: Array<{ id: string; ok: boolean; notified?: number; error?: string }> = [];
  for (const id of ids) {
    try {
      const pr = await prisma.purchaseRequisition.findUnique({
        where: { id },
        select: { id: true, number: true, title: true, status: true, entityId: true },
      });
      if (!pr) throw new NotFoundError("Requisition");

      const pending = await prisma.task.findMany({
        where: {
          documentType: "PR",
          documentId: id,
          status: { in: ["OPEN", "IN_PROGRESS"] },
        },
        select: { assigneeId: true, assignedRoleCode: true, title: true },
      });
      if (pending.length === 0) {
        results.push({ id, ok: false, error: `${pr.number} has nothing outstanding.` });
        continue;
      }

      const userIds = pending.map((t) => t.assigneeId).filter((x): x is string => !!x);
      const roleCodes = [...new Set(pending.map((t) => t.assignedRoleCode).filter((x): x is string => !!x))];
      const notified = await notify({
        userIds,
        roleCodes,
        entityId: pr.entityId,
        type: "APPROVAL_REQUIRED",
        priority: "HIGH",
        title: `Reminder: ${pr.number} is waiting on you`,
        body: `${pr.title} — ${pr.status.replace(/_/g, " ").toLowerCase()}. ${reason ?? ""}`.trim(),
        linkType: "PR",
        linkId: pr.id,
        linkUrl: `/pr/${pr.id}`,
      });

      await writeAudit({
        entityType: "PurchaseRequisition",
        entityId: pr.id,
        entityRef: pr.number,
        action: "APPROVAL_REMINDER_SENT",
        newValue: { notified },
        reason,
        caseKey: pr.number,
        actor: user,
      });
      results.push({ id, ok: true, notified });
    } catch (e) {
      results.push({ id, ok: false, error: e instanceof Error ? e.message : "Failed" });
    }
  }
  revalidatePath("/pr");
  revalidatePath("/workspace");
  return results;
}
