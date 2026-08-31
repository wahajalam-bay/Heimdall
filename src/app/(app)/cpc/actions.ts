"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission, requireUser } from "@/lib/auth";
import { ForbiddenError, toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import { castCpcDecision, recordMinutes, resolveCpcCase, scheduleMeeting, type CpcVote } from "@/server/cpc";
import { userHasPermission } from "@/lib/rbac";
import { PERMISSIONS as P } from "@/lib/permissions";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

function touch(caseId?: string, meetingId?: string) {
  revalidatePath("/cpc");
  revalidatePath("/cpc/cases");
  revalidatePath("/cpc/decisions");
  if (caseId) revalidatePath(`/cpc/cases/${caseId}`);
  if (meetingId) {
    revalidatePath("/cpc/meetings");
    revalidatePath(`/cpc/meetings/${meetingId}`);
  }
}

/* ── Voting ───────────────────────────────────────────────── */

export async function castVoteAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    const vote = String(formData.get("vote") ?? "") as CpcVote;
    if (!vote) throw new ValidationError("Select your decision.");
    const result = await castCpcDecision(user, {
      caseId,
      vote,
      comment: blank(formData.get("comment")),
      final: formData.get("final") === "true",
    });
    touch(caseId);
    revalidatePath("/pr");
    return {
      ok: true,
      data: null,
      message:
        result.outcome === "APPROVED"
          ? "Your vote is recorded and the case is approved — the requisition has moved to PO preparation."
          : result.outcome
            ? `Your vote is recorded — the case is now ${result.outcome.toLowerCase()}.`
            : "Your vote is recorded. The case stays open until the remaining required members vote.",
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function resolveCaseAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission(P.CPC_DECIDE);
    const caseId = String(formData.get("caseId") ?? "");
    const outcome = String(formData.get("outcome") ?? "") as
      | "APPROVED"
      | "REJECTED"
      | "RETURNED"
      | "CLARIFICATION"
      | "DEFERRED";
    if (!outcome) throw new ValidationError("Select the outcome.");
    const comment = blank(formData.get("comment"));
    if (outcome !== "APPROVED" && !comment) {
      throw new ValidationError("Record the committee's reasoning for anything other than a clean approval.");
    }
    const { kase } = await resolveCpcCase(user, caseId, outcome, comment);
    touch(caseId, kase.meetingId ?? undefined);
    revalidatePath("/pr");
    return { ok: true, data: null, message: `${kase.number} recorded as ${outcome.toLowerCase()}.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Meetings ─────────────────────────────────────────────── */

export async function scheduleMeetingAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const entityId = String(formData.get("entityId") ?? "");
    const title = String(formData.get("title") ?? "").trim();
    const when = String(formData.get("scheduledAt") ?? "");
    if (!entityId) throw new ValidationError("Select the entity this meeting belongs to.");
    if (!title) throw new ValidationError("Give the meeting a title.");
    if (!when) throw new ValidationError("Set the date and time.");
    const scheduledAt = new Date(when);
    if (Number.isNaN(scheduledAt.getTime())) throw new ValidationError("The date and time could not be read.");

    const meeting = await scheduleMeeting(user, {
      entityId,
      title,
      scheduledAt,
      meetingType: String(formData.get("meetingType") ?? "WEEKLY"),
      location: blank(formData.get("location")),
      agenda: blank(formData.get("agenda")),
      caseIds: formData.getAll("caseIds").map(String).filter(Boolean),
    });
    touch(undefined, meeting.id);
    return {
      ok: true,
      data: { id: meeting.id, number: meeting.number },
      message: `${meeting.number} scheduled for ${scheduledAt.toLocaleString("en-PK")}.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function recordMinutesAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const meetingId = String(formData.get("meetingId") ?? "");
    const minutes = String(formData.get("minutes") ?? "").trim();
    if (!minutes) throw new ValidationError("Record what the committee discussed and decided.");
    const complete = formData.get("complete") === "true";
    const m = await recordMinutes(user, meetingId, minutes, complete);
    touch(undefined, meetingId);
    return {
      ok: true,
      data: null,
      message: complete ? `${m.number} closed with minutes on file.` : `Minutes saved against ${m.number}.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function addCasesToMeetingAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const meetingId = String(formData.get("meetingId") ?? "");
    const caseIds = formData.getAll("caseIds").map(String).filter(Boolean);
    if (!caseIds.length) throw new ValidationError("Select at least one case.");
    if (!userHasPermission(user, P.CPC_MANAGE)) {
      throw new ForbiddenError("You do not have permission to manage the CPC agenda.");
    }
    await prisma.cpcCase.updateMany({
      where: { id: { in: caseIds }, status: { in: ["PENDING", "SCHEDULED"] } },
      data: { meetingId, status: "SCHEDULED" },
    });
    touch(undefined, meetingId);
    return { ok: true, data: null, message: `${caseIds.length} case(s) added to the agenda.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Options ──────────────────────────────────────────────── */

export async function cpcOptions(entityId: string | null) {
  const user = await requireUser();
  const [entities, unscheduled] = await Promise.all([
    prisma.entity.findMany({
      where: { active: true, id: { in: user.entityIds } },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    prisma.cpcCase.findMany({
      where: {
        status: { in: ["PENDING", "SCHEDULED"] },
        ...(entityId ? { pr: { entityId } } : { pr: { entityId: { in: user.entityIds } } }),
      },
      select: {
        id: true,
        number: true,
        title: true,
        amount: true,
        meetingId: true,
        pr: { select: { number: true, entityId: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  return { entities, unscheduled };
}
