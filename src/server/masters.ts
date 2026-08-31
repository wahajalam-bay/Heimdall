import { prisma, type DbClient } from "@/lib/db";
import { round2 } from "@/lib/format";
import { CONFIG_KEYS, getConfigBool } from "@/lib/config";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { DOMAIN_ACTIONS, assertAuthority, type Actor, type Authority } from "@/lib/actor";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { nextNumber } from "@/lib/numbering";

/**
 * Master data: item codes, units, department contacts, asset insurance.
 *
 * The specification is explicit that an item code is derived from a hierarchy
 * rather than typed by an ordinary user, and that is worth honouring literally.
 * A hand-typed code is how the same screwdriver ends up in the catalogue three
 * times, which is how a stock check finds nothing and a buyer buys a fourth.
 */

/* ── Derived item codes ───────────────────────────────────── */

/** The rule that governs a given item, most specific first. */
export async function itemCodeRuleFor(
  input: { entityId?: string | null; categoryId?: string | null },
  db: DbClient = prisma,
) {
  const rules = await db.itemCodeRule.findMany({
    where: {
      active: true,
      OR: [
        { entityId: input.entityId ?? null, categoryId: input.categoryId ?? null },
        { entityId: input.entityId ?? null, categoryId: null },
        { entityId: null, categoryId: input.categoryId ?? null },
        { entityId: null, categoryId: null },
      ],
    },
  });
  if (!rules.length) return null;
  const score = (r: (typeof rules)[number]) =>
    (r.entityId && r.entityId === input.entityId ? 2 : 0) +
    (r.categoryId && r.categoryId === input.categoryId ? 1 : 0);
  return rules.sort((a, b) => score(b) - score(a))[0];
}

export type CodeContext = {
  entityCode?: string | null;
  categoryCode?: string | null;
  subcategoryCode?: string | null;
  locationCode?: string | null;
};

/**
 * Builds the next code for a rule.
 *
 * The counter is per resolved prefix, so IT-LAP counts separately from OFF-PAP
 * and neither leaves gaps in the other. Segments that resolve to nothing are
 * dropped rather than left as empty separators.
 */
export async function nextItemCode(
  rule: { pattern: string; separator: string; sequenceWidth: number },
  ctx: CodeContext,
  db: DbClient = prisma,
): Promise<string> {
  const segments = rule.pattern
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const resolved: string[] = [];
  let hasSequence = false;
  for (const seg of segments) {
    if (seg.startsWith("LITERAL:")) {
      resolved.push(seg.slice("LITERAL:".length));
      continue;
    }
    switch (seg) {
      case "ENTITY":
        if (ctx.entityCode) resolved.push(ctx.entityCode);
        break;
      case "CATEGORY":
        if (ctx.categoryCode) resolved.push(ctx.categoryCode);
        break;
      case "SUBCATEGORY":
        if (ctx.subcategoryCode) resolved.push(ctx.subcategoryCode);
        break;
      case "LOCATION":
        if (ctx.locationCode) resolved.push(ctx.locationCode);
        break;
      case "SEQUENCE":
        hasSequence = true;
        break;
      default:
        throw new ValidationError(`Item code rule refers to an unknown segment "${seg}".`);
    }
  }

  if (!hasSequence) {
    throw new ValidationError("An item code rule must include a SEQUENCE segment, or every item shares one code.");
  }

  const prefix = resolved.join(rule.separator);
  // The numbering table already guarantees gap-free counters per prefix and
  // handles concurrency; reusing it avoids a second mechanism doing the same job
  // slightly differently.
  const issued = await nextNumber(`ITEM:${prefix}`, db);
  const serial = issued.split("-").pop() ?? "1";
  const padded = serial.padStart(rule.sequenceWidth, "0");
  return prefix ? `${prefix}${rule.separator}${padded}` : padded;
}

