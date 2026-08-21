import { prisma, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { writeAudit, diffFields } from "@/lib/audit";
import { notify, createTask, completeTasks } from "@/lib/notify";
import { raiseException } from "@/lib/exceptions-service";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import type { BlacklistStage, VendorStatus } from "@/lib/domain";
import { round2, safeDiv } from "@/lib/format";

/**
 * Vendor OS: registration, weighted pre-qualification scoring, performance
 * computation, issue tracking and the investigation-led blacklist workflow.
 */

/* ── Registration & profile ───────────────────────────────── */

export type VendorInput = {
  name: string;
  legalName?: string | null;
  businessType?: string;
  address?: string | null;
  city?: string | null;
  country?: string;
  contactPerson?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  website?: string | null;
  taxStatus?: string;
  ntn?: string | null;
  strn?: string | null;
  registrationNumber?: string | null;
  officeCount?: number | null;
  citiesCovered?: string | null;
  workforceCount?: number | null;
  hasTransportation?: boolean;
  transportationNotes?: string | null;
  supportStaffCount?: number | null;
  paymentTerms?: string | null;
  creditDays?: number | null;
  bankName?: string | null;
  bankAccountTitle?: string | null;
  bankAccountNumber?: string | null;
  bankIban?: string | null;
  references?: string | null;
  productsServices?: string | null;
  categories?: string | null;
  sourceChannel?: string;
  sourceNotes?: string | null;
  isTrader?: boolean;
  minimumOrderValue?: number | null;
  entityIds?: string[];
};

export async function createVendor(user: SessionUser, input: VendorInput, db: DbClient = prisma) {
  if (!userHasPermission(user, P.VENDOR_CREATE)) {
    throw new ForbiddenError("You do not have permission to create vendors.");
  }
  if (!input.name.trim()) throw new ValidationError("Vendor name is required.");

  const dup = await db.vendor.findFirst({
    where: {
      OR: [
        { name: input.name.trim() },
        ...(input.ntn?.trim() ? [{ ntn: input.ntn.trim() }] : []),
      ],
    },
  });
  if (dup) {
    throw new RuleViolationError(
      `A vendor with this name or NTN already exists (${dup.code} — ${dup.name}, status ${dup.status}).`,
    );
  }

  const code = await nextNumber(SEQ.VENDOR, db);
  const vendor = await db.vendor.create({
    data: {
      code,
      name: input.name.trim(),
      legalName: input.legalName ?? null,
      businessType: input.businessType ?? "DISTRIBUTOR",
      address: input.address ?? null,
      city: input.city ?? null,
      country: input.country ?? "Pakistan",
      contactPerson: input.contactPerson ?? null,
      contactPhone: input.contactPhone ?? null,
      contactEmail: input.contactEmail ?? null,
      website: input.website ?? null,
      taxStatus: input.taxStatus ?? "FILER",
      ntn: input.ntn ?? null,
      strn: input.strn ?? null,
      registrationNumber: input.registrationNumber ?? null,
      officeCount: input.officeCount ?? null,
      citiesCovered: input.citiesCovered ?? null,
      workforceCount: input.workforceCount ?? null,
      hasTransportation: Boolean(input.hasTransportation),
      transportationNotes: input.transportationNotes ?? null,
      supportStaffCount: input.supportStaffCount ?? null,
      paymentTerms: input.paymentTerms ?? null,
      creditDays: input.creditDays ?? null,
      bankName: input.bankName ?? null,
      bankAccountTitle: input.bankAccountTitle ?? null,
      bankAccountNumber: input.bankAccountNumber ?? null,
      bankIban: input.bankIban ?? null,
      references: input.references ?? null,
      productsServices: input.productsServices ?? null,
      categories: input.categories ?? null,
      sourceChannel: input.sourceChannel ?? "MARKET",
      sourceNotes: input.sourceNotes ?? null,
      isTrader: Boolean(input.isTrader),
      minimumOrderValue: input.minimumOrderValue ?? null,
      status: "PROSPECT",
      entityLinks: input.entityIds?.length
        ? { create: input.entityIds.map((entityId) => ({ entityId, approved: false })) }
        : undefined,
    },
  });

  await createTask(
    {
      title: `Pre-qualify vendor ${vendor.name}`,
      description: `Source: ${vendor.sourceChannel}. Score the vendor against the pre-qualification criteria.`,
      taskType: "REVIEW",
      assignedRoleCode: "PROCUREMENT_OFFICER",
      documentType: "VENDOR",
      documentId: vendor.id,
      documentRef: vendor.code,
      slaHours: 120,
      linkUrl: `/vendors/${vendor.id}`,
    },
    db,
  );

  await writeAudit(
    {
      entityType: "Vendor",
      entityId: vendor.id,
      entityRef: vendor.code,
      action: "VENDOR_CREATED",
      newValue: { name: vendor.name, businessType: vendor.businessType, source: vendor.sourceChannel },
      actor: user,
    },
    db,
  );

  return vendor;
}

export async function updateVendor(
  user: SessionUser,
  vendorId: string,
  input: Partial<VendorInput>,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.VENDOR_EDIT)) throw new ForbiddenError("Not permitted.");
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) throw new NotFoundError("Vendor");
  if (vendor.status === "BLACKLISTED" && !userHasPermission(user, P.VENDOR_BLACKLIST)) {
    throw new ForbiddenError("A blacklisted vendor can only be edited by an authorised approver.");
  }

  const { entityIds, ...rest } = input;
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) data[k] = v;

  const updated = await db.vendor.update({ where: { id: vendorId }, data });
  if (entityIds) {
    await db.vendorEntityLink.deleteMany({ where: { vendorId } });
    await db.vendorEntityLink.createMany({
      data: entityIds.map((entityId) => ({ vendorId, entityId, approved: vendor.status === "APPROVED" })),
    });
  }

  await writeAudit(
    {
      entityType: "Vendor",
      entityId: vendorId,
      entityRef: vendor.code,
      action: "VENDOR_UPDATED",
      changes: diffFields(vendor as unknown as Record<string, unknown>, data),
      actor: user,
    },
    db,
  );
  return updated;
}

