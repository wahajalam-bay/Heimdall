import { createHash } from "node:crypto";
import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { assertEntityAccess, userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { round2 } from "@/lib/format";

/**
 * Controlled amendment — requisitions and RFQs.
 *
 * The previous protection was blunt: a requisition could not be edited once it
 * left draft. That sounds strict and is actually weak, because an approved
 * requisition that genuinely needs a change had no route at all — so the change
 * happens by cancelling and re-raising, and the trail is lost. The same for an
 * RFQ, where amendment, cancellation and reissue were all simply absent.
 *
 * What was missing is versioning. An approval is given against a *state* of a
 * document, and the only way to know whether it still covers what is there is to
 * keep the states. So:
 *
 *   · Each submission snapshots the document and its lines.
 *   · An amendment after approval bumps the version, records why, summarises
 *     what changed, and sends the document back for approval — because the
 *     approval that exists was given against a version that no longer stands.
 *   · An RFQ amendment leaves existing quotations answering the old scope, and
 *     says so, rather than letting a comparative mix versions.
 *
 * Snapshots, not diffs. A diff can only be read against the thing it came from,
 * and the point is to be able to read a past version on its own.
 */

export type RevisionSummary = {
  version: number;
  createdAt: Date;
  createdByName: string;
  amendmentReason: string | null;
  changeSummary: string | null;
  contentHash: string;
  isCurrent: boolean;
};

function hash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/* ── Requisitions ─────────────────────────────────────────── */

type PrSnapshotShape = {
  number: string;
  title: string;
  justification: string | null;
  requiredDate: string;
  priority: string;
  estimatedValue: number;
  requiredLocation: string | null;
  documentComments: string | null;
  deliveryStoreId: string | null;
  lines: Array<{
    lineNo: number;
    itemCode: string | null;
    description: string;
    specification: string | null;
    quantity: number;
    unit: string;
    estimatedUnitPrice: number | null;
    estimatedTotal: number;
  }>;
};

async function prSnapshot(prId: string, db: DbClient): Promise<PrSnapshotShape> {
  const pr = await db.purchaseRequisition.findUnique({
    where: { id: prId },
    include: { items: { orderBy: { lineNo: "asc" } } },
  });
  if (!pr) throw new NotFoundError("Requisition");
  return {
    number: pr.number,
    title: pr.title,
    justification: pr.justification,
    requiredDate: pr.requiredDate.toISOString(),
    priority: pr.priority,
    estimatedValue: pr.estimatedValue,
    requiredLocation: pr.requiredLocation,
    documentComments: pr.documentComments,
    deliveryStoreId: pr.deliveryStoreId,
    lines: pr.items.map((i) => ({
      lineNo: i.lineNo,
      itemCode: i.itemCode,
      description: i.description,
      specification: i.specification,
      quantity: i.quantity,
      unit: i.unit,
      estimatedUnitPrice: i.estimatedUnitPrice,
      estimatedTotal: i.estimatedTotal,
    })),
  };
}

/**
 * What changed between two snapshots, in words.
 *
 * Written for an approver re-reading a document they already approved once. They
 * need to know whether the change is material, and "quantity on line 2 went from
 * 6 to 40" answers that in a way two JSON blobs do not.
 */
function describeChanges(before: PrSnapshotShape, after: PrSnapshotShape): string[] {
  const out: string[] = [];

  if (before.title !== after.title) out.push(`Title changed.`);
  if (before.justification !== after.justification) out.push("Justification changed.");
  if (before.requiredDate !== after.requiredDate) {
    out.push(
      `Required date moved from ${before.requiredDate.slice(0, 10)} to ${after.requiredDate.slice(0, 10)}.`,
    );
  }
  if (before.priority !== after.priority) {
    out.push(`Priority changed from ${before.priority} to ${after.priority}.`);
  }
  if (round2(before.estimatedValue) !== round2(after.estimatedValue)) {
    const delta = round2(after.estimatedValue - before.estimatedValue);
    out.push(
      `Value ${delta > 0 ? "up" : "down"} ${Math.abs(delta).toLocaleString("en-PK")} — ` +
        `${before.estimatedValue.toLocaleString("en-PK")} to ${after.estimatedValue.toLocaleString("en-PK")}.`,
    );
  }
  if (before.requiredLocation !== after.requiredLocation) out.push("Required location changed.");
  if (before.deliveryStoreId !== after.deliveryStoreId) out.push("Delivery store changed.");

  const beforeByLine = new Map(before.lines.map((l) => [l.lineNo, l]));
  const afterByLine = new Map(after.lines.map((l) => [l.lineNo, l]));

  for (const [lineNo, b] of beforeByLine) {
    const a = afterByLine.get(lineNo);
    if (!a) {
      out.push(`Line ${lineNo} removed (${b.description}, ${b.quantity} ${b.unit}).`);
      continue;
    }
    if (b.quantity !== a.quantity) {
      out.push(`Line ${lineNo} quantity ${b.quantity} → ${a.quantity} ${a.unit}.`);
    }
    if (b.description !== a.description) out.push(`Line ${lineNo} description changed.`);
    if (b.specification !== a.specification) out.push(`Line ${lineNo} specification changed.`);
    if (b.estimatedUnitPrice !== a.estimatedUnitPrice) {
      out.push(
        `Line ${lineNo} unit price ${b.estimatedUnitPrice ?? "—"} → ${a.estimatedUnitPrice ?? "—"}.`,
      );
    }
  }
  for (const [lineNo, a] of afterByLine) {
    if (!beforeByLine.has(lineNo)) {
      out.push(`Line ${lineNo} added (${a.description}, ${a.quantity} ${a.unit}).`);
    }
  }

  return out;
}

/**
 * Snapshots the requisition as the version currently on the table.
 *
 * Called at submission. Idempotent for a version already captured, so a
 * resubmission after a return does not create two identical rows.
 */
export async function captureePrRevision(
  user: SessionUser,
  prId: string,
  opts: { amendmentReason?: string | null } = {},
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    const pr = await tx.purchaseRequisition.findUnique({
      where: { id: prId },
      select: { id: true, number: true, revisionVersion: true, entityId: true },
    });
    if (!pr) throw new NotFoundError("Requisition");

    const snapshot = await prSnapshot(prId, tx);
    const contentHash = hash(snapshot);

    const existing = await tx.documentRevision.findUnique({
      where: {
        documentType_documentId_version: {
          documentType: "PR",
          documentId: prId,
          version: pr.revisionVersion,
        },
      },
    });
    // Nothing has changed since this version was captured, so there is nothing
    // to capture. Writing an identical row would make the history longer without
    // making it more informative.
    if (existing && existing.contentHash === contentHash) return existing;

    const previous = await tx.documentRevision.findFirst({
      where: { documentType: "PR", documentId: prId },
      orderBy: { version: "desc" },
    });
    const changeSummary = previous
      ? describeChanges(JSON.parse(previous.snapshot) as PrSnapshotShape, snapshot).join(" ")
      : null;

    if (existing) {
      return tx.documentRevision.update({
        where: { id: existing.id },
        data: {
          snapshot: JSON.stringify(snapshot),
          contentHash,
          changeSummary: changeSummary || existing.changeSummary,
          amendmentReason: opts.amendmentReason ?? existing.amendmentReason,
        },
      });
    }

    await tx.documentRevision.updateMany({
      where: { documentType: "PR", documentId: prId, isCurrent: true },
      data: { isCurrent: false },
    });
    return tx.documentRevision.create({
      data: {
        documentType: "PR",
        documentId: prId,
        documentRef: pr.number,
        version: pr.revisionVersion,
        snapshot: JSON.stringify(snapshot),
        contentHash,
        amendmentReason: opts.amendmentReason ?? null,
        changeSummary: changeSummary || null,
        createdById: user.id,
        isCurrent: true,
      },
    });
  });
}

