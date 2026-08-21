import { prisma, type DbClient } from "@/lib/db";
import { nextNumber, nextSerial, SEQ } from "@/lib/numbering";
import { CONFIG_KEYS, getConfigArray, getConfigNumber } from "@/lib/config";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify, createTask, completeTasks } from "@/lib/notify";
import { raiseException } from "@/lib/exceptions-service";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import type { DiscrepancyType } from "@/lib/domain";
import { round2 } from "@/lib/format";

/**
 * Physical receipt chain: inward gate pass → physical verification (delivery)
 * → technical inspection. GRN is a separate step and only becomes available
 * once these are satisfied.
 */

/* ── Inward gate pass ─────────────────────────────────────── */

export type GatePassInput = {
  direction?: "INWARD" | "OUTWARD";
  poId?: string | null;
  vendorId?: string | null;
  storeId: string;
  vehicleNumber?: string | null;
  vehicleType?: string | null;
  driverName?: string | null;
  driverCnic?: string | null;
  driverPhone?: string | null;
  deliveryNoteRef?: string | null;
  invoiceRef?: string | null;
  materialSummary?: string | null;
  declaredQuantity?: number | null;
  declaredPackages?: number | null;
  securityRemarks?: string | null;
  arrivedAt?: Date;
};

export async function createGatePass(user: SessionUser, input: GatePassInput, db: DbClient = prisma) {
  if (!userHasPermission(user, P.GATE_PASS_CREATE)) {
    throw new ForbiddenError("You do not have permission to record gate passes.");
  }
  const store = await db.store.findUnique({ where: { id: input.storeId } });
  if (!store) throw new NotFoundError("Receiving store");

  let vendorId = input.vendorId ?? null;
  let po = null;
  if (input.poId) {
    po = await db.purchaseOrder.findUnique({ where: { id: input.poId }, include: { vendor: true, pr: true } });
    if (!po) throw new NotFoundError("Purchase order");
    const receivable = ["ISSUED", "PARTIALLY_RECEIVED", "APPROVED"];
    if (!receivable.includes(po.status)) {
      throw new RuleViolationError(
        `Purchase order ${po.number} is ${po.status} — goods cannot be booked in against it.`,
      );
    }
    vendorId = po.vendorId;
  }

  const number = await nextNumber(SEQ.GATE_PASS, db);
  const serial = await nextSerial(SEQ.GATE_PASS, db);

  const gp = await db.gatePass.create({
    data: {
      number,
      serial,
      direction: input.direction ?? "INWARD",
      poId: input.poId ?? null,
      vendorId,
      storeId: input.storeId,
      vehicleNumber: input.vehicleNumber ?? null,
      vehicleType: input.vehicleType ?? null,
      driverName: input.driverName ?? null,
      driverCnic: input.driverCnic ?? null,
      driverPhone: input.driverPhone ?? null,
      deliveryNoteRef: input.deliveryNoteRef ?? null,
      invoiceRef: input.invoiceRef ?? null,
      materialSummary: input.materialSummary ?? null,
      declaredQuantity: input.declaredQuantity ?? null,
      declaredPackages: input.declaredPackages ?? null,
      securityCheckedById: user.id,
      securityRemarks: input.securityRemarks ?? null,
      recordedById: user.id,
      arrivedAt: input.arrivedAt ?? new Date(),
      status: "RECORDED",
    },
  });

  // Route the vendor to the receiving store owner.
  await db.gatePass.update({ where: { id: gp.id }, data: { status: "ROUTED_TO_STORE" } });
  await createTask(
    {
      title: `Receive goods against ${gp.number}${po ? ` · ${po.number}` : ""}`,
      description: `${input.materialSummary ?? "Inward delivery"} at ${store.name}`,
      taskType: "RECEIVING",
      assigneeId: store.managerId ?? null,
      assignedRoleCode: store.managerId ? null : store.kind === "SITE_STORE" ? "SITE_STORE_USER" : "STORE_RECEIVER",
      entityId: store.entityId,
      documentType: "GATE_PASS",
      documentId: gp.id,
      documentRef: gp.number,
      priority: "HIGH",
      slaHours: 8,
      linkUrl: `/gate-passes/${gp.id}`,
    },
    db,
  );
  await notify(
    {
      userIds: store.managerId ? [store.managerId] : [],
      roleCodes: store.managerId ? [] : ["STORE_RECEIVER", "STORE_MANAGER", "SITE_STORE_USER"],
      entityId: store.entityId,
      type: "GENERAL",
      title: `Vehicle arrived — ${gp.number} at ${store.name}`,
      body: [input.vehicleNumber, input.driverName, po?.number].filter(Boolean).join(" · "),
      priority: "HIGH",
      linkType: "GATE_PASS",
      linkId: gp.id,
      linkUrl: `/gate-passes/${gp.id}`,
    },
    db,
  );

  await writeAudit(
    {
      entityType: "GatePass",
      entityId: gp.id,
      entityRef: gp.number,
      action: "GATE_PASS_RECORDED",
      newValue: {
        serial,
        store: store.name,
        po: po?.number ?? null,
        vehicle: input.vehicleNumber,
        declaredPackages: input.declaredPackages,
      },
      caseKey: po?.pr?.number ?? null,
      actor: user,
    },
    db,
  );

  return gp;
}

