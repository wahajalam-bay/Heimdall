import { prisma, type DbClient } from "@/lib/db";
import { round2 } from "@/lib/format";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { primaryPoc } from "@/server/org";

/**
 * The Cost Analysis Form.
 *
 * The comparative already held the arithmetic — rates, totals, who was lowest,
 * what was saved. What it did not hold was the form that gets signed: the
 * requisition's point of contact, the last price actually paid for each item,
 * the four compliance questions that decide whether an award above the lowest
 * quotation is defensible, and a second signature.
 *
 * Nothing here recomputes a figure the comparative already owns. This assembles
 * the sheet from what is recorded and refuses to sign it while a question on it
 * is unanswered.
 */

export type CostAnalysisItem = {
  lineNo: number;
  description: string;
  /** The last price actually paid for this item, and when. Null when never bought. */
  lastPoPrice: number | null;
  lastPoDate: Date | null;
  quantity: number;
  unit: string;
  /** Rate and extended total per vendor, keyed by comparative line id. */
  byVendor: Record<string, { rate: number | null; total: number | null }>;
};

export type CostAnalysisVendor = {
  lineId: string;
  vendorId: string;
  vendorName: string;
  subtotal: number;
  taxAmount: number;
  netTotal: number;
  paymentTerms: string | null;
  specifications: string | null;
  deliveryCommitment: string | null;
  taxInformation: string | null;
  isSelected: boolean;
  isLowest: boolean;
};

export type CostAnalysis = {
  comparativeId: string;
  number: string;
  status: string;
  prNumber: string;
  prTitle: string;
  departmentName: string;
  entityName: string;
  entityLegalName: string;
  preparedByName: string;
  preparedAt: Date;
  verifiedByName: string | null;
  verifiedAt: Date | null;
  pocName: string | null;
  pocTitle: string | null;
  taxPercent: number;
  invoiceChargedTo: string | null;
  awardedToVendorName: string | null;
  remarks: string | null;
  specialNotes: string | null;
  singleSourced: boolean | null;
  ratesLocked: boolean | null;
  vendorSelectionForm: boolean | null;
  higherRateReason: string | null;
  items: CostAnalysisItem[];
  vendors: CostAnalysisVendor[];
};

/**
 * The last price paid for each item, from the price history the orders write.
 *
 * Derived rather than typed onto the form, because a figure somebody keys in is
 * a figure that can be keyed in wrongly, and the system already knows what was
 * paid.
 */
async function lastPaid(itemIds: string[], db: DbClient) {
  if (!itemIds.length) return new Map<string, { price: number; at: Date }>();
  const history = await db.priceHistory.findMany({
    where: { itemId: { in: itemIds }, source: "PO" },
    orderBy: { recordedAt: "desc" },
    select: { itemId: true, unitPrice: true, recordedAt: true },
  });
  const latest = new Map<string, { price: number; at: Date }>();
  for (const h of history) {
    if (!latest.has(h.itemId)) latest.set(h.itemId, { price: h.unitPrice, at: h.recordedAt });
  }
  return latest;
}

