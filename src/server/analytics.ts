import { prisma, type DbClient } from "@/lib/db";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { PO_OPEN_STATUSES } from "@/lib/domain";
import { round2, safeDiv } from "@/lib/format";
import { nullableEntityScope } from "@/lib/rbac";
import { PERMISSIONS as P } from "@/lib/permissions";
import { DOMAIN_ACTIONS, assertAuthority, type Actor, type Authority } from "@/lib/actor";

/**
 * Procurement analytics. All figures derive from live transactions — nothing is
 * cached or hand-entered.
 */

export type AnalyticsFilter = {
  entityIds?: string[] | null;
  entityId?: string | null;
  departmentId?: string | null;
  categoryId?: string | null;
  vendorId?: string | null;
  projectId?: string | null;
  siteId?: string | null;
  buyerId?: string | null;
  from?: Date | null;
  to?: Date | null;
};

function entityWhere(f: AnalyticsFilter) {
  if (f.entityId) return { entityId: f.entityId };
  if (f.entityIds) return { entityId: { in: f.entityIds } };
  return {};
}

function dateWhere(f: AnalyticsFilter, field: string) {
  if (!f.from && !f.to) return {};
  return { [field]: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } };
}

export type Kpis = {
  totalProcurementValue: number;
  monthProcurementValue: number;
  prCount: number;
  prPendingApproval: number;
  avgPrApprovalHours: number;
  rfqCount: number;
  avgQuotationsPerRfq: number;
  poCount: number;
  poValue: number;
  savingsAmount: number;
  savingsPercent: number;
  openPoCount: number;
  openPoValue: number;
  overduePoCount: number;
  grnPendingCount: number;
  invoicesPendingCount: number;
  invoiceMismatchCount: number;
  paymentPendingCount: number;
  paymentPendingValue: number;
  pettyCashSpend: number;
  pettyCashStoreGap: number;
  cpcPendingCount: number;
  cpcApprovedCount: number;
  avgCycleTimeDays: number;
  activeVendors: number;
  blacklistedVendors: number;
  openExceptions: number;
  criticalExceptions: number;
  inventoryValue: number;
  assetCount: number;
};

