"use server";

import { revalidatePath } from "next/cache";
import { requirePermission, requireUser } from "@/lib/auth";
import { toActionError, ValidationError, type ActionResult } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import {
  confirmServiceAcceptance,
  createServiceAcceptance,
  serviceOutstanding,
} from "@/server/service-acceptance";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const n = Number(typeof v === "string" ? v : NaN);
  return Number.isFinite(n) ? n : null;
};

/** Raises the acceptance record against a service order. */
export async function raiseServiceAcceptanceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requirePermission(P.SERVICE_ACCEPT, P.RECEIVE_GOODS);
    const poId = String(formData.get("poId") ?? "");
    if (!poId) throw new ValidationError("Select the service order.");

    const outstanding = await serviceOutstanding(poId);
    const items = outstanding
      .map((o) => {
        const accepted = num(formData.get(`accepted_${o.id}`));
        if (accepted === null) return null;
        return {
          poItemId: o.id,
          acceptedQty: accepted,
          rejectedQty: num(formData.get(`rejected_${o.id}`)) ?? 0,
          evidenceRef: blank(formData.get(`evidence_${o.id}`)),
          remarks: blank(formData.get(`remarks_${o.id}`)),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (!items.length) throw new ValidationError("Enter the quantity accepted on at least one line.");

    const from = blank(formData.get("serviceFrom"));
    const to = blank(formData.get("serviceTo"));

    const sa = await createServiceAcceptance(user, {
      poId,
      serviceFrom: from ? new Date(from) : null,
      serviceTo: to ? new Date(to) : null,
      pocUserId: blank(formData.get("pocUserId")),
      remarks: blank(formData.get("remarks")),
      items,
    });

    revalidatePath(`/po/${poId}`);
    revalidatePath("/service-acceptance");
    return {
      ok: true,
      data: { id: sa.id, number: sa.number },
      message: `${sa.number} raised. It is not evidence until the point of contact confirms the work was performed.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/** The point of contact confirms, or refuses with a reason. */
export async function confirmServiceAcceptanceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    // Deliberately only `requireUser`: the domain function decides, because the
    // right to confirm belongs to the *named* point of contact rather than to a
    // permission anybody could hold. A permission check here would either admit
    // the wrong people or exclude the right one.
    const user = await requireUser();
    const id = String(formData.get("id") ?? "");
    const decision = String(formData.get("decision") ?? "") as "ACCEPT" | "REJECT";
    if (decision !== "ACCEPT" && decision !== "REJECT") {
      throw new ValidationError("Say whether the service is accepted.");
    }
    const comment = blank(formData.get("comment"));

    const sa = await confirmServiceAcceptance(user, id, decision, comment);

    revalidatePath(`/service-acceptance/${id}`);
    revalidatePath(`/po/${sa.poId}`);
    return {
      ok: true,
      data: null,
      message:
        decision === "ACCEPT"
          ? `${sa.number} confirmed — PKR ${sa.acceptedValue.toLocaleString("en-PK")} is now invoiceable.`
          : `${sa.number} refused. The vendor's invoice stays blocked until this is settled.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}
