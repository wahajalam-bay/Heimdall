import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify, createTask, completeTasks } from "@/lib/notify";
import { raiseException, autoResolveExceptions } from "@/lib/exceptions-service";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { STORE_ENTRY_DISPOSITIONS, type Disposition } from "@/lib/domain";
import { round2 } from "@/lib/format";
import { assertTreatments, capitalisationPolicy, decideTreatment } from "@/lib/treatment";
import { reconcileGrnToPo } from "./receiving-exceptions";
import { postMovement } from "./inventory";
import { recomputePoFulfilment } from "./po";
import { transitionPr } from "./pr";
import { tagAssetsFromGrn } from "./assets";

/**
 * Goods Receipt Note — the official confirmation that goods have entered
 * organisational inventory.
 *
 * Hard rules enforced here:
 *  - No GRN without a recorded physical receipt (delivery).
 *  - No GRN posting while a mandatory technical inspection is outstanding or failed.
 *  - Accepted quantity can never exceed what was physically verified.
 *  - Posting is the only path by which inventory increases.
 */

export type GrnReadiness = {
  ready: boolean;
  issues: string[];
  inspectionStatus: "NOT_REQUIRED" | "PENDING" | "APPROVED" | "REJECTED" | "CONDITIONAL";
};

export async function grnReadiness(deliveryId: string, db: DbClient = prisma): Promise<GrnReadiness> {
  const delivery = await db.delivery.findUnique({
    where: { id: deliveryId },
    include: {
      items: { include: { poItem: true } },
      inspections: { orderBy: { createdAt: "desc" } },
      po: true,
      grns: { where: { status: { not: "CANCELLED" } } },
    },
  });
  if (!delivery) throw new NotFoundError("Delivery");

  const issues: string[] = [];
  if (delivery.status === "REJECTED") {
    issues.push("This delivery was rejected in full — no goods may be taken into inventory.");
  }
  if (delivery.grns.length) {
    issues.push(`A GRN (${delivery.grns.map((g) => g.number).join(", ")}) already exists for this delivery.`);
  }
  if (!delivery.items.some((i) => i.acceptedQty > 0)) {
    issues.push("No accepted quantity was recorded on this delivery.");
  }

  const requiresInspection = delivery.items.some((i) => i.poItem.requiresInspection && i.acceptedQty > 0);
  let inspectionStatus: GrnReadiness["inspectionStatus"] = "NOT_REQUIRED";

  if (requiresInspection) {
    const latest = delivery.inspections[0];
    if (!latest) {
      inspectionStatus = "PENDING";
      issues.push("Technical inspection is mandatory for these items and has not been raised.");
    } else if (latest.result === "APPROVED") {
      inspectionStatus = "APPROVED";
    } else if (latest.result === "CONDITIONAL") {
      inspectionStatus = "CONDITIONAL";
    } else if (latest.result === "REJECTED") {
      inspectionStatus = "REJECTED";
      issues.push(`Technical inspection ${latest.number} was rejected — a GRN cannot be raised.`);
    } else {
      inspectionStatus = "PENDING";
      issues.push(
        `Technical inspection ${latest.number} is ${latest.result.replace(/_/g, " ").toLowerCase()} — it must be completed before a GRN.`,
      );
    }
  }

  return { ready: issues.length === 0, issues, inspectionStatus };
}

export type GrnItemInput = {
  deliveryItemId: string;
  acceptedQty: number;
  rejectedQty?: number;
  batchNumber?: string | null;
  serialNumbers?: string | null;
  expiryDate?: Date | null;
  warrantyMonths?: number | null;
  storeLocationId?: string | null;
  disposition?: Disposition;
  /**
   * Why this line departs from the item's default treatment.
   *
   * The same air conditioner is an office asset and a project cost, so the
   * receipt decides — but a decision with no reason cannot be reviewed, and
   * capitalising below the threshold needs an approval as well.
   */
  treatmentReason?: string | null;
  treatmentApprovedById?: string | null;
  /** Where the goods went, which is what makes the treatment defensible. */
  usageContext?: string | null;
  remarks?: string | null;
};

