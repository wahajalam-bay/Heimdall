import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";

/**
 * The payment document pack.
 *
 * ZAM/PUR/SOP-01 §3.4 requires procurement to "ensure availability of supporting
 * documents before submitting to finance **as per Annexure A**", and Annexure A
 * lists seven: the requisition, the order, the receipt and the invoice always;
 * the undertaking, the goods declaration and the tax exemption certificate when
 * they apply.
 *
 * The system could not express that. `DocumentType.required` is one global
 * boolean, so the choice was between demanding a goods declaration on every
 * payment or never demanding one — and it chose never. All thirty document types
 * are optional, which is why the checklist has never blocked anything.
 *
 * A pack item therefore records four separate facts, because collapsing them
 * loses the distinction that matters:
 *
 *   · **Required?** what policy says for this kind of transaction
 *   · **Applicable?** whether a conditional requirement bites on this one
 *   · **Present?** whether the document is attached
 *   · **Verified?** whether somebody has looked at it
 *
 * A conditional document that does not apply is satisfied. One that applies and
 * is missing is a blocker. One attached but unverified is not yet evidence. And
 * a payment that proceeds without a mandatory document carries a named exception
 * with a reason, or the control is decorative.
 */

export type PackItemState = {
  documentTypeCode: string;
  documentTypeName: string;
  requirementKind: "ALWAYS" | "CONDITIONAL" | "OPTIONAL";
  condition: string | null;
  applicable: boolean;
  applicableNote: string | null;
  present: boolean;
  attachedDocumentId: string | null;
  verified: boolean;
  verifiedByName: string | null;
  verifiedAt: Date | null;
  exceptionReason: string | null;
  exceptionApprovedByName: string | null;
  /** True when this item is what stands between the pack and payment. */
  blocking: boolean;
};

export type PackState = {
  items: PackItemState[];
  complete: boolean;
  blockers: string[];
  /** Mandatory documents released by a named exception rather than supplied. */
  waived: string[];
};

/**
 * The pack for one invoice or petty cash request, as it stands.
 *
 * Requirements come from policy; presence comes from what is attached; the
 * conditional answers and the verifications come from the pack items somebody
 * has already filled in. Nothing is inferred that a person should have stated.
 */
export async function paymentPack(
  documentType: "INVOICE" | "PETTY_CASH",
  documentId: string,
  opts: { entityId?: string | null; transactionType?: string } = {},
  db: DbClient = prisma,
): Promise<PackState> {
  const transactionType = opts.transactionType ?? "ALL";

  const requirements = await db.paymentPackRequirement.findMany({
    where: {
      active: true,
      transactionType: { in: [transactionType, "ALL"] },
      ...(opts.entityId ? { OR: [{ entityId: opts.entityId }, { entityId: null }] } : {}),
    },
    include: { documentType: { select: { id: true, code: true, name: true } } },
    orderBy: [{ sequence: "asc" }],
  });

  // An entity's own requirement supersedes the group one for the same document.
  const chosen = new Map<string, (typeof requirements)[number]>();
  for (const r of requirements) {
    const held = chosen.get(r.documentType.code);
    if (!held || (r.entityId && !held.entityId)) chosen.set(r.documentType.code, r);
  }

  const [items, attached] = await Promise.all([
    db.paymentPackItem.findMany({
      where: { documentType, documentId },
      include: {
        verifiedBy: { select: { name: true } },
        exceptionApprovedBy: { select: { name: true } },
      },
    }),
    db.document.findMany({
      where: { linkedType: documentType, linkedId: documentId, archived: false, isCurrent: true },
      select: { id: true, documentType: { select: { code: true } } },
    }),
  ]);

  const itemByCode = new Map(items.map((i) => [i.documentTypeCode, i]));
  const attachedByCode = new Map(
    attached.filter((a) => a.documentType?.code).map((a) => [a.documentType!.code, a.id]),
  );

  const state: PackItemState[] = [...chosen.values()].map((r) => {
    const saved = itemByCode.get(r.documentType.code);
    const kind = r.requirement as PackItemState["requirementKind"];
    // A conditional requirement is applicable until somebody says otherwise; an
    // unanswered condition should not quietly excuse the document.
    const applicable = saved ? saved.applicable : kind !== "OPTIONAL";
    const attachedId = saved?.attachedDocumentId ?? attachedByCode.get(r.documentType.code) ?? null;
    const present = Boolean(attachedId);
    const verified = Boolean(saved?.verifiedAt);
    const waived = Boolean(saved?.exceptionReason && saved?.exceptionApprovedById);

    return {
      documentTypeCode: r.documentType.code,
      documentTypeName: r.documentType.name,
      requirementKind: kind,
      condition: r.condition,
      applicable,
      applicableNote: saved?.applicableNote ?? null,
      present,
      attachedDocumentId: attachedId,
      verified,
      verifiedByName: saved?.verifiedBy?.name ?? null,
      verifiedAt: saved?.verifiedAt ?? null,
      exceptionReason: saved?.exceptionReason ?? null,
      exceptionApprovedByName: saved?.exceptionApprovedBy?.name ?? null,
      blocking: kind !== "OPTIONAL" && applicable && !present && !waived,
    };
  });

  return {
    items: state,
    complete: state.every((i) => !i.blocking),
    blockers: state.filter((i) => i.blocking).map((i) => i.documentTypeName),
    waived: state
      .filter((i) => i.exceptionReason && i.exceptionApprovedByName)
      .map((i) => i.documentTypeName),
  };
}

