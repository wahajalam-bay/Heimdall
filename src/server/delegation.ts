import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P, PERMISSION_META } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { DOMAIN_ACTIONS, assertAuthority, type Actor } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";

/**
 * Delegated authority.
 *
 * The meeting requirements ask for delegation and proxy that is **provable**,
 * rather than "somebody else holds the permission". Today the only way to keep
 * approvals moving while an approver is away is to give somebody their role —
 * which is permanent until removed, invisible once removed, and afterwards
 * indistinguishable from that person having always held it.
 *
 * ## Four things that make this a control rather than a shortcut
 *
 * **Bounded in time.** A delegation with no end date is a role reassignment
 * wearing a delegation's name, so an end date is required and the past is
 * refused.
 *
 * **Granted by the person whose authority it is.** You cannot delegate an
 * authority you do not hold — that is not delegation, it is invention. An
 * administrator may *record* somebody's delegation, and when they do, who
 * recorded it is stored separately from whose authority it is.
 *
 * **Scoped.** A delegation of purchase-order approval is not a delegation of
 * everything. An empty scope is refused because a delegation of nothing is not
 * one, and the screen makes the cost of a wide scope explicit rather than
 * offering "all" as a convenience.
 *
 * **Both names on every act.** The delegate acted; the delegator's authority was
 * used. An approval recording only one of those cannot be audited, which is the
 * whole reason this exists instead of a temporary role.
 *
 * ## What it deliberately does not do
 *
 * It does not silently widen anybody's session. `effectivePermissions` returns
 * the delegated set *separately*, so a caller has to decide to use it and can
 * record that it did. A delegation that quietly merged into `user.permissions`
 * would be exactly the invisible role grant this replaces.
 */

export type DelegationGrant = {
  id: string;
  delegatorId: string;
  delegatorName: string;
  permissions: string[];
  documentTypes: string[];
  valueLimit: number | null;
  validFrom: Date;
  validTo: Date;
  reason: string;
};

