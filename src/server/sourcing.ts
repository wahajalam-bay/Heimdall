import { prisma, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { CONFIG_KEYS, getConfig, getConfigBool, getConfigNumber } from "@/lib/config";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify, createTask, completeTasks } from "@/lib/notify";
import { raiseException } from "@/lib/exceptions-service";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { VENDOR_SOURCEABLE_STATUSES, type ComplianceLevel } from "@/lib/domain";
import { round2, variancePercent } from "@/lib/format";
import { transitionPr, assertRequisitionComplete } from "./pr";

/**
 * Sourcing: RFQ issue, vendor invitation, quotation capture, comparative
 * analysis, negotiation rounds and vendor selection.
 */

/* ── Vendor eligibility ───────────────────────────────────── */

export type VendorEligibility = { eligible: boolean; reason?: string; overridable: boolean
  /**
   * PC-018 · The vendor is sourceable but carries no performance rating. The
   * caller records this rather than letting the absence pass unremarked.
   */
  raiseUnratedException?: boolean;
};

/**
 * Blacklisted and suspended vendors are blocked from sourcing. An override is
 * possible only when configuration allows it and the actor holds the blacklist
 * permission — and it is always recorded.
 */
export async function checkVendorEligibility(
  vendorId: string,
  entityId: string | null,
  db: DbClient = prisma,
): Promise<VendorEligibility> {
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) return { eligible: false, reason: "Vendor not found.", overridable: false };

  const block = await getConfigBool(CONFIG_KEYS.BLOCK_BLACKLISTED_VENDORS, entityId, db);
  const allowOverride = await getConfigBool(CONFIG_KEYS.ALLOW_BLACKLIST_OVERRIDE, entityId, db);

  if (vendor.status === "BLACKLISTED") {
    return {
      eligible: !block,
      reason: `${vendor.name} is blacklisted${vendor.statusReason ? `: ${vendor.statusReason}` : ""}.`,
      overridable: allowOverride,
    };
  }
  if (vendor.status === "SUSPENDED") {
    return {
      eligible: !block,
      reason: `${vendor.name} is suspended${vendor.statusReason ? `: ${vendor.statusReason}` : ""}.`,
      overridable: allowOverride,
    };
  }
  if (!VENDOR_SOURCEABLE_STATUSES.includes(vendor.status as never)) {
    return {
      eligible: false,
      reason: `${vendor.name} is not an approved vendor (status: ${vendor.status}). Complete pre-qualification first.`,
      overridable: true,
    };
  }

  // PC-021 · Pre-qualification validity. ZD §2.3.1 iii sets two years with
  // mandatory re-qualification; ZAM states no period at all. So the months come
  // from the entity's own policy and 0 means the control is inactive here —
  // ZAM does not inherit ZD's expiry, and ZD's expiry is not optional.
  const validityMonths = await getConfigNumber(CONFIG_KEYS.POLICY_PQ_VALIDITY_MONTHS, entityId, db);
  if (validityMonths > 0 && vendor.approvedAt) {
    const expiresAt = new Date(vendor.approvedAt);
    expiresAt.setMonth(expiresAt.getMonth() + validityMonths);
    if (expiresAt < new Date()) {
      return {
        eligible: false,
        reason:
          `${vendor.name}'s pre-qualification expired on ${expiresAt.toISOString().slice(0, 10)} ` +
          `(valid ${validityMonths} months from approval). Re-qualification is required before sourcing.`,
        overridable: true,
      };
    }
  }

  // PC-018 · ZD §2.3.3 ii bars business with a vendor "not having satisfactory
  // performance rating". Neither SOP says what an *unrated* vendor is, and every
  // newly approved vendor is unrated until its first evaluation — so blocking
  // by default would stop exactly the vendors the pre-qualification process just
  // approved. The treatment is policy, and the default neither invents a bar nor
  // hides the gap.
  const unrated = await getConfig<string>(CONFIG_KEYS.POLICY_UNRATED_VENDOR_TREATMENT, entityId, db);
  const hasRating = typeof vendor.performanceScore === "number";

  if (!hasRating && String(unrated) === "UNRATED-BLOCK") {
    return {
      eligible: false,
      reason:
        `${vendor.name} has no performance rating, and this entity's policy requires a satisfactory rating before business is transacted (ZD §2.3.3 ii).`,
      overridable: true,
    };
  }
  if (!hasRating && String(unrated) === "UNRATED-ALLOW-WITH-EXCEPTION") {
    return {
      eligible: true,
      overridable: false,
      reason: `${vendor.name} has no performance rating yet. Sourcing is permitted and the gap is recorded.`,
      raiseUnratedException: true,
    };
  }
  return { eligible: true, overridable: false };
}

/* ── RFQ ──────────────────────────────────────────────────── */

export type RfqInput = {
  prId: string;
  title: string;
  scope?: string | null;
  terms?: string | null;
  deliveryRequirement?: string | null;
  responseDeadline: Date;
  vendorIds: string[];
  channels?: Record<string, string>;
  /** Reason recorded when a blocked vendor is invited anyway. */
  overrideReason?: string | null;
};