export async function costAnalysis(comparativeId: string, db: DbClient = prisma): Promise<CostAnalysis> {
  const c = await db.comparative.findUnique({
    where: { id: comparativeId },
    include: {
      pr: {
        include: {
          entity: { select: { name: true, legalName: true } },
          department: { select: { id: true, name: true } },
          items: {
            orderBy: { lineNo: "asc" },
            select: { id: true, lineNo: true, description: true, quantity: true, unit: true, itemId: true },
          },
        },
      },
      pocUser: { select: { name: true, title: true } },
      verifiedBy: { select: { name: true } },
      awardedToVendor: { select: { name: true } },
      lines: {
        include: {
          vendor: { select: { id: true, name: true } },
          quote: { include: { items: { select: { prItemId: true, lineNo: true, unitPrice: true, quantity: true } } } },
        },
      },
    },
  });
  if (!c) throw new NotFoundError("Comparative");

  const preparedBy = await db.user.findUnique({ where: { id: c.preparedById }, select: { name: true } });

  // The point of contact named on the form, falling back to whoever the
  // department has appointed for sourcing when the comparative names nobody.
  let pocName = c.pocUser?.name ?? null;
  let pocTitle = c.pocUser?.title ?? null;
  if (!pocName) {
    const poc = await primaryPoc(c.pr.department.id, "SOURCING", db);
    pocName = poc?.name ?? null;
    pocTitle = poc?.title ?? null;
  }

  const itemIds = c.pr.items.map((i) => i.itemId).filter((x): x is string => !!x);
  const latest = await lastPaid(itemIds, db);

  // The rate each vendor quoted for each requisition line. A vendor that did not
  // quote a line leaves it blank rather than showing zero, because zero reads as
  // "free" and blank reads as "not offered".
  const rateByLineAndItem = new Map<string, Map<string, { rate: number; qty: number }>>();
  for (const line of c.lines) {
    const perItem = new Map<string, { rate: number; qty: number }>();
    for (const qi of line.quote.items) {
      if (qi.prItemId) perItem.set(qi.prItemId, { rate: qi.unitPrice, qty: qi.quantity });
    }
    rateByLineAndItem.set(line.id, perItem);
  }

  const items: CostAnalysisItem[] = c.pr.items.map((pi) => {
    const byVendor: CostAnalysisItem["byVendor"] = {};
    for (const line of c.lines) {
      const hit = rateByLineAndItem.get(line.id)?.get(pi.id);
      byVendor[line.id] = hit
        ? { rate: round2(hit.rate), total: round2(hit.rate * (hit.qty || pi.quantity)) }
        : { rate: null, total: null };
    }
    const prev = pi.itemId ? latest.get(pi.itemId) : undefined;
    return {
      lineNo: pi.lineNo,
      description: pi.description,
      lastPoPrice: prev ? round2(prev.price) : null,
      lastPoDate: prev ? prev.at : null,
      quantity: pi.quantity,
      unit: pi.unit,
      byVendor,
    };
  });

  const vendors: CostAnalysisVendor[] = c.lines
    .map((l) => ({
      lineId: l.id,
      vendorId: l.vendorId,
      vendorName: l.vendor.name,
      subtotal: round2(l.subtotal),
      taxAmount: round2(l.taxAmount),
      netTotal: round2(l.netTotal),
      paymentTerms: l.paymentTerms,
      specifications: l.specifications,
      deliveryCommitment: l.deliveryCommitment ?? (l.deliveryDays != null ? `${l.deliveryDays} days` : null),
      taxInformation: l.taxInformation,
      isSelected: l.isSelected,
      isLowest: l.isLowest,
    }))
    .sort((a, b) => a.netTotal - b.netTotal);

  return {
    comparativeId: c.id,
    number: c.number,
    status: c.status,
    prNumber: c.pr.number,
    prTitle: c.pr.title,
    departmentName: c.pr.department.name,
    entityName: c.pr.entity.name,
    entityLegalName: c.pr.entity.legalName ?? c.pr.entity.name,
    preparedByName: preparedBy?.name ?? "—",
    preparedAt: c.preparedAt,
    verifiedByName: c.verifiedBy?.name ?? null,
    verifiedAt: c.verifiedAt,
    pocName,
    pocTitle,
    taxPercent: c.taxPercent,
    invoiceChargedTo: c.invoiceChargedTo ?? c.pr.entity.legalName ?? c.pr.entity.name,
    awardedToVendorName: c.awardedToVendor?.name ?? vendors.find((v) => v.isSelected)?.vendorName ?? null,
    remarks: c.remarks,
    specialNotes: c.specialNotes,
    singleSourced: c.singleSourced,
    ratesLocked: c.ratesLocked,
    vendorSelectionForm: c.vendorSelectionForm,
    higherRateReason: c.higherRateReason,
    items,
    vendors,
  };
}

/**
 * What is still missing before the form can be signed.
 *
 * Returned rather than thrown so the screen can show the whole list at once
 * instead of revealing one gap per attempt.
 */
export function costAnalysisGaps(form: CostAnalysis): string[] {
  const gaps: string[] = [];
  if (form.singleSourced === null) gaps.push("Whether the vendor is single sourced has not been answered.");
  if (form.ratesLocked === null) gaps.push("Whether rates are already locked with the vendor has not been answered.");
  if (form.vendorSelectionForm === null) {
    gaps.push("Whether the vendor selection form is fulfilled and approved has not been answered.");
  }
  const awarded = form.vendors.find((v) => v.isSelected);
  const lowest = form.vendors.find((v) => v.isLowest);
  if (awarded && lowest && awarded.vendorId !== lowest.vendorId && !form.higherRateReason?.trim()) {
    gaps.push(`${awarded.vendorName} is not the lowest quotation and no reason for the higher rate is stated.`);
  }
  if (!form.pocName) gaps.push("No point of contact is named for this requisition.");
  if (!form.vendors.length) gaps.push("No vendor quotations are on the comparative.");
  return gaps;
}

