import { prisma, type DbClient } from "@/lib/db";
import { PERMISSIONS as P, PERMISSION_META, ROLE_DEFINITIONS } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { SOD_RULE_DEFS, SOD_ROLE_CONFLICTS_KEY, type RoleConflict } from "@/lib/sod";
import { getConfigArray } from "@/lib/config";
import { writeAudit } from "@/lib/audit";
import { RuleViolationError, ValidationError } from "@/lib/errors";

/**
 * Who holds what, and whether anybody holds a combination they should not.
 *
 * Two controls the calendar was carrying as "awaiting rollout" because they had
 * no screen. Both are read-only over data that already exists — the gap was
 * never the data, it was that nobody could look at it.
 *
 * ## The access review
 *
 * The meeting requirements ask for a quarterly access review "as a decision
 * record". The distinction from a report is the whole point: a list of who holds
 * what is a report, and everybody has one. A review is somebody looking at that
 * list and saying it is right — so performing it is recorded against the control
 * calendar's run, with the figures as they stood.
 *
 * The parts worth a reviewer's attention are the ones this surfaces:
 *
 *   · people with no role at all, who can sign in and do nothing, which usually
 *     means somebody was set up and forgotten;
 *   · people holding more than one procurement role, which is where separation
 *     of duties quietly stops holding;
 *   · inactive accounts that still carry roles, which is what a leaver's access
 *     looks like when nobody removed it;
 *   · roles nobody holds, which are either dead weight or a control with no
 *     owner — and the control calendar already shows which.
 *
 * ## The segregation report
 *
 * Phase 1 built three per-transaction separations and they are enforced. What did
 * not exist is the standing view: which *people* hold both sides of a separation,
 * which is a different question from whether any single transaction breached one.
 *
 * A person holding both sides has not done anything wrong. They are simply the
 * point at which the control depends on their restraint rather than on the
 * system, and that is worth knowing before it matters rather than after.
 */

export type AccessRow = {
  userId: string;
  name: string;
  email: string;
  title: string | null;
  active: boolean;
  entityName: string | null;
  roles: string[];
  permissionCount: number;
  /** Roles that are procurement-facing rather than read-only. */
  actingRoles: string[];
  flags: string[];
};

export type AccessReview = {
  rows: AccessRow[];
  totals: {
    users: number;
    active: number;
    inactive: number;
    noRole: number;
    multiRole: number;
    inactiveWithRoles: number;
  };
  /** Roles defined in code that nobody holds. */
  unheldRoles: Array<{ code: string; name: string }>;
  /** Roles held by exactly one person — a single point of failure. */
  soleHolders: Array<{ code: string; name: string; holder: string }>;
};

/**
 * Roles that act on procurement rather than only reading it.
 *
 * Derived from the role definitions rather than listed by hand: a role that can
 * approve, issue, post or authorise anything is an acting role. Listing them
 * would go stale the first time somebody adds one.
 */
const ACTING_MARKERS = [
  "approve",
  "issue",
  "post",
  "authorise",
  "decide",
  "sign",
  "adjust",
  "manage",
];

function isActingRole(code: string): boolean {
  const def = ROLE_DEFINITIONS.find((r) => r.code === code);
  if (!def) return false;
  return def.permissions.some((p) => ACTING_MARKERS.some((m) => p.includes(m)));
}

