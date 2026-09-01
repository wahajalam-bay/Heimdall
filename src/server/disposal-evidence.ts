import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { CONFIG_KEYS, getConfigBool } from "@/lib/config";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { round2 } from "@/lib/format";

/**
 * The evidence the Scrap Material Policy asks each disposal stage to produce.
 *
 * ZAM/PUR/SOP-01's disposal procedure is a table of eight rows, each with a
 * named process owner. The stage machine in `assets.ts` already walked the
 * ladder; what it did not do was require anything to exist at each rung, so a
 * case could reach completion with no inspection report, no photographs, no
 * Finance valuation and nobody recorded as present at the sale.
 *
 * | Stage | What the SOP requires | Owner |
 * |---|---|---|
 * | 1 | Physical inspection, report maintained | Admin / dept / Logistics / IA |
 * | 2 | Pictorial evidence of the material | Admin |
 * | 3 | Depreciated value and residual value | Finance |
 * | 4 | Committee approval, **or** the business head consulted where the value is insignificant | Procurement |
 * | 5 | Quotes or tender, depending on volume | Procurement |
 * | 6 | Sale **in the presence of IA, Finance, Admin, Procurement and Logistics** | all five |
 * | 7 | Pictorial evidence of the activity | Procurement / Admin |
 * | 8 | Write-off and FAR update | Finance |
 *
 * Two of those are worth drawing out.
 *
 * **Five functions must be present at the sale.** The point of naming five is
 * that no one of them conducts the sale alone. They are recorded as rows, not a
 * checkbox, because "who was there" is the question asked about a disposal that
 * later looks wrong and a boolean cannot answer it. A witness who is not a
 * system user is captured by name.
 *
 * **The insignificant-value route is a choice, not an omission.** The SOP allows
 * committee approval to be replaced by consulting the business head where the
 * value or quantum is insignificant. Taking that route names the head consulted
 * and states why the value is insignificant, so it reads as a decision somebody
 * made rather than a step that quietly did not happen.
 */

export const DISPOSAL_WITNESS_FUNCTIONS = [
  "INTERNAL_AUDIT",
  "FINANCE",
  "ADMIN",
  "PROCUREMENT",
  "LOGISTICS",
] as const;
export type DisposalWitnessFunction = (typeof DISPOSAL_WITNESS_FUNCTIONS)[number];

export const WITNESS_LABELS: Record<DisposalWitnessFunction, string> = {
  INTERNAL_AUDIT: "Internal Audit",
  FINANCE: "Finance",
  ADMIN: "Admin",
  PROCUREMENT: "Procurement",
  LOGISTICS: "Logistics",
};

/** Records the physical inspection and its report — stage 1. */
export async function recordPhysicalInspection(
  user: SessionUser,
  input: { caseId: string; report: string },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.DISPOSAL_CREATE, P.DISPOSAL_AUDIT_REVIEW, P.DISPOSAL_APPROVE)) {
    throw new RuleViolationError("You do not have permission to record a disposal inspection.");
  }
  if (!input.report?.trim()) {
    throw new ValidationError(
      "The SOP requires a Physical Inspection Report to be maintained. Record what the inspection found.",
    );
  }
  const kase = await db.disposalCase.findUnique({
    where: { id: input.caseId },
    select: { id: true, number: true },
  });
  if (!kase) throw new NotFoundError("Disposal case");

  const updated = await db.disposalCase.update({
    where: { id: kase.id },
    data: {
      physicalInspectionById: user.id,
      physicalInspectionAt: new Date(),
      physicalInspectionReport: input.report.trim(),
    },
  });
  await writeAudit(
    {
      entityType: "DisposalCase",
      entityId: kase.id,
      entityRef: kase.number,
      action: "DISPOSAL_PHYSICAL_INSPECTION",
      newValue: { by: user.name },
      reason: input.report.trim(),
      actor: user,
    },
    db,
  );
  return updated;
}

/**
 * Records Finance's valuation — stage 3.
 *
 * Two figures, not one. The depreciated (net book) value and the residual value
 * are different numbers, and the write-off is the gap between what the books
 * carry and what the sale realises. Collapsing them loses the write-off.
 */