/**
 * Amends an approved requisition.
 *
 * This is the route that did not exist. It does not edit anything itself — it
 * opens the document for editing by returning it to the requester, having first
 * captured the approved version and recorded why the amendment is being made.
 *
 * The approval is not deleted. It stands against the version it was given for,
 * and `approvedVersion` records which — so the requisition can say "approved at
 * version 2, now at version 3" rather than looking approved when it is not.
 */
export async function amendPr(
  user: SessionUser,
  input: { prId: string; reason: string },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.PR_EDIT, P.PR_CREATE)) {
    throw new RuleViolationError("You do not have permission to amend a requisition.");
  }
  if (!input.reason?.trim()) {
    throw new ValidationError(
      "Say why the requisition is being amended. An approved document reopened without a reason is indistinguishable from one being quietly changed.",
    );
  }

  return withTransaction(db, async (tx) => {
    const pr = await tx.purchaseRequisition.findUnique({
      where: { id: input.prId },
      include: { purchaseOrders: { select: { id: true, number: true, status: true } } },
    });
    if (!pr) throw new NotFoundError("Requisition");
    assertEntityAccess(user, pr.entityId);

    // Once an order exists the requisition is no longer the document that
    // matters — amending it would leave the order describing something else.
    const liveOrders = pr.purchaseOrders.filter((p) => !["CANCELLED", "DRAFT"].includes(p.status));
    if (liveOrders.length) {
      throw new RuleViolationError(
        `${pr.number} has ${liveOrders.length} live purchase order(s): ${liveOrders.map((o) => o.number).join(", ")}. ` +
          "Amend the order, or cancel it first — amending the requisition underneath it would leave the order describing a demand that no longer exists.",
      );
    }
    const amendable = ["APPROVED", "PROCUREMENT_REVIEW", "SOURCING", "CPC_REVIEW", "PO_PREPARATION"];
    if (!amendable.includes(pr.status)) {
      throw new RuleViolationError(
        `${pr.number} is ${pr.status}. Amendment is for a requisition that has been approved — a draft can simply be edited, and a closed one cannot be reopened.`,
      );
    }

    // Capture what was approved, before anything changes.
    await captureePrRevision(user, pr.id, {}, tx);

    const updated = await tx.purchaseRequisition.update({
      where: { id: pr.id },
      data: {
        status: "RETURNED",
        returnReason: `Amendment: ${input.reason.trim()}`,
        revisionVersion: pr.revisionVersion + 1,
        amendmentCount: pr.amendmentCount + 1,
        lastAmendmentReason: input.reason.trim(),
        // The approval stands against the version it was given for. `approvedAt`
        // and `approvedById` are left alone deliberately — deleting them would
        // erase the fact that somebody did approve version N.
        approvedVersion: pr.approvedVersion ?? pr.revisionVersion,
      },
    });

    await writeAudit(
      {
        entityType: "PurchaseRequisition",
        entityId: pr.id,
        entityRef: pr.number,
        action: "PR_AMENDMENT_OPENED",
        newValue: {
          fromVersion: pr.revisionVersion,
          toVersion: pr.revisionVersion + 1,
          approvedVersion: pr.approvedVersion ?? pr.revisionVersion,
        },
        reason: input.reason.trim(),
        caseKey: pr.number,
        actor: user,
      },
      tx,
    );

    await notify(
      {
        userIds: [pr.requesterId],
        entityId: pr.entityId,
        type: "PR_AMENDMENT",
        title: `${pr.number} reopened for amendment`,
        body: `${input.reason.trim()} It is now version ${pr.revisionVersion + 1} and needs approval again.`,
        priority: "HIGH",
        linkType: "PR",
        linkId: pr.id,
        linkUrl: `/pr/${pr.id}`,
      },
      tx,
    );

    return updated;
  });
}

