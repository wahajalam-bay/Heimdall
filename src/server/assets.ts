import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { CONFIG_KEYS, getConfigBool, getConfigNumber } from "@/lib/config";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify, createTask, completeTasks } from "@/lib/notify";
import { PERMISSIONS as P } from "@/lib/permissions";
import { DOMAIN_ACTIONS, assertAuthority, type Actor, type Authority } from "@/lib/actor";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import type { AssetStatus, DisposalStage } from "@/lib/domain";
import { round2 } from "@/lib/format";
import { postMovement } from "./inventory";
import { assertDisposalEvidence } from "./disposal-evidence";

/**
 * Asset register, tagging, custody and the disposal / scrap lifecycle.
 */

/* ── Asset tagging ────────────────────────────────────────── */

/**
 * Creates asset records for GRN lines whose disposition is ASSET (or whose
 * category demands a tag). One asset per unit so custody can be tracked
 * individually.
 */
export async function tagAssetsFromGrn(
  actor: Actor,
  grnId: string,
  db: DbClient = prisma,
  /**
   * Tagging normally happens as a consequence of posting the receipt, and the
   * store user who posts it does not necessarily hold `asset.manage`. Callers
   * in that position name the receiving permission that authorized them.
   */
  authority: Authority = { permission: [P.ASSET_MANAGE] },
) {
  return withTransaction(db, async (tx) => {
    assertAuthority(actor, DOMAIN_ACTIONS.ASSET_TAG_FROM_GRN, authority);
    const grn = await tx.grn.findUnique({
      where: { id: grnId },
      include: {
        items: { include: { item: { include: { category: true } }, poItem: true } },
        po: { include: { pr: { include: { department: true } }, entity: true } },
        store: true,
        vendor: true,
      },
    });
    if (!grn) throw new NotFoundError("GRN");

    const created: string[] = [];
    for (const li of grn.items) {
      const category = li.item?.category;
      const isAsset = li.disposition === "ASSET" || Boolean(category?.assetTagRequired);
      if (!isAsset || li.acceptedQty <= 0) continue;

      const serials = (li.serialNumbers ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const units = Math.max(1, Math.round(li.acceptedQty));

      for (let u = 0; u < units; u++) {
        const assetId = await nextNumber(SEQ.ASSET, tx);
        const tag = `${grn.po.entity.code}-${assetId.split("-").slice(1).join("")}`;
        const asset = await tx.asset.create({
          data: {
            assetId,
            tag,
            name: li.item?.name ?? li.description,
            description: li.description,
            entityId: grn.po.entityId,
            departmentId: grn.po.pr?.departmentId ?? null,
            categoryId: li.item?.categoryId ?? null,
            itemId: li.itemId,
            storeId: grn.storeId,
            location: grn.store.name,
            serialNumber: serials[u] ?? null,
            brand: li.poItem.brand,
            model: li.poItem.model,
            purchaseDate: grn.receivedAt,
            vendorId: grn.vendorId,
            poId: grn.poId,
            grnId: grn.id,
            cost: li.unitPrice,
            currentValue: li.unitPrice,
            warrantyUntil: li.warrantyMonths
              ? new Date(grn.receivedAt.getTime() + li.warrantyMonths * 30 * 86400000)
              : null,
            status: "IN_STORAGE",
          },
        });
        await tx.assetTransaction.create({
          data: {
            assetId: asset.id,
            type: "TAGGED",
            toStatus: "IN_STORAGE",
            toLocation: grn.store.name,
            reference: grn.number,
            notes: `Tagged on receipt against ${grn.po.number}`,
            performedById: actor.id,
          },
        });
        created.push(asset.tag);
      }
    }

    if (created.length) {
      await writeAudit(
        {
          entityType: "Asset",
          entityId: grnId,
          entityRef: grn.number,
          action: "ASSETS_TAGGED",
          newValue: { tags: created },
          caseKey: grn.po.pr?.number ?? null,
          actor,
        },
        tx,
      );
    }
    return created;
  });
}

export async function updateAsset(
  user: SessionUser,
  assetId: string,
  input: {
    status?: AssetStatus;
    custodianId?: string | null;
    location?: string | null;
    office?: string | null;
    departmentId?: string | null;
    conditionNotes?: string | null;
    currentValue?: number | null;
  },
  reason: string | null,
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.ASSET_MANAGE)) {
      throw new ForbiddenError("You do not have permission to manage assets.");
    }
    const asset = await tx.asset.findUnique({ where: { id: assetId } });
    if (!asset) throw new NotFoundError("Asset");
    if (["DISPOSED", "SCRAPPED"].includes(asset.status)) {
      throw new RuleViolationError(`Asset ${asset.tag} is ${asset.status.toLowerCase()} and can no longer be modified.`);
    }

    const updated = await tx.asset.update({
      where: { id: assetId },
      data: {
        status: input.status ?? asset.status,
        custodianId: input.custodianId === undefined ? asset.custodianId : input.custodianId,
        location: input.location ?? asset.location,
        office: input.office ?? asset.office,
        departmentId: input.departmentId ?? asset.departmentId,
        conditionNotes: input.conditionNotes ?? asset.conditionNotes,
        currentValue: input.currentValue ?? asset.currentValue,
      },
    });

    const typeFor = (s: AssetStatus | undefined): string => {
      if (!s) return "REVALUED";
      if (s === "ISSUED") return "ISSUED";
      if (s === "IN_STORAGE") return "RETURNED";
      if (s === "TRANSFERRED") return "TRANSFERRED";
      if (s === "UNDER_REPAIR") return "REPAIR_IN";
      if (s === "IDLE") return "FLAGGED_IDLE";
      if (s === "OBSOLETE") return "FLAGGED_OBSOLETE";
      if (s === "LOST") return "LOST";
      return "REVALUED";
    };

    await tx.assetTransaction.create({
      data: {
        assetId,
        type: typeFor(input.status),
        fromStatus: asset.status,
        toStatus: updated.status,
        fromCustodianId: asset.custodianId,
        toCustodianId: updated.custodianId,
        fromLocation: asset.location,
        toLocation: updated.location,
        notes: reason,
        performedById: user.id,
      },
    });

    await writeAudit(
      {
        entityType: "Asset",
        entityId: assetId,
        entityRef: asset.tag,
        action: "ASSET_UPDATED",
        changes: {
          ...(input.status && input.status !== asset.status ? { status: { from: asset.status, to: input.status } } : {}),
          ...(input.custodianId !== undefined && input.custodianId !== asset.custodianId
            ? { custodianId: { from: asset.custodianId, to: input.custodianId } }
            : {}),
        },
        reason,
        actor: user,
      },
      tx,
    );

    return updated;
  });
}

