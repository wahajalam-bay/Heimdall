import { prisma, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { round2 } from "@/lib/format";
import { CONFIG_KEYS, getConfigBool, getConfigNumber } from "@/lib/config";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { createTask, completeTasks } from "@/lib/notify";

/**
 * Payment vouchers and the signatures on them.
 *
 * A voucher is the document finance signs before money moves, and it is only
 * generated when the papers behind it already stand up: an approved order, a
 * posted receipt, a passing match, verified tax. The signatories are asked to
 * approve a payment that has been proven — not to do the proving. Anything that
 * would make them the last line of defence is refused here instead.
 *
 * Signatures are rows, in sequence. Who signed, in what order, and when is the
 * entire content of a signatory hierarchy; a status field cannot hold it.
 */

export type VoucherReadiness = { ready: boolean; blockers: string[]; warnings: string[] };

/**
 * Everything that must be true before a voucher may exist.
 *
 * Deliberately returns every blocker rather than the first: somebody chasing a
 * payment wants the whole list, not one item at a time.
 */
export async function voucherReadiness(invoiceId: string, db: DbClient = prisma): Promise<VoucherReadiness> {
  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      po: { select: { id: true, number: true, status: true, entityId: true, total: true } },
      grnLinks: { select: { grnId: true } },
      taxLines: { select: { status: true, label: true } },
      vouchers: { select: { id: true, number: true, status: true } },
      exceptions: { where: { status: { in: ["OPEN", "IN_PROGRESS"] }, blocking: true }, select: { number: true } },
    },
  });
  if (!invoice) throw new NotFoundError("Invoice");

  const blockers: string[] = [];
  const warnings: string[] = [];

  const live = invoice.vouchers.find((v) => !["CANCELLED", "REJECTED"].includes(v.status));
  if (live) blockers.push(`Voucher ${live.number} already exists for this invoice and is ${live.status}.`);

  if (!["APPROVED", "EXCEPTION_APPROVED", "MATCHED", "SENT_TO_FINANCE"].includes(invoice.status)) {
    blockers.push(`The invoice is ${invoice.status}; it must be approved before a voucher is raised.`);
  }
  if (invoice.matchStatus === "FAILED") {
    blockers.push("The three-way match has failed. Resolve it or record an authorised exception first.");
  }
  if (invoice.matchStatus === "PENDING") {
    blockers.push("The three-way match has not been run.");
  }
  if (!invoice.po) blockers.push("The invoice is not linked to a purchase order.");

  const requireGrn = await getConfigBool(CONFIG_KEYS.REQUIRE_GRN_FOR_PAYMENT, invoice.po?.entityId ?? null, db);
  if (requireGrn && invoice.grnLinks.length === 0) {
    blockers.push("No posted receipt is linked. Payment cannot be raised for goods not recorded as received.");
  }

  for (const e of invoice.exceptions) blockers.push(`Blocking exception ${e.number} is open against this invoice.`);

  const unverifiedTax = invoice.taxLines.filter((t) => t.status !== "VERIFIED");
  if (invoice.taxLines.length === 0) {
    warnings.push("No tax lines are recorded against this invoice.");
  } else if (unverifiedTax.length) {
    blockers.push(
      `Tax not verified: ${unverifiedTax.map((t) => t.label).join(", ")}. Finance must verify tax before a voucher.`,
    );
  }

  if (round2(invoice.netPayable) <= 0) blockers.push("The net payable is zero or negative.");

  return { ready: blockers.length === 0, blockers, warnings };
}

/**
 * The signatures a voucher of this size needs.
 *
 * Read from configuration rather than hard-coded, because a signatory ladder is
 * the first thing an organisation changes and the last thing it wants to redeploy
 * for. Each rung names a role and the amount above which it applies.
 */