export type GrnInput = {
  deliveryId: string;
  storeId?: string | null;
  remarks?: string | null;
  items: GrnItemInput[];
  /** Post to inventory immediately rather than leaving a draft. */
  post?: boolean;
};

export async function createGrn(user: SessionUser, input: GrnInput, db: DbClient = prisma) {
  if (!userHasPermission(user, P.GRN_CREATE)) {
    throw new ForbiddenError("You do not have permission to create GRNs.");
  }
  const readiness = await grnReadiness(input.deliveryId, db);
  if (!readiness.ready) {
    throw new RuleViolationError("A GRN cannot be raised for this delivery yet.", readiness.issues);
  }

  const delivery = await db.delivery.findUnique({
    where: { id: input.deliveryId },
    include: {
      items: { include: { poItem: true, item: { include: { category: true } } } },
      po: { include: { pr: true, items: true } },
      gatePass: true,
      inspections: { orderBy: { createdAt: "desc" }, take: 1, include: { items: true } },
      store: true,
    },
  });
  if (!delivery) throw new NotFoundError("Delivery");

  const inspection = delivery.inspections[0] ?? null;

  const problems: string[] = [];
  const prepared: Array<{
    lineNo: number;
    deliveryItem: (typeof delivery.items)[number];
    acceptedQty: number;
    rejectedQty: number;
    input: GrnItemInput;
  }> = [];

  let lineNo = 0;
  for (const li of input.items) {
    const dl = delivery.items.find((d) => d.id === li.deliveryItemId);
    if (!dl) {
      problems.push("A GRN line does not belong to this delivery.");
      continue;
    }
    lineNo += 1;
    if (li.acceptedQty < 0) problems.push(`Line ${lineNo}: accepted quantity cannot be negative.`);
    if (li.acceptedQty > dl.acceptedQty + 1e-9) {
      problems.push(
        `Line ${lineNo} (${dl.description}): cannot take ${li.acceptedQty} ${dl.unit} into inventory — only ${dl.acceptedQty} ${dl.unit} was accepted at physical verification.`,
      );
    }
    // Inspection caps the quantity that may be taken in.
    if (inspection) {
      const ii = inspection.items.find((x) => x.poItemId === dl.poItemId);
      if (ii && li.acceptedQty > ii.quantityPassed + 1e-9) {
        problems.push(
          `Line ${lineNo} (${dl.description}): technical inspection passed only ${ii.quantityPassed} ${dl.unit}.`,
        );
      }
    }
    // Over-receipt guard at the PO level.
    const remaining = round2(dl.poItem.quantity - dl.poItem.acceptedQty);
    if (li.acceptedQty > remaining + 1e-9) {
      problems.push(
        `Line ${lineNo} (${dl.description}): only ${remaining} ${dl.unit} remains outstanding on ${delivery.po.number}.`,
      );
    }
    prepared.push({
      lineNo,
      deliveryItem: dl,
      acceptedQty: round2(li.acceptedQty),
      rejectedQty: round2(li.rejectedQty ?? Math.max(0, dl.actualQty - li.acceptedQty)),
      input: li,
    });
  }
  if (problems.length) throw new RuleViolationError("This GRN cannot be created.", problems);
  if (!prepared.some((p) => p.acceptedQty > 0)) {
    throw new ValidationError("A GRN needs at least one line with an accepted quantity.");
  }

  const storeId = input.storeId ?? delivery.storeId;
// Accounting treatment, per line and per receipt.
  //
  // The item's category says what it usually is; this receipt says what it is
  // this time. Where the two differ the reason is required, and where the line
  // capitalises below the configured threshold an approval is required too —
  // that is the only reading under which the approved requirements' two
  // statements about PKR 15,000 are both true. See BD-002.
  const policy = await capitalisationPolicy(delivery.po.entityId, db);
  const treatmentDecisions = prepared.map((p) => {
    const defaultTreatment = (p.deliveryItem.poItem.disposition ??
      p.deliveryItem.item?.category?.defaultDisposition ??
      "INVENTORY") as Disposition;
    return {
      lineNo: p.deliveryItem.poItem.lineNo,
      description: p.deliveryItem.description,
      deliveryItemId: p.deliveryItem.id,
      decision: decideTreatment({
        requested: p.input.disposition,
        defaultTreatment,
        lineValue: round2(p.acceptedQty * p.deliveryItem.poItem.unitPrice),
        categoryCode: p.deliveryItem.item?.category?.code ?? null,
        policy,
        reason: p.input.treatmentReason,
        approvedById: p.input.treatmentApprovedById,
      }),
    };
  });
  assertTreatments(treatmentDecisions);
  const decisionByDeliveryItem = new Map(
    treatmentDecisions.map((d) => [d.deliveryItemId, d.decision]),
  );

    const number = await nextNumber(SEQ.GRN, db);
  const totalValue = round2(
    prepared.reduce((a, p) => a + p.acceptedQty * p.deliveryItem.poItem.unitPrice, 0),
  );

  const grn = await db.grn.create({
    data: {
      number,
      poId: delivery.poId,
      vendorId: delivery.vendorId,
      deliveryId: delivery.id,
      gatePassId: delivery.gatePassId,
      inspectionId: inspection?.id ?? null,
      storeId,
      receivedById: user.id,
      receivedAt: new Date(),
      // Carried from the order, so the receipt states its own treatment.
      expenditureType: delivery.po.expenditureType,
      status: "DRAFT",
      inspectionStatus: readiness.inspectionStatus,
      totalValue,
      remarks: input.remarks ?? null,
      items: {
        create: prepared.map((p) => ({
          poItemId: p.deliveryItem.poItemId,
          itemId: p.deliveryItem.itemId,
          lineNo: p.lineNo,
          description: p.deliveryItem.description,
          orderedQty: p.deliveryItem.poItem.quantity,
          receivedQty: p.deliveryItem.actualQty,
          acceptedQty: p.acceptedQty,
          rejectedQty: p.rejectedQty,
          unit: p.deliveryItem.unit,
          unitPrice: p.deliveryItem.poItem.unitPrice,
          lineValue: round2(p.acceptedQty * p.deliveryItem.poItem.unitPrice),
          batchNumber: p.input.batchNumber ?? p.deliveryItem.batchNumber,
          serialNumbers: p.input.serialNumbers ?? p.deliveryItem.serialNumbers,
          expiryDate: p.input.expiryDate ?? p.deliveryItem.expiryDate,
          warrantyMonths: p.input.warrantyMonths ?? p.deliveryItem.warrantyMonths,
          storeLocationId: p.input.storeLocationId ?? null,
          disposition:
            decisionByDeliveryItem.get(p.deliveryItem.id)?.treatment ??
            p.input.disposition ??
            p.deliveryItem.poItem.disposition,
          defaultDisposition: decisionByDeliveryItem.get(p.deliveryItem.id)?.defaultTreatment ?? null,
          treatmentReason: p.input.treatmentReason ?? null,
          treatmentApprovedById: p.input.treatmentApprovedById ?? null,
          treatmentApprovedAt: p.input.treatmentApprovedById ? new Date() : null,
          capitalisedBelowThreshold:
            decisionByDeliveryItem.get(p.deliveryItem.id)?.belowThreshold ?? false,
          usageContext: p.input.usageContext ?? null,
          remarks: p.input.remarks ?? null,
        })),
      },
    },
  });

  await writeAudit(
    {
      entityType: "Grn",
      entityId: grn.id,
      entityRef: grn.number,
      action: "GRN_CREATED",
      newValue: {
        po: delivery.po.number,
        delivery: delivery.number,
        store: delivery.store.name,
        totalValue,
        inspectionStatus: readiness.inspectionStatus,
        lines: prepared.length,
      },
      caseKey: delivery.po.pr?.number ?? null,
      actor: user,
    },
    db,
  );

  if (input.post) {
    return postGrn(user, grn.id, db);
  }

  await createTask(
    {
      title: `Post GRN ${grn.number} to inventory`,
      taskType: "ACTION",
      assignedRoleCode: "STORE_MANAGER",
      entityId: delivery.po.entityId,
      documentType: "GRN",
      documentId: grn.id,
      documentRef: grn.number,
      priority: "HIGH",
      slaHours: 24,
      linkUrl: `/grn/${grn.id}`,
    },
    db,
  );

  return grn;
}