/* ── Pre-qualification scoring ────────────────────────────── */

export type ScoreInput = { criterionId: string; score: number; comment?: string | null };

/**
 * Records a weighted pre-qualification evaluation. The pass mark and maximum
 * score are configuration, not constants.
 */
export async function evaluateVendor(
  user: SessionUser,
  input: {
    vendorId: string;
    evaluationType?: string;
    scores: ScoreInput[];
    recommendation?: string | null;
    notes?: string | null;
    entityId?: string | null;
    submit?: boolean;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.VENDOR_EVALUATE)) {
    throw new ForbiddenError("You do not have permission to evaluate vendors.");
  }
  const vendor = await db.vendor.findUnique({ where: { id: input.vendorId } });
  if (!vendor) throw new NotFoundError("Vendor");
  if (!input.scores.length) throw new ValidationError("Score at least one criterion.");

  const criteria = await db.evaluationCriterion.findMany({
    where: { id: { in: input.scores.map((s) => s.criterionId) }, active: true },
  });
  if (criteria.length !== input.scores.length) {
    throw new ValidationError("One or more scored criteria are unknown or inactive.");
  }

  let totalScore = 0;
  let maxScore = 0;
  const rows = input.scores.map((s) => {
    const c = criteria.find((x) => x.id === s.criterionId)!;
    if (s.score < 0 || s.score > c.maxScore) {
      throw new ValidationError(`"${c.name}" must be scored between 0 and ${c.maxScore}.`);
    }
    const weighted = round2(s.score * c.weight);
    totalScore += weighted;
    maxScore += round2(c.maxScore * c.weight);
    return {
      criterionId: c.id,
      score: s.score,
      maxScore: c.maxScore,
      weight: c.weight,
      weightedScore: weighted,
      comment: s.comment ?? null,
    };
  });

  totalScore = round2(totalScore);
  maxScore = round2(maxScore);

  const passingScore = await getConfigNumber(CONFIG_KEYS.VENDOR_MIN_SCORE, input.entityId ?? null, db);
  const configuredMax = await getConfigNumber(CONFIG_KEYS.VENDOR_MAX_SCORE, input.entityId ?? null, db);
  // Express the achieved score on the configured scale so the 30/60 style rule reads correctly.
  const scaledScore = maxScore > 0 ? round2((totalScore / maxScore) * configuredMax) : 0;
  const percentage = maxScore > 0 ? round2((totalScore / maxScore) * 100) : 0;
  const passed = scaledScore >= passingScore;

  const number = await nextNumber(SEQ.VENDOR_EVAL, db);
  const evaluation = await db.vendorEvaluation.create({
    data: {
      number,
      vendorId: vendor.id,
      evaluationType: input.evaluationType ?? "PRE_QUALIFICATION",
      evaluatorId: user.id,
      totalScore: scaledScore,
      maxScore: configuredMax,
      percentage,
      passingScore,
      passed,
      status: input.submit ? "SUBMITTED" : "DRAFT",
      recommendation: input.recommendation ?? null,
      notes: input.notes ?? null,
      scores: { create: rows },
    },
  });

  await db.vendor.update({
    where: { id: vendor.id },
    data: {
      currentScore: scaledScore,
      maxScore: configuredMax,
      scorePercent: percentage,
      status:
        vendor.status === "PROSPECT" || vendor.status === "UNDER_EVALUATION"
          ? input.submit
            ? "PENDING_APPROVAL"
            : "UNDER_EVALUATION"
          : vendor.status,
    },
  });

  if (input.submit) {
    await createTask(
      {
        title: `Approve vendor ${vendor.name} (${scaledScore}/${configuredMax})`,
        description: passed
          ? `Scored ${scaledScore}/${configuredMax} — meets the minimum of ${passingScore}.`
          : `Scored ${scaledScore}/${configuredMax} — below the minimum of ${passingScore}.`,
        taskType: "APPROVAL",
        assignedRoleCode: "PROCUREMENT_SENIOR_MANAGER",
        documentType: "VENDOR",
        documentId: vendor.id,
        documentRef: vendor.code,
        priority: "NORMAL",
        slaHours: 72,
        linkUrl: `/vendors/${vendor.id}`,
      },
      db,
    );
    await notify(
      {
        roleCodes: ["PROCUREMENT_SENIOR_MANAGER", "PROCUREMENT_DIRECTOR"],
        type: "VENDOR_EVALUATION_DUE",
        title: `${vendor.name} pre-qualification submitted`,
        body: `${scaledScore}/${configuredMax} (${percentage}%) — ${passed ? "pass" : "below minimum"}`,
        linkType: "VENDOR",
        linkId: vendor.id,
        linkUrl: `/vendors/${vendor.id}`,
      },
      db,
    );
  }

  await writeAudit(
    {
      entityType: "VendorEvaluation",
      entityId: evaluation.id,
      entityRef: evaluation.number,
      action: input.submit ? "VENDOR_EVALUATION_SUBMITTED" : "VENDOR_EVALUATION_DRAFTED",
      newValue: { vendor: vendor.name, score: scaledScore, max: configuredMax, percentage, passed },
      actor: user,
    },
    db,
  );

  return { evaluation, passed, scaledScore, configuredMax, passingScore, percentage };
}

