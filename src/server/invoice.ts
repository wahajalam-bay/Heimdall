import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { CONFIG_KEYS, getConfigBool, getConfigNumber } from "@/lib/config";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify, createTask, completeTasks } from "@/lib/notify";
import { raiseException, autoResolveExceptions } from "@/lib/exceptions-service";
import { startApproval, actOnApproval, getPendingApproval, type ApprovalDecision } from "@/lib/approvals";
import { PERMISSIONS as P } from "@/lib/permissions";
import { SOD_RULES, assertSeparation } from "@/lib/sod";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { round2 } from "@/lib/format";
import { transitionPr } from "./pr";

/**
 * Invoice verification and finance handoff.
 *
 * Three-way match: PO + GRN + Invoice. An invoice is never payable merely
 * because it exists — the match must pass, or an authorised exception must be
 * recorded.
 */

export type MatchLineResult = {
  lineNo: number;
  description: string;
  invoiceQty: number;
  invoiceUnitPrice: number;
  poQty: number | null;
  poUnitPrice: number | null;
  grnAcceptedQty: number | null;
  alreadyInvoicedQty: number;
  flag: "OK" | "QTY_MISMATCH" | "PRICE_MISMATCH" | "NOT_ON_PO" | "NOT_RECEIVED" | "TAX_MISMATCH";
  notes: string | null;
};

export type MatchResult = {
  passed: boolean;
  vendorMatches: boolean;
  poFound: boolean;
  grnPresent: boolean;
  totalsMatch: boolean;
  invoiceTotal: number;
  computedTotal: number;
  totalVariance: number;
  lines: MatchLineResult[];
  failures: string[];
  warnings: string[];
  tolerances: { qtyPercent: number; pricePercent: number; valueAbsolute: number };
};

/**
 * Runs the three-way match. Pure computation — callers persist the outcome.
 */
