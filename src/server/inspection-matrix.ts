import { prisma, type DbClient } from "@/lib/db";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { attest } from "./attestation";

/**
 * The inspection responsibility matrix.
 *
 * ZAM/PUR/SOP-01, Store – Process Flow, Goods Receiving Flow step 2 prints a
 * chart: three inspection types down the side, seven category groups across the
 * top, and Store, Admin or IT in each of the twenty-one cells.
 *
 * ```
 *                Stationery Giveaways Furniture H&G  IT/Network Electronics Printed
 *  Technical      Store      Store     Admin     Store IT        Admin       Store
 *  Qualitative    Store      Store     Admin     Store IT        Admin       Store
 *  Quantitative   Store      Store     Store     Store Store     Store       Store
 * ```
 *
 * The system had one `inspectionType` defaulting to `GENERAL` and routed every
 * inspection to a single technical inspector. An Admin sign-off on furniture and
 * an IT sign-off on mobiles did not exist, and §4.7's requirement that the form
 * be "filled and signed by all concerns" had one `signedByName` text field to
 * hold them all.
 *
 * Two things follow from the chart that the code has to respect.
 *
 * **A delivery can need three different functions.** Furniture wants Admin for
 * the technical and qualitative checks and Store for the count. So an inspection
 * carries a set of required sign-offs, one per type, each with its own verdict.
 *
 * **The chart does not cover everything.** It names seven office and consumable
 * groups and says nothing about construction, MEP, machinery, vehicles or
 * professional services — which is most of what this business actually buys. A
 * category with no group is reported as *unmapped* and falls back to the
 * existing template routing. Inventing an owner for a steel delivery because the
 * chart happens to have a Store column would be putting words in the SOP's
 * mouth.
 */

export const SOP_INSPECTION_TYPES = ["TECHNICAL", "QUALITATIVE", "QUANTITATIVE"] as const;
export type SopInspectionType = (typeof SOP_INSPECTION_TYPES)[number];

export const INSPECTION_FUNCTIONS = ["STORE", "ADMIN", "IT"] as const;
export type InspectionFunction = (typeof INSPECTION_FUNCTIONS)[number];

export const INSPECTION_TYPE_LABELS: Record<SopInspectionType, string> = {
  TECHNICAL: "Technical",
  QUALITATIVE: "Qualitative",
  QUANTITATIVE: "Quantitative",
};

export const INSPECTION_FUNCTION_LABELS: Record<InspectionFunction, string> = {
  STORE: "Store",
  ADMIN: "Admin",
  IT: "IT",
};

/** The chart's seven column headings, verbatim. */
export const INSPECTION_CATEGORY_GROUPS = [
  "Stationery",
  "Giveaways",
  "Furniture",
  "Housekeeping & Grocery",
  "IT / Network / Mobiles",
  "Electronic Appliances",
  "Printed Collateral",
] as const;
export type InspectionCategoryGroup = (typeof INSPECTION_CATEGORY_GROUPS)[number];

/**
 * The chart itself, transcribed cell by cell.
 *
 * Kept here as the shipped default and seeded into `InspectionResponsibility`,
 * which is what the system actually reads. The chart is the sort of thing that
 * changes by memo, and a memo should not need a deployment.
 */
export const SOP_INSPECTION_MATRIX: Array<{
  group: InspectionCategoryGroup;
  technical: InspectionFunction;
  qualitative: InspectionFunction;
  quantitative: InspectionFunction;
}> = [
  { group: "Stationery", technical: "STORE", qualitative: "STORE", quantitative: "STORE" },
  { group: "Giveaways", technical: "STORE", qualitative: "STORE", quantitative: "STORE" },
  { group: "Furniture", technical: "ADMIN", qualitative: "ADMIN", quantitative: "STORE" },
  { group: "Housekeeping & Grocery", technical: "STORE", qualitative: "STORE", quantitative: "STORE" },
  { group: "IT / Network / Mobiles", technical: "IT", qualitative: "IT", quantitative: "STORE" },
  { group: "Electronic Appliances", technical: "ADMIN", qualitative: "ADMIN", quantitative: "STORE" },
  { group: "Printed Collateral", technical: "STORE", qualitative: "STORE", quantitative: "STORE" },
];

/**
 * Which system role each of the chart's three functions resolves to.
 *
 * The chart names functions, not roles, and the two are not the same thing. This
 * is the join, and it is deliberately shallow — a function with no matching role
 * is a gap somebody should fill, not a reason to route the inspection to whoever
 * happens to be available.
 */
export const FUNCTION_ROLE_CODES: Record<InspectionFunction, string | null> = {
  STORE: "STORE_MANAGER",
  ADMIN: "ADMIN_FLOOR_MANAGER",
  IT: "IT_USER",
};

export type Responsibility = {
  inspectionType: SopInspectionType;
  ownerFunction: InspectionFunction;
  ownerRoleCode: string | null;
  sourceReference: string | null;
};