/**
 * Posts a GRN: writes inventory receipts, updates PO fulfilment, records price
 * history, tags assets and advances the requisition.
 */
/**
 * Commits a receipt to inventory.
 *
 * This is the longest write chain in the system — the receipt, a ledger movement
 * and a price history row per line, the item's standard price, the order's
 * fulfilment, possibly the requisition's state, the vendor rollup, tasks,
 * notifications and the variance reconciliation. Every one of those used to be a
 * separate committed write, so a failure part-way through left stock on the shelf
 * against an order that did not know it had arrived.
 *
 * Now all of it either happens or none of it does. Asset tagging is the one
 * exception and is deferred to after the commit, because tagging is explicitly
 * allowed to fail without blocking the receipt — and a caught error inside a
 * transaction would poison every write after it instead.
 */
export async function postGrn(user: SessionUser, grnId: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.GRN_POST)) {
    throw new ForbiddenError("You do not have permission to post GRNs to inventory.");
  }

  return withTransaction(db, async (tx, defer) => {
    const grn = await tx.grn.findUnique({
      where: { id: grnId },
      include: {
        items: { include: { poItem: true, item: true } },
        po: { include: { pr: true, vendor: true } },
        store: true,
        inspection: true,
        delivery: true,
      },
    });
    if (!grn) throw new NotFoundError("GRN");
    if (grn.status === "POSTED") return grn;
    if (grn.status === "CANCELLED") throw new RuleViolationError("A cancelled GRN cannot be posted.");

    // Re-verify inspection at posting time — the rule must hold even if the GRN sat as a draft.
    if (grn.inspectionStatus === "PENDING" || grn.inspectionStatus === "REJECTED") {
      throw new RuleViolationError(
        `GRN ${grn.number} cannot be posted: mandatory technical inspection is ${grn.inspectionStatus.toLowerCase()}.`,
      );
    }

    // The status flip is the idempotency guard, and it has to be conditional on
    // the row still being unposted rather than on the read above. Two requests
    // that both read DRAFT — a double-clicked button, a retried action — would
    // otherwise both proceed and post the stock twice. `updateMany` with the
    // status in the filter makes the check and the write one statement, so the
    // second request matches nothing and stops here.
    const claim = await tx.grn.updateMany({
      where: { id: grnId, status: { not: "POSTED" } },
      data: { status: "POSTED", postedAt: new Date(), postedById: user.id },
    });
    if (claim.count === 0) {
      // Somebody else posted it between the read and the claim. Their
      // transaction owns the rest of the chain.
      return (await tx.grn.findUniqueOrThrow({ where: { id: grnId } })) as typeof grn;
    }
    const posted = await tx.grn.findUniqueOrThrow({ where: { id: grnId } });

    // The cumulative cap, re-checked at the moment of posting.
    //
    // `createGrn` already refuses a draft that exceeds what remains outstanding,
    // but it measures the remainder from `poItem.acceptedQty`, which counts only
    // *posted* receipts. Two drafts raised against the same 40 outstanding
    // therefore both pass, and nothing stopped both from posting — 100 ordered
    // could become 140 received.
    //
    // Here the sum is taken inside the transaction that is doing the posting, so
    // the second one sees the first and is refused. This is the control the SOP
    // means by never receiving above the order: it holds at the point the stock
    // actually moves, not only at data entry.
    const alreadyPosted = await tx.grnItem.groupBy({
      by: ["poItemId"],
      where: { grn: { poId: grn.poId, status: "POSTED" }, grnId: { not: grnId } },
      _sum: { acceptedQty: true },
    });
    const postedByPoItem = new Map(
      alreadyPosted.map((r) => [r.poItemId, r._sum.acceptedQty ?? 0]),
    );
    const orderLines = await tx.purchaseOrderItem.findMany({
      where: { poId: grn.poId },
      select: { id: true, lineNo: true, description: true, unit: true, quantity: true },
    });
    const orderByItem = new Map(orderLines.map((l) => [l.id, l]));

    const breaches: string[] = [];
    for (const li of grn.items) {
      if (li.acceptedQty <= 0) continue;
      const order = orderByItem.get(li.poItemId);
      if (!order) continue;
      const before = round2(postedByPoItem.get(li.poItemId) ?? 0);
      const after = round2(before + li.acceptedQty);
      if (after > order.quantity + 1e-9) {
        breaches.push(
          `line ${order.lineNo} (${order.description}): ${order.quantity} ${order.unit} ordered, ` +
            `${before} ${order.unit} already received, and this receipt adds ${round2(li.acceptedQty)} — ${round2(after - order.quantity)} ${order.unit} too many`,
        );
      }
    }
    if (breaches.length) {
      throw new RuleViolationError(
        `${grn.number} would take more into inventory than ${grn.po.number} ordered: ${breaches.join("; ")}. ` +
          "Receiving above the order needs a purchase order amendment, not a larger receipt.",
      );
    }

    for (const li of grn.items) {
      if (li.acceptedQty <= 0) continue;

      // Only inventory-bearing dispositions create stock; expensed items are
      // recorded on the GRN but do not inflate inventory.
      const needsStock = STORE_ENTRY_DISPOSITIONS.includes(li.disposition as Disposition);
      if (needsStock && li.itemId) {
        await postMovement(
          "RECEIPT",
          {
            itemId: li.itemId,
            storeId: grn.storeId,
            quantity: li.acceptedQty,
            unit: li.unit,
            unitCost: li.unitPrice,
            batchNumber: li.batchNumber,
            serialNumber: li.serialNumbers && !li.serialNumbers.includes(",") ? li.serialNumbers : null,
            expiryDate: li.expiryDate,
            warrantyMonths: li.warrantyMonths,
            locationId: li.storeLocationId,
            projectId: grn.po.pr?.projectId ?? null,
            entityId: grn.po.entityId,
            source: { kind: "GRN", id: grn.id, ref: grn.number },
            reason: `Receipt against ${grn.po.number}`,
            performedById: user.id,
          },
          tx,
          user,
        );
      }

      // Actual purchase price becomes the baseline for future comparatives.
      if (li.itemId) {
        await tx.priceHistory.create({
          data: {
            itemId: li.itemId,
            vendorId: grn.vendorId,
            unitPrice: li.unitPrice,
            quantity: li.acceptedQty,
            source: "PO",
            sourceRef: grn.po.number,
          },
        });
        await tx.item.update({ where: { id: li.itemId }, data: { standardPrice: li.unitPrice } });
      }
    }

      // Posting a receipt is what creates the asset record; the store user who
      // posts it need not also hold `asset.manage`, so the grounds are named.
      const postGrounds = { cascade: "goods receipt posted", from: [P.GRN_POST] } as const;

      // Deferred, not swallowed. Tagging must not block the receipt, and the only
      // way to keep that true is to run it after the receipt is committed — a
      // caught failure inside the transaction would abort the posting silently.
      defer({
        label: `tag assets from ${grn.number}`,
        run: () => tagAssetsFromGrn(user, grn.id, prisma, postGrounds),
      });

      const fulfilment = await recomputePoFulfilment(grn.poId, user, tx, postGrounds);
    await completeTasks("GRN", grnId, user.id, tx);
    if (grn.deliveryId) await completeTasks("DELIVERY", grn.deliveryId, user.id, tx);

    // Vendor spend / recency rollup.
    await tx.vendor.update({
      where: { id: grn.vendorId },
      data: { lastOrderAt: new Date() },
    });

    await autoResolveExceptions("PO", grn.poId, ["MISSING_GRN"], `GRN ${grn.number} posted`, tx);

    if (grn.po.prId && fulfilment.allComplete) {
      await transitionPr(user, grn.po.prId, "GRN_COMPLETED", { force: true, authority: postGrounds }, tx);
      await createTask(
        {
          title: `Verify vendor invoice for ${grn.po.number}`,
          taskType: "VERIFICATION",
          assignedRoleCode: "PROCUREMENT_OFFICER",
          entityId: grn.po.entityId,
          documentType: "PO",
          documentId: grn.poId,
          documentRef: grn.po.number,
          slaHours: await getConfigNumber(CONFIG_KEYS.SLA_INVOICE_VERIFICATION_HOURS, grn.po.entityId, tx),
          linkUrl: `/po/${grn.poId}`,
        },
        tx,
      );
    }

    await notify(
      {
        roleCodes: ["PROCUREMENT_OFFICER", "STORE_MANAGER", "FINANCE_USER"],
        userIds: grn.po.pr ? [grn.po.pr.requesterId] : [],
        entityId: grn.po.entityId,
        type: "GRN_PENDING",
        title: `${grn.number} posted — ${grn.store.name}`,
        body: `${grn.po.number} · PKR ${grn.totalValue.toLocaleString("en-PK")} taken into inventory`,
        linkType: "GRN",
        linkId: grn.id,
        linkUrl: `/grn/${grn.id}`,
      },
      tx,
    );

    await createTask(
      {
        title: `Record goods stacking for ${grn.number}`,
        taskType: "ACTION",
        assigneeId: grn.store.managerId ?? null,
        assignedRoleCode: grn.store.managerId ? null : "STORE_RECEIVER",
        entityId: grn.po.entityId,
        documentType: "GRN",
        documentId: grn.id,
        documentRef: grn.number,
        slaHours: 24,
        linkUrl: `/grn/${grn.id}`,
      },
      tx,
    );

    // Squaring the receipt off against the order does not make the difference
    // vanish: it records it, typed and owned, so the order can close while the
    // shortfall or overage remains answerable.
    const variances = await reconcileGrnToPo(user, grn.id, tx, postGrounds);

    await writeAudit(
      {
        entityType: "Grn",
        entityId: grn.id,
        entityRef: grn.number,
        action: "GRN_POSTED",
        newValue: {
          totalValue: grn.totalValue,
          store: grn.store.name,
          poFullyReceived: fulfilment.allComplete,
          variancesRecorded: variances,
          lines: grn.items.map((i) => ({ line: i.lineNo, accepted: i.acceptedQty, disposition: i.disposition })),
        },
        caseKey: grn.po.pr?.number ?? null,
        actor: user,
      },
      tx,
    );

    return posted;
  });
}