/* ── Disposal ─────────────────────────────────────────────── */

export type DisposalItemInput = {
  assetId?: string | null;
  itemId?: string | null;
  storeId?: string | null;
  description: string;
  quantity: number;
  unit: string;
  condition?: string;
  bookValue?: number | null;
  estimatedValue?: number | null;
  notes?: string | null;
};

export async function createDisposalCase(
  user: SessionUser,
  input: {
    entityId: string;
    title: string;
    disposalCategory: string;
    recommendedAction?: string | null;
    assessmentNotes?: string | null;
    estimatedValue?: number | null;
    items: DisposalItemInput[];
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.DISPOSAL_CREATE)) {
      throw new ForbiddenError("You do not have permission to raise disposal cases.");
    }
    if (!input.items.length) throw new ValidationError("Add at least one item to dispose.");

    const estimatedValue =
      input.estimatedValue ?? round2(input.items.reduce((a, i) => a + (i.estimatedValue ?? 0), 0));
    const biddingThreshold = await getConfigNumber(CONFIG_KEYS.DISPOSAL_BIDDING_THRESHOLD, input.entityId, tx);
    const number = await nextNumber(SEQ.DISPOSAL, tx);

    const kase = await tx.disposalCase.create({
      data: {
        number,
        entityId: input.entityId,
        title: input.title.trim(),
        disposalCategory: input.disposalCategory,
        recommendedAction: input.recommendedAction ?? null,
        assessmentNotes: input.assessmentNotes ?? null,
        estimatedValue,
        stage: "FLAGGED",
        biddingRequired: estimatedValue >= biddingThreshold,
        raisedById: user.id,
        items: {
          create: input.items.map((it, i) => ({
            lineNo: i + 1,
            assetId: it.assetId ?? null,
            itemId: it.itemId ?? null,
            storeId: it.storeId ?? null,
            description: it.description,
            quantity: it.quantity,
            unit: it.unit,
            condition: it.condition ?? "OBSOLETE",
            bookValue: it.bookValue ?? null,
            estimatedValue: it.estimatedValue ?? null,
            notes: it.notes ?? null,
          })),
        },
      },
    });

    // Flag the underlying assets so they cannot be issued while under disposal.
    for (const it of input.items) {
      if (!it.assetId) continue;
      const a = await tx.asset.findUnique({ where: { id: it.assetId } });
      if (!a || ["DISPOSED", "SCRAPPED"].includes(a.status)) continue;
      await tx.asset.update({ where: { id: it.assetId }, data: { status: "OBSOLETE" } });
      await tx.assetTransaction.create({
        data: {
          assetId: it.assetId,
          type: "FLAGGED_OBSOLETE",
          fromStatus: a.status,
          toStatus: "OBSOLETE",
          reference: kase.number,
          notes: `Included in disposal case ${kase.number}`,
          performedById: user.id,
        },
      });
    }

    await createTask(
      {
        title: `Assess disposal case ${kase.number}`,
        description: input.title,
        taskType: "REVIEW",
        assignedRoleCode: "STORE_MANAGER",
        entityId: input.entityId,
        documentType: "DISPOSAL",
        documentId: kase.id,
        documentRef: kase.number,
        slaHours: 72,
        linkUrl: `/disposal/${kase.id}`,
      },
      tx,
    );

    await writeAudit(
      {
        entityType: "DisposalCase",
        entityId: kase.id,
        entityRef: kase.number,
        action: "DISPOSAL_RAISED",
        newValue: { title: input.title, items: input.items.length, estimatedValue, biddingRequired: kase.biddingRequired },
        actor: user,
      },
      tx,
    );

    return kase;
  });
}

