import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { assertEntityAccess, userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { round2 } from "@/lib/format";
import { effectiveTaxRate } from "@/lib/policy";
import { lineTax, taxSnapshot } from "./tax";

/**
 * Manual cost-comparison entries.
 *
 * Not every comparison source is a formal quotation. A published price list, a
 * rate from a framework contract, what the same item cost last month, a price
 * quoted over the phone — all are legitimate evidence, and until now each had to
 * exist as a `VendorQuote` before it could appear in a comparison. That left two
 * bad options: fabricate a quotation, or leave the comparison thinner than the
 * buyer's actual knowledge.
 *
 * A manual entry is therefore first-class but never disguised. It lives in its
 * own table, carries its own source type and evidence reference, requires a
 * reason for having been entered by hand, and is labelled MANUAL everywhere it
 * appears. The formal quotation workflow is untouched — this sits beside it.
 *
 * What a manual entry deliberately cannot do is win. Selecting a vendor and
 * awarding an order still runs off `ComparativeLine`, which means off a real
 * quotation, because an award needs something the vendor actually offered.
 */

// The source-type list lives in `lib/domain` so the entry form can import it
// without pulling this module — and Prisma — into the client bundle.
import { type ManualSourceType } from "@/lib/domain";
export { MANUAL_SOURCE_TYPES, type ManualSourceType } from "@/lib/domain";

export type ManualEntryInput = {
  comparativeId: string;
  vendorId?: string | null;
  sourceName: string;
  sourceType: ManualSourceType;
  description: string;
  unit: string;
  quantity: number;
  rate: number;
  taxRuleId?: string | null;
  taxNote?: string | null;
  deliveryTerms?: string | null;
  paymentTerms?: string | null;
  validUntil?: Date | null;
  evidenceRef?: string | null;
  reason: string;
};

export async function addManualComparison(
  user: SessionUser,
  input: ManualEntryInput,
  db: DbClient = prisma,
) {
  // Entering a comparison option is the same act as entering a quotation, so it
  // takes the same authority.
  if (!userHasPermission(user, P.QUOTE_ENTER, P.COMPARATIVE_CREATE)) {
    throw new RuleViolationError(
      "You do not have permission to enter cost-comparison options.",
    );
  }
  if (!input.sourceName?.trim()) throw new ValidationError("Name the source of this price.");
  if (!input.description?.trim()) throw new ValidationError("Describe what is being priced.");
  if (!input.reason?.trim()) {
    throw new ValidationError(
      "State why this was entered by hand rather than obtained as a quotation. Without it, a reader cannot judge how much weight the comparison carries.",
    );
  }
  if (input.quantity <= 0) throw new ValidationError("Quantity must be greater than zero.");
  if (input.rate < 0) throw new ValidationError("A rate cannot be negative.");

  return withTransaction(db, async (tx) => {
    const comparative = await tx.comparative.findUnique({
      where: { id: input.comparativeId },
      include: { pr: { select: { number: true, entityId: true } } },
    });
    if (!comparative) throw new NotFoundError("Comparative");
    assertEntityAccess(user, comparative.pr.entityId);

    if (["APPROVED", "CANCELLED"].includes(comparative.status)) {
      throw new RuleViolationError(
        `${comparative.number} is ${comparative.status.toLowerCase()} — its comparison cannot be added to. ` +
          "A comparison that changes after approval is not the comparison that was approved.",
      );
    }

    const grossValue = round2(input.quantity * input.rate);

    // Tax comes from the master, or from nothing. There is no default rate to
    // fall back on, and inventing one on a comparison sheet is how 16% and 18%
    // ended up in this system.
    let taxRate: number | null = null;
    let taxAmount = 0;
    let snapshotRate: number | null = null;
    if (input.taxRuleId) {
      const rule = await tx.taxRule.findUnique({ where: { id: input.taxRuleId } });
      if (!rule) throw new NotFoundError("Tax rule");
      const snap = taxSnapshot(rule);
      const t = lineTax({
        quantity: input.quantity,
        unitPrice: input.rate,
        taxRuleSnapshot: snap.taxRuleSnapshot,
      });
      taxRate = rule.percent;
      taxAmount = t.amount;
      snapshotRate = rule.percent;
    } else {
      // Nothing configured and nothing chosen: the sheet shows tax as unset.
      const inForce = await effectiveTaxRate(comparative.pr.entityId, "GST", tx);
      if (inForce) {
        taxRate = inForce.percent;
        taxAmount = round2((grossValue * inForce.percent) / 100);
      }
    }

    const entry = await tx.comparativeManualEntry.create({
      data: {
        comparativeId: input.comparativeId,
        vendorId: input.vendorId ?? null,
        sourceName: input.sourceName.trim(),
        sourceType: input.sourceType,
        description: input.description.trim(),
        unit: input.unit,
        quantity: input.quantity,
        rate: input.rate,
        grossValue,
        taxRuleId: input.taxRuleId ?? null,
        taxRate,
        taxAmount,
        taxNote: input.taxNote ?? (taxRate === null ? "No tax rate configured" : null),
        netValue: round2(grossValue + taxAmount),
        deliveryTerms: input.deliveryTerms ?? null,
        paymentTerms: input.paymentTerms ?? null,
        validUntil: input.validUntil ?? null,
        evidenceRef: input.evidenceRef ?? null,
        reason: input.reason.trim(),
        enteredById: user.id,
      },
    });

    await writeAudit(
      {
        entityType: "Comparative",
        entityId: comparative.id,
        entityRef: comparative.number,
        action: "MANUAL_COMPARISON_ADDED",
        newValue: {
          source: entry.sourceName,
          sourceType: entry.sourceType,
          description: entry.description,
          rate: entry.rate,
          quantity: entry.quantity,
          grossValue,
          netValue: entry.netValue,
          taxRate: snapshotRate,
          evidence: entry.evidenceRef,
        },
        reason: entry.reason,
        caseKey: comparative.pr.number,
        actor: user,
      },
      tx,
    );
    return entry;
  });
}

/** Removes a manual entry. The audit keeps what it said. */
export async function removeManualComparison(
  user: SessionUser,
  id: string,
  reason: string,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.QUOTE_ENTER, P.COMPARATIVE_CREATE)) {
    throw new RuleViolationError("You do not have permission to change cost-comparison options.");
  }
  if (!reason?.trim()) throw new ValidationError("State why this entry is being removed.");

  return withTransaction(db, async (tx) => {
    const entry = await tx.comparativeManualEntry.findUnique({
      where: { id },
      include: { comparative: { include: { pr: { select: { number: true, entityId: true } } } } },
    });
    if (!entry) throw new NotFoundError("Manual comparison entry");
    assertEntityAccess(user, entry.comparative.pr.entityId);
    if (["APPROVED", "CANCELLED"].includes(entry.comparative.status)) {
      throw new RuleViolationError(
        `${entry.comparative.number} is ${entry.comparative.status.toLowerCase()} — its comparison can no longer be changed.`,
      );
    }

    await writeAudit(
      {
        entityType: "Comparative",
        entityId: entry.comparativeId,
        entityRef: entry.comparative.number,
        action: "MANUAL_COMPARISON_REMOVED",
        oldValue: {
          source: entry.sourceName,
          description: entry.description,
          rate: entry.rate,
          netValue: entry.netValue,
        },
        reason: reason.trim(),
        caseKey: entry.comparative.pr.number,
        actor: user,
      },
      tx,
    );
    await tx.comparativeManualEntry.delete({ where: { id } });
    return entry;
  });
}

/** Manual entries on a comparative, cheapest first. */
export async function manualComparisons(comparativeId: string, db: DbClient = prisma) {
  return db.comparativeManualEntry.findMany({
    where: { comparativeId },
    orderBy: { netValue: "asc" },
    include: {
      vendor: { select: { id: true, name: true } },
      enteredBy: { select: { name: true } },
      taxRule: { select: { code: true, percent: true } },
    },
  });
}
