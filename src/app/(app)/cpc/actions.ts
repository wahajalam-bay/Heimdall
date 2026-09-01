"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission, requireUser } from "@/lib/auth";
import { ForbiddenError, toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import { circulateCpcDecision, recordCpcAttendance } from "@/server/cpc-quorum";
import {
  castCpcDecision,
  recordCeoDecision,
  recordMinutes,
  resolveCpcCase,
  scheduleMeeting,
  type CpcVote,
} from "@/server/cpc";
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
          : result.outcome === "PENDING_CEO"
            ? "Your vote is recorded and the committee has approved. The case is above the CEO tier, so it is held for the Office of the CEO and the requisition has not moved."
            : result.outcome
              ? `Your vote is recorded — the case is now ${result.outcome.toLowerCase().replace(/_/g, " ")}.`
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
    const { kase, outcome: landed } = await resolveCpcCase(user, caseId, outcome, comment);
    touch(caseId, kase.meetingId ?? undefined);
    revalidatePath("/pr");
    return {
      ok: true,
      data: null,
      message:
        landed === "PENDING_CEO"
          ? `${kase.number} is approved by the committee and held for the Office of the CEO — PC-023 applies above the value tier, so the requisition has not moved to PO preparation.`
          : `${kase.number} recorded as ${outcome.toLowerCase()}.`,
    };
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

/**
 * The Office of the CEO's decision — PC-023, above the value tier.
 *
 * A separate permission from `CPC_DECIDE`, and held by no committee role. The
 * committee approving on the CEO's behalf is precisely what a second approval
 * exists to prevent, and an action that accepted either would not be able to
 * tell the two apart.
 */
export async function recordCeoDecisionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requirePermission(P.CPC_CEO_APPROVE);
    const caseId = String(formData.get("caseId") ?? "");
    const decision = String(formData.get("decision") ?? "") as "APPROVED" | "REJECTED";
    if (decision !== "APPROVED" && decision !== "REJECTED") {
      throw new ValidationError("Say whether the Office of the CEO approved or declined the award.");
    }
    const kase = await recordCeoDecision(user, {
      caseId,
      decision,
      comment: blank(formData.get("comment")),
    });
    touch(caseId, kase.meetingId ?? undefined);
    revalidatePath("/pr");
    return {
      ok: true,
      data: null,
      message:
        decision === "APPROVED"
          ? `${kase.number} approved by the Office of the CEO — the requisition has moved to PO preparation.`
          : `${kase.number} declined by the Office of the CEO and returned to procurement.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/**
 * CP-006 attendance, and CP-016 circulation.
 *
 * Both are recorded rather than performed by the system: it does not run the
 * meeting and does not own the mailbox. What it can do is count the quorum from
 * what was recorded, and refuse to call a decision circulated when the people
 * the clause names were not on it.
 */
export async function setCpcAttendanceAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission(P.CPC_DECIDE);
    const caseId = String(formData.get("caseId") ?? "");
    const memberId = String(formData.get("memberId") ?? "");
    const attendance = String(formData.get("attendance") ?? "ABSENT") as "PRESENT" | "PROXY" | "ABSENT";
    const quorum = await recordCpcAttendance(user, {
      caseId,
      rows: [{ memberId, attendance, proxyName: blank(formData.get("reason")) }],
    });
    touch(caseId);
    return {
      ok: true,
      data: null,
      message: quorum.quorate
        ? `Recorded. The committee is quorate — ${quorum.present} of ${quorum.required} permanent members besides the requisitioner's head.`
        : `Recorded. Not yet quorate: ${quorum.reason}`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function circulateCpcDecisionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requirePermission(P.CPC_DECIDE);
    const caseId = String(formData.get("caseId") ?? "");
    await circulateCpcDecision(user, {
      caseId,
      circularRef: String(formData.get("circularRef") ?? ""),
      ceoOfficeCopied: formData.get("ceoOfficeCopied") === "on",
    });
    touch(caseId);
    revalidatePath("/invoices");
    return {
      ok: true,
      data: null,
      message:
        "Circulated. The decision is now part of the documentation trail Finance pays against, and shows on the payment pack of any invoice against this requisition.",
    };
  } catch (e) {
    return toActionError(e);
  }
}