export async function createRfq(user: SessionUser, input: RfqInput, db: DbClient = prisma) {
  if (!userHasPermission(user, P.RFQ_ISSUE)) {
    throw new ForbiddenError("You do not have permission to create RFQs.");
  }
  const pr = await db.purchaseRequisition.findUnique({
    where: { id: input.prId },
    include: { items: true },
  });
  if (!pr) throw new NotFoundError("Requisition");

  // The requisition module has to be finished before this one starts.
  await assertRequisitionComplete(pr.id, "Raising an RFQ", db);
  if (!input.vendorIds.length) throw new ValidationError("Invite at least one vendor.");
  if (input.responseDeadline.getTime() < Date.now() - 60_000) {
    throw new ValidationError("The response deadline must be in the future.");
  }

  // Vendor gating before anything is written.
  const blocked: string[] = [];
  for (const vid of input.vendorIds) {
    const check = await checkVendorEligibility(vid, pr.entityId, db);
    if (!check.eligible) {
      if (!check.overridable || !input.overrideReason?.trim() || !userHasPermission(user, P.VENDOR_BLACKLIST)) {
        blocked.push(check.reason ?? "Vendor is not eligible.");
      }
    }
  }
  if (blocked.length) {
    throw new RuleViolationError(
      "One or more vendors cannot be invited to this RFQ.",
      blocked,
    );
  }

  const number = await nextNumber(SEQ.RFQ, db);
  const rfq = await db.rfq.create({
    data: {
      number,
      prId: pr.id,
      title: input.title.trim() || `Sourcing for ${pr.number}`,
      scope: input.scope ?? null,
      terms: input.terms ?? null,
      deliveryRequirement: input.deliveryRequirement ?? null,
      responseDeadline: input.responseDeadline,
      status: "DRAFT",
      createdById: user.id,
      vendors: {
        create: input.vendorIds.map((vid) => ({
          vendorId: vid,
          status: "INVITED",
          channel: input.channels?.[vid] ?? "EMAIL",
        })),
      },
    },
  });

  if (pr.status !== "SOURCING") {
    if (pr.status === "APPROVED") await transitionPr(user, pr.id, "PROCUREMENT_REVIEW", {}, db);
    await transitionPr(user, pr.id, "SOURCING", {}, db);
  }

  await writeAudit(
    {
      entityType: "Rfq",
      entityId: rfq.id,
      entityRef: rfq.number,
      action: "RFQ_CREATED",
      newValue: { prNumber: pr.number, vendors: input.vendorIds.length, deadline: input.responseDeadline },
      reason: input.overrideReason ?? null,
      caseKey: pr.number,
      actor: user,
    },
    db,
  );

  return rfq;
}

export async function issueRfq(user: SessionUser, rfqId: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.RFQ_ISSUE)) {
    throw new ForbiddenError("You do not have permission to issue RFQs.");
  }
  const rfq = await db.rfq.findUnique({
    where: { id: rfqId },
    include: { vendors: { include: { vendor: true } }, pr: true },
  });
  if (!rfq) throw new NotFoundError("RFQ");
  if (rfq.status !== "DRAFT") throw new RuleViolationError(`RFQ ${rfq.number} has already been issued.`);
  if (!rfq.vendors.length) throw new RuleViolationError("Invite at least one vendor before issuing.");

  const updated = await db.rfq.update({
    where: { id: rfqId },
    data: { status: "ISSUED", issuedAt: new Date() },
  });

  const slaHours = await getConfigNumber(CONFIG_KEYS.SLA_RFQ_RESPONSE_HOURS, rfq.pr.entityId, db);
  await createTask(
    {
      title: `Collect quotations for ${rfq.number}`,
      description: `${rfq.vendors.length} vendor(s) invited · deadline ${rfq.responseDeadline.toISOString().slice(0, 10)}`,
      taskType: "DATA_ENTRY",
      assignedRoleCode: "PROCUREMENT_OFFICER",
      entityId: rfq.pr.entityId,
      documentType: "RFQ",
      documentId: rfq.id,
      documentRef: rfq.number,
      slaHours,
      linkUrl: `/rfq/${rfq.id}`,
    },
    db,
  );
  await notify(
    {
      roleCodes: ["PROCUREMENT_OFFICER", "BUYER"],
      entityId: rfq.pr.entityId,
      type: "RFQ_RESPONSE_PENDING",
      title: `${rfq.number} issued to ${rfq.vendors.length} vendor(s)`,
      body: rfq.title,
      linkType: "RFQ",
      linkId: rfq.id,
      linkUrl: `/rfq/${rfq.id}`,
    },
    db,
  );

  await writeAudit(
    {
      entityType: "Rfq",
      entityId: rfq.id,
      entityRef: rfq.number,
      action: "RFQ_ISSUED",
      newValue: { vendors: rfq.vendors.map((v) => v.vendor.name) },
      caseKey: rfq.pr.number,
      actor: user,
    },
    db,
  );

  return updated;
}

