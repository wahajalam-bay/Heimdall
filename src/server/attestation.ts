import { createHash } from "node:crypto";
import { prisma, type DbClient } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";

/**
 * Attestations — one signature block, used by every form that has one.
 *
 * The paper forms all end the same way: a name, a designation, a signature, a
 * stamp, a date and a time. Annexure 1 is explicit that the last three are not
 * optional — "Stamps, Date, Time are compulsory to ensure compliance". The
 * requisition, the cost analysis, the goods inspection note, the order, the
 * committee minute, the payment voucher and the disposal file each want that
 * block, and adding six sets of signature columns to six tables is how a schema
 * stops being reviewable.
 *
 * Two details make an attestation worth more than a timestamp:
 *
 *   · **The office, captured not joined.** A signature means something because
 *     of the role the signer held when they gave it. Roles change; the record
 *     must not. So the designation is copied in at signing.
 *   · **What was signed.** An approval that points only at a document points at
 *     whatever that document later became. The version and, where available, a
 *     hash are stored, so a change after approval is detectable rather than
 *     merely unlikely.
 */

export const ATTESTATION_TYPES = [
  "PREPARED",
  "VERIFIED",
  "REVIEWED",
  "APPROVED",
  "REJECTED",
  "WITNESSED",
  "ACKNOWLEDGED",
] as const;

export type AttestationType = (typeof ATTESTATION_TYPES)[number];

export const ATTESTATION_TYPE_LABELS: Record<AttestationType, string> = {
  PREPARED: "Prepared by",
  VERIFIED: "Verified by",
  REVIEWED: "Reviewed by",
  APPROVED: "Approved by",
  REJECTED: "Rejected by",
  WITNESSED: "Witnessed by",
  ACKNOWLEDGED: "Acknowledged by",
};

