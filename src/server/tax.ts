import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { assertEntityAccess, userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit, diffFields } from "@/lib/audit";
import { round2 } from "@/lib/format";
import type { ProcurementKind } from "@/lib/kind";

/**
 * The Tax Master.
 *
 * ZAM/PUR/SOP-01 §4.8 says taxes are applied "in accordance with the
 * requirements of the Income Tax Ordinance currently applicable in Pakistan",
 * and the payment flow routes the computation to KPMG. The SOP therefore states
 * no percentage on purpose — the applicable rate is a matter of law that changes
 * without the SOP changing.
 *
 * So rates are data the business enters and approves, never a literal. Two
 * figures used to be hard-coded — 18% in configuration and 16% on the Cost
 * Analysis Form — and they contradicted each other. Both are gone.
 *
 * Three properties make this correct rather than merely configurable:
 *
 *   · **Effective-dated.** A rate change is a new row, not an edit. A rule that
 *     has been applied to a transaction is never modified.
 *   · **Line-level.** Goods and services can be taxed differently, and one
 *     order can carry both kinds of line where policy permits.
 *   · **Snapshotted.** The percentage that was applied is written onto the line.
 *     A later change to the master cannot silently restate an old order's tax.
 */

export type TaxRuleInput = {
  code: string;
  name: string;
  appliesTo: ProcurementKind | "BOTH";
  method?: "PERCENT" | "FIXED";
  percent: number;
  withholding?: boolean;
  vendorTaxStatus?: "FILER" | "NON_FILER" | "ANY";
  entityId?: string | null;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  sourceReference?: string | null;
};

/** The rules in force for a kind, a date and an entity — the dropdown's contents. */
export async function applicableTaxRules(
  where: {
    entityId?: string | null;
    kind?: ProcurementKind;
    on?: Date;
    vendorTaxStatus?: "FILER" | "NON_FILER";
  } = {},
  db: DbClient = prisma,
) {
  const on = where.on ?? new Date();
  const rules = await db.taxRule.findMany({
    where: {
      active: true,
      effectiveFrom: { lte: on },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }],
      // A null entity is a group-wide rule; an entity's own rules sit alongside.
      ...(where.entityId ? { OR: [{ entityId: where.entityId }, { entityId: null }] } : {}),
      ...(where.kind ? { appliesTo: { in: [where.kind, "BOTH"] } } : {}),
      ...(where.vendorTaxStatus
        ? { vendorTaxStatus: { in: [where.vendorTaxStatus, "ANY"] } }
        : {}),
    },
    orderBy: [{ code: "asc" }, { effectiveFrom: "desc" }],
  });

  // An entity-specific rule supersedes the group rule of the same code, and a
  // later effective date supersedes an earlier one. Only the survivor is offered.
  const chosen = new Map<string, (typeof rules)[number]>();
  for (const r of rules) {
    const held = chosen.get(r.code);
    if (!held) {
      chosen.set(r.code, r);
      continue;
    }
    const moreSpecific = Boolean(r.entityId) && !held.entityId;
    if (moreSpecific) chosen.set(r.code, r);
  }
  return [...chosen.values()];
}

/**
 * What to write onto a line: the rule's id and a frozen copy of what it said.
 *
 * The snapshot is the whole point. Without it, reading an order from two years
 * ago and recomputing its tax from today's master would restate a settled
 * figure — which is how a reconciliation stops tying out.
 */
export function taxSnapshot(rule: {
  id: string;
  code: string;
  name: string;
  percent: number;
  method: string;
  withholding: boolean;
  appliesTo: string;
  effectiveFrom: Date;
}) {
  return {
    taxRuleId: rule.id,
    taxRate: rule.percent,
    taxRuleSnapshot: JSON.stringify({
      code: rule.code,
      name: rule.name,
      percent: rule.percent,
      method: rule.method,
      withholding: rule.withholding,
      appliesTo: rule.appliesTo,
      effectiveFrom: rule.effectiveFrom.toISOString(),
      snapshotAt: new Date().toISOString(),
    }),
  };
}

/** Reads a snapshot back. Returns null rather than throwing on malformed JSON. */
export function readTaxSnapshot(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as {
      code: string;
      name: string;
      percent: number;
      method: string;
      withholding: boolean;
      appliesTo: string;
      effectiveFrom: string;
      snapshotAt: string;
    };
  } catch {
    return null;
  }
}

/**
 * Line tax from the snapshot, never from the master.
 *
 * Withholding is deducted rather than added: it is tax retained from the
 * vendor's payment, not a charge on top of the invoice. Treating the two the
 * same way is how a payable ends up wrong by twice the rate.
 */
export function lineTax(line: {
  quantity: number;
  unitPrice: number;
  taxRate?: number | null;
  taxRuleSnapshot?: string | null;
}) {
  const gross = round2(line.quantity * line.unitPrice);
  const snap = readTaxSnapshot(line.taxRuleSnapshot);
  const percent = snap?.percent ?? line.taxRate ?? 0;
  const amount = snap?.method === "FIXED" ? round2(percent) : round2((gross * percent) / 100);
  const withholding = snap?.withholding ?? false;
  return {
    gross,
    percent,
    amount,
    withholding,
    /** What the line adds to the payable: withholding subtracts. */
    net: withholding ? round2(gross - amount) : round2(gross + amount),
  };
}

