import "server-only";
import { prisma } from "./db";
import type { SessionUser } from "./auth";
import { visibleEntityIds } from "./auth";
import { PO_OPEN_STATUSES } from "./domain";

/** Sidebar badge counts — one round of cheap aggregate queries. */
export async function navBadgeCounts(user: SessionUser): Promise<Record<string, number>> {
  const scoped = visibleEntityIds(user);
  const entityWhere = scoped ? { entityId: { in: scoped } } : {};

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
      prisma.cpcCase.count({ where: { status: { in: ["PENDING", "SCHEDULED", "UNDER_REVIEW"] } } }),
      prisma.purchaseOrder.count({ where: { status: { in: PO_OPEN_STATUSES }, ...entityWhere } }),
      prisma.invoice.count({ where: { OR: [{ matchStatus: "FAILED" }, { status: "MISMATCH" }] } }),
      prisma.exception.count({ where: { status: { in: ["OPEN", "IN_PROGRESS"] } } }),
      prisma.inspection.count({ where: { result: { in: ["PENDING", "IN_PROGRESS", "RE_INSPECTION_REQUIRED"] } } }),
      prisma.delivery.count({
        where: { status: { not: "REJECTED" }, grns: { none: {} } },
      }),
    ]);

  return { myTasks, alerts, cpcPending, openPo, invoiceMismatch, exceptions, inspections, grnPending };
}
