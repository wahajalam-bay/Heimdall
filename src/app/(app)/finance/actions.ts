"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import { cancelVoucher, generateVoucher, overrideMatch, signVoucher } from "@/server/vouchers";
import { upsertBudget } from "@/server/budget";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { ForbiddenError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { round2 } from "@/lib/format";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const s = blank(v);
  return s === null ? null : Number(s);
};

function touchVoucher(id?: string) {
  revalidatePath("/finance/vouchers");
  revalidatePath("/finance/pending");
  revalidatePath("/invoices");
  if (id) revalidatePath(`/finance/vouchers/${id}`);
}

/* ── Vouchers ─────────────────────────────────────────────── */

export async function generateVoucherAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const invoiceId = String(formData.get("invoiceId") ?? "");
    const voucher = await generateVoucher(user, {
      invoiceId,
      narration: blank(formData.get("narration")),
      glAccount: blank(formData.get("glAccount")),
      deductions: num(formData.get("deductions")),
    });
    touchVoucher(voucher.id);
    revalidatePath(`/invoices/${invoiceId}`);
    return {
      ok: true,
      data: { id: voucher.id, number: voucher.number },
      message: `${voucher.number} raised and sent for signature.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function signVoucherAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const voucherId = String(formData.get("voucherId") ?? "");
    const approve = formData.get("approve") === "true";
    const v = await signVoucher(user, { voucherId, approve, comment: blank(formData.get("reason")) });
    touchVoucher(voucherId);
    return {
      ok: true,
      data: null,
      message: approve
        ? v.status === "APPROVED"
          ? `${v.number} is fully signed and ready for payment.`
          : `Signature recorded on ${v.number}; it moves to the next signatory.`
        : `${v.number} refused.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function cancelVoucherAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const voucherId = String(formData.get("voucherId") ?? "");
    const v = await cancelVoucher(user, voucherId, String(formData.get("reason") ?? ""));
    touchVoucher(voucherId);
    return { ok: true, data: null, message: `${v.number} cancelled.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function overrideMatchAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const matchId = String(formData.get("matchId") ?? "");
    await overrideMatch(user, { matchId, reason: String(formData.get("reason") ?? "") });
    revalidatePath("/invoices");
    return { ok: true, data: null, message: "Match override recorded with its reason." };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Budgets ──────────────────────────────────────────────── */

export async function upsertBudgetAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const budget = await upsertBudget(user, {
      id: blank(formData.get("id")),
      entityId: String(formData.get("entityId") ?? ""),
      year: String(formData.get("year") ?? ""),
      departmentId: blank(formData.get("departmentId")),
      costCenterId: blank(formData.get("costCenterId")),
      categoryId: blank(formData.get("categoryId")),
      expenditureType: String(formData.get("expenditureType") ?? "BOTH"),
      allocated: Number(formData.get("allocated") ?? 0),
      hardLimit: formData.get("hardLimit") === "on" || formData.get("hardLimit") === "true",
      notes: blank(formData.get("notes")),
    });
    revalidatePath("/finance/budgets");
    return { ok: true, data: { id: budget.id }, message: `Budget for ${budget.year} saved.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Tax ──────────────────────────────────────────────────── */

export async function upsertTaxAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    if (!userHasPermission(user, P.TAX_MANAGE)) {
      throw new ForbiddenError("You do not have permission to maintain tax rates.");
    }
    const code = String(formData.get("code") ?? "").trim().toUpperCase();
    const name = String(formData.get("name") ?? "").trim();
    const rate = Number(formData.get("rate") ?? 0);
    if (!code) throw new ValidationError("A tax code is required.");
    if (!name) throw new ValidationError("A name is required.");
    if (rate < 0 || rate > 100) throw new ValidationError("A rate must be between nought and a hundred per cent.");

    const id = blank(formData.get("id"));
    const data = {
      code,
      name,
      type: String(formData.get("type") ?? "SALES"),
      rate: round2(rate),
      withheld: formData.get("withheld") === "on" || formData.get("withheld") === "true",
      entityId: blank(formData.get("entityId")),
      glAccount: blank(formData.get("glAccount")),
      notes: blank(formData.get("notes")),
    };
    const tax = id
      ? await prisma.tax.update({ where: { id }, data })
      : await prisma.tax.create({ data });

    await writeAudit(
      {
        entityType: "Tax",
        entityId: tax.id,
        entityRef: tax.code,
        action: id ? "TAX_UPDATED" : "TAX_CREATED",
        newValue: { rate: tax.rate, withheld: tax.withheld },
        actor: user,
      },
      prisma,
    );
    revalidatePath("/finance/taxes");
    return { ok: true, data: { id: tax.id }, message: `${tax.code} saved at ${tax.rate}%.` };
  } catch (e) {
    return toActionError(e);
  }
}

/**
 * Verifies the tax on an invoice.
 *
 * Kept as an explicit act by finance rather than a side effect of registering the
 * invoice: §58 makes tax verification a step, and a voucher will not be raised
 * until it has happened.
 */
export async function verifyTaxLinesAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    if (!userHasPermission(user, P.TAX_VERIFY)) {
      throw new ForbiddenError("You do not have permission to verify tax.");
    }
    const invoiceId = String(formData.get("invoiceId") ?? "");
    const dispute = formData.get("dispute") === "true";
    const reason = blank(formData.get("reason"));
    if (dispute && !reason) throw new ValidationError("Say what is disputed about the tax.");

    const lines = await prisma.invoiceTaxLine.findMany({ where: { invoiceId }, select: { id: true } });
    if (!lines.length) throw new ValidationError("This invoice has no tax lines to verify.");

    await prisma.invoiceTaxLine.updateMany({
      where: { invoiceId },
      data: {
        status: dispute ? "DISPUTED" : "VERIFIED",
        verifiedById: user.id,
        verifiedAt: new Date(),
        notes: reason,
      },
    });
    await writeAudit(
      {
        entityType: "Invoice",
        entityId: invoiceId,
        action: dispute ? "TAX_DISPUTED" : "TAX_VERIFIED",
        reason,
        newValue: { lines: lines.length },
        actor: user,
      },
      prisma,
    );
    revalidatePath(`/invoices/${invoiceId}`);
    return {
      ok: true,
      data: null,
      message: dispute ? `${lines.length} tax line(s) marked disputed.` : `${lines.length} tax line(s) verified.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Options ──────────────────────────────────────────────── */

export async function budgetOptions() {
  const user = await requireUser();
  const [entities, departments, costCenters, categories] = await Promise.all([
    prisma.entity.findMany({
      where: { active: true, id: { in: user.entityIds } },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    prisma.department.findMany({
      where: { active: true, entityId: { in: user.entityIds } },
      select: { id: true, name: true, entityId: true },
      orderBy: { name: "asc" },
    }),
    prisma.costCenter.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true, entityId: true },
      orderBy: { code: "asc" },
    }),
    prisma.category.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);
  return { entities, departments, costCenters, categories };
}