export async function decideVendorApproval(
  user: SessionUser,
  input: {
    vendorId: string;
    decision: "APPROVE" | "CONDITIONAL" | "REJECT";
    reason: string;
    entityIds?: string[];
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.VENDOR_APPROVE)) {
    throw new ForbiddenError("You do not have permission to approve vendors.");
  }
  if (!input.reason?.trim()) throw new ValidationError("Record the basis for this decision.");

  const vendor = await db.vendor.findUnique({
    where: { id: input.vendorId },
    include: { evaluations: { orderBy: { evaluatedAt: "desc" }, take: 1 } },
  });
  if (!vendor) throw new NotFoundError("Vendor");

  const latest = vendor.evaluations[0];
  if (input.decision === "APPROVE") {
    if (!latest) {
      throw new RuleViolationError("A vendor cannot be approved before a pre-qualification evaluation is recorded.");
    }
    if (!latest.passed) {
      throw new RuleViolationError(
        `${vendor.name} scored ${latest.totalScore}/${latest.maxScore}, below the minimum of ${latest.passingScore}. Approve conditionally with a recorded reason, or re-evaluate.`,
      );
    }
  }

  const status: VendorStatus =
    input.decision === "APPROVE" ? "APPROVED" : input.decision === "CONDITIONAL" ? "CONDITIONAL" : "INACTIVE";

  const updated = await db.vendor.update({
    where: { id: vendor.id },
    data: {
      status,
      statusReason: input.reason.trim(),
      approvedAt: input.decision === "REJECT" ? null : new Date(),
    },
  });
  if (latest) {
    await db.vendorEvaluation.update({
      where: { id: latest.id },
      data: {
        status: input.decision === "REJECT" ? "REJECTED" : "APPROVED",
        approvedById: user.id,
        approvedAt: new Date(),
      },
    });
  }
  if (input.entityIds?.length) {
    await db.vendorEntityLink.deleteMany({ where: { vendorId: vendor.id } });
    await db.vendorEntityLink.createMany({
      data: input.entityIds.map((entityId) => ({ vendorId: vendor.id, entityId, approved: status !== "INACTIVE" })),
    });
  } else {
    await db.vendorEntityLink.updateMany({
      where: { vendorId: vendor.id },
      data: { approved: status !== "INACTIVE" },
    });
  }

  await completeTasks("VENDOR", vendor.id, user.id, db);
  await writeAudit(
    {
      entityType: "Vendor",
      entityId: vendor.id,
      entityRef: vendor.code,
      action: `VENDOR_${input.decision}`,
      changes: { status: { from: vendor.status, to: status } },
      reason: input.reason.trim(),
      actor: user,
    },
    db,
  );
  return updated;
}

/* ── Performance ──────────────────────────────────────────── */

/**
 * Recomputes a vendor's performance from actual transactions: delivery
 * timeliness, acceptance quality, rejections, price variance and issues.
 */
export async function computeVendorPerformance(
  vendorId: string,
  periodStart: Date,
  periodEnd: Date,
  db: DbClient = prisma,
) {
  const [pos, deliveries, grnItems, invoiceIssues, issues] = await Promise.all([
    db.purchaseOrder.findMany({
      where: {
        vendorId,
        issuedAt: { gte: periodStart, lte: periodEnd },
        status: { notIn: ["DRAFT", "CANCELLED", "PENDING_APPROVAL"] },
      },
      include: { items: true, deliveries: true },
    }),
    db.delivery.findMany({
      where: { vendorId, deliveryDate: { gte: periodStart, lte: periodEnd } },
      include: { po: { select: { deliveryDate: true } }, items: true },
    }),
    db.grnItem.findMany({
      where: { grn: { vendorId, status: "POSTED", receivedAt: { gte: periodStart, lte: periodEnd } } },
    }),
    db.invoice.count({
      where: {
        vendorId,
        receivedDate: { gte: periodStart, lte: periodEnd },
        OR: [{ matchStatus: "FAILED" }, { matchStatus: "OVERRIDDEN" }],
      },
    }),
    db.vendorIssue.findMany({ where: { vendorId, raisedAt: { gte: periodStart, lte: periodEnd } } }),
  ]);

  const ordersCount = pos.length;
  const totalSpend = round2(pos.reduce((a, p) => a + p.total, 0));

  let onTime = 0;
  let late = 0;
  let partial = 0;
  for (const d of deliveries) {
    if (d.po.deliveryDate && d.deliveryDate > d.po.deliveryDate) late += 1;
    else onTime += 1;
    if (d.status === "PARTIALLY_ACCEPTED" || d.status === "ACCEPTED_WITH_DISCREPANCY") partial += 1;
  }

  const acceptedLines = grnItems.filter((g) => g.acceptedQty > 0).length;
  const rejectedLines = grnItems.filter((g) => g.rejectedQty > 0).length;
  const acceptedQty = round2(grnItems.reduce((a, g) => a + g.acceptedQty, 0));
  const rejectedQty = round2(grnItems.reduce((a, g) => a + g.rejectedQty, 0));

  const qualityIssues = issues.filter((i) => i.issueType === "QUALITY").length;
  const warrantyClaims = issues.filter((i) => i.issueType === "WARRANTY_DENIED").length;
  const complaints = issues.length;

  const deliveryTotal = onTime + late;
  const onTimePercent = deliveryTotal ? round2((onTime / deliveryTotal) * 100) : 0;
  const receivedTotal = acceptedQty + rejectedQty;
  const qualityPercent = receivedTotal ? round2((acceptedQty / receivedTotal) * 100) : 0;
  const rejectionPercent = receivedTotal ? round2((rejectedQty / receivedTotal) * 100) : 0;

  // Average variance of PO price against the item's standard price.
  let varianceSum = 0;
  let varianceCount = 0;
  for (const p of pos) {
    for (const it of p.items) {
      if (!it.itemId) continue;
      const item = await db.item.findUnique({ where: { id: it.itemId }, select: { standardPrice: true } });
      if (item?.standardPrice && item.standardPrice > 0) {
        varianceSum += ((it.unitPrice - item.standardPrice) / item.standardPrice) * 100;
        varianceCount += 1;
      }
    }
  }
  const avgPriceVariance = varianceCount ? round2(varianceSum / varianceCount) : 0;

  // Composite score: delivery 35, quality 35, issues 20, invoice accuracy 10.
  const issuePenalty = Math.min(20, complaints * 4);
  const invoicePenalty = Math.min(10, invoiceIssues * 3);
  const score = round2(
    Math.max(
      0,
      onTimePercent * 0.35 + qualityPercent * 0.35 + (20 - issuePenalty) + (10 - invoicePenalty),
    ),
  );

  const record = await db.vendorPerformance.upsert({
    where: { vendorId_periodStart_periodEnd: { vendorId, periodStart, periodEnd } },
    create: {
      vendorId,
      periodStart,
      periodEnd,
      ordersCount,
      totalSpend,
      onTimeDeliveries: onTime,
      lateDeliveries: late,
      partialDeliveries: partial,
      rejectedLines,
      acceptedLines,
      qualityIssues,
      invoiceIssues,
      warrantyClaims,
      complaints,
      avgPriceVariance,
      onTimePercent,
      qualityPercent,
      rejectionPercent,
      score,
    },
    update: {
      ordersCount,
      totalSpend,
      onTimeDeliveries: onTime,
      lateDeliveries: late,
      partialDeliveries: partial,
      rejectedLines,
      acceptedLines,
      qualityIssues,
      invoiceIssues,
      warrantyClaims,
      complaints,
      avgPriceVariance,
      onTimePercent,
      qualityPercent,
      rejectionPercent,
      score,
      computedAt: new Date(),
    },
  });

  // Roll the headline figures onto the vendor for sourcing screens.
  const lifetime = await db.purchaseOrder.aggregate({
    where: { vendorId, status: { notIn: ["DRAFT", "CANCELLED", "PENDING_APPROVAL"] } },
    _sum: { total: true },
    _count: { _all: true },
  });
  await db.vendor.update({
    where: { id: vendorId },
    data: {
      performanceScore: score,
      onTimePercent,
      qualityPercent,
      rejectionPercent,
      totalOrders: lifetime._count._all,
      totalSpend: round2(lifetime._sum.total ?? 0),
    },
  });

  return record;
}

