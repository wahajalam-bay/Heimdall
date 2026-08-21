"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import { COMPLIANCE_LEVELS, QUOTE_CHANNELS } from "@/lib/domain";
import {
  addRfqVendor,
  buildComparative,
  closeRfq,
  createRfq,
  issueRfq,
  markVendorDeclined,
  recommendVendor,
  recordNegotiation,
  upsertQuote,
  comparativeReadiness,
  DEFAULT_COMPARATIVE_CRITERIA,
  type QuoteItemInput,
} from "@/server/sourcing";
import { createCpcCase } from "@/server/cpc";
import { recordTraderCase } from "@/server/vendors";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const s = blank(v);
  return s === null ? null : Number(s);
};

/* ── RFQ ──────────────────────────────────────────────────── */

const rfqSchema = z.object({
  prId: z.string().min(1),
  title: z.string().trim().min(4, "Give the RFQ a title"),
  scope: z.string().trim().optional().nullable(),
  terms: z.string().trim().optional().nullable(),
  deliveryRequirement: z.string().trim().optional().nullable(),
  responseDeadline: z.string().min(1, "A response deadline is required"),
  vendorIds: z.array(z.string()).min(1, "Invite at least one vendor"),
});

export async function createRfqAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const vendorIds = formData.getAll("vendorIds").map(String).filter(Boolean);
    const parsed = rfqSchema.safeParse({
      prId: String(formData.get("prId") ?? ""),
      title: String(formData.get("title") ?? ""),
      scope: blank(formData.get("scope")),
      terms: blank(formData.get("terms")),
      deliveryRequirement: blank(formData.get("deliveryRequirement")),
      responseDeadline: String(formData.get("responseDeadline") ?? ""),
      vendorIds,
    });
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? "Please correct the highlighted fields.",
        parsed.error.issues.map((i) => i.message),
      );
    }

    const channels: Record<string, string> = {};
    for (const vid of vendorIds) {
      const ch = blank(formData.get(`channel_${vid}`));
      if (ch) channels[vid] = ch;
    }

    const rfq = await createRfq(
      user,
      {
        prId: parsed.data.prId,
        title: parsed.data.title,
        scope: parsed.data.scope,
        terms: parsed.data.terms,
        deliveryRequirement: parsed.data.deliveryRequirement,
        responseDeadline: new Date(parsed.data.responseDeadline),
        vendorIds: parsed.data.vendorIds,
        channels,
        overrideReason: blank(formData.get("overrideReason")),
      },
      prisma,
    );

    if (formData.get("issueNow") === "true") {
      await issueRfq(user, rfq.id);
    }
    revalidatePath("/rfq");
    revalidatePath(`/pr/${parsed.data.prId}`);
    return {
      ok: true,
      data: { id: rfq.id, number: rfq.number },
      message:
        formData.get("issueNow") === "true"
          ? `${rfq.number} created and issued to ${vendorIds.length} vendor(s).`
          : `${rfq.number} saved as a draft.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function issueRfqAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const rfqId = String(formData.get("rfqId") ?? "");
    const rfq = await issueRfq(user, rfqId);
    revalidatePath(`/rfq/${rfqId}`);
    return { ok: true, data: null, message: `${rfq.number} issued to the invited vendors.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function closeRfqAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const rfqId = String(formData.get("rfqId") ?? "");
    await closeRfq(user, rfqId);
    revalidatePath(`/rfq/${rfqId}`);
    return {
      ok: true,
      data: null,
      message: "RFQ closed. Vendors that never responded are marked as no-response.",
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function addRfqVendorAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const rfqId = String(formData.get("rfqId") ?? "");
    const vendorId = String(formData.get("vendorId") ?? "");
    const channel = blank(formData.get("channel")) ?? "EMAIL";
    await addRfqVendor(user, rfqId, vendorId, channel, blank(formData.get("reason")));
    revalidatePath(`/rfq/${rfqId}`);
    return { ok: true, data: null, message: "Vendor invited." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function declineVendorAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const rfqId = String(formData.get("rfqId") ?? "");
    const vendorId = String(formData.get("vendorId") ?? "");
    await markVendorDeclined(user, rfqId, vendorId, blank(formData.get("reason")));
    revalidatePath(`/rfq/${rfqId}`);
    return { ok: true, data: null, message: "Vendor recorded as declined." };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Quotations ───────────────────────────────────────────── */

const quoteItemSchema = z.object({
  prItemId: z.string().optional().nullable(),
  itemId: z.string().optional().nullable(),
  description: z.string().trim().min(1, "Description is required"),
  brand: z.string().trim().optional().nullable(),
  model: z.string().trim().optional().nullable(),
  specification: z.string().trim().optional().nullable(),
  quantity: z.coerce.number().positive("Quantity must be greater than zero"),
  unit: z.string().trim().min(1),
  unitPrice: z.coerce.number().min(0, "Unit price cannot be negative"),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  deliveryDays: z.coerce.number().int().min(0).optional().nullable(),
  compliance: z.enum(COMPLIANCE_LEVELS).optional(),
  notes: z.string().trim().optional().nullable(),
});

export async function saveQuoteAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const rfqId = String(formData.get("rfqId") ?? "");
    const vendorId = String(formData.get("vendorId") ?? "");
    if (!rfqId || !vendorId) throw new ValidationError("Missing RFQ or vendor reference.");

    let items: QuoteItemInput[];
    try {
      const arr = JSON.parse(String(formData.get("items") ?? "[]")) as unknown[];
      const validated = z.array(quoteItemSchema).min(1, "A quotation needs at least one priced line").safeParse(arr);
      if (!validated.success) {
        throw new ValidationError(
          "One or more quotation lines are incomplete.",
          validated.error.issues.map((i) => `Line ${Number(i.path[0]) + 1}: ${i.message}`),
        );
      }
      items = validated.data.map((i) => ({
        prItemId: i.prItemId ?? null,
        itemId: i.itemId ?? null,
        description: i.description,
        brand: i.brand ?? null,
        model: i.model ?? null,
        specification: i.specification ?? null,
        quantity: i.quantity,
        unit: i.unit,
        unitPrice: i.unitPrice,
        taxRate: i.taxRate ?? 0,
        deliveryDays: i.deliveryDays ?? null,
        compliance: i.compliance,
        notes: i.notes ?? null,
      }));
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      throw new ValidationError("Quotation lines could not be read.");
    }

    const channel = blank(formData.get("channel")) ?? "EMAIL";
    if (!QUOTE_CHANNELS.includes(channel as never)) throw new ValidationError("Unknown quotation channel.");

    const quote = await upsertQuote(user, {
      rfqId,
      vendorId,
      quoteRef: blank(formData.get("quoteRef")),
      quoteDate: blank(formData.get("quoteDate")) ? new Date(String(formData.get("quoteDate"))) : new Date(),
      validUntil: blank(formData.get("validUntil")) ? new Date(String(formData.get("validUntil"))) : null,
      deliveryCharges: num(formData.get("deliveryCharges")) ?? 0,
      otherCharges: num(formData.get("otherCharges")) ?? 0,
      discount: num(formData.get("discount")) ?? 0,
      taxRegistered: formData.get("taxRegistered") === "on" || formData.get("taxRegistered") === "true",
      deliveryDays: num(formData.get("deliveryDays")),
      paymentTerms: blank(formData.get("paymentTerms")),
      creditDays: num(formData.get("creditDays")),
      warrantyMonths: num(formData.get("warrantyMonths")),
      warrantyTerms: blank(formData.get("warrantyTerms")),
      technicalCompliance: (blank(formData.get("technicalCompliance")) ?? "NOT_ASSESSED") as never,
      complianceNotes: blank(formData.get("complianceNotes")),
      exceptions: blank(formData.get("exceptions")),
      notes: blank(formData.get("notes")),
      channel,
      items,
    });

    revalidatePath(`/rfq/${rfqId}`);
    revalidatePath("/quotes");
    return { ok: true, data: { id: quote.id, number: quote.number }, message: `Quotation ${quote.number} recorded.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Negotiation ──────────────────────────────────────────── */

export async function recordNegotiationAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const quoteId = String(formData.get("quoteId") ?? "");
    const negotiatedTotal = num(formData.get("negotiatedTotal"));
    if (negotiatedTotal === null) throw new ValidationError("Enter the negotiated total.");
    const neg = await recordNegotiation(user, {
      quoteId,
      negotiatedTotal,
      finalTotal: num(formData.get("finalTotal")),
      channel: blank(formData.get("channel")) ?? "CALL",
      notes: blank(formData.get("notes")),
      outcome: (blank(formData.get("outcome")) ?? "OPEN") as never,
    });
    const quote = await prisma.vendorQuote.findUnique({ where: { id: quoteId }, select: { rfqId: true } });
    if (quote) revalidatePath(`/rfq/${quote.rfqId}`);
    return {
      ok: true,
      data: null,
      message: `Round ${neg.round} recorded — PKR ${Math.round(neg.savings).toLocaleString("en-PK")} conceded.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Comparative ──────────────────────────────────────────── */

export async function buildComparativeAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const rfqId = String(formData.get("rfqId") ?? "");
    const criteria = DEFAULT_COMPARATIVE_CRITERIA.map((c) => {
      const w = num(formData.get(`weight_${c.key}`));
      return { ...c, weight: w === null ? c.weight : w };
    });
    const totalWeight = criteria.reduce((a, c) => a + c.weight, 0);
    if (totalWeight <= 0) throw new ValidationError("Evaluation weights must add up to more than zero.");

    const comparative = await buildComparative(user, {
      rfqId,
      marketPrice: num(formData.get("marketPrice")),
      criteria,
      notes: blank(formData.get("notes")),
    });
    revalidatePath(`/rfq/${rfqId}`);
    revalidatePath("/comparatives");
    return {
      ok: true,
      data: { id: comparative.id, number: comparative.number },
      message: `${comparative.number} prepared. Review the ranking, then record a recommendation.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function recommendVendorAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const comparativeId = String(formData.get("comparativeId") ?? "");
    const quoteId = String(formData.get("quoteId") ?? "");
    if (!quoteId) throw new ValidationError("Select the vendor you are recommending.");
    const result = await recommendVendor(user, {
      comparativeId,
      quoteId,
      basis: String(formData.get("basis") ?? ""),
      nonLowestJustification: blank(formData.get("nonLowestJustification")),
    });
    revalidatePath(`/comparatives/${comparativeId}`);
    revalidatePath(`/pr/${result.comparative.prId}`);
    return {
      ok: true,
      data: { prId: result.comparative.prId },
      message: `${result.chosen.vendor.name} recommended${result.isBenchmark ? " as the lowest compliant quotation" : " above the lowest compliant quotation, with justification recorded"}.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function raiseCpcCaseAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const comparativeId = String(formData.get("comparativeId") ?? "");
    const kase = await createCpcCase(user, {
      comparativeId,
      recommendation: blank(formData.get("recommendation")),
      riskNotes: blank(formData.get("riskNotes")),
    });
    revalidatePath(`/comparatives/${comparativeId}`);
    revalidatePath("/cpc/cases");
    return { ok: true, data: { id: kase.id }, message: `${kase.number} raised and the committee has been notified.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function comparativeReadinessAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const comparativeId = String(formData.get("comparativeId") ?? "");
    const r = await comparativeReadiness(comparativeId);
    return {
      ok: true,
      data: { issues: r.issues, quoteCount: r.quoteCount, minQuotes: r.minQuotes },
      message: r.issues.length ? `${r.issues.length} issue(s) to resolve.` : "This comparative is ready to advance.",
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function recordTraderCaseAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await recordTraderCase(user, {
      prId: String(formData.get("prId") ?? ""),
      principalVendorId: String(formData.get("principalVendorId") ?? ""),
      traderVendorId: String(formData.get("traderVendorId") ?? ""),
      moq: num(formData.get("moq")) ?? 0,
      requiredQuantity: num(formData.get("requiredQuantity")) ?? 0,
      priceDifference: num(formData.get("priceDifference")) ?? 0,
      deliveryDays: num(formData.get("deliveryDays")),
      deliveryCharges: num(formData.get("deliveryCharges")),
      reason: String(formData.get("reason") ?? ""),
    });
    revalidatePath(`/pr/${String(formData.get("prId") ?? "")}`);
    return { ok: true, data: null, message: "Trader / MOQ case recorded against the requisition." };
  } catch (e) {
    return toActionError(e);
  }
}

/** Vendors eligible to be invited, with their eligibility reason. */
export async function eligibleVendors(entityId: string | null) {
  await requireUser();
  const vendors = await prisma.vendor.findMany({
    where: {
      ...(entityId ? { entityLinks: { some: { entityId } } } : {}),
    },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      city: true,
      businessType: true,
      taxStatus: true,
      categories: true,
      isTrader: true,
      minimumOrderValue: true,
      performanceScore: true,
      onTimePercent: true,
      scorePercent: true,
      statusReason: true,
      creditDays: true,
      paymentTerms: true,
    },
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });
  return vendors;
}
