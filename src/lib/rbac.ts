import { ForbiddenError } from "./errors";
import { PERMISSIONS } from "./permissions";

/**
 * Pure authorization primitives.
 *
 * Deliberately free of request-scoped APIs (cookies, headers) so the same
 * checks run in server components, server actions, background sweeps, the
 * seeder and the test suite.
 */

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  title: string | null;
  primaryEntityId: string | null;
  primaryDepartmentId: string | null;
  primaryEntityCode: string | null;
  primaryEntityName: string | null;
  primaryDepartmentName: string | null;
  roleCodes: string[];
  roleNames: string[];
  permissions: string[];
  entityIds: string[];
};

export function userHasPermission(user: SessionUser, ...codes: string[]): boolean {
  return codes.some((c) => user.permissions.includes(c));
}

export function userHasAllPermissions(user: SessionUser, ...codes: string[]): boolean {
  return codes.every((c) => user.permissions.includes(c));
}

export function assertPermission(user: SessionUser, ...codes: string[]) {
  if (!userHasPermission(user, ...codes)) {
    throw new ForbiddenError(
      `Missing required permission: ${codes.join(" or ")}. Your roles: ${user.roleNames.join(", ") || "none"}.`,
    );
  }
}

/** Cross-entity readers (analytics-wide roles, system admin) bypass entity scoping. */
export function canAccessEntity(user: SessionUser, entityId: string | null | undefined): boolean {
  if (!entityId) return true;
  if (user.permissions.includes(PERMISSIONS.ANALYTICS_VIEW_ALL_ENTITIES)) return true;
  return user.entityIds.includes(entityId);
}

export function assertEntityAccess(user: SessionUser, entityId: string | null | undefined) {
  if (!canAccessEntity(user, entityId)) {
    throw new ForbiddenError("You do not have access to this entity's records.");
  }
}

/** Entity ids a user may read; null means "no restriction". */
export function visibleEntityIds(user: SessionUser): string[] | null {
  if (user.permissions.includes(PERMISSIONS.ANALYTICS_VIEW_ALL_ENTITIES)) return null;
  return user.entityIds;
}

/**
 * Where-fragment scoping a table whose `entityId` is nullable.
 *
 * Exceptions and alerts are raised either against a document, which belongs to
 * an entity, or against the system as a whole, which belongs to none. A null
 * entity is therefore visible to everyone, while a set one is visible only
 * inside the reader's entities. This is written once because a home page and a
 * register that disagree about it leak one entity's document references into
 * another entity's view — and report two different totals for the same word.
 */
export function nullableEntityScope(
  entityId: string | null | undefined,
  entityIds: string[] | null | undefined,
): { entityId?: string; OR?: Array<{ entityId: { in: string[] } | null }> } {
  if (entityId) return { entityId };
  if (entityIds) return { OR: [{ entityId: { in: entityIds } }, { entityId: null }] };
  return {};
}
