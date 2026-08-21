"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission, requireUser } from "@/lib/auth";
import { PERMISSIONS as P } from "@/lib/permissions";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import type { BlacklistStage } from "@/lib/domain";
import {
  advanceBlacklistCase,
  createVendor,
  decideVendorApproval,
  evaluateVendor,
  openBlacklistCase,
  raiseVendorIssue,
  recomputeAllVendorPerformance,
  reinstateVendor,
  updateVendor,
  updateVendorIssue,
  computeVendorPerformance,
  type ScoreInput,
} from "@/server/vendors";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const s = blank(v);
  return s === null ? null : Number(s);
};
const bool = (v: FormDataEntryValue | null) => v === "on" || v === "true";

function touch(vendorId?: string) {
  revalidatePath("/vendors");
  if (vendorId) revalidatePath(`/vendors/${vendorId}`);
}

/* ── Registration ─────────────────────────────────────────── */

function vendorFields(formData: FormData) {
  return {
    name: String(formData.get("name") ?? "").trim(),
    legalName: blank(formData.get("legalName")),
    businessType: String(formData.get("businessType") ?? "DISTRIBUTOR"),
    address: blank(formData.get("address")),
    city: blank(formData.get("city")),
    country: String(formData.get("country") ?? "Pakistan"),
    contactPerson: blank(formData.get("contactPerson")),
    contactPhone: blank(formData.get("contactPhone")),
    contactEmail: blank(formData.get("contactEmail")),
    website: blank(formData.get("website")),
    taxStatus: String(formData.get("taxStatus") ?? "FILER"),
    ntn: blank(formData.get("ntn")),
    strn: blank(formData.get("strn")),
    registrationNumber: blank(formData.get("registrationNumber")),
    officeCount: num(formData.get("officeCount")),
    citiesCovered: blank(formData.get("citiesCovered")),
    workforceCount: num(formData.get("workforceCount")),
    hasTransportation: bool(formData.get("hasTransportation")),
    transportationNotes: blank(formData.get("transportationNotes")),
    supportStaffCount: num(formData.get("supportStaffCount")),
    paymentTerms: blank(formData.get("paymentTerms")),
    creditDays: num(formData.get("creditDays")),
    bankName: blank(formData.get("bankName")),
    bankAccountTitle: blank(formData.get("bankAccountTitle")),
    bankAccountNumber: blank(formData.get("bankAccountNumber")),
    bankIban: blank(formData.get("bankIban")),
    references: blank(formData.get("references")),
    productsServices: blank(formData.get("productsServices")),
    categories: blank(formData.get("categories")),
    sourceChannel: String(formData.get("sourceChannel") ?? "MARKET"),
    sourceNotes: blank(formData.get("sourceNotes")),
    isTrader: bool(formData.get("isTrader")),
    minimumOrderValue: num(formData.get("minimumOrderValue")),
    entityIds: formData.getAll("entityIds").map(String).filter(Boolean),
  };
}

export async function createVendorAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const fields = vendorFields(formData);
    if (!fields.name) throw new ValidationError("Enter the vendor's trading name.");
    const vendor = await createVendor(user, fields);
    touch(vendor.id);
    return {
      ok: true,
      data: { id: vendor.id, code: vendor.code },
      message: `${vendor.name} registered as ${vendor.code}. Score the pre-qualification before approving.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function updateVendorAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const vendorId = String(formData.get("vendorId") ?? "");
    const fields = vendorFields(formData);
    if (!fields.name) throw new ValidationError("Enter the vendor's trading name.");
    await updateVendor(user, vendorId, fields);
    touch(vendorId);
    return { ok: true, data: { id: vendorId }, message: "Vendor record updated." };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Pre-qualification ────────────────────────────────────── */

export async function evaluateVendorAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const vendorId = String(formData.get("vendorId") ?? "");
    let scores: ScoreInput[];
    try {
      scores = JSON.parse(String(formData.get("scores") ?? "[]")) as ScoreInput[];
    } catch {
      throw new ValidationError("Scores could not be read.");
    }
    scores = scores.filter((s) => s.criterionId && s.score !== null && s.score !== undefined);
    if (!scores.length) throw new ValidationError("Score at least one criterion.");

    const result = await evaluateVendor(user, {
      vendorId,
      evaluationType: String(formData.get("evaluationType") ?? "PRE_QUALIFICATION"),
      scores: scores.map((s) => ({
        criterionId: s.criterionId,
        score: Number(s.score),
        comment: s.comment ?? null,
      })),
      recommendation: blank(formData.get("recommendation")),
      notes: blank(formData.get("notes")),
      entityId: blank(formData.get("entityId")),
      submit: formData.get("submit") !== "false",
    });
    touch(vendorId);
    revalidatePath("/vendors/evaluations");
    return {
      ok: true,
      data: { id: result.evaluation.id },
      message: `${result.evaluation.number} recorded — ${result.scaledScore} of ${result.configuredMax} (${result.percentage.toFixed(1)}%), ${result.passed ? "at or above" : "below"} the ${result.passingScore} pass mark.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function decideVendorAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const vendorId = String(formData.get("vendorId") ?? "");
    const decision = String(formData.get("decision") ?? "") as "APPROVE" | "CONDITIONAL" | "REJECT";
    const reason = String(formData.get("reason") ?? "");
    const entityIds = formData.getAll("entityIds").map(String).filter(Boolean);
    const vendor = await decideVendorApproval(user, {
      vendorId,
      decision,
      reason,
      entityIds: entityIds.length ? entityIds : undefined,
    });
    touch(vendorId);
    revalidatePath("/vendors/prequalification");
    return { ok: true, data: null, message: `${vendor.name} is now ${vendor.status.toLowerCase()}.` };
  } catch (e) {
    return toActionError(e);
  }
}