/* ── Physical verification (delivery) ─────────────────────── */

export type DeliveryItemInput = {
  poItemId: string;
  actualQty: number;
  acceptedQty: number;
  rejectedQty?: number;
  packages?: number | null;
  batchNumber?: string | null;
  serialNumbers?: string | null;
  expiryDate?: Date | null;
  warrantyMonths?: number | null;
  specificationMatch?: boolean;
  conditionNotes?: string | null;
  discrepancyType?: DiscrepancyType;
  discrepancyNotes?: string | null;
};

export type DeliveryInput = {
  poId: string;
  gatePassId?: string | null;
  storeId: string;
  deliveryNoteRef?: string | null;
  deliveryDate?: Date;
  totalPackages?: number | null;
  packagesVerified?: number | null;
  packagingCondition?: string | null;
  physicalCondition?: string | null;
  damageObserved?: boolean;
  damageNotes?: string | null;
  leakageObserved?: boolean;
  handlingNotes?: string | null;
  weightRecorded?: number | null;
  weightUnit?: string | null;
  documentationComplete?: boolean;
  remarks?: string | null;
  items: DeliveryItemInput[];
};

/**
 * Records physical verification of a delivery: quantities, condition, packaging
 * and any discrepancy. Discrepancies are recorded, not suppressed — each one
 * raises a tracked exception.
 */
