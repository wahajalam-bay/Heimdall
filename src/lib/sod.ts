import { prisma, type DbClient } from "./db";
import { CONFIG_KEYS, getConfigArray, getConfigBool } from "./config";
import { writeAudit } from "./audit";
import { ForbiddenError } from "./errors";
import type { Actor } from "./actor";

/**
 * Segregation of duties.
 *
 * Two different controls wear the same name, and conflating them breaks working
 * workflow:
 *
 *   · **Per-transaction** — the same person must not occupy both sides of one
 *     document. This is what the source documents actually require, and it is
 *     the one enforced by default. It does not care what roles somebody holds;
 *     a head of department who legitimately raises requisitions for their own
 *     team and legitimately approves their team's requisitions is fine, right
 *     up to the moment they try to approve their own.
 *   · **Per-role** — a role must not carry two permissions at once. Nothing in
 *     the supplied SOPs states any such combination, so the list is empty by
 *     default and is configuration, not code. Inventing entries here would
 *     silently lock people out of work they are doing today.
 *
 * Every rule below cites the separation the source states. Rules with no source
 * are not here.
 */

export const SOD_RULES = {
  /**
   * The Cost Analysis Form (Annexure 3) carries Prepared By and Verified By as
   * two signatures. One person signing both defeats the form.
   */
  COST_ANALYSIS_PREPARE_VERIFY: CONFIG_KEYS.SOD_COST_ANALYSIS_PREPARE_VERIFY,
  /**
   * A requisition's approval is the department's assent to the requester's ask.
   * The requester supplying their own assent is not an approval.
   */
  PR_RAISE_APPROVE: CONFIG_KEYS.SOD_PR_RAISE_APPROVE,
  /**
   * The three-way match sets the receipt against the invoice. The person who
   * attested the receipt is not the person to attest that it matches.
   */
  GRN_POST_INVOICE_APPROVE: CONFIG_KEYS.SOD_GRN_POST_INVOICE_APPROVE,
} as const;

export type SodRuleCode = (typeof SOD_RULES)[keyof typeof SOD_RULES];

type SodRuleDef = {
  code: SodRuleCode;
  /** What the actor is trying to do. */
  action: string;
  /** The earlier act on the same document that they must not also have done. */
  counterpart: string;
  /** Where in the supplied source the separation comes from. */
  source: string;
  message: string;
};

export const SOD_RULE_DEFS: readonly SodRuleDef[] = [
  {
    code: SOD_RULES.COST_ANALYSIS_PREPARE_VERIFY,
    action: "verify a cost analysis",
    counterpart: "prepared it",
    source: "SOP-012 Annexure 3 — separate Prepared By and Verified By signatures",
    message:
      "A cost analysis is verified by somebody other than the person who prepared it. Ask a colleague at or above your grade to verify this one.",
  },
  {
    code: SOD_RULES.PR_RAISE_APPROVE,
    action: "approve a requisition",
    counterpart: "raised it",
    source: "SOP-012 — departmental approval is given to the requester, not by them",
    message:
      "A requisition is approved by somebody other than the person who raised it. This one is yours, so it needs your department head or their delegate.",
  },
  {
    code: SOD_RULES.GRN_POST_INVOICE_APPROVE,
    action: "approve an invoice for payment",
    counterpart: "posted the goods receipt it is matched against",
    source: "SOP-012 / SOP-ZD-SC — three-way match as an independent check on the receipt",
    message:
      "An invoice is approved by somebody other than the person who posted the receipt it is matched against, so that the match is an independent check.",
  },
];

const RULE_BY_CODE = new Map(SOD_RULE_DEFS.map((r) => [r.code, r]));

/**
 * Refuses the operation when `counterpartUserId` is the actor.
 *
 * Each rule is entity-configurable because the two entities run different
 * approval chains and the source does not state that every separation applies
 * to both. Turning one off is a recorded configuration decision; the default is
 * on, because that is what the source says.
 */
export async function assertSeparation(
  actor: Actor,
  code: SodRuleCode,
  counterpartUserId: string | null | undefined,
  ctx: { entityId?: string | null; documentType: string; documentId: string; documentRef?: string | null },
  db: DbClient = prisma,
): Promise<void> {
  if (!counterpartUserId || counterpartUserId !== actor.id) return;

  const rule = RULE_BY_CODE.get(code);
  if (!rule) return;

  const enforced = await getConfigBool(code, ctx.entityId ?? null, db);
  if (!enforced) {
    // Switched off deliberately. Recorded, because a suppressed control that
    // leaves no trace is indistinguishable from one that was never there.
    await writeAudit(
      {
        entityType: ctx.documentType,
        entityId: ctx.documentId,
        entityRef: ctx.documentRef ?? null,
        action: "SOD_RULE_WAIVED_BY_CONFIGURATION",
        newValue: { rule: code, actor: actor.id, source: rule.source },
        reason: `Segregation of duties (${rule.action} / ${rule.counterpart}) is disabled for this entity.`,
        actor,
      },
      db,
    );
    return;
  }

  await writeAudit(
    {
      entityType: ctx.documentType,
      entityId: ctx.documentId,
      entityRef: ctx.documentRef ?? null,
      action: "SOD_RULE_BLOCKED",
      newValue: { rule: code, actor: actor.id, source: rule.source },
      reason: `${actor.name} tried to ${rule.action} they ${rule.counterpart}.`,
      actor,
    },
    db,
  );
  throw new ForbiddenError(rule.message);
}

/* ── Role-assignment combinations ──────────────────────────────────────────
 * Configuration, empty by default. Populated only when the business states a
 * combination, not inferred from the shape of the permission catalogue. */

export const SOD_ROLE_CONFLICTS_KEY = CONFIG_KEYS.SOD_PROHIBITED_ROLE_COMBINATIONS;

export type RoleConflict = { roles: [string, string]; reason: string };

/**
 * Prohibited role pairs, as configured. Returns the pairs the given role set
 * violates — empty when none, which is the shipped default.
 */
export async function roleConflicts(
  roleCodes: readonly string[],
  entityId: string | null = null,
  db: DbClient = prisma,
): Promise<RoleConflict[]> {
  const configured = await getConfigArray<RoleConflict>(SOD_ROLE_CONFLICTS_KEY, entityId, db);
  const held = new Set(roleCodes);
  return configured.filter(
    (c) => Array.isArray(c.roles) && c.roles.length === 2 && held.has(c.roles[0]) && held.has(c.roles[1]),
  );
}

/** Throws when a role assignment would create a configured prohibited pair. */
export async function assertNoRoleConflict(
  roleCodes: readonly string[],
  entityId: string | null = null,
  db: DbClient = prisma,
): Promise<void> {
  const conflicts = await roleConflicts(roleCodes, entityId, db);
  if (!conflicts.length) return;
  throw new ForbiddenError(
    `These roles cannot be held together: ${conflicts
      .map((c) => `${c.roles[0]} + ${c.roles[1]} (${c.reason})`)
      .join("; ")}.`,
  );
}