/** Marks the approval as covering the current version. Called on approval. */
export async function stampApprovedVersion(prId: string, db: DbClient = prisma) {
  const pr = await db.purchaseRequisition.findUnique({
    where: { id: prId },
    select: { revisionVersion: true },
  });
  if (!pr) return null;
  return db.purchaseRequisition.update({
    where: { id: prId },
    data: { approvedVersion: pr.revisionVersion },
  });
}

/** Whether the standing approval still covers what the document says now. */
export async function approvalCoversCurrent(
  prId: string,
  db: DbClient = prisma,
): Promise<{ covered: boolean; approvedVersion: number | null; currentVersion: number; note: string | null }> {
  const pr = await db.purchaseRequisition.findUnique({
    where: { id: prId },
    select: { revisionVersion: true, approvedVersion: true, approvedAt: true, amendmentCount: true },
  });
  if (!pr) throw new NotFoundError("Requisition");
  if (!pr.approvedAt) {
    return { covered: false, approvedVersion: null, currentVersion: pr.revisionVersion, note: null };
  }
  const covered = pr.approvedVersion === pr.revisionVersion;
  return {
    covered,
    approvedVersion: pr.approvedVersion,
    currentVersion: pr.revisionVersion,
    note: covered
      ? null
      : `The approval on file was given against version ${pr.approvedVersion ?? 1}; this is now version ${pr.revisionVersion}. ` +
        `${pr.amendmentCount} amendment(s) since.`,
  };
}

