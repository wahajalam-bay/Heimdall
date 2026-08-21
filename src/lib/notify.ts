import { prisma, type DbClient } from "./db";
import { queueEmail, renderNotificationEmail } from "./mail";

/** In-app notification centre + task inbox writers. */

export type NotifyInput = {
  userIds?: string[];
  roleCodes?: string[];
  entityId?: string | null;
  type: string;
  title: string;
  body?: string | null;
  priority?: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
  linkType?: string | null;
  linkId?: string | null;
  linkUrl?: string | null;
};

/** Resolves role codes to user ids, optionally scoped to an entity. */
export async function usersForRoles(
  roleCodes: string[],
  entityId?: string | null,
  db: DbClient = prisma,
): Promise<string[]> {
  if (!roleCodes.length) return [];
  const users = await db.user.findMany({
    where: {
      active: true,
      roles: { some: { role: { code: { in: roleCodes } } } },
      ...(entityId
        ? { OR: [{ primaryEntityId: entityId }, { entityAccess: { some: { entityId } } }] }
        : {}),
    },
    select: { id: true, notifyInApp: true },
  });
  return users.filter((u) => u.notifyInApp).map((u) => u.id);
}

export async function notify(input: NotifyInput, db: DbClient = prisma) {
  const ids = new Set(input.userIds ?? []);
  if (input.roleCodes?.length) {
    for (const id of await usersForRoles(input.roleCodes, input.entityId, db)) ids.add(id);
  }
  if (!ids.size) return 0;
  const priority = input.priority ?? "NORMAL";
  await db.notification.createMany({
    data: [...ids].map((userId) => ({
      userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      priority,
      linkType: input.linkType ?? null,
      linkId: input.linkId ?? null,
      linkUrl: input.linkUrl ?? null,
    })),
  });
  await queueEmailsFor([...ids], { ...input, priority }, db);
  return ids.size;
}

/**
 * Queues email for the recipients who asked for it. In-app notification is the
 * record; email is a nudge, so it goes only to people who switched it on, and
 * only for work that will not wait — an approval sitting in a queue nobody has
 * open is exactly the case the in-app centre cannot cover.
 */
async function queueEmailsFor(userIds: string[], input: NotifyInput & { priority: string }, db: DbClient) {
  const mailWorthy = input.priority === "HIGH" || input.priority === "CRITICAL" || MAIL_TYPES.has(input.type);
  if (!mailWorthy) return;

  const recipients = await db.user.findMany({
    where: { id: { in: userIds }, active: true, notifyEmail: true },
    select: { id: true, email: true, name: true },
  });

  for (const r of recipients) {
    await queueEmail(
      {
        toAddress: r.email,
        toName: r.name,
        subject: input.title,
        bodyText: renderNotificationEmail({
          recipientName: r.name,
          title: input.title,
          body: input.body,
          linkUrl: input.linkUrl,
          priority: input.priority,
        }),
        category: EMAIL_CATEGORY[input.type] ?? "GENERAL",
        userId: r.id,
        linkUrl: input.linkUrl ?? null,
        entityId: input.entityId ?? null,
      },
      db,
    );
  }
}

/** Notification types that always earn an email, whatever their priority. */
const MAIL_TYPES = new Set([
  "APPROVAL_REQUIRED",
  "APPROVAL_REMINDER",
  "PO_APPROVAL",
  "CPC_PENDING",
  "INVOICE_MISMATCH",
  "EXCEPTION_RAISED",
  "PR_REJECTED",
  "PR_RETURNED",
]);

const EMAIL_CATEGORY: Record<string, "APPROVAL" | "REMINDER" | "EXCEPTION" | "DIGEST" | "GENERAL"> = {
  APPROVAL_REQUIRED: "APPROVAL",
  APPROVAL_REMINDER: "REMINDER",
  PO_APPROVAL: "APPROVAL",
  CPC_PENDING: "APPROVAL",
  INVOICE_MISMATCH: "EXCEPTION",
  EXCEPTION_RAISED: "EXCEPTION",
  PR_REJECTED: "GENERAL",
  PR_RETURNED: "GENERAL",
};

export type TaskInput = {
  title: string;
  description?: string | null;
  taskType?: "APPROVAL" | "ACTION" | "REVIEW" | "DATA_ENTRY" | "INSPECTION" | "RECEIVING" | "VERIFICATION";
  assigneeId?: string | null;
  assignedRoleCode?: string | null;
  entityId?: string | null;
  documentType: string;
  documentId: string;
  documentRef: string;
  priority?: string;
  slaHours?: number | null;
  linkUrl?: string | null;
};

export async function createTask(input: TaskInput, db: DbClient = prisma) {
  const dueAt = input.slaHours ? new Date(Date.now() + input.slaHours * 3600 * 1000) : null;
  return db.task.create({
    data: {
      title: input.title,
      description: input.description ?? null,
      taskType: input.taskType ?? "ACTION",
      assigneeId: input.assigneeId ?? null,
      assignedRoleCode: input.assignedRoleCode ?? null,
      entityId: input.entityId ?? null,
      documentType: input.documentType,
      documentId: input.documentId,
      documentRef: input.documentRef,
      priority: input.priority ?? "NORMAL",
      slaHours: input.slaHours ?? null,
      dueAt,
      linkUrl: input.linkUrl ?? null,
    },
  });
}

/** Closes open tasks for a document, e.g. once an approval step is actioned. */
export async function completeTasks(
  documentType: string,
  documentId: string,
  completedById: string | null,
  db: DbClient = prisma,
  taskType?: string,
) {
  return db.task.updateMany({
    where: {
      documentType,
      documentId,
      status: { in: ["OPEN", "IN_PROGRESS"] },
      ...(taskType ? { taskType } : {}),
    },
    data: { status: "DONE", completedAt: new Date(), completedById },
  });
}

export async function cancelTasks(documentType: string, documentId: string, db: DbClient = prisma) {
  return db.task.updateMany({
    where: { documentType, documentId, status: { in: ["OPEN", "IN_PROGRESS"] } },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
}
