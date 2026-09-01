import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { notify, createTask, completeTasks } from "@/lib/notify";
import { round2 } from "@/lib/format";
import { postMovement } from "./inventory";

/**
 * Loss, theft and unexplained shortage.
 *
 * The system had one route for stock that is not there: a manual adjustment with
 * a reason. That makes a shortage look like a correction and buries a theft in
 * the same list as a mis-keyed count.
 *
 * The distinction matters for three concrete reasons. A theft needs an
 * investigation and possibly a police report; an adjustment does not. A loss has
 * a value that belongs in a figure somebody is accountable for; an adjustment's
 * does not. And a pattern of losses in one store is a finding, which is
 * impossible to see when each one is a line in the adjustment ledger.
 *
 * ## The kind is a real classification
 *
 * `SHORTAGE_UNEXPLAINED` exists because it is the honest and most common answer.
 * Calling a shortage theft is an accusation; calling it a loss implies somebody
 * knows what happened. "We cannot account for it" is neither, and forcing a
 * reporter to choose between the other two produces a register full of wrong
 * labels.
 *
 * ## Reporting does not move stock
 *
 * The ledger correction is a separate, authorised adjustment taken after the case
 * has been concluded. A report that wrote off the stock as it was filed would let
 * anybody make an inconvenient quantity disappear by submitting a form — which is
 * a worse hole than the one this closes.
 */

export const LOSS_TYPES = [
  "THEFT",
  "LOSS",
  "DAMAGE",
  "SHORTAGE_UNEXPLAINED",
  "MISPLACED",
] as const;
export type LossType = (typeof LOSS_TYPES)[number];

export const LOSS_TYPE_LABELS: Record<LossType, string> = {
  THEFT: "Theft",
  LOSS: "Loss",
  DAMAGE: "Damage",
  SHORTAGE_UNEXPLAINED: "Unexplained shortage",
  MISPLACED: "Misplaced",
};

export const LOSS_STATES = [
  "DRAFT",
  "REPORTED",
  "UNDER_INVESTIGATION",
  "SUBSTANTIATED",
  "UNSUBSTANTIATED",
  "WRITTEN_OFF",
  "RECOVERED",
  "CLOSED",
  "CANCELLED",
] as const;
export type LossState = (typeof LOSS_STATES)[number];

export type LossLineInput = {
  itemId?: string | null;
  assetId?: string | null;
  description: string;
  quantity?: number;
  unit?: string;
  serialNumber?: string | null;
  batchNumber?: string | null;
  unitValue?: number | null;
  notes?: string | null;
};

/**
 * Files a report.
 *
 * The value is taken from the inventory bucket's cost where the reporter does
 * not supply one, because a loss valued at zero disappears from every figure it
 * should appear in — and "we do not know what it was worth" is almost never true
 * when the item is in the catalogue.
 */