export async function recordDelivery(user: SessionUser, input: DeliveryInput, db: DbClient = prisma) {
  if (!userHasPermission(user, P.RECEIVE_GOODS)) {
    throw new ForbiddenError("You do not have permission to record goods receiving.");
  }
  const po = await db.purchaseOrder.findUnique({
    where: { id: input.poId },
    include: { items: true, vendor: true, pr: true },
  });
  if (!po) throw new NotFoundError("Purchase order");
  if (!["ISSUED", "PARTIALLY_RECEIVED", "APPROVED", "ON_HOLD"].includes(po.status)) {
    throw new RuleViolationError(`Purchase order ${po.number} is ${po.status} — goods cannot be received.`);
  }
  if (!input.items.length) throw new ValidationError("Record at least one received line.");

  const store = await db.store.findUnique({ where: { id: input.storeId } });
  if (!store) throw new NotFoundError("Receiving store");

  const overReceiptPct = await getConfigNumber(CONFIG_KEYS.ALLOW_EXCESS_RECEIPT_PERCENT, po.entityId, db);

  // Validate every line against the outstanding PO balance before writing.
  const prepared: Array<DeliveryItemInput & { lineNo: number; poItem: (typeof po.items)[number]; expectedQty: number }> = [];
  const problems: string[] = [];
  let lineNo = 0;
  for (const li of input.items) {
    const poItem = po.items.find((i) => i.id === li.poItemId);
    if (!poItem) {
      problems.push("A received line does not belong to this purchase order.");
      continue;
    }
    lineNo += 1;
    const alreadyReceived = poItem.receivedQty;
    const expectedQty = round2(Math.max(0, poItem.quantity - poItem.acceptedQty));
    const ceiling = round2(poItem.quantity * (1 + overReceiptPct / 100));

    if (li.actualQty < 0) problems.push(`Line ${lineNo}: received quantity cannot be negative.`);
    if (li.acceptedQty < 0) problems.push(`Line ${lineNo}: accepted quantity cannot be negative.`);
    if (li.acceptedQty > li.actualQty + 1e-9) {
      problems.push(`Line ${lineNo}: accepted quantity (${li.acceptedQty}) exceeds the quantity delivered (${li.actualQty}).`);
    }
    if (round2(alreadyReceived + li.actualQty) > ceiling + 1e-9) {
      problems.push(
        `Line ${lineNo} (${poItem.description}): receiving ${li.actualQty} ${poItem.unit} would bring total receipts to ${round2(alreadyReceived + li.actualQty)} against an ordered quantity of ${poItem.quantity} ${poItem.unit}. Over-receipt beyond ${overReceiptPct}% is not permitted.`,
      );
    }
    prepared.push({ ...li, lineNo, poItem, expectedQty });
  }
  if (problems.length) throw new RuleViolationError("This delivery cannot be recorded.", problems);

  // Derive the overall verification status from the lines.
  const anyRejected = prepared.some((p) => (p.rejectedQty ?? 0) > 0);
  const anyShort = prepared.some((p) => p.actualQty + 1e-9 < p.expectedQty);
  const anyDiscrepancy = prepared.some((p) => (p.discrepancyType ?? "OK") !== "OK");
  const allRejected = prepared.every((p) => p.acceptedQty <= 0);

  const status = allRejected
    ? "REJECTED"
    : anyDiscrepancy || input.damageObserved || input.leakageObserved
      ? "ACCEPTED_WITH_DISCREPANCY"
      : anyRejected || anyShort
        ? "PARTIALLY_ACCEPTED"
        : "ACCEPTED";

  const number = await nextNumber(SEQ.DELIVERY, db);
  const delivery = await db.delivery.create({
    data: {
      number,
      poId: po.id,
      gatePassId: input.gatePassId ?? null,
      vendorId: po.vendorId,
      storeId: input.storeId,
      deliveryNoteRef: input.deliveryNoteRef ?? null,
      deliveryDate: input.deliveryDate ?? new Date(),
      receivedById: user.id,
      totalPackages: input.totalPackages ?? null,
      packagesVerified: input.packagesVerified ?? null,
      packagingCondition: input.packagingCondition ?? null,
      physicalCondition: input.physicalCondition ?? null,
      damageObserved: Boolean(input.damageObserved),
      damageNotes: input.damageNotes ?? null,
      leakageObserved: Boolean(input.leakageObserved),
      handlingNotes: input.handlingNotes ?? null,
      weightRecorded: input.weightRecorded ?? null,
      weightUnit: input.weightUnit ?? null,
      documentationComplete: input.documentationComplete ?? true,
      status,
      remarks: input.remarks ?? null,
      items: {
        create: prepared.map((p) => ({
          poItemId: p.poItemId,
          itemId: p.poItem.itemId,
          lineNo: p.lineNo,
          description: p.poItem.description,
          orderedQty: p.poItem.quantity,
          expectedQty: p.expectedQty,
          actualQty: p.actualQty,
          acceptedQty: p.acceptedQty,
          rejectedQty: p.rejectedQty ?? round2(Math.max(0, p.actualQty - p.acceptedQty)),
          unit: p.poItem.unit,
          packages: p.packages ?? null,
          batchNumber: p.batchNumber ?? null,
          serialNumbers: p.serialNumbers ?? null,
          expiryDate: p.expiryDate ?? null,
          warrantyMonths: p.warrantyMonths ?? null,
          specificationMatch: p.specificationMatch ?? true,
          conditionNotes: p.conditionNotes ?? null,
          discrepancyType: p.discrepancyType ?? "OK",
          discrepancyNotes: p.discrepancyNotes ?? null,
        })),
      },
    },
  });

  if (input.gatePassId) {
    await db.gatePass.update({
      where: { id: input.gatePassId },
      data: { status: "RECEIVED", releasedAt: new Date() },
    });
    await completeTasks("GATE_PASS", input.gatePassId, user.id, db);
  }

  // Every discrepancy becomes a first-class exception.
  for (const p of prepared) {
    const dt = p.discrepancyType ?? "OK";
    const short = p.actualQty + 1e-9 < p.expectedQty;
    if (dt === "OK" && !short) continue;

    const typeMap: Partial<Record<DiscrepancyType, "QUANTITY_MISMATCH" | "DAMAGED_MATERIAL" | "OTHER">> = {
      QUANTITY_MISMATCH: "QUANTITY_MISMATCH",
      SHORT_DELIVERY: "QUANTITY_MISMATCH",
      EXCESS_DELIVERY: "QUANTITY_MISMATCH",
      DAMAGED: "DAMAGED_MATERIAL",
      EXPIRED: "DAMAGED_MATERIAL",
      WRONG_ITEM: "OTHER",
      WRONG_SPEC: "OTHER",
      MISSING_SERIAL: "OTHER",
      MISSING_WARRANTY: "OTHER",
    };
    const excType = typeMap[dt] ?? "QUANTITY_MISMATCH";

    await raiseException(
      {
        type: excType,
        severity: dt === "DAMAGED" || dt === "EXPIRED" || dt === "WRONG_ITEM" ? "HIGH" : "MEDIUM",
        title: `${delivery.number} line ${p.lineNo}: ${dt === "OK" ? "SHORT_DELIVERY" : dt}`,
        description: `${p.poItem.description} — expected ${p.expectedQty} ${p.poItem.unit}, delivered ${p.actualQty}, accepted ${p.acceptedQty}. ${p.discrepancyNotes ?? ""}`.trim(),
        documentType: "PO",
        documentId: po.id,
        documentRef: po.number,
        poId: po.id,
        caseKey: po.pr?.number ?? null,
        entityId: po.entityId,
        raisedById: user.id,
        notifyRoles: ["PROCUREMENT_OFFICER", "PROCUREMENT_SENIOR_MANAGER", "STORE_MANAGER"],
      },
      db,
      user,
    );
  }

  // Late delivery against the promised PO date.
  if (po.deliveryDate && delivery.deliveryDate > po.deliveryDate) {
    const lateDays = Math.ceil((delivery.deliveryDate.getTime() - po.deliveryDate.getTime()) / 86400000);
    await raiseException(
      {
        type: "LATE_DELIVERY",
        severity: lateDays > 14 ? "HIGH" : "MEDIUM",
        title: `${po.number} delivered ${lateDays} day(s) late by ${po.vendor.name}`,
        description: `Promised ${po.deliveryDate.toISOString().slice(0, 10)}, delivered ${delivery.deliveryDate.toISOString().slice(0, 10)}.`,
        documentType: "PO",
        documentId: po.id,
        documentRef: po.number,
        poId: po.id,
        caseKey: po.pr?.number ?? null,
        entityId: po.entityId,
        raisedById: user.id,
      },
      db,
      user,
    );
  }

  await writeAudit(
    {
      entityType: "Delivery",
      entityId: delivery.id,
      entityRef: delivery.number,
      action: "DELIVERY_VERIFIED",
      newValue: {
        po: po.number,
        store: store.name,
        status,
        lines: prepared.map((p) => ({
          line: p.lineNo,
          delivered: p.actualQty,
          accepted: p.acceptedQty,
          discrepancy: p.discrepancyType ?? "OK",
        })),
      },
      caseKey: po.pr?.number ?? null,
      actor: user,
    },
    db,
  );

  // Queue technical inspection where the PO lines demand it.
  const needsInspection = po.items.filter(
    (i) => i.requiresInspection && prepared.some((p) => p.poItemId === i.id && p.acceptedQty > 0),
  );
  let inspection = null;
  if (needsInspection.length) {
    inspection = await scheduleInspection(
      user,
      {
        deliveryId: delivery.id,
        poId: po.id,
        poItemIds: needsInspection.map((i) => i.id),
      },
      db,
    );
  } else {
    await createTask(
      {
        title: `Raise GRN for ${delivery.number}`,
        description: `${po.number} · ${store.name}`,
        taskType: "ACTION",
        assigneeId: store.managerId ?? user.id,
        entityId: po.entityId,
        documentType: "DELIVERY",
        documentId: delivery.id,
        documentRef: delivery.number,
        priority: "HIGH",
        slaHours: await getConfigNumber(CONFIG_KEYS.SLA_GRN_HOURS, po.entityId, db),
        linkUrl: `/receiving/${delivery.id}`,
      },
      db,
    );
  }

  await notify(
    {
      roleCodes: ["PROCUREMENT_OFFICER", "BUYER", "STORE_MANAGER"],
      entityId: po.entityId,
      type: status === "ACCEPTED" ? "GRN_PENDING" : "GENERAL",
      title: `${delivery.number} recorded against ${po.number} — ${status.replace(/_/g, " ").toLowerCase()}`,
      body: `${store.name} · ${prepared.length} line(s)`,
      priority: status === "ACCEPTED" ? "NORMAL" : "HIGH",
      linkType: "DELIVERY",
      linkId: delivery.id,
      linkUrl: `/receiving/${delivery.id}`,
    },
    db,
  );

  return { delivery, inspection, status };
}

