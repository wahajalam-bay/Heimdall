import "server-only";
import { cookies, headers } from "next/headers";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "./db";
import { UnauthorizedError } from "./errors";
import {
  assertEntityAccess,
  assertPermission,
  canAccessEntity,
  userHasAllPermissions,
  userHasPermission,
  visibleEntityIds,
  type SessionUser,
} from "./rbac";

export {
  assertEntityAccess,
  assertPermission,
  canAccessEntity,
  userHasAllPermissions,
  userHasPermission,
  visibleEntityIds,
};
export type { SessionUser };

export const SESSION_COOKIE = "procurementos_session";
const SESSION_TTL_HOURS = 12;


// ── Password hashing ─────────────────────────────────────────

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ── Login throttling (in-process; adequate for a single-node deployment) ──

type Attempt = { count: number; firstAt: number; lockedUntil?: number };
const attempts = new Map<string, Attempt>();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;

export function checkRateLimit(key: string): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a) return { allowed: true };
  if (a.lockedUntil && a.lockedUntil > now) {
    return { allowed: false, retryAfterSec: Math.ceil((a.lockedUntil - now) / 1000) };
  }
  if (now - a.firstAt > WINDOW_MS) {
    attempts.delete(key);
    return { allowed: true };
  }
  return { allowed: true };
}

export function recordFailure(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || now - a.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now });
    return;
  }
  a.count += 1;
  if (a.count >= MAX_ATTEMPTS) a.lockedUntil = now + LOCK_MS;
}

export function clearFailures(key: string) {
  attempts.delete(key);
}

// ── Session lifecycle ────────────────────────────────────────

function newToken() {
  return randomBytes(32).toString("base64url");
}

/** Stored digest, so a leaked DB row cannot be replayed as a cookie. */
function digest(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string, ip?: string, userAgent?: string) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
  await prisma.session.create({
    data: { token: digest(token), userId, ip, userAgent, expiresAt },
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
  return token;
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { token: digest(token) } });
  }
  jar.delete(SESSION_COOKIE);
}

export function constantTimeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

let cachedRolePerms: Map<string, string[]> | null = null;

/** Called after RBAC edits so the next request re-reads grants. */
export function invalidatePermissionCache() {
  cachedRolePerms = null;
}

async function loadUser(userId: string): Promise<SessionUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
      entityAccess: true,
      primaryEntity: true,
      primaryDepartment: true,
    },
  });
  if (!user || !user.active) return null;

  const permissions = new Set<string>();
  for (const ur of user.roles) {
    for (const rp of ur.role.permissions) permissions.add(rp.permission.code);
  }
  const entityIds = new Set(user.entityAccess.map((e) => e.entityId));
  if (user.primaryEntityId) entityIds.add(user.primaryEntityId);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    title: user.title,
    primaryEntityId: user.primaryEntityId,
    primaryDepartmentId: user.primaryDepartmentId,
    primaryEntityCode: user.primaryEntity?.code ?? null,
    primaryEntityName: user.primaryEntity?.name ?? null,
    primaryDepartmentName: user.primaryDepartment?.name ?? null,
    roleCodes: user.roles.map((r) => r.role.code),
    roleNames: user.roles.map((r) => r.role.name),
    permissions: [...permissions],
    entityIds: [...entityIds],
  };
}

/** Resolves the signed-in user, or null. Never throws. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { token: digest(token) } });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return loadUser(session.userId);
}

/** Resolves the signed-in user or throws UnauthorizedError. */
export async function requireUser(): Promise<SessionUser> {
  const u = await getSessionUser();
  if (!u) throw new UnauthorizedError();
  return u;
}

/**
 * Primary server-side authorization guard for request handlers.
 * Passing multiple codes means "any of these is sufficient".
 */
export async function requirePermission(...codes: string[]): Promise<SessionUser> {
  const user = await requireUser();
  assertPermission(user, ...codes);
  return user;
}

export async function requestContext() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null,
    userAgent: h.get("user-agent") ?? null,
  };
}