export async function procurementKpis(f: AnalyticsFilter, db: DbClient = prisma): Promise<Kpis> {
  const ew = entityWhere(f);
  // Exceptions carry a nullable entity, so they scope differently from documents.
  const exceptionScope = nullableEntityScope(f.entityId ?? null, f.entityIds ?? null);
  // Deliveries, invoices and payments reach their entity through the order they
  // belong to. Without this they were counted across every entity while the
  // figures beside them were scoped, so one row of tiles disagreed with itself.
  const viaPo = Object.keys(ew).length ? { po: ew } : {};
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const poWhere = {
    ...ew,
    status: { notIn: ["DRAFT", "CANCELLED", "PENDING_APPROVAL"] },
    ...(f.vendorId ? { vendorId: f.vendorId } : {}),
    ...(f.buyerId ? { createdById: f.buyerId } : {}),
    ...dateWhere(f, "createdAt"),
  };

  const [
    poAgg,
    poMonthAgg,
    prCount,
    prPending,
    prApproved,
    rfqCount,
    quoteCount,
    savingsAgg,
    openPos,
    grnPending,
    invoicePending,
    invoiceMismatch,
    handoffPending,
    pettyCash,
    cpcPending,
    cpcApproved,
    closedPrs,
    activeVendors,
    blacklisted,
    openExceptions,
    criticalExceptions,
    inventoryAgg,
    assetCount,
  ] = await Promise.all([
    db.purchaseOrder.aggregate({ where: poWhere, _sum: { total: true }, _count: { _all: true } }),
    db.purchaseOrder.aggregate({
      where: { ...poWhere, createdAt: { gte: monthStart } },
      _sum: { total: true },
    }),
    db.purchaseRequisition.count({
      where: { ...ew, ...dateWhere(f, "createdAt"), ...(f.departmentId ? { departmentId: f.departmentId } : {}) },
    }),
    db.purchaseRequisition.count({
      where: { ...ew, status: { in: ["SUBMITTED", "UNDER_DEPARTMENT_APPROVAL", "PROCUREMENT_REVIEW"] } },
    }),
    db.purchaseRequisition.findMany({
      where: { ...ew, submittedAt: { not: null }, approvedAt: { not: null }, ...dateWhere(f, "submittedAt") },
      select: { submittedAt: true, approvedAt: true },
      take: 500,
      orderBy: { approvedAt: "desc" },
    }),
    db.rfq.count({ where: { pr: { ...ew }, ...dateWhere(f, "createdAt") } }),
    db.vendorQuote.count({ where: { rfq: { pr: { ...ew } }, ...dateWhere(f, "createdAt") } }),
    db.savingsRecord.aggregate({
      where: { ...(f.entityId ? { entityId: f.entityId } : f.entityIds ? { entityId: { in: f.entityIds } } : {}), ...dateWhere(f, "recordedAt") },
      _sum: { totalSavings: true, finalPrice: true },
    }),
    db.purchaseOrder.findMany({
      where: { ...ew, status: { in: PO_OPEN_STATUSES } },
      select: { total: true, deliveryDate: true, items: { select: { quantity: true, acceptedQty: true, unitPrice: true } } },
    }),
    db.delivery.count({ where: { grns: { none: {} }, status: { not: "REJECTED" }, ...viaPo } }),
    db.invoice.count({
      where: {
        status: { in: ["RECEIVED", "UNDER_VERIFICATION", "MATCHED", "PENDING_APPROVAL", "MISMATCH"] },
        ...viaPo,
      },
    }),
    db.invoice.count({ where: { OR: [{ matchStatus: "FAILED" }, { status: "MISMATCH" }], ...viaPo } }),
    db.paymentHandoff.aggregate({
      where: {
        status: { in: ["PENDING", "ACKNOWLEDGED", "SCHEDULED"] },
        ...(Object.keys(ew).length ? { invoice: { po: ew } } : {}),
      },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    db.pettyCashRequest.aggregate({
      where: { ...ew, status: { notIn: ["DRAFT", "REJECTED", "CANCELLED"] }, ...dateWhere(f, "createdAt") },
      _sum: { actualAmount: true, approvedAmount: true, estimatedAmount: true },
    }),
    db.cpcCase.count({ where: { pr: { ...ew }, status: { in: ["PENDING", "SCHEDULED", "UNDER_REVIEW"] } } }),
    db.cpcCase.count({ where: { pr: { ...ew }, status: "APPROVED" } }),
    db.purchaseRequisition.findMany({
      where: { ...ew, status: "CLOSED", submittedAt: { not: null }, closedAt: { not: null } },
      select: { submittedAt: true, closedAt: true },
      take: 300,
      orderBy: { closedAt: "desc" },
    }),
    db.vendor.count({ where: { status: { in: ["APPROVED", "CONDITIONAL"] } } }),
    db.vendor.count({ where: { status: "BLACKLISTED" } }),
    db.exception.count({ where: { status: { in: ["OPEN", "IN_PROGRESS"] }, ...exceptionScope } }),
    db.exception.count({
      where: { status: { in: ["OPEN", "IN_PROGRESS"] }, severity: "CRITICAL", ...exceptionScope },
    }),
    db.inventoryItem.aggregate({
      where: f.entityId ? { store: { entityId: f.entityId } } : f.entityIds ? { store: { entityId: { in: f.entityIds } } } : {},
      _sum: { totalValue: true },
    }),
    db.asset.count({ where: { ...ew, status: { notIn: ["DISPOSED", "SCRAPPED"] } } }),
  ]);

  const approvalHours = prApproved
    .filter((p) => p.submittedAt && p.approvedAt)
    .map((p) => (p.approvedAt!.getTime() - p.submittedAt!.getTime()) / 3600000);
  const cycleDays = closedPrs
    .filter((p) => p.submittedAt && p.closedAt)
    .map((p) => (p.closedAt!.getTime() - p.submittedAt!.getTime()) / 86400000);

  const now = Date.now();
  const openPoValue = round2(
    openPos.reduce(
      (a, p) => a + p.items.reduce((s, i) => s + Math.max(0, i.quantity - i.acceptedQty) * i.unitPrice, 0),
      0,
    ),
  );
  const overdue = openPos.filter((p) => p.deliveryDate && p.deliveryDate.getTime() < now).length;

  const savings = round2(savingsAgg._sum.totalSavings ?? 0);
  const savingsBase = round2(savingsAgg._sum.finalPrice ?? 0);

  const pettyCashSpend = round2(
    pettyCash._sum.actualAmount ?? pettyCash._sum.approvedAmount ?? pettyCash._sum.estimatedAmount ?? 0,
  );
  const { pettyCashStoreEntryGap } = await import("./pettycash");
  const gap = await pettyCashStoreEntryGap(f.entityId ? [f.entityId] : (f.entityIds ?? null), db);

  return {
    totalProcurementValue: round2(poAgg._sum.total ?? 0),
    monthProcurementValue: round2(poMonthAgg._sum.total ?? 0),
    prCount,
    prPendingApproval: prPending,
    avgPrApprovalHours: approvalHours.length ? round2(approvalHours.reduce((a, b) => a + b, 0) / approvalHours.length) : 0,
    rfqCount,
    avgQuotationsPerRfq: rfqCount ? round2(quoteCount / rfqCount) : 0,
    poCount: poAgg._count._all,
    poValue: round2(poAgg._sum.total ?? 0),
    savingsAmount: savings,
    savingsPercent: savingsBase + savings > 0 ? round2((savings / (savingsBase + savings)) * 100) : 0,
    openPoCount: openPos.length,
    openPoValue,
    overduePoCount: overdue,
    grnPendingCount: grnPending,
    invoicesPendingCount: invoicePending,
    invoiceMismatchCount: invoiceMismatch,
    paymentPendingCount: handoffPending._count._all,
    paymentPendingValue: round2(handoffPending._sum.amount ?? 0),
    pettyCashSpend,
    pettyCashStoreGap: gap.length,
    cpcPendingCount: cpcPending,
    cpcApprovedCount: cpcApproved,
    avgCycleTimeDays: cycleDays.length ? round2(cycleDays.reduce((a, b) => a + b, 0) / cycleDays.length) : 0,
    activeVendors,
    blacklistedVendors: blacklisted,
    openExceptions,
    criticalExceptions,
    inventoryValue: round2(inventoryAgg._sum.totalValue ?? 0),
    assetCount,
  };
}

/* ── Spend breakdowns ─────────────────────────────────────── */

export type SpendSlice = { key: string; label: string; value: number; count: number };

export async function spendByDimension(
  dimension: "entity" | "department" | "category" | "vendor" | "project" | "site" | "buyer" | "procurementType",
  f: AnalyticsFilter,
  db: DbClient = prisma,
): Promise<SpendSlice[]> {
  const pos = await db.purchaseOrder.findMany({
    where: {
      ...entityWhere(f),
      status: { notIn: ["DRAFT", "CANCELLED", "PENDING_APPROVAL"] },
      ...(f.vendorId ? { vendorId: f.vendorId } : {}),
      ...dateWhere(f, "createdAt"),
    },
    include: {
      entity: { select: { code: true, name: true } },
      vendor: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      items: { include: { item: { include: { category: { select: { id: true, name: true } } } } } },
      pr: {
        include: {
          department: { select: { id: true, name: true } },
          project: { select: { id: true, name: true } },
          site: { select: { id: true, name: true } },
        },
      },
    },
  });

  const map = new Map<string, SpendSlice>();
  const add = (key: string, label: string, value: number) => {
    const cur = map.get(key) ?? { key, label, value: 0, count: 0 };
    cur.value = round2(cur.value + value);
    cur.count += 1;
    map.set(key, cur);
  };

  for (const po of pos) {
    if (dimension === "category") {
      for (const it of po.items) {
        const c = it.item?.category;
        add(c?.id ?? "none", c?.name ?? "Uncategorised", it.lineTotal);
      }
      continue;
    }
    if (dimension === "entity") add(po.entityId, `${po.entity.code} — ${po.entity.name}`, po.total);
    else if (dimension === "vendor") add(po.vendor.id, po.vendor.name, po.total);
    else if (dimension === "buyer") add(po.createdBy.id, po.createdBy.name, po.total);
    else if (dimension === "department") {
      const d = po.pr?.department;
      add(d?.id ?? "none", d?.name ?? "Unassigned", po.total);
    } else if (dimension === "project") {
      const p = po.pr?.project;
      add(p?.id ?? "none", p?.name ?? "Non-project", po.total);
    } else if (dimension === "site") {
      const s = po.pr?.site;
      add(s?.id ?? "none", s?.name ?? "No site", po.total);
    } else if (dimension === "procurementType") {
      const t = po.pr?.procurementType ?? "UNSPECIFIED";
      add(t, t.replace(/_/g, " "), po.total);
    }
  }

  return [...map.values()].sort((a, b) => b.value - a.value);
}

export type MonthlyPoint = { label: string; monthKey: string; poValue: number; poCount: number; prCount: number; savings: number };

export async function monthlyTrend(
  f: AnalyticsFilter,
  months = 12,
  db: DbClient = prisma,
): Promise<MonthlyPoint[]> {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

  const [pos, prs, savings] = await Promise.all([
    db.purchaseOrder.findMany({
      where: { ...entityWhere(f), status: { notIn: ["DRAFT", "CANCELLED", "PENDING_APPROVAL"] }, createdAt: { gte: start } },
      select: { createdAt: true, total: true },
    }),
    db.purchaseRequisition.findMany({
      where: { ...entityWhere(f), createdAt: { gte: start } },
      select: { createdAt: true },
    }),
    db.savingsRecord.findMany({
      where: {
        ...(f.entityId ? { entityId: f.entityId } : f.entityIds ? { entityId: { in: f.entityIds } } : {}),
        recordedAt: { gte: start },
      },
      select: { recordedAt: true, totalSavings: true },
    }),
  ]);

  const buckets = new Map<string, MonthlyPoint>();
  for (let i = 0; i < months; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    buckets.set(key, {
      monthKey: key,
      label: d.toLocaleDateString("en-GB", { month: "short" }),
      poValue: 0,
      poCount: 0,
      prCount: 0,
      savings: 0,
    });
  }
  const keyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  for (const p of pos) {
    const b = buckets.get(keyOf(p.createdAt));
    if (b) {
      b.poValue = round2(b.poValue + p.total);
      b.poCount += 1;
    }
  }
  for (const p of prs) {
    const b = buckets.get(keyOf(p.createdAt));
    if (b) b.prCount += 1;
  }
  for (const s of savings) {
    const b = buckets.get(keyOf(s.recordedAt));
    if (b) b.savings = round2(b.savings + s.totalSavings);
  }
  return [...buckets.values()];
}

/* ── Savings ──────────────────────────────────────────────── */

export type SavingsRow = {
  id: string;
  itemDescription: string;
  quantity: number;
  marketPrice: number | null;
  previousPrice: number | null;
  initialQuote: number | null;
  negotiatedPrice: number | null;
  finalPrice: number;
  savingsPerUnit: number;
  totalSavings: number;
  savingsPercent: number;
  savingsType: string;
  recordedAt: Date;
  poNumber: string | null;
  vendorName: string | null;
  entityCode: string | null;
  categoryName: string | null;
  notes: string | null;
};

export async function savingsRows(f: AnalyticsFilter, db: DbClient = prisma): Promise<SavingsRow[]> {
  const rows = await db.savingsRecord.findMany({
    where: {
      ...(f.entityId ? { entityId: f.entityId } : f.entityIds ? { entityId: { in: f.entityIds } } : {}),
      ...(f.vendorId ? { vendorId: f.vendorId } : {}),
      ...(f.categoryId ? { categoryId: f.categoryId } : {}),
      ...dateWhere(f, "recordedAt"),
    },
    orderBy: { recordedAt: "desc" },
    include: { po: { select: { number: true } } },
  });

  const vendorIds = [...new Set(rows.map((r) => r.vendorId).filter((x): x is string => !!x))];
  const categoryIds = [...new Set(rows.map((r) => r.categoryId).filter((x): x is string => !!x))];
  const entityIds = [...new Set(rows.map((r) => r.entityId).filter((x): x is string => !!x))];
  const [vendors, categories, entities] = await Promise.all([
    db.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, name: true } }),
    db.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } }),
    db.entity.findMany({ where: { id: { in: entityIds } }, select: { id: true, code: true } }),
  ]);
  const vMap = new Map(vendors.map((v) => [v.id, v.name]));
  const cMap = new Map(categories.map((c) => [c.id, c.name]));
  const eMap = new Map(entities.map((e) => [e.id, e.code]));

  return rows.map((r) => ({
    id: r.id,
    itemDescription: r.itemDescription,
    quantity: r.quantity,
    marketPrice: r.marketPrice,
    previousPrice: r.previousPrice,
    initialQuote: r.initialQuote,
    negotiatedPrice: r.negotiatedPrice,
    finalPrice: r.finalPrice,
    savingsPerUnit: r.savingsPerUnit,
    totalSavings: r.totalSavings,
    savingsPercent: r.savingsPercent,
    savingsType: r.savingsType,
    recordedAt: r.recordedAt,
    poNumber: r.po?.number ?? null,
    vendorName: r.vendorId ? (vMap.get(r.vendorId) ?? null) : null,
    entityCode: r.entityId ? (eMap.get(r.entityId) ?? null) : null,
    categoryName: r.categoryId ? (cMap.get(r.categoryId) ?? null) : null,
    notes: r.notes,
  }));
}