/* ── Technical inspection ─────────────────────────────────── */

export type InspectionTemplate = {
  code: string;
  label: string;
  type: string;
  criteria: Array<{ key: string; label: string; kind: "text" | "boolean" | "number" | "select"; options?: string[]; required?: boolean }>;
};

/** Configurable inspection templates keyed by inspection type. */
export const INSPECTION_TEMPLATES: InspectionTemplate[] = [
  {
    code: "IT_EQUIPMENT",
    label: "IT equipment",
    type: "IT",
    criteria: [
      { key: "model", label: "Model verified against PO", kind: "text", required: true },
      { key: "serial", label: "Serial number recorded", kind: "text", required: true },
      { key: "processor", label: "Processor / configuration", kind: "text", required: true },
      { key: "memory", label: "Memory (RAM)", kind: "text" },
      { key: "storage", label: "Storage", kind: "text" },
      { key: "display", label: "Display / resolution", kind: "text" },
      { key: "os", label: "Operating system / licence", kind: "text" },
      { key: "boot", label: "Powers on and boots", kind: "boolean", required: true },
      { key: "performance", label: "Performance check", kind: "select", options: ["Pass", "Marginal", "Fail"], required: true },
      { key: "accessories", label: "Accessories complete (charger, cables, box)", kind: "boolean", required: true },
      { key: "physical", label: "Physical condition", kind: "select", options: ["New", "Scuffed", "Damaged"], required: true },
      { key: "warranty", label: "Warranty card / registration", kind: "boolean" },
    ],
  },
  {
    code: "CONSTRUCTION_MATERIAL",
    label: "Construction material",
    type: "CIVIL",
    criteria: [
      { key: "grade", label: "Grade / specification", kind: "text", required: true },
      { key: "mill_cert", label: "Mill / test certificate provided", kind: "boolean", required: true },
      { key: "diameter", label: "Diameter / section verified", kind: "text" },
      { key: "weight", label: "Weight verified against challan", kind: "boolean", required: true },
      { key: "surface", label: "Surface condition (rust, pitting)", kind: "select", options: ["Acceptable", "Minor", "Unacceptable"], required: true },
      { key: "batch", label: "Batch / heat number", kind: "text" },
      { key: "lab", label: "Lab test required", kind: "boolean" },
      { key: "quantity_match", label: "Quantity matches delivery note", kind: "boolean", required: true },
    ],
  },
  {
    code: "MACHINERY",
    label: "Machinery & equipment",
    type: "MECHANICAL",
    criteria: [
      { key: "make_model", label: "Make / model verified", kind: "text", required: true },
      { key: "serial", label: "Serial / chassis number", kind: "text", required: true },
      { key: "hours", label: "Hour meter / mileage", kind: "number" },
      { key: "test_run", label: "Test run completed", kind: "boolean", required: true },
      { key: "leaks", label: "No leaks observed", kind: "boolean", required: true },
      { key: "safety", label: "Safety guards present", kind: "boolean", required: true },
      { key: "manuals", label: "Manuals & documentation", kind: "boolean" },
      { key: "condition", label: "Overall condition", kind: "select", options: ["New", "Good", "Fair", "Poor"], required: true },
    ],
  },
  {
    code: "ELECTRICAL",
    label: "Electrical / MEP",
    type: "ELECTRICAL",
    criteria: [
      { key: "rating", label: "Rating / capacity verified", kind: "text", required: true },
      { key: "standard", label: "Compliance standard", kind: "text" },
      { key: "insulation", label: "Insulation / continuity test", kind: "select", options: ["Pass", "Fail", "Not tested"], required: true },
      { key: "certification", label: "Certification provided", kind: "boolean", required: true },
      { key: "condition", label: "Physical condition", kind: "select", options: ["New", "Damaged"], required: true },
    ],
  },
  {
    code: "GENERAL",
    label: "General goods",
    type: "GENERAL",
    criteria: [
      { key: "spec_match", label: "Matches specification", kind: "boolean", required: true },
      { key: "quantity_match", label: "Quantity verified", kind: "boolean", required: true },
      { key: "condition", label: "Condition", kind: "select", options: ["Acceptable", "Damaged"], required: true },
      { key: "notes", label: "Observations", kind: "text" },
    ],
  },
];