export async function runThreeWayMatch(invoiceId: string, db: DbClient = prisma): Promise<MatchResult> {
  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      items: { orderBy: { lineNo: "asc" } },
      po: {
        include: {
          items: true,
          vendor: true,
          grns: { where: { status: "POSTED" }, include: { items: true } },
        },
      },
      vendor: true,
    },
  });
  if (!invoice) throw new NotFoundError("Invoice");

  const entityId = invoice.po?.entityId ?? null;
  const [qtyTol, priceTol, valueTol, requireGrn] = await Promise.all([
    getConfigNumber(CONFIG_KEYS.INVOICE_QTY_TOLERANCE, entityId, db),
    getConfigNumber(CONFIG_KEYS.INVOICE_PRICE_TOLERANCE, entityId, db),
    getConfigNumber(CONFIG_KEYS.INVOICE_VALUE_TOLERANCE_ABS, entityId, db),
    getConfigBool(CONFIG_KEYS.REQUIRE_GRN_FOR_PAYMENT, entityId, db),
  ]);

  const failures: string[] = [];
  const warnings: string[] = [];

  const poFound = Boolean(invoice.po);
  if (!poFound) failures.push("No purchase order is linked to this invoice.");

  const vendorMatches = invoice.po ? invoice.po.vendorId === invoice.vendorId : false;
  if (poFound && !vendorMatches) {
    failures.push(
      `Invoice vendor (${invoice.vendor.name}) does not match the purchase order vendor (${invoice.po!.vendor.name}).`,
    );
  }

  const postedGrns = invoice.po?.grns ?? [];
  const grnPresent = postedGrns.length > 0;
  if (requireGrn && !grnPresent) {
    failures.push(
      "No posted GRN exists for this purchase order — goods are not recorded as received into inventory, so the invoice is not payable.",
    );
  }

  // Accepted quantity per PO line across all posted GRNs.
  const acceptedByPoItem = new Map<string, number>();
  for (const g of postedGrns) {
    for (const gi of g.items) {
      acceptedByPoItem.set(gi.poItemId, round2((acceptedByPoItem.get(gi.poItemId) ?? 0) + gi.acceptedQty));
    }
  }

  // Quantity already invoiced on other invoices, so duplicates are caught.
  const otherInvoiceLines = await db.invoiceItem.findMany({
    where: {
      invoiceId: { not: invoiceId },
      poItemId: { not: null },
      invoice: { poId: invoice.poId, status: { notIn: ["REJECTED"] } },
    },
    select: { poItemId: true, quantity: true },
  });
  const alreadyInvoiced = new Map<string, number>();
  for (const l of otherInvoiceLines) {
    if (!l.poItemId) continue;
    alreadyInvoiced.set(l.poItemId, round2((alreadyInvoiced.get(l.poItemId) ?? 0) + l.quantity));
  }

  const lines: MatchLineResult[] = [];
  let computedTotal = 0;

  for (const il of invoice.items) {
    const poItem = il.poItemId ? invoice.po?.items.find((p) => p.id === il.poItemId) : undefined;
    let flag: MatchLineResult["flag"] = "OK";
    let notes: string | null = null;

    const accepted = poItem ? (acceptedByPoItem.get(poItem.id) ?? 0) : null;
    const prior = poItem ? (alreadyInvoiced.get(poItem.id) ?? 0) : 0;

    if (!poItem) {
      flag = "NOT_ON_PO";
      notes = "This line does not correspond to any purchase order line.";
      failures.push(`Line ${il.lineNo} (${il.description}) is not on the purchase order.`);
    } else {
      const priceVar = poItem.unitPrice > 0 ? ((il.unitPrice - poItem.unitPrice) / poItem.unitPrice) * 100 : 0;
      const billable = round2(Math.max(0, (accepted ?? 0) - prior));

      if (accepted !== null && accepted <= 0) {
        flag = "NOT_RECEIVED";
        notes = "No accepted quantity has been recorded against this line.";
        failures.push(
          `Line ${il.lineNo} (${il.description}): invoiced ${il.quantity} ${il.unit} but nothing has been accepted into inventory.`,
        );
      } else if (il.quantity > billable * (1 + qtyTol / 100) + 1e-9) {
        flag = "QTY_MISMATCH";
        notes = `Invoiced ${il.quantity} ${il.unit} against ${billable} ${il.unit} available to invoice (accepted ${accepted}, previously invoiced ${prior}).`;
        failures.push(`Line ${il.lineNo} (${il.description}): ${notes}`);
      } else if (Math.abs(priceVar) > priceTol) {
        flag = "PRICE_MISMATCH";
        notes = `Unit price ${il.unitPrice} vs purchase order ${poItem.unitPrice} (${priceVar > 0 ? "+" : ""}${round2(priceVar)}%).`;
        failures.push(`Line ${il.lineNo} (${il.description}): ${notes}`);
      } else if (Math.abs(il.taxRate - poItem.taxRate) > 0.01) {
        flag = "TAX_MISMATCH";
        notes = `Tax rate ${il.taxRate}% vs purchase order ${poItem.taxRate}%.`;
        warnings.push(`Line ${il.lineNo} (${il.description}): ${notes}`);
      }
      if (il.quantity < billable - 1e-9 && flag === "OK") {
        warnings.push(
          `Line ${il.lineNo} (${il.description}): invoiced ${il.quantity} of ${billable} ${il.unit} available — partial billing.`,
        );
      }
    }

    computedTotal += il.lineTotal;
    lines.push({
      lineNo: il.lineNo,
      description: il.description,
      invoiceQty: il.quantity,
      invoiceUnitPrice: il.unitPrice,
      poQty: poItem?.quantity ?? null,
      poUnitPrice: poItem?.unitPrice ?? null,
      grnAcceptedQty: accepted,
      alreadyInvoicedQty: prior,
      flag,
      notes,
    });
  }

  computedTotal = round2(
    computedTotal + invoice.deliveryCharges + invoice.otherCharges - invoice.discount,
  );
  const totalVariance = round2(invoice.total - computedTotal);
  const totalsMatch = Math.abs(totalVariance) <= valueTol;
  if (!totalsMatch) {
    failures.push(
      `Invoice total PKR ${invoice.total.toLocaleString("en-PK")} does not reconcile with the sum of its lines and charges (PKR ${computedTotal.toLocaleString("en-PK")}, variance PKR ${totalVariance.toLocaleString("en-PK")}).`,
    );
  }

  // Duplicate vendor invoice number for the same vendor.
  const dupe = await db.invoice.findFirst({
    where: {
      id: { not: invoiceId },
      vendorId: invoice.vendorId,
      vendorInvoiceNumber: invoice.vendorInvoiceNumber,
      status: { notIn: ["REJECTED"] },
    },
    select: { number: true },
  });
  if (dupe) {
    failures.push(
      `Vendor invoice number ${invoice.vendorInvoiceNumber} has already been registered as ${dupe.number}.`,
    );
  }

  return {
    passed: failures.length === 0,
    vendorMatches,
    poFound,
    grnPresent,
    totalsMatch,
    invoiceTotal: invoice.total,
    computedTotal,
    totalVariance,
    lines,
    failures,
    warnings,
    tolerances: { qtyPercent: qtyTol, pricePercent: priceTol, valueAbsolute: valueTol },
  };
}

