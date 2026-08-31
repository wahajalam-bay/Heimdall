"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { PERMISSIONS as P } from "@/lib/permissions";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import {
  cancelPo,
  closePo,
  createPoFromCase,
  decidePo,
  holdPo,
  issuePo,
  poReadiness,
  setAdvanceStatus,
  submitPoForApproval,
  updatePoTerms,
} from "@/server/po";
import { recordSavingsForPo } from "@/server/analytics";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const s = blank(v);
  return s === null ? null : Number(s);
};

export async function createPoAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const prId = String(formData.get("prId") ?? "");
    if (!prId) throw new ValidationError("Missing requisition reference.");

    const advanceRequired = formData.get("advanceRequired") === "on" || formData.get("advanceRequired") === "true";
    const po = await createPoFromCase(user, {
      prId,
      deliveryStoreId: blank(formData.get("deliveryStoreId")),
      deliveryAddress: blank(formData.get("deliveryAddress")),
      deliveryDate: blank(formData.get("deliveryDate")) ? new Date(String(formData.get("deliveryDate"))) : null,
      paymentTerms: blank(formData.get("paymentTerms")),
      creditDays: num(formData.get("creditDays")),
      warrantyTerms: blank(formData.get("warrantyTerms")),
      termsConditions: blank(formData.get("termsConditions")),
      incoterms: blank(formData.get("incoterms")),
      advanceRequired,
      advancePercent: advanceRequired ? num(formData.get("advancePercent")) : null,
      collateralType: advanceRequired ? blank(formData.get("collateralType")) : null,
      collateralRef: advanceRequired ? blank(formData.get("collateralRef")) : null,
      collateralNotes: advanceRequired ? blank(formData.get("collateralNotes")) : null,
    });

    await recordSavingsForPo(user, po.id, undefined, {
      cascade: "purchase order created",
      from: [P.PO_CREATE],
    }).catch(() => null);

    if (formData.get("submitNow") === "true") {
      await submitPoForApproval(user, po.id);
    }
    revalidatePath("/po");
    revalidatePath(`/pr/${prId}`);
    return {
      ok: true,
      data: { id: po.id, number: po.number },
      message:
        formData.get("submitNow") === "true"
          ? `${po.number} created and submitted for approval.`
          : `${po.number} created as a draft.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function submitPoAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const poId = String(formData.get("poId") ?? "");
    const approval = await submitPoForApproval(user, poId);
    revalidatePath(`/po/${poId}`);
    return {
      ok: true,
      data: approval,
      message: approval.autoApproved
        ? "No approval rule matched — the purchase order is approved and ready to issue."
        : `Submitted for approval. First step: ${approval.steps[0]?.name ?? "approval"}.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function decidePoAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const poId = String(formData.get("poId") ?? "");
    const decision = String(formData.get("decision") ?? "") as
      | "APPROVED"
      | "REJECTED"
      | "RETURNED"
      | "CLARIFICATION_REQUESTED";
    const result = await decidePo(user, poId, decision, blank(formData.get("reason")));
    revalidatePath(`/po/${poId}`);
    revalidatePath("/workspace");
    return {
      ok: true,
      data: result,
      message: result.completed
        ? "Approval complete — the purchase order is ready to issue."
        : `Decision recorded${result.nextStepName ? `. Next step: ${result.nextStepName}.` : "."}`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function issuePoAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const poId = String(formData.get("poId") ?? "");
    const po = await issuePo(user, poId);
    revalidatePath(`/po/${poId}`);
    revalidatePath("/open-pos");
    return { ok: true, data: null, message: `${po.number} issued to the vendor. Receiving is now expected.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function closePoAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const poId = String(formData.get("poId") ?? "");
    const po = await closePo(user, poId, blank(formData.get("reason")));
    revalidatePath(`/po/${poId}`);
    revalidatePath("/open-pos");
    return { ok: true, data: null, message: `${po.number} closed.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function cancelPoAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const poId = String(formData.get("poId") ?? "");
    await cancelPo(user, poId, String(formData.get("reason") ?? ""));
    revalidatePath(`/po/${poId}`);
    revalidatePath("/po");
    return { ok: true, data: null, message: "Purchase order cancelled." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function holdPoAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const poId = String(formData.get("poId") ?? "");
    await holdPo(user, poId, String(formData.get("reason") ?? ""));
    revalidatePath(`/po/${poId}`);
    return { ok: true, data: null, message: "Purchase order placed on hold." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function updatePoTermsAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const poId = String(formData.get("poId") ?? "");
    await updatePoTerms(user, poId, {
      deliveryStoreId: blank(formData.get("deliveryStoreId")),
      deliveryAddress: blank(formData.get("deliveryAddress")),
      deliveryDate: blank(formData.get("deliveryDate")) ? new Date(String(formData.get("deliveryDate"))) : null,
      paymentTerms: blank(formData.get("paymentTerms")),
      creditDays: num(formData.get("creditDays")),
      warrantyTerms: blank(formData.get("warrantyTerms")),
      termsConditions: blank(formData.get("termsConditions")),
      incoterms: blank(formData.get("incoterms")),
    });
    revalidatePath(`/po/${poId}`);
    return { ok: true, data: null, message: "Purchase order terms updated." };
  } catch (e) {
    return toActionError(e);
  }
}

export async function setAdvanceStatusAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const poId = String(formData.get("poId") ?? "");
    const status = String(formData.get("status") ?? "PENDING") as "PENDING" | "APPROVED" | "PAID" | "SETTLED";
    await setAdvanceStatus(user, poId, status, blank(formData.get("reason")));
    revalidatePath(`/po/${poId}`);
    return { ok: true, data: null, message: `Advance marked as ${status.toLowerCase()}.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function poReadinessAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const prId = String(formData.get("prId") ?? "");
    const r = await poReadiness(prId);
    return { ok: true, data: r, message: r.ready ? "Ready for a purchase order." : `${r.issues.length} blocker(s).` };
  } catch (e) {
    return toActionError(e);
  }
}

/** Bulk short-close of purchase orders, used from the Open PO control tower. */
export async function bulkClosePos(ids: string[], reason: string | null) {
  const user = await requireUser();
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const id of ids) {
    try {
      await closePo(user, id, reason);
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e instanceof Error ? e.message : "Failed" });
    }
  }
  revalidatePath("/open-pos");
  revalidatePath("/po");
  return results;
}

export async function poFormOptions(entityId: string) {
  await requireUser();
  const stores = await prisma.store.findMany({
    where: { entityId, active: true },
    select: { id: true, code: true, name: true, kind: true, address: true, siteId: true },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
  return { stores };
}