export async function addRfqVendor(
  user: SessionUser,
  rfqId: string,
  vendorId: string,
  channel: string,
  overrideReason: string | null,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.RFQ_ISSUE)) throw new ForbiddenError("Not permitted.");
  const rfq = await db.rfq.findUnique({ where: { id: rfqId }, include: { pr: true } });
  if (!rfq) throw new NotFoundError("RFQ");
  if (["CLOSED", "AWARDED", "CANCELLED"].includes(rfq.status)) {
    throw new RuleViolationError(`RFQ ${rfq.number} is ${rfq.status} — vendors cannot be added.`);
  }
  const check = await checkVendorEligibility(vendorId, rfq.pr.entityId, db);
  if (!check.eligible) {
    if (!check.overridable || !overrideReason?.trim() || !userHasPermission(user, P.VENDOR_BLACKLIST)) {
      throw new RuleViolationError(check.reason ?? "Vendor is not eligible for sourcing.");
    }
  }
  const existing = await db.rfqVendor.findFirst({ where: { rfqId, vendorId } });
  if (existing) throw new RuleViolationError("That vendor is already invited to this RFQ.");

  const rv = await db.rfqVendor.create({ data: { rfqId, vendorId, channel, status: "INVITED" } });
  await writeAudit(
    {
      entityType: "Rfq",
      entityId: rfqId,
      entityRef: rfq.number,
      action: "RFQ_VENDOR_ADDED",
      newValue: { vendorId, channel },
      reason: overrideReason,
      caseKey: rfq.pr.number,
      actor: user,
    },
    db,
  );
  return rv;
}

export async function closeRfq(user: SessionUser, rfqId: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.RFQ_ISSUE)) throw new ForbiddenError("Not permitted.");
  const rfq = await db.rfq.findUnique({ where: { id: rfqId }, include: { pr: true, quotes: true } });
  if (!rfq) throw new NotFoundError("RFQ");
  await db.rfqVendor.updateMany({
    where: { rfqId, status: "INVITED" },
    data: { status: "NO_RESPONSE" },
  });
  const updated = await db.rfq.update({
    where: { id: rfqId },
    data: { status: "CLOSED", closedAt: new Date() },
  });
  await completeTasks("RFQ", rfqId, user.id, db);
  await writeAudit(
    {
      entityType: "Rfq",
      entityId: rfqId,
      entityRef: rfq.number,
      action: "RFQ_CLOSED",
      newValue: { quotesReceived: rfq.quotes.length },
      caseKey: rfq.pr.number,
      actor: user,
    },
    db,
  );
  return updated;
}

/* ── Quotations ───────────────────────────────────────────── */

export type QuoteItemInput = {
  prItemId?: string | null;
  itemId?: string | null;
  description: string;
  brand?: string | null;
  model?: string | null;
  specification?: string | null;
  quantity: number;
  unit: string;
  unitPrice: number;
  taxRate?: number;
  deliveryDays?: number | null;
  compliance?: ComplianceLevel;
  notes?: string | null;
};

export type QuoteInput = {
  rfqId: string;
  vendorId: string;
  quoteRef?: string | null;
  quoteDate?: Date;
  validUntil?: Date | null;
  deliveryCharges?: number;
  otherCharges?: number;
  discount?: number;
  taxRegistered?: boolean;
  deliveryDays?: number | null;
  paymentTerms?: string | null;
  creditDays?: number | null;
  warrantyMonths?: number | null;
  warrantyTerms?: string | null;
  technicalCompliance?: ComplianceLevel;
  complianceNotes?: string | null;
  exceptions?: string | null;
  notes?: string | null;
  channel?: string;
  items: QuoteItemInput[];
};

function quoteTotals(input: QuoteInput) {
  const items = input.items.map((it, i) => {
    const lineNet = round2(it.unitPrice * it.quantity);
    const taxAmount = round2(lineNet * ((it.taxRate ?? 0) / 100));
    return {
      ...it,
      lineNo: i + 1,
      taxRate: it.taxRate ?? 0,
      taxAmount,
      lineTotal: round2(lineNet + taxAmount),
      net: lineNet,
    };
  });
  const subtotal = round2(items.reduce((a, i) => a + i.net, 0));
  const taxAmount = round2(items.reduce((a, i) => a + i.taxAmount, 0));
  const total = round2(
    subtotal + taxAmount + (input.deliveryCharges ?? 0) + (input.otherCharges ?? 0) - (input.discount ?? 0),
  );
  return { items, subtotal, taxAmount, total };
}