export async function accessReview(
  filter: { entityId?: string | null } = {},
  db: DbClient = prisma,
): Promise<AccessReview> {
  const users = await db.user.findMany({
    where: filter.entityId
      ? {
          OR: [
            { primaryEntityId: filter.entityId },
            { entityAccess: { some: { entityId: filter.entityId } } },
          ],
        }
      : {},
    select: {
      id: true,
      name: true,
      email: true,
      title: true,
      active: true,
      primaryEntity: { select: { name: true } },
      roles: {
        select: {
          role: {
            select: {
              code: true,
              name: true,
              _count: { select: { permissions: true } },
            },
          },
        },
      },
    },
    orderBy: { name: "asc" },
    take: 2000,
  });

  const rows: AccessRow[] = users.map((u) => {
    const roles = u.roles.map((r) => r.role.code);
    const acting = roles.filter(isActingRole);
    const permissionCount = u.roles.reduce((a, r) => a + r.role._count.permissions, 0);

    const flags: string[] = [];
    if (u.active && roles.length === 0) flags.push("No role — can sign in and do nothing");
    if (!u.active && roles.length > 0) flags.push("Inactive but still carries roles");
    if (acting.length > 1) flags.push(`Holds ${acting.length} acting roles`);

    return {
      userId: u.id,
      name: u.name,
      email: u.email,
      title: u.title,
      active: u.active,
      entityName: u.primaryEntity?.name ?? null,
      roles,
      permissionCount,
      actingRoles: acting,
      flags,
    };
  });

  const heldCodes = new Map<string, string[]>();
  for (const r of rows) {
    for (const code of r.roles) {
      heldCodes.set(code, [...(heldCodes.get(code) ?? []), r.name]);
    }
  }

  const unheldRoles = ROLE_DEFINITIONS.filter((d) => !heldCodes.has(d.code)).map((d) => ({
    code: d.code,
    name: d.name,
  }));

  const soleHolders = [...heldCodes.entries()]
    .filter(([, holders]) => holders.length === 1)
    .map(([code, holders]) => ({
      code,
      name: ROLE_DEFINITIONS.find((d) => d.code === code)?.name ?? code,
      holder: holders[0]!,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    rows,
    totals: {
      users: rows.length,
      active: rows.filter((r) => r.active).length,
      inactive: rows.filter((r) => !r.active).length,
      noRole: rows.filter((r) => r.active && r.roles.length === 0).length,
      multiRole: rows.filter((r) => r.actingRoles.length > 1).length,
      inactiveWithRoles: rows.filter((r) => !r.active && r.roles.length > 0).length,
    },
    unheldRoles,
    soleHolders,
  };
}

export type SeparationRow = {
  code: string;
  action: string;
  counterpart: string;
  source: string;
  /** Permission pairs that let one person stand on both sides. */
  sidePermissions: { acting: string[]; counterpart: string[] };
  /** People who hold both sides. */
  bothSides: Array<{ id: string; name: string; title: string | null }>;
};

/**
 * Which permissions put somebody on each side of each separation.
 *
 * Derived from what the separation is actually about rather than declared, so a
 * permission added to a role later is picked up without this list being edited.
 * The pairs are deliberately explicit here because the separations are three
 * specific things and inferring them from names would be guesswork.
 */
const SEPARATION_SIDES: Record<string, { acting: string[]; counterpart: string[] }> = {
  "sod.cost_analysis_prepare_verify": {
    acting: [P.COMPARATIVE_VERIFY, P.VENDOR_SELECT],
    counterpart: [P.COMPARATIVE_CREATE],
  },
  "sod.pr_raise_approve": {
    acting: [P.PR_APPROVE],
    counterpart: [P.PR_CREATE],
  },
  "sod.grn_post_invoice_approve": {
    acting: [P.INVOICE_APPROVE, P.INVOICE_VERIFY],
    counterpart: [P.GRN_POST],
  },
};

/**
 * Who stands on both sides of a separation.
 *
 * Holding both is not a breach. It is the point at which the control depends on
 * that person's restraint rather than on the system — and the system refuses the
 * act on a given document either way. What this shows is where that per-document
 * refusal is the *only* thing standing in the way, which is worth knowing before
 * it matters.
 */
export async function separationReport(
  filter: { entityId?: string | null } = {},
  db: DbClient = prisma,
): Promise<{ rows: SeparationRow[]; conflicts: Array<{ roles: [string, string]; reason: string; holders: string[] }> }> {
  const users = await db.user.findMany({
    where: {
      active: true,
      ...(filter.entityId
        ? {
            OR: [
              { primaryEntityId: filter.entityId },
              { entityAccess: { some: { entityId: filter.entityId } } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      name: true,
      title: true,
      roles: {
        select: {
          role: {
            select: {
              code: true,
              permissions: { select: { permission: { select: { code: true } } } },
            },
          },
        },
      },
    },
    take: 2000,
  });

  const permissionsOf = new Map<string, Set<string>>();
  const rolesOf = new Map<string, string[]>();
  for (const u of users) {
    permissionsOf.set(
      u.id,
      new Set(u.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.code))),
    );
    rolesOf.set(u.id, u.roles.map((r) => r.role.code));
  }

  const rows: SeparationRow[] = SOD_RULE_DEFS.map((def) => {
    const sides = SEPARATION_SIDES[def.code] ?? { acting: [], counterpart: [] };
    const bothSides = users
      .filter((u) => {
        const held = permissionsOf.get(u.id)!;
        return (
          sides.acting.some((c) => held.has(c)) && sides.counterpart.some((c) => held.has(c))
        );
      })
      .map((u) => ({ id: u.id, name: u.name, title: u.title }));

    return {
      code: def.code,
      action: def.action,
      counterpart: def.counterpart,
      source: def.source,
      sidePermissions: sides,
      bothSides,
    };
  });

  // Every prohibited role pair in policy, and who holds each. Read from the
  // configuration directly rather than through `roleConflicts`, which answers a
  // different question — it returns the pairs a *given* role set violates, and
  // this report needs the pairs themselves plus their holders. The list ships
  // empty because neither SOP names a pair; see ES-025.
  const declared = await getConfigArray<RoleConflict>(
    SOD_ROLE_CONFLICTS_KEY,
    filter.entityId ?? null,
    db,
  );
  const conflicts = declared.map((c) => ({
    ...c,
    holders: users
      .filter((u) => {
        const held = rolesOf.get(u.id) ?? [];
        return held.includes(c.roles[0]) && held.includes(c.roles[1]);
      })
      .map((u) => u.name),
  }));

  return { rows, conflicts };
}

/**
 * Records that a review was performed.
 *
 * The figures as they stood go into the record, so the decision is anchored to
 * what was actually in front of the reviewer. A review that says only "looked at
 * it on the 3rd" cannot be checked against anything.
 */
export async function recordAccessReview(
  user: SessionUser,
  input: { periodLabel: string; notes: string; entityId?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.USER_MANAGE, P.ROLE_MANAGE, P.AUDIT_VIEW)) {
    throw new RuleViolationError("Recording an access review needs user-administration or audit authority.");
  }
  if (!input.notes?.trim() || input.notes.trim().length < 15) {
    throw new ValidationError(
      "Say what you looked at and what you concluded. A review is somebody saying the list is right; without that it is just a report.",
    );
  }

  const review = await accessReview({ entityId: input.entityId ?? null }, db);
  const separations = await separationReport({ entityId: input.entityId ?? null }, db);

  await writeAudit(
    {
      entityType: "AccessReview",
      entityId: input.periodLabel,
      entityRef: `Access review ${input.periodLabel}`,
      action: "ACCESS_REVIEW_PERFORMED",
      newValue: {
        ...review.totals,
        unheldRoles: review.unheldRoles.length,
        soleHolders: review.soleHolders.length,
        peopleOnBothSidesOfASeparation: separations.rows.reduce(
          (a, r) => a + r.bothSides.length,
          0,
        ),
        declaredRoleConflicts: separations.conflicts.length,
      },
      reason: input.notes.trim(),
      actor: user,
    },
    db,
  );
  return { review, separations };
}

/** Permission labels for the screens. */
export function permissionLabel(code: string): string {
  return PERMISSION_META[code]?.name ?? code;
}