/** Derives a code for a proposed item, or explains why it cannot. */
export async function deriveItemCode(
  input: { entityId?: string | null; categoryId: string; locationCode?: string | null },
  db: DbClient = prisma,
): Promise<{ code: string | null; reason: string | null }> {
  const auto = await getConfigBool(CONFIG_KEYS.ITEM_CODE_AUTOGENERATE, input.entityId ?? null, db);
  if (!auto) return { code: null, reason: "Automatic item codes are switched off in configuration." };

  const rule = await itemCodeRuleFor(input, db);
  if (!rule) return { code: null, reason: "No item code rule covers this entity and category." };

  const category = await db.category.findUnique({
    where: { id: input.categoryId },
    select: { code: true, parent: { select: { code: true } } },
  });
  if (!category) throw new NotFoundError("Category");

  const entity = input.entityId
    ? await db.entity.findUnique({ where: { id: input.entityId }, select: { code: true } })
    : null;

  // A child category is the sub-category; its parent is the category.
  const code = await nextItemCode(
    rule,
    {
      entityCode: entity?.code ?? null,
      categoryCode: category.parent?.code ?? category.code,
      subcategoryCode: category.parent ? category.code : null,
      locationCode: input.locationCode ?? null,
    },
    db,
  );
  return { code, reason: null };
}

export async function upsertItemCodeRule(
  user: SessionUser,
  input: {
    id?: string | null;
    entityId?: string | null;
    categoryId?: string | null;
    pattern: string;
    separator?: string;
    sequenceWidth?: number;
    notes?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.MASTER_MANAGE)) {
    throw new ForbiddenError("You do not have permission to maintain master data.");
  }
  if (!input.pattern?.trim()) throw new ValidationError("A pattern is required.");
  if (!input.pattern.includes("SEQUENCE")) {
    throw new ValidationError("The pattern must include SEQUENCE, or every item would share one code.");
  }

  const data = {
    entityId: input.entityId ?? null,
    categoryId: input.categoryId ?? null,
    pattern: input.pattern.trim(),
    separator: input.separator?.trim() || "-",
    sequenceWidth: Math.min(8, Math.max(1, input.sequenceWidth ?? 4)),
    notes: input.notes ?? null,
  };
  const rule = input.id
    ? await db.itemCodeRule.update({ where: { id: input.id }, data })
    : await db.itemCodeRule.create({ data });

  await writeAudit(
    {
      entityType: "ItemCodeRule",
      entityId: rule.id,
      action: input.id ? "RULE_UPDATED" : "RULE_CREATED",
      newValue: data,
      actor: user,
    },
    db,
  );
  return rule;
}

/* ── Units of measure ─────────────────────────────────────── */

export async function upsertUom(
  user: SessionUser,
  input: {
    id?: string | null;
    code: string;
    name: string;
    dimension?: string;
    baseCode?: string | null;
    factor?: number | null;
    entityId?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.MASTER_MANAGE)) {
    throw new ForbiddenError("You do not have permission to maintain master data.");
  }
  if (!input.code?.trim()) throw new ValidationError("A unit code is required.");
  if (input.baseCode && !input.factor) {
    throw new ValidationError("A unit that converts to another needs a conversion factor.");
  }
  if (input.baseCode && input.baseCode.trim().toUpperCase() === input.code.trim().toUpperCase()) {
    throw new ValidationError("A unit cannot convert to itself.");
  }

  const data = {
    code: input.code.trim().toUpperCase(),
    name: input.name.trim(),
    dimension: input.dimension ?? "COUNT",
    baseCode: input.baseCode?.trim().toUpperCase() || null,
    factor: input.factor ?? null,
    entityId: input.entityId ?? null,
  };
  const uom = input.id
    ? await db.uom.update({ where: { id: input.id }, data })
    : await db.uom.create({ data });

  await writeAudit(
    { entityType: "Uom", entityId: uom.id, entityRef: uom.code, action: input.id ? "UOM_UPDATED" : "UOM_CREATED", actor: user },
    db,
  );
  return uom;
}