export async function upsertQuote(user: SessionUser, input: QuoteInput, db: DbClient = prisma) {
  if (!userHasPermission(user, P.QUOTE_ENTER)) {
    throw new ForbiddenError("You do not have permission to enter vendor quotations.");
  }
  const rfq = await db.rfq.findUnique({ where: { id: input.rfqId }, include: { pr: true } });
  if (!rfq) throw new NotFoundError("RFQ");
  if (["CANCELLED", "AWARDED"].includes(rfq.status)) {
    throw new RuleViolationError(`RFQ ${rfq.number} is ${rfq.status} — quotations cannot be changed.`);
  }
  if (!input.items.length) throw new ValidationError("A quotation needs at least one priced line.");
  for (const it of input.items) {
    if (!(it.quantity > 0)) throw new ValidationError(`Quantity must be greater than zero for "${it.description}".`);
    if (it.unitPrice < 0) throw new ValidationError(`Unit price cannot be negative for "${it.description}".`);
  }

  const eligibility = await checkVendorEligibility(input.vendorId, rfq.pr.entityId, db);
  if (!eligibility.eligible && !eligibility.overridable) {
    throw new RuleViolationError(eligibility.reason ?? "Vendor is not eligible.");
  }

  const { items, subtotal, taxAmount, total } = quoteTotals(input);
  const existing = await db.vendorQuote.findFirst({
    where: { rfqId: input.rfqId, vendorId: input.vendorId },
  });

  const payload = {
    quoteRef: input.quoteRef ?? null,
    quoteDate: input.quoteDate ?? new Date(),
    validUntil: input.validUntil ?? null,
    subtotal,
    taxAmount,
    deliveryCharges: input.deliveryCharges ?? 0,
    otherCharges: input.otherCharges ?? 0,
    discount: input.discount ?? 0,
    total,
    taxRegistered: input.taxRegistered ?? true,
    deliveryDays: input.deliveryDays ?? null,
    paymentTerms: input.paymentTerms ?? null,
    creditDays: input.creditDays ?? null,
    warrantyMonths: input.warrantyMonths ?? null,
    warrantyTerms: input.warrantyTerms ?? null,
    technicalCompliance: input.technicalCompliance ?? "NOT_ASSESSED",
    complianceNotes: input.complianceNotes ?? null,
    exceptions: input.exceptions ?? null,
    notes: input.notes ?? null,
    channel: input.channel ?? "EMAIL",
    enteredById: user.id,
    status: "SUBMITTED",
  };

  let quote;
  if (existing) {
    await db.quoteItem.deleteMany({ where: { quoteId: existing.id } });
    quote = await db.vendorQuote.update({
      where: { id: existing.id },
      data: {
        ...payload,
        items: {
          create: items.map((it) => ({
            prItemId: it.prItemId ?? null,
            itemId: it.itemId ?? null,
            lineNo: it.lineNo,
            description: it.description,
            brand: it.brand ?? null,
            model: it.model ?? null,
            specification: it.specification ?? null,
            quantity: it.quantity,
            unit: it.unit,
            unitPrice: it.unitPrice,
            taxRate: it.taxRate,
            taxAmount: it.taxAmount,
            lineTotal: it.lineTotal,
            deliveryDays: it.deliveryDays ?? null,
            compliance: it.compliance ?? "NOT_ASSESSED",
            notes: it.notes ?? null,
          })),
        },
      },
    });
  } else {
    const number = await nextNumber(SEQ.QUOTE, db);
    quote = await db.vendorQuote.create({
      data: {
        number,
        rfqId: input.rfqId,
        vendorId: input.vendorId,
        ...payload,
        items: {
          create: items.map((it) => ({
            prItemId: it.prItemId ?? null,
            itemId: it.itemId ?? null,
            lineNo: it.lineNo,
            description: it.description,
            brand: it.brand ?? null,
            model: it.model ?? null,
            specification: it.specification ?? null,
            quantity: it.quantity,
            unit: it.unit,
            unitPrice: it.unitPrice,
            taxRate: it.taxRate,
            taxAmount: it.taxAmount,
            lineTotal: it.lineTotal,
            deliveryDays: it.deliveryDays ?? null,
            compliance: it.compliance ?? "NOT_ASSESSED",
            notes: it.notes ?? null,
          })),
        },
      },
    });
  }

  await db.rfqVendor.updateMany({
    where: { rfqId: input.rfqId, vendorId: input.vendorId },
    data: { status: "QUOTED", respondedAt: new Date() },
  });
  if (rfq.status === "ISSUED") {
    await db.rfq.update({ where: { id: rfq.id }, data: { status: "RESPONSES_IN" } });
  }

  // Feed price history so future comparatives have a previous-price baseline.
  for (const it of items) {
    if (it.itemId) {
      await db.priceHistory.create({
        data: {
          itemId: it.itemId,
          vendorId: input.vendorId,
          unitPrice: it.unitPrice,
          quantity: it.quantity,
          source: "QUOTE",
          sourceRef: quote.number,
        },
      });
    }
  }

  await writeAudit(
    {
      entityType: "VendorQuote",
      entityId: quote.id,
      entityRef: quote.number,
      action: existing ? "QUOTE_UPDATED" : "QUOTE_RECEIVED",
      newValue: { vendorId: input.vendorId, total, lines: items.length, compliance: payload.technicalCompliance },
      caseKey: rfq.pr.number,
      actor: user,
    },
    db,
  );

  await notify(
    {
      roleCodes: ["PROCUREMENT_OFFICER", "BUYER"],
      entityId: rfq.pr.entityId,
      type: "QUOTE_RECEIVED",
      title: `Quotation ${quote.number} recorded for ${rfq.number}`,
      body: `PKR ${total.toLocaleString("en-PK")}`,
      linkType: "RFQ",
      linkId: rfq.id,
      linkUrl: `/rfq/${rfq.id}`,
    },
    db,
  );

  return quote;
}

export async function markVendorDeclined(
  user: SessionUser,
  rfqId: string,
  vendorId: string,
  notes: string | null,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.QUOTE_ENTER)) throw new ForbiddenError("Not permitted.");
  await db.rfqVendor.updateMany({
    where: { rfqId, vendorId },
    data: { status: "DECLINED", respondedAt: new Date(), notes },
  });
  const rfq = await db.rfq.findUnique({ where: { id: rfqId }, include: { pr: true } });
  await writeAudit(
    {
      entityType: "Rfq",
      entityId: rfqId,
      entityRef: rfq?.number ?? rfqId,
      action: "RFQ_VENDOR_DECLINED",
      newValue: { vendorId },
      reason: notes,
      caseKey: rfq?.pr.number ?? null,
      actor: user,
    },
    db,
  );
}

