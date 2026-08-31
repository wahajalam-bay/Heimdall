import { prisma } from "@/lib/db";
import type { SessionUser } from "@/lib/rbac";

/**
 * Builds the SessionUser the service layer expects, resolved from real role and
 * permission rows — so a test exercising authorisation is exercising the same
 * data the running application reads.
 */
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
  const perms = new Set<string>();
  for (const ur of u.roles) for (const rp of ur.role.permissions) perms.add(rp.permission.code);
  const eids = new Set(u.entityAccess.map((e) => e.entityId));
  if (u.primaryEntityId) eids.add(u.primaryEntityId);
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
    permissions: [...perms],
    entityIds: [...eids],
  };
}

/** A session with the given permissions stripped, for negative authorisation tests. */
export function without(user: SessionUser, ...permissions: string[]): SessionUser {
  return { ...user, permissions: user.permissions.filter((p) => !permissions.includes(p)) };
}

/** A session holding only the given permissions. */
export function only(user: SessionUser, ...permissions: string[]): SessionUser {
  return { ...user, permissions: [...permissions] };
}

/** Well-known seeded accounts, by the part they play in the workflow. */
export const ACTORS = {
  admin: "system.admin@zameen.com",
} as const;

/**
 * The permission map for every active account, read once.
 *
 * Resolving it per call meant loading every user with their roles and each
 * role's permissions on every lookup. An authorisation suite makes hundreds of
 * lookups, and at that point the tests are slow enough not to be run — which is
 * a worse outcome than any single assertion.
 */
let permissionMap: Promise<Array<{ email: string; permissions: Set<string> }>> | null = null;

function allUserPermissions() {
  permissionMap ??= prisma.user
    .findMany({
      where: { active: true },
      select: {
        email: true,
        roles: { select: { role: { select: { permissions: { select: { permission: { select: { code: true } } } } } } } },
      },
    })
    .then((users) =>
      users.map((u) => ({
        email: u.email,
        permissions: new Set(u.roles.flatMap((ur) => ur.role.permissions.map((rp) => rp.permission.code))),
      })),
    );
  return permissionMap;
}

const sessionCache = new Map<string, Promise<SessionUser>>();

/** `sessionFor`, memoised. Sessions are immutable, so re-reading them is waste. */
function cachedSession(email: string): Promise<SessionUser> {
  let s = sessionCache.get(email);
  if (!s) {
    s = sessionFor(email);
    sessionCache.set(email, s);
  }
  return s;
}

/** Resolves a seeded user holding a permission, so tests do not hard-code names. */
export async function userWithPermission(code: string, exclude: string[] = []): Promise<SessionUser> {
  const users = await allUserPermissions();
  const match = users.find((u) => !exclude.includes(u.email) && u.permissions.has(code));
  if (!match) throw new Error(`No seeded user holds the "${code}" permission.`);
  return cachedSession(match.email);
}

/** Resolves a seeded user holding none of the given permissions. */
export async function userWithoutPermission(...codes: string[]): Promise<SessionUser> {
  const users = await allUserPermissions();
  const match = users.find((u) => !codes.some((c) => u.permissions.has(c)));
  if (!match) throw new Error(`Every seeded user holds one of: ${codes.join(", ")}.`);
  return cachedSession(match.email);
}

/** Asserts a promise rejects, and returns the error for further inspection. */
export async function expectRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new Error("Expected the operation to be refused, but it succeeded.");
}

export const uniqueSuffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();