export type InvoiceItemInput = {
  poItemId?: string | null;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  taxRate?: number;
};

export type InvoiceInput = {
  poId: string;
  vendorInvoiceNumber: string;
  invoiceDate: Date;
  dueDate?: Date | null;
  deliveryCharges?: number;
  otherCharges?: number;
  discount?: number;
  withholdingTax?: number;
  items: InvoiceItemInput[];
  grnIds?: string[];
};

export async function registerInvoice(user: SessionUser, input: InvoiceInput, db: DbClient = prisma) {
  const registered = await withTransaction(db, async (tx, defer) => {
    if (!userHasPermission(user, P.INVOICE_CREATE)) {
      throw new ForbiddenError("You do not have permission to register vendor invoices.");
    }
    const po = await tx.purchaseOrder.findUnique({
      where: { id: input.poId },
      include: { vendor: true, pr: true, grns: { where: { status: "POSTED" }, select: { id: true } } },
    });
    if (!po) throw new NotFoundError("Purchase order");
    if (!input.vendorInvoiceNumber.trim()) throw new ValidationError("The vendor invoice number is required.");
    if (!input.items.length) throw new ValidationError("An invoice needs at least one line.");
    if (["DRAFT", "PENDING_APPROVAL"].includes(po.status)) {
      throw new RuleViolationError(
        `Purchase order ${po.number} is ${po.status} — an invoice cannot be registered against an unissued order.`,
      );
    }

    const lines = input.items.map((it, i) => {
      const net = round2(it.unitPrice * it.quantity);
      const taxAmount = round2(net * ((it.taxRate ?? 0) / 100));
      return { ...it, lineNo: i + 1, net, taxRate: it.taxRate ?? 0, taxAmount, lineTotal: round2(net + taxAmount) };
    });
    const subtotal = round2(lines.reduce((a, l) => a + l.net, 0));
    const taxAmount = round2(lines.reduce((a, l) => a + l.taxAmount, 0));
    const total = round2(
      subtotal + taxAmount + (input.deliveryCharges ?? 0) + (input.otherCharges ?? 0) - (input.discount ?? 0),
    );
    const withholding =
      input.withholdingTax ??
      round2((subtotal * (await getConfigNumber(CONFIG_KEYS.WITHHOLDING_TAX_RATE, po.entityId, tx))) / 100);
    const netPayable = round2(total - withholding);

    const number = await nextNumber(SEQ.INVOICE, tx);
    const invoice = await tx.invoice.create({
      data: {
        number,
        vendorInvoiceNumber: input.vendorInvoiceNumber.trim(),
        poId: po.id,
        vendorId: po.vendorId,
        invoiceDate: input.invoiceDate,
        dueDate:
          input.dueDate ??
          (po.creditDays ? new Date(input.invoiceDate.getTime() + po.creditDays * 86400000) : null),
        subtotal,
        taxAmount,
        deliveryCharges: input.deliveryCharges ?? 0,
        otherCharges: input.otherCharges ?? 0,
        discount: input.discount ?? 0,
        total,
        withholdingTax: withholding,
        netPayable,
        status: "RECEIVED",
        matchStatus: "PENDING",
        items: {
          create: lines.map((l) => ({
            poItemId: l.poItemId ?? null,
            lineNo: l.lineNo,
            description: l.description,
            quantity: l.quantity,
            unit: l.unit,
            unitPrice: l.unitPrice,
            taxRate: l.taxRate,
            taxAmount: l.taxAmount,
            lineTotal: l.lineTotal,
          })),
        },
        grnLinks: {
          create: (input.grnIds ?? po.grns.map((g) => g.id)).map((grnId) => ({ grnId })),
        },
      },
    });

    // Copy the PO baseline and item link onto each line for the audit record.
    const created = await tx.invoiceItem.findMany({ where: { invoiceId: invoice.id } });
    for (const ci of created) {
      if (!ci.poItemId) continue;
      const poItem = await tx.purchaseOrderItem.findUnique({ where: { id: ci.poItemId } });
      if (poItem) {
        await tx.invoiceItem.update({
          where: { id: ci.id },
          data: { itemId: poItem.itemId, poQuantity: poItem.quantity, poUnitPrice: poItem.unitPrice },
        });
      }
    }

    if (po.prId) {
      const pr = await tx.purchaseRequisition.findUnique({ where: { id: po.prId } });
      if (pr && ["GRN_COMPLETED", "FULLY_RECEIVED", "PARTIALLY_RECEIVED"].includes(pr.status)) {
        await transitionPr(
          user,
          po.prId,
          "INVOICE_VERIFICATION",
          { force: true, authority: { cascade: "vendor invoice registered", from: [P.INVOICE_CREATE] } },
          tx,
        );
      }
    }

    await createTask(
      {
        title: `Verify invoice ${invoice.number}`,
        description: `${po.vendor.name} · vendor ref ${invoice.vendorInvoiceNumber} · PKR ${total.toLocaleString("en-PK")}`,
        taskType: "VERIFICATION",
        assignedRoleCode: "PROCUREMENT_OFFICER",
        entityId: po.entityId,
        documentType: "INVOICE",
        documentId: invoice.id,
        documentRef: invoice.number,
        priority: "NORMAL",
        slaHours: await getConfigNumber(CONFIG_KEYS.SLA_INVOICE_VERIFICATION_HOURS, po.entityId, tx),
        linkUrl: `/invoices/${invoice.id}`,
      },
      tx,
    );

    await writeAudit(
      {
        entityType: "Invoice",
        entityId: invoice.id,
        entityRef: invoice.number,
        action: "INVOICE_REGISTERED",
        newValue: {
          po: po.number,
          vendorRef: invoice.vendorInvoiceNumber,
          total,
          netPayable,
          lines: lines.length,
        },
        caseKey: po.pr?.number ?? null,
        actor: user,
      },
      tx,
    );

    // Run the match immediately so mismatches surface at registration — but
    // after the commit, not inside it.
    //
    // The intent is that registration stands even if the match cannot be run,
    // and a catch inside this transaction cannot deliver that: a failed
    // statement aborts every write before it, so swallowing the error would
    // discard the invoice while reporting success. Deferred, the invoice is
    // registered and a failed match is a failed match.
    const invoiceId = invoice.id;
    defer({
      label: `three-way match for ${invoice.number}`,
      run: () => verifyInvoice(user, invoiceId, prisma),
    });

    return tx.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  });

  // Re-read, because the match ran after the commit. `withTransaction` does not
  // resolve until its deferred work has finished, so the row is current by the
  // time we get here — and the caller words its message from `matchStatus`, so
  // returning the pre-match row would have it announce a clean match on an
  // invoice that failed one.
  return db.invoice.findUnique({ where: { id: registered.id } });
}