export function templateForCategoryCode(code: string | null | undefined): InspectionTemplate {
  const c = (code ?? "").toUpperCase();
  if (c.startsWith("IT")) return INSPECTION_TEMPLATES[0];
  if (c.startsWith("CONSTR")) return INSPECTION_TEMPLATES[1];
  if (c.startsWith("MACH") || c.startsWith("EQUIP")) return INSPECTION_TEMPLATES[2];
  if (c.startsWith("ELEC") || c.startsWith("MEP")) return INSPECTION_TEMPLATES[3];
  return INSPECTION_TEMPLATES[4];
}

export async function scheduleInspection(
  user: SessionUser,
  input: { deliveryId: string; poId: string; poItemIds: string[]; inspectorId?: string | null },
  db: DbClient = prisma,
) {
  const delivery = await db.delivery.findUnique({
    where: { id: input.deliveryId },
    include: {
      po: { include: { pr: { include: { items: { include: { category: true } } } }, entity: true } },
      items: true,
      store: true,
    },
  });
  if (!delivery) throw new NotFoundError("Delivery");

  const poItems = await db.purchaseOrderItem.findMany({
    where: { id: { in: input.poItemIds } },
    include: { prItem: { include: { category: true } } },
  });
  const categoryCode = poItems[0]?.prItem?.category?.code ?? null;
  const template = templateForCategoryCode(categoryCode);

  const number = await nextNumber(SEQ.INSPECTION, db);
  const slaHours = await getConfigNumber(CONFIG_KEYS.SLA_INSPECTION_HOURS, delivery.po.entityId, db);

  const inspection = await db.inspection.create({
    data: {
      number,
      poId: input.poId,
      deliveryId: input.deliveryId,
      inspectionType: template.type,
      templateCode: template.code,
      inspectorId: input.inspectorId ?? null,
      department: template.label,
      scheduledAt: new Date(),
      result: "PENDING",
      items: {
        create: poItems.map((pi, idx) => {
          const dl = delivery.items.find((d) => d.poItemId === pi.id);
          return {
            poItemId: pi.id,
            itemId: pi.itemId,
            lineNo: idx + 1,
            description: pi.description,
            quantityInspected: dl?.acceptedQty ?? 0,
            quantityPassed: 0,
            quantityFailed: 0,
            serialNumber: dl?.serialNumbers ?? null,
            verdict: "PASS",
            criteriaResults: JSON.stringify(template.criteria.map((c) => ({ key: c.key, label: c.label, value: null }))),
          };
        }),
      },
    },
  });

  const roleForType: Record<string, string> = {
    IT: "IT_USER",
    CIVIL: "PM_USER",
    MECHANICAL: "TECHNICAL_INSPECTOR",
    ELECTRICAL: "TECHNICAL_INSPECTOR",
    GENERAL: "TECHNICAL_INSPECTOR",
    QUALITY: "TECHNICAL_INSPECTOR",
  };

  await createTask(
    {
      title: `Technical inspection required — ${inspection.number}`,
      description: `${template.label} · ${delivery.po.number} at ${delivery.store.name}`,
      taskType: "INSPECTION",
      assigneeId: input.inspectorId ?? null,
      assignedRoleCode: input.inspectorId ? null : (roleForType[template.type] ?? "TECHNICAL_INSPECTOR"),
      entityId: delivery.po.entityId,
      documentType: "INSPECTION",
      documentId: inspection.id,
      documentRef: inspection.number,
      priority: "HIGH",
      slaHours,
      linkUrl: `/inspections/${inspection.id}`,
    },
    db,
  );
  await notify(
    {
      userIds: input.inspectorId ? [input.inspectorId] : [],
      roleCodes: input.inspectorId ? [] : [roleForType[template.type] ?? "TECHNICAL_INSPECTOR"],
      entityId: delivery.po.entityId,
      type: "INSPECTION_REQUIRED",
      title: `Inspection ${inspection.number} pending`,
      body: `${template.label} for ${delivery.po.number}`,
      priority: "HIGH",
      linkType: "INSPECTION",
      linkId: inspection.id,
      linkUrl: `/inspections/${inspection.id}`,
    },
    db,
  );

  await writeAudit(
    {
      entityType: "Inspection",
      entityId: inspection.id,
      entityRef: inspection.number,
      action: "INSPECTION_SCHEDULED",
      newValue: { template: template.code, lines: poItems.length, delivery: delivery.number },
      caseKey: delivery.po.pr?.number ?? null,
      actor: user,
    },
    db,
  );

  return inspection;
}

