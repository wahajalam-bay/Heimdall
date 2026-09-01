import { prisma, type DbClient } from "@/lib/db";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { notify, usersForRoles } from "@/lib/notify";

/**
 * Policy acknowledgement, tied to the exact version.
 *
 * The meeting requirements ask for acknowledgement "tied to the exact version",
 * and that qualifier is the whole point. An acknowledgement of "the procurement
 * policy" says nothing the moment the policy changes: everybody's signature
 * silently becomes a signature on a document they never read, and the register
 * looks complete while meaning nothing.
 *
 * So what somebody signs is a **code plus a version**. Publishing a new version
 * does not carry acknowledgements forward — the register goes back to zero for
 * that policy, which is uncomfortable and correct.
 *
 * ## Two more decisions
 *
 * **A version says what changed.** An acknowledgement of a version with no change
 * note is a click. `changeNote` is what makes the second signature mean something
 * different from the first.
 *
 * **Who must sign is a role list, not a person list.** People join and leave; the
 * obligation attaches to the office. An empty list means everybody, which is the
 * common case for a procurement policy.
 */

export type AckStanding = {
  policyId: string;
  code: string;
  version: string;
  title: string;
  effectiveFrom: Date;
  requiredRoleCodes: string[];
  /** People who have to sign it. */
  required: number;
  acknowledged: number;
  outstanding: Array<{ id: string; name: string; title: string | null }>;
  /** Whether the reader has signed this version. */
  mine: boolean;
};

function parseList(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Publishes a version of a policy. */
export async function publishPolicy(
  user: SessionUser,
  input: {
    code: string;
    version: string;
    title: string;
    summary?: string | null;
    changeNote?: string | null;
    effectiveFrom: Date;
    requiredRoleCodes?: string[];
    entityId?: string | null;
    documentId?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.CONFIG_MANAGE, P.ROLE_MANAGE)) {
    throw new RuleViolationError("Publishing a policy version needs configuration authority.");
  }
  if (!input.code?.trim() || !input.version?.trim()) {
    throw new ValidationError("A policy needs a code and a version. The version is what people sign.");
  }
  if (!input.title?.trim()) throw new ValidationError("Give the policy a title.");

  const existing = await db.policyDocument.findFirst({
    where: {
      code: input.code.trim(),
      version: input.version.trim(),
      entityId: input.entityId ?? null,
    },
    select: { id: true },
  });
  if (existing) {
    throw new RuleViolationError(
      `${input.code.trim()} version ${input.version.trim()} already exists. Publish a new version rather than editing a signed one — an acknowledgement has to point at fixed text or it means nothing.`,
    );
  }

  // Earlier versions stop being current. Their acknowledgements are kept: what
  // somebody signed in March is still what they signed, and carrying it forward
  // to April's text would be forging it.
  const priors = await db.policyDocument.findMany({
    where: { code: input.code.trim(), entityId: input.entityId ?? null, active: true },
    select: { id: true },
  });
  for (const prior of priors) {
    await db.policyDocument.update({
      where: { id: prior.id },
      // SUPERSEDED rather than merely inactive, so the review register can ask
      // for the published version without inferring it from dates.
      data: { active: false, status: "SUPERSEDED", effectiveTo: input.effectiveFrom },
    });
  }

  const row = await db.policyDocument.create({
    data: {
      code: input.code.trim(),
      version: input.version.trim(),
      title: input.title.trim(),
      summary: input.summary?.trim() || null,
      changeNote: input.changeNote?.trim() || null,
      entityId: input.entityId ?? null,
      documentId: input.documentId ?? null,
      effectiveFrom: input.effectiveFrom,
      requiredRoleCodes: JSON.stringify(input.requiredRoleCodes ?? []),
      active: true,
      status: "PUBLISHED",
      publishedAt: new Date(),
      createdById: user.id,
    },
  });

  await writeAudit(
    {
      entityType: "PolicyDocument",
      entityId: row.id,
      entityRef: `${row.code} v${row.version}`,
      action: "POLICY_PUBLISHED",
      newValue: {
        supersededVersions: priors.length,
        requiredRoles: input.requiredRoleCodes ?? [],
      },
      reason: input.changeNote?.trim() ?? null,
      actor: user,
    },
    db,
  );

  // Everybody who has to sign is told, because a policy nobody knows about is a
  // policy nobody acknowledges.
  const roles = input.requiredRoleCodes ?? [];
  const userIds = roles.length
    ? await usersForRoles(roles, input.entityId ?? null, db)
    : (await db.user.findMany({ where: { active: true }, select: { id: true } })).map((u) => u.id);
  await notify(
    {
      userIds,
      type: "GENERAL",
      priority: "NORMAL",
      title: `${row.title} version ${row.version} needs your acknowledgement`,
      body: input.changeNote?.trim() ?? input.summary?.trim() ?? "A new version has been published.",
      linkType: "POLICY",
      linkUrl: "/policies",
    },
    db,
  );
  return row;
}

