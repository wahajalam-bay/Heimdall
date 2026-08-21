import { prisma, type DbClient } from "./db";
import { nextNumber, SEQ } from "./numbering";
import { notify } from "./notify";
import { writeAudit, type AuditActor } from "./audit";
import type { ExceptionType, Severity } from "./domain";

/**
 * Exceptions are first-class objects: every rule breach the system tolerates
 * (rather than blocks) leaves a tracked, owned exception behind.
 */

export type RaiseExceptionInput = {
  type: ExceptionType;
  severity?: Severity;
  title: string;
  description?: string | null;
  reason?: string | null;
  documentType: string;
  documentId: string;
  documentRef: string;
  caseKey?: string | null;
  entityId?: string | null;
  prId?: string | null;
  poId?: string | null;
  invoiceId?: string | null;
  ownerId?: string | null;
  raisedById?: string | null;
  /** Blocking exceptions prevent downstream closure until resolved or waived. */
  blocking?: boolean;
  dueInHours?: number;
  notifyRoles?: string[];
};

export async function raiseException(
  input: RaiseExceptionInput,
  db: DbClient = prisma,
  actor?: AuditActor | null,
) {
  // Don't stack duplicate open exceptions of the same type on the same document.
  const existing = await db.exception.findFirst({
    where: {
      type: input.type,
      documentType: input.documentType,
      documentId: input.documentId,
      status: { in: ["OPEN", "IN_PROGRESS"] },
    },
  });
  if (existing) {
    if (input.description && existing.description !== input.description) {
      await db.exception.update({
        where: { id: existing.id },
        data: { description: input.description, severity: input.severity ?? existing.severity },
      });
    }
    return existing;
  }

  const number = await nextNumber(SEQ.EXCEPTION, db);
  const exc = await db.exception.create({
    data: {
      number,
      type: input.type,
      severity: input.severity ?? "MEDIUM",
      title: input.title,
      description: input.description ?? null,
      reason: input.reason ?? null,
      documentType: input.documentType,
      documentId: input.documentId,
      documentRef: input.documentRef,
      caseKey: input.caseKey ?? null,
      entityId: input.entityId ?? null,
      prId: input.prId ?? null,
      poId: input.poId ?? null,
      invoiceId: input.invoiceId ?? null,
      ownerId: input.ownerId ?? null,
      raisedById: input.raisedById ?? null,
      blocking: input.blocking ?? false,
      dueAt: input.dueInHours ? new Date(Date.now() + input.dueInHours * 3600 * 1000) : null,
    },
  });

  await writeAudit(
    {
      entityType: "Exception",
      entityId: exc.id,
      entityRef: exc.number,
      action: "EXCEPTION_RAISED",
      newValue: { type: exc.type, severity: exc.severity, title: exc.title },
      caseKey: input.caseKey ?? null,
      actor: actor ?? null,
    },
    db,
  );

  await notify(
    {
      userIds: input.ownerId ? [input.ownerId] : [],
      roleCodes: input.notifyRoles ?? ["PROCUREMENT_OFFICER", "PROCUREMENT_SENIOR_MANAGER"],
      entityId: input.entityId,
      type: "EXCEPTION_RAISED",
      title: `${exc.number}: ${exc.title}`,
      body: exc.description,
      priority: exc.severity === "CRITICAL" ? "CRITICAL" : exc.severity === "HIGH" ? "HIGH" : "NORMAL",
      linkType: "EXCEPTION",
      linkId: exc.id,
      linkUrl: `/analytics/exceptions/${exc.id}`,
    },
    db,
  );

  return exc;
}

/** Auto-resolves exceptions of a type once the underlying condition clears. */
export async function autoResolveExceptions(
  documentType: string,
  documentId: string,
  types: ExceptionType[],
  resolution: string,
  db: DbClient = prisma,
) {
  const open = await db.exception.findMany({
    where: { documentType, documentId, type: { in: types }, status: { in: ["OPEN", "IN_PROGRESS"] } },
  });
  if (!open.length) return 0;
  await db.exception.updateMany({
    where: { id: { in: open.map((e) => e.id) } },
    data: { status: "RESOLVED", resolution, resolvedAt: new Date() },
  });
  return open.length;
}

/** True when a document carries an unresolved blocking exception. */
export async function hasBlockingException(
  documentType: string,
  documentId: string,
  db: DbClient = prisma,
): Promise<boolean> {
  const n = await db.exception.count({
    where: { documentType, documentId, blocking: true, status: { in: ["OPEN", "IN_PROGRESS"] } },
  });
  return n > 0;
}