/* ── Negotiation ──────────────────────────────────────────── */

export async function recordNegotiation(
  user: SessionUser,
  input: {
    quoteId: string;
    negotiatedTotal: number;
    finalTotal?: number | null;
    channel?: string;
    notes?: string | null;
    outcome?: "OPEN" | "ACCEPTED" | "REJECTED" | "VENDOR_DECLINED";
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.NEGOTIATE)) {
    throw new ForbiddenError("You do not have permission to record negotiations.");
  }
  const quote = await db.vendorQuote.findUnique({
    where: { id: input.quoteId },
    include: { negotiations: { orderBy: { round: "desc" } }, rfq: { include: { pr: true } }, vendor: true },
  });
  if (!quote) throw new NotFoundError("Quotation");
  if (input.negotiatedTotal <= 0) throw new ValidationError("Negotiated total must be greater than zero.");

  const baseline = quote.negotiations[0]?.negotiatedTotal ?? quote.total;
  const round = (quote.negotiations[0]?.round ?? 0) + 1;
  const savings = round2(baseline - input.negotiatedTotal);

  const neg = await db.negotiation.create({
    data: {
      quoteId: quote.id,
      round,
      originalTotal: baseline,
      negotiatedTotal: input.negotiatedTotal,
      finalTotal: input.finalTotal ?? null,
      savings,
      savingsPercent: baseline > 0 ? round2((savings / baseline) * 100) : 0,
      channel: input.channel ?? "CALL",
      negotiatedById: user.id,
      notes: input.notes ?? null,
      outcome: input.outcome ?? "OPEN",
    },
  });

  await writeAudit(
    {
      entityType: "Negotiation",
      entityId: neg.id,
      entityRef: `${quote.number} R${round}`,
      action: "NEGOTIATION_RECORDED",
      newValue: {
        vendor: quote.vendor.name,
        round,
        from: baseline,
        to: input.negotiatedTotal,
        savings,
        channel: neg.channel,
      },
      reason: input.notes ?? null,
      caseKey: quote.rfq.pr.number,
      actor: user,
    },
    db,
  );

  return neg;
}

/** Latest negotiated value for a quote, or the quoted total if never negotiated. */
export async function effectiveQuoteTotal(quoteId: string, db: DbClient = prisma): Promise<number> {
  const quote = await db.vendorQuote.findUnique({
    where: { id: quoteId },
    include: { negotiations: { orderBy: { round: "desc" }, take: 1 } },
  });
  if (!quote) return 0;
  const n = quote.negotiations[0];
  return n ? (n.finalTotal ?? n.negotiatedTotal) : quote.total;
}

/* ── Comparative ──────────────────────────────────────────── */

export type ComparativeCriterion = { key: string; label: string; weight: number };

export const DEFAULT_COMPARATIVE_CRITERIA: ComparativeCriterion[] = [
  { key: "price", label: "Price", weight: 40 },
  { key: "compliance", label: "Technical compliance", weight: 20 },
  { key: "delivery", label: "Delivery lead time", weight: 15 },
  { key: "vendor", label: "Vendor performance", weight: 15 },
  { key: "warranty", label: "Warranty & after-sales", weight: 5 },
  { key: "terms", label: "Payment terms", weight: 5 },
];

const COMPLIANCE_SCORE: Record<string, number> = {
  COMPLIANT: 1,
  PARTIAL: 0.5,
  NON_COMPLIANT: 0,
  NOT_ASSESSED: 0.35,
};

/**
 * Builds (or rebuilds) a comparative from every quotation on the RFQ, computing
 * lowest / lowest-compliant flags, previous and market price baselines, variance
 * and a weighted multi-criteria score. Nothing is auto-selected.
 */
