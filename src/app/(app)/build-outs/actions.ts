"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import {
  addLesson,
  addScheduleDay,
  approveBuildOut,
  checkScheduleDay,
  closeBuildOut,
  conveneCfc,
  createBuildOut,
  measureBoqLine,
  recordMeetingOutcome,
  recordRequirements,
  scheduleWeeklyReview,
  setTimelines,
  updateTask,
  upsertBoqLine,
  type TaskState,
} from "@/server/buildout";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const s = blank(v);
  return s === null ? null : Number(s);
};
const date = (v: FormDataEntryValue | null) => {
  const s = blank(v);
  return s === null ? null : new Date(s);
};

function touch(id?: string) {
  revalidatePath("/build-outs");
  if (id) revalidatePath(`/build-outs/${id}`);
}

export async function createBuildOutAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const entityId = String(formData.get("entityId") ?? "");
    if (!entityId) throw new ValidationError("Choose the company.");
    const buildOut = await createBuildOut(user, {
      entityId,
      name: String(formData.get("name") ?? ""),
      region: String(formData.get("region") ?? "CENTRAL"),
      city: blank(formData.get("city")),
      projectId: blank(formData.get("projectId")),
      siteId: blank(formData.get("siteId")),
      budgetAmount: num(formData.get("budgetAmount")),
    });
    touch(buildOut.id);
    return {
      ok: true,
      data: { id: buildOut.id },
      message: `${buildOut.number} raised. It needs management's go-ahead before requirements are gathered.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function approveBuildOutAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const buildOutId = String(formData.get("buildOutId") ?? "");
    await approveBuildOut(user, { buildOutId, note: blank(formData.get("reason")) });
    touch(buildOutId);
    return { ok: true, data: null, message: "Go-ahead recorded. Requirement gathering can start." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function recordRequirementsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const buildOutId = String(formData.get("buildOutId") ?? "");
    await recordRequirements(user, {
      buildOutId,
      headcount: num(formData.get("headcount")),
      requirementsSummary: String(formData.get("requirementsSummary") ?? ""),
      specialRequirements: blank(formData.get("specialRequirements")),
    });
    touch(buildOutId);
    return { ok: true, data: null, message: "Requirements recorded." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function setTimelinesAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const buildOutId = String(formData.get("buildOutId") ?? "");
    const start = date(formData.get("plannedStartDate"));
    const end = date(formData.get("plannedEndDate"));
    if (!start || !end) throw new ValidationError("Give both the planned start and the planned end.");
    await setTimelines(user, { buildOutId, plannedStartDate: start, plannedEndDate: end });
    touch(buildOutId);
    return { ok: true, data: null, message: "Timelines set and shared with the committee." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function conveneCfcAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const buildOutId = String(formData.get("buildOutId") ?? "");
    const scheduledAt = date(formData.get("scheduledAt"));
    if (!scheduledAt) throw new ValidationError("When does the committee meet?");
    const result = await conveneCfc(user, {
      buildOutId,
      scheduledAt,
      location: blank(formData.get("location")),
      agenda: blank(formData.get("agenda")),
    });
    touch(buildOutId);
    return {
      ok: true,
      data: null,
      message:
        `${result.meeting.number} called. ` +
        (result.checklistLines
          ? `${result.checklistLines} checklist responsibilities copied onto the project across ten departments.`
          : "The checklist was already handed out."),
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function scheduleWeeklyAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const buildOutId = String(formData.get("buildOutId") ?? "");
    const meeting = await scheduleWeeklyReview(user, { buildOutId });
    touch(buildOutId);
    return {
      ok: true,
      data: null,
      message: `${meeting.number} scheduled for ${meeting.scheduledAt.toISOString().slice(0, 10)} — the standing Friday review.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function minuteMeetingAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const meetingId = String(formData.get("meetingId") ?? "");
    const buildOutId = String(formData.get("buildOutId") ?? "");
    await recordMeetingOutcome(user, {
      meetingId,
      minutes: String(formData.get("minutes") ?? ""),
    });
    touch(buildOutId);
    return { ok: true, data: null, message: "Minutes recorded." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function updateTaskAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const buildOutId = String(formData.get("buildOutId") ?? "");
    await updateTask(user, {
      taskId: String(formData.get("taskId") ?? ""),
      status: String(formData.get("status") ?? "IN_PROGRESS") as TaskState,
      progressNote: blank(formData.get("progressNote")),
      notApplicableReason: blank(formData.get("notApplicableReason")),
      ownerId: blank(formData.get("ownerId")),
      dueDate: date(formData.get("dueDate")),
    });
    touch(buildOutId);
    return { ok: true, data: null, message: "Checklist updated." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function upsertBoqLineAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const buildOutId = String(formData.get("buildOutId") ?? "");
    await upsertBoqLine(user, {
      buildOutId,
      lineNo: Number(formData.get("lineNo") ?? 0),
      description: String(formData.get("description") ?? ""),
      unit: String(formData.get("unit") ?? ""),
      budgetQty: Number(formData.get("budgetQty") ?? 0),
      budgetRate: Number(formData.get("budgetRate") ?? 0),
    });
    touch(buildOutId);
    return { ok: true, data: null, message: "BOQ line saved." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function measureBoqLineAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const buildOutId = String(formData.get("buildOutId") ?? "");
    await measureBoqLine(user, {
      lineId: String(formData.get("lineId") ?? ""),
      actualQty: Number(formData.get("actualQty") ?? 0),
      actualRate: Number(formData.get("actualRate") ?? 0),
      varianceNote: blank(formData.get("varianceNote")),
    });
    touch(buildOutId);
    return { ok: true, data: null, message: "Measured against the BOQ." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function addScheduleDayAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const buildOutId = String(formData.get("buildOutId") ?? "");
    const day = date(formData.get("day"));
    if (!day) throw new ValidationError("Which day?");
    await addScheduleDay(user, {
      buildOutId,
      day,
      activity: String(formData.get("activity") ?? ""),
      vendorId: blank(formData.get("vendorId")),
      vendorName: blank(formData.get("vendorName")),
    });
    touch(buildOutId);
    return { ok: true, data: null, message: "Day added to the vendor schedule." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function checkScheduleDayAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const buildOutId = String(formData.get("buildOutId") ?? "");
    await checkScheduleDay(user, {
      dayId: String(formData.get("dayId") ?? ""),
      status: String(formData.get("status") ?? "ON_TRACK") as "ON_TRACK" | "SLIPPED" | "DONE",
      slipReason: blank(formData.get("reason")),
    });
    touch(buildOutId);
    return { ok: true, data: null, message: "Schedule checked." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function addLessonAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const buildOutId = String(formData.get("buildOutId") ?? "");
    await addLesson(user, {
      buildOutId,
      category: String(formData.get("category") ?? "OTHER"),
      finding: String(formData.get("finding") ?? ""),
      recommendation: blank(formData.get("recommendation")),
    });
    touch(buildOutId);
    return { ok: true, data: null, message: "Lesson recorded." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function closeBuildOutAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const buildOutId = String(formData.get("buildOutId") ?? "");
    await closeBuildOut(user, { buildOutId, summary: blank(formData.get("reason")) });
    touch(buildOutId);
    return {
      ok: true,
      data: null,
      message: "Closed. The cost and timeline variance has gone to management.",
    };
  } catch (e) {
    return toActionError(e);
  }
}