function parseList(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Records a delegation.
 *
 * The delegator must actually hold every permission being lent. Checked against
 * their own permission set, not the recorder's — otherwise an administrator
 * could mint authority nobody has by writing somebody else's name on it.
 */
export async function createDelegation(
  user: SessionUser,
  input: {
    delegatorId: string;
    delegateId: string;
    permissions: string[];
    documentTypes?: string[];
    valueLimit?: number | null;
    validFrom: Date;
    validTo: Date;
    reason: string;
    entityId?: string | null;
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    const recordingForSelf = input.delegatorId === user.id;
    // Delegating your own authority needs nothing beyond holding it. Recording
    // somebody else's needs administrative authority, because it is a statement
    // about a third party.
    if (!recordingForSelf && !userHasPermission(user, P.USER_MANAGE, P.ROLE_MANAGE)) {
      throw new RuleViolationError(
        "You can delegate your own authority. Recording somebody else's delegation needs user-administration authority.",
      );
    }
    if (input.delegatorId === input.delegateId) {
      throw new ValidationError("A delegation needs two different people.");
    }
    if (!input.reason?.trim() || input.reason.trim().length < 8) {
      throw new ValidationError(
        "State why the authority is being delegated. 'On leave until the 14th' is enough; nothing is not.",
      );
    }
    if (!input.permissions?.length) {
      throw new ValidationError(
        "Name what is being delegated. A delegation of nothing is not a delegation, and a delegation of everything is what makes segregation of duties unenforceable while it lasts.",
      );
    }
    if (!(input.validTo > input.validFrom)) {
      throw new ValidationError("The delegation must end after it starts.");
    }
    if (input.validTo < new Date()) {
      throw new ValidationError(
        "That period has already passed. A delegation cannot be backdated into authority somebody did not have at the time.",
      );
    }

    const [delegator, delegate] = await Promise.all([
      tx.user.findUnique({
        where: { id: input.delegatorId },
        select: {
          id: true,
          name: true,
          active: true,
          roles: { select: { role: { select: { permissions: { select: { permission: { select: { code: true } } } } } } } },
        },
      }),
      tx.user.findUnique({
        where: { id: input.delegateId },
        select: { id: true, name: true, active: true },
      }),
    ]);
    if (!delegator) throw new NotFoundError("Delegator");
    if (!delegate) throw new NotFoundError("Delegate");
    if (!delegate.active) {
      throw new RuleViolationError(`${delegate.name} is not an active user.`);
    }

    // What the delegator actually holds. You cannot lend what you do not have.
    const held = new Set(
      delegator.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.code)),
    );
    const cannotLend = input.permissions.filter((c) => !held.has(c));
    if (cannotLend.length) {
      throw new RuleViolationError(
        `${delegator.name} does not hold ${cannotLend
          .map((c) => PERMISSION_META[c]?.name ?? c)
          .join(", ")}, so it cannot be delegated. Delegation lends existing authority; it does not create any.`,
      );
    }

    // An overlapping delegation of the same permission between the same two
    // people is either a duplicate or a change of mind, and both are better
    // handled by revoking the first than by leaving two live grants nobody can
    // reconcile.
    const overlapping = await tx.delegation.findFirst({
      where: {
        delegatorId: delegator.id,
        delegateId: delegate.id,
        status: "ACTIVE",
        validFrom: { lte: input.validTo },
        validTo: { gte: input.validFrom },
      },
      select: { id: true },
    });
    if (overlapping) {
      throw new RuleViolationError(
        `${delegator.name} already has a live delegation to ${delegate.name} overlapping that period. Revoke it first — two live grants for the same pair cannot be reconciled after the fact.`,
      );
    }

    const row = await tx.delegation.create({
      data: {
        delegatorId: delegator.id,
        delegateId: delegate.id,
        entityId: input.entityId ?? null,
        permissions: JSON.stringify(input.permissions),
        documentTypes: JSON.stringify(input.documentTypes ?? []),
        valueLimit: input.valueLimit ?? null,
        validFrom: input.validFrom,
        validTo: input.validTo,
        reason: input.reason.trim(),
        status: input.validFrom > new Date() ? "PENDING" : "ACTIVE",
        recordedById: user.id,
      },
    });

    await writeAudit(
      {
        entityType: "Delegation",
        entityId: row.id,
        entityRef: `${delegator.name} → ${delegate.name}`,
        action: "DELEGATION_CREATED",
        newValue: {
          permissions: input.permissions,
          from: input.validFrom,
          to: input.validTo,
          valueLimit: input.valueLimit ?? null,
          recordedBy: user.name,
        },
        reason: input.reason.trim(),
        actor: user,
      },
      tx,
    );

    // Both parties are told. A delegation the delegate does not know about is
    // authority they will not use, and one the delegator does not know about is
    // authority they did not lend.
    await notify(
      {
        userIds: [delegate.id, delegator.id],
        type: "GENERAL",
        priority: "NORMAL",
        title: `${delegator.name} has delegated authority to ${delegate.name}`,
        body:
          `${input.permissions.length} permission(s) until ${input.validTo.toISOString().slice(0, 10)}. ` +
          input.reason.trim(),
        linkType: "DELEGATION",
        linkUrl: "/admin/delegations",
      },
      tx,
    );
    return row;
  });
}