/**
 * Converts a quantity between units of the same dimension.
 *
 * Refuses across dimensions rather than guessing: a kilogram is not a metre, and
 * a system that silently converts them produces a stock figure nobody can trust.
 */
export async function convertQuantity(
  quantity: number,
  fromCode: string,
  toCode: string,
  db: DbClient = prisma,
): Promise<number> {
  if (fromCode.toUpperCase() === toCode.toUpperCase()) return round2(quantity);
  const [from, to] = await Promise.all([
    db.uom.findUnique({ where: { code: fromCode.toUpperCase() } }),
    db.uom.findUnique({ where: { code: toCode.toUpperCase() } }),
  ]);
  if (!from || !to) throw new NotFoundError("Unit of measure");
  if (from.dimension !== to.dimension) {
    throw new RuleViolationError(`${from.code} measures ${from.dimension} and ${to.code} measures ${to.dimension}.`);
  }

  const toBase = (u: typeof from) => (u.baseCode && u.factor ? u.factor : 1);
  const fromBase = from.baseCode ?? from.code;
  const toBaseCode = to.baseCode ?? to.code;
  if (fromBase !== toBaseCode) {
    throw new RuleViolationError(`${from.code} and ${to.code} do not share a base unit.`);
  }
  return round2((quantity * toBase(from)) / toBase(to));
}

/* ── Department points of contact ─────────────────────────── */

export async function setDepartmentPoc(
  user: SessionUser,
  input: { departmentId: string; userId: string; responsibility?: string; primary?: boolean },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.MASTER_MANAGE, P.USER_MANAGE)) {
    throw new ForbiddenError("You do not have permission to assign department contacts.");
  }
  const responsibility = input.responsibility ?? "GENERAL";

  // One primary per responsibility, or "the primary contact" means nothing.
  if (input.primary) {
    await db.departmentPoc.updateMany({
      where: { departmentId: input.departmentId, responsibility, primary: true },
      data: { primary: false },
    });
  }

  const existing = await db.departmentPoc.findFirst({
    where: { departmentId: input.departmentId, userId: input.userId, responsibility },
  });
  const poc = existing
    ? await db.departmentPoc.update({
        where: { id: existing.id },
        data: { primary: Boolean(input.primary), active: true },
      })
    : await db.departmentPoc.create({
        data: {
          departmentId: input.departmentId,
          userId: input.userId,
          responsibility,
          primary: Boolean(input.primary),
        },
      });

  await writeAudit(
    {
      entityType: "DepartmentPoc",
      entityId: poc.id,
      action: "POC_ASSIGNED",
      newValue: { responsibility, primary: poc.primary },
      actor: user,
    },
    db,
  );
  return poc;
}

export async function removeDepartmentPoc(user: SessionUser, pocId: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.MASTER_MANAGE, P.USER_MANAGE)) {
    throw new ForbiddenError("You do not have permission to change department contacts.");
  }
  const poc = await db.departmentPoc.findUnique({ where: { id: pocId } });
  if (!poc) throw new NotFoundError("Department contact");
  const updated = await db.departmentPoc.update({ where: { id: pocId }, data: { active: false, primary: false } });
  await writeAudit({ entityType: "DepartmentPoc", entityId: pocId, action: "POC_REMOVED", actor: user }, db);
  return updated;
}

/** The contact who should handle a given piece of work for a department. */
export async function pocFor(
  departmentId: string,
  responsibility: string,
  db: DbClient = prisma,
) {
  const pocs = await db.departmentPoc.findMany({
    where: { departmentId, active: true, responsibility: { in: [responsibility, "GENERAL"] } },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: [{ primary: "desc" }],
  });
  // The named responsibility wins over the general one.
  return pocs.find((p) => p.responsibility === responsibility) ?? pocs[0] ?? null;
}

/* ── Asset insurance ──────────────────────────────────────── */