export async function createLossReport(
  user: SessionUser,
  input: {
    entityId: string;
    storeId?: string | null;
    lossType?: LossType;
    title: string;
    description: string;
    occurredOn?: Date | null;
    discoveredOn: Date;
    discoveryRoute?: string | null;
    stockCountId?: string | null;
    policeReported?: boolean;
    policeReference?: string | null;
    suspicionNote?: string | null;
    items: LossLineInput[];
    submit?: boolean;
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.INVENTORY_ADJUST, P.STORE_ISSUE, P.RECEIVE_GOODS, P.AUDIT_VIEW)) {
      throw new RuleViolationError("You do not have permission to file a loss report.");
    }
    if (!input.title?.trim()) throw new ValidationError("Give the report a title.");
    if (!input.description?.trim() || input.description.trim().length < 15) {
      throw new ValidationError(
        "Describe what happened. A loss report is read by somebody who was not there, and two words will not tell them anything.",
      );
    }
    if (!input.items?.length) throw new ValidationError("List what is missing.");
    if (input.discoveredOn > new Date()) {
      throw new ValidationError("The discovery date cannot be in the future.");
    }
    if (input.occurredOn && input.occurredOn > input.discoveredOn) {
      throw new ValidationError(
        "It cannot have happened after it was discovered. If the date it happened is unknown, leave it blank.",
      );
    }
    const lossType = input.lossType ?? "SHORTAGE_UNEXPLAINED";
    if (!LOSS_TYPES.includes(lossType)) {
      throw new ValidationError("That is not a recognised kind of loss.");
    }
    if (lossType === "THEFT" && !input.description.trim()) {
      throw new ValidationError("A theft report needs a description of what is believed to have happened.");
    }
    if (input.policeReported && !input.policeReference?.trim()) {
      throw new ValidationError(
        "Record the police reference. A report marked as reported to the police with no reference cannot be followed up.",
      );
    }

    // Values from the ledger where the reporter did not supply one. A loss
    // valued at zero vanishes from every figure it belongs in.
    const itemIds = input.items.map((l) => l.itemId).filter((x): x is string => !!x);
    const costs = itemIds.length
      ? await tx.inventoryItem.findMany({
          where: {
            itemId: { in: itemIds },
            ...(input.storeId ? { storeId: input.storeId } : {}),
          },
          select: { itemId: true, unitCost: true },
        })
      : [];
    const costBy = new Map<string, number>();
    for (const c of costs) {
      if (!costBy.has(c.itemId) && c.unitCost > 0) costBy.set(c.itemId, c.unitCost);
    }

    const lines = input.items.map((l, i) => {
      if (!l.description?.trim()) throw new ValidationError(`Line ${i + 1}: describe what is missing.`);
      const quantity = round2(l.quantity ?? 1);
      if (quantity <= 0) throw new ValidationError(`Line ${i + 1}: quantity must be greater than zero.`);
      const unitValue = round2(l.unitValue ?? (l.itemId ? (costBy.get(l.itemId) ?? 0) : 0));
      return {
        lineNo: i + 1,
        itemId: l.itemId ?? null,
        assetId: l.assetId ?? null,
        description: l.description.trim(),
        quantity,
        unit: l.unit?.trim() || "EA",
        serialNumber: l.serialNumber?.trim() || null,
        batchNumber: l.batchNumber?.trim() || null,
        unitValue,
        lineValue: round2(quantity * unitValue),
        notes: l.notes?.trim() || null,
      };
    });

    const estimatedValue = round2(lines.reduce((a, l) => a + l.lineValue, 0));

    const report = await tx.lossReport.create({
      data: {
        number: await nextNumber(SEQ.LOSS_REPORT, tx),
        entityId: input.entityId,
        storeId: input.storeId ?? null,
        lossType,
        title: input.title.trim(),
        description: input.description.trim(),
        occurredOn: input.occurredOn ?? null,
        discoveredOn: input.discoveredOn,
        discoveryRoute: input.discoveryRoute?.trim() || null,
        stockCountId: input.stockCountId ?? null,
        status: input.submit ? "REPORTED" : "DRAFT",
        estimatedValue,
        policeReported: Boolean(input.policeReported),
        policeReference: input.policeReference?.trim() || null,
        suspicionNote: input.suspicionNote?.trim() || null,
        reportedById: user.id,
        items: { create: lines },
      },
    });

    await writeAudit(
      {
        entityType: "LossReport",
        entityId: report.id,
        entityRef: report.number,
        action: "LOSS_REPORTED",
        newValue: {
          type: lossType,
          value: estimatedValue,
          lines: lines.length,
          policeReported: Boolean(input.policeReported),
        },
        reason: input.description.trim(),
        actor: user,
      },
      tx,
    );

    if (input.submit) {
      await createTask(
        {
          title: `Investigate ${report.number} — ${LOSS_TYPE_LABELS[lossType]}`,
          description: `${input.title.trim()} · ${estimatedValue.toLocaleString("en-PK")}`,
          taskType: "VERIFICATION",
          assignedRoleCode: "AUDIT_USER",
          entityId: input.entityId,
          documentType: "LOSS_REPORT",
          documentId: report.id,
          documentRef: report.number,
          priority: lossType === "THEFT" ? "HIGH" : "NORMAL",
          linkUrl: `/inventory/losses/${report.id}`,
        },
        tx,
      );
      await notify(
        {
          roleCodes: ["AUDIT_USER", "WAREHOUSE_MANAGER", "STORE_MANAGER", "PROCUREMENT_SENIOR_MANAGER"],
          entityId: input.entityId,
          type: "GENERAL",
          priority: lossType === "THEFT" ? "HIGH" : "NORMAL",
          title: `${LOSS_TYPE_LABELS[lossType]} reported — ${report.number}`,
          body: `${input.title.trim()} · ${estimatedValue.toLocaleString("en-PK")} across ${lines.length} line(s)`,
          linkType: "LOSS_REPORT",
          linkId: report.id,
          linkUrl: `/inventory/losses/${report.id}`,
        },
        tx,
      );
    }
    return report;
  });
}