export async function recordFinanceValuation(
  user: SessionUser,
  input: {
    caseId: string;
    netBookValue: number;
    residualValue: number;
    notes?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.PAYMENT_RECORD, P.BUDGET_MANAGE, P.DISPOSAL_APPROVE)) {
    throw new RuleViolationError(
      "The SOP puts the depreciated and residual values with Finance.",
    );
  }
  if (!(input.netBookValue >= 0) || !(input.residualValue >= 0)) {
    throw new ValidationError("Both values must be zero or more.");
  }
  const kase = await db.disposalCase.findUnique({
    where: { id: input.caseId },
    select: { id: true, number: true },
  });
  if (!kase) throw new NotFoundError("Disposal case");

  const updated = await db.disposalCase.update({
    where: { id: kase.id },
    data: {
      netBookValue: round2(input.netBookValue),
      residualValue: round2(input.residualValue),
      financeAssessedById: user.id,
      financeAssessedAt: new Date(),
      financeNotes: input.notes?.trim() || null,
    },
  });
  await writeAudit(
    {
      entityType: "DisposalCase",
      entityId: kase.id,
      entityRef: kase.number,
      action: "DISPOSAL_FINANCE_VALUATION",
      newValue: {
        netBookValue: round2(input.netBookValue),
        residualValue: round2(input.residualValue),
      },
      reason: input.notes?.trim() ?? null,
      actor: user,
    },
    db,
  );
  return updated;
}

/**
 * Takes the insignificant-value route in place of committee approval — stage 4.
 *
 * The SOP permits it "after consulting with relevant/concerned business head",
 * so the head is named and the insignificance is argued. Both are required:
 * without the name it is not a consultation, and without the argument it is not
 * insignificance, it is a preference.
 */
export async function recordInsignificantValue(
  user: SessionUser,
  input: { caseId: string; businessHeadId: string; justification: string },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.DISPOSAL_APPROVE)) {
    throw new RuleViolationError(
      "Replacing committee approval with a business-head consultation needs disposal-approval authority.",
    );
  }
  if (!input.businessHeadId) {
    throw new ValidationError("Name the business head consulted.");
  }
  if (!input.justification?.trim() || input.justification.trim().length < 12) {
    throw new ValidationError(
      "State why the value or quantum is insignificant. Without an argument this is a preference, not the SOP's exception.",
    );
  }

  const [kase, head] = await Promise.all([
    db.disposalCase.findUnique({ where: { id: input.caseId }, select: { id: true, number: true } }),
    db.user.findUnique({ where: { id: input.businessHeadId }, select: { id: true, name: true } }),
  ]);
  if (!kase) throw new NotFoundError("Disposal case");
  if (!head) throw new NotFoundError("Business head");
  if (head.id === user.id) {
    throw new RuleViolationError(
      "You cannot record yourself as the business head consulted. A consultation has two people in it.",
    );
  }

  const updated = await db.disposalCase.update({
    where: { id: kase.id },
    data: {
      insignificantValue: true,
      businessHeadConsultedId: head.id,
      businessHeadConsultedAt: new Date(),
      insignificanceJustification: input.justification.trim(),
    },
  });
  await writeAudit(
    {
      entityType: "DisposalCase",
      entityId: kase.id,
      entityRef: kase.number,
      action: "DISPOSAL_INSIGNIFICANT_VALUE",
      newValue: { businessHead: head.name, by: user.name },
      reason: input.justification.trim(),
      actor: user,
    },
    db,
  );
  return updated;
}

