"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { userHasPermission } from "@/lib/rbac";
import { PERMISSIONS as P } from "@/lib/permissions";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { ForbiddenError, NotFoundError, toActionError, ValidationError, type ActionResult } from "@/lib/errors";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

function touch(id: string) {
  revalidatePath("/analytics/exceptions");
  revalidatePath(`/analytics/exceptions/${id}`);
  revalidatePath("/alerts");
}

/**
 * Closing out an exception. Resolution, acceptance and waiver are distinct
 * outcomes and each demands its own written justification — waiving a blocking
 * control is the most consequential of the three and needs the widest authority.
 */
export async function resolveExceptionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = String(formData.get("exceptionId") ?? "");
    const outcome = String(formData.get("outcome") ?? "") as "RESOLVED" | "ACCEPTED" | "WAIVED" | "IN_PROGRESS" | "CLOSED";
    const resolution = blank(formData.get("resolution"));

    if (!userHasPermission(user, P.EXCEPTION_MANAGE)) {
      throw new ForbiddenError("You do not have permission to act on exceptions.");
    }
    const exception = await prisma.exception.findUnique({ where: { id } });
    if (!exception) throw new NotFoundError("Exception");
    if (["RESOLVED", "ACCEPTED", "WAIVED", "CLOSED"].includes(exception.status)) {
      throw new ValidationError(`${exception.number} is already ${exception.status.toLowerCase()}.`);
    }

    if (outcome !== "IN_PROGRESS" && (!resolution || resolution.length < 12)) {
      throw new ValidationError("Record a substantive resolution — at least a full sentence.");
    }
    // Waiving a blocking control needs the wider invoice/exception override
    // authority, not merely the ability to work an exception.
    if (outcome === "WAIVED" && exception.blocking && !userHasPermission(user, P.INVOICE_EXCEPTION_APPROVE)) {
      throw new ForbiddenError(
        "A blocking exception can only be waived by an authorised override approver. Resolve the underlying issue, or escalate.",
      );
    }

    const updated = await prisma.exception.update({
      where: { id },
      data: {
        status: outcome,
        resolution: resolution ?? exception.resolution,
        ...(outcome === "IN_PROGRESS"
          ? {}
          : { resolvedById: user.id, resolvedAt: new Date(), blocking: outcome === "WAIVED" ? false : exception.blocking }),
      },
    });

    await writeAudit({
      entityType: "Exception",
      entityId: id,
      entityRef: exception.number,
      action: `EXCEPTION_${outcome}`,
      reason: resolution,
      newValue: { from: exception.status, to: outcome, wasBlocking: exception.blocking },
      caseKey: exception.caseKey,
      actor: user,
    });

    if (outcome === "WAIVED" && exception.blocking) {
      await notify({
        roleCodes: ["PROCUREMENT_DIRECTOR", "AUDIT_MANAGER", "FINANCE_APPROVER"],
        entityId: exception.entityId,
        type: "EXCEPTION_WAIVED",
        title: `Blocking exception ${exception.number} waived`,
        body: `${exception.title} — waived by ${user.name}. ${resolution ?? ""}`.trim(),
        linkType: "EXCEPTION",
        linkId: exception.id,
        linkUrl: `/analytics/exceptions/${exception.id}`,
      });
    }

    touch(id);
    return {
      ok: true,
      data: null,
      message:
        outcome === "IN_PROGRESS"
          ? `${updated.number} taken up.`
          : outcome === "WAIVED"
            ? `${updated.number} waived — the override is permanently attributed to you.`
            : `${updated.number} ${outcome.toLowerCase()}.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function assignExceptionAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    if (!userHasPermission(user, P.EXCEPTION_MANAGE)) {
      throw new ForbiddenError("You do not have permission to assign exceptions.");
    }
    const id = String(formData.get("exceptionId") ?? "");
    const ownerId = blank(formData.get("ownerId"));
    const exception = await prisma.exception.findUnique({ where: { id } });
    if (!exception) throw new NotFoundError("Exception");

    await prisma.exception.update({ where: { id }, data: { ownerId } });
    await writeAudit({
      entityType: "Exception",
      entityId: id,
      entityRef: exception.number,
      action: "EXCEPTION_ASSIGNED",
      newValue: { ownerId },
      caseKey: exception.caseKey,
      actor: user,
    });
    if (ownerId) {
      await notify({
        userIds: [ownerId],
        entityId: exception.entityId,
        type: "EXCEPTION_ASSIGNED",
        title: `Exception ${exception.number} assigned to you`,
        body: exception.title,
        linkType: "EXCEPTION",
        linkId: exception.id,
        linkUrl: `/analytics/exceptions/${exception.id}`,
      });
    }
    touch(id);
    return { ok: true, data: null, message: ownerId ? "Exception assigned." : "Owner cleared." };
  } catch (e) {
    return toActionError(e);
  }
}