export async function upsertAssetInsurance(
  user: SessionUser,
  input: {
    id?: string | null;
    assetId: string;
    policyNumber: string;
    insurer: string;
    coverType?: string;
    sumInsured: number;
    premium?: number | null;
    startDate: Date;
    endDate: Date;
    notes?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.ASSET_INSURANCE_MANAGE, P.ASSET_MANAGE)) {
    throw new ForbiddenError("You do not have permission to maintain asset insurance.");
  }
  if (!input.policyNumber?.trim()) throw new ValidationError("A policy number is required.");
  if (input.endDate <= input.startDate) throw new ValidationError("The policy must end after it starts.");
  if (input.sumInsured <= 0) throw new ValidationError("A sum insured is required.");

  const asset = await db.asset.findUnique({ where: { id: input.assetId }, select: { id: true, cost: true, tag: true } });
  if (!asset) throw new NotFoundError("Asset");

  const data = {
    assetId: input.assetId,
    policyNumber: input.policyNumber.trim(),
    insurer: input.insurer.trim(),
    coverType: input.coverType ?? "COMPREHENSIVE",
    sumInsured: round2(input.sumInsured),
    premium: round2(input.premium ?? 0),
    startDate: input.startDate,
    endDate: input.endDate,
    notes: input.notes ?? null,
  };
  const policy = input.id
    ? await db.assetInsurance.update({ where: { id: input.id }, data })
    : await db.assetInsurance.create({ data });

  await writeAudit(
    {
      entityType: "AssetInsurance",
      entityId: policy.id,
      entityRef: asset.tag,
      action: input.id ? "INSURANCE_UPDATED" : "INSURANCE_ADDED",
      newValue: { policyNumber: data.policyNumber, sumInsured: data.sumInsured, endDate: data.endDate },
      actor: user,
    },
    db,
  );
  return policy;
}

/**
 * Policies that have lapsed or are about to, and the assets they leave uncovered.
 *
 * An asset whose cover expired quietly is the reason this exists at all.
 */
export async function insuranceExposure(
  entityIds: string[] | null,
  withinDays = 30,
  db: DbClient = prisma,
) {
  const horizon = new Date(Date.now() + withinDays * 86400000);
  const scope = entityIds ? { asset: { entityId: { in: entityIds } } } : {};

  const [expiring, lapsed, uninsured] = await Promise.all([
    db.assetInsurance.findMany({
      where: { status: "ACTIVE", endDate: { gte: new Date(), lte: horizon }, ...scope },
      include: { asset: { select: { id: true, tag: true, name: true, cost: true } } },
      orderBy: { endDate: "asc" },
    }),
    db.assetInsurance.findMany({
      where: { status: "ACTIVE", endDate: { lt: new Date() }, ...scope },
      include: { asset: { select: { id: true, tag: true, name: true, cost: true } } },
      orderBy: { endDate: "asc" },
    }),
    db.asset.count({
      where: {
        insurance: { none: {} },
        status: { notIn: ["DISPOSED", "SCRAPPED", "LOST"] },
        ...(entityIds ? { entityId: { in: entityIds } } : {}),
      },
    }),
  ]);

  return {
    expiring,
    lapsed,
    uninsured,
    valueAtRisk: round2(lapsed.reduce((a, p) => a + (p.asset.cost ?? 0), 0)),
  };
}

/** Marks cover that has run out, so the exposure report is not a manual read. */
export async function lapseExpiredPolicies(actor: Actor, db: DbClient = prisma) {
  assertAuthority(actor, DOMAIN_ACTIONS.POLICY_LAPSE_EXPIRED, {
    permission: [P.ASSET_INSURANCE_MANAGE, P.MASTER_MANAGE],
  });
  const result = await db.assetInsurance.updateMany({
    where: { status: "ACTIVE", endDate: { lt: new Date() } },
    data: { status: "LAPSED" },
  });
  return result.count;
}