/** Runs the match and persists the outcome, raising an exception on failure. */
export async function verifyInvoice(user: SessionUser, invoiceId: string, db: DbClient = prisma) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.INVOICE_VERIFY)) {
      throw new ForbiddenError("You do not have permission to verify invoices.");
    }
    const result = await runThreeWayMatch(invoiceId, tx);
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { po: { include: { pr: true } }, vendor: true, items: true },
    });
    if (!invoice) throw new NotFoundError("Invoice");

    // Persist per-line flags.
    for (const lr of result.lines) {
      const il = invoice.items.find((x) => x.lineNo === lr.lineNo);
      if (!il) continue;
      await tx.invoiceItem.update({
        where: { id: il.id },
        data: { matchFlag: lr.flag, matchNotes: lr.notes, grnAcceptedQty: lr.grnAcceptedQty },
      });
    }

    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        matchStatus: result.passed ? "PASSED" : "FAILED",
        matchNotes: [...result.failures, ...result.warnings].join(" · ") || null,
        matchResult: JSON.stringify(result),
        status: result.passed ? "MATCHED" : "MISMATCH",
        verifiedById: user.id,
        verifiedAt: new Date(),
      },
    });

    // The invoice holds the current verdict; the match record holds this attempt.
    // A dispute about what was known at the time of payment cannot be settled from
    // a field that has since been overwritten.
    await tx.threeWayMatch.create({
      data: {
        invoiceId,
        poId: invoice.poId,
        grnId: (await tx.invoiceGrnLink.findFirst({ where: { invoiceId }, select: { grnId: true } }))?.grnId ?? null,
        result: result.passed ? "PASSED" : "FAILED",
        quantityMatched: !result.lines.some((l) => l.flag === "QTY_MISMATCH"),
        priceMatched: !result.lines.some((l) => l.flag === "PRICE_MISMATCH"),
        taxMatched: !result.lines.some((l) => l.flag === "TAX_MISMATCH"),
        totalMatched: result.totalsMatch,
        poTotal: round2(invoice.po?.total ?? 0),
        grnValue: round2(result.computedTotal),
        invoiceTotal: round2(result.invoiceTotal),
        variance: round2(result.totalVariance),
        detail: JSON.stringify(result.lines.filter((l) => l.flag !== "OK")),
        runById: user.id,
      },
    });

    if (!result.passed) {
      await raiseException(
        {
          type: "INVOICE_MISMATCH",
          severity: "HIGH",
          title: `${invoice.number}: three-way match failed`,
          description: result.failures.join(" · "),
          documentType: "INVOICE",
          documentId: invoice.id,
          documentRef: invoice.number,
          invoiceId: invoice.id,
          poId: invoice.poId,
          caseKey: invoice.po?.pr?.number ?? null,
          entityId: invoice.po?.entityId ?? null,
          ownerId: user.id,
          raisedById: user.id,
          blocking: true,
          notifyRoles: ["PROCUREMENT_SENIOR_MANAGER", "FINANCE_APPROVER", "PROCUREMENT_DIRECTOR"],
        },
        tx,
        user,
      );
      await notify(
        {
          roleCodes: ["PROCUREMENT_SENIOR_MANAGER", "FINANCE_APPROVER"],
          entityId: invoice.po?.entityId ?? null,
          type: "INVOICE_MISMATCH",
          title: `${invoice.number} failed three-way match`,
          body: result.failures[0],
          priority: "HIGH",
          linkType: "INVOICE",
          linkId: invoice.id,
          linkUrl: `/invoices/${invoice.id}`,
        },
        tx,
      );
    } else {
      await autoResolveExceptions(
        "INVOICE",
        invoice.id,
        ["INVOICE_MISMATCH"],
        "Three-way match passed on re-verification",
        tx,
      );
      await completeTasks("INVOICE", invoice.id, user.id, tx, "VERIFICATION");
    }

    await writeAudit(
      {
        entityType: "Invoice",
        entityId: invoiceId,
        entityRef: invoice.number,
        action: result.passed ? "INVOICE_MATCH_PASSED" : "INVOICE_MATCH_FAILED",
        newValue: {
          failures: result.failures,
          warnings: result.warnings,
          totalVariance: result.totalVariance,
          grnPresent: result.grnPresent,
        },
        caseKey: invoice.po?.pr?.number ?? null,
        actor: user,
      },
      tx,
    );

    return { invoice: updated, result };
  });
}

