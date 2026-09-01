import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { attest, attestations } from "./attestation";

/**
 * Negotiation Minutes.
 *
 * ZAM/PUR/SOP-01 §4.5.1:
 *
 * > A price negotiating call or meeting will be conducted by procurement
 * > department with the vendors. Negotiation will be based on; financial
 * > evaluation/competitive price, payment terms, product/ service quality, on
 * > time delivery, after sales services, warranties etc. **Preparation of
 * > Comparative Statement, Negotiation Minutes, approval documents and
 * > conclusion is to be documented.**
 *
 * The system recorded negotiation *rounds*: a number moving from one figure to
 * another, with a channel and a free-text note. That is the outcome of a
 * negotiation, not the minutes of one. A price that fell eight per cent with no
 * record of who was in the room or what was conceded to get there is a number
 * nobody can defend.
 *
 * So the minutes are their own document: who attended and on which side, what
 * was discussed against each of the six bases the SOP names, and what was
 * concluded. Finalising them requires a conclusion, because §4.5.1 requires the
 * conclusion to be documented and minutes without one document a conversation
 * rather than a decision.
 *
 * The six bases are shipped as named rows because the SOP names them. It then
 * says "etc.", so the list is open rather than closed — `OTHER` exists for that
 * and must carry a label, so an unnamed basis cannot hide among the named ones.
 */

export const NEGOTIATION_BASES = [
  "PRICE",
  "PAYMENT_TERMS",
  "QUALITY",
  "DELIVERY",
  "AFTER_SALES",
  "WARRANTY",
  "OTHER",
] as const;
export type NegotiationBasis = (typeof NEGOTIATION_BASES)[number];

/** The SOP's own wording, so the form reads as the policy does. */
export const NEGOTIATION_BASIS_LABELS: Record<NegotiationBasis, string> = {
  PRICE: "Financial evaluation / competitive price",
  PAYMENT_TERMS: "Payment terms",
  QUALITY: "Product / service quality",
  DELIVERY: "On-time delivery",
  AFTER_SALES: "After-sales services",
  WARRANTY: "Warranties",
  OTHER: "Other",
};

/** The six §4.5.1 names, in the order it names them. `OTHER` is not seeded. */
export const SOP_BASES: NegotiationBasis[] = [
  "PRICE",
  "PAYMENT_TERMS",
  "QUALITY",
  "DELIVERY",
  "AFTER_SALES",
  "WARRANTY",
];

export const NEGOTIATION_CHANNELS = ["CALL", "MEETING", "EMAIL", "PORTAL", "WHATSAPP"] as const;

export type ParticipantInput = {
  side: "COMPANY" | "VENDOR";
  userId?: string | null;
  vendorId?: string | null;
  name: string;
  designation?: string | null;
  attended?: boolean;
};

/**
 * Opens a set of minutes for a negotiation that has taken place.
 *
 * The six bases are written straight away, all marked undiscussed, so the form
 * shows what the SOP expects to be covered rather than an empty box. Somebody
 * then records what was said against each — and a basis that genuinely did not
 * come up is recorded as not discussed rather than left blank, because "we never
 * raised payment terms" is itself worth knowing.
 */
