import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { cpcDecisionTrail } from "@/server/cpc-quorum";

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

/**
 * A document the system itself holds, rather than a file somebody uploaded.
 *
 * Annexure A's first three entries are the requisition, the order and the goods
 * receipt — all three of which this system generates. Demanding a scan of a
 * document the system produced would be theatre: the requirement is that the
 * paper is *available* with the payment, and a record that prints on demand is
 * more available than a PDF in a folder.
 *
 * So a record satisfies its requirement, and says which record and where the
 * form is, so whoever checks the pack can open it rather than take it on trust.
 */
export type PackRecord = {
  /** The document type code this record answers for. */
  code: string;
  /** What it is, in the words the form uses. */
  label: string;
  /** Its own number, so the pack names the document rather than gesturing at it. */
  ref: string;
  /** The printable form. */
  href: string;
};

export type PackItemState = {
  documentTypeCode: string;
  documentTypeName: string;
  requirementKind: "ALWAYS" | "CONDITIONAL" | "OPTIONAL";
  condition: string | null;
  applicable: boolean;
  applicableNote: string | null;
  present: boolean;
  attachedDocumentId: string | null;
  /**
   * How the requirement is met. `RECORD` is a document the system generates and
   * can print; `ATTACHMENT` is a file somebody supplied. Kept apart because the
   * two are different kinds of evidence and a checker should be able to see
   * which one they are looking at.
   */
  satisfiedBy: "RECORD" | "ATTACHMENT" | null;
  /** The system records answering this requirement, in document order. */
  records: PackRecord[];
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
  /**
   * Requirements met by a system record that nobody has yet looked at. Not a
   * blocker — the document exists — but the distinction between "we have it"
   * and "somebody checked it" is the whole point of the pack.
   */
  unverified: string[];
};

/**
 * The company and transaction kind a pack belongs to, resolved from the document.
 *
 * Requirements are seeded per entity and per transaction type, so a pack read
 * without that context finds nothing and reports every document as unknown. The
 * caller usually has both to hand — and a caller that forgets produces a pack
 * that is silently empty, which reads as "nothing is required" rather than as a
 * mistake. So the context is derivable from the document itself, and the
 * functions that mutate a pack derive it rather than trusting an argument.
 */
export async function packContextFor(
  documentType: "INVOICE" | "PETTY_CASH",
  documentId: string,
  db: DbClient = prisma,
): Promise<{ entityId: string | null; transactionType: string }> {
  if (documentType === "PETTY_CASH") {
    const pc = await db.pettyCashRequest.findUnique({
      where: { id: documentId },
      select: { entityId: true },
    });
    // Petty cash buys goods against a receipt; there is no service variant of
    // the route in the SOP.
    return { entityId: pc?.entityId ?? null, transactionType: "GOODS" };
  }
  const invoice = await db.invoice.findUnique({
    where: { id: documentId },
    select: { po: { select: { entityId: true, procurementKind: true } } },
  });
  return {
    entityId: invoice?.po?.entityId ?? null,
    transactionType: invoice?.po?.procurementKind ?? "GOODS",
  };
}

/**
 * The documents in the chain behind an invoice, mapped to what they answer for.
 *
 * Walks outwards from the invoice: its order, the requisition that order came
 * from, and the goods receipts the invoice was matched against. Every one of
 * these is a record the system already holds, so the pack can populate itself
 * instead of asking somebody to upload four documents it generated.
 *
 * A petty cash request has no order and no receipt — it *is* the requisition,
 * and the SOP routes it to Accounts on its own form. So it answers for the
 * requisition entry and nothing else, and the pack for petty cash carries only
 * the requirements a petty cash transaction can actually meet.
 *
 * The mapping is deliberately by document-type code rather than by name: the
 * codes come from the seeded Annexure A set, so a re-seed or a rename cannot
 * quietly break the population.
 */
