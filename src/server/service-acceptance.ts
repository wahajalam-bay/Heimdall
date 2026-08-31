import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { assertEntityAccess, userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { createTask, notify } from "@/lib/notify";
import { round2 } from "@/lib/format";
import { DOMAIN_ACTIONS, assertAuthority, type Authority } from "@/lib/actor";
import { transitionPr } from "./pr";

/**
 * Service acceptance.
 *
 * The goods path ends in a receipt: something arrived, it was counted, it went
 * on a shelf. A service has nothing to count and nothing to shelve, so pushing
 * it down that path produces documents that describe nothing — a delivery note
 * for an oil test, a stock balance of zero cleanings.
 *
 * What a service needs instead is the same thing a receipt provides: somebody
 * accountable saying what actually happened. ZAM/PUR/SOP-01 §3.2 already names
 * who — "the concerned departmental head or their representative" verifies, not
 * procurement and not the store. So acceptance is confirmed by the requesting
 * department's point of contact, records what proportion is accepted, and is
 * what makes the invoice payable.
 *
 * Partial acceptance is normal and is not an exception: a month of cleaning with
 * three days missed is 90% of the line, stated as such, with the reason on the
 * record.
 */

export type ServiceAcceptanceInput = {
  poId: string;
  serviceFrom?: Date | null;
  serviceTo?: Date | null;
  pocUserId?: string | null;
  remarks?: string | null;
  items: Array<{
    poItemId: string;
    acceptedQty: number;
    rejectedQty?: number;
    evidenceRef?: string | null;
    remarks?: string | null;
  }>;
};

/**
 * How much of each service line is still open to accept.
 *
 * The same cap the goods path applies to receiving: cumulative accepted quantity
 * across every acceptance may never exceed what was ordered. Without this a
 * recurring service could be accepted twelve times against a three-month order.
 */
export async function serviceOutstanding(poId: string, db: DbClient = prisma) {
  const [items, accepted] = await Promise.all([
    db.purchaseOrderItem.findMany({
      where: { poId },
      select: { id: true, lineNo: true, description: true, unit: true, quantity: true, unitPrice: true, procurementKind: true },
      orderBy: { lineNo: "asc" },
    }),
    db.serviceAcceptanceItem.groupBy({
      by: ["poItemId"],
      where: { serviceAcceptance: { poId, status: { in: ["ACCEPTED", "PARTIALLY_ACCEPTED"] } } },
      _sum: { acceptedQty: true },
    }),
  ]);
  const takenByItem = new Map(accepted.map((a) => [a.poItemId, a._sum.acceptedQty ?? 0]));
  return items.map((i) => {
    const taken = round2(takenByItem.get(i.id) ?? 0);
    return {
      ...i,
      acceptedToDate: taken,
      outstanding: round2(Math.max(0, i.quantity - taken)),
    };
  });
}

export async function createServiceAcceptance(
  user: SessionUser,
  input: ServiceAcceptanceInput,
  db: DbClient = prisma,
) {
  // Confirming that work was done is a substantive act: it is what releases the
  // vendor's invoice. It sits with the same authority that records a receipt.
  if (!userHasPermission(user, P.RECEIVE_GOODS, P.SERVICE_ACCEPT)) {
    throw new RuleViolationError(
      "You do not have permission to record service acceptance.",
    );
  }
  if (!input.items.length) throw new ValidationError("Record at least one service line.");

  return withTransaction(db, async (tx) => {
    const po = await tx.purchaseOrder.findUnique({
      where: { id: input.poId },
      include: { items: true, vendor: true, pr: true },
    });
    if (!po) throw new NotFoundError("Purchase order");
    assertEntityAccess(user, po.entityId);

    if (po.procurementKind !== "SERVICES") {
      throw new RuleViolationError(
        `${po.number} is a goods order. Goods are received against a GRN after inspection, not accepted as a service. ` +
          "If this order covers a service, it needs raising as a service order.",
      );
    }
    const receivable = ["ISSUED", "PARTIALLY_RECEIVED", "APPROVED"];
    if (!receivable.includes(po.status)) {
      throw new RuleViolationError(
        `${po.number} is ${po.status.replace(/_/g, " ").toLowerCase()} — a service cannot be accepted against it.`,
      );
    }

    const outstanding = await serviceOutstanding(input.poId, tx);
    const byId = new Map(outstanding.map((o) => [o.id, o]));

    const lines = input.items.map((it, i) => {
      const line = byId.get(it.poItemId);
      if (!line) {
        throw new ValidationError("A service line does not belong to this order.");
      }
      if (it.acceptedQty < 0 || (it.rejectedQty ?? 0) < 0) {
        throw new ValidationError("Accepted and rejected quantities cannot be negative.");
      }
      // The cumulative cap, stated in the vendor's terms rather than the system's.
      if (it.acceptedQty > line.outstanding + 1e-9) {
        throw new RuleViolationError(
          `Line ${line.lineNo} (${line.description}): ${round2(it.acceptedQty)} ${line.unit} accepted, but only ${line.outstanding} ${line.unit} of ${line.quantity} remains open — ${line.acceptedToDate} has already been accepted. ` +
            "Accepting beyond the order needs a purchase order amendment, not a larger acceptance.",
        );
      }
      return {
        poItemId: it.poItemId,
        lineNo: i + 1,
        description: line.description,
        unit: line.unit,
        orderedQty: line.quantity,
        acceptedQty: round2(it.acceptedQty),
        rejectedQty: round2(it.rejectedQty ?? 0),
        unitPrice: line.unitPrice,
        acceptedValue: round2(it.acceptedQty * line.unitPrice),
        evidenceRef: it.evidenceRef ?? null,
        remarks: it.remarks ?? null,
      };
    });

    const acceptedValue = round2(lines.reduce((a, l) => a + l.acceptedValue, 0));
    const orderedValue = round2(
      lines.reduce((a, l) => a + l.orderedQty * l.unitPrice, 0),
    );
    const anyShortfall = lines.some((l) => l.acceptedQty + 1e-9 < l.orderedQty);

    // Anything less than the whole line needs a reason. A shortfall with no
    // explanation is the thing this record exists to prevent.
    if (anyShortfall && !input.remarks?.trim() && !lines.some((l) => l.remarks?.trim())) {
      throw new ValidationError(
        "Part of the service was not accepted. State what was not delivered, so the vendor can be told and the invoice can be settled against it.",
      );
    }

    const number = await nextNumber(SEQ.SERVICE_ACCEPTANCE, tx);
    const created = await tx.serviceAcceptance.create({
      data: {
        number,
        poId: input.poId,
        entityId: po.entityId,
        status: "DRAFT",
        serviceFrom: input.serviceFrom ?? null,
        serviceTo: input.serviceTo ?? null,
        // The SOP puts verification with the requesting department. Default to
        // the requisitioner rather than to whoever is recording this.
        pocUserId: input.pocUserId ?? po.pr?.requesterId ?? null,
        remarks: input.remarks ?? null,
        acceptedValue,
        orderedValue,
        createdById: user.id,
        items: { create: lines },
      },
      include: { items: true },
    });

    if (created.pocUserId) {
      await createTask(
        {
          title: `Confirm service acceptance ${created.number}`,
          description: `${po.vendor.name} · ${po.number}. Confirm the work was performed before the invoice can be settled.`,
          taskType: "VERIFICATION",
          assigneeId: created.pocUserId,
          entityId: po.entityId,
          documentType: "SERVICE_ACCEPTANCE",
          documentId: created.id,
          documentRef: created.number,
          priority: "HIGH",
          slaHours: 48,
          linkUrl: `/service-acceptance/${created.id}`,
        },
        tx,
      );
    }

    await writeAudit(
      {
        entityType: "ServiceAcceptance",
        entityId: created.id,
        entityRef: created.number,
        action: "SERVICE_ACCEPTANCE_RAISED",
        newValue: {
          po: po.number,
          vendor: po.vendor.name,
          acceptedValue,
          orderedValue,
          lines: lines.length,
          poc: created.pocUserId,
        },
        caseKey: po.pr?.number ?? null,
        actor: user,
      },
      tx,
    );
    return created;
  });
}

/**
 * The point of contact confirms, or refuses.
 *
 * Only the named point of contact — or somebody who can act for the requesting
 * department — settles this. Procurement raising and procurement confirming its
 * own acceptance is the separation §3.2 exists to create.
 */
export async function confirmServiceAcceptance(
  user: SessionUser,
  id: string,
  decision: "ACCEPT" | "REJECT",
  comment: string | null,
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    const sa = await tx.serviceAcceptance.findUnique({
      where: { id },
      include: { items: true, po: { include: { pr: true, vendor: true } } },
    });
    if (!sa) throw new NotFoundError("Service acceptance");
    assertEntityAccess(user, sa.entityId);

    if (!["DRAFT", "SUBMITTED"].includes(sa.status)) {
      throw new RuleViolationError(
        `${sa.number} is already ${sa.status.replace(/_/g, " ").toLowerCase()}.`,
      );
    }

    // The named point of contact, or somebody holding the department's authority.
    const isPoc = sa.pocUserId === user.id;
    if (!isPoc && !userHasPermission(user, P.SERVICE_ACCEPT_ANY, P.INVOICE_VERIFY)) {
      throw new RuleViolationError(
        "A service is confirmed by the point of contact who asked for it, or by somebody authorised to act for that department. " +
          "This one is assigned to somebody else.",
      );
    }
    if (decision === "REJECT" && !comment?.trim()) {
      throw new ValidationError("State why the service is not accepted.");
    }

    const shortfall = sa.items.some((i) => i.acceptedQty + 1e-9 < i.orderedQty);
    const status =
      decision === "REJECT" ? "REJECTED" : shortfall ? "PARTIALLY_ACCEPTED" : "ACCEPTED";

    const updated = await tx.serviceAcceptance.update({
      where: { id },
      data: {
        status,
        confirmedById: user.id,
        confirmedAt: new Date(),
        rejectionReason: decision === "REJECT" ? comment : null,
        remarks: decision === "ACCEPT" && comment ? comment : sa.remarks,
        acceptedValue: decision === "REJECT" ? 0 : sa.acceptedValue,
      },
    });

    if (decision === "ACCEPT") {
      // Accepted service moves the order the way a receipt does, so the invoice
      // has something to match against.
      const outstanding = await serviceOutstanding(sa.poId, tx);
      const allDone = outstanding.every((o) => o.outstanding <= 1e-9);
      await tx.purchaseOrder.update({
        where: { id: sa.poId },
        data: { status: allDone ? "FULLY_RECEIVED" : "PARTIALLY_RECEIVED" },
      });

      if (sa.po.prId && allDone) {
        await transitionPr(
          user,
          sa.po.prId,
          "GRN_COMPLETED",
          {
            force: true,
            authority: {
              cascade: "service accepted in full",
              from: [P.RECEIVE_GOODS, P.SERVICE_ACCEPT, P.SERVICE_ACCEPT_ANY, P.INVOICE_VERIFY],
            } satisfies Authority,
          },
          tx,
        );
      }

      await createTask(
        {
          title: `Verify vendor invoice for ${sa.po.number}`,
          description: `Service accepted on ${sa.number} at PKR ${sa.acceptedValue.toLocaleString("en-PK")}.`,
          taskType: "VERIFICATION",
          assignedRoleCode: "PROCUREMENT_OFFICER",
          entityId: sa.entityId,
          documentType: "PO",
          documentId: sa.poId,
          documentRef: sa.po.number,
          slaHours: 24,
          linkUrl: `/po/${sa.poId}`,
        },
        tx,
      );
    }

    await notify(
      {
        roleCodes: ["PROCUREMENT_OFFICER", "FINANCE_USER"],
        userIds: sa.createdById === user.id ? [] : [sa.createdById],
        entityId: sa.entityId,
        type: "GENERAL",
        title: `${sa.number} ${status.replace(/_/g, " ").toLowerCase()}`,
        body: `${sa.po.vendor.name} · ${sa.po.number} · PKR ${updated.acceptedValue.toLocaleString("en-PK")} accepted`,
        priority: decision === "REJECT" ? "HIGH" : "NORMAL",
        linkType: "SERVICE_ACCEPTANCE",
        linkId: sa.id,
        linkUrl: `/service-acceptance/${sa.id}`,
      },
      tx,
    );

    await writeAudit(
      {
        entityType: "ServiceAcceptance",
        entityId: sa.id,
        entityRef: sa.number,
        action: decision === "ACCEPT" ? "SERVICE_ACCEPTED" : "SERVICE_REJECTED",
        changes: { status: { from: sa.status, to: status } },
        newValue: { acceptedValue: updated.acceptedValue, confirmedBy: user.name },
        reason: comment ?? null,
        caseKey: sa.po.pr?.number ?? null,
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/**
 * What a service order has had accepted, for the invoice match.
 *
 * The goods match asks what was received; the service match asks what was
 * accepted. Same question, different evidence.
 */
export async function acceptedServiceValue(poId: string, db: DbClient = prisma) {
  const rows = await db.serviceAcceptanceItem.findMany({
    where: {
      serviceAcceptance: { poId, status: { in: ["ACCEPTED", "PARTIALLY_ACCEPTED"] } },
    },
    select: { poItemId: true, acceptedQty: true, acceptedValue: true },
  });
  const byItem = new Map<string, { qty: number; value: number }>();
  for (const r of rows) {
    const cur = byItem.get(r.poItemId) ?? { qty: 0, value: 0 };
    cur.qty = round2(cur.qty + r.acceptedQty);
    cur.value = round2(cur.value + r.acceptedValue);
    byItem.set(r.poItemId, cur);
  }
  return byItem;
}