/**
 * Records somebody's acknowledgement of one version.
 *
 * Their own, and nobody else's. An acknowledgement entered on somebody's behalf
 * is not an acknowledgement — it is an administrator asserting that a person read
 * something, which is the one thing this register exists to avoid.
 */
export async function acknowledgePolicy(
  user: SessionUser,
  input: { policyId: string; ip?: string | null; userAgent?: string | null },
  db: DbClient = prisma,
) {
  const policy = await db.policyDocument.findUnique({
    where: { id: input.policyId },
    select: { id: true, code: true, version: true, title: true, active: true },
  });
  if (!policy) throw new NotFoundError("Policy");
  if (!policy.active) {
    throw new RuleViolationError(
      `${policy.code} version ${policy.version} has been superseded. Acknowledge the current version instead.`,
    );
  }

  const existing = await db.policyAcknowledgement.findFirst({
    where: { policyId: policy.id, userId: user.id },
    select: { id: true },
  });
  if (existing) {
    throw new RuleViolationError(`You have already acknowledged ${policy.code} version ${policy.version}.`);
  }

  const row = await db.policyAcknowledgement.create({
    data: {
      policyId: policy.id,
      userId: user.id,
      // The office held at the moment of signing, captured rather than joined:
      // an acknowledgement is a statement by a person in a role at a moment.
      roleAtAcknowledgement: user.roleNames.join(", ") || null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
  await writeAudit(
    {
      entityType: "PolicyDocument",
      entityId: policy.id,
      entityRef: `${policy.code} v${policy.version}`,
      action: "POLICY_ACKNOWLEDGED",
      newValue: { by: user.name, roleAtSigning: user.roleNames.join(", ") },
      actor: user,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
    db,
  );
  return row;
}

/**
 * Who has signed what, and who has not.
 *
 * The outstanding list is the point. A register that only shows signatures
 * cannot tell you who is missing, and who is missing is the only question worth
 * asking of it.
 */
export async function acknowledgementStanding(
  forUserId: string,
  entityId: string | null = null,
  db: DbClient = prisma,
): Promise<AckStanding[]> {
  const policies = await db.policyDocument.findMany({
    where: {
      active: true,
      effectiveFrom: { lte: new Date() },
      ...(entityId ? { OR: [{ entityId }, { entityId: null }] } : {}),
    },
    include: {
      acknowledgements: { select: { userId: true } },
    },
    orderBy: [{ code: "asc" }],
  });
  if (!policies.length) return [];

  const out: AckStanding[] = [];
  for (const p of policies) {
    const roles = parseList(p.requiredRoleCodes);
    const requiredIds = roles.length
      ? await usersForRoles(roles, p.entityId, db)
      : (await db.user.findMany({ where: { active: true }, select: { id: true } })).map((u) => u.id);

    const signed = new Set(p.acknowledgements.map((a) => a.userId));
    const missingIds = requiredIds.filter((id) => !signed.has(id));
    const missing = missingIds.length
      ? await db.user.findMany({
          where: { id: { in: missingIds } },
          select: { id: true, name: true, title: true },
          orderBy: { name: "asc" },
          take: 200,
        })
      : [];

    out.push({
      policyId: p.id,
      code: p.code,
      version: p.version,
      title: p.title,
      effectiveFrom: p.effectiveFrom,
      requiredRoleCodes: roles,
      required: requiredIds.length,
      acknowledged: requiredIds.filter((id) => signed.has(id)).length,
      outstanding: missing,
      mine: signed.has(forUserId),
    });
  }
  return out;
}

/** Everything a reader still has to sign. */
export async function myOutstandingPolicies(
  userId: string,
  entityId: string | null = null,
  db: DbClient = prisma,
) {
  const standing = await acknowledgementStanding(userId, entityId, db);
  return standing.filter((s) => !s.mine && s.outstanding.some((o) => o.id === userId));
}

export async function policyDetail(id: string, db: DbClient = prisma) {
  return db.policyDocument.findUnique({
    where: { id },
    include: {
      createdBy: { select: { name: true } },
      acknowledgements: {
        include: { user: { select: { name: true, title: true } } },
        orderBy: { acknowledgedAt: "desc" },
      },
    },
  });
}