export async function signatoryLadder(
  entityId: string,
  amount: number,
  db: DbClient = prisma,
): Promise<Array<{ sequence: number; roleCode: string; thresholdAmount: number }>> {
  const raw = await db.configSetting.findFirst({
    where: { key: CONFIG_KEYS.SIGNATORY_LADDER, OR: [{ entityId }, { entityId: null }] },
    orderBy: { entityId: "desc" },
  });

  let ladder: Array<{ roleCode: string; above?: number }> = [];
  if (raw?.value) {
    try {
      const parsed = JSON.parse(raw.value);
      if (Array.isArray(parsed)) ladder = parsed;
    } catch {
      // A malformed ladder must not silently mean "nobody needs to sign".
      throw new RuleViolationError(
        "The signatory ladder configuration could not be read. Fix it in administration before raising vouchers.",
      );
    }
  }
  if (!ladder.length) {
    // Falls back to the two finance roles that exist, so an unconfigured system
    // still routes a voucher to somebody rather than to a role nobody holds.
    ladder = [
      { roleCode: "FINANCE_USER", above: 0 },
      { roleCode: "FINANCE_APPROVER", above: 500000 },
    ];
  }

  return ladder
    .filter((rung) => amount >= (rung.above ?? 0))
    .map((rung, i) => ({ sequence: i + 1, roleCode: rung.roleCode, thresholdAmount: rung.above ?? 0 }));
}

/** Raises the voucher and opens the first signature. */
export async function generateVoucher(
  user: SessionUser,
  input: { invoiceId: string; narration?: string | null; glAccount?: string | null; deductions?: number | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.VOUCHER_GENERATE)) {
    throw new ForbiddenError("You do not have permission to generate payment vouchers.");
  }

  const readiness = await voucherReadiness(input.invoiceId, db);
  if (!readiness.ready) {
    throw new RuleViolationError("A voucher cannot be raised for this invoice.", readiness.blockers);
  }

  const invoice = await db.invoice.findUniqueOrThrow({
    where: { id: input.invoiceId },
    include: {
      po: { select: { entityId: true, number: true, costCenterId: true } },
      vendor: { select: { name: true } },
      taxLines: true,
    },
  });
  const entityId = invoice.po!.entityId;

  const deductions = round2(Math.max(0, input.deductions ?? 0));
  const withholding = round2(invoice.withholdingTax);
  const net = round2(invoice.total - withholding - deductions);
  if (net <= 0) throw new ValidationError("Deductions cannot reduce the payable to zero or below.");

  const number = await nextNumber(SEQ.PAYMENT_VOUCHER, db);
  const ladder = await signatoryLadder(entityId, net, db);
  if (!ladder.length) {
    throw new RuleViolationError("No signatory is configured for an amount of this size.");
  }

  const voucher = await db.voucher.create({
    data: {
      number,
      entityId,
      invoiceId: invoice.id,
      type: "PAYMENT",
      currency: invoice.currency,
      grossAmount: round2(invoice.total),
      taxAmount: round2(invoice.taxAmount),
      withholdingTax: withholding,
      deductions,
      netAmount: net,
      status: "PENDING_SIGNATORIES",
      narration:
        input.narration?.trim() ||
        `Payment to ${invoice.vendor.name} against invoice ${invoice.vendorInvoiceNumber} on order ${invoice.po!.number}.`,
      glAccount: input.glAccount ?? null,
      costCenterId: invoice.po!.costCenterId ?? null,
      preparedById: user.id,
      items: {
        create: [
          {
            lineNo: 1,
            description: `Invoice ${invoice.vendorInvoiceNumber} — goods and services`,
            amount: round2(invoice.subtotal),
            side: "DEBIT",
          },
          ...(round2(invoice.taxAmount) > 0
            ? [{ lineNo: 2, description: "Input tax", amount: round2(invoice.taxAmount), side: "DEBIT" }]
            : []),
          ...(withholding > 0
            ? [
                {
                  lineNo: round2(invoice.taxAmount) > 0 ? 3 : 2,
                  description: "Withholding tax deducted at source",
                  amount: withholding,
                  side: "CREDIT",
                },
              ]
            : []),
          ...(deductions > 0
            ? [
                {
                  lineNo: 9,
                  description: "Other deductions",
                  amount: deductions,
                  side: "CREDIT",
                },
              ]
            : []),
        ],
      },
      signatures: { create: ladder.map((r) => ({ ...r, status: "PENDING" })) },
    },
    include: { signatures: { orderBy: { sequence: "asc" } } },
  });

  await db.invoice.update({ where: { id: invoice.id }, data: { status: "SENT_TO_FINANCE" } });

  const first = voucher.signatures[0];
  await createTask(
    {
      title: `Sign voucher ${voucher.number}`,
      taskType: "APPROVAL",
      assignedRoleCode: first.roleCode,
      entityId,
      documentType: "VOUCHER",
      documentId: voucher.id,
      documentRef: voucher.number,
      slaHours: await getConfigNumber(CONFIG_KEYS.SLA_SIGNATORY_HOURS, entityId, db),
      linkUrl: `/finance/vouchers/${voucher.id}`,
    },
    db,
  );

  await writeAudit(
    {
      entityType: "Voucher",
      entityId: voucher.id,
      entityRef: voucher.number,
      action: "VOUCHER_GENERATED",
      newValue: { net, signatures: ladder.length, invoice: invoice.vendorInvoiceNumber },
      actor: user,
    },
    db,
  );

  return voucher;
}