export type MatrixResolution = {
  /** The chart column this category falls under, or null when it falls under none. */
  categoryGroup: string | null;
  responsibilities: Responsibility[];
  /**
   * Set when the chart is silent. The caller keeps its existing routing and says
   * so rather than pretending the matrix answered.
   */
  unmapped: string | null;
};

/**
 * What the chart says for a category.
 *
 * Entity rows supersede group rows for the same cell, so one company can differ
 * without forking the chart.
 */
export async function responsibilitiesForCategory(
  categoryId: string | null,
  entityId: string | null,
  db: DbClient = prisma,
): Promise<MatrixResolution> {
  if (!categoryId) {
    return {
      categoryGroup: null,
      responsibilities: [],
      unmapped: "No category on the order line, so the inspection chart cannot be read for it.",
    };
  }

  const category = await db.category.findUnique({
    where: { id: categoryId },
    select: { name: true, code: true, inspectionGroup: true },
  });
  if (!category?.inspectionGroup) {
    return {
      categoryGroup: null,
      responsibilities: [],
      unmapped:
        `${category?.name ?? "This category"} is not on the SOP's inspection chart. ` +
        "The chart covers seven office and consumable groups and says nothing about construction, MEP, machinery, vehicles or services.",
    };
  }

  const rows = await db.inspectionResponsibility.findMany({
    where: {
      active: true,
      categoryGroup: category.inspectionGroup,
      ...(entityId ? { OR: [{ entityId }, { entityId: null }] } : {}),
    },
    orderBy: [{ sequence: "asc" }],
  });

  // An entity's own cell beats the group's for the same inspection type.
  const chosen = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const held = chosen.get(r.inspectionType);
    if (!held || (r.entityId && !held.entityId)) chosen.set(r.inspectionType, r);
  }

  if (!chosen.size) {
    return {
      categoryGroup: category.inspectionGroup,
      responsibilities: [],
      unmapped: `The chart has no rows loaded for ${category.inspectionGroup}. Run the seed.`,
    };
  }

  // Chart order, not database order.
  const responsibilities = SOP_INSPECTION_TYPES.flatMap((t) => {
    const r = chosen.get(t);
    return r
      ? [
          {
            inspectionType: t,
            ownerFunction: r.ownerFunction as InspectionFunction,
            ownerRoleCode: r.ownerRoleCode,
            sourceReference: r.sourceReference,
          },
        ]
      : [];
  });

  return { categoryGroup: category.inspectionGroup, responsibilities, unmapped: null };
}

/**
 * Writes the required sign-offs onto an inspection.
 *
 * Snapshotted at scheduling from the chart as it stood then. A later change to
 * the chart must not silently rewrite who was supposed to have signed an
 * inspection that has already happened.
 */
export async function createSignoffs(
  inspectionId: string,
  responsibilities: Responsibility[],
  db: DbClient = prisma,
): Promise<number> {
  if (!responsibilities.length) return 0;
  const existing = await db.inspectionSignoff.findMany({
    where: { inspectionId },
    select: { inspectionType: true },
  });
  const held = new Set(existing.map((e) => e.inspectionType));

  let written = 0;
  for (const r of responsibilities) {
    if (held.has(r.inspectionType)) continue;
    await db.inspectionSignoff.create({
      data: {
        inspectionId,
        inspectionType: r.inspectionType,
        ownerFunction: r.ownerFunction,
        ownerRoleCode: r.ownerRoleCode,
      },
    });
    written += 1;
  }
  return written;
}

export type SignoffState = {
  id: string;
  inspectionType: SopInspectionType;
  typeLabel: string;
  ownerFunction: InspectionFunction;
  ownerLabel: string;
  ownerRoleCode: string | null;
  verdict: string | null;
  notes: string | null;
  signedByName: string | null;
  signedAt: Date | null;
  outstanding: boolean;
};

export async function signoffsFor(
  inspectionId: string,
  db: DbClient = prisma,
): Promise<SignoffState[]> {
  const rows = await db.inspectionSignoff.findMany({
    where: { inspectionId },
    include: { signedBy: { select: { name: true } } },
  });
  const order = new Map(SOP_INSPECTION_TYPES.map((t, i) => [t as string, i]));
  return rows
    .sort((a, b) => (order.get(a.inspectionType) ?? 9) - (order.get(b.inspectionType) ?? 9))
    .map((r) => ({
      id: r.id,
      inspectionType: r.inspectionType as SopInspectionType,
      typeLabel: INSPECTION_TYPE_LABELS[r.inspectionType as SopInspectionType] ?? r.inspectionType,
      ownerFunction: r.ownerFunction as InspectionFunction,
      ownerLabel: INSPECTION_FUNCTION_LABELS[r.ownerFunction as InspectionFunction] ?? r.ownerFunction,
      ownerRoleCode: r.ownerRoleCode,
      verdict: r.verdict,
      notes: r.notes,
      signedByName: r.signedBy?.name ?? null,
      signedAt: r.signedAt,
      outstanding: !r.signedAt,
    }));
}

