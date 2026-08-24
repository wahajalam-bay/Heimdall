import "server-only";
import { prisma } from "./db";
import type { SessionUser } from "./auth";
import { visibleEntityIds } from "./auth";
import { nullableEntityScope } from "./rbac";
import { PO_OPEN_STATUSES } from "./domain";

/**
 * Sidebar badge counts — one round of cheap aggregate queries.
 *
 * These are scoped exactly as the register each badge links to is scoped,
 * including the entity chosen in the switcher. A badge reading "2" beside a page
 * that then shows nothing is worse than no badge at all: it sends people looking
 * for work that is not theirs to see.
 */
export async function navBadgeCounts(
  user: SessionUser,
  entityId: string | null = null,
): Promise<Record<string, number>> {
  const scoped = visibleEntityIds(user);
  const entityWhere = entityId ? { entityId } : scoped ? { entityId: { in: scoped } } : {};
  // Invoices, deliveries and inspections belong to an entity through their order.
  const viaPo = Object.keys(entityWhere).length ? { po: entityWhere } : {};

  const [myTasks, alerts, cpcPending, openPo, invoiceMismatch, exceptions, inspections, grnPending] =
    await Promise.all([
      prisma.task.count({
        where: {
          status: { in: ["OPEN", "IN_PROGRESS"] },
          OR: [
            { assigneeId: user.id },
            { assigneeId: null, assignedRoleCode: { in: user.roleCodes } },
          ],
        },
      }),
      prisma.notification.count({ where: { userId: user.id, read: false } }),
      prisma.cpcCase.count({
        where: { status: { in: ["PENDING", "SCHEDULED", "UNDER_REVIEW"] }, pr: entityWhere },
      }),
      prisma.purchaseOrder.count({ where: { status: { in: PO_OPEN_STATUSES }, ...entityWhere } }),
      prisma.invoice.count({
        where: { OR: [{ matchStatus: "FAILED" }, { status: "MISMATCH" }], ...viaPo },
      }),
      prisma.exception.count({
        where: { status: { in: ["OPEN", "IN_PROGRESS"] }, ...nullableEntityScope(entityId, scoped) },
      }),
      prisma.inspection.count({
        where: { result: { in: ["PENDING", "IN_PROGRESS", "RE_INSPECTION_REQUIRED"] }, ...viaPo },
      }),
      prisma.delivery.count({
        where: { status: { not: "REJECTED" }, grns: { none: {} }, ...viaPo },
      }),
    ]);

  return { myTasks, alerts, cpcPending, openPo, invoiceMismatch, exceptions, inspections, grnPending };
}