/** Records one function's presence at the sale — stage 6. */
export async function recordWitness(
  user: SessionUser,
  input: {
    caseId: string;
    function: DisposalWitnessFunction;
    userId?: string | null;
    name?: string | null;
    designation?: string | null;
    notes?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.DISPOSAL_APPROVE, P.DISPOSAL_CREATE, P.DISPOSAL_AUDIT_REVIEW)) {
    throw new RuleViolationError("You do not have permission to record disposal witnesses.");
  }
  if (!DISPOSAL_WITNESS_FUNCTIONS.includes(input.function)) {
    throw new ValidationError("That is not one of the five functions the SOP names.");
  }
  const named = input.name?.trim();
  if (!input.userId && !named) {
    throw new ValidationError(
      "Name who attended for this function. A function marked present with nobody behind it is a tick, not a witness.",
    );
  }

  const kase = await db.disposalCase.findUnique({
    where: { id: input.caseId },
    select: { id: true, number: true },
  });
  if (!kase) throw new NotFoundError("Disposal case");

  const resolvedName =
    named ??
    (input.userId
      ? ((await db.user.findUnique({ where: { id: input.userId }, select: { name: true } }))?.name ??
        null)
      : null);

  const existing = await db.disposalWitness.findFirst({
    where: { disposalId: kase.id, function: input.function },
  });
  const data = {
    userId: input.userId ?? null,
    name: resolvedName,
    designation: input.designation?.trim() || null,
    attendedAt: new Date(),
    notes: input.notes?.trim() || null,
  };
  const row = existing
    ? await db.disposalWitness.update({ where: { id: existing.id }, data })
    : await db.disposalWitness.create({
        data: { disposalId: kase.id, function: input.function, ...data },
      });

  await writeAudit(
    {
      entityType: "DisposalCase",
      entityId: kase.id,
      entityRef: kase.number,
      action: "DISPOSAL_WITNESS_RECORDED",
      newValue: { function: input.function, who: resolvedName },
      actor: user,
    },
    db,
  );
  return row;
}

/** Records the FAR hand-off and the write-off — stage 8. */
export async function recordFarUpdate(
  user: SessionUser,
  input: { caseId: string; reference: string; writeOffAmount?: number | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.PAYMENT_RECORD, P.BUDGET_MANAGE, P.DISPOSAL_APPROVE)) {
    throw new RuleViolationError("The SOP puts the FAR update with Finance.");
  }
  if (!input.reference?.trim()) {
    throw new ValidationError(
      "Record the reference Finance gave the FAR update. The register is Finance's system; this is the link to it, and a link with no reference is not one.",
    );
  }
  const kase = await db.disposalCase.findUnique({
    where: { id: input.caseId },
    select: { id: true, number: true, netBookValue: true, realisedValue: true },
  });
  if (!kase) throw new NotFoundError("Disposal case");

  // The write-off is what the books carried less what the sale realised. Taken
  // from the record where both figures exist, rather than asked for again.
  const derived =
    kase.netBookValue != null && kase.realisedValue != null
      ? round2(kase.netBookValue - kase.realisedValue)
      : null;

  const updated = await db.disposalCase.update({
    where: { id: kase.id },
    data: {
      farUpdatedById: user.id,
      farUpdatedAt: new Date(),
      farReference: input.reference.trim(),
      writeOffAmount: input.writeOffAmount ?? derived,
    },
  });
  await writeAudit(
    {
      entityType: "DisposalCase",
      entityId: kase.id,
      entityRef: kase.number,
      action: "DISPOSAL_FAR_UPDATED",
      newValue: { reference: input.reference.trim(), writeOff: updated.writeOffAmount },
      actor: user,
    },
    db,
  );
  return updated;
}

export type DisposalEvidence = {
  step: string;
  label: string;
  owner: string;
  satisfied: boolean;
  detail: string | null;
};

/**
 * What each stage of the SOP's table has and has not produced.
 *
 * Photographs are counted from the documents attached to the case, because
 * that is where they actually live; a separate flag would be a claim about the
 * documents rather than the documents themselves.
 */