/** Ends a delegation early. */
export async function revokeDelegation(
  user: SessionUser,
  input: { delegationId: string; reason: string },
  db: DbClient = prisma,
) {
  if (!input.reason?.trim()) {
    throw new ValidationError("State why the delegation is being revoked.");
  }
  const d = await db.delegation.findUnique({
    where: { id: input.delegationId },
    include: {
      delegator: { select: { id: true, name: true } },
      delegate: { select: { id: true, name: true } },
    },
  });
  if (!d) throw new NotFoundError("Delegation");
  if (d.status === "REVOKED") throw new RuleViolationError("Already revoked.");

  // The delegator can always take back their own authority. Anybody else needs
  // administrative authority — a delegate revoking their own grant would let
  // them close the record of what they were given.
  const isDelegator = d.delegatorId === user.id;
  if (!isDelegator && !userHasPermission(user, P.USER_MANAGE, P.ROLE_MANAGE)) {
    throw new RuleViolationError(
      "Only the person whose authority it is, or a user administrator, can revoke a delegation.",
    );
  }

  const row = await db.delegation.update({
    where: { id: d.id },
    data: {
      status: "REVOKED",
      revokedById: user.id,
      revokedAt: new Date(),
      revokeReason: input.reason.trim(),
    },
  });
  await writeAudit(
    {
      entityType: "Delegation",
      entityId: d.id,
      entityRef: `${d.delegator.name} → ${d.delegate.name}`,
      action: "DELEGATION_REVOKED",
      reason: input.reason.trim(),
      actor: user,
    },
    db,
  );
  await notify(
    {
      userIds: [d.delegateId, d.delegatorId],
      type: "GENERAL",
      title: `Delegation from ${d.delegator.name} to ${d.delegate.name} revoked`,
      body: input.reason.trim(),
      linkType: "DELEGATION",
      linkUrl: "/admin/delegations",
    },
    db,
  );
  return row;
}

/**
 * The delegations a person may act under right now.
 *
 * Returned separately from their own permissions, deliberately. A caller has to
 * decide to use delegated authority and can then record that it did — a
 * delegation that merged silently into `user.permissions` would be exactly the
 * invisible role grant this exists to replace.
 */