/**
 * Records one function's sign-off on an inspection.
 *
 * The signer has to hold the role the chart names, or the matrix is decorative:
 * a Store Manager signing the IT technical check on a laptop delivery is exactly
 * the substitution the chart exists to prevent. The exception is somebody with
 * blanket inspection authority, who is entitled to act for any function and
 * whose name goes on the record either way.
 */
export async function signOffInspection(
  user: SessionUser,
  input: {
    signoffId: string;
    verdict: "PASS" | "FAIL" | "CONDITIONAL";
    notes?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.INSPECTION_PERFORM)) {
    throw new RuleViolationError("You do not have permission to sign an inspection.");
  }
  if (!["PASS", "FAIL", "CONDITIONAL"].includes(input.verdict)) {
    throw new ValidationError("Say whether this check passed, failed, or passed with conditions.");
  }
  if (input.verdict !== "PASS" && !input.notes?.trim()) {
    throw new ValidationError(
      "Say what was wrong. A failed or conditional check with no note cannot be acted on by whoever has to fix it.",
    );
  }

  const signoff = await db.inspectionSignoff.findUnique({
    where: { id: input.signoffId },
    include: { inspection: { select: { id: true, number: true, result: true } } },
  });
  if (!signoff) throw new NotFoundError("Inspection sign-off");
  if (signoff.signedAt) {
    throw new RuleViolationError(
      `The ${INSPECTION_TYPE_LABELS[signoff.inspectionType as SopInspectionType] ?? signoff.inspectionType} check on ${signoff.inspection.number} has already been signed.`,
    );
  }
  if (["APPROVED", "REJECTED"].includes(signoff.inspection.result)) {
    throw new RuleViolationError(
      `${signoff.inspection.number} is already ${signoff.inspection.result.toLowerCase()}. Sign-offs belong to an inspection that is still open.`,
    );
  }

  const holdsRole = !signoff.ownerRoleCode || user.roleCodes.includes(signoff.ownerRoleCode);
  const hasOverride = userHasPermission(user, P.INSPECTION_SCHEDULE);
  if (!holdsRole && !hasOverride) {
    throw new RuleViolationError(
      `The SOP's chart puts this check with ${INSPECTION_FUNCTION_LABELS[signoff.ownerFunction as InspectionFunction] ?? signoff.ownerFunction}. ` +
        "Signing it from another function is the substitution the chart exists to prevent.",
    );
  }

  const signed = await attest(
    user,
    {
      documentType: "INSPECTION",
      documentId: signoff.inspection.id,
      documentRef: signoff.inspection.number,
      attestationType: input.verdict === "FAIL" ? "REJECTED" : "VERIFIED",
      decision: input.verdict === "FAIL" ? "REJECTED" : "APPROVED",
      comment:
        `${INSPECTION_TYPE_LABELS[signoff.inspectionType as SopInspectionType] ?? signoff.inspectionType} check ` +
        `(${INSPECTION_FUNCTION_LABELS[signoff.ownerFunction as InspectionFunction] ?? signoff.ownerFunction}): ${input.verdict}` +
        (input.notes?.trim() ? ` — ${input.notes.trim()}` : ""),
    },
    db,
  );

  const updated = await db.inspectionSignoff.update({
    where: { id: signoff.id },
    data: {
      verdict: input.verdict,
      notes: input.notes?.trim() || null,
      signedById: user.id,
      signedAt: new Date(),
      attestationId: signed.id,
    },
  });

  await writeAudit(
    {
      entityType: "Inspection",
      entityId: signoff.inspection.id,
      entityRef: signoff.inspection.number,
      action: "INSPECTION_SIGNOFF",
      newValue: {
        check: signoff.inspectionType,
        function: signoff.ownerFunction,
        verdict: input.verdict,
      },
      reason: input.notes?.trim() || null,
      actor: user,
    },
    db,
  );
  return updated;
}

/**
 * Refuses to close an inspection while a required check is unsigned.
 *
 * §4.7 says the form is filled and signed by *all concerns*. An inspection
 * closed with the Admin technical check outstanding is a form with a blank on
 * it, and a blank on a signed form is worse than no form — it looks complete.
 */
export async function assertSignoffsComplete(
  inspectionId: string,
  ref: string,
  db: DbClient = prisma,
): Promise<void> {
  const rows = await signoffsFor(inspectionId, db);
  const outstanding = rows.filter((r) => r.outstanding);
  if (!outstanding.length) return;
  const named = outstanding.map((o) => `${o.typeLabel.toLowerCase()} check (${o.ownerLabel})`);
  const list =
    named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  throw new RuleViolationError(
    `${ref} cannot be closed: the ${list} ${outstanding.length === 1 ? "is" : "are"} unsigned. ` +
      "ZAM/PUR/SOP-01 §4.7 requires the inspection form to be signed by all concerns.",
  );
}