/** Moves the case along its states. */
export async function transitionLossReport(
  user: SessionUser,
  input: { reportId: string; to: LossState; findings?: string | null; reason?: string | null },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    const r = await tx.lossReport.findUnique({ where: { id: input.reportId } });
    if (!r) throw new NotFoundError("Loss report");
    if (!LOSS_STATES.includes(input.to)) throw new ValidationError("Unrecognised state.");

    const FLOW: Record<string, LossState[]> = {
      DRAFT: ["REPORTED", "CANCELLED"],
      REPORTED: ["UNDER_INVESTIGATION", "CANCELLED"],
      UNDER_INVESTIGATION: ["SUBSTANTIATED", "UNSUBSTANTIATED", "RECOVERED"],
      SUBSTANTIATED: ["WRITTEN_OFF", "RECOVERED", "CLOSED"],
      UNSUBSTANTIATED: ["CLOSED", "UNDER_INVESTIGATION"],
      WRITTEN_OFF: ["CLOSED"],
      RECOVERED: ["CLOSED"],
      CLOSED: [],
      CANCELLED: [],
    };
    if (!FLOW[r.status]?.includes(input.to)) {
      throw new RuleViolationError(
        `${r.number} cannot go from ${r.status.replace(/_/g, " ").toLowerCase()} to ${input.to.replace(/_/g, " ").toLowerCase()}.`,
      );
    }

    // A conclusion needs findings. "Substantiated" with nothing behind it is an
    // opinion, and "unsubstantiated" with nothing behind it is worse — it closes
    // a case without saying what was looked at.
    if (["SUBSTANTIATED", "UNSUBSTANTIATED"].includes(input.to) && !input.findings?.trim()) {
      throw new ValidationError(
        "Record what the investigation found. A conclusion with nothing behind it closes a case without saying what was looked at.",
      );
    }
    if (input.to === "CANCELLED" && !input.reason?.trim()) {
      throw new ValidationError("State why the report is being cancelled.");
    }

    const need = (...codes: string[]) => {
      if (!userHasPermission(user, ...codes)) {
        throw new RuleViolationError(`You do not have permission to move this report to ${input.to}.`);
      }
    };
    if (input.to === "UNDER_INVESTIGATION") need(P.AUDIT_VIEW, P.EXCEPTION_MANAGE);
    if (["SUBSTANTIATED", "UNSUBSTANTIATED"].includes(input.to)) need(P.AUDIT_VIEW, P.EXCEPTION_MANAGE);
    if (input.to === "WRITTEN_OFF") need(P.INVENTORY_ADJUST);
    if (["RECOVERED", "CLOSED", "CANCELLED"].includes(input.to)) {
      need(P.AUDIT_VIEW, P.INVENTORY_ADJUST, P.EXCEPTION_MANAGE);
    }

    // The investigator cannot be the reporter. A loss investigated by the person
    // who reported it tells you nothing you did not already have.
    if (input.to === "UNDER_INVESTIGATION" && r.reportedById === user.id) {
      throw new RuleViolationError(
        "You filed this report, so you cannot be its investigator. An investigation by the reporter adds nothing to what the report already says.",
      );
    }

    const updated = await tx.lossReport.update({
      where: { id: r.id },
      data: {
        status: input.to,
        ...(input.to === "UNDER_INVESTIGATION"
          ? { investigatorId: user.id, investigationStartedAt: new Date() }
          : {}),
        ...(["SUBSTANTIATED", "UNSUBSTANTIATED"].includes(input.to)
          ? { findings: input.findings!.trim(), concludedById: user.id, concludedAt: new Date() }
          : {}),
        ...(input.to === "CLOSED" || input.to === "CANCELLED" ? { closedAt: new Date() } : {}),
      },
    });

    if (["CLOSED", "CANCELLED", "WRITTEN_OFF"].includes(input.to)) {
      await completeTasks("LOSS_REPORT", r.id, user.id, tx);
    }
    await writeAudit(
      {
        entityType: "LossReport",
        entityId: r.id,
        entityRef: r.number,
        action: `LOSS_${input.to}`,
        changes: { status: { from: r.status, to: input.to } },
        reason: input.findings?.trim() ?? input.reason?.trim() ?? null,
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/**
 * Takes the lost stock off the ledger.
 *
 * Deliberately separate from reporting, and only after the case has been
 * substantiated. Each line posts through `postMovement` like every other stock
 * change and carries the report's number as its reason, so the ledger says why a
 * quantity left rather than just that it did.
 *
 * Asset lines are marked lost rather than adjusted: a tagged asset is one
 * identified thing, and posting a quantity against it would be nonsense.
 */
export async function writeOffLoss(
  user: SessionUser,
  reportId: string,
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.INVENTORY_ADJUST)) {
      throw new RuleViolationError("Taking stock off the ledger needs inventory-adjustment authority.");
    }
    const r = await tx.lossReport.findUnique({
      where: { id: reportId },
      include: { items: true, store: { select: { id: true, name: true, entityId: true } } },
    });
    if (!r) throw new NotFoundError("Loss report");
    if (r.status !== "SUBSTANTIATED") {
      throw new RuleViolationError(
        `${r.number} is ${r.status.replace(/_/g, " ").toLowerCase()}. Stock comes off the ledger once the loss has been substantiated, not when it is reported — otherwise a form could make an inconvenient quantity disappear.`,
      );
    }
    if (!r.storeId || !r.store) {
      throw new RuleViolationError(
        `${r.number} names no store, so there is no ledger to correct. Record the store, or close the case without a write-off.`,
      );
    }

    const toPost = r.items.filter((i) => i.itemId && !i.adjustmentTxnId);
    const assets = r.items.filter((i) => i.assetId);
    let posted = 0;
    let flagged = 0;
    const txnIds: string[] = [];

    for (const line of toPost) {
      const txn = await postMovement(
        "ADJUSTMENT",
        {
          itemId: line.itemId!,
          storeId: r.storeId,
          quantity: -line.quantity,
          unit: line.unit,
          batchNumber: line.batchNumber,
          serialNumber: line.serialNumber,
          entityId: r.store.entityId,
          source: { kind: "ADJUSTMENT", id: r.id, ref: r.number },
          reason: `${LOSS_TYPE_LABELS[r.lossType as LossType] ?? r.lossType} ${r.number}: ${line.description}`,
          performedById: user.id,
        },
        tx,
        user,
        { cascade: `substantiated loss report ${r.number}`, from: [P.INVENTORY_ADJUST] },
      );
      await tx.lossReportItem.update({
        where: { id: line.id },
        data: { adjustmentTxnId: txn.id },
      });
      txnIds.push(txn.id);
      posted += 1;
    }

    for (const line of assets) {
      const asset = await tx.asset.findUnique({ where: { id: line.assetId! } });
      if (!asset || asset.status === "LOST") continue;
      await tx.asset.update({ where: { id: asset.id }, data: { status: "LOST" } });
      await tx.assetTransaction.create({
        data: {
          assetId: asset.id,
          type: "LOST",
          fromStatus: asset.status,
          toStatus: "LOST",
          fromCustodianId: asset.custodianId,
          reference: r.number,
          performedById: user.id,
        },
      });
      flagged += 1;
    }

    const writtenOff = round2(
      r.items.reduce((a, i) => a + (i.itemId || i.assetId ? i.lineValue : 0), 0),
    );

    const updated = await tx.lossReport.update({
      where: { id: r.id },
      data: {
        status: "WRITTEN_OFF",
        writtenOffValue: writtenOff,
        writtenOffAt: new Date(),
        adjustmentTxnIds: JSON.stringify(txnIds),
      },
    });

    await writeAudit(
      {
        entityType: "LossReport",
        entityId: r.id,
        entityRef: r.number,
        action: "LOSS_WRITTEN_OFF",
        newValue: { movements: posted, assetsFlagged: flagged, value: writtenOff },
        actor: user,
      },
      tx,
    );
    return { report: updated, posted, flagged, writtenOff };
  });
}