export async function buildComparative(
  user: SessionUser,
  input: { rfqId: string; marketPrice?: number | null; criteria?: ComparativeCriterion[]; notes?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.COMPARATIVE_CREATE)) {
    throw new ForbiddenError("You do not have permission to build comparatives.");
  }
  const rfq = await db.rfq.findUnique({
    where: { id: input.rfqId },
    include: {
      pr: { include: { items: true } },
      quotes: {
        where: { status: { notIn: ["REJECTED", "EXPIRED"] } },
        include: {
          vendor: true,
          items: true,
          negotiations: { orderBy: { round: "desc" }, take: 1 },
        },
      },
    },
  });
  if (!rfq) throw new NotFoundError("RFQ");
  if (!rfq.quotes.length) {
    throw new RuleViolationError(`No quotations have been recorded against ${rfq.number}.`);
  }

  const criteria = input.criteria ?? DEFAULT_COMPARATIVE_CRITERIA;

  // Previous purchase price baseline from historical POs for the same items.
  const itemIds = rfq.pr.items.map((i) => i.itemId).filter((x): x is string => !!x);
  let previousPrice: number | null = null;
  if (itemIds.length) {
    const hist = await db.priceHistory.findMany({
      where: { itemId: { in: itemIds }, source: "PO" },
      orderBy: { recordedAt: "desc" },
      take: 40,
    });
    if (hist.length) {
      // Value the PR basket at the most recent PO price per item.
      const latestByItem = new Map<string, number>();
      for (const h of hist) if (!latestByItem.has(h.itemId)) latestByItem.set(h.itemId, h.unitPrice);
      let basket = 0;
      let covered = 0;
      for (const li of rfq.pr.items) {
        if (li.itemId && latestByItem.has(li.itemId)) {
          basket += latestByItem.get(li.itemId)! * li.quantity;
          covered++;
        }
      }
      if (covered > 0) previousPrice = round2(basket);
    }
  }

  const lines = rfq.quotes.map((q) => {
    const neg = q.negotiations[0];
    const negotiatedTotal = neg ? (neg.finalTotal ?? neg.negotiatedTotal) : null;
    const netTotal = negotiatedTotal ?? q.total;
    const totalQty = q.items.reduce((a, i) => a + i.quantity, 0);
    return {
      quote: q,
      vendorId: q.vendorId,
      unitPriceAvg: totalQty > 0 ? round2(q.items.reduce((a, i) => a + i.unitPrice * i.quantity, 0) / totalQty) : 0,
      subtotal: q.subtotal,
      taxAmount: q.taxAmount,
      deliveryCharges: q.deliveryCharges,
      total: q.total,
      negotiatedTotal,
      netTotal,
      deliveryDays: q.deliveryDays,
      paymentTerms: q.paymentTerms,
      warrantyMonths: q.warrantyMonths,
      technicalCompliance: q.technicalCompliance,
      vendorScore: q.vendor.performanceScore ?? q.vendor.scorePercent ?? null,
      vendorOnTimePercent: q.vendor.onTimePercent ?? null,
      previousPrice,
      marketPrice: input.marketPrice ?? null,
      variancePercent: variancePercent(netTotal, previousPrice ?? input.marketPrice ?? null),
    };
  });

  const lowestTotal = Math.min(...lines.map((l) => l.netTotal));
  const compliantLines = lines.filter((l) => l.technicalCompliance === "COMPLIANT");
  const lowestCompliantTotal = compliantLines.length
    ? Math.min(...compliantLines.map((l) => l.netTotal))
    : null;

  // Weighted scoring: each criterion normalised 0..1 across the field.
  const minDelivery = Math.min(...lines.map((l) => l.deliveryDays ?? 9999));
  const maxDelivery = Math.max(...lines.map((l) => l.deliveryDays ?? 0));
  const maxWarranty = Math.max(...lines.map((l) => l.warrantyMonths ?? 0), 1);
  const maxCredit = Math.max(...lines.map((l) => l.quote.creditDays ?? 0), 1);
  const maxNet = Math.max(...lines.map((l) => l.netTotal), 1);

  const weightOf = (k: string) => criteria.find((c) => c.key === k)?.weight ?? 0;
  const totalWeight = criteria.reduce((a, c) => a + c.weight, 0) || 1;

  const scored = lines.map((l) => {
    const priceScore = lowestTotal > 0 ? lowestTotal / l.netTotal : l.netTotal === 0 ? 1 : 0;
    const complianceScore = COMPLIANCE_SCORE[l.technicalCompliance] ?? 0.35;
    const deliveryScore =
      l.deliveryDays === null || l.deliveryDays === undefined
        ? 0.4
        : maxDelivery === minDelivery
          ? 1
          : 1 - (l.deliveryDays - minDelivery) / (maxDelivery - minDelivery);
    const vendorScoreNorm = l.vendorScore !== null ? Math.min(1, l.vendorScore / 100) : 0.5;
    const warrantyScore = (l.warrantyMonths ?? 0) / maxWarranty;
    const termsScore = (l.quote.creditDays ?? 0) / maxCredit;

    const breakdown = {
      price: round2(priceScore * weightOf("price")),
      compliance: round2(complianceScore * weightOf("compliance")),
      delivery: round2(deliveryScore * weightOf("delivery")),
      vendor: round2(vendorScoreNorm * weightOf("vendor")),
      warranty: round2(warrantyScore * weightOf("warranty")),
      terms: round2(termsScore * weightOf("terms")),
    };
    const scoreTotal = round2(
      (Object.values(breakdown).reduce((a, b) => a + b, 0) / totalWeight) * 100,
    );
    return { ...l, scoreTotal, breakdown, unusedMaxNet: maxNet };
  });

  const ranked = [...scored].sort((a, b) => b.scoreTotal - a.scoreTotal);

  const existing = await db.comparative.findFirst({
    where: { rfqId: rfq.id, status: { notIn: ["SUPERSEDED", "REJECTED"] } },
  });
  if (existing) {
    await db.comparative.update({ where: { id: existing.id }, data: { status: "SUPERSEDED" } });
  }

  const number = await nextNumber(SEQ.COMPARATIVE, db);
  const comparative = await db.comparative.create({
    data: {
      number,
      prId: rfq.prId,
      rfqId: rfq.id,
      status: "DRAFT",
      preparedById: user.id,
      evaluationCriteria: JSON.stringify(criteria),
      marketPrice: input.marketPrice ?? null,
      previousPrice,
      lowestTotal,
      notes: input.notes ?? null,
      lines: {
        create: scored.map((l) => ({
          quoteId: l.quote.id,
          vendorId: l.vendorId,
          unitPriceAvg: l.unitPriceAvg,
          subtotal: l.subtotal,
          taxAmount: l.taxAmount,
          deliveryCharges: l.deliveryCharges,
          total: l.total,
          negotiatedTotal: l.negotiatedTotal,
          netTotal: l.netTotal,
          previousPrice: l.previousPrice,
          marketPrice: l.marketPrice,
          variancePercent: l.variancePercent,
          deliveryDays: l.deliveryDays,
          paymentTerms: l.paymentTerms,
          warrantyMonths: l.warrantyMonths,
          technicalCompliance: l.technicalCompliance,
          vendorScore: l.vendorScore,
          vendorOnTimePercent: l.vendorOnTimePercent,
          isLowest: l.netTotal === lowestTotal,
          isLowestCompliant: lowestCompliantTotal !== null && l.netTotal === lowestCompliantTotal && l.technicalCompliance === "COMPLIANT",
          rank: ranked.findIndex((r) => r.quote.id === l.quote.id) + 1,
          scoreTotal: l.scoreTotal,
          scoreBreakdown: JSON.stringify(l.breakdown),
        })),
      },
    },
  });

  // Insufficient-quotation and price-variance controls.
  const minQuotes = await getConfigNumber(CONFIG_KEYS.MIN_QUOTATIONS, rfq.pr.entityId, db);
  const waiverBelow = await getConfigNumber(CONFIG_KEYS.MIN_QUOTATIONS_WAIVER_BELOW, rfq.pr.entityId, db);
  if (rfq.quotes.length < minQuotes && lowestTotal >= waiverBelow) {
    await raiseException(
      {
        type: "INSUFFICIENT_QUOTATIONS",
        severity: "HIGH",
        title: `${rfq.number}: only ${rfq.quotes.length} of ${minQuotes} required quotations`,
        description: `Procurement policy requires ${minQuotes} quotations for cases at or above PKR ${waiverBelow.toLocaleString("en-PK")}.`,
        documentType: "PR",
        documentId: rfq.prId,
        documentRef: rfq.pr.number,
        caseKey: rfq.pr.number,
        entityId: rfq.pr.entityId,
        raisedById: user.id,
        blocking: false,
      },
      db,
      user,
    );
  }

  const varianceLimit = await getConfigNumber(CONFIG_KEYS.PRICE_VARIANCE_ALERT_PERCENT, rfq.pr.entityId, db);
  const baseline = previousPrice ?? input.marketPrice ?? null;
  if (baseline) {
    const v = variancePercent(lowestTotal, baseline);
    if (v !== null && Math.abs(v) >= varianceLimit) {
      await raiseException(
        {
          type: "PRICE_VARIANCE",
          severity: Math.abs(v) >= varianceLimit * 2 ? "HIGH" : "MEDIUM",
          title: `${rfq.pr.number}: ${v > 0 ? "+" : ""}${v}% price variance vs baseline`,
          description: `Lowest net total PKR ${lowestTotal.toLocaleString("en-PK")} against baseline PKR ${baseline.toLocaleString("en-PK")}.`,
          documentType: "PR",
          documentId: rfq.prId,
          documentRef: rfq.pr.number,
          caseKey: rfq.pr.number,
          entityId: rfq.pr.entityId,
          raisedById: user.id,
        },
        db,
        user,
      );
    }
  }

  await writeAudit(
    {
      entityType: "Comparative",
      entityId: comparative.id,
      entityRef: comparative.number,
      action: "COMPARATIVE_CREATED",
      newValue: {
        rfq: rfq.number,
        quotes: rfq.quotes.length,
        lowestTotal,
        lowestCompliantTotal,
        previousPrice,
        marketPrice: input.marketPrice ?? null,
      },
      caseKey: rfq.pr.number,
      actor: user,
    },
    db,
  );

  return comparative;
}