export async function createNegotiationMinute(
  user: SessionUser,
  input: {
    rfqId?: string | null;
    prId?: string | null;
    entityId?: string | null;
    channel?: string;
    heldAt: Date;
    location?: string | null;
    participants: ParticipantInput[];
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.NEGOTIATE)) {
      throw new RuleViolationError("You do not have permission to record negotiations.");
    }
    if (!input.rfqId && !input.prId) {
      throw new ValidationError("Minutes must belong to an RFQ or a requisition.");
    }
    if (!input.heldAt || Number.isNaN(input.heldAt.getTime())) {
      throw new ValidationError("State when the negotiation took place.");
    }
    if (input.heldAt.getTime() > Date.now() + 60_000) {
      throw new ValidationError(
        "These are minutes of a negotiation that has happened. A future date would make them a plan.",
      );
    }

    const company = input.participants.filter((p) => p.side === "COMPANY" && p.name?.trim());
    const vendor = input.participants.filter((p) => p.side === "VENDOR" && p.name?.trim());
    if (!company.length || !vendor.length) {
      throw new ValidationError(
        "§4.5.1 describes a negotiation between procurement and the vendors. Name at least one person on each side.",
      );
    }

    let rfq: { id: string; entityId: string | null; prId: string } | null = null;
    if (input.rfqId) {
      const found = await tx.rfq.findUnique({
        where: { id: input.rfqId },
        select: { id: true, prId: true, pr: { select: { entityId: true } } },
      });
      if (!found) throw new NotFoundError("RFQ");
      rfq = { id: found.id, prId: found.prId, entityId: found.pr?.entityId ?? null };
    }

    const minute = await tx.negotiationMinute.create({
      data: {
        number: await nextNumber(SEQ.NEGOTIATION_MINUTE, tx),
        rfqId: input.rfqId ?? null,
        prId: input.prId ?? rfq?.prId ?? null,
        entityId: input.entityId ?? rfq?.entityId ?? null,
        channel: NEGOTIATION_CHANNELS.includes((input.channel ?? "CALL") as never)
          ? (input.channel ?? "CALL")
          : "CALL",
        heldAt: input.heldAt,
        location: input.location?.trim() || null,
        status: "DRAFT",
        preparedById: user.id,
        participants: {
          create: [...company, ...vendor].map((p) => ({
            side: p.side,
            userId: p.userId ?? null,
            vendorId: p.vendorId ?? null,
            name: p.name.trim(),
            designation: p.designation?.trim() || null,
            attended: p.attended ?? true,
          })),
        },
        bases: {
          create: SOP_BASES.map((b, i) => ({
            basis: b,
            discussed: false,
            sequence: i + 1,
          })),
        },
      },
    });

    await writeAudit(
      {
        entityType: "NegotiationMinute",
        entityId: minute.id,
        entityRef: minute.number,
        action: "MINUTES_OPENED",
        newValue: {
          channel: minute.channel,
          heldAt: minute.heldAt,
          company: company.length,
          vendor: vendor.length,
        },
        actor: user,
      },
      tx,
    );
    return minute;
  });
}

/** Records what was said against one of the negotiation bases. */
export async function recordBasis(
  user: SessionUser,
  input: {
    minuteId: string;
    basis: NegotiationBasis;
    label?: string | null;
    discussed: boolean;
    notes?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.NEGOTIATE)) {
    throw new RuleViolationError("You do not have permission to record negotiations.");
  }
  if (!NEGOTIATION_BASES.includes(input.basis)) {
    throw new ValidationError("That is not one of the negotiation bases.");
  }
  if (input.basis === "OTHER" && !input.label?.trim()) {
    throw new ValidationError(
      "Name the other basis. §4.5.1 lists six and says 'etc.', so the list is open — but an unnamed basis is not a basis.",
    );
  }
  if (input.discussed && !input.notes?.trim()) {
    throw new ValidationError(
      "Say what was discussed. A basis ticked as covered with nothing written against it records that a box was ticked.",
    );
  }

  const minute = await db.negotiationMinute.findUnique({
    where: { id: input.minuteId },
    select: { id: true, number: true, status: true },
  });
  if (!minute) throw new NotFoundError("Negotiation minutes");
  if (minute.status !== "DRAFT") {
    throw new RuleViolationError(
      `${minute.number} is finalised. Minutes are a record of what happened, not a document that keeps changing.`,
    );
  }

  const label = input.basis === "OTHER" ? input.label!.trim() : null;
  const existing = await db.negotiationBasisNote.findFirst({
    where: { minuteId: minute.id, basis: input.basis, label },
  });

  return existing
    ? db.negotiationBasisNote.update({
        where: { id: existing.id },
        data: { discussed: input.discussed, notes: input.notes?.trim() || null },
      })
    : db.negotiationBasisNote.create({
        data: {
          minuteId: minute.id,
          basis: input.basis,
          label,
          discussed: input.discussed,
          notes: input.notes?.trim() || null,
          sequence: SOP_BASES.length + 1,
        },
      });
}

