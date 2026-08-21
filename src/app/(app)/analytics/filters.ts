import "server-only";
import { prisma } from "@/lib/db";
import { first, type SearchParams } from "@/lib/page";
import { userHasPermission, visibleEntityIds, type SessionUser } from "@/lib/rbac";
import { PERMISSIONS as P } from "@/lib/permissions";
import type { AnalyticsFilter } from "@/server/analytics";

/**
 * Turns query-string filters into an AnalyticsFilter, always intersected with
 * the entities the caller may actually read. A filter can narrow the scope but
 * never widen it.
 */
export function buildFilter(user: SessionUser, sp: SearchParams, fallbackEntityId: string | null): AnalyticsFilter {
  const scoped = visibleEntityIds(user);
  const requested = first(sp.entity) ?? null;
  const canSeeAll = userHasPermission(user, P.ANALYTICS_VIEW_ALL_ENTITIES);

  // A requested entity narrows the scope; anything outside the readable set is ignored.
  const entityId =
    requested && (!scoped || scoped.includes(requested))
      ? requested
      : !canSeeAll && fallbackEntityId && (!scoped || scoped.includes(fallbackEntityId))
        ? fallbackEntityId
        : null;

  const fromRaw = first(sp.from);
  const toRaw = first(sp.to);
  const from = fromRaw ? new Date(fromRaw) : null;
  const to = toRaw ? new Date(toRaw) : null;

  return {
    entityId,
    entityIds: entityId ? null : scoped,
    departmentId: first(sp.department) ?? null,
    categoryId: first(sp.category) ?? null,
    vendorId: first(sp.vendor) ?? null,
    projectId: first(sp.project) ?? null,
    from: from && !Number.isNaN(from.getTime()) ? from : null,
    to: to && !Number.isNaN(to.getTime()) ? to : null,
  };
}

/** Option lists for the filter row, scoped to what the caller can read. */
export async function filterOptions(user: SessionUser) {
  const scoped = visibleEntityIds(user);
  const [entities, departments, categories, vendors, projects] = await Promise.all([
    prisma.entity.findMany({
      where: { active: true, ...(scoped ? { id: { in: scoped } } : {}) },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    prisma.department.findMany({
      where: { active: true, ...(scoped ? { entityId: { in: scoped } } : {}) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.category.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.vendor.findMany({
      where: { status: { in: ["APPROVED", "CONDITIONAL", "SUSPENDED", "BLACKLISTED"] } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.project.findMany({
      where: { status: "Active", ...(scoped ? { entityId: { in: scoped } } : {}) },
      select: { id: true, code: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return {
    entities: entities.map((e) => ({ value: e.id, label: `${e.code} — ${e.name}` })),
    departments: departments.map((d) => ({ value: d.id, label: d.name })),
    categories: categories.map((c) => ({ value: c.id, label: c.name })),
    vendors: vendors.map((v) => ({ value: v.id, label: v.name })),
    projects: projects.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })),
  };
}

/** Human description of the period in force, for page subtitles. */
export function periodLabel(f: AnalyticsFilter): string {
  const fmt = (d: Date) => d.toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" });
  if (f.from && f.to) return `${fmt(f.from)} to ${fmt(f.to)}`;
  if (f.from) return `since ${fmt(f.from)}`;
  if (f.to) return `up to ${fmt(f.to)}`;
  return "all time";
}