/**
 * Records the sourcing recommendation. Selecting anything other than the lowest
 * compliant quotation demands a written justification and raises a tracked
 * exception.
 */
export async function recommendVendor(
  user: SessionUser,
  input: {
    comparativeId: string;
    quoteId: string;
    basis: string;
    nonLowestJustification?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.VENDOR_SELECT)) {
    throw new ForbiddenError("You do not have permission to select an awarded vendor.");
  }
  const comparative = await db.comparative.findUnique({
    where: { id: input.comparativeId },
    include: {
      lines: { include: { vendor: true, quote: true } },
      pr: true,
      rfq: true,
    },
  });
  if (!comparative) throw new NotFoundError("Comparative");
  if (comparative.status === "SUPERSEDED") {
    throw new RuleViolationError("This comparative has been superseded by a newer version.");
  }

  const chosen = comparative.lines.find((l) => l.quoteId === input.quoteId);
  if (!chosen) throw new ValidationError("The selected quotation is not part of this comparative.");
  if (!input.basis?.trim()) throw new ValidationError("Record the basis for this recommendation.");

  const eligibility = await checkVendorEligibility(chosen.vendorId, comparative.pr.entityId, db);
  if (!eligibility.eligible) {
    throw new RuleViolationError(
      eligibility.reason ?? "The selected vendor is not eligible for award.",
    );
  }

  const requireJustification = await getConfigBool(
    CONFIG_KEYS.NON_LOWEST_REQUIRES_JUSTIFICATION,
    comparative.pr.entityId,
    db,
  );
  const compliantLines = comparative.lines.filter((l) => l.technicalCompliance === "COMPLIANT");
  const benchmark = compliantLines.length
    ? Math.min(...compliantLines.map((l) => l.netTotal))
    : Math.min(...comparative.lines.map((l) => l.netTotal));
  const isBenchmark = chosen.netTotal <= benchmark + 0.01;

  if (!isBenchmark && requireJustification && !input.nonLowestJustification?.trim()) {
    throw new RuleViolationError(
      `${chosen.vendor.name} is not the lowest compliant quotation (PKR ${chosen.netTotal.toLocaleString("en-PK")} vs PKR ${benchmark.toLocaleString("en-PK")}). A written justification is required.`,
    );
  }

  // Two independent savings measures, both defensible:
  //  · negotiation — what the vendor conceded off their own quotation;
  //  · baseline    — how the award compares to the market or last paid price.
  // We report the larger, and never treat a risen market as a loss.
  const negotiationSaving = round2(Math.max(0, chosen.total - chosen.netTotal));
  const baseline = Math.max(comparative.marketPrice ?? 0, comparative.previousPrice ?? 0) || null;
  const baselineSaving = baseline ? round2(Math.max(0, baseline - chosen.netTotal)) : 0;
  const savingsAmount = round2(Math.max(negotiationSaving, baselineSaving));
  const savingsBase = baselineSaving >= negotiationSaving && baseline ? baseline : chosen.total;

  await db.comparativeLine.updateMany({ where: { comparativeId: comparative.id }, data: { isSelected: false } });
  await db.comparativeLine.update({ where: { id: chosen.id }, data: { isSelected: true } });

  const updated = await db.comparative.update({
    where: { id: comparative.id },
    data: {
      status: "RECOMMENDED",
      recommendedQuoteId: input.quoteId,
      recommendationBasis: input.basis.trim(),
      nonLowestJustification: isBenchmark ? null : (input.nonLowestJustification ?? null),
      selectedTotal: chosen.netTotal,
      savingsAmount,
      savingsPercent: savingsBase > 0 ? round2((savingsAmount / savingsBase) * 100) : 0,
    },
  });

  await db.vendorQuote.updateMany({
    where: { rfqId: comparative.rfqId },
    data: { status: "UNDER_REVIEW" },
  });
  await db.vendorQuote.update({ where: { id: input.quoteId }, data: { status: "SHORTLISTED" } });

  if (!isBenchmark) {
    await raiseException(
      {
        type: "NON_LOWEST_SELECTED",
        severity: "MEDIUM",
        title: `${comparative.number}: ${chosen.vendor.name} recommended above lowest compliant quote`,
        description: input.nonLowestJustification ?? undefined,
        reason: input.nonLowestJustification ?? null,
        documentType: "PR",
        documentId: comparative.prId,
        documentRef: comparative.pr.number,
        caseKey: comparative.pr.number,
        entityId: comparative.pr.entityId,
        raisedById: user.id,
        ownerId: user.id,
      },
      db,
      user,
    );
  }

  await writeAudit(
    {
      entityType: "Comparative",
      entityId: comparative.id,
      entityRef: comparative.number,
      action: "COMPARATIVE_RECOMMENDED",
      newValue: {
        vendor: chosen.vendor.name,
        netTotal: chosen.netTotal,
        isLowestCompliant: isBenchmark,
        savingsAmount,
        basis: input.basis,
      },
      reason: input.nonLowestJustification ?? null,
      caseKey: comparative.pr.number,
      actor: user,
    },
    db,
  );

  return { comparative: updated, chosen, isBenchmark, savingsAmount };
}