/**
 * Refuses when the pack is short.
 *
 * Called at the finance handoff and again at payment, because a document can be
 * detached between the two and the second check costs one query.
 */
export async function assertPackComplete(
  documentType: "INVOICE" | "PETTY_CASH",
  documentId: string,
  ref: string,
  opts: { entityId?: string | null; transactionType?: string } = {},
  db: DbClient = prisma,
): Promise<void> {
  const pack = await paymentPack(documentType, documentId, opts, db);
  if (pack.complete) return;
  throw new RuleViolationError(
    `${ref} cannot go to finance: ${pack.blockers.join(", ")} ${pack.blockers.length === 1 ? "is" : "are"} required and not attached. ` +
      "Attach the missing documents, mark a conditional one as not applicable with a note, or record an authorised exception.",
  );
}

/** Says whether a conditional requirement bites on this transaction. */
export async function setApplicability(
  user: SessionUser,
  input: {
    documentType: "INVOICE" | "PETTY_CASH";
    documentId: string;
    documentTypeCode: string;
    applicable: boolean;
    note?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.INVOICE_VERIFY, P.PETTY_CASH_APPROVE, P.DOCUMENT_UPLOAD)) {
    throw new RuleViolationError("You do not have permission to assemble a payment pack.");
  }
  // Excusing a document needs a reason. Requiring one does not.
  if (!input.applicable && !input.note?.trim()) {
    throw new ValidationError(
      "Say why this document does not apply. A requirement marked not-applicable with no note cannot be reviewed.",
    );
  }

  const req = await db.paymentPackRequirement.findFirst({
    where: { documentType: { code: input.documentTypeCode }, active: true },
    include: { documentType: { select: { code: true, name: true } } },
  });
  if (!req) throw new NotFoundError("Payment pack requirement");

  const row = await db.paymentPackItem.upsert({
    where: {
      documentType_documentId_documentTypeCode: {
        documentType: input.documentType,
        documentId: input.documentId,
        documentTypeCode: input.documentTypeCode,
      },
    },
    create: {
      documentType: input.documentType,
      documentId: input.documentId,
      requirementId: req.id,
      documentTypeCode: req.documentType.code,
      documentTypeName: req.documentType.name,
      requirementKind: req.requirement,
      applicable: input.applicable,
      applicableNote: input.note ?? null,
    },
    update: { applicable: input.applicable, applicableNote: input.note ?? null },
  });

  await writeAudit(
    {
      entityType: input.documentType,
      entityId: input.documentId,
      action: input.applicable ? "PACK_ITEM_APPLICABLE" : "PACK_ITEM_NOT_APPLICABLE",
      newValue: { document: req.documentType.name },
      reason: input.note ?? null,
      actor: user,
    },
    db,
  );
  return row;
}