/**
 * Records realised savings for a PO, derived from the comparative baselines.
 * Called at PO creation so savings reflect actual awards.
 */
export async function recordSavingsForPo(
  actor: Actor,
  poId: string,
  db: DbClient = prisma,
  authority: Authority = { permission: [P.PO_CREATE, P.PO_EDIT, P.ANALYTICS_VIEW] },
) {
  assertAuthority(actor, DOMAIN_ACTIONS.SAVINGS_RECORD, authority);
  const po = await db.purchaseOrder.findUnique({
    where: { id: poId },
    include: {
      items: { include: { item: { select: { categoryId: true, standardPrice: true } } } },
      quote: { include: { negotiations: { orderBy: { round: "asc" } } } },
      pr: { include: { comparatives: { orderBy: { preparedAt: "desc" }, take: 1, include: { lines: { where: { isSelected: true } } } } } },
      vendor: { select: { id: true } },
    },
  });
  if (!po) return null;

  const comparative = po.pr?.comparatives[0];
  const selected = comparative?.lines[0];
  const existing = await db.savingsRecord.findFirst({ where: { poId } });
  if (existing) return existing;

  const initialQuote = po.quote?.total ?? null;
  const negotiated = po.quote?.negotiations.length
    ? (po.quote.negotiations[po.quote.negotiations.length - 1].finalTotal ??
      po.quote.negotiations[po.quote.negotiations.length - 1].negotiatedTotal)
    : null;
  // Mirror the comparative's measure: the greater of what the vendor conceded
  // and how the award compares to the market or last paid price.
  const negotiationSaving = round2(Math.max(0, (initialQuote ?? po.total) - po.total));
  const marketBaseline = Math.max(comparative?.marketPrice ?? 0, comparative?.previousPrice ?? 0) || null;
  const baselineSaving = marketBaseline ? round2(Math.max(0, marketBaseline - po.total)) : 0;
  const totalSavings = round2(Math.max(negotiationSaving, baselineSaving));
  const baseline = baselineSaving >= negotiationSaving && marketBaseline ? marketBaseline : (initialQuote ?? po.total);
  if (totalSavings <= 0) return null;

  const qty = round2(po.items.reduce((a, i) => a + i.quantity, 0));
  const savingsType =
    baselineSaving > negotiationSaving && comparative?.marketPrice
      ? "MARKET_RATE"
      : negotiated
        ? "NEGOTIATION"
        : selected && !selected.isLowest
          ? "VENDOR_SWITCH"
          : "MARKET_RATE";

  return db.savingsRecord.create({
    data: {
      comparativeId: comparative?.id ?? null,
      poId: po.id,
      entityId: po.entityId,
      categoryId: po.items[0]?.item?.categoryId ?? null,
      vendorId: po.vendorId,
      itemDescription: po.items.map((i) => i.description).slice(0, 3).join("; ") || "Purchase order",
      quantity: qty,
      marketPrice: comparative?.marketPrice ?? null,
      previousPrice: comparative?.previousPrice ?? null,
      initialQuote,
      negotiatedPrice: negotiated,
      finalPrice: po.total,
      savingsPerUnit: qty > 0 ? round2(totalSavings / qty) : 0,
      totalSavings,
      savingsPercent: baseline > 0 ? round2((totalSavings / baseline) * 100) : 0,
      savingsType,
      notes: comparative?.recommendationBasis ?? null,
    },
  });
}