/** Reverses a posted GRN by writing compensating movements — never by deleting. */
export async function cancelGrn(user: SessionUser, grnId: string, reason: string, db: DbClient = prisma) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.GRN_CANCEL)) {
      throw new ForbiddenError("You do not have permission to cancel GRNs.");
    }
    if (!reason?.trim()) throw new ValidationError("A cancellation reason is required.");

    const grn = await tx.grn.findUnique({
      where: { id: grnId },
      include: { items: true, po: { include: { pr: true } }, invoiceMatches: true },
    });
    if (!grn) throw new NotFoundError("GRN");
    if (grn.status === "CANCELLED") return grn;
    if (grn.invoiceMatches.length) {
      throw new RuleViolationError(
        `GRN ${grn.number} is matched to ${grn.invoiceMatches.length} invoice(s). Resolve those first.`,
      );
    }

    if (grn.status === "POSTED") {
      for (const li of grn.items) {
        if (li.acceptedQty <= 0 || !li.itemId) continue;
        if (!STORE_ENTRY_DISPOSITIONS.includes(li.disposition as Disposition)) continue;
        await postMovement(
          "ADJUSTMENT",
          {
            itemId: li.itemId,
            storeId: grn.storeId,
            quantity: -li.acceptedQty,
            unit: li.unit,
            unitCost: li.unitPrice,
            batchNumber: li.batchNumber,
            serialNumber: li.serialNumbers && !li.serialNumbers.includes(",") ? li.serialNumbers : null,
            source: { kind: "ADJUSTMENT", id: grn.id, ref: `Reversal of ${grn.number}` },
            reason: `GRN cancelled: ${reason}`,
            performedById: user.id,
          },
          tx,
          user,
          { cascade: "goods receipt cancelled", from: [P.GRN_CANCEL] },
        );
      }
    }

    const cancelled = await tx.grn.update({
      where: { id: grnId },
      data: { status: "CANCELLED", remarks: `${grn.remarks ?? ""}\nCancelled: ${reason}`.trim() },
    });
    await recomputePoFulfilment(grn.poId, user, tx, {
      cascade: "goods receipt cancelled",
      from: [P.GRN_CANCEL],
    });

    await raiseException(
      {
        type: "OTHER",
        severity: "HIGH",
        title: `GRN ${grn.number} cancelled after posting`,
        description: reason,
        documentType: "GRN",
        documentId: grn.id,
        documentRef: grn.number,
        poId: grn.poId,
        caseKey: grn.po.pr?.number ?? null,
        entityId: grn.po.entityId,
        raisedById: user.id,
        notifyRoles: ["PROCUREMENT_SENIOR_MANAGER", "AUDIT_USER"],
      },
      tx,
      user,
    );

    await writeAudit(
      {
        entityType: "Grn",
        entityId: grnId,
        entityRef: grn.number,
        action: "GRN_CANCELLED",
        reason,
        changes: { status: { from: grn.status, to: "CANCELLED" } },
        caseKey: grn.po.pr?.number ?? null,
        actor: user,
      },
      tx,
    );

    return cancelled;
  });
}