const DISPOSAL_FLOW: Record<DisposalStage, DisposalStage[]> = {
  FLAGGED: ["ASSESSMENT", "CANCELLED"],
  ASSESSMENT: ["AUDIT_REVIEW", "PENDING_APPROVAL", "REJECTED", "CANCELLED"],
  AUDIT_REVIEW: ["PENDING_APPROVAL", "REJECTED", "CANCELLED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["BIDDING", "MANAGEMENT_APPROVAL", "PAYMENT_PENDING", "COMPLETED", "CANCELLED"],
  BIDDING: ["BID_EVALUATION", "CANCELLED"],
  BID_EVALUATION: ["MANAGEMENT_APPROVAL", "BIDDING", "CANCELLED"],
  MANAGEMENT_APPROVAL: ["PAYMENT_PENDING", "COMPLETED", "REJECTED", "CANCELLED"],
  PAYMENT_PENDING: ["PAYMENT_RECEIVED", "CANCELLED"],
  PAYMENT_RECEIVED: ["COMPLETED"],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
};

export async function advanceDisposal(
  user: SessionUser,
  caseId: string,
  to: DisposalStage,
  input: {
    notes?: string | null;
    finalAction?: string | null;
    assessmentNotes?: string | null;
    auditNotes?: string | null;
    bidDeadline?: Date | null;
    winningBidId?: string | null;
    paymentReference?: string | null;
    realisedValue?: number | null;
  } = {},
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    const kase = await tx.disposalCase.findUnique({
      where: { id: caseId },
      include: { items: { include: { asset: true } }, bids: true },
    });
    if (!kase) throw new NotFoundError("Disposal case");

    const from = kase.stage as DisposalStage;
    const allowed = DISPOSAL_FLOW[from] ?? [];
    if (!allowed.includes(to)) {
      throw new RuleViolationError(
        `Cannot move disposal case ${kase.number} from ${from} to ${to}. Permitted: ${allowed.join(", ") || "none"}.`,
      );
    }

    // Stage-specific authorization.
    const need = (...codes: string[]) => {
      if (!userHasPermission(user, ...codes)) {
        throw new ForbiddenError(`You do not have permission to move this case to ${to}.`);
      }
    };
    if (to === "AUDIT_REVIEW") {
      need(P.DISPOSAL_AUDIT_REVIEW, P.DISPOSAL_CREATE, P.DISPOSAL_APPROVE);
    }
    if (to === "ASSESSMENT" || to === "BIDDING" || to === "BID_EVALUATION") {
      need(P.DISPOSAL_CREATE, P.DISPOSAL_APPROVE);
    }
    if (to === "PENDING_APPROVAL") need(P.DISPOSAL_CREATE, P.DISPOSAL_APPROVE, P.DISPOSAL_AUDIT_REVIEW);
    if (to === "APPROVED" || to === "REJECTED") need(P.DISPOSAL_APPROVE);
    if (to === "MANAGEMENT_APPROVAL" || to === "PAYMENT_PENDING") need(P.DISPOSAL_APPROVE, P.DISPOSAL_MANAGEMENT_APPROVE);
    if (to === "PAYMENT_RECEIVED") need(P.PAYMENT_RECORD, P.DISPOSAL_APPROVE);
    if (to === "COMPLETED") need(P.DISPOSAL_APPROVE, P.DISPOSAL_MANAGEMENT_APPROVE);

    // Gating rules.
    if (to === "PENDING_APPROVAL") {
      const auditRequired = await getConfigBool(CONFIG_KEYS.DISPOSAL_REQUIRES_AUDIT, kase.entityId, tx);
      if (auditRequired && !kase.auditReviewAt && from !== "AUDIT_REVIEW") {
        throw new RuleViolationError(
          `Disposal case ${kase.number} requires audit review before approval can be sought.`,
        );
      }
      if (!kase.recommendedAction && !input.finalAction) {
        throw new RuleViolationError("Record the recommended disposition (reuse, transfer, repair, scrap, dispose or sale).");
      }
    }
    if (to === "MANAGEMENT_APPROVAL") {
      if (kase.biddingRequired && !input.winningBidId && !kase.winningBidId) {
        throw new RuleViolationError("Select the winning bid before seeking management approval.");
      }
    }
    if (to === "COMPLETED") {
      // The Scrap Material Policy's eight stages each produce evidence. Gated on
      // configuration and off by default: cases in flight have none of it.
      await assertDisposalEvidence(kase.id, kase.number, kase.entityId, tx);
      const mgmtThreshold = await getConfigNumber(CONFIG_KEYS.DISPOSAL_MGMT_APPROVAL_THRESHOLD, kase.entityId, tx);
      const realised = input.realisedValue ?? kase.realisedValue ?? 0;
      if (realised >= mgmtThreshold && !kase.managementApprovedAt && from !== "MANAGEMENT_APPROVAL") {
        throw new RuleViolationError(
          `Realised value PKR ${realised.toLocaleString("en-PK")} requires management committee approval before completion.`,
        );
      }
      if (kase.biddingRequired && !kase.paymentReceivedAt && from !== "PAYMENT_RECEIVED") {
        throw new RuleViolationError("Payment must be received before a sale disposal can be completed.");
      }
    }

    const data: Record<string, unknown> = { stage: to };
    if (input.finalAction) data.finalAction = input.finalAction;
    if (input.assessmentNotes) data.assessmentNotes = input.assessmentNotes;
    if (input.bidDeadline) data.bidDeadline = input.bidDeadline;
    if (input.realisedValue !== undefined && input.realisedValue !== null) data.realisedValue = input.realisedValue;
    if (to === "AUDIT_REVIEW") {
      data.auditReviewById = user.id;
      data.auditReviewAt = new Date();
      data.auditNotes = input.auditNotes ?? input.notes ?? null;
    }
    if (to === "APPROVED") {
      data.approvedById = user.id;
      data.approvedAt = new Date();
    }
    if (to === "MANAGEMENT_APPROVAL" && input.winningBidId) {
      data.winningBidId = input.winningBidId;
    }
    // Leaving the management-approval stage IS the management approval; the
    // permission check above has already confirmed the actor may give it.
    if (from === "MANAGEMENT_APPROVAL" && (to === "PAYMENT_PENDING" || to === "COMPLETED")) {
      data.managementApprovedById = kase.managementApprovedById ?? user.id;
      data.managementApprovedAt = kase.managementApprovedAt ?? new Date();
    }
    if (to === "PAYMENT_RECEIVED") {
      data.paymentReceivedAt = new Date();
      data.paymentReference = input.paymentReference ?? null;
    }
    if (to === "COMPLETED") {
      data.completedAt = new Date();
      data.managementApprovedById = kase.managementApprovedById ?? user.id;
      data.managementApprovedAt = kase.managementApprovedAt ?? new Date();
    }

    if (to === "MANAGEMENT_APPROVAL" && input.winningBidId) {
      await tx.disposalBid.updateMany({ where: { caseId }, data: { status: "LOST" } });
      await tx.disposalBid.update({ where: { id: input.winningBidId }, data: { status: "WON" } });
      const bid = await tx.disposalBid.findUnique({ where: { id: input.winningBidId } });
      if (bid) data.realisedValue = bid.amount;
    }

    const updated = await tx.disposalCase.update({ where: { id: caseId }, data });

    // Completion writes off inventory and retires the assets.
    if (to === "COMPLETED") {
      const finalAction = (updated.finalAction ?? updated.recommendedAction ?? "DISPOSE").toUpperCase();
      const retire = ["SCRAP", "DISPOSE", "SALE"].includes(finalAction);

      for (const it of kase.items) {
        if (it.itemId && it.storeId && it.quantity > 0 && retire) {
          await postMovement(
            "DISPOSAL",
            {
              itemId: it.itemId,
              storeId: it.storeId,
              quantity: it.quantity,
              unit: it.unit,
              source: { kind: "DISPOSAL", id: kase.id, ref: kase.number },
              reason: `Disposal ${finalAction.toLowerCase()} via ${kase.number}`,
              performedById: user.id,
            },
            tx,
            user,
            {
              cascade: `disposal case moved to ${to}`,
              from: [P.DISPOSAL_APPROVE, P.DISPOSAL_MANAGEMENT_APPROVE],
            },
          ).catch((e) => {
            // Stock may legitimately already be zero for items written off
            // outside the ledger, and `postMovement` reports that as a rule
            // violation before it writes anything. That case is expected here.
            //
            // Anything else is a real failure and must not be swallowed: this
            // runs inside a transaction, where one failed statement aborts every
            // write after it, so a blanket catch would hide the abort and report
            // a disposal that did not happen.
            if (!(e instanceof RuleViolationError)) throw e;
          });
        }
        if (it.assetId && retire) {
          const newStatus: AssetStatus = finalAction === "SCRAP" ? "SCRAPPED" : "DISPOSED";
          const a = it.asset;
          await tx.asset.update({
            where: { id: it.assetId },
            data: { status: newStatus, currentValue: 0, custodianId: null },
          });
          await tx.assetTransaction.create({
            data: {
              assetId: it.assetId,
              type: finalAction === "SCRAP" ? "SCRAPPED" : "DISPOSED",
              fromStatus: a?.status ?? null,
              toStatus: newStatus,
              reference: kase.number,
              notes: input.notes ?? `Completed via ${kase.number}`,
              performedById: user.id,
            },
          });
        }
        await tx.disposalItem.update({
          where: { id: it.id },
          data: { disposition: finalAction, realisedValue: it.realisedValue ?? it.estimatedValue },
        });
      }
      await completeTasks("DISPOSAL", caseId, user.id, tx);
    }

    // Next-step task and notification.
    const nextOwner: Partial<Record<DisposalStage, string>> = {
      ASSESSMENT: "STORE_MANAGER",
      AUDIT_REVIEW: "AUDIT_USER",
      PENDING_APPROVAL: "PROCUREMENT_SENIOR_MANAGER",
      APPROVED: "STORE_MANAGER",
      BIDDING: "PROCUREMENT_OFFICER",
      BID_EVALUATION: "PROCUREMENT_SENIOR_MANAGER",
      MANAGEMENT_APPROVAL: "MANAGEMENT_COMMITTEE",
      PAYMENT_PENDING: "FINANCE_USER",
      PAYMENT_RECEIVED: "FINANCE_USER",
    };
    const role = nextOwner[to];
    if (role) {
      await createTask(
        {
          title: `Disposal ${kase.number} — ${to.replace(/_/g, " ").toLowerCase()}`,
          taskType: "REVIEW",
          assignedRoleCode: role,
          entityId: kase.entityId,
          documentType: "DISPOSAL",
          documentId: caseId,
          documentRef: kase.number,
          slaHours: 72,
          linkUrl: `/disposal/${caseId}`,
        },
        tx,
      );
      await notify(
        {
          roleCodes: [role],
          entityId: kase.entityId,
          type: "DISPOSAL_APPROVAL",
          title: `Disposal ${kase.number} is now ${to.replace(/_/g, " ").toLowerCase()}`,
          body: kase.title,
          linkType: "DISPOSAL",
          linkId: caseId,
          linkUrl: `/disposal/${caseId}`,
        },
        tx,
      );
    }

    await writeAudit(
      {
        entityType: "DisposalCase",
        entityId: caseId,
        entityRef: kase.number,
        action: `DISPOSAL_${to}`,
        changes: { stage: { from, to } },
        reason: input.notes ?? null,
        newValue: { realisedValue: updated.realisedValue, finalAction: updated.finalAction },
        actor: user,
      },
      tx,
    );

    return updated;
  });
}