/** Form variant used by the approval-decision modal. */
export async function decideVendorFormAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return decideVendorAction(formData);
}

export async function reinstateVendorAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const vendorId = String(formData.get("vendorId") ?? "");
    const vendor = await reinstateVendor(user, vendorId, String(formData.get("reason") ?? ""));
    touch(vendorId);
    revalidatePath("/vendors/blacklist");
    return {
      ok: true,
      data: null,
      message: `${vendor.name} reinstated on conditional status — a fresh evaluation is expected.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Performance ──────────────────────────────────────────── */

export async function recomputePerformanceAction(formData: FormData): Promise<ActionResult> {
  try {
    await requirePermission(P.VENDOR_EVALUATE, P.VENDOR_APPROVE, P.ANALYTICS_VIEW);
    const vendorId = blank(formData.get("vendorId"));
    const months = num(formData.get("months")) ?? 12;
    if (vendorId) {
      const end = new Date();
      const start = new Date(end.getTime() - months * 30 * 86400000);
      const perf = await computeVendorPerformance(vendorId, start, end);
      touch(vendorId);
      revalidatePath("/vendors/performance");
      return {
        ok: true,
        data: null,
        message: `Performance recomputed — score ${perf.score.toFixed(1)}, on-time ${perf.onTimePercent.toFixed(1)}%.`,
      };
    }
    const count = await recomputeAllVendorPerformance(months);
    revalidatePath("/vendors/performance");
    revalidatePath("/vendors");
    return { ok: true, data: null, message: `Performance recomputed for ${count} vendors.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Issues ───────────────────────────────────────────────── */

export async function raiseIssueAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const vendorId = String(formData.get("vendorId") ?? "");
    const issue = await raiseVendorIssue(user, {
      vendorId,
      issueType: String(formData.get("issueType") ?? "OTHER"),
      severity: String(formData.get("severity") ?? "MEDIUM"),
      title: String(formData.get("title") ?? "").trim(),
      description: String(formData.get("description") ?? "").trim(),
      relatedPoId: blank(formData.get("relatedPoId")),
      relatedGrnId: blank(formData.get("relatedGrnId")),
      relatedInvoiceId: blank(formData.get("relatedInvoiceId")),
    });
    touch(vendorId);
    revalidatePath("/vendors/issues");
    return { ok: true, data: { id: issue.id }, message: `${issue.number} raised against this vendor.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function updateIssueAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const issueId = String(formData.get("issueId") ?? "");
    const updated = await updateVendorIssue(user, issueId, {
      status: blank(formData.get("status")) ?? undefined,
      vendorResponse: blank(formData.get("vendorResponse")),
      resolution: blank(formData.get("resolution")),
    });
    revalidatePath(`/vendors/issues/${issueId}`);
    revalidatePath("/vendors/issues");
    touch(updated.vendorId);
    return { ok: true, data: null, message: `${updated.number} updated.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Investigation and blacklisting ───────────────────────── */

export async function openBlacklistCaseAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const vendorId = String(formData.get("vendorId") ?? "");
    const kase = await openBlacklistCase(user, {
      vendorId,
      reason: String(formData.get("reason") ?? "").trim(),
      reasonCode: String(formData.get("reasonCode") ?? "OTHER"),
      evidence: blank(formData.get("evidence")),
      auditRequired: formData.get("auditRequired") !== "false",
      suspendImmediately: bool(formData.get("suspendImmediately")),
    });
    touch(vendorId);
    revalidatePath("/vendors/blacklist");
    return {
      ok: true,
      data: { id: kase.id, number: kase.number },
      message: `Investigation ${kase.number} opened. Blacklisting can only follow the investigation, never precede it.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function advanceCaseAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const caseId = String(formData.get("caseId") ?? "");
    const to = String(formData.get("to") ?? "") as BlacklistStage;
    if (!to) throw new ValidationError("Select the stage to move to.");
    const decisionRaw = blank(formData.get("decision"));
    const kase = await advanceBlacklistCase(user, caseId, to, {
      notes: blank(formData.get("notes")),
      vendorResponse: blank(formData.get("vendorResponse")),
      procurementReview: blank(formData.get("procurementReview")),
      auditReview: blank(formData.get("auditReview")),
      decision: (decisionRaw ?? undefined) as "BLACKLIST" | "RETAIN" | "WARNING" | "SUSPEND" | undefined,
      decisionNotes: blank(formData.get("decisionNotes")),
    });
    revalidatePath(`/vendors/blacklist/${caseId}`);
    revalidatePath("/vendors/blacklist");
    touch(kase.vendorId);
    return { ok: true, data: null, message: `${kase.number} moved to ${to.replace(/_/g, " ").toLowerCase()}.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Options ──────────────────────────────────────────────── */

export async function vendorFormOptions() {
  const user = await requireUser();
  const [entities, criteria, categories] = await Promise.all([
    prisma.entity.findMany({
      where: { active: true, id: { in: user.entityIds } },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    prisma.evaluationCriterion.findMany({
      where: { active: true },
      orderBy: [{ group: "asc" }, { sequence: "asc" }],
    }),
    prisma.category.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return { entities, criteria, categories };
}

/** Purchase orders, GRNs and invoices a vendor issue can be pinned to. */
export async function vendorIssueTargets(vendorId: string) {
  await requireUser();
  const [pos, grns, invoices] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where: { vendorId },
      select: { id: true, number: true, total: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.grn.findMany({
      where: { vendorId },
      select: { id: true, number: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.invoice.findMany({
      where: { vendorId },
      select: { id: true, number: true, vendorInvoiceNumber: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  return { pos, grns, invoices };
}