/** Records that somebody looked at the attached document, not merely that it exists. */
export async function verifyPackItem(
  user: SessionUser,
  input: {
    documentType: "INVOICE" | "PETTY_CASH";
    documentId: string;
    documentTypeCode: string;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.INVOICE_VERIFY, P.PETTY_CASH_APPROVE)) {
    throw new RuleViolationError("You do not have permission to verify payment documents.");
  }
  return withTransaction(db, async (tx) => {
    const item = await tx.paymentPackItem.findUnique({
      where: {
        documentType_documentId_documentTypeCode: {
          documentType: input.documentType,
          documentId: input.documentId,
          documentTypeCode: input.documentTypeCode,
        },
      },
    });
    if (!item) throw new NotFoundError("Payment pack item");
    if (!item.attachedDocumentId) {
      throw new RuleViolationError(
        `${item.documentTypeName} is not attached yet, so there is nothing to verify.`,
      );
    }

    const row = await tx.paymentPackItem.update({
      where: { id: item.id },
      data: { verifiedById: user.id, verifiedAt: new Date() },
    });
    await writeAudit(
      {
        entityType: input.documentType,
        entityId: input.documentId,
        action: "PACK_ITEM_VERIFIED",
        newValue: { document: item.documentTypeName },
        actor: user,
      },
      tx,
    );
    return row;
  });
}

/**
 * Releases a mandatory document that is genuinely unavailable.
 *
 * Both a reason and an approver are required. A waiver with neither is
 * indistinguishable from an oversight, which is precisely what a document
 * checklist exists to prevent.
 */
export async function waivePackItem(
  user: SessionUser,
  input: {
    documentType: "INVOICE" | "PETTY_CASH";
    documentId: string;
    documentTypeCode: string;
    reason: string;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.INVOICE_EXCEPTION_APPROVE)) {
    throw new RuleViolationError(
      "Releasing a payment without a required document needs exception-approval authority.",
    );
  }
  if (!input.reason?.trim()) {
    throw new ValidationError("State why the payment may proceed without this document.");
  }

  return withTransaction(db, async (tx) => {
    const req = await tx.paymentPackRequirement.findFirst({
      where: { documentType: { code: input.documentTypeCode }, active: true },
      include: { documentType: { select: { code: true, name: true } } },
    });
    if (!req) throw new NotFoundError("Payment pack requirement");

    const row = await tx.paymentPackItem.upsert({
      where: {
        documentType_documentId_documentTypeCode: {
          documentType: input.documentType,
          documentId: input.documentId,
          documentTypeCode: input.documentTypeCode,
        },
      },
      create: {
        documentType: input.documentType,
        documentId: input.documentId,
        requirementId: req.id,
        documentTypeCode: req.documentType.code,
        documentTypeName: req.documentType.name,
        requirementKind: req.requirement,
        exceptionReason: input.reason.trim(),
        exceptionApprovedById: user.id,
        exceptionApprovedAt: new Date(),
      },
      update: {
        exceptionReason: input.reason.trim(),
        exceptionApprovedById: user.id,
        exceptionApprovedAt: new Date(),
      },
    });

    await writeAudit(
      {
        entityType: input.documentType,
        entityId: input.documentId,
        action: "PACK_ITEM_WAIVED",
        newValue: { document: req.documentType.name, approvedBy: user.name },
        reason: input.reason.trim(),
        actor: user,
      },
      tx,
    );
    return row;
  });
}
