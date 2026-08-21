import "server-only";
import { redirect } from "next/navigation";
import { getSessionUser } from "./auth";
import { userHasPermission, type SessionUser } from "./rbac";
import { getAppContext, type AppContext } from "./context";

/**
 * Standard page preamble: resolves the session, redirects anonymous callers to
 * sign-in, and reports whether the caller holds any of the required
 * permissions. Pages render an explicit unauthorized state rather than 404ing,
 * so users understand why they cannot see something.
 */
export async function pageContext(
  ...perms: string[]
): Promise<{ user: SessionUser; ctx: AppContext; authorized: boolean }> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const ctx = await getAppContext(user);
  const authorized = perms.length === 0 || userHasPermission(user, ...perms);
  return { user, ctx, authorized };
}

export type SearchParams = Record<string, string | string[] | undefined>;

export function first(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export function asDate(v: string | string[] | undefined): Date | null {
  const s = first(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