/* ── Goods stacking ───────────────────────────────────────── */

export async function recordStacking(
  user: SessionUser,
  input: {
    grnId?: string | null;
    storeId: string;
    entries: Array<{
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
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.STACKING_RECORD)) {
      throw new ForbiddenError("You do not have permission to record goods stacking.");
    }
    if (!input.entries.length) throw new ValidationError("Record at least one stacking entry.");

    const created = [];
    for (const e of input.entries) {
      if (e.quantity <= 0) throw new ValidationError(`Stacked quantity must be greater than zero for "${e.description}".`);
      const row = await tx.goodsStacking.create({
        data: {
          grnId: input.grnId ?? null,
          storeId: input.storeId,
          locationId: e.locationId ?? null,
          itemId: e.itemId ?? null,
          description: e.description,
          quantity: e.quantity,
          unit: e.unit,
          stackingMethod: e.stackingMethod ?? "RACK",
          goodsClass: e.goodsClass ?? "GENERAL",
          handlingRequirements: e.handlingRequirements ?? null,
          stackedById: user.id,
          notes: e.notes ?? null,
        },
      });
      created.push(row);

      // Bind the stock to its physical bin.
      if (e.itemId && e.locationId) {
        await tx.inventoryItem.updateMany({
          where: { itemId: e.itemId, storeId: input.storeId, locationId: null },
          data: { locationId: e.locationId },
        });
      }
    }

    if (input.grnId) await completeTasks("GRN", input.grnId, user.id, tx);

    await writeAudit(
      {
        entityType: "GoodsStacking",
        entityId: created[0]?.id ?? input.storeId,
        entityRef: input.grnId ?? input.storeId,
        action: "STACKING_RECORDED",
        newValue: { entries: created.length, storeId: input.storeId },
        actor: user,
      },
      tx,
    );

    return created;
  });
}