/**
 * Signs, or refuses, the step that is currently open.
 *
 * Out-of-order signing is refused rather than reordered: a ladder that can be
 * climbed from the top is not a ladder. One person holding two rungs still signs
 * twice, deliberately.
 */
export async function signVoucher(
  user: SessionUser,
  input: { voucherId: string; approve: boolean; comment?: string | null },
  db: DbClient = prisma,
) {
  const voucher = await db.voucher.findUnique({
    where: { id: input.voucherId },
    include: { signatures: { orderBy: { sequence: "asc" } }, invoice: { select: { id: true, number: true } } },
  });
  if (!voucher) throw new NotFoundError("Voucher");
  if (voucher.status !== "PENDING_SIGNATORIES") {
    throw new RuleViolationError(`Voucher ${voucher.number} is ${voucher.status} — it is not awaiting signature.`);
  }

  const step = voucher.signatures.find((s) => s.status === "PENDING");
  if (!step) throw new RuleViolationError("Every signature on this voucher is already recorded.");

  const holdsRung = user.roleCodes.includes(step.roleCode);
  const canOverride = userHasPermission(user, P.VOUCHER_SIGN_ANY);
  if (!holdsRung && !canOverride) {
    throw new ForbiddenError(
      `Signature ${step.sequence} of ${voucher.signatures.length} is for ${step.roleCode}. You do not hold that role.`,
    );
  }
  if (!userHasPermission(user, P.VOUCHER_SIGN, P.VOUCHER_SIGN_ANY)) {
    throw new ForbiddenError("You do not have permission to sign vouchers.");
  }

  if (!input.approve) {
    if (!input.comment?.trim()) throw new ValidationError("Record why the voucher is being refused.");
    await db.signatoryApproval.update({
      where: { id: step.id },
      data: { status: "REJECTED", signedById: user.id, signedAt: new Date(), comment: input.comment.trim() },
    });
    const rejected = await db.voucher.update({
      where: { id: voucher.id },
      data: { status: "REJECTED", rejectedAt: new Date(), rejectReason: input.comment.trim() },
    });
    await completeTasks("VOUCHER", voucher.id, user.id, db);
    // The invoice goes back to approved: the payment was refused, not the invoice.
    await db.invoice.update({ where: { id: voucher.invoiceId }, data: { status: "APPROVED" } });
    await writeAudit(
      {
        entityType: "Voucher",
        entityId: voucher.id,
        entityRef: voucher.number,
        action: "VOUCHER_REJECTED",
        reason: input.comment.trim(),
        actor: user,
      },
      db,
    );
    return rejected;
  }

  await db.signatoryApproval.update({
    where: { id: step.id },
    data: {
      status: "APPROVED",
      signedById: user.id,
      signedAt: new Date(),
      comment: input.comment?.trim() || null,
    },
  });
  await completeTasks("VOUCHER", voucher.id, user.id, db);

  const remaining = voucher.signatures.filter((s) => s.id !== step.id && s.status === "PENDING");
  if (remaining.length) {
    const next = remaining[0];
    await createTask(
      {
        title: `Sign voucher ${voucher.number}`,
        taskType: "APPROVAL",
        assignedRoleCode: next.roleCode,
        entityId: voucher.entityId,
        documentType: "VOUCHER",
        documentId: voucher.id,
        documentRef: voucher.number,
        slaHours: await getConfigNumber(CONFIG_KEYS.SLA_SIGNATORY_HOURS, voucher.entityId, db),
        linkUrl: `/finance/vouchers/${voucher.id}`,
      },
      db,
    );
    await writeAudit(
      {
        entityType: "Voucher",
        entityId: voucher.id,
        entityRef: voucher.number,
        action: "VOUCHER_SIGNED",
        newValue: { sequence: step.sequence, of: voucher.signatures.length, next: next.roleCode },
        actor: user,
      },
      db,
    );
    return db.voucher.findUniqueOrThrow({ where: { id: voucher.id } });
  }

  const approved = await db.voucher.update({
    where: { id: voucher.id },
    data: { status: "APPROVED", approvedAt: new Date() },
  });
  await createTask(
    {
      title: `Release payment — ${voucher.number}`,
      taskType: "ACTION",
      assignedRoleCode: "FINANCE_USER",
      entityId: voucher.entityId,
      documentType: "VOUCHER",
      documentId: voucher.id,
      documentRef: voucher.number,
      slaHours: await getConfigNumber(CONFIG_KEYS.SLA_PAYMENT_HOURS, voucher.entityId, db),
      linkUrl: `/finance/vouchers/${voucher.id}`,
    },
    db,
  );
  await writeAudit(
    {
      entityType: "Voucher",
      entityId: voucher.id,
      entityRef: voucher.number,
      action: "VOUCHER_APPROVED",
      newValue: { signatures: voucher.signatures.length },
      actor: user,
    },
    db,
  );
  return approved;
}

