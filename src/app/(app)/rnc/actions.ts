"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import {
  addQuote,
  castRncVote,
  convene,
  createRncCase,
  recordAttendance,
  recordDecisionEmail,
  recordTerms,
  resolveRncCase,
  selectLandlord,
} from "@/server/rnc";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const s = blank(v);
  return s === null ? null : Number(s);
};

function touch(id?: string) {
  revalidatePath("/rnc");
  if (id) revalidatePath(`/rnc/${id}`);
}

export async function createRncCaseAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const entityId = String(formData.get("entityId") ?? "");
    if (!entityId) throw new ValidationError("Choose the company.");
    const kase = await createRncCase(user, {
      entityId,
      region: String(formData.get("region") ?? "CENTRAL"),
      title: String(formData.get("title") ?? ""),
      needAssessment: blank(formData.get("needAssessment")),
      locationNote: blank(formData.get("locationNote")),
      buildOutId: blank(formData.get("buildOutId")),
    });
    touch(kase.id);
    return { ok: true, data: { id: kase.id }, message: `${kase.number} raised.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function addQuoteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    await addQuote(user, {
      caseId,
      landlordName: String(formData.get("landlordName") ?? ""),
      propertyRef: blank(formData.get("propertyRef")),
      areaSqft: num(formData.get("areaSqft")),
      monthlyRent: Number(formData.get("monthlyRent") ?? 0),
      annualEscalationPercent: num(formData.get("annualEscalationPercent")),
      advanceMonths: num(formData.get("advanceMonths")),
      securityDeposit: num(formData.get("securityDeposit")),
      leaseYears: num(formData.get("leaseYears")),
      technicalEvaluation: blank(formData.get("technicalEvaluation")),
      environmentalImpact: blank(formData.get("environmentalImpact")),
      quoteAnalysisNote: blank(formData.get("quoteAnalysisNote")),
    });
    touch(caseId);
    return { ok: true, data: null, message: "Quotation added to the comparative." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function selectLandlordAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    await selectLandlord(user, {
      caseId,
      quoteId: String(formData.get("quoteId") ?? ""),
      selectionReason: blank(formData.get("reason")),
    });
    touch(caseId);
    return { ok: true, data: null, message: "Landlord selected on the comparative." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function recordTermsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    await recordTerms(user, {
      caseId,
      commercialTerms: blank(formData.get("commercialTerms")),
      marketPracticeNote: blank(formData.get("marketPracticeNote")),
      landlordObligations: blank(formData.get("landlordObligations")),
    });
    touch(caseId);
    return { ok: true, data: null, message: "Terms recorded." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function conveneRncAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    await convene(user, { caseId });
    touch(caseId);
    return { ok: true, data: null, message: "Put to the committee." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function setAttendanceAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    const memberId = String(formData.get("memberId") ?? "");
    const attendance = String(formData.get("attendance") ?? "ABSENT") as "PRESENT" | "PROXY" | "ABSENT";
    const q = await recordAttendance(user, {
      caseId,
      rows: [{ memberId, attendance, proxyName: blank(formData.get("reason")) }],
    });
    touch(caseId);
    return {
      ok: true,
      data: null,
      message: q.quorate
        ? `Recorded. The committee is quorate — ${q.present} of ${q.required} permanent members beside the head.`
        : `Recorded. Not yet quorate: ${q.reason}`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function castRncVoteAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    await castRncVote(user, {
      caseId,
      vote: String(formData.get("vote") ?? "APPROVE") as "APPROVE" | "REJECT" | "DEFER",
      comment: blank(formData.get("reason")),
    });
    touch(caseId);
    return { ok: true, data: null, message: "Vote recorded." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function resolveRncCaseAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    const outcome = String(formData.get("outcome") ?? "") as "APPROVED" | "REJECTED" | "DEFERRED";
    const { kase, quorum } = await resolveRncCase(user, {
      caseId,
      outcome,
      summary: String(formData.get("summary") ?? ""),
      deferredReason: blank(formData.get("deferredReason")),
    });
    touch(caseId);
    return {
      ok: true,
      data: null,
      message:
        outcome === "DEFERRED"
          ? `${kase.number} deferred to the next RNC.`
          : `${kase.number} ${outcome.toLowerCase()} — quorate with ${quorum.present} of ${quorum.required} beside the head. ` +
            "RN-010's decision email is the next step, and Finance cannot pay until it is recorded.",
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function recordDecisionEmailAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    await recordDecisionEmail(user, {
      caseId,
      emailRef: String(formData.get("emailRef") ?? ""),
      ceoOfficeCopied: formData.get("ceoOfficeCopied") === "on",
    });
    touch(caseId);
    return {
      ok: true,
      data: null,
      message: "Decision trail recorded. Finance has been told the rental payment may be initiated.",
    };
  } catch (e) {
    return toActionError(e);
  }
}