/** Recomputes performance for every vendor over a rolling window. */
export async function recomputeAllVendorPerformance(months = 12, db: DbClient = prisma) {
  const end = new Date();
  const start = new Date(end.getTime() - months * 30 * 86400000);
  const vendors = await db.vendor.findMany({ select: { id: true } });
  for (const v of vendors) {
    await computeVendorPerformance(v.id, start, end, db);
  }
  return vendors.length;
}

/* ── Vendor history (for CPC & sourcing decisions) ────────── */

export type VendorHistory = {
  vendor: NonNullable<Awaited<ReturnType<typeof prisma.vendor.findUnique>>>;
  totals: {
    orders: number;
    spend: number;
    grns: number;
    invoices: number;
    invoiceIssues: number;
    rejections: number;
    openIssues: number;
    negotiationSavings: number;
  };
  recentPos: Array<{ id: string; number: string; total: number; status: string; issuedAt: Date | null; entityCode: string }>;
  recentQuotes: Array<{ id: string; number: string; total: number; status: string; quoteDate: Date; rfqNumber: string }>;
  recentGrns: Array<{ id: string; number: string; totalValue: number; receivedAt: Date; storeName: string }>;
  issues: Array<{ id: string; number: string; issueType: string; severity: string; status: string; title: string; raisedAt: Date }>;
  performance: Array<{ periodStart: Date; periodEnd: Date; onTimePercent: number; qualityPercent: number; score: number; ordersCount: number; totalSpend: number }>;
  categorySpend: Array<{ category: string; spend: number }>;
  projectSpend: Array<{ project: string; spend: number }>;
};

export async function vendorHistory(vendorId: string, db: DbClient = prisma): Promise<VendorHistory> {
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) throw new NotFoundError("Vendor");

  const [pos, quotes, grns, invoices, issues, performance, negotiations] = await Promise.all([
    db.purchaseOrder.findMany({
      where: { vendorId },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: {
        entity: { select: { code: true } },
        items: { include: { item: { include: { category: { select: { name: true } } } } } },
        pr: { include: { project: { select: { name: true } } } },
      },
    }),
    db.vendorQuote.findMany({
      where: { vendorId },
      orderBy: { quoteDate: "desc" },
      take: 25,
      include: { rfq: { select: { number: true } } },
    }),
    db.grn.findMany({
      where: { vendorId, status: "POSTED" },
      orderBy: { receivedAt: "desc" },
      take: 25,
      include: { store: { select: { name: true } }, items: true },
    }),
    db.invoice.findMany({ where: { vendorId }, select: { id: true, matchStatus: true, status: true } }),
    db.vendorIssue.findMany({ where: { vendorId }, orderBy: { raisedAt: "desc" }, take: 30 }),
    db.vendorPerformance.findMany({ where: { vendorId }, orderBy: { periodStart: "desc" }, take: 12 }),
    db.negotiation.findMany({ where: { quote: { vendorId } }, select: { savings: true } }),
  ]);

  const categorySpend = new Map<string, number>();
  const projectSpend = new Map<string, number>();
  for (const po of pos) {
    for (const it of po.items) {
      const cat = it.item?.category?.name ?? "Uncategorised";
      categorySpend.set(cat, round2((categorySpend.get(cat) ?? 0) + it.lineTotal));
    }
    const proj = po.pr?.project?.name;
    if (proj) projectSpend.set(proj, round2((projectSpend.get(proj) ?? 0) + po.total));
  }

  const rejections = grns.reduce((a, g) => a + g.items.filter((i) => i.rejectedQty > 0).length, 0);

  return {
    vendor,
    totals: {
      orders: vendor.totalOrders,
      spend: vendor.totalSpend,
      grns: grns.length,
      invoices: invoices.length,
      invoiceIssues: invoices.filter((i) => i.matchStatus === "FAILED" || i.matchStatus === "OVERRIDDEN").length,
      rejections,
      openIssues: issues.filter((i) => !["RESOLVED", "CLOSED"].includes(i.status)).length,
      negotiationSavings: round2(negotiations.reduce((a, n) => a + n.savings, 0)),
    },
    recentPos: pos.map((p) => ({
      id: p.id,
      number: p.number,
      total: p.total,
      status: p.status,
      issuedAt: p.issuedAt,
      entityCode: p.entity.code,
    })),
    recentQuotes: quotes.map((q) => ({
      id: q.id,
      number: q.number,
      total: q.total,
      status: q.status,
      quoteDate: q.quoteDate,
      rfqNumber: q.rfq.number,
    })),
    recentGrns: grns.map((g) => ({
      id: g.id,
      number: g.number,
      totalValue: g.totalValue,
      receivedAt: g.receivedAt,
      storeName: g.store.name,
    })),
    issues: issues.map((i) => ({
      id: i.id,
      number: i.number,
      issueType: i.issueType,
      severity: i.severity,
      status: i.status,
      title: i.title,
      raisedAt: i.raisedAt,
    })),
    performance: performance.map((p) => ({
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      onTimePercent: p.onTimePercent,
      qualityPercent: p.qualityPercent,
      score: p.score,
      ordersCount: p.ordersCount,
      totalSpend: p.totalSpend,
    })),
    categorySpend: [...categorySpend.entries()]
      .map(([category, spend]) => ({ category, spend }))
      .sort((a, b) => b.spend - a.spend),
    projectSpend: [...projectSpend.entries()]
      .map(([project, spend]) => ({ project, spend }))
      .sort((a, b) => b.spend - a.spend),
  };
}