export async function activeDelegationsFor(
  userId: string,
  at: Date = new Date(),
  db: DbClient = prisma,
): Promise<DelegationGrant[]> {
  const rows = await db.delegation.findMany({
    where: {
      delegateId: userId,
      status: { in: ["ACTIVE", "PENDING"] },
      validFrom: { lte: at },
      validTo: { gte: at },
    },
    include: { delegator: { select: { id: true, name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    delegatorId: r.delegatorId,
    delegatorName: r.delegator.name,
    permissions: parseList(r.permissions),
    documentTypes: parseList(r.documentTypes),
    valueLimit: r.valueLimit,
    validFrom: r.validFrom,
    validTo: r.validTo,
    reason: r.reason,
  }));
}

export type DelegatedAuthority = {
  /** The grant that covers the action, or null when none does. */
  grant: DelegationGrant | null;
  reason: string | null;
};

/**
 * Whether a delegation lets this person do this thing, right now.
 *
 * Scope is checked in three dimensions and all three must hold: the permission,
 * the document type where the grant narrows to some, and the value where the
 * grant sets a ceiling. A grant that covered the permission but not the value
 * would let a delegate approve something their delegator could not.
 */
export async function delegatedAuthorityFor(
  userId: string,
  need: { permission: string; documentType?: string; value?: number },
  db: DbClient = prisma,
): Promise<DelegatedAuthority> {
  const grants = await activeDelegationsFor(userId, new Date(), db);
  if (!grants.length) return { grant: null, reason: "No delegation is in force for you." };

  for (const g of grants) {
    if (!g.permissions.includes(need.permission)) continue;
    if (need.documentType && g.documentTypes.length && !g.documentTypes.includes(need.documentType)) {
      continue;
    }
    if (need.value != null && g.valueLimit != null && need.value > g.valueLimit) continue;
    return { grant: g, reason: null };
  }

  const closest = grants.find((g) => g.permissions.includes(need.permission));
  if (closest) {
    return {
      grant: null,
      reason:
        closest.valueLimit != null && need.value != null && need.value > closest.valueLimit
          ? `${closest.delegatorName}'s delegation is limited to ${closest.valueLimit.toLocaleString("en-PK")}.`
          : `${closest.delegatorName}'s delegation does not cover ${need.documentType ?? "this document type"}.`,
    };
  }
  return { grant: null, reason: "No delegation in force covers that authority." };
}

/**
 * Records that an act was taken under a delegation.
 *
 * Called after the act, by the caller that used the grant. Both names end up on
 * the record: the delegate acted, and the delegator's authority was what allowed
 * it.
 */
export async function recordDelegationUse(
  user: SessionUser,
  input: {
    delegationId: string;
    action: string;
    documentType: string;
    documentId: string;
    documentRef?: string | null;
  },
  db: DbClient = prisma,
) {
  const d = await db.delegation.findUnique({
    where: { id: input.delegationId },
    include: { delegator: { select: { name: true } } },
  });
  if (!d) throw new NotFoundError("Delegation");

  const row = await db.delegationUse.create({
    data: {
      delegationId: d.id,
      action: input.action,
      documentType: input.documentType,
      documentId: input.documentId,
      documentRef: input.documentRef ?? null,
      usedById: user.id,
    },
  });
  await writeAudit(
    {
      entityType: input.documentType,
      entityId: input.documentId,
      entityRef: input.documentRef ?? null,
      action: "ACTED_UNDER_DELEGATION",
      newValue: {
        act: input.action,
        by: user.name,
        underAuthorityOf: d.delegator.name,
        delegationId: d.id,
      },
      actor: user,
    },
    db,
  );
  return row;
}

/**
 * Closes delegations whose period has ended, and opens those whose has begun.
 *
 * Run as a job. Expiry is a fact about dates, so it is not left to somebody
 * remembering — an expired delegation that still reads as active is authority
 * nobody granted.
 */
export async function sweepDelegations(
  actor: Actor,
  db: DbClient = prisma,
): Promise<{ activated: number; expired: number }> {
  assertAuthority(actor, DOMAIN_ACTIONS.DELEGATION_SWEEP, {
    permission: [P.USER_MANAGE, P.ROLE_MANAGE, P.AUDIT_VIEW],
  });

  const now = new Date();
  const toActivate = await db.delegation.findMany({
    where: { status: "PENDING", validFrom: { lte: now }, validTo: { gte: now } },
    select: { id: true },
  });
  for (const d of toActivate) {
    await db.delegation.update({ where: { id: d.id }, data: { status: "ACTIVE" } });
  }

  const toExpire = await db.delegation.findMany({
    where: { status: { in: ["ACTIVE", "PENDING"] }, validTo: { lt: now } },
    include: {
      delegator: { select: { name: true } },
      delegate: { select: { name: true } },
    },
  });
  for (const d of toExpire) {
    await db.delegation.update({ where: { id: d.id }, data: { status: "EXPIRED" } });
    await writeAudit(
      {
        entityType: "Delegation",
        entityId: d.id,
        entityRef: `${d.delegator.name} → ${d.delegate.name}`,
        action: "DELEGATION_EXPIRED",
        newValue: { validTo: d.validTo },
        actor,
      },
      db,
    );
  }

  return { activated: toActivate.length, expired: toExpire.length };
}

export async function listDelegations(
  filter: { userId?: string | null; status?: string | null } = {},
  db: DbClient = prisma,
) {
  const rows = await db.delegation.findMany({
    where: {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.userId
        ? { OR: [{ delegatorId: filter.userId }, { delegateId: filter.userId }] }
        : {}),
    },
    include: {
      delegator: { select: { id: true, name: true, title: true } },
      delegate: { select: { id: true, name: true, title: true } },
      recordedBy: { select: { name: true } },
      revokedBy: { select: { name: true } },
      _count: { select: { uses: true } },
    },
    orderBy: [{ validTo: "desc" }],
    take: 300,
  });
  return rows.map((r) => ({
    ...r,
    permissionCodes: parseList(r.permissions),
    documentTypeList: parseList(r.documentTypes),
  }));
}
