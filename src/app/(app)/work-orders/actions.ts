"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import {
  approveWorkOrder,
  closeWorkOrder,
  createWorkOrder,
  internalAuditReview,
  issueWorkOrder,
  submitWorkOrder,
  type WorkOrderLineInput,
} from "@/server/work-orders";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const n = Number(typeof v === "string" ? v : NaN);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Every one of these re-checks its permission inside the domain function. The
 * server action is a URL; hiding a button is presentation, not authorization.
 */
export async function createWorkOrderAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();

    const descriptions = formData.getAll("lineDescription").map(String);
    const quantities = formData.getAll("lineQuantity").map(String);
    const units = formData.getAll("lineUnit").map(String);
    const rates = formData.getAll("lineRate").map(String);
    const sources = formData.getAll("lineSource").map(String);

    const items: WorkOrderLineInput[] = descriptions
      .map((description, i) => ({
        description,
        quantity: Number(quantities[i] ?? 1) || 1,
        unit: units[i] || "JOB",
        rate: Number(rates[i] ?? 0) || 0,
        sourceRef: sources[i] || null,
      }))
      .filter((l) => l.description.trim());

    if (!items.length) throw new ValidationError("Add at least one line of work.");

    const entityId = blank(formData.get("entityId"));
    const vendorId = blank(formData.get("vendorId"));
    if (!entityId || !vendorId) throw new ValidationError("Choose the company and the vendor.");

    const start = blank(formData.get("startDate"));
    const end = blank(formData.get("endDate"));

    const wo = await createWorkOrder(user, {
      entityId,
      vendorId,
      title: String(formData.get("title") ?? ""),
      scopeOfWork: String(formData.get("scopeOfWork") ?? ""),
      prId: blank(formData.get("prId")),
      rfqId: blank(formData.get("rfqId")),
      comparativeId: blank(formData.get("comparativeId")),
      taxAmount: num(formData.get("taxAmount")),
      startDate: start ? new Date(start) : null,
      endDate: end ? new Date(end) : null,
      items,
    });

    revalidatePath("/work-orders");
    return {
      ok: true,
      data: { id: wo.id },
      message: wo.internalAuditRequired
        ? `${wo.number} raised. It falls outside the committee's domain, so Internal Audit must review it before it is finalised.`
        : `${wo.number} raised. It falls within the committee's domain, where the CPC case is the review.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function submitWorkOrderAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = String(formData.get("workOrderId") ?? "");
    const wo = await submitWorkOrder(user, id);
    revalidatePath(`/work-orders/${id}`);
    return {
      ok: true,
      data: null,
      message:
        wo.status === "PENDING_INTERNAL_AUDIT"
          ? "Sent to Internal Audit for review."
          : "Sent for approval.",
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function internalAuditReviewAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = String(formData.get("workOrderId") ?? "");
    const decision = String(formData.get("decision") ?? "APPROVED") as "APPROVED" | "REJECTED";
    await internalAuditReview(user, {
      workOrderId: id,
      decision,
      notes: blank(formData.get("reason")),
    });
    revalidatePath(`/work-orders/${id}`);
    return {
      ok: true,
      data: null,
      message: decision === "APPROVED" ? "Cleared by Internal Audit." : "Returned by Internal Audit.",
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function approveWorkOrderAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = String(formData.get("workOrderId") ?? "");
    await approveWorkOrder(user, { workOrderId: id, notes: blank(formData.get("reason")) });
    revalidatePath(`/work-orders/${id}`);
    return { ok: true, data: null, message: "Approved." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function issueWorkOrderAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = String(formData.get("workOrderId") ?? "");
    const wo = await issueWorkOrder(user, id);
    revalidatePath(`/work-orders/${id}`);
    return { ok: true, data: null, message: `${wo.number} issued to the vendor.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function closeWorkOrderAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = String(formData.get("workOrderId") ?? "");
    const to = String(formData.get("to") ?? "COMPLETED") as
      | "IN_PROGRESS"
      | "COMPLETED"
      | "CLOSED"
      | "CANCELLED";
    const wo = await closeWorkOrder(user, {
      workOrderId: id,
      to,
      reason: blank(formData.get("reason")),
    });
    revalidatePath(`/work-orders/${id}`);
    return {
      ok: true,
      data: null,
      message: `${wo.number} is now ${wo.status.replace(/_/g, " ").toLowerCase()}.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}