/**
 * Authorised override of a failed match. Requires a written reason and the
 * exception-approval permission; the exception is closed as WAIVED, not deleted.
 */
export async function approveInvoiceException(
  user: SessionUser,
  invoiceId: string,
  reason: string,
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.INVOICE_EXCEPTION_APPROVE)) {
      throw new ForbiddenError(
        "Only an authorised approver (Procurement Director or Finance Approver) may waive an invoice mismatch.",
      );
    }
    if (!reason?.trim() || reason.trim().length < 12) {
      throw new ValidationError("A substantive written reason is required to waive a three-way match failure.");
    }
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { po: { include: { pr: true } } },
    });
    if (!invoice) throw new NotFoundError("Invoice");
    if (invoice.matchStatus !== "FAILED") {
      throw new RuleViolationError("This invoice does not have a failed match to waive.");
    }

    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        matchStatus: "OVERRIDDEN",
        status: "EXCEPTION_APPROVED",
        exceptionApprovedById: user.id,
        exceptionApprovedAt: new Date(),
        exceptionReason: reason.trim(),
      },
    });

    await tx.exception.updateMany({
      where: { invoiceId, type: "INVOICE_MISMATCH", status: { in: ["OPEN", "IN_PROGRESS"] } },
      data: {
        status: "WAIVED",
        resolution: `Waived by ${user.name}: ${reason.trim()}`,
        resolvedById: user.id,
        resolvedAt: new Date(),
      },
    });

    await writeAudit(
      {
        entityType: "Invoice",
        entityId: invoiceId,
        entityRef: invoice.number,
        action: "INVOICE_MISMATCH_WAIVED",
        reason: reason.trim(),
        newValue: { approvedBy: user.name, total: invoice.total },
        caseKey: invoice.po?.pr?.number ?? null,
        actor: user,
      },
      tx,
    );

    return updated;
  });
}

