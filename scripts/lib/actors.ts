/**
 * Session resolution for the verification and population scripts.
 *
 * Every actor is built from real role and permission rows, so a script driving
 * the service layer is subject to exactly the authorisation the running
 * application enforces.
 */
import { prisma } from "../../src/lib/db";
import type { SessionUser } from "../../src/lib/rbac";
import { getPendingApproval } from "../../src/lib/approvals";

export async function sessionFor(email: string): Promise<SessionUser> {
  const u = await prisma.user.findUniqueOrThrow({
    where: { email },
    include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
      entityAccess: true,
      primaryEntity: true,
      primaryDepartment: true,
    },
  });
  const permissions = new Set<string>();
  for (const ur of u.roles) for (const rp of ur.role.permissions) permissions.add(rp.permission.code);
  const entityIds = new Set(u.entityAccess.map((e) => e.entityId));
  if (u.primaryEntityId) entityIds.add(u.primaryEntityId);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    title: u.title,
    primaryEntityId: u.primaryEntityId,
    primaryDepartmentId: u.primaryDepartmentId,
    primaryEntityCode: u.primaryEntity?.code ?? null,
    primaryEntityName: u.primaryEntity?.name ?? null,
    primaryDepartmentName: u.primaryDepartment?.name ?? null,
    roleCodes: u.roles.map((r) => r.role.code),
    roleNames: u.roles.map((r) => r.role.name),
    permissions: [...permissions],
    entityIds: [...entityIds],
  };
}

/** The first active user holding a permission, optionally scoped to an entity. */
export async function withPermission(code: string, entityId?: string): Promise<SessionUser> {
  const users = await prisma.user.findMany({
    where: {
      active: true,
      roles: { some: { role: { permissions: { some: { permission: { code } } } } } },
      ...(entityId ? { OR: [{ primaryEntityId: entityId }, { entityAccess: { some: { entityId } } }] } : {}),
    },
    select: { email: true },
    orderBy: { email: "asc" },
  });
  if (!users.length) throw new Error(`No active user holds "${code}"${entityId ? " for that entity" : ""}.`);
  return sessionFor(users[0].email);
}

/** The first active user holding every one of the given permissions. */
export async function withPermissions(codes: string[], entityId?: string): Promise<SessionUser> {
  const candidates = await prisma.user.findMany({
    where: {
      active: true,
      ...(entityId ? { OR: [{ primaryEntityId: entityId }, { entityAccess: { some: { entityId } } }] } : {}),
    },
    include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
    orderBy: { email: "asc" },
  });
  for (const u of candidates) {
    const held = new Set<string>();
    for (const ur of u.roles) for (const rp of ur.role.permissions) held.add(rp.permission.code);
    if (codes.every((c) => held.has(c))) return sessionFor(u.email);
  }
  throw new Error(`No active user holds all of: ${codes.join(", ")}${entityId ? " for that entity" : ""}.`);
}

/** The first active user holding none of the given permissions. */
export async function withoutPermissions(...codes: string[]): Promise<SessionUser> {
  const user = await prisma.user.findFirst({
    where: {
      active: true,
      roles: { every: { role: { permissions: { none: { permission: { code: { in: codes } } } } } } },
    },
    select: { email: true },
    orderBy: { email: "asc" },
  });
  if (!user) throw new Error(`Every active user holds one of: ${codes.join(", ")}.`);
  return sessionFor(user.email);
}

/** A user able to action the approval step currently pending on a document. */
export async function currentApprover(
  docType: string,
  docId: string,
  entityId: string,
): Promise<SessionUser | null> {
  const instance = await getPendingApproval(docType, docId, prisma);
  if (!instance) return null;
  const current = instance.actions.find((a) => a.sequence === instance.currentSequence && a.action === "PENDING");
  if (!current) return null;
  if (!current.assignedRoleCode) {
    throw new Error(`Pending step "${current.stepName}" has no assignee to resolve.`);
  }

  const scoped = await prisma.user.findFirst({
    where: {
      active: true,
      roles: { some: { role: { code: current.assignedRoleCode } } },
      OR: [{ primaryEntityId: entityId }, { entityAccess: { some: { entityId } } }],
    },
    select: { email: true },
  });
  // Some approval roles (audit, committee) are deliberately entity-agnostic.
  const holder =
    scoped ??
    (await prisma.user.findFirst({
      where: { active: true, roles: { some: { role: { code: current.assignedRoleCode } } } },
      select: { email: true },
    }));
  if (!holder) throw new Error(`No active user holds the ${current.assignedRoleCode} role.`);
  return sessionFor(holder.email);
}

/** Walks an approval chain to completion using whichever role each step needs. */
export async function walkApprovals(
  docType: string,
  docId: string,
  entityId: string,
  decide: (approver: SessionUser) => Promise<unknown>,
  maxSteps = 8,
): Promise<number> {
  let steps = 0;
  while (steps < maxSteps) {
    const approver = await currentApprover(docType, docId, entityId);
    if (!approver) break;
    await decide(approver);
    steps += 1;
  }
  return steps;
}

/** Runs an operation expected to be refused, returning the refusal message. */
export async function refused(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