export async function addDisposalBid(
  user: SessionUser,
  input: {
    caseId: string;
    bidderName: string;
    vendorId?: string | null;
    contactPhone?: string | null;
    amount: number;
    notes?: string | null;
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.DISPOSAL_CREATE, P.DISPOSAL_APPROVE)) {
      throw new ForbiddenError("You do not have permission to record disposal bids.");
    }
    const kase = await tx.disposalCase.findUnique({ where: { id: input.caseId } });
    if (!kase) throw new NotFoundError("Disposal case");
    if (!["APPROVED", "BIDDING", "BID_EVALUATION"].includes(kase.stage)) {
      throw new RuleViolationError(
        `Bids can only be recorded while the case is approved or in bidding (current: ${kase.stage}).`,
      );
    }
    if (input.amount <= 0) throw new ValidationError("Bid amount must be greater than zero.");

    const bid = await tx.disposalBid.create({
      data: {
        caseId: input.caseId,
        bidderName: input.bidderName.trim(),
        vendorId: input.vendorId ?? null,
        contactPhone: input.contactPhone ?? null,
        amount: input.amount,
        notes: input.notes ?? null,
        status: "SUBMITTED",
      },
    });
    if (kase.stage === "APPROVED") {
      await tx.disposalCase.update({ where: { id: input.caseId }, data: { stage: "BIDDING" } });
    }
    await writeAudit(
      {
        entityType: "DisposalCase",
        entityId: input.caseId,
        entityRef: kase.number,
        action: "DISPOSAL_BID_RECORDED",
        newValue: { bidder: bid.bidderName, amount: bid.amount },
        actor: user,
      },
      tx,
    );
    return bid;
  });
}

/** Assets eligible to be flagged for disposal. */
export async function disposableAssets(entityIds: string[] | null, db: DbClient = prisma) {
  return db.asset.findMany({
    where: {
      status: { in: ["IDLE", "OBSOLETE", "UNDER_REPAIR", "IN_STORAGE"] },
      ...(entityIds ? { entityId: { in: entityIds } } : {}),
    },
    include: { entity: { select: { code: true } }, category: { select: { name: true } } },
    orderBy: { updatedAt: "desc" },
    take: 400,
  });
}