export async function cancelVoucher(
  user: SessionUser,
  voucherId: string,
  reason: string,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.VOUCHER_GENERATE)) {
    throw new ForbiddenError("You do not have permission to cancel vouchers.");
  }
  if (!reason?.trim()) throw new ValidationError("A cancellation reason is required.");
  const voucher = await db.voucher.findUnique({ where: { id: voucherId } });
  if (!voucher) throw new NotFoundError("Voucher");
  if (voucher.status === "PAID") {
    throw new RuleViolationError("A paid voucher cannot be cancelled. Raise an adjustment instead.");
  }

  const cancelled = await db.voucher.update({
    where: { id: voucherId },
    data: { status: "CANCELLED", cancelledAt: new Date(), rejectReason: reason.trim() },
  });
  await completeTasks("VOUCHER", voucherId, user.id, db);
  await db.invoice.update({ where: { id: voucher.invoiceId }, data: { status: "APPROVED" } });
  await writeAudit(
    {
      entityType: "Voucher",
      entityId: voucherId,
      entityRef: voucher.number,
      action: "VOUCHER_CANCELLED",
      reason: reason.trim(),
      actor: user,
    },
    db,
  );
  return cancelled;
}

/** Marks a match record as deliberately overridden, with the reason on the record. */
export async function overrideMatch(
  user: SessionUser,
  input: { matchId: string; reason: string },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.INVOICE_EXCEPTION_APPROVE)) {
    throw new ForbiddenError("You do not have permission to override a three-way match.");
  }
  if (!input.reason?.trim()) throw new ValidationError("An override reason is required.");
  const match = await db.threeWayMatch.findUnique({ where: { id: input.matchId } });
  if (!match) throw new NotFoundError("Match record");
  if (match.result === "PASSED") throw new RuleViolationError("This match passed; there is nothing to override.");

  const updated = await db.threeWayMatch.update({
    where: { id: input.matchId },
    data: { result: "OVERRIDDEN", overriddenById: user.id, overrideReason: input.reason.trim() },
  });
  await writeAudit(
    {
      entityType: "ThreeWayMatch",
      entityId: input.matchId,
      action: "MATCH_OVERRIDDEN",
      reason: input.reason.trim(),
      newValue: { variance: match.variance },
      actor: user,
    },
    db,
  );
  return updated;
}

/* ── Reading ──────────────────────────────────────────────── */

export const VOUCHER_OPEN_STATUSES = ["DRAFT", "PENDING_SIGNATORIES", "APPROVED"];

export async function voucherStats(where: Record<string, unknown>, db: DbClient = prisma) {
  const [total, awaitingSignature, approved, paid, valueAwaiting] = await Promise.all([
    db.voucher.count({ where }),
    db.voucher.count({ where: { ...where, status: "PENDING_SIGNATORIES" } }),
    db.voucher.count({ where: { ...where, status: "APPROVED" } }),
    db.voucher.count({ where: { ...where, status: "PAID" } }),
    db.voucher.aggregate({
      where: { ...where, status: { in: ["PENDING_SIGNATORIES", "APPROVED"] } },
      _sum: { netAmount: true },
    }),
  ]);
  return {
    total,
    awaitingSignature,
    approved,
    paid,
    valueAwaiting: round2(valueAwaiting._sum.netAmount ?? 0),
  };
}
