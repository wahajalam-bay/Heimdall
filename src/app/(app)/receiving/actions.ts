"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import { DISCREPANCY_TYPES } from "@/lib/domain";
import {
  createGatePass,
  recordDelivery,
  recordInspection,
  assignInspector,
  scheduleInspection,
  type DeliveryItemInput,
  type InspectionItemResult,
} from "@/server/receiving";
import { createGrn, postGrn, cancelGrn, recordStacking, grnReadiness } from "@/server/grn";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const s = blank(v);
  return s === null ? null : Number(s);
};

/* ── Gate pass ────────────────────────────────────────────── */

export async function createGatePassAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const storeId = String(formData.get("storeId") ?? "");
    if (!storeId) throw new ValidationError("Select the receiving store.");
    const gp = await createGatePass(user, {
      poId: blank(formData.get("poId")),
      vendorId: blank(formData.get("vendorId")),
      storeId,
      vehicleNumber: blank(formData.get("vehicleNumber")),
      vehicleType: blank(formData.get("vehicleType")),
      driverName: blank(formData.get("driverName")),
      driverCnic: blank(formData.get("driverCnic")),
      driverPhone: blank(formData.get("driverPhone")),
      deliveryNoteRef: blank(formData.get("deliveryNoteRef")),
      invoiceRef: blank(formData.get("invoiceRef")),
      materialSummary: blank(formData.get("materialSummary")),
      declaredQuantity: num(formData.get("declaredQuantity")),
      declaredPackages: num(formData.get("declaredPackages")),
      securityRemarks: blank(formData.get("securityRemarks")),
    });
    revalidatePath("/gate-passes");
    return {
      ok: true,
      data: { id: gp.id, number: gp.number, serial: gp.serial },
      message: `${gp.number} recorded (serial ${gp.serial}). The receiving store has been notified.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Delivery / physical verification ─────────────────────── */

const deliveryItemSchema = z.object({
  poItemId: z.string().min(1),
  actualQty: z.coerce.number().min(0, "Delivered quantity cannot be negative"),
  acceptedQty: z.coerce.number().min(0, "Accepted quantity cannot be negative"),
  rejectedQty: z.coerce.number().min(0).optional(),
  packages: z.coerce.number().int().min(0).optional().nullable(),
  batchNumber: z.string().trim().optional().nullable(),
  serialNumbers: z.string().trim().optional().nullable(),
  expiryDate: z.string().optional().nullable(),
  warrantyMonths: z.coerce.number().int().min(0).optional().nullable(),
  specificationMatch: z.boolean().optional(),
  conditionNotes: z.string().trim().optional().nullable(),
  discrepancyType: z.enum(DISCREPANCY_TYPES).optional(),
  discrepancyNotes: z.string().trim().optional().nullable(),
});

export async function recordDeliveryAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const poId = String(formData.get("poId") ?? "");
    const storeId = String(formData.get("storeId") ?? "");
    if (!poId || !storeId) throw new ValidationError("Missing purchase order or store reference.");

    let items: DeliveryItemInput[];
    try {
      const arr = JSON.parse(String(formData.get("items") ?? "[]")) as unknown[];
      const validated = z.array(deliveryItemSchema).min(1, "Record at least one line").safeParse(arr);
      if (!validated.success) {
        throw new ValidationError(
          "One or more received lines are invalid.",
          validated.error.issues.map((i) => `Line ${Number(i.path[0]) + 1}: ${i.message}`),
        );
      }
      items = validated.data.map((i) => ({
        poItemId: i.poItemId,
        actualQty: i.actualQty,
        acceptedQty: i.acceptedQty,
        rejectedQty: i.rejectedQty,
        packages: i.packages ?? null,
        batchNumber: i.batchNumber ?? null,
        serialNumbers: i.serialNumbers ?? null,
        expiryDate: i.expiryDate ? new Date(i.expiryDate) : null,
        warrantyMonths: i.warrantyMonths ?? null,
        specificationMatch: i.specificationMatch ?? true,
        conditionNotes: i.conditionNotes ?? null,
        discrepancyType: i.discrepancyType,
        discrepancyNotes: i.discrepancyNotes ?? null,
      }));
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      throw new ValidationError("Received lines could not be read.");
    }

    const result = await recordDelivery(user, {
      poId,
      gatePassId: blank(formData.get("gatePassId")),
      storeId,
      deliveryNoteRef: blank(formData.get("deliveryNoteRef")),
      totalPackages: num(formData.get("totalPackages")),
      packagesVerified: num(formData.get("packagesVerified")),
      packagingCondition: blank(formData.get("packagingCondition")),
      physicalCondition: blank(formData.get("physicalCondition")),
      damageObserved: formData.get("damageObserved") === "on",
      damageNotes: blank(formData.get("damageNotes")),
      leakageObserved: formData.get("leakageObserved") === "on",
      handlingNotes: blank(formData.get("handlingNotes")),
      weightRecorded: num(formData.get("weightRecorded")),
      weightUnit: blank(formData.get("weightUnit")),
      documentationComplete: formData.get("documentationComplete") === "on",
      remarks: blank(formData.get("remarks")),
      items,
    });

    revalidatePath("/receiving");
    revalidatePath(`/po/${poId}`);
    revalidatePath("/open-pos");
    return {
      ok: true,
      data: { id: result.delivery.id, inspectionId: result.inspection?.id ?? null },
      message: result.inspection
        ? `${result.delivery.number} recorded. Technical inspection ${result.inspection.number} has been raised and must be completed before a GRN.`
        : `${result.delivery.number} recorded — status ${result.status.replace(/_/g, " ").toLowerCase()}. You can now raise the GRN.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Inspection ───────────────────────────────────────────── */

export async function recordInspectionAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const inspectionId = String(formData.get("inspectionId") ?? "");
    const result = String(formData.get("result") ?? "") as
      | "APPROVED"
      | "REJECTED"
      | "CONDITIONAL"
      | "RE_INSPECTION_REQUIRED";

    let items: InspectionItemResult[];
    try {
      items = JSON.parse(String(formData.get("items") ?? "[]")) as InspectionItemResult[];
    } catch {
      throw new ValidationError("Inspection results could not be read.");
    }
    if (!items.length) throw new ValidationError("Record a result for each inspected line.");

    const insp = await recordInspection(user, {
      inspectionId,
      result,
      findings: blank(formData.get("findings")),
      conditions: blank(formData.get("conditions")),
      signedByName: String(formData.get("signedByName") ?? ""),
      items,
    });

    revalidatePath(`/inspections/${inspectionId}`);
    revalidatePath("/inspections");
    if (insp.deliveryId) revalidatePath(`/receiving/${insp.deliveryId}`);
    return {
      ok: true,
      data: { id: insp.id },
      message:
        result === "APPROVED"
          ? `${insp.number} approved. The GRN can now be raised.`
          : result === "CONDITIONAL"
            ? `${insp.number} conditionally approved — conditions recorded.`
            : `${insp.number} ${result.replace(/_/g, " ").toLowerCase()}. A GRN is blocked until this is resolved.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function assignInspectorAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const inspectionId = String(formData.get("inspectionId") ?? "");
    const inspectorId = String(formData.get("inspectorId") ?? "");
    if (!inspectorId) throw new ValidationError("Select an inspector.");
    await assignInspector(user, inspectionId, inspectorId);
    revalidatePath(`/inspections/${inspectionId}`);
    return { ok: true, data: null, message: "Inspector assigned and notified." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function raiseInspectionAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const deliveryId = String(formData.get("deliveryId") ?? "");
    const delivery = await prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { items: true },
    });
    if (!delivery) throw new ValidationError("Delivery not found.");
    const insp = await scheduleInspection(user, {
      deliveryId,
      poId: delivery.poId,
      poItemIds: delivery.items.map((i) => i.poItemId),
      inspectorId: blank(formData.get("inspectorId")),
    });
    revalidatePath(`/receiving/${deliveryId}`);
    return { ok: true, data: { id: insp.id }, message: `Inspection ${insp.number} raised.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── GRN ──────────────────────────────────────────────────── */

const grnItemSchema = z.object({
  deliveryItemId: z.string().min(1),
  acceptedQty: z.coerce.number().min(0),
  rejectedQty: z.coerce.number().min(0).optional(),
  batchNumber: z.string().trim().optional().nullable(),
  serialNumbers: z.string().trim().optional().nullable(),
  expiryDate: z.string().optional().nullable(),
  warrantyMonths: z.coerce.number().int().min(0).optional().nullable(),
  storeLocationId: z.string().optional().nullable(),
  disposition: z.string().optional(),
  remarks: z.string().trim().optional().nullable(),
});

export async function createGrnAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const deliveryId = String(formData.get("deliveryId") ?? "");
    if (!deliveryId) throw new ValidationError("Missing delivery reference.");

    let items;
    try {
      const arr = JSON.parse(String(formData.get("items") ?? "[]")) as unknown[];
      const validated = z.array(grnItemSchema).min(1, "A GRN needs at least one line").safeParse(arr);
      if (!validated.success) {
        throw new ValidationError(
          "One or more GRN lines are invalid.",
          validated.error.issues.map((i) => `Line ${Number(i.path[0]) + 1}: ${i.message}`),
        );
      }
      items = validated.data.map((i) => ({
        deliveryItemId: i.deliveryItemId,
        acceptedQty: i.acceptedQty,
        rejectedQty: i.rejectedQty,
        batchNumber: i.batchNumber ?? null,
        serialNumbers: i.serialNumbers ?? null,
        expiryDate: i.expiryDate ? new Date(i.expiryDate) : null,
        warrantyMonths: i.warrantyMonths ?? null,
        storeLocationId: i.storeLocationId ?? null,
        disposition: i.disposition as never,
        remarks: i.remarks ?? null,
      }));
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      throw new ValidationError("GRN lines could not be read.");
    }

    const post = formData.get("post") === "true";
    const grn = await createGrn(user, {
      deliveryId,
      storeId: blank(formData.get("storeId")),
      remarks: blank(formData.get("remarks")),
      items,
      post,
    });

    revalidatePath("/grn");
    revalidatePath("/inventory");
    revalidatePath("/open-pos");
    revalidatePath(`/receiving/${deliveryId}`);
    return {
      ok: true,
      data: { id: grn.id, number: grn.number },
      message: post
        ? `${grn.number} posted — goods are now in inventory and the purchase order balance has been updated.`
        : `${grn.number} created as a draft. Post it to take the goods into inventory.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function postGrnAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const grnId = String(formData.get("grnId") ?? "");
    const grn = await postGrn(user, grnId);
    revalidatePath(`/grn/${grnId}`);
    revalidatePath("/inventory");
    revalidatePath("/open-pos");
    return {
      ok: true,
      data: null,
      message: `${grn.number} posted. Inventory and the purchase order balance have been updated.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function cancelGrnAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const grnId = String(formData.get("grnId") ?? "");
    const grn = await cancelGrn(user, grnId, String(formData.get("reason") ?? ""));
    revalidatePath(`/grn/${grnId}`);
    revalidatePath("/inventory");
    return {
      ok: true,
      data: null,
      message: `${grn.number} cancelled. Compensating inventory movements have been written — nothing was deleted.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function grnReadinessAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const deliveryId = String(formData.get("deliveryId") ?? "");
    const r = await grnReadiness(deliveryId);
    return {
      ok: true,
      data: r,
      message: r.ready ? "Ready to raise a GRN." : `${r.issues.length} blocker(s).`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Goods stacking ───────────────────────────────────────── */

export async function recordStackingAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const storeId = String(formData.get("storeId") ?? "");
    let entries;
    try {
      entries = JSON.parse(String(formData.get("entries") ?? "[]")) as Array<{
        itemId?: string | null;
        description: string;
        quantity: number;
        unit: string;
        locationId?: string | null;
        stackingMethod?: string;
        goodsClass?: string;
        handlingRequirements?: string | null;
        notes?: string | null;
      }>;
    } catch {
      throw new ValidationError("Stacking entries could not be read.");
    }
    const created = await recordStacking(user, {
      grnId: blank(formData.get("grnId")),
      storeId,
      entries,
    });
    revalidatePath(`/grn/${String(formData.get("grnId") ?? "")}`);
    revalidatePath(`/stores/${storeId}`);
    return { ok: true, data: null, message: `${created.length} stacking entry(ies) recorded.` };
  } catch (e) {
    return toActionError(e);
  }
}

/** Options for the receiving forms. */
export async function receivingOptions(entityId: string | null) {
  await requireUser();
  const [stores, openPos, inspectors] = await Promise.all([
    prisma.store.findMany({
      where: { active: true, ...(entityId ? { entityId } : {}) },
      select: { id: true, code: true, name: true, kind: true, managerId: true },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    }),
    prisma.purchaseOrder.findMany({
      where: {
        status: { in: ["ISSUED", "PARTIALLY_RECEIVED", "APPROVED"] },
        ...(entityId ? { entityId } : {}),
      },
      select: {
        id: true,
        number: true,
        total: true,
        deliveryDate: true,
        vendor: { select: { id: true, name: true } },
        deliveryStore: { select: { id: true, name: true } },
        items: { select: { quantity: true, acceptedQty: true } },
      },
      orderBy: { issuedAt: "desc" },
      take: 200,
    }),
    prisma.user.findMany({
      where: {
        active: true,
        roles: { some: { role: { code: { in: ["TECHNICAL_INSPECTOR", "IT_USER", "PM_USER", "DESIGN_USER"] } } } },
      },
      select: { id: true, name: true, title: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return { stores, openPos, inspectors };
}