/* ── Open PO / missing GRN monitoring ─────────────────────── */

export type OpenPoRow = {
  id: string;
  number: string;
  entityCode: string;
  vendorId: string;
  vendorName: string;
  status: string;
  total: number;
  orderedQty: number;
  receivedQty: number;
  pendingQty: number;
  pendingValue: number;
  issuedAt: Date | null;
  deliveryDate: Date | null;
  daysOpen: number | null;
  daysOverdue: number | null;
  grnCount: number;
  deliveryCount: number;
  inspectionPending: number;
  openExceptions: number;
  storeName: string | null;
  prNumber: string | null;
  flags: string[];
};

/**
 * The Open PO control tower dataset: everything issued but not fully received,
 * with the exception reasons that make each row actionable.
 */
export async function openPoRows(
  entityIds: string[] | null,
  db: DbClient = prisma,
): Promise<OpenPoRow[]> {
  const staleDays = await getConfigNumber(CONFIG_KEYS.OPEN_PO_STALE_DAYS, entityIds?.[0] ?? null, db);
  const missingGrnDays = await getConfigNumber(CONFIG_KEYS.MISSING_GRN_DAYS, entityIds?.[0] ?? null, db);

  const pos = await db.purchaseOrder.findMany({
    where: {
      status: { in: ["APPROVED", "ISSUED", "PARTIALLY_RECEIVED"] },
      ...(entityIds ? { entityId: { in: entityIds } } : {}),
    },
    include: {
      items: true,
      vendor: { select: { id: true, name: true } },
      entity: { select: { code: true } },
      deliveryStore: { select: { name: true } },
      pr: { select: { number: true } },
      grns: { where: { status: "POSTED" }, select: { id: true } },
      deliveries: { select: { id: true, inspections: { select: { result: true } } } },
      exceptions: { where: { status: { in: ["OPEN", "IN_PROGRESS"] } }, select: { id: true } },
    },
    orderBy: { issuedAt: "asc" },
  });

  const now = Date.now();

  return pos.map((po) => {
    const orderedQty = round2(po.items.reduce((a, i) => a + i.quantity, 0));
    const receivedQty = round2(po.items.reduce((a, i) => a + i.acceptedQty, 0));
    const pendingQty = round2(Math.max(0, orderedQty - receivedQty));
    const pendingValue = round2(
      po.items.reduce((a, i) => a + Math.max(0, i.quantity - i.acceptedQty) * i.unitPrice, 0),
    );
    const daysOpen = po.issuedAt ? Math.floor((now - po.issuedAt.getTime()) / 86400000) : null;
    const daysOverdue = po.deliveryDate
      ? Math.floor((now - po.deliveryDate.getTime()) / 86400000)
      : null;
    const inspectionPending = po.deliveries.reduce(
      (a, d) => a + d.inspections.filter((i) => ["PENDING", "IN_PROGRESS", "RE_INSPECTION_REQUIRED"].includes(i.result)).length,
      0,
    );

    const flags: string[] = [];
    if (po.grns.length === 0) flags.push("No GRN");
    else if (pendingQty > 0) flags.push("Partial GRN");
    if (daysOverdue !== null && daysOverdue > 0) flags.push(`Overdue ${daysOverdue}d`);
    if (daysOverdue !== null && daysOverdue <= 0 && daysOverdue > -4) flags.push("Due soon");
    if (daysOpen !== null && daysOpen > staleDays) flags.push("Long outstanding");
    if (po.grns.length === 0 && daysOverdue !== null && daysOverdue > missingGrnDays) flags.push("Missing GRN");
    if (inspectionPending > 0) flags.push("Inspection pending");
    if (po.exceptions.length > 0) flags.push(`${po.exceptions.length} exception(s)`);

    return {
      id: po.id,
      number: po.number,
      entityCode: po.entity.code,
      vendorId: po.vendor.id,
      vendorName: po.vendor.name,
      status: po.status,
      total: po.total,
      orderedQty,
      receivedQty,
      pendingQty,
      pendingValue,
      issuedAt: po.issuedAt,
      deliveryDate: po.deliveryDate,
      daysOpen,
      daysOverdue,
      grnCount: po.grns.length,
      deliveryCount: po.deliveries.length,
      inspectionPending,
      openExceptions: po.exceptions.length,
      storeName: po.deliveryStore?.name ?? null,
      prNumber: po.pr?.number ?? null,
      flags,
    };
  });
}

/**
 * Sweep that raises missing-GRN exceptions for overdue POs. Safe to run
 * repeatedly — `raiseException` de-duplicates.
 */
export async function sweepMissingGrns(db: DbClient = prisma) {
  const rows = await openPoRows(null, db);
  let raised = 0;
  for (const r of rows) {
    if (!r.flags.includes("Missing GRN")) continue;
    await raiseException(
      {
        type: "MISSING_GRN",
        severity: r.daysOverdue && r.daysOverdue > 30 ? "HIGH" : "MEDIUM",
        title: `${r.number}: no GRN ${r.daysOverdue}d past promised delivery`,
        description: `${r.vendorName} · pending ${r.pendingQty} unit(s) worth PKR ${r.pendingValue.toLocaleString("en-PK")}.`,
        documentType: "PO",
        documentId: r.id,
        documentRef: r.number,
        poId: r.id,
        raisedById: null,
        notifyRoles: ["PROCUREMENT_OFFICER", "PROCUREMENT_SENIOR_MANAGER"],
      },
      db,
      null,
    );
    raised += 1;
  }
  return raised;
}