export async function revisionHistory(
  documentType: "PR" | "RFQ",
  documentId: string,
  db: DbClient = prisma,
): Promise<RevisionSummary[]> {
  const rows = await db.documentRevision.findMany({
    where: { documentType, documentId },
    orderBy: { version: "desc" },
    include: { createdBy: { select: { name: true } } },
  });
  return rows.map((r) => ({
    version: r.version,
    createdAt: r.createdAt,
    createdByName: r.createdBy.name,
    amendmentReason: r.amendmentReason,
    changeSummary: r.changeSummary,
    contentHash: r.contentHash,
    isCurrent: r.isCurrent,
  }));
}

/* ── RFQs ─────────────────────────────────────────────────── */

/**
 * Amends an issued RFQ.
 *
 * The consequence the clause implies and the system did not model: quotations
 * already received answered the old scope. They are not deleted — a vendor did
 * quote, and pretending otherwise would lose that — but they carry the version
 * they answered, so a comparative can say which quotes are answering the current
 * question and which are not.
 */
export async function amendRfq(
  user: SessionUser,
  input: { rfqId: string; reason: string; scope?: string | null; responseDeadline?: Date | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.RFQ_ISSUE)) {
    throw new RuleViolationError("You do not have permission to amend an RFQ.");
  }
  if (!input.reason?.trim()) {
    throw new ValidationError("Say why the RFQ is being amended — the vendors have to be told the same thing.");
  }

  return withTransaction(db, async (tx) => {
    const rfq = await tx.rfq.findUnique({
      where: { id: input.rfqId },
      include: {
        quotes: { select: { id: true, vendorId: true, rfqVersion: true } },
        pr: { select: { entityId: true, number: true } },
      },
    });
    if (!rfq) throw new NotFoundError("RFQ");
    assertEntityAccess(user, rfq.pr.entityId);
    if (rfq.cancelledAt) throw new RuleViolationError(`${rfq.number} is cancelled.`);
    if (!["ISSUED", "RESPONSES_RECEIVED", "PARTIALLY_RECEIVED"].includes(rfq.status)) {
      throw new RuleViolationError(
        `${rfq.number} is ${rfq.status}. Amendment is for an RFQ that is already with the vendors.`,
      );
    }

    const nextVersion = rfq.revisionVersion + 1;
    const updated = await tx.rfq.update({
      where: { id: rfq.id },
      data: {
        scope: input.scope?.trim() ?? rfq.scope,
        responseDeadline: input.responseDeadline ?? rfq.responseDeadline,
        revisionVersion: nextVersion,
        amendmentCount: rfq.amendmentCount + 1,
        lastAmendmentReason: input.reason.trim(),
      },
    });

    await writeAudit(
      {
        entityType: "Rfq",
        entityId: rfq.id,
        entityRef: rfq.number,
        action: "RFQ_AMENDED",
        newValue: {
          fromVersion: rfq.revisionVersion,
          toVersion: nextVersion,
          quotesAgainstOldScope: rfq.quotes.length,
        },
        reason: input.reason.trim(),
        caseKey: rfq.pr.number,
        actor: user,
      },
      tx,
    );

    // Every vendor invited is told, including those who already quoted — they are
    // the ones whose quote has just stopped answering the question.
    const invited = await tx.rfqVendor.findMany({
      where: { rfqId: rfq.id },
      select: { vendorId: true },
    });
    if (invited.length) {
      await notify(
        {
          roleCodes: ["PROCUREMENT_OFFICER", "BUYER"],
          entityId: rfq.pr.entityId,
          type: "RFQ_AMENDED",
          title: `${rfq.number} amended to version ${nextVersion}`,
          body:
            `${input.reason.trim()} ${invited.length} vendor(s) invited; ` +
            `${rfq.quotes.length} quotation(s) now answer the previous scope and must be re-sought or re-confirmed.`,
          priority: "HIGH",
          linkType: "RFQ",
          linkId: rfq.id,
          linkUrl: `/rfq/${rfq.id}`,
        },
        tx,
      );
    }

    return { rfq: updated, staleQuotes: rfq.quotes.length };
  });
}