export async function packRecords(
  documentType: "INVOICE" | "PETTY_CASH",
  documentId: string,
  db: DbClient = prisma,
): Promise<PackRecord[]> {
  if (documentType === "PETTY_CASH") {
    const pc = await db.pettyCashRequest.findUnique({
      where: { id: documentId },
      select: { id: true, number: true },
    });
    if (!pc) return [];
    return [
      {
        code: "PR-FORM",
        label: "Petty cash request",
        ref: pc.number,
        href: `/petty-cash/${pc.id}/annexure-2`,
      },
    ];
  }

  const invoice = await db.invoice.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      number: true,
      po: {
        select: {
          id: true,
          number: true,
          pr: { select: { id: true, number: true } },
        },
      },
      grnLinks: {
        select: { grn: { select: { id: true, number: true } } },
      },
    },
  });
  if (!invoice) return [];

  // CP-016 makes the committee's circulated decision "attached with the standard
  // documentation trail required to initiate any payment request through
  // Finance". So where the purchase went to committee, that circulation is a
  // payment prerequisite in the same way the order is — and one that is
  // satisfied by a record, not by a re-uploaded file.
  const cpcTrail = invoice.po?.pr
    ? await cpcDecisionTrail(invoice.po.pr.id, db)
    : { required: false, circulated: false, ref: null, caseNumber: null, caseId: null };

  const out: PackRecord[] = [];

  if (invoice.po?.pr) {
    out.push({
      code: "PR-FORM",
      label: "Purchase requisition",
      ref: invoice.po.pr.number,
      href: `/pr/${invoice.po.pr.id}/annexure-1`,
    });
  }
  if (invoice.po) {
    out.push({
      code: "PO-DOC",
      label: "Purchase order",
      ref: invoice.po.number,
      href: `/po/${invoice.po.id}/document`,
    });
  }
  // Several receipts can sit behind one invoice — a part delivery followed by the
  // rest. All of them are listed, because the requirement is the receipt for what
  // is being paid for and one of two is not that.
  for (const link of invoice.grnLinks) {
    out.push({
      code: "GRN-DOC",
      label: "Goods receipt note",
      ref: link.grn.number,
      href: `/grn/${link.grn.id}/document`,
    });
  }
  out.push({
    code: "INVOICE-DOC",
    label: "Vendor invoice",
    ref: invoice.number,
    href: `/invoices/${invoice.id}`,
  });

  // Only when it has actually been circulated. A committee decision that exists
  // and was never shared is precisely what CP-016 is written against, so it must
  // not satisfy the requirement by existing.
  if (cpcTrail.required && cpcTrail.circulated && cpcTrail.caseId) {
    out.push({
      code: "CPC-DECISION",
      label: "CPC decision circular",
      ref: cpcTrail.ref ?? cpcTrail.caseNumber ?? "circulated",
      href: `/cpc/cases/${cpcTrail.caseId}`,
    });
  }

  return out;
}

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

  const [items, attached, records] = await Promise.all([
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
    packRecords(documentType, documentId, db),
  ]);

  const itemByCode = new Map(items.map((i) => [i.documentTypeCode, i]));
  const attachedByCode = new Map(
    attached.filter((a) => a.documentType?.code).map((a) => [a.documentType!.code, a.id]),
  );
  const recordsByCode = new Map<string, PackRecord[]>();
  for (const r of records) {
    const held = recordsByCode.get(r.code);
    if (held) held.push(r);
    else recordsByCode.set(r.code, [r]);
  }

  const state: PackItemState[] = [...chosen.values()].map((r) => {
    const saved = itemByCode.get(r.documentType.code);
    const kind = r.requirement as PackItemState["requirementKind"];
    // A conditional requirement is applicable until somebody says otherwise; an
    // unanswered condition should not quietly excuse the document.
    const applicable = saved ? saved.applicable : kind !== "OPTIONAL";
    const attachedId = saved?.attachedDocumentId ?? attachedByCode.get(r.documentType.code) ?? null;
    const own = recordsByCode.get(r.documentType.code) ?? [];
    // An attachment is the stronger evidence where both exist — somebody chose to
    // put that file here, and it may be the signed and stamped copy rather than
    // the system's rendering of the same document.
    const satisfiedBy: PackItemState["satisfiedBy"] = attachedId
      ? "ATTACHMENT"
      : own.length
        ? "RECORD"
        : null;
    const present = satisfiedBy !== null;
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
      satisfiedBy,
      records: own,
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
    unverified: state
      .filter((i) => i.applicable && i.present && !i.verified)
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
    // Read the pack rather than the stored row. A requirement met by a system
    // record — the requisition, the order, the receipt — has no stored row until
    // somebody acts on it, and it is exactly those three that most need
    // verifying. Demanding a row first meant the four documents Annexure A
    // always requires were the four that could never be marked checked.
    const context = await packContextFor(input.documentType, input.documentId, tx);
    const pack = await paymentPack(input.documentType, input.documentId, context, tx);
    const state = pack.items.find((i) => i.documentTypeCode === input.documentTypeCode);
    if (!state) throw new NotFoundError("Payment pack item");
    if (!state.present) {
      throw new RuleViolationError(
        `${state.documentTypeName} is not held yet, so there is nothing to verify.`,
      );
    }

    const req = await tx.paymentPackRequirement.findFirst({
      where: { documentType: { code: input.documentTypeCode }, active: true },
      select: { id: true },
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
        documentTypeCode: state.documentTypeCode,
        documentTypeName: state.documentTypeName,
        applicable: state.applicable,
        attachedDocumentId: state.attachedDocumentId,
        verifiedById: user.id,
        verifiedAt: new Date(),
      },
      update: { verifiedById: user.id, verifiedAt: new Date() },
    });
    await writeAudit(
      {
        entityType: input.documentType,
        entityId: input.documentId,
        action: "PACK_ITEM_VERIFIED",
        newValue: {
          document: state.documentTypeName,
          // Which kind of evidence was checked, because "verified" against a
          // system record and against an uploaded scan are not the same claim.
          satisfiedBy: state.satisfiedBy,
          records: state.records.map((r) => r.ref),
        },
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