export async function disposalEvidence(
  caseId: string,
  db: DbClient = prisma,
): Promise<{ items: DisposalEvidence[]; witnesses: Array<{ function: string; label: string; name: string | null; attendedAt: Date | null }>; missingWitnesses: string[] }> {
  const kase = await db.disposalCase.findUnique({
    where: { id: caseId },
    include: {
      witnesses: { include: { user: { select: { name: true } } } },
      bids: { select: { id: true } },
      physicalInspectionBy: { select: { name: true } },
      financeAssessedBy: { select: { name: true } },
      businessHeadConsulted: { select: { name: true } },
    },
  });
  if (!kase) throw new NotFoundError("Disposal case");

  const photos = await db.document.count({
    where: {
      linkedType: "DISPOSAL",
      linkedId: caseId,
      archived: false,
      mimeType: { startsWith: "image/" },
    },
  });

  const witnessByFn = new Map(kase.witnesses.map((w) => [w.function, w]));
  const missingWitnesses = DISPOSAL_WITNESS_FUNCTIONS.filter((f) => !witnessByFn.has(f)).map(
    (f) => WITNESS_LABELS[f],
  );

  const items: DisposalEvidence[] = [
    {
      step: "PHYSICAL_INSPECTION",
      label: "Physical inspection report",
      owner: "Admin / department / Logistics / Internal Audit",
      satisfied: Boolean(kase.physicalInspectionAt && kase.physicalInspectionReport),
      detail: kase.physicalInspectionBy?.name ?? null,
    },
    {
      step: "PICTORIAL_MATERIAL",
      label: "Pictorial evidence of the material",
      owner: "Admin",
      satisfied: photos > 0,
      detail: photos ? `${photos} image${photos === 1 ? "" : "s"} attached` : null,
    },
    {
      step: "FINANCE_VALUATION",
      label: "Depreciated and residual value",
      owner: "Finance",
      satisfied: kase.netBookValue != null && kase.residualValue != null,
      detail:
        kase.netBookValue != null
          ? `NBV ${kase.netBookValue.toLocaleString("en-PK")} · residual ${(kase.residualValue ?? 0).toLocaleString("en-PK")}${kase.financeAssessedBy ? ` — ${kase.financeAssessedBy.name}` : ""}`
          : null,
    },
    {
      step: "APPROVAL",
      label: "Committee approval, or the business head consulted",
      owner: "Procurement",
      satisfied: Boolean(kase.approvedAt || kase.businessHeadConsultedAt),
      detail: kase.insignificantValue
        ? `Insignificant value — ${kase.businessHeadConsulted?.name ?? "business head"} consulted`
        : kase.approvedAt
          ? "Committee approved"
          : null,
    },
    {
      step: "QUOTES",
      label: "Quotes or tender, depending on volume",
      owner: "Procurement",
      satisfied: !kase.biddingRequired || kase.bids.length > 0,
      detail: kase.biddingRequired
        ? `${kase.bids.length} bid${kase.bids.length === 1 ? "" : "s"}`
        : "Bidding not required for this case",
    },
    {
      step: "WITNESSES",
      label: "Sale in the presence of all five functions",
      owner: "IA, Finance, Admin, Procurement, Logistics",
      satisfied: missingWitnesses.length === 0,
      detail: missingWitnesses.length ? `Missing: ${missingWitnesses.join(", ")}` : "All five recorded",
    },
    {
      step: "PICTORIAL_ACTIVITY",
      label: "Pictorial evidence of the activity",
      owner: "Procurement / Admin",
      // Same document store; the SOP asks for photographs at two points and the
      // system cannot tell one photograph's purpose from another's, so this is
      // reported honestly as the same evidence rather than double-counted.
      satisfied: photos > 0,
      detail: photos ? "Counted from the same attached images" : null,
    },
    {
      step: "FAR",
      label: "Write-off and FAR update",
      owner: "Finance",
      satisfied: Boolean(kase.farUpdatedAt && kase.farReference),
      detail: kase.farReference
        ? `${kase.farReference}${kase.writeOffAmount != null ? ` · write-off ${kase.writeOffAmount.toLocaleString("en-PK")}` : ""}`
        : null,
    },
  ];

  return {
    items,
    witnesses: DISPOSAL_WITNESS_FUNCTIONS.map((f) => {
      const w = witnessByFn.get(f);
      return {
        function: f,
        label: WITNESS_LABELS[f],
        name: w?.name ?? w?.user?.name ?? null,
        attendedAt: w?.attendedAt ?? null,
      };
    }),
    missingWitnesses,
  };
}

/**
 * Refuses to complete a disposal while its evidence is short.
 *
 * Gated on configuration and off by default, because existing cases have none of
 * this and enforcing on day one would strand them. The witness requirement is
 * the one that matters most: a sale conducted without the five functions present
 * is the failure mode the SOP wrote that sentence for.
 */
export async function assertDisposalEvidence(
  caseId: string,
  ref: string,
  entityId: string,
  db: DbClient = prisma,
): Promise<void> {
  const enforce = await getConfigBool(CONFIG_KEYS.ENFORCE_DISPOSAL_EVIDENCE, entityId, db);
  if (!enforce) return;

  const { items } = await disposalEvidence(caseId, db);
  const missing = items.filter((i) => !i.satisfied).map((i) => i.label);
  if (!missing.length) return;
  throw new RuleViolationError(
    `${ref} cannot be completed: the Scrap Material Policy is short on ${missing.join(", ")}.`,
  );
}