/* ── Issues ───────────────────────────────────────────────── */

export async function raiseVendorIssue(
  user: SessionUser,
  input: {
    vendorId: string;
    issueType: string;
    severity?: string;
    title: string;
    description: string;
    relatedPoId?: string | null;
    relatedGrnId?: string | null;
    relatedInvoiceId?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.VENDOR_ISSUE_RAISE)) {
    throw new ForbiddenError("You do not have permission to raise vendor issues.");
  }
  if (!input.description?.trim()) throw new ValidationError("Describe the issue.");

  const vendor = await db.vendor.findUnique({ where: { id: input.vendorId } });
  if (!vendor) throw new NotFoundError("Vendor");

  const number = await nextNumber(SEQ.VENDOR_ISSUE, db);
  const issue = await db.vendorIssue.create({
    data: {
      number,
      vendorId: input.vendorId,
      issueType: input.issueType,
      severity: input.severity ?? "MEDIUM",
      title: input.title.trim(),
      description: input.description.trim(),
      relatedPoId: input.relatedPoId ?? null,
      relatedGrnId: input.relatedGrnId ?? null,
      relatedInvoiceId: input.relatedInvoiceId ?? null,
      raisedById: user.id,
      status: "OPEN",
    },
  });

  await createTask(
    {
      title: `Review vendor issue ${issue.number} — ${vendor.name}`,
      description: input.title,
      taskType: "REVIEW",
      assignedRoleCode: "PROCUREMENT_SENIOR_MANAGER",
      documentType: "VENDOR_ISSUE",
      documentId: issue.id,
      documentRef: issue.number,
      priority: input.severity === "CRITICAL" ? "URGENT" : "NORMAL",
      slaHours: 72,
      linkUrl: `/vendors/issues/${issue.id}`,
    },
    db,
  );
  await notify(
    {
      roleCodes: ["PROCUREMENT_SENIOR_MANAGER", "PROCUREMENT_DIRECTOR"],
      type: "VENDOR_ISSUE",
      title: `${issue.number}: ${input.title}`,
      body: `${vendor.name} · ${input.issueType.replace(/_/g, " ").toLowerCase()}`,
      priority: input.severity === "CRITICAL" ? "CRITICAL" : "HIGH",
      linkType: "VENDOR_ISSUE",
      linkId: issue.id,
      linkUrl: `/vendors/issues/${issue.id}`,
    },
    db,
  );

  await raiseException(
    {
      type: "VENDOR_COMPLIANCE",
      severity: (input.severity as never) ?? "MEDIUM",
      title: `${vendor.name}: ${input.title}`,
      description: input.description,
      documentType: "VENDOR",
      documentId: vendor.id,
      documentRef: vendor.code,
      raisedById: user.id,
    },
    db,
    user,
  );

  await writeAudit(
    {
      entityType: "VendorIssue",
      entityId: issue.id,
      entityRef: issue.number,
      action: "VENDOR_ISSUE_RAISED",
      newValue: { vendor: vendor.name, type: input.issueType, severity: issue.severity },
      actor: user,
    },
    db,
  );

  return issue;
}

export async function updateVendorIssue(
  user: SessionUser,
  issueId: string,
  input: { status?: string; vendorResponse?: string | null; resolution?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.VENDOR_ISSUE_RAISE, P.VENDOR_BLACKLIST)) {
    throw new ForbiddenError("Not permitted.");
  }
  const issue = await db.vendorIssue.findUnique({ where: { id: issueId }, include: { vendor: true } });
  if (!issue) throw new NotFoundError("Vendor issue");
  if (input.status && ["RESOLVED", "CLOSED"].includes(input.status) && !input.resolution?.trim()) {
    throw new ValidationError("Record the resolution before closing this issue.");
  }

  const updated = await db.vendorIssue.update({
    where: { id: issueId },
    data: {
      status: input.status ?? issue.status,
      vendorResponse: input.vendorResponse ?? issue.vendorResponse,
      resolution: input.resolution ?? issue.resolution,
      resolvedAt: input.status && ["RESOLVED", "CLOSED"].includes(input.status) ? new Date() : issue.resolvedAt,
    },
  });
  if (input.status && ["RESOLVED", "CLOSED"].includes(input.status)) {
    await completeTasks("VENDOR_ISSUE", issueId, user.id, db);
  }
  await writeAudit(
    {
      entityType: "VendorIssue",
      entityId: issueId,
      entityRef: issue.number,
      action: "VENDOR_ISSUE_UPDATED",
      changes: { status: { from: issue.status, to: updated.status } },
      reason: input.resolution ?? input.vendorResponse ?? null,
      actor: user,
    },
    db,
  );
  return updated;
}

