"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import {
  acknowledgeHandoff,
  approveInvoiceException,
  decideInvoice,
  handoffToFinance,
  holdInvoice,
  recordPayment,
  registerInvoice,
  runThreeWayMatch,
  submitInvoiceForApproval,
  verifyInvoice,
  type InvoiceItemInput,
} from "@/server/invoice";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const s = blank(v);
  return s === null ? null : Number(s);
};

function touch(invoiceId?: string) {
  revalidatePath("/invoices");
  revalidatePath("/finance/pending");
  revalidatePath("/finance/handoffs");
  if (invoiceId) revalidatePath(`/invoices/${invoiceId}`);
}

/* ── Registration ─────────────────────────────────────────── */

export async function registerInvoiceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const poId = String(formData.get("poId") ?? "");
    if (!poId) throw new ValidationError("Select the purchase order this invoice is against.");
    const vendorInvoiceNumber = String(formData.get("vendorInvoiceNumber") ?? "").trim();
    if (!vendorInvoiceNumber) throw new ValidationError("Enter the vendor's own invoice number.");
    const invoiceDateRaw = blank(formData.get("invoiceDate"));
    if (!invoiceDateRaw) throw new ValidationError("Enter the invoice date.");
    const invoiceDate = new Date(invoiceDateRaw);
    if (Number.isNaN(invoiceDate.getTime())) throw new ValidationError("The invoice date could not be read.");
    const dueRaw = blank(formData.get("dueDate"));

    let items: InvoiceItemInput[];
    try {
      items = JSON.parse(String(formData.get("items") ?? "[]")) as InvoiceItemInput[];
    } catch {
      throw new ValidationError("Invoice lines could not be read.");
    }
    items = items.filter((l) => l.description?.trim() && Number(l.quantity) > 0);
    if (!items.length) throw new ValidationError("An invoice needs at least one line with a quantity.");

    const invoice = await registerInvoice(user, {
      poId,
      vendorInvoiceNumber,
      invoiceDate,
      dueDate: dueRaw ? new Date(dueRaw) : null,
      deliveryCharges: num(formData.get("deliveryCharges")) ?? 0,
      otherCharges: num(formData.get("otherCharges")) ?? 0,
      discount: num(formData.get("discount")) ?? 0,
      withholdingTax: num(formData.get("withholdingTax")) ?? 0,
      items: items.map((l) => ({
        poItemId: l.poItemId ?? null,
        description: l.description,
        quantity: Number(l.quantity),
        unit: l.unit || "EA",
        unitPrice: Number(l.unitPrice) || 0,
        taxRate: Number(l.taxRate) || 0,
      })),
      grnIds: formData.getAll("grnIds").map(String).filter(Boolean),
    });
    if (!invoice) throw new ValidationError("The invoice could not be read back after registration.");
    touch(invoice.id);
    revalidatePath(`/po/${poId}`);
    return {
      ok: true,
      data: { id: invoice.id, number: invoice.number, matchStatus: invoice.matchStatus },
      message:
        invoice.matchStatus === "FAILED"
          ? `${invoice.number} registered but the three-way match FAILED — payment is blocked until it is resolved or formally waived.`
          : `${invoice.number} registered and matched against the order and receipts.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Verification and matching ────────────────────────────── */

export async function rematchAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const invoiceId = String(formData.get("invoiceId") ?? "");
    const result = await runThreeWayMatch(invoiceId);
    touch(invoiceId);
    return {
      ok: true,
      data: null,
      message: result.passed
        ? "Three-way match re-run: passed."
        : `Three-way match re-run: ${result.failures.length} failure(s) remain.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function verifyInvoiceAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const invoiceId = String(formData.get("invoiceId") ?? "");
    const { invoice, result } = await verifyInvoice(user, invoiceId);
    touch(invoiceId);
    return {
      ok: true,
      data: null,
      message: result.passed
        ? `${invoice.number} verified — the match passed and it can go for approval.`
        : `${invoice.number} verified with ${result.failures.length} match failure(s). It cannot proceed until they are resolved or formally waived.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function waiveMismatchAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const invoiceId = String(formData.get("invoiceId") ?? "");
    const reason = String(formData.get("reason") ?? "");
    const invoice = await approveInvoiceException(user, invoiceId, reason);
    touch(invoiceId);
    return {
      ok: true,
      data: null,
      message: `Mismatch on ${invoice.number} formally waived. The override is permanently attributed to you.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function holdInvoiceAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const invoiceId = String(formData.get("invoiceId") ?? "");
    const invoice = await holdInvoice(user, invoiceId, String(formData.get("reason") ?? ""));
    touch(invoiceId);
    return { ok: true, data: null, message: `${invoice.number} placed on hold.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Approval ─────────────────────────────────────────────── */

export async function submitInvoiceAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const invoiceId = String(formData.get("invoiceId") ?? "");
    const approval = await submitInvoiceForApproval(user, invoiceId);
    touch(invoiceId);
    return {
      ok: true,
      data: null,
      message: approval.autoApproved
        ? "Invoice approved automatically — no approval rule required a decision at this value."
        : "Invoice submitted for approval.",
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function decideInvoiceAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const invoiceId = String(formData.get("invoiceId") ?? "");
    const decision = String(formData.get("decision") ?? "APPROVED") as
      | "APPROVED"
      | "REJECTED"
      | "RETURNED"
      | "CLARIFICATION_REQUESTED";
    const result = await decideInvoice(user, invoiceId, decision, blank(formData.get("reason")));
    touch(invoiceId);
    return {
      ok: true,
      data: null,
      message:
        decision === "APPROVED"
          ? result.completed
            ? "Approval complete — the invoice can now be handed to finance."
            : `Decision recorded${result.nextStepName ? `. Next step: ${result.nextStepName}.` : "."}`
          : `Invoice ${decision.toLowerCase().replace(/_/g, " ")}.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Finance ──────────────────────────────────────────────── */

export async function handoffAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const invoiceId = String(formData.get("invoiceId") ?? "");
    const handoff = await handoffToFinance(user, invoiceId, blank(formData.get("reason")));
    touch(invoiceId);
    return {
      ok: true,
      data: null,
      message: `${handoff.number} raised — finance has the invoice and the supporting documents.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function acknowledgeHandoffAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const handoffId = String(formData.get("handoffId") ?? "");
    const scheduledRaw = blank(formData.get("scheduledDate"));
    const h = await acknowledgeHandoff(user, handoffId, {
      paymentMethod: blank(formData.get("paymentMethod")),
      bankAccount: blank(formData.get("bankAccount")),
      scheduledDate: scheduledRaw ? new Date(scheduledRaw) : null,
      notes: blank(formData.get("notes")),
    });
    revalidatePath("/finance/handoffs");
    revalidatePath(`/finance/handoffs/${handoffId}`);
    revalidatePath("/finance/pending");
    return { ok: true, data: null, message: `${h.number} acknowledged by finance.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function recordPaymentAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const handoffId = String(formData.get("handoffId") ?? "");
    const paymentReference = String(formData.get("paymentReference") ?? "").trim();
    if (!paymentReference) throw new ValidationError("A payment reference is required.");
    const paidRaw = blank(formData.get("paidDate"));
    const h = await recordPayment(user, handoffId, {
      paymentReference,
      paidDate: paidRaw ? new Date(paidRaw) : undefined,
      paymentMethod: blank(formData.get("paymentMethod")),
    });
    revalidatePath("/finance/handoffs");
    revalidatePath(`/finance/handoffs/${handoffId}`);
    revalidatePath("/finance/pending");
    revalidatePath("/invoices");
    return { ok: true, data: null, message: `Payment recorded against ${h.number}.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Options ──────────────────────────────────────────────── */

/** Purchase orders that can legitimately carry an invoice, with their receipts. */
export async function invoiceablePos(entityId: string | null) {
  const user = await requireUser();
  const pos = await prisma.purchaseOrder.findMany({
    where: {
      status: { in: ["ISSUED", "ACKNOWLEDGED", "IN_PROGRESS", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CLOSED"] },
      ...(entityId ? { entityId } : { entityId: { in: user.entityIds } }),
    },
    orderBy: { createdAt: "desc" },
    take: 300,
    select: {
      id: true,
      number: true,
      total: true,
      currency: true,
      taxAmount: true,
      deliveryCharges: true,
      entityId: true,
      vendor: { select: { id: true, name: true } },
      items: {
        orderBy: { lineNo: "asc" },
        select: {
          id: true,
          lineNo: true,
          description: true,
          quantity: true,
          unit: true,
          unitPrice: true,
          taxRate: true,
          acceptedQty: true,
          invoicedQty: true,
        },
      },
      grns: {
        where: { status: "POSTED" },
        select: { id: true, number: true, receivedAt: true, totalValue: true },
        orderBy: { receivedAt: "desc" },
      },
      invoices: { select: { id: true, number: true, total: true, status: true } },
    },
  });
  return pos;
}

/* ── Bulk ─────────────────────────────────────────────────── */

/**
 * Re-runs the three-way match across several invoices. Finance uses this after a
 * GRN posts: an invoice that failed only because the goods had not been received
 * yet will pass on its own once they have, and one that fails for a real reason
 * keeps failing.
 */
export async function bulkRematchInvoices(ids: string[]) {
  const user = await requireUser();
  void user;
  const results: Array<{ id: string; ok: boolean; passed?: boolean; error?: string }> = [];
  for (const id of ids) {
    try {
      const result = await runThreeWayMatch(id);
      results.push({ id, ok: true, passed: result.passed });
    } catch (e) {
      results.push({ id, ok: false, error: e instanceof Error ? e.message : "Failed" });
    }
  }
  revalidatePath("/invoices");
  revalidatePath("/finance/pending");
  return results;
}