/* ── Recording the form ──────────────────────────────────── */

export async function saveCostAnalysis(
  user: SessionUser,
  input: {
    comparativeId: string;
    pocUserId?: string | null;
    taxPercent?: number;
    invoiceChargedTo?: string | null;
    remarks?: string | null;
    specialNotes?: string | null;
    singleSourced?: boolean | null;
    ratesLocked?: boolean | null;
    vendorSelectionForm?: boolean | null;
    higherRateReason?: string | null;
    /** Per-vendor terms, keyed by comparative line id. */
    terms?: Record<
      string,
      { paymentTerms?: string | null; specifications?: string | null; deliveryCommitment?: string | null; taxInformation?: string | null }
    >;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.COMPARATIVE_CREATE, P.COMPARATIVE_VERIFY)) {
    throw new ForbiddenError("You do not have permission to maintain the cost analysis form.");
  }
  const c = await db.comparative.findUnique({
    where: { id: input.comparativeId },
    select: { id: true, number: true, status: true },
  });
  if (!c) throw new NotFoundError("Comparative");
  if (["APPROVED", "AWARDED"].includes(c.status)) {
    throw new RuleViolationError(
      `${c.number} has already been ${c.status.toLowerCase()}; the form it was decided on cannot be edited.`,
    );
  }
  if (input.taxPercent != null && (input.taxPercent < 0 || input.taxPercent > 100)) {
    throw new ValidationError("A tax rate must be between 0 and 100 per cent.");
  }

  const updated = await db.comparative.update({
    where: { id: input.comparativeId },
    data: {
      pocUserId: input.pocUserId ?? undefined,
      taxPercent: input.taxPercent ?? undefined,
      invoiceChargedTo: input.invoiceChargedTo ?? undefined,
      remarks: input.remarks ?? undefined,
      specialNotes: input.specialNotes ?? undefined,
      singleSourced: input.singleSourced ?? undefined,
      ratesLocked: input.ratesLocked ?? undefined,
      vendorSelectionForm: input.vendorSelectionForm ?? undefined,
      higherRateReason: input.higherRateReason ?? undefined,
    },
  });

  for (const [lineId, terms] of Object.entries(input.terms ?? {})) {
    await db.comparativeLine.update({
      where: { id: lineId },
      data: {
        paymentTerms: terms.paymentTerms ?? undefined,
        specifications: terms.specifications ?? undefined,
        deliveryCommitment: terms.deliveryCommitment ?? undefined,
        taxInformation: terms.taxInformation ?? undefined,
      },
    });
  }

  await writeAudit(
    {
      entityType: "Comparative",
      entityId: updated.id,
      entityRef: updated.number,
      action: "COST_ANALYSIS_UPDATED",
      newValue: {
        singleSourced: updated.singleSourced,
        ratesLocked: updated.ratesLocked,
        vendorSelectionForm: updated.vendorSelectionForm,
      },
      actor: user,
    },
    db,
  );
  return updated;
}

/**
 * The second signature on the form.
 *
 * Refused when the person verifying is the one who prepared it: a form checked
 * only by its author is not checked, and the paper version has two signature
 * lines for that reason.
 */
export async function verifyCostAnalysis(
  user: SessionUser,
  comparativeId: string,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.COMPARATIVE_VERIFY)) {
    throw new ForbiddenError("You do not have permission to verify a cost analysis form.");
  }
  const c = await db.comparative.findUnique({
    where: { id: comparativeId },
    select: { id: true, number: true, preparedById: true, verifiedById: true },
  });
  if (!c) throw new NotFoundError("Comparative");
  if (c.preparedById === user.id) {
    throw new RuleViolationError("A form cannot be verified by the person who prepared it.");
  }
  if (c.verifiedById) throw new RuleViolationError(`${c.number} has already been verified.`);

  const form = await costAnalysis(comparativeId, db);
  const gaps = costAnalysisGaps(form);
  if (gaps.length) {
    throw new RuleViolationError(`The form is not complete: ${gaps[0]}`);
  }

  const updated = await db.comparative.update({
    where: { id: comparativeId },
    data: { verifiedById: user.id, verifiedAt: new Date() },
  });
  await writeAudit(
    {
      entityType: "Comparative",
      entityId: updated.id,
      entityRef: updated.number,
      action: "COST_ANALYSIS_VERIFIED",
      actor: user,
    },
    db,
  );
  return updated;
}