/* ── Blacklist investigation workflow ─────────────────────── */

const BLACKLIST_FLOW: Record<BlacklistStage, BlacklistStage[]> = {
  RAISED: ["EVIDENCE_COLLECTION", "CLOSED"],
  EVIDENCE_COLLECTION: ["INVESTIGATION", "CLOSED"],
  INVESTIGATION: ["VENDOR_RESPONSE_AWAITED", "PROCUREMENT_REVIEW", "CLOSED"],
  VENDOR_RESPONSE_AWAITED: ["PROCUREMENT_REVIEW", "CLOSED"],
  PROCUREMENT_REVIEW: ["AUDIT_REVIEW", "DECISION_PENDING", "CLOSED"],
  AUDIT_REVIEW: ["DECISION_PENDING", "CLOSED"],
  DECISION_PENDING: ["BLACKLISTED", "WARNING_ISSUED", "RETAINED", "CLOSED"],
  BLACKLISTED: ["CLOSED"],
  WARNING_ISSUED: ["CLOSED"],
  RETAINED: ["CLOSED"],
  CLOSED: [],
};

export async function openBlacklistCase(
  user: SessionUser,
  input: {
    vendorId: string;
    reason: string;
    reasonCode: string;
    evidence?: string | null;
    auditRequired?: boolean;
    suspendImmediately?: boolean;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.VENDOR_ISSUE_RAISE, P.VENDOR_BLACKLIST)) {
    throw new ForbiddenError("You do not have permission to open a vendor investigation.");
  }
  if (!input.reason?.trim()) throw new ValidationError("State the reason for the investigation.");

  const vendor = await db.vendor.findUnique({ where: { id: input.vendorId } });
  if (!vendor) throw new NotFoundError("Vendor");
  const open = await db.vendorBlacklistCase.findFirst({
    where: { vendorId: input.vendorId, stage: { notIn: ["CLOSED"] } },
  });
  if (open) {
    throw new RuleViolationError(`An investigation (${open.number}) is already open for ${vendor.name}.`);
  }

  const number = await nextNumber(SEQ.BLACKLIST, db);
  const kase = await db.vendorBlacklistCase.create({
    data: {
      number,
      vendorId: input.vendorId,
      reason: input.reason.trim(),
      reasonCode: input.reasonCode,
      evidence: input.evidence ?? null,
      auditRequired: input.auditRequired ?? true,
      stage: "RAISED",
      raisedById: user.id,
    },
  });

  // Suspension pending investigation is a holding action, not a blacklist.
  if (input.suspendImmediately) {
    if (!userHasPermission(user, P.VENDOR_BLACKLIST)) {
      throw new ForbiddenError("Only an authorised approver may suspend a vendor pending investigation.");
    }
    await db.vendor.update({
      where: { id: input.vendorId },
      data: { status: "SUSPENDED", statusReason: `Suspended pending investigation ${kase.number}: ${input.reason.trim()}` },
    });
  }

  await createTask(
    {
      title: `Collect evidence — ${kase.number} (${vendor.name})`,
      taskType: "REVIEW",
      assignedRoleCode: "PROCUREMENT_SENIOR_MANAGER",
      documentType: "VENDOR_BLACKLIST",
      documentId: kase.id,
      documentRef: kase.number,
      priority: "HIGH",
      slaHours: 120,
      linkUrl: `/vendors/blacklist/${kase.id}`,
    },
    db,
  );
  await notify(
    {
      roleCodes: ["PROCUREMENT_DIRECTOR", "AUDIT_USER", "PROCUREMENT_SENIOR_MANAGER"],
      type: "VENDOR_ISSUE",
      title: `Vendor investigation opened — ${vendor.name}`,
      body: `${kase.number}: ${input.reason.trim()}`,
      priority: "HIGH",
      linkType: "VENDOR_BLACKLIST",
      linkId: kase.id,
      linkUrl: `/vendors/blacklist/${kase.id}`,
    },
    db,
  );

  await writeAudit(
    {
      entityType: "VendorBlacklistCase",
      entityId: kase.id,
      entityRef: kase.number,
      action: "BLACKLIST_CASE_OPENED",
      newValue: { vendor: vendor.name, reasonCode: input.reasonCode, suspended: Boolean(input.suspendImmediately) },
      reason: input.reason.trim(),
      actor: user,
    },
    db,
  );

  return kase;
}

/**
 * Advances the investigation. A vendor can never be blacklisted directly — the
 * case must pass through investigation, vendor response and review first.
 */