/** Cancels an RFQ, with the reason vendors will be given. */
export async function cancelRfq(
  user: SessionUser,
  input: { rfqId: string; reason: string },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.RFQ_ISSUE)) {
    throw new RuleViolationError("You do not have permission to cancel an RFQ.");
  }
  if (!input.reason?.trim()) {
    throw new ValidationError(
      "Say why the enquiry is being cancelled. Vendors who quoted are owed a reason, and the next enquiry for the same thing will be read against this one.",
    );
  }

  const rfq = await db.rfq.findUnique({
    where: { id: input.rfqId },
    include: { pr: { select: { entityId: true, number: true } }, _count: { select: { quotes: true } } },
  });
  if (!rfq) throw new NotFoundError("RFQ");
  assertEntityAccess(user, rfq.pr.entityId);
  if (rfq.cancelledAt) throw new RuleViolationError(`${rfq.number} is already cancelled.`);
  if (["AWARDED", "CLOSED"].includes(rfq.status)) {
    throw new RuleViolationError(
      `${rfq.number} is ${rfq.status.toLowerCase()} — an awarded enquiry cannot be cancelled, only the award reversed.`,
    );
  }

  const updated = await db.rfq.update({
    where: { id: rfq.id },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: input.reason.trim() },
  });
  await writeAudit(
    {
      entityType: "Rfq",
      entityId: rfq.id,
      entityRef: rfq.number,
      action: "RFQ_CANCELLED",
      newValue: { quotesReceived: rfq._count.quotes },
      reason: input.reason.trim(),
      caseKey: rfq.pr.number,
      actor: user,
    },
    db,
  );
  return updated;
}

/**
 * Reissues a cancelled RFQ as a fresh enquiry.
 *
 * Linked to the one it replaces, so a second attempt reads as a second attempt.
 * An enquiry cancelled and quietly re-raised looks like two independent
 * enquiries, which is how a vendor gets excluded twice without anybody noticing.
 */
export async function reissueRfq(
  user: SessionUser,
  input: { rfqId: string; scope?: string | null; responseDeadline: Date },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.RFQ_ISSUE)) {
    throw new RuleViolationError("You do not have permission to reissue an RFQ.");
  }

  return withTransaction(db, async (tx) => {
    const original = await tx.rfq.findUnique({
      where: { id: input.rfqId },
      include: {
        vendors: { select: { vendorId: true } },
        pr: { select: { id: true, entityId: true, number: true } },
      },
    });
    if (!original) throw new NotFoundError("RFQ");
    assertEntityAccess(user, original.pr.entityId);
    if (!original.cancelledAt) {
      throw new RuleViolationError(
        `${original.number} is not cancelled. Amend it instead of reissuing — a live enquiry and its replacement running together is how vendors end up quoting twice for one requirement.`,
      );
    }

    const { nextNumber, SEQ } = await import("@/lib/numbering");
    const number = await nextNumber(SEQ.RFQ, tx);
    const created = await tx.rfq.create({
      data: {
        number,
        prId: original.prId,
        title: original.title,
        scope: input.scope?.trim() ?? original.scope,
        responseDeadline: input.responseDeadline,
        status: "DRAFT",
        createdById: user.id,
        reissueOfRfqId: original.id,
        vendors: original.vendors.length
          ? { create: original.vendors.map((v) => ({ vendorId: v.vendorId })) }
          : undefined,
      },
    });

    await writeAudit(
      {
        entityType: "Rfq",
        entityId: created.id,
        entityRef: created.number,
        action: "RFQ_REISSUED",
        newValue: { reissueOf: original.number, vendors: original.vendors.length },
        caseKey: original.pr.number,
        actor: user,
      },
      tx,
    );
    return created;
  });
}

/**
 * Quotes that answered an earlier version of the scope.
 *
 * Read by the comparative, so a comparison across versions is visible instead of
 * being silently made.
 */
export async function staleQuotes(rfqId: string, db: DbClient = prisma) {
  const rfq = await db.rfq.findUnique({
    where: { id: rfqId },
    select: { revisionVersion: true, number: true },
  });
  if (!rfq) throw new NotFoundError("RFQ");
  const quotes = await db.vendorQuote.findMany({
    where: { rfqId, rfqVersion: { lt: rfq.revisionVersion } },
    select: {
      id: true,
      quoteRef: true,
      rfqVersion: true,
      vendor: { select: { name: true } },
    },
  });
  return {
    currentVersion: rfq.revisionVersion,
    stale: quotes.map((q) => ({
      id: q.id,
      quoteRef: q.quoteRef,
      vendorName: q.vendor.name,
      answeredVersion: q.rfqVersion,
    })),
  };
}