export type AttestInput = {
  documentType: string;
  documentId: string;
  documentRef?: string | null;
  documentVersion?: number;
  attestationType: AttestationType;
  decision?: "APPROVED" | "REJECTED" | "NOTED" | null;
  /** Somebody signed for somebody else, under a recorded delegation. */
  onBehalfOfId?: string | null;
  delegationRef?: string | null;
  /** What the physical stamp bore, for a form signed on paper and scanned back. */
  stampRef?: string | null;
  comment?: string | null;
  /** Content to hash, so a later change to the signed document is detectable. */
  signedContent?: unknown;
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * Records a signature.
 *
 * Authorization is the caller's: an attestation is the *record* of a decision
 * somebody was entitled to make, and the entitlement was checked when they made
 * it. Signing without that check would let this function launder an unauthorized
 * approval into evidence, so it is only ever called after one.
 */
export async function attest(user: SessionUser, input: AttestInput, db: DbClient = prisma) {
  if (!input.documentType || !input.documentId) {
    throw new ValidationError("An attestation must name the document it signs.");
  }

  const documentHash = input.signedContent
    ? createHash("sha256").update(JSON.stringify(input.signedContent)).digest("hex").slice(0, 32)
    : null;

  const row = await db.attestation.create({
    data: {
      documentType: input.documentType,
      documentId: input.documentId,
      documentRef: input.documentRef ?? null,
      documentVersion: input.documentVersion ?? 1,
      attestationType: input.attestationType,
      decision: input.decision ?? null,
      signedById: user.id,
      // The office at the moment of signing, not whatever it becomes later.
      roleAtSigning: user.roleNames.join(", ") || null,
      designation: user.title ?? null,
      onBehalfOfId: input.onBehalfOfId ?? null,
      delegationRef: input.delegationRef ?? null,
      stampRef: input.stampRef ?? null,
      comment: input.comment ?? null,
      documentHash,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });

  await writeAudit(
    {
      entityType: input.documentType,
      entityId: input.documentId,
      entityRef: input.documentRef ?? null,
      action: `ATTESTED_${input.attestationType}`,
      newValue: {
        by: user.name,
        designation: user.title,
        roleAtSigning: row.roleAtSigning,
        onBehalfOf: input.onBehalfOfId ?? null,
        stamp: input.stampRef ?? null,
        version: row.documentVersion,
        hash: documentHash,
      },
      reason: input.comment ?? null,
      actor: user,
    },
    db,
  );

  return row;
}

/** Every signature on a document, oldest first — the order they were given in. */
export async function attestations(
  documentType: string,
  documentId: string,
  db: DbClient = prisma,
) {
  return db.attestation.findMany({
    where: { documentType, documentId },
    orderBy: { signedAt: "asc" },
    include: {
      signedBy: { select: { id: true, name: true, title: true } },
      onBehalfOf: { select: { name: true } },
    },
  });
}

/** Whether a particular signature is present. */
export async function hasAttestation(
  documentType: string,
  documentId: string,
  attestationType: AttestationType,
  db: DbClient = prisma,
): Promise<boolean> {
  const found = await db.attestation.findFirst({
    where: { documentType, documentId, attestationType },
    select: { id: true },
  });
  return Boolean(found);
}

/**
 * Refuses when a required signature is missing.
 *
 * Used at a gate — a payment that needs an approval, a form that needs a
 * verification — so the missing signature is named rather than the failure being
 * generic.
 */
export async function assertAttested(
  documentType: string,
  documentId: string,
  required: AttestationType[],
  what: string,
  db: DbClient = prisma,
): Promise<void> {
  const held = await db.attestation.findMany({
    where: { documentType, documentId, attestationType: { in: required } },
    select: { attestationType: true },
  });
  const have = new Set(held.map((h) => h.attestationType));
  const missing = required.filter((r) => !have.has(r));
  if (!missing.length) return;

  throw new ValidationError(
    `${what} is missing ${missing.map((m) => ATTESTATION_TYPE_LABELS[m].toLowerCase()).join(" and ")}.`,
  );
}

/**
 * Detects a document that changed after it was signed.
 *
 * Returns the attestations whose recorded hash no longer matches the content.
 * An empty array means either that nothing changed or that nothing was hashed —
 * `hashed` distinguishes the two, because "no evidence of tampering" and "no
 * evidence at all" are not the same answer.
 */
export async function verifySignedContent(
  documentType: string,
  documentId: string,
  currentContent: unknown,
  db: DbClient = prisma,
): Promise<{ hashed: number; mismatched: Array<{ id: string; signedAt: Date; by: string }> }> {
  const rows = await db.attestation.findMany({
    where: { documentType, documentId, documentHash: { not: null } },
    include: { signedBy: { select: { name: true } } },
  });
  const current = createHash("sha256")
    .update(JSON.stringify(currentContent))
    .digest("hex")
    .slice(0, 32);
  return {
    hashed: rows.length,
    mismatched: rows
      .filter((r) => r.documentHash !== current)
      .map((r) => ({ id: r.id, signedAt: r.signedAt, by: r.signedBy.name })),
  };
}

/** Loads a document's attestation block for printing on a form. */
export async function attestationBlock(
  documentType: string,
  documentId: string,
  order: AttestationType[],
  db: DbClient = prisma,
) {
  const rows = await attestations(documentType, documentId, db);
  if (!rows.length && !order.length) throw new NotFoundError("Attestation");
  return order.map((type) => {
    const row = rows.find((r) => r.attestationType === type) ?? null;
    return {
      type,
      label: ATTESTATION_TYPE_LABELS[type],
      signed: Boolean(row),
      name: row?.signedBy.name ?? null,
      designation: row?.designation ?? row?.signedBy.title ?? null,
      roleAtSigning: row?.roleAtSigning ?? null,
      signedAt: row?.signedAt ?? null,
      stampRef: row?.stampRef ?? null,
      onBehalfOf: row?.onBehalfOf?.name ?? null,
      comment: row?.comment ?? null,
    };
  });
}