export async function advanceBlacklistCase(
  user: SessionUser,
  caseId: string,
  to: BlacklistStage,
  input: {
    notes?: string | null;
    vendorResponse?: string | null;
    procurementReview?: string | null;
    auditReview?: string | null;
    decision?: "BLACKLIST" | "RETAIN" | "WARNING" | "SUSPEND";
    decisionNotes?: string | null;
  } = {},
  db: DbClient = prisma,
) {
  const kase = await db.vendorBlacklistCase.findUnique({
    where: { id: caseId },
    include: { vendor: true },
  });
  if (!kase) throw new NotFoundError("Investigation case");

  const from = kase.stage as BlacklistStage;
  const allowed = BLACKLIST_FLOW[from] ?? [];
  if (!allowed.includes(to)) {
    throw new RuleViolationError(
      `Cannot move investigation ${kase.number} from ${from} to ${to}. Permitted: ${allowed.join(", ") || "none"}.`,
    );
  }

  if (to === "AUDIT_REVIEW" && !userHasPermission(user, P.VENDOR_AUDIT_REVIEW, P.VENDOR_BLACKLIST)) {
    throw new ForbiddenError("Only audit may record the audit review.");
  }
  if (["BLACKLISTED", "WARNING_ISSUED", "RETAINED"].includes(to) && !userHasPermission(user, P.VENDOR_BLACKLIST)) {
    throw new ForbiddenError("Only an authorised approver may decide the outcome of an investigation.");
  }
  if (!userHasPermission(user, P.VENDOR_ISSUE_RAISE, P.VENDOR_BLACKLIST, P.VENDOR_AUDIT_REVIEW)) {
    throw new ForbiddenError("Not permitted.");
  }

  if (to === "DECISION_PENDING") {
    if (kase.auditRequired && !kase.auditReview?.trim() && from !== "AUDIT_REVIEW") {
      throw new RuleViolationError(
        `Investigation ${kase.number} requires an audit review before a decision can be taken.`,
      );
    }
    if (!kase.investigationNotes?.trim() && !input.notes?.trim()) {
      throw new RuleViolationError("Record the investigation findings before moving to decision.");
    }
  }
  if (["BLACKLISTED", "WARNING_ISSUED", "RETAINED"].includes(to) && !input.decisionNotes?.trim()) {
    throw new ValidationError("Record the basis for the decision.");
  }

  const data: Record<string, unknown> = { stage: to };
  if (to === "INVESTIGATION" || to === "EVIDENCE_COLLECTION") {
    data.investigationNotes = [kase.investigationNotes, input.notes].filter(Boolean).join("\n");
  }
  if (to === "VENDOR_RESPONSE_AWAITED" && input.vendorResponse) {
    data.vendorResponse = input.vendorResponse;
    data.vendorRespondedAt = new Date();
  }
  if (to === "PROCUREMENT_REVIEW") {
    data.procurementReview = input.procurementReview ?? input.notes ?? null;
    if (input.vendorResponse) {
      data.vendorResponse = input.vendorResponse;
      data.vendorRespondedAt = new Date();
    }
  }
  if (to === "AUDIT_REVIEW") data.auditReview = input.auditReview ?? input.notes ?? null;

  const decisionMap: Partial<Record<BlacklistStage, "BLACKLIST" | "RETAIN" | "WARNING">> = {
    BLACKLISTED: "BLACKLIST",
    RETAINED: "RETAIN",
    WARNING_ISSUED: "WARNING",
  };
  const decision = decisionMap[to] ?? input.decision ?? null;
  if (decision) {
    data.decision = decision;
    data.decisionBy = user.id;
    data.decisionAt = new Date();
    data.decisionNotes = input.decisionNotes ?? input.notes ?? null;
  }
  if (to === "CLOSED") data.closedAt = new Date();

  const updated = await db.vendorBlacklistCase.update({ where: { id: caseId }, data });

  // Apply the decision to the vendor record.
  if (to === "BLACKLISTED") {
    await db.vendor.update({
      where: { id: kase.vendorId },
      data: {
        status: "BLACKLISTED",
        statusReason: `${kase.number}: ${input.decisionNotes ?? kase.reason}`,
        blacklistedAt: new Date(),
      },
    });
    await db.vendorEntityLink.updateMany({ where: { vendorId: kase.vendorId }, data: { approved: false } });
    // Withdraw the vendor from live sourcing.
    await db.rfqVendor.updateMany({
      where: { vendorId: kase.vendorId, status: "INVITED", rfq: { status: { in: ["DRAFT", "ISSUED", "RESPONSES_IN"] } } },
      data: { status: "DECLINED", notes: `Withdrawn — vendor blacklisted via ${kase.number}` },
    });
    await notify(
      {
        roleCodes: ["PROCUREMENT_OFFICER", "BUYER", "PROCUREMENT_SENIOR_MANAGER", "FINANCE_APPROVER", "AUDIT_USER"],
        type: "VENDOR_ISSUE",
        title: `${kase.vendor.name} has been blacklisted`,
        body: input.decisionNotes ?? kase.reason,
        priority: "CRITICAL",
        linkType: "VENDOR",
        linkId: kase.vendorId,
        linkUrl: `/vendors/${kase.vendorId}`,
      },
      db,
    );
  } else if (to === "RETAINED") {
    await db.vendor.update({
      where: { id: kase.vendorId },
      data: {
        status: kase.vendor.approvedAt ? "APPROVED" : "PENDING_APPROVAL",
        statusReason: `Retained after investigation ${kase.number}`,
      },
    });
  } else if (to === "WARNING_ISSUED") {
    await db.vendor.update({
      where: { id: kase.vendorId },
      data: {
        status: "CONDITIONAL",
        statusReason: `Formal warning issued via ${kase.number}: ${input.decisionNotes ?? kase.reason}`,
      },
    });
  }

  if (["BLACKLISTED", "WARNING_ISSUED", "RETAINED", "CLOSED"].includes(to)) {
    await completeTasks("VENDOR_BLACKLIST", caseId, user.id, db);
  } else {
    const nextRole =
      to === "AUDIT_REVIEW"
        ? "AUDIT_USER"
        : to === "DECISION_PENDING"
          ? "PROCUREMENT_DIRECTOR"
          : "PROCUREMENT_SENIOR_MANAGER";
    await createTask(
      {
        title: `${kase.number} — ${to.replace(/_/g, " ").toLowerCase()} (${kase.vendor.name})`,
        taskType: "REVIEW",
        assignedRoleCode: nextRole,
        documentType: "VENDOR_BLACKLIST",
        documentId: caseId,
        documentRef: kase.number,
        priority: "HIGH",
        slaHours: 96,
        linkUrl: `/vendors/blacklist/${caseId}`,
      },
      db,
    );
  }

  await writeAudit(
    {
      entityType: "VendorBlacklistCase",
      entityId: caseId,
      entityRef: kase.number,
      action: `BLACKLIST_${to}`,
      changes: { stage: { from, to } },
      reason: input.decisionNotes ?? input.notes ?? null,
      newValue: { decision },
      actor: user,
    },
    db,
  );

  return updated;
}