/* ── Master maintenance ──────────────────────────────────────────────────── */

export async function createTaxRule(user: SessionUser, input: TaxRuleInput, db: DbClient = prisma) {
  if (!userHasPermission(user, P.TAX_MANAGE)) {
    throw new RuleViolationError("You do not have permission to maintain the tax master.");
  }
  if (input.entityId) assertEntityAccess(user, input.entityId);
  if (!input.code.trim()) throw new ValidationError("Give the tax a code.");
  if (!input.name.trim()) throw new ValidationError("Give the tax a name.");
  if (input.percent < 0 || input.percent > 100) {
    throw new ValidationError("A tax percentage must be between 0 and 100.");
  }
  if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) {
    throw new ValidationError("The end date must be after the date the rate takes effect.");
  }

  return withTransaction(db, async (tx) => {
    // Two rules of the same code cannot be in force at once for the same scope:
    // the dropdown would offer both and the applied rate would be arbitrary.
    const overlapping = await tx.taxRule.findFirst({
      where: {
        code: input.code.trim(),
        active: true,
        entityId: input.entityId ?? null,
        appliesTo: input.appliesTo,
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: input.effectiveFrom } }],
      },
    });
    if (overlapping) {
      throw new RuleViolationError(
        `${overlapping.code} is already in force for this scope from ${overlapping.effectiveFrom.toISOString().slice(0, 10)}` +
          `${overlapping.effectiveTo ? ` to ${overlapping.effectiveTo.toISOString().slice(0, 10)}` : " with no end date"}. ` +
          "Close that rate off first, so the two do not overlap — the older one keeps the transactions it governed.",
      );
    }

    const rule = await tx.taxRule.create({
      data: {
        code: input.code.trim().toUpperCase(),
        name: input.name.trim(),
        appliesTo: input.appliesTo,
        method: input.method ?? "PERCENT",
        percent: input.percent,
        withholding: input.withholding ?? false,
        vendorTaxStatus: input.vendorTaxStatus ?? "ANY",
        entityId: input.entityId ?? null,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        sourceReference: input.sourceReference ?? null,
        createdById: user.id,
      },
    });

    await writeAudit(
      {
        entityType: "TaxRule",
        entityId: rule.id,
        entityRef: `${rule.code} ${rule.percent}%`,
        action: "TAX_RULE_CREATED",
        newValue: {
          code: rule.code,
          percent: rule.percent,
          appliesTo: rule.appliesTo,
          withholding: rule.withholding,
          effectiveFrom: rule.effectiveFrom,
          source: rule.sourceReference,
        },
        reason: input.sourceReference ?? null,
        actor: user,
      },
      tx,
    );
    return rule;
  });
}

/**
 * Closes a rate off from a date. Never edits the percentage.
 *
 * Editing a rate that has been applied would restate settled transactions. A
 * rate change is therefore two operations: end the old one, create the new one.
 */
export async function closeTaxRule(
  user: SessionUser,
  id: string,
  effectiveTo: Date,
  reason: string,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.TAX_MANAGE)) {
    throw new RuleViolationError("You do not have permission to maintain the tax master.");
  }
  if (!reason?.trim()) throw new ValidationError("Record why this rate is being closed off.");

  return withTransaction(db, async (tx) => {
    const rule = await tx.taxRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundError("Tax rule");
    if (effectiveTo < rule.effectiveFrom) {
      throw new ValidationError("A rate cannot end before it began.");
    }

    const updated = await tx.taxRule.update({
      where: { id },
      data: { effectiveTo, active: effectiveTo > new Date() },
    });
    await writeAudit(
      {
        entityType: "TaxRule",
        entityId: id,
        entityRef: `${rule.code} ${rule.percent}%`,
        action: "TAX_RULE_CLOSED",
        changes: diffFields(rule, { effectiveTo, active: updated.active }),
        reason: reason.trim(),
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/** Approves a rate for use. A rate nobody approved should not price an order. */
export async function approveTaxRule(user: SessionUser, id: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.TAX_VERIFY, P.TAX_MANAGE)) {
    throw new RuleViolationError("You do not have permission to approve tax rates.");
  }
  return withTransaction(db, async (tx) => {
    const rule = await tx.taxRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundError("Tax rule");
    if (rule.createdById === user.id && !userHasPermission(user, P.TAX_VERIFY)) {
      throw new RuleViolationError(
        "A rate is approved by somebody other than the person who entered it.",
      );
    }
    const updated = await tx.taxRule.update({
      where: { id },
      data: { approvedById: user.id, approvedAt: new Date() },
    });
    await writeAudit(
      {
        entityType: "TaxRule",
        entityId: id,
        entityRef: `${rule.code} ${rule.percent}%`,
        action: "TAX_RULE_APPROVED",
        actor: user,
      },
      tx,
    );
    return updated;
  });
}