/* ── Bottlenecks ──────────────────────────────────────────── */

export type Bottleneck = {
  id: string;
  stage: string;
  documentType: string;
  documentId: string;
  documentRef: string;
  title: string;
  owner: string;
  ageHours: number;
  slaHours: number | null;
  overdue: boolean;
  reason: string;
  nextAction: string;
  value: number | null;
  entityCode: string | null;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  href: string;
};

/**
 * Assembles the bottleneck board: every place work is sitting, with owner, age,
 * SLA, reason and the next action required.
 */
export async function bottlenecks(f: AnalyticsFilter, db: DbClient = prisma): Promise<Bottleneck[]> {
  const ew = entityWhere(f);
  const now = Date.now();
  const out: Bottleneck[] = [];

  const sla = {
    dept: await getConfigNumber(CONFIG_KEYS.SLA_DEPT_APPROVAL_HOURS, f.entityId ?? null, db),
    proc: await getConfigNumber(CONFIG_KEYS.SLA_PROCUREMENT_REVIEW_HOURS, f.entityId ?? null, db),
    rfq: await getConfigNumber(CONFIG_KEYS.SLA_RFQ_RESPONSE_HOURS, f.entityId ?? null, db),
    comp: await getConfigNumber(CONFIG_KEYS.SLA_COMPARATIVE_HOURS, f.entityId ?? null, db),
    cpc: await getConfigNumber(CONFIG_KEYS.SLA_CPC_HOURS, f.entityId ?? null, db),
    po: await getConfigNumber(CONFIG_KEYS.SLA_PO_APPROVAL_HOURS, f.entityId ?? null, db),
    grn: await getConfigNumber(CONFIG_KEYS.SLA_GRN_HOURS, f.entityId ?? null, db),
    insp: await getConfigNumber(CONFIG_KEYS.SLA_INSPECTION_HOURS, f.entityId ?? null, db),
    inv: await getConfigNumber(CONFIG_KEYS.SLA_INVOICE_VERIFICATION_HOURS, f.entityId ?? null, db),
  };

  const hoursSince = (d: Date | null | undefined) => (d ? Math.floor((now - d.getTime()) / 3600000) : 0);
  const sev = (age: number, limit: number | null): Bottleneck["severity"] => {
    if (!limit) return "LOW";
    const r = age / limit;
    if (r >= 3) return "CRITICAL";
    if (r >= 2) return "HIGH";
    if (r >= 1) return "MEDIUM";
    return "LOW";
  };

  // 1. PRs waiting for approval
  const pendingPrs = await db.purchaseRequisition.findMany({
    where: { ...ew, status: { in: ["SUBMITTED", "UNDER_DEPARTMENT_APPROVAL"] } },
    include: { entity: { select: { code: true } }, department: { select: { name: true } } },
  });
  for (const pr of pendingPrs) {
    const age = hoursSince(pr.submittedAt ?? pr.createdAt);
    out.push({
      id: `pr-approval-${pr.id}`,
      stage: "Department approval",
      documentType: "PR",
      documentId: pr.id,
      documentRef: pr.number,
      title: pr.title,
      owner: `HOD — ${pr.department.name}`,
      ageHours: age,
      slaHours: sla.dept,
      overdue: age > sla.dept,
      reason: "Awaiting department head decision.",
      nextAction: "Department head to approve, return or reject.",
      value: pr.estimatedValue,
      entityCode: pr.entity.code,
      severity: sev(age, sla.dept),
      href: `/pr/${pr.id}`,
    });
  }

  // 2. PRs returned for missing information
  const returned = await db.purchaseRequisition.findMany({
    where: { ...ew, status: "RETURNED" },
    include: { entity: { select: { code: true } }, requester: { select: { name: true } } },
  });
  for (const pr of returned) {
    const age = hoursSince(pr.updatedAt);
    out.push({
      id: `pr-returned-${pr.id}`,
      stage: "Returned to requester",
      documentType: "PR",
      documentId: pr.id,
      documentRef: pr.number,
      title: pr.title,
      owner: pr.requester.name,
      ageHours: age,
      slaHours: 48,
      overdue: age > 48,
      reason: pr.returnReason ?? "Returned for revision.",
      nextAction: "Requester to revise and resubmit.",
      value: pr.estimatedValue,
      entityCode: pr.entity.code,
      severity: sev(age, 48),
      href: `/pr/${pr.id}`,
    });
  }

  // 3. PRs approved but not yet sourced
  const awaitingSourcing = await db.purchaseRequisition.findMany({
    where: { ...ew, status: { in: ["APPROVED", "PROCUREMENT_REVIEW"] } },
    include: { entity: { select: { code: true } } },
  });
  for (const pr of awaitingSourcing) {
    const age = hoursSince(pr.approvedAt ?? pr.submittedAt);
    out.push({
      id: `pr-sourcing-${pr.id}`,
      stage: "Procurement review",
      documentType: "PR",
      documentId: pr.id,
      documentRef: pr.number,
      title: pr.title,
      owner: "Procurement",
      ageHours: age,
      slaHours: sla.proc,
      overdue: age > sla.proc,
      reason: "Approved requisition has not entered sourcing.",
      nextAction: "Raise an RFQ and invite vendors.",
      value: pr.estimatedValue,
      entityCode: pr.entity.code,
      severity: sev(age, sla.proc),
      href: `/pr/${pr.id}`,
    });
  }

  // 4. RFQs awaiting vendor quotations
  const openRfqs = await db.rfq.findMany({
    where: { status: { in: ["ISSUED", "RESPONSES_IN"] }, pr: { ...ew } },
    include: { pr: { include: { entity: { select: { code: true } } } }, vendors: true, quotes: true },
  });
  for (const rfq of openRfqs) {
    const age = hoursSince(rfq.issuedAt ?? rfq.createdAt);
    const outstanding = rfq.vendors.filter((v) => v.status === "INVITED").length;
    if (outstanding === 0) continue;
    out.push({
      id: `rfq-${rfq.id}`,
      stage: "Vendor quotation pending",
      documentType: "RFQ",
      documentId: rfq.id,
      documentRef: rfq.number,
      title: rfq.title,
      owner: "Procurement / vendors",
      ageHours: age,
      slaHours: sla.rfq,
      overdue: age > sla.rfq || rfq.responseDeadline.getTime() < now,
      reason: `${outstanding} of ${rfq.vendors.length} invited vendor(s) have not responded.`,
      nextAction: "Follow up with vendors or close the RFQ with the quotations in hand.",
      value: rfq.pr.estimatedValue,
      entityCode: rfq.pr.entity.code,
      severity: sev(age, sla.rfq),
      href: `/rfq/${rfq.id}`,
    });
  }

  // 5. Quotes in, no comparative
  const rfqsNeedingComparative = await db.rfq.findMany({
    where: { status: { in: ["RESPONSES_IN", "CLOSED"] }, comparatives: { none: {} }, pr: { ...ew } },
    include: { pr: { include: { entity: { select: { code: true } } } }, quotes: true },
  });
  for (const rfq of rfqsNeedingComparative) {
    if (!rfq.quotes.length) continue;
    const age = hoursSince(rfq.quotes[rfq.quotes.length - 1]?.createdAt ?? rfq.createdAt);
    out.push({
      id: `comp-${rfq.id}`,
      stage: "Comparative pending",
      documentType: "RFQ",
      documentId: rfq.id,
      documentRef: rfq.number,
      title: rfq.title,
      owner: "Procurement",
      ageHours: age,
      slaHours: sla.comp,
      overdue: age > sla.comp,
      reason: `${rfq.quotes.length} quotation(s) received but no comparative has been prepared.`,
      nextAction: "Build the cost comparative and recommend a vendor.",
      value: rfq.pr.estimatedValue,
      entityCode: rfq.pr.entity.code,
      severity: sev(age, sla.comp),
      href: `/rfq/${rfq.id}`,
    });
  }

  // 6. Comparative recommended, awaiting CPC or PO
  const recommended = await db.comparative.findMany({
    where: { status: "RECOMMENDED", pr: { ...ew, status: { in: ["SOURCING", "CPC_REVIEW", "PO_PREPARATION"] } } },
    include: { pr: { include: { entity: { select: { code: true } }, cpcCases: true } }, lines: { where: { isSelected: true } } },
  });
  for (const c of recommended) {
    const openCase = c.pr.cpcCases.find((k) =>
      ["PENDING", "SCHEDULED", "UNDER_REVIEW", "CLARIFICATION", "DEFERRED"].includes(k.status),
    );
    const age = hoursSince(openCase?.createdAt ?? c.updatedAt);
    out.push({
      id: `award-${c.id}`,
      stage: openCase ? "CPC decision pending" : "PO preparation",
      documentType: openCase ? "CPC_CASE" : "PR",
      documentId: openCase?.id ?? c.prId,
      documentRef: openCase?.number ?? c.pr.number,
      title: c.pr.title,
      owner: openCase ? "Central Procurement Committee" : "Procurement",
      ageHours: age,
      slaHours: openCase ? sla.cpc : sla.po,
      overdue: age > (openCase ? sla.cpc : sla.po),
      reason: openCase
        ? `CPC case ${openCase.number} is ${openCase.status.toLowerCase()}.`
        : "Vendor recommended; purchase order not yet raised.",
      nextAction: openCase ? "Committee members to record their decisions." : "Generate and submit the purchase order.",
      value: c.lines[0]?.netTotal ?? c.selectedTotal ?? c.pr.estimatedValue,
      entityCode: c.pr.entity.code,
      severity: sev(age, openCase ? sla.cpc : sla.po),
      href: openCase ? `/cpc/cases/${openCase.id}` : `/pr/${c.prId}`,
    });
  }

  // 7. POs pending approval
  const pendingPos = await db.purchaseOrder.findMany({
    where: { ...ew, status: "PENDING_APPROVAL" },
    include: { entity: { select: { code: true } }, vendor: { select: { name: true } } },
  });
  for (const po of pendingPos) {
    const age = hoursSince(po.updatedAt);
    out.push({
      id: `po-approval-${po.id}`,
      stage: "PO approval pending",
      documentType: "PO",
      documentId: po.id,
      documentRef: po.number,
      title: po.vendor.name,
      owner: "Procurement management",
      ageHours: age,
      slaHours: sla.po,
      overdue: age > sla.po,
      reason: "Purchase order awaiting authorisation.",
      nextAction: "Approver to authorise or return the purchase order.",
      value: po.total,
      entityCode: po.entity.code,
      severity: sev(age, sla.po),
      href: `/po/${po.id}`,
    });
  }

  // 8. Overdue deliveries
  const overduePos = await db.purchaseOrder.findMany({
    where: { ...ew, status: { in: ["ISSUED", "PARTIALLY_RECEIVED"] }, deliveryDate: { lt: new Date() } },
    include: { entity: { select: { code: true } }, vendor: { select: { name: true } }, items: true },
  });
  for (const po of overduePos) {
    const age = hoursSince(po.deliveryDate);
    const pendingValue = round2(
      po.items.reduce((a, i) => a + Math.max(0, i.quantity - i.acceptedQty) * i.unitPrice, 0),
    );
    if (pendingValue <= 0) continue;
    out.push({
      id: `po-late-${po.id}`,
      stage: "Delivery overdue",
      documentType: "PO",
      documentId: po.id,
      documentRef: po.number,
      title: po.vendor.name,
      owner: po.vendor.name,
      ageHours: age,
      slaHours: 24,
      overdue: true,
      reason: `Promised delivery date passed ${Math.floor(age / 24)} day(s) ago; PKR ${pendingValue.toLocaleString("en-PK")} outstanding.`,
      nextAction: "Chase the vendor, revise the date, or short-close with a reason.",
      value: pendingValue,
      entityCode: po.entity.code,
      severity: age > 24 * 30 ? "CRITICAL" : age > 24 * 14 ? "HIGH" : "MEDIUM",
      href: `/po/${po.id}`,
    });
  }

  // 9. Inspection pending
  const inspections = await db.inspection.findMany({
    where: { result: { in: ["PENDING", "IN_PROGRESS", "RE_INSPECTION_REQUIRED"] }, po: { ...ew } },
    include: { po: { include: { entity: { select: { code: true } } } }, delivery: { select: { number: true } } },
  });
  for (const i of inspections) {
    const age = hoursSince(i.scheduledAt ?? i.createdAt);
    out.push({
      id: `insp-${i.id}`,
      stage: "Inspection pending",
      documentType: "INSPECTION",
      documentId: i.id,
      documentRef: i.number,
      title: `${i.inspectionType} inspection · ${i.delivery?.number ?? ""}`.trim(),
      owner: i.department ?? "Technical department",
      ageHours: age,
      slaHours: sla.insp,
      overdue: age > sla.insp,
      reason: "Mandatory technical inspection is outstanding — the GRN is blocked.",
      nextAction: "Technical inspector to complete and sign the inspection.",
      value: i.po?.total ?? null,
      entityCode: i.po?.entity.code ?? null,
      severity: sev(age, sla.insp),
      href: `/inspections/${i.id}`,
    });
  }

  // 10. GRN pending after receipt
  const deliveriesWithoutGrn = await db.delivery.findMany({
    where: { grns: { none: {} }, status: { not: "REJECTED" }, po: { ...ew } },
    include: {
      po: { include: { entity: { select: { code: true } } } },
      store: { select: { name: true, managerId: true } },
      inspections: { select: { result: true } },
    },
  });
  for (const d of deliveriesWithoutGrn) {
    const blockedByInspection = d.inspections.some((i) =>
      ["PENDING", "IN_PROGRESS", "RE_INSPECTION_REQUIRED"].includes(i.result),
    );
    if (blockedByInspection) continue;
    const age = hoursSince(d.deliveryDate);
    out.push({
      id: `grn-${d.id}`,
      stage: "GRN pending",
      documentType: "DELIVERY",
      documentId: d.id,
      documentRef: d.number,
      title: `${d.store.name} receipt`,
      owner: d.store.name,
      ageHours: age,
      slaHours: sla.grn,
      overdue: age > sla.grn,
      reason: "Goods physically received but not yet taken into inventory via a GRN.",
      nextAction: "Store to raise and post the GRN.",
      value: d.po.total,
      entityCode: d.po.entity.code,
      severity: sev(age, sla.grn),
      href: `/receiving/${d.id}`,
    });
  }

  // 11. Invoice mismatch / verification
  const invoices = await db.invoice.findMany({
    where: {
      status: { in: ["RECEIVED", "UNDER_VERIFICATION", "MISMATCH", "PENDING_APPROVAL", "MATCHED"] },
      po: { ...ew },
    },
    include: { po: { include: { entity: { select: { code: true } } } }, vendor: { select: { name: true } } },
  });
  for (const inv of invoices) {
    const age = hoursSince(inv.receivedDate);
    const mismatch = inv.matchStatus === "FAILED";
    out.push({
      id: `inv-${inv.id}`,
      stage: mismatch ? "Invoice mismatch" : inv.status === "MATCHED" ? "Invoice approval pending" : "Invoice verification",
      documentType: "INVOICE",
      documentId: inv.id,
      documentRef: inv.number,
      title: inv.vendor.name,
      owner: mismatch ? "Procurement / Finance" : "Procurement",
      ageHours: age,
      slaHours: sla.inv,
      overdue: age > sla.inv,
      reason: mismatch
        ? (inv.matchNotes ?? "Three-way match failed.")
        : inv.status === "MATCHED"
          ? "Matched invoice awaiting payment approval."
          : "Invoice registered and awaiting three-way match.",
      nextAction: mismatch
        ? "Resolve the mismatch or obtain an authorised waiver."
        : inv.status === "MATCHED"
          ? "Submit for payment approval."
          : "Run the three-way match.",
      value: inv.total,
      entityCode: inv.po?.entity.code ?? null,
      severity: mismatch ? "HIGH" : sev(age, sla.inv),
      href: `/invoices/${inv.id}`,
    });
  }

  // 12. Finance handoffs pending payment
  const handoffs = await db.paymentHandoff.findMany({
    where: { status: { in: ["PENDING", "ACKNOWLEDGED", "SCHEDULED"] }, invoice: { po: { ...ew } } },
    include: {
      invoice: { include: { vendor: { select: { name: true } }, po: { include: { entity: { select: { code: true } } } } } },
    },
  });
  for (const h of handoffs) {
    const age = hoursSince(h.handedOffAt);
    out.push({
      id: `pay-${h.id}`,
      stage: "Finance pending",
      documentType: "PAYMENT_HANDOFF",
      documentId: h.id,
      documentRef: h.number,
      title: h.invoice.vendor.name,
      owner: "Finance",
      ageHours: age,
      slaHours: 72,
      overdue: age > 72,
      reason: `Handed to finance and ${h.status.toLowerCase()}.`,
      nextAction: "Finance to schedule and record the payment.",
      value: h.amount,
      entityCode: h.invoice.po?.entity.code ?? null,
      severity: sev(age, 72),
      href: `/finance/handoffs/${h.id}`,
    });
  }

  // 13. Petty cash store-entry gap
  const { pettyCashStoreEntryGap } = await import("./pettycash");
  const gap = await pettyCashStoreEntryGap(f.entityId ? [f.entityId] : (f.entityIds ?? null), db);
  for (const g of gap) {
    const age = Math.floor((now - g.updatedAt.getTime()) / 3600000);
    out.push({
      id: `pc-${g.id}`,
      stage: "Store entry missing",
      documentType: "PETTY_CASH",
      documentId: g.id,
      documentRef: g.number,
      title: g.purpose,
      owner: "Store",
      ageHours: age,
      slaHours: 24,
      overdue: age > 24,
      reason: `${g.unbooked} purchased item(s) have no store transaction — the request cannot be reconciled.`,
      nextAction: "Store to book the items into inventory.",
      value: g.amount,
      entityCode: g.entityCode,
      severity: age > 72 ? "HIGH" : "MEDIUM",
      href: `/petty-cash/${g.id}`,
    });
  }

  // 14. Vendor pre-qualification / re-evaluation
  const pendingVendors = await db.vendor.findMany({
    where: { status: { in: ["PROSPECT", "UNDER_EVALUATION", "PENDING_APPROVAL"] } },
    take: 60,
  });
  for (const v of pendingVendors) {
    const age = hoursSince(v.updatedAt);
    if (age < 72) continue;
    out.push({
      id: `vendor-${v.id}`,
      stage: "Stakeholder pending",
      documentType: "VENDOR",
      documentId: v.id,
      documentRef: v.code,
      title: v.name,
      owner: "Procurement",
      ageHours: age,
      slaHours: 120,
      overdue: age > 120,
      reason: `Vendor is ${v.status.replace(/_/g, " ").toLowerCase()} and has not been progressed.`,
      nextAction: v.status === "PENDING_APPROVAL" ? "Approve or reject the vendor." : "Complete pre-qualification scoring.",
      value: null,
      entityCode: null,
      severity: sev(age, 120),
      href: `/vendors/${v.id}`,
    });
  }

  return out.sort((a, b) => {
    const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    const s = rank[a.severity] - rank[b.severity];
    if (s !== 0) return s;
    return b.ageHours - a.ageHours;
  });
}

