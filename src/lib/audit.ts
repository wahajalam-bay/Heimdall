import { prisma, type DbClient } from "./db";
import type { SessionUser } from "./rbac";

/**
 * Append-only audit trail. Every state transition and mutation routes through
 * `writeAudit`; nothing in the domain services mutates silently.
 */

export type AuditActor =
  | Pick<SessionUser, "id" | "name" | "roleNames">
  | { id: string; name: string; roleNames?: string[]; system?: string };

/**
 * System principals carry a synthetic id (`system:scheduler`) that is not a row
 * in `users`, so writing it to `actorId` violates the foreign key and takes the
 * whole transaction down with it.
 *
 * The audit line still needs to say who acted, and it does — `actorName` keeps
 * the principal's name either way. What it cannot do is claim the actor is a
 * user record that does not exist.
 */
function actorIdFor(actor: AuditActor | null | undefined): string | null {
  if (!actor?.id) return null;
  if ("system" in actor && actor.system) return null;
  return actor.id.startsWith("system:") ? null : actor.id;
}

export type AuditInput = {
  entityType: string;
  entityId: string;
  entityRef?: string | null;
  action: string;
  changes?: Record<string, { from: unknown; to: unknown }> | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  actor?: AuditActor | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Groups every event of one procurement case (usually the PR number). */
  caseKey?: string | null;
};

export async function writeAudit(input: AuditInput, db: DbClient = prisma) {
  return db.auditLog.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      entityRef: input.entityRef ?? null,
      action: input.action,
      changes: input.changes ? JSON.stringify(input.changes) : null,
      oldValue: input.oldValue === undefined ? null : JSON.stringify(input.oldValue),
      newValue: input.newValue === undefined ? null : JSON.stringify(input.newValue),
      reason: input.reason ?? null,
      actorId: actorIdFor(input.actor),
      // Automated sweeps have no human actor, but an anonymous audit line is
      // useless — they are attributed to the system explicitly.
      actorName: input.actor?.name ?? "System",
      actorRoles:
        input.actor && "roleNames" in input.actor && input.actor.roleNames
          ? input.actor.roleNames.join(", ")
          : input.actor
            ? null
            : "Automated",
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      caseKey: input.caseKey ?? null,
    },
  });
}

/** Computes a field-level diff, skipping unchanged and internal fields. */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
  skip: string[] = ["updatedAt", "createdAt", "id"],
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(after)) {
    if (skip.includes(k)) continue;
    const prev = before[k as keyof T];
    const norm = (x: unknown) => (x instanceof Date ? x.toISOString() : x);
    if (norm(prev) !== norm(v)) out[k] = { from: norm(prev), to: norm(v) };
  }
  return out;
}

export type ParsedAudit = {
  id: string;
  entityType: string;
  entityId: string;
  entityRef: string | null;
  action: string;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  reason: string | null;
  actorName: string | null;
  actorRoles: string | null;
  ip: string | null;
  createdAt: Date;
  caseKey: string | null;
};

export function parseAuditRow(row: {
  id: string;
  entityType: string;
  entityId: string;
  entityRef: string | null;
  action: string;
  changes: string | null;
  reason: string | null;
  actorName: string | null;
  actorRoles: string | null;
  ip: string | null;
  createdAt: Date;
  caseKey: string | null;
}): ParsedAudit {
  let changes: ParsedAudit["changes"] = null;
  if (row.changes) {
    try {
      changes = JSON.parse(row.changes);
    } catch {
      changes = null;
    }
  }
  return { ...row, changes };
}