export type InspectionItemResult = {
  inspectionItemId: string;
  quantityPassed: number;
  quantityFailed: number;
  serialNumber?: string | null;
  modelVerified?: string | null;
  specVerified?: string | null;
  configuration?: string | null;
  condition?: string | null;
  performanceNotes?: string | null;
  accessoriesComplete?: boolean;
  verdict: "PASS" | "FAIL" | "CONDITIONAL";
  criteriaResults?: Array<{ key: string; label: string; value: string | number | boolean | null }>;
  notes?: string | null;
};

export async function recordInspection(
  user: SessionUser,
  input: {
    inspectionId: string;
    result: "APPROVED" | "REJECTED" | "CONDITIONAL" | "RE_INSPECTION_REQUIRED";
    findings?: string | null;
    conditions?: string | null;
    signedByName: string;
    items: InspectionItemResult[];
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.INSPECTION_PERFORM)) {
    throw new ForbiddenError("You do not have permission to perform technical inspections.");
  }
  const inspection = await db.inspection.findUnique({
    where: { id: input.inspectionId },
    include: { items: true, delivery: { include: { store: true } }, po: { include: { pr: true } } },
  });
  if (!inspection) throw new NotFoundError("Inspection");
  if (["APPROVED", "REJECTED"].includes(inspection.result)) {
    throw new RuleViolationError(`Inspection ${inspection.number} is already ${inspection.result.toLowerCase()}.`);
  }
  if (!input.signedByName?.trim()) {
    throw new ValidationError("The inspection must be signed by the responsible inspector.");
  }
  if (input.result === "CONDITIONAL" && !input.conditions?.trim()) {
    throw new ValidationError("Record the conditions attached to a conditional approval.");
  }
  if (input.result === "REJECTED" && !input.findings?.trim()) {
    throw new ValidationError("Record the findings that led to rejection.");
  }

  for (const r of input.items) {
    const item = inspection.items.find((i) => i.id === r.inspectionItemId);
    if (!item) throw new ValidationError("An inspection result does not belong to this inspection.");
    if (round2(r.quantityPassed + r.quantityFailed) > item.quantityInspected + 1e-9) {
      throw new ValidationError(
        `Line ${item.lineNo}: passed + failed (${round2(r.quantityPassed + r.quantityFailed)}) exceeds the quantity presented (${item.quantityInspected}).`,
      );
    }
    await db.inspectionItem.update({
      where: { id: item.id },
      data: {
        quantityPassed: r.quantityPassed,
        quantityFailed: r.quantityFailed,
        serialNumber: r.serialNumber ?? item.serialNumber,
        modelVerified: r.modelVerified ?? null,
        specVerified: r.specVerified ?? null,
        configuration: r.configuration ?? null,
        condition: r.condition ?? null,
        performanceNotes: r.performanceNotes ?? null,
        accessoriesComplete: r.accessoriesComplete ?? true,
        verdict: r.verdict,
        criteriaResults: JSON.stringify(r.criteriaResults ?? []),
        notes: r.notes ?? null,
      },
    });
  }

  const updated = await db.inspection.update({
    where: { id: inspection.id },
    data: {
      result: input.result,
      findings: input.findings ?? null,
      conditions: input.conditions ?? null,
      inspectorId: inspection.inspectorId ?? user.id,
      inspectedAt: new Date(),
      signedByName: input.signedByName.trim(),
      signedAt: new Date(),
    },
  });

  await completeTasks("INSPECTION", inspection.id, user.id, db);

  if (input.result === "REJECTED" || input.result === "RE_INSPECTION_REQUIRED") {
    await raiseException(
      {
        type: "FAILED_INSPECTION",
        severity: input.result === "REJECTED" ? "HIGH" : "MEDIUM",
        title: `${inspection.number}: inspection ${input.result.toLowerCase().replace(/_/g, " ")}`,
        description: input.findings ?? undefined,
        documentType: "PO",
        documentId: inspection.poId ?? "",
        documentRef: inspection.po?.number ?? inspection.number,
        poId: inspection.poId,
        caseKey: inspection.po?.pr?.number ?? null,
        entityId: inspection.po?.entityId ?? null,
        raisedById: user.id,
        blocking: input.result === "REJECTED",
        notifyRoles: ["PROCUREMENT_OFFICER", "PROCUREMENT_SENIOR_MANAGER", "STORE_MANAGER"],
      },
      db,
      user,
    );
  }

  if (input.result === "APPROVED" || input.result === "CONDITIONAL") {
    await createTask(
      {
        title: `Raise GRN — inspection ${inspection.number} cleared`,
        taskType: "ACTION",
        assigneeId: inspection.delivery?.store.managerId ?? null,
        assignedRoleCode: inspection.delivery?.store.managerId ? null : "STORE_MANAGER",
        entityId: inspection.po?.entityId ?? null,
        documentType: "DELIVERY",
        documentId: inspection.deliveryId ?? inspection.id,
        documentRef: inspection.delivery?.number ?? inspection.number,
        priority: "HIGH",
        slaHours: 24,
        linkUrl: inspection.deliveryId ? `/receiving/${inspection.deliveryId}` : `/inspections/${inspection.id}`,
      },
      db,
    );
  }

  await notify(
    {
      roleCodes: ["PROCUREMENT_OFFICER", "STORE_MANAGER", "WAREHOUSE_MANAGER"],
      entityId: inspection.po?.entityId ?? null,
      type: "INSPECTION_REQUIRED",
      title: `Inspection ${inspection.number} — ${input.result.replace(/_/g, " ").toLowerCase()}`,
      body: input.findings ?? undefined,
      priority: input.result === "REJECTED" ? "HIGH" : "NORMAL",
      linkType: "INSPECTION",
      linkId: inspection.id,
      linkUrl: `/inspections/${inspection.id}`,
    },
    db,
  );

  await writeAudit(
    {
      entityType: "Inspection",
      entityId: inspection.id,
      entityRef: inspection.number,
      action: `INSPECTION_${input.result}`,
      newValue: {
        signedBy: input.signedByName,
        lines: input.items.map((i) => ({ passed: i.quantityPassed, failed: i.quantityFailed, verdict: i.verdict })),
      },
      reason: input.findings ?? null,
      caseKey: inspection.po?.pr?.number ?? null,
      actor: user,
    },
    db,
  );

  return updated;
}