/**
 * Closes the minutes.
 *
 * §4.5.1 requires the conclusion to be documented, so a conclusion is required.
 * Every one of the SOP's six bases must also have been answered one way or the
 * other — covered with a note, or explicitly not discussed. A blank is neither,
 * and finalising over blanks would produce a document that looks complete while
 * saying nothing about half of what the SOP asks.
 *
 * Signed on finalising, so the minutes carry the name of whoever attests to
 * them and a hash of what they attested to.
 */
export async function finaliseNegotiationMinute(
  user: SessionUser,
  input: { minuteId: string; conclusion: string; recommendedVendorId?: string | null },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.NEGOTIATE)) {
      throw new RuleViolationError("You do not have permission to record negotiations.");
    }
    if (!input.conclusion?.trim()) {
      throw new ValidationError(
        "§4.5.1 requires the conclusion to be documented. Minutes without one record a conversation, not a decision.",
      );
    }

    const minute = await tx.negotiationMinute.findUnique({
      where: { id: input.minuteId },
      include: { bases: true, participants: true },
    });
    if (!minute) throw new NotFoundError("Negotiation minutes");
    if (minute.status !== "DRAFT") {
      throw new RuleViolationError(`${minute.number} has already been finalised.`);
    }

    const unanswered = minute.bases.filter(
      (b) => SOP_BASES.includes(b.basis as NegotiationBasis) && !b.discussed && !b.notes,
    );
    if (unanswered.length) {
      throw new RuleViolationError(
        `${minute.number} cannot be finalised: ${unanswered
          .map((b) => NEGOTIATION_BASIS_LABELS[b.basis as NegotiationBasis])
          .join(", ")} ${unanswered.length === 1 ? "has" : "have"} no answer. ` +
          "Record what was discussed, or say the basis was not raised — a blank is neither.",
      );
    }

    const updated = await tx.negotiationMinute.update({
      where: { id: minute.id },
      data: {
        status: "FINALISED",
        conclusion: input.conclusion.trim(),
        recommendedVendorId: input.recommendedVendorId ?? null,
        finalisedAt: new Date(),
      },
    });

    await attest(
      user,
      {
        documentType: "NEGOTIATION_MINUTE",
        documentId: minute.id,
        documentRef: minute.number,
        attestationType: "PREPARED",
        decision: "NOTED",
        comment: `Negotiation minutes finalised — ${input.conclusion.trim()}`,
        signedContent: {
          heldAt: minute.heldAt,
          participants: minute.participants.map((p) => `${p.side}:${p.name}`),
          bases: minute.bases.map((b) => `${b.basis}:${b.discussed ? "discussed" : "not raised"}`),
          conclusion: input.conclusion.trim(),
        },
      },
      tx,
    );

    await writeAudit(
      {
        entityType: "NegotiationMinute",
        entityId: minute.id,
        entityRef: minute.number,
        action: "MINUTES_FINALISED",
        newValue: {
          conclusion: input.conclusion.trim(),
          recommendedVendorId: input.recommendedVendorId ?? null,
        },
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/** The minutes on one sourcing exercise, newest first. */
export async function minutesFor(
  filter: { rfqId?: string; prId?: string },
  db: DbClient = prisma,
) {
  return db.negotiationMinute.findMany({
    where: {
      ...(filter.rfqId ? { rfqId: filter.rfqId } : {}),
      ...(filter.prId ? { prId: filter.prId } : {}),
    },
    include: {
      participants: true,
      bases: { orderBy: { sequence: "asc" } },
      preparedBy: { select: { name: true, title: true } },
      recommendedVendor: { select: { id: true, name: true } },
    },
    orderBy: { heldAt: "desc" },
  });
}

export async function minuteSignatures(minuteId: string, db: DbClient = prisma) {
  return attestations("NEGOTIATION_MINUTE", minuteId, db);
}