export async function submitInvoiceForApproval(user: SessionUser, invoiceId: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.INVOICE_VERIFY)) throw new ForbiddenError("Not permitted.");
  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: { po: { include: { pr: true } } },
  });
  if (!invoice) throw new NotFoundError("Invoice");

  const blockOnMismatch = await getConfigBool(
    CONFIG_KEYS.BLOCK_PAYMENT_ON_MISMATCH,
    invoice.po?.entityId ?? null,
    db,
  );
  if (blockOnMismatch && invoice.matchStatus === "FAILED") {
    throw new RuleViolationError(
      `Invoice ${invoice.number} has an unresolved three-way match failure. Resolve it, or have an authorised approver waive it with a recorded reason, before seeking payment approval.`,
    );
  }
  if (invoice.matchStatus === "PENDING") {
    throw new RuleViolationError("Run the three-way match before submitting this invoice for approval.");
  }
  if (["APPROVED", "SENT_TO_FINANCE", "PAID"].includes(invoice.status)) {
    throw new RuleViolationError(`Invoice ${invoice.number} is already ${invoice.status}.`);
  }

  const approval = await startApproval(
    {
      documentType: "INVOICE",
      documentId: invoice.id,
      documentRef: invoice.number,
      entityId: invoice.po?.entityId ?? null,
      departmentId: invoice.po?.pr?.departmentId ?? null,
      procurementType: invoice.po?.pr?.procurementType ?? null,
      amount: invoice.total,
      caseKey: invoice.po?.pr?.number ?? null,
      linkUrl: `/invoices/${invoice.id}`,
      actor: user,
    },
    db,
  );

  await db.invoice.update({
    where: { id: invoiceId },
    data: { status: approval.autoApproved ? "APPROVED" : "PENDING_APPROVAL" },
  });

  return approval;
}

export async function decideInvoice(
  user: SessionUser,
  invoiceId: string,
  decision: ApprovalDecision,
  comment: string | null,
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.INVOICE_APPROVE)) {
      throw new ForbiddenError("You do not have permission to approve invoices.");
    }
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { po: { include: { pr: true } }, vendor: true },
    });
    if (!invoice) throw new NotFoundError("Invoice");

    // The match is only a check if somebody other than the receipt's author makes
    // it. Every posted receipt on the order is considered, not just the latest —
    // a part-delivered order has several, and any one of them being the approver's
    // own work defeats the same control.
    if (decision === "APPROVED" && invoice.poId) {
      // The poster is the counterpart that matters: their act created the stock
      // record the invoice is matched against. Receipts posted before
      // `postedById` existed fall back to the receiver, which is the closest
      // recorded counterpart for them and still catches the same person on both
      // sides in the overwhelmingly common case where they are one and the same.
      const posted = await tx.grn.findMany({
        where: { poId: invoice.poId, status: "POSTED" },
        select: { id: true, number: true, postedById: true, receivedById: true },
      });
      for (const g of posted) {
        await assertSeparation(
          user,
          SOD_RULES.GRN_POST_INVOICE_APPROVE,
          g.postedById ?? g.receivedById,
          {
            entityId: invoice.po?.entityId ?? null,
            documentType: "Invoice",
            documentId: invoice.id,
            documentRef: invoice.number,
          },
          tx,
        );
      }
    }
    const instance = await getPendingApproval("INVOICE", invoiceId, tx);
    if (!instance) throw new RuleViolationError(`Invoice ${invoice.number} has no approval pending.`);

    const result = await actOnApproval(
      {
        instanceId: instance.id,
        decision,
        comment,
        actor: user,
        caseKey: invoice.po?.pr?.number ?? null,
        linkUrl: `/invoices/${invoice.id}`,
      },
      tx,
    );

    if (decision === "REJECTED") {
      await tx.invoice.update({ where: { id: invoiceId }, data: { status: "REJECTED" } });
    } else if (decision === "RETURNED" || decision === "CLARIFICATION_REQUESTED") {
      await tx.invoice.update({ where: { id: invoiceId }, data: { status: "UNDER_VERIFICATION" } });
    } else if (result.completed) {
      await tx.invoice.update({ where: { id: invoiceId }, data: { status: "APPROVED" } });
      await createTask(
        {
          title: `Hand off ${invoice.number} to finance`,
          taskType: "ACTION",
          assignedRoleCode: "PROCUREMENT_OFFICER",
          entityId: invoice.po?.entityId ?? null,
          documentType: "INVOICE",
          documentId: invoice.id,
          documentRef: invoice.number,
          slaHours: 24,
          linkUrl: `/invoices/${invoice.id}`,
        },
        tx,
      );
    }

    await writeAudit(
      {
        entityType: "Invoice",
        entityId: invoiceId,
        entityRef: invoice.number,
        action: `INVOICE_${decision}`,
        reason: comment,
        caseKey: invoice.po?.pr?.number ?? null,
        actor: user,
      },
      tx,
    );

    return result;
  });
}

/**
 * Creates the finance handoff. This is the last procurement-side gate: it
 * re-checks GRN presence and match state so nothing slips through.
 */