export async function listLossReports(
  filter: { entityIds?: string[] | null; storeId?: string | null; status?: string | null } = {},
  db: DbClient = prisma,
) {
  return db.lossReport.findMany({
    where: {
      ...(filter.entityIds ? { entityId: { in: filter.entityIds } } : {}),
      ...(filter.storeId ? { storeId: filter.storeId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    include: {
      store: { select: { name: true } },
      reportedBy: { select: { name: true } },
      investigator: { select: { name: true } },
      _count: { select: { items: true } },
    },
    orderBy: { discoveredOn: "desc" },
    take: 300,
  });
}

export async function lossReportDetail(id: string, db: DbClient = prisma) {
  return db.lossReport.findUnique({
    where: { id },
    include: {
      store: { select: { id: true, name: true } },
      entity: { select: { code: true, name: true } },
      reportedBy: { select: { id: true, name: true, title: true } },
      investigator: { select: { name: true, title: true } },
      concludedBy: { select: { name: true, title: true } },
      items: {
        orderBy: { lineNo: "asc" },
        include: {
          item: { select: { sku: true, name: true } },
          asset: { select: { tag: true, name: true } },
        },
      },
    },
  });
}

/**
 * Losses by store and by kind, for the pattern the adjustment ledger cannot
 * show.
 *
 * One shortage is an incident. Four in the same store in a quarter is a finding,
 * and that is the only reason this report exists separately from the ledger.
 */
export async function lossSummary(
  filter: { entityIds?: string[] | null; since?: Date } = {},
  db: DbClient = prisma,
) {
  const since = filter.since ?? new Date(Date.now() - 365 * 86400000);
  const rows = await db.lossReport.findMany({
    where: {
      discoveredOn: { gte: since },
      status: { notIn: ["DRAFT", "CANCELLED"] },
      ...(filter.entityIds ? { entityId: { in: filter.entityIds } } : {}),
    },
    select: {
      lossType: true,
      estimatedValue: true,
      recoveredValue: true,
      writtenOffValue: true,
      storeId: true,
      store: { select: { name: true } },
    },
  });

  const byStore = new Map<string, { store: string; count: number; value: number }>();
  const byType = new Map<string, { count: number; value: number }>();
  for (const r of rows) {
    const key = r.storeId ?? "__none__";
    const slot = byStore.get(key) ?? {
      store: r.store?.name ?? "No store named",
      count: 0,
      value: 0,
    };
    slot.count += 1;
    slot.value = round2(slot.value + r.estimatedValue);
    byStore.set(key, slot);

    const t = byType.get(r.lossType) ?? { count: 0, value: 0 };
    t.count += 1;
    t.value = round2(t.value + r.estimatedValue);
    byType.set(r.lossType, t);
  }

  return {
    total: rows.length,
    totalValue: round2(rows.reduce((a, r) => a + r.estimatedValue, 0)),
    recovered: round2(rows.reduce((a, r) => a + r.recoveredValue, 0)),
    writtenOff: round2(rows.reduce((a, r) => a + (r.writtenOffValue ?? 0), 0)),
    byStore: [...byStore.values()].sort((a, b) => b.value - a.value),
    byType: [...byType.entries()]
      .map(([type, v]) => ({ type, ...v }))
      .sort((a, b) => b.value - a.value),
  };
}