/** Blocking checks before a comparative can be advanced to CPC or PO. */
export async function comparativeReadiness(comparativeId: string, db: DbClient = prisma) {
  const c = await db.comparative.findUnique({
    where: { id: comparativeId },
    include: { lines: true, pr: true, rfq: { include: { quotes: true } } },
  });
  if (!c) throw new NotFoundError("Comparative");

  const issues: string[] = [];
  const minQuotes = await getConfigNumber(CONFIG_KEYS.MIN_QUOTATIONS, c.pr.entityId, db);
  const waiverBelow = await getConfigNumber(CONFIG_KEYS.MIN_QUOTATIONS_WAIVER_BELOW, c.pr.entityId, db);
  const selected = c.lines.find((l) => l.isSelected);

  if (!selected) issues.push("No vendor has been recommended yet.");
  const quoteCount = c.rfq.quotes.length;
  const value = selected?.netTotal ?? c.lowestTotal ?? 0;
  if (quoteCount < minQuotes && value >= waiverBelow) {
    issues.push(
      `Only ${quoteCount} quotation(s) recorded — policy requires ${minQuotes} for cases at or above PKR ${waiverBelow.toLocaleString("en-PK")}.`,
    );
  }
  if (selected && selected.technicalCompliance === "NON_COMPLIANT") {
    issues.push("The recommended quotation is marked technically non-compliant.");
  }
  return { comparative: c, selected, issues, quoteCount, minQuotes };
}