export async function handoffToFinance(
  user: SessionUser,
  invoiceId: string,
  notes: string | null,
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.FINANCE_HANDOFF)) {
      throw new ForbiddenError("You do not have permission to hand invoices to finance.");
    }
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        po: { include: { pr: true, grns: { where: { status: "POSTED" }, select: { id: true } } } },
        vendor: true,
        exceptions: { where: { status: { in: ["OPEN", "IN_PROGRESS"] }, blocking: true } },
      },
    });
    if (!invoice) throw new NotFoundError("Invoice");

    const blockers: string[] = [];
    if (!["APPROVED", "EXCEPTION_APPROVED", "MATCHED"].includes(invoice.status)) {
      blockers.push(`Invoice status is ${invoice.status} — it must be approved before finance handoff.`);
    }
    const requireGrn = await getConfigBool(
      CONFIG_KEYS.REQUIRE_GRN_FOR_PAYMENT,
      invoice.po?.entityId ?? null,
      tx,
    );
    if (requireGrn && !(invoice.po?.grns.length ?? 0)) {
      blockers.push("No posted GRN exists — payment cannot be released for goods not recorded as received.");
    }
    const blockOnMismatch = await getConfigBool(
      CONFIG_KEYS.BLOCK_PAYMENT_ON_MISMATCH,
      invoice.po?.entityId ?? null,
      tx,
    );
    if (blockOnMismatch && invoice.matchStatus === "FAILED") {
      blockers.push("The three-way match is still failing and has not been waived by an authorised approver.");
    }
    if (invoice.exceptions.length) {
      blockers.push(
        `${invoice.exceptions.length} blocking exception(s) are unresolved: ${invoice.exceptions.map((e) => e.number).join(", ")}.`,
      );
    }
    if (blockers.length) {
      throw new RuleViolationError(`Invoice ${invoice.number} cannot be handed to finance.`, blockers);
    }

    const number = await nextNumber(SEQ.HANDOFF, tx);
    const handoff = await tx.paymentHandoff.create({
      data: {
        number,
        invoiceId: invoice.id,
        amount: invoice.netPayable || invoice.total,
        status: "PENDING",
        handedOffById: user.id,
        notes,
      },
    });

    await tx.invoice.update({ where: { id: invoiceId }, data: { status: "SENT_TO_FINANCE" } });
    await completeTasks("INVOICE", invoiceId, user.id, tx);

    if (invoice.po?.prId) {
      await transitionPr(user, invoice.po.prId, "FINANCE_HANDOFF", { force: true }, tx);
    }

    await createTask(
      {
        title: `Payment pending — ${handoff.number}`,
        description: `${invoice.vendor.name} · ${invoice.number} · PKR ${handoff.amount.toLocaleString("en-PK")}`,
        taskType: "ACTION",
        assignedRoleCode: "FINANCE_USER",
        entityId: invoice.po?.entityId ?? null,
        documentType: "PAYMENT_HANDOFF",
        documentId: handoff.id,
        documentRef: handoff.number,
        priority: "NORMAL",
        slaHours: 72,
        linkUrl: `/finance/handoffs/${handoff.id}`,
      },
      tx,
    );
    await notify(
      {
        roleCodes: ["FINANCE_USER", "FINANCE_APPROVER"],
        entityId: invoice.po?.entityId ?? null,
        type: "FINANCE_HANDOFF",
        title: `${invoice.number} handed to finance`,
        body: `${invoice.vendor.name} · PKR ${handoff.amount.toLocaleString("en-PK")}`,
        linkType: "PAYMENT_HANDOFF",
        linkId: handoff.id,
        linkUrl: `/finance/handoffs/${handoff.id}`,
      },
      tx,
    );

    await writeAudit(
      {
        entityType: "PaymentHandoff",
        entityId: handoff.id,
        entityRef: handoff.number,
        action: "FINANCE_HANDOFF_CREATED",
        newValue: { invoice: invoice.number, amount: handoff.amount, vendor: invoice.vendor.name },
        reason: notes,
        caseKey: invoice.po?.pr?.number ?? null,
        actor: user,
      },
      tx,
    );

    return handoff;
  });
}

export async function acknowledgeHandoff(
  user: SessionUser,
  handoffId: string,
  input: { paymentMethod?: string | null; bankAccount?: string | null; scheduledDate?: Date | null; notes?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.FINANCE_ACK)) {
    throw new ForbiddenError("You do not have permission to acknowledge finance handoffs.");
  }
  const h = await db.paymentHandoff.findUnique({
    where: { id: handoffId },
    include: { invoice: { include: { po: { include: { pr: true } } } } },
  });
  if (!h) throw new NotFoundError("Payment handoff");

  const updated = await db.paymentHandoff.update({
    where: { id: handoffId },
    data: {
      status: input.scheduledDate ? "SCHEDULED" : "ACKNOWLEDGED",
      paymentMethod: input.paymentMethod ?? null,
      bankAccount: input.bankAccount ?? null,
      scheduledDate: input.scheduledDate ?? null,
      financeAckById: user.id,
      financeAckAt: new Date(),
      notes: input.notes ?? h.notes,
    },
  });
  await writeAudit(
    {
      entityType: "PaymentHandoff",
      entityId: handoffId,
      entityRef: h.number,
      action: "FINANCE_HANDOFF_ACKNOWLEDGED",
      newValue: { method: input.paymentMethod, scheduled: input.scheduledDate },
      caseKey: h.invoice.po?.pr?.number ?? null,
      actor: user,
    },
    db,
  );
  return updated;
}