/* ── Vendor analytics ─────────────────────────────────────── */

export type VendorAnalyticsRow = {
  id: string;
  code: string;
  name: string;
  status: string;
  city: string | null;
  businessType: string;
  orders: number;
  spend: number;
  onTimePercent: number | null;
  qualityPercent: number | null;
  rejectionPercent: number | null;
  score: number | null;
  qualificationPercent: number | null;
  openIssues: number;
  invoiceIssues: number;
  avgPriceVariance: number | null;
  lastOrderAt: Date | null;
  concentrationPercent: number;
};

export async function vendorAnalytics(f: AnalyticsFilter, db: DbClient = prisma): Promise<VendorAnalyticsRow[]> {
  const vendors = await db.vendor.findMany({
    include: {
      performance: { orderBy: { periodStart: "desc" }, take: 1 },
      issues: { where: { status: { notIn: ["RESOLVED", "CLOSED"] } }, select: { id: true } },
      invoices: { select: { matchStatus: true } },
    },
    orderBy: { totalSpend: "desc" },
  });
  const totalSpend = vendors.reduce((a, v) => a + v.totalSpend, 0);

  return vendors.map((v) => ({
    id: v.id,
    code: v.code,
    name: v.name,
    status: v.status,
    city: v.city,
    businessType: v.businessType,
    orders: v.totalOrders,
    spend: v.totalSpend,
    onTimePercent: v.onTimePercent,
    qualityPercent: v.qualityPercent,
    rejectionPercent: v.rejectionPercent,
    score: v.performanceScore,
    qualificationPercent: v.scorePercent,
    openIssues: v.issues.length,
    invoiceIssues: v.invoices.filter((i) => i.matchStatus === "FAILED" || i.matchStatus === "OVERRIDDEN").length,
    avgPriceVariance: v.performance[0]?.avgPriceVariance ?? null,
    lastOrderAt: v.lastOrderAt,
    concentrationPercent: totalSpend > 0 ? round2((v.totalSpend / totalSpend) * 100) : 0,
  }));
}

/** Category spend with previous-period comparison. */
export async function categorySpendTrend(f: AnalyticsFilter, db: DbClient = prisma) {
  const now = new Date();
  const currentStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const priorStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);

  const [current, prior] = await Promise.all([
    spendByDimension("category", { ...f, from: currentStart, to: now }, db),
    spendByDimension("category", { ...f, from: priorStart, to: currentStart }, db),
  ]);
  const priorMap = new Map(prior.map((p) => [p.key, p.value]));
  return current.map((c) => ({
    ...c,
    priorValue: priorMap.get(c.key) ?? 0,
    changePercent:
      (priorMap.get(c.key) ?? 0) > 0 ? round2(((c.value - (priorMap.get(c.key) ?? 0)) / (priorMap.get(c.key) ?? 1)) * 100) : null,
  }));
}

export { safeDiv };
