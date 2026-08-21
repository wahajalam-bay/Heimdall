import "server-only";
import { cookies } from "next/headers";
import { prisma } from "./db";
import { type SessionUser, canAccessEntity, visibleEntityIds } from "./auth";

export const ENTITY_COOKIE = "pos_entity";

export type AppContext = {
  user: SessionUser;
  /** Currently selected entity, or null for "all entities I can see". */
  entityId: string | null;
  entityCode: string | null;
  entityName: string | null;
  entities: Array<{ id: string; code: string; name: string }>;
  /** Prisma `where` fragment scoping a query to the readable entity set. */
  entityFilter: { entityId?: string | { in: string[] } };
};

/**
 * Resolves the active entity from the cookie, falling back to the user's
 * primary entity. Access is re-verified on every request — the cookie is a
 * preference, never an authorization.
 */
export async function getAppContext(user: SessionUser): Promise<AppContext> {
  const scoped = visibleEntityIds(user);
  const entities = await prisma.entity.findMany({
    where: { active: true, ...(scoped ? { id: { in: scoped } } : {}) },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });

  const jar = await cookies();
  const cookieEntity = jar.get(ENTITY_COOKIE)?.value ?? null;

  let entityId: string | null = null;
  if (cookieEntity && cookieEntity !== "__all" && canAccessEntity(user, cookieEntity)) {
    entityId = entities.some((e) => e.id === cookieEntity) ? cookieEntity : null;
  }
  if (!entityId && cookieEntity !== "__all") {
    entityId =
      user.primaryEntityId && entities.some((e) => e.id === user.primaryEntityId)
        ? user.primaryEntityId
        : (entities[0]?.id ?? null);
  }

  const active = entities.find((e) => e.id === entityId) ?? null;

  const entityFilter: AppContext["entityFilter"] = entityId
    ? { entityId }
    : scoped
      ? { entityId: { in: scoped } }
      : {};

  return {
    user,
    entityId,
    entityCode: active?.code ?? null,
    entityName: active?.name ?? null,
    entities,
    entityFilter,
  };
}

/** Entity scope for analytics that should span every readable entity. */
export function allEntityFilter(user: SessionUser): { entityId?: { in: string[] } } {
  const scoped = visibleEntityIds(user);
  return scoped ? { entityId: { in: scoped } } : {};
}