export async function recordPayment(
  user: SessionUser,
  handoffId: string,
  input: { paymentReference: string; paidDate?: Date; paymentMethod?: string | null },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx, defer) => {
    if (!userHasPermission(user, P.PAYMENT_RECORD)) {
      throw new ForbiddenError("You do not have permission to record payments.");
    }
    if (!input.paymentReference?.trim()) throw new ValidationError("A payment reference is required.");

    const h = await tx.paymentHandoff.findUnique({
      where: { id: handoffId },
      include: { invoice: { include: { po: { include: { pr: true, grns: { where: { status: "POSTED" }, select: { id: true } } } } } } },
    });
    if (!h) throw new NotFoundError("Payment handoff");
    if (h.status === "PAID") return h;

    // Final integrity gate before money leaves.
    const requireGrn = await getConfigBool(
      CONFIG_KEYS.REQUIRE_GRN_FOR_PAYMENT,
      h.invoice.po?.entityId ?? null,
      tx,
    );
    if (requireGrn && !(h.invoice.po?.grns.length ?? 0)) {
      throw new RuleViolationError(
        "Payment cannot be recorded: no posted GRN exists for this purchase order.",
      );
    }
    if (h.invoice.matchStatus === "FAILED") {
      throw new RuleViolationError(
        "Payment cannot be recorded while the three-way match is failing and unwaived.",
      );
    }

    const updated = await tx.paymentHandoff.update({
      where: { id: handoffId },
      data: {
        status: "PAID",
        paymentReference: input.paymentReference.trim(),
        paidDate: input.paidDate ?? new Date(),
        paymentMethod: input.paymentMethod ?? h.paymentMethod,
      },
    });
    await tx.invoice.update({ where: { id: h.invoiceId }, data: { status: "PAID" } });
    await completeTasks("PAYMENT_HANDOFF", handoffId, user.id, tx);

    // Close the case when every invoice on the PO is settled.
    if (h.invoice.poId) {
      const outstanding = await tx.invoice.count({
        where: { poId: h.invoice.poId, status: { notIn: ["PAID", "REJECTED"] } },
      });
      const po = await tx.purchaseOrder.findUnique({ where: { id: h.invoice.poId } });
      if (outstanding === 0 && po && po.status === "FULLY_RECEIVED") {
        // Best-effort, and therefore deferred rather than caught. Closing the
        // order is a consequence of the payment, not a condition of it — but a
        // caught database error inside this transaction would abort the payment
        // itself while the catch reported success. After the commit it can fail
        // harmlessly, and the Open PO board surfaces anything left open.
        const poId = po.id;
        defer({
          label: `close purchase order ${po.number} after final payment`,
          run: async () => {
            const { closePo } = await import("./po");
            await closePo(user, poId, "All goods received and all invoices paid", prisma);
          },
        });
      }
    }

    await writeAudit(
      {
        entityType: "PaymentHandoff",
        entityId: handoffId,
        entityRef: h.number,
        action: "PAYMENT_RECORDED",
        newValue: { amount: h.amount, reference: input.paymentReference },
        caseKey: h.invoice.po?.pr?.number ?? null,
        actor: user,
      },
      tx,
    );

    return updated;
  });
}

export async function holdInvoice(user: SessionUser, invoiceId: string, reason: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.INVOICE_VERIFY, P.INVOICE_APPROVE)) throw new ForbiddenError("Not permitted.");
  if (!reason?.trim()) throw new ValidationError("A reason is required.");
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId }, include: { po: { include: { pr: true } } } });
  if (!invoice) throw new NotFoundError("Invoice");
  const updated = await db.invoice.update({ where: { id: invoiceId }, data: { status: "ON_HOLD", matchNotes: reason } });
  await writeAudit(
    {
      entityType: "Invoice",
      entityId: invoiceId,
      entityRef: invoice.number,
      action: "INVOICE_ON_HOLD",
      reason,
      caseKey: invoice.po?.pr?.number ?? null,
      actor: user,
    },
    db,
  );
  return updated;
}