/** Reinstates a blacklisted vendor. Requires the blacklist permission and a reason. */
export async function reinstateVendor(
  user: SessionUser,
  vendorId: string,
  reason: string,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.VENDOR_BLACKLIST)) {
    throw new ForbiddenError("Only an authorised approver may reinstate a vendor.");
  }
  if (!reason?.trim() || reason.trim().length < 10) {
    throw new ValidationError("A substantive reason is required to reinstate a vendor.");
  }
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) throw new NotFoundError("Vendor");
  if (!["BLACKLISTED", "SUSPENDED", "INACTIVE"].includes(vendor.status)) {
    throw new RuleViolationError(`${vendor.name} is not blacklisted, suspended or inactive.`);
  }
  const updated = await db.vendor.update({
    where: { id: vendorId },
    data: { status: "CONDITIONAL", statusReason: `Reinstated: ${reason.trim()}`, blacklistedAt: null },
  });
  await db.vendorEntityLink.updateMany({ where: { vendorId }, data: { approved: true } });
  await writeAudit(
    {
      entityType: "Vendor",
      entityId: vendorId,
      entityRef: vendor.code,
      action: "VENDOR_REINSTATED",
      changes: { status: { from: vendor.status, to: "CONDITIONAL" } },
      reason: reason.trim(),
      actor: user,
    },
    db,
  );
  return updated;
}

/* ── Trader / MOQ tracking ────────────────────────────────── */

/**
 * Records the rationale when a trader is used because a principal vendor's
 * minimum order quantity does not suit the requirement.
 */
export async function recordTraderCase(
  user: SessionUser,
  input: {
    prId: string;
    principalVendorId: string;
    traderVendorId: string;
    moq: number;
    requiredQuantity: number;
    priceDifference: number;
    deliveryDays?: number | null;
    deliveryCharges?: number | null;
    reason: string;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.VENDOR_SELECT)) throw new ForbiddenError("Not permitted.");
  if (!input.reason?.trim()) throw new ValidationError("Record why the trader was selected.");

  const [pr, principal, trader] = await Promise.all([
    db.purchaseRequisition.findUnique({ where: { id: input.prId } }),
    db.vendor.findUnique({ where: { id: input.principalVendorId } }),
    db.vendor.findUnique({ where: { id: input.traderVendorId } }),
  ]);
  if (!pr) throw new NotFoundError("Requisition");
  if (!principal || !trader) throw new NotFoundError("Vendor");
  if (input.requiredQuantity >= input.moq) {
    throw new RuleViolationError(
      `Required quantity (${input.requiredQuantity}) meets the principal vendor's minimum order quantity (${input.moq}) — a trader case is not warranted.`,
    );
  }

  await writeAudit(
    {
      entityType: "PurchaseRequisition",
      entityId: pr.id,
      entityRef: pr.number,
      action: "TRADER_CASE_RECORDED",
      newValue: {
        principalVendor: principal.name,
        trader: trader.name,
        moq: input.moq,
        requiredQuantity: input.requiredQuantity,
        priceDifference: input.priceDifference,
        deliveryDays: input.deliveryDays ?? null,
        deliveryCharges: input.deliveryCharges ?? null,
      },
      reason: input.reason.trim(),
      caseKey: pr.number,
      actor: user,
    },
    db,
  );

  return raiseException(
    {
      type: "OTHER",
      severity: "LOW",
      title: `${pr.number}: trader ${trader.name} used below ${principal.name} MOQ`,
      description: `Required ${input.requiredQuantity} against an MOQ of ${input.moq}. Price difference PKR ${input.priceDifference.toLocaleString("en-PK")}. ${input.reason.trim()}`,
      documentType: "PR",
      documentId: pr.id,
      documentRef: pr.number,
      caseKey: pr.number,
      entityId: pr.entityId,
      raisedById: user.id,
      ownerId: user.id,
    },
    db,
    user,
  );
}

/** Vendors whose scheduled re-evaluation is overdue. */
export async function vendorsDueForReevaluation(db: DbClient = prisma) {
  const months = await getConfigNumber(CONFIG_KEYS.VENDOR_REEVALUATION_MONTHS, null, db);
  const cutoff = new Date(Date.now() - months * 30 * 86400000);
  const vendors = await db.vendor.findMany({
    where: { status: { in: ["APPROVED", "CONDITIONAL"] } },
    include: { evaluations: { orderBy: { evaluatedAt: "desc" }, take: 1 } },
  });
  return vendors
    .filter((v) => {
      const last = v.evaluations[0]?.evaluatedAt ?? v.approvedAt ?? v.createdAt;
      return last < cutoff;
    })
    .map((v) => ({
      id: v.id,
      code: v.code,
      name: v.name,
      status: v.status,
      lastEvaluatedAt: v.evaluations[0]?.evaluatedAt ?? v.approvedAt ?? v.createdAt,
      currentScore: v.currentScore,
      maxScore: v.maxScore,
    }));
}

export function scoreBand(percent: number | null | undefined) {
  if (percent === null || percent === undefined) return { label: "Not scored", tone: "neutral" as const };
  if (percent >= 80) return { label: "Strong", tone: "success" as const };
  if (percent >= 60) return { label: "Acceptable", tone: "info" as const };
  if (percent >= 50) return { label: "Marginal", tone: "warning" as const };
  return { label: "Below standard", tone: "danger" as const };
}

export { safeDiv };
