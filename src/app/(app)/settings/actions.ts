"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { toActionError, type ActionResult } from "@/lib/errors";

export async function saveNotificationPreferences(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { notifyInApp: true, notifyEmail: true, notifyDigest: true },
    });
    const next = {
      notifyInApp: formData.get("notifyInApp") === "on",
      notifyEmail: formData.get("notifyEmail") === "on",
      notifyDigest: formData.get("notifyDigest") === "on",
    };
    await prisma.user.update({ where: { id: user.id }, data: next });
    await writeAudit({
      entityType: "User",
      entityId: user.id,
      entityRef: user.email,
      action: "NOTIFICATION_PREFERENCES_UPDATED",
      changes: {
        notifyInApp: { from: before.notifyInApp, to: next.notifyInApp },
        notifyEmail: { from: before.notifyEmail, to: next.notifyEmail },
        notifyDigest: { from: before.notifyDigest, to: next.notifyDigest },
      },
      actor: user,
    });
    revalidatePath("/settings");
    return { ok: true, data: next, message: "Notification preferences saved." };
  } catch (e) {
    return toActionError(e);
  }
}