export async function assignInspector(
  user: SessionUser,
  inspectionId: string,
  inspectorId: string,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.INSPECTION_PERFORM, P.PO_VIEW)) throw new ForbiddenError("Not permitted.");
  const inspection = await db.inspection.findUnique({ where: { id: inspectionId }, include: { po: { include: { pr: true } } } });
  if (!inspection) throw new NotFoundError("Inspection");
  const updated = await db.inspection.update({
    where: { id: inspectionId },
    data: { inspectorId, result: inspection.result === "PENDING" ? "IN_PROGRESS" : inspection.result },
  });
  await createTask(
    {
      title: `Technical inspection assigned — ${inspection.number}`,
      taskType: "INSPECTION",
      assigneeId: inspectorId,
      entityId: inspection.po?.entityId ?? null,
      documentType: "INSPECTION",
      documentId: inspection.id,
      documentRef: inspection.number,
      priority: "HIGH",
      slaHours: 48,
      linkUrl: `/inspections/${inspection.id}`,
    },
    db,
  );
  await writeAudit(
    {
      entityType: "Inspection",
      entityId: inspectionId,
      entityRef: inspection.number,
      action: "INSPECTION_ASSIGNED",
      newValue: { inspectorId },
      caseKey: inspection.po?.pr?.number ?? null,
      actor: user,
    },
    db,
  );
  return updated;
}

/** Categories that mandate inspection, resolved from configuration + category flags. */
export async function mandatoryInspectionCategoryCodes(entityId: string | null, db: DbClient = prisma) {
  const configured = await getConfigArray<string>(CONFIG_KEYS.REQUIRE_INSPECTION_CATEGORIES, entityId, db);
  const flagged = await db.category.findMany({ where: { requiresInspection: true }, select: { code: true } });
  return new Set([...configured, ...flagged.map((c) => c.code)]);
}
