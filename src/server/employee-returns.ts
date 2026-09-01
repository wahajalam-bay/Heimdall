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
 * Employee returns.
 *
 * ZAM/PUR/SOP-01, Store Keeping, gives this its own flow: Store Receiving Note,
 * then inspection — **only for IT equipment** — then either the Repair and
 * Maintenance department or stacking and inventory.
 *
 * The system had nothing for it. Custody sat on the asset and could be
 * reassigned, which recorded that somebody else now holds a laptop but not that
 * one came back, in what state, or whether it was fit to give to anybody.
 *
 * ## Two details from the flow that carry the weight
 *
 * **Only IT equipment is inspected.** So the inspection is conditional, and what
 * makes it conditional is the item rather than somebody's judgement on the day.
 * A returned chair does not sit waiting on an IT inspection it will never get.
 *
 * **A failure goes to Repair and Maintenance, not back on the shelf.** That is
 * the entire point of inspecting. The alternative is a broken laptop reissued to
 * the next joiner, so a failed unit is handed off and the hand-off is recorded —
 * the return does not simply close.
 *
 * ## What does and does not go back into stock
 *
 * Only lines dispositioned `STACK` produce a movement. A unit sent for repair is
 * not in the store's usable stock and must not be counted as though it were;
 * that is the difference between an inventory figure and a pile of things in a
 * corner.
 */

export const RETURN_REASONS = [
  "RESIGNATION",
  "TRANSFER",
  "ROLE_CHANGE",
  "UPGRADE",
  "FAULTY",
  "END_OF_PROJECT",
  "OTHER",
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const RETURN_CONDITIONS = ["GOOD", "USABLE", "DAMAGED", "FAULTY", "BEYOND_REPAIR"] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

export const DISPOSITIONS = ["STACK", "REPAIR", "DISPOSE", "HOLD"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  RESIGNATION: "Leaving the company",
  TRANSFER: "Transfer",
  ROLE_CHANGE: "Role change",
  UPGRADE: "Replaced with an upgrade",
  FAULTY: "Faulty",
  END_OF_PROJECT: "End of project",
  OTHER: "Other",
};

/**
 * Category codes whose returns the SOP sends for inspection.
 *
 * "Only IT equipment will be inspected" — so this is the IT branch of the
 * catalogue and nothing else. Held here rather than inferred from the item's
 * name, because a category is a fact and a name is a guess.
 */
const IT_CATEGORY_CODES = new Set(["IT-EQUIP", "IT-PERIPH"]);

export type ReturnLineInput = {
  assetId?: string | null;
  itemId?: string | null;
  description: string;
  quantity?: number;
  unit?: string;
  serialNumber?: string | null;
  condition?: ReturnCondition;
  conditionNotes?: string | null;
};

/**
 * Raises the Store Receiving Note.
 *
 * Whether the IT inspection applies is decided here, from the items, and held on
 * the row. A category recategorised next year must not make a return that was
 * correctly not inspected look as though it skipped a step.
 */
export async function createEmployeeReturn(
  user: SessionUser,
  input: {
    storeId: string;
    returnedById?: string | null;
    returnedByName: string;
    department?: string | null;
    reason?: ReturnReason;
    reasonNote?: string | null;
    receiptNotes?: string | null;
    items: ReturnLineInput[];
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.RECEIVE_GOODS, P.STORE_ISSUE, P.INVENTORY_ADJUST)) {
      throw new RuleViolationError("You do not have permission to receive returns into a store.");
    }
    if (!input.returnedByName?.trim()) {
      throw new ValidationError(
        "Name who is handing this back. A leaver's account is often already disabled by the time the equipment arrives, so the name is what the record keeps.",
      );
    }
    if (!input.items?.length) throw new ValidationError("A return needs at least one line.");

    const store = await tx.store.findUnique({
      where: { id: input.storeId },
      select: { id: true, name: true, entityId: true, active: true },
    });
    if (!store) throw new NotFoundError("Store");
    if (!store.active) throw new RuleViolationError(`${store.name} is not active.`);

    // Which items are IT, resolved from their categories in one read.
    const itemIds = input.items.map((i) => i.itemId).filter((x): x is string => !!x);
    const assetIds = input.items.map((i) => i.assetId).filter((x): x is string => !!x);
    const [items, assets] = await Promise.all([
      itemIds.length
        ? tx.item.findMany({
            where: { id: { in: itemIds } },
            select: { id: true, unit: true, category: { select: { code: true } } },
          })
        : Promise.resolve([]),
      assetIds.length
        ? tx.asset.findMany({
            where: { id: { in: assetIds } },
            select: { id: true, itemId: true, item: { select: { category: { select: { code: true } } } } },
          })
        : Promise.resolve([]),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));
    const assetById = new Map(assets.map((a) => [a.id, a]));

    const isIt = (l: ReturnLineInput) => {
      const viaItem = l.itemId ? itemById.get(l.itemId)?.category?.code : undefined;
      const viaAsset = l.assetId ? assetById.get(l.assetId)?.item?.category?.code : undefined;
      const code = viaItem ?? viaAsset;
      return code ? IT_CATEGORY_CODES.has(code) : false;
    };

    const lines = input.items.map((l, i) => {
      if (!l.description?.trim()) throw new ValidationError(`Line ${i + 1}: describe what came back.`);
      const quantity = round2(l.quantity ?? 1);
      if (quantity <= 0) throw new ValidationError(`Line ${i + 1}: quantity must be greater than zero.`);
      const condition = (l.condition ?? "GOOD") as ReturnCondition;
      if (!RETURN_CONDITIONS.includes(condition)) {
        throw new ValidationError(`Line ${i + 1}: that is not a recognised condition.`);
      }
      if (condition !== "GOOD" && !l.conditionNotes?.trim()) {
        throw new ValidationError(
          `Line ${i + 1}: say what is wrong with it. "Damaged" with nothing beside it cannot be acted on by whoever has to fix or write it off.`,
        );
      }
      return {
        lineNo: i + 1,
        assetId: l.assetId ?? null,
        itemId: l.itemId ?? assetById.get(l.assetId ?? "")?.itemId ?? null,
        description: l.description.trim(),
        quantity,
        unit: l.unit?.trim() || itemById.get(l.itemId ?? "")?.unit || "EA",
        serialNumber: l.serialNumber?.trim() || null,
        condition,
        conditionNotes: l.conditionNotes?.trim() || null,
        inspectionVerdict: isIt(l) ? null : "NOT_INSPECTED",
      };
    });

    const inspectionRequired = input.items.some(isIt);

    const ret = await tx.employeeReturn.create({
      data: {
        number: await nextNumber(SEQ.EMPLOYEE_RETURN, tx),
        storeId: store.id,
        entityId: store.entityId,
        returnedById: input.returnedById ?? null,
        returnedByName: input.returnedByName.trim(),
        department: input.department?.trim() || null,
        reason: input.reason ?? "OTHER",
        reasonNote: input.reasonNote?.trim() || null,
        status: inspectionRequired ? "PENDING_INSPECTION" : "RECEIVED",
        srnNumber: null,
        receivedById: user.id,
        receivedAt: new Date(),
        receiptNotes: input.receiptNotes?.trim() || null,
        inspectionRequired,
        createdById: user.id,
        items: { create: lines },
      },
    });

    // The SRN is the return's own number: a second number for the same piece of
    // paper is one more thing to reconcile and nothing to gain.
    await tx.employeeReturn.update({
      where: { id: ret.id },
      data: { srnNumber: ret.number },
    });

    await writeAudit(
      {
        entityType: "EmployeeReturn",
        entityId: ret.id,
        entityRef: ret.number,
        action: "EMPLOYEE_RETURN_RECEIVED",
        newValue: {
          from: input.returnedByName.trim(),
          store: store.name,
          lines: lines.length,
          inspectionRequired,
        },
        reason: input.receiptNotes?.trim() ?? null,
        actor: user,
      },
      tx,
    );

    if (inspectionRequired) {
      await createTask(
        {
          title: `Inspect returned IT equipment — ${ret.number}`,
          description: `${input.returnedByName.trim()} · ${store.name} · ${lines.length} line(s)`,
          taskType: "INSPECTION",
          assignedRoleCode: "IT_USER",
          entityId: store.entityId,
          documentType: "EMPLOYEE_RETURN",
          documentId: ret.id,
          documentRef: ret.number,
          priority: "NORMAL",
          linkUrl: `/inventory/returns/${ret.id}`,
        },
        tx,
      );
    }
    return ret;
  });
}

/**
 * Records the IT inspection — the conditional step in the SOP's flow.
 *
 * Per line, because one return holds a working monitor and a dead laptop, and a
 * single verdict over both would send the monitor to repair or the laptop to the
 * shelf.
 */
export async function inspectEmployeeReturn(
  user: SessionUser,
  input: {
    returnId: string;
    lines: Array<{ lineId: string; verdict: "PASS" | "FAIL"; notes?: string | null }>;
    notes?: string | null;
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.INSPECTION_PERFORM, P.RECEIVE_GOODS)) {
      throw new RuleViolationError("You do not have permission to inspect returned equipment.");
    }
    const ret = await tx.employeeReturn.findUnique({
      where: { id: input.returnId },
      include: { items: true, store: { select: { name: true, entityId: true } } },
    });
    if (!ret) throw new NotFoundError("Employee return");
    if (!ret.inspectionRequired) {
      throw new RuleViolationError(
        `${ret.number} holds no IT equipment. The SOP inspects IT equipment only, so there is nothing here to inspect.`,
      );
    }
    if (!["PENDING_INSPECTION", "INSPECTION_FAILED"].includes(ret.status)) {
      throw new RuleViolationError(`${ret.number} is ${ret.status.replace(/_/g, " ").toLowerCase()}.`);
    }

    const byId = new Map(ret.items.map((i) => [i.id, i]));
    for (const entry of input.lines) {
      const line = byId.get(entry.lineId);
      if (!line) throw new ValidationError("An inspected line does not belong to this return.");
      if (!["PASS", "FAIL"].includes(entry.verdict)) {
        throw new ValidationError(`Line ${line.lineNo}: say whether it passed or failed.`);
      }
      if (entry.verdict === "FAIL" && !entry.notes?.trim()) {
        throw new ValidationError(
          `Line ${line.lineNo}: say what failed. Repair and Maintenance need to know what they are being sent.`,
        );
      }
      await tx.employeeReturnItem.update({
        where: { id: line.id },
        data: {
          inspectionVerdict: entry.verdict,
          // A failure goes to Repair and Maintenance; a pass is stacked. Set
          // here so the disposition follows the verdict rather than being a
          // second, separate decision somebody might make differently.
          disposition: entry.verdict === "FAIL" ? "REPAIR" : "STACK",
          dispositionNote: entry.notes?.trim() || null,
        },
      });
    }

    const after = await tx.employeeReturnItem.findMany({ where: { returnId: ret.id } });
    const pending = after.filter((i) => i.inspectionVerdict === null);
    const failed = after.filter((i) => i.inspectionVerdict === "FAIL");

    const status = pending.length
      ? "PENDING_INSPECTION"
      : failed.length
        ? "INSPECTION_FAILED"
        : "ACCEPTED";

    const updated = await tx.employeeReturn.update({
      where: { id: ret.id },
      data: {
        status,
        inspectedById: user.id,
        inspectedAt: new Date(),
        inspectionResult: failed.length ? "FAILED" : pending.length ? "PARTIAL" : "PASSED",
        inspectionNotes: input.notes?.trim() || null,
      },
    });

    if (!pending.length) await completeTasks("EMPLOYEE_RETURN", ret.id, user.id, tx);

    if (failed.length && !pending.length) {
      await notify(
        {
          roleCodes: ["IT_USER", "ADMIN_FLOOR_MANAGER", "STORE_MANAGER"],
          entityId: ret.store.entityId,
          type: "GENERAL",
          priority: "NORMAL",
          title: `${ret.number} — ${failed.length} unit${failed.length === 1 ? "" : "s"} for Repair and Maintenance`,
          body: `Returned by ${ret.returnedByName}. Failed units do not go back on the shelf.`,
          linkType: "EMPLOYEE_RETURN",
          linkId: ret.id,
          linkUrl: `/inventory/returns/${ret.id}`,
        },
        tx,
      );
    }

    await writeAudit(
      {
        entityType: "EmployeeReturn",
        entityId: ret.id,
        entityRef: ret.number,
        action: "EMPLOYEE_RETURN_INSPECTED",
        newValue: { passed: after.length - failed.length - pending.length, failed: failed.length },
        reason: input.notes?.trim() ?? null,
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/** Records the hand-off of failed units to Repair and Maintenance. */
export async function handOffToRepair(
  user: SessionUser,
  input: { returnId: string; reference: string; note?: string | null },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.RECEIVE_GOODS, P.STORE_ISSUE, P.INVENTORY_ADJUST)) {
      throw new RuleViolationError("You do not have permission to hand off returned equipment.");
    }
    if (!input.reference?.trim()) {
      throw new ValidationError(
        "Record the reference Repair and Maintenance gave. A hand-off with no reference cannot be chased.",
      );
    }
    const ret = await tx.employeeReturn.findUnique({
      where: { id: input.returnId },
      include: { items: true },
    });
    if (!ret) throw new NotFoundError("Employee return");

    const forRepair = ret.items.filter((i) => i.disposition === "REPAIR");
    if (!forRepair.length) {
      throw new RuleViolationError(`Nothing on ${ret.number} is going to Repair and Maintenance.`);
    }

    const updated = await tx.employeeReturn.update({
      where: { id: ret.id },
      data: {
        status: "AT_REPAIR",
        repairHandoffAt: new Date(),
        repairHandoffRef: input.reference.trim(),
        repairHandoffNote: input.note?.trim() || null,
      },
    });
    await writeAudit(
      {
        entityType: "EmployeeReturn",
        entityId: ret.id,
        entityRef: ret.number,
        action: "EMPLOYEE_RETURN_TO_REPAIR",
        newValue: { units: forRepair.length, reference: input.reference.trim() },
        reason: input.note?.trim() ?? null,
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/**
 * Takes the accepted units back into stock — the SOP's "Stacking & Inventory".
 *
 * Only lines dispositioned `STACK` produce a movement. A unit at repair is not
 * usable stock, and counting it as though it were is the difference between an
 * inventory figure and a pile of things in a corner.
 *
 * Asset lines move custody back to the store rather than posting a quantity: a
 * tagged asset is one identified thing, not a quantity of something.
 */
export async function stackEmployeeReturn(
  user: SessionUser,
  returnId: string,
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.INVENTORY_ADJUST, P.RECEIVE_GOODS)) {
      throw new RuleViolationError("Taking stock back in needs receiving or adjustment authority.");
    }
    const ret = await tx.employeeReturn.findUnique({
      where: { id: returnId },
      include: { items: true, store: { select: { id: true, name: true, entityId: true } } },
    });
    if (!ret) throw new NotFoundError("Employee return");
    if (["CLOSED", "CANCELLED"].includes(ret.status)) {
      throw new RuleViolationError(`${ret.number} is already ${ret.status.toLowerCase()}.`);
    }
    if (ret.inspectionRequired && ret.items.some((i) => i.inspectionVerdict === null)) {
      throw new RuleViolationError(
        `${ret.number} holds IT equipment that has not been inspected. The SOP inspects before stacking, not after.`,
      );
    }

    const toStack = ret.items.filter((i) => i.disposition === "STACK" && !i.movementTxnId);
    let posted = 0;
    let custody = 0;

    for (const line of toStack) {
      if (line.assetId) {
        // A tagged asset comes back to the store as custody, not as a quantity.
        const asset = await tx.asset.findUnique({ where: { id: line.assetId } });
        if (asset) {
          await tx.asset.update({
            where: { id: asset.id },
            data: { status: "IN_STORAGE", custodianId: null, location: ret.store.name },
          });
          await tx.assetTransaction.create({
            data: {
              assetId: asset.id,
              type: "RETURNED",
              fromStatus: asset.status,
              toStatus: "IN_STORAGE",
              fromCustodianId: asset.custodianId,
              toCustodianId: null,
              fromLocation: asset.location,
              toLocation: ret.store.name,
              reference: ret.number,
              performedById: user.id,
            },
          });
          custody += 1;
        }
        continue;
      }
      if (!line.itemId) continue;

      const txn = await postMovement(
        "RETURN",
        {
          itemId: line.itemId,
          storeId: ret.store.id,
          quantity: line.quantity,
          unit: line.unit,
          serialNumber: line.serialNumber,
          entityId: ret.store.entityId,
          source: { kind: "ADJUSTMENT", id: ret.id, ref: ret.number },
          reason: `Employee return ${ret.number} from ${ret.returnedByName} — ${line.description}`,
          performedById: user.id,
        },
        tx,
        user,
        // Follows from an accepted return, and the receiving permission behind
        // it is re-verified rather than assumed.
        { cascade: `accepted employee return ${ret.number}`, from: [P.RECEIVE_GOODS, P.INVENTORY_ADJUST] },
      );
      await tx.employeeReturnItem.update({
        where: { id: line.id },
        data: { movementTxnId: txn.id },
      });
      posted += 1;
    }

    const stillAtRepair = ret.items.some((i) => i.disposition === "REPAIR");
    const updated = await tx.employeeReturn.update({
      where: { id: ret.id },
      data: {
        status: stillAtRepair && ret.status === "AT_REPAIR" ? "AT_REPAIR" : "STACKED",
        stackedAt: new Date(),
      },
    });

    await writeAudit(
      {
        entityType: "EmployeeReturn",
        entityId: ret.id,
        entityRef: ret.number,
        action: "EMPLOYEE_RETURN_STACKED",
        newValue: { movements: posted, assetsReturned: custody, store: ret.store.name },
        actor: user,
      },
      tx,
    );
    return { return: updated, posted, custody };
  });
}

/** Sets a line's disposition where no inspection decided it. */
export async function setDisposition(
  user: SessionUser,
  input: { returnId: string; lineId: string; disposition: Disposition; note?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.RECEIVE_GOODS, P.STORE_ISSUE, P.INVENTORY_ADJUST)) {
    throw new RuleViolationError("You do not have permission to disposition a returned line.");
  }
  if (!DISPOSITIONS.includes(input.disposition)) {
    throw new ValidationError("That is not a recognised disposition.");
  }
  if (input.disposition !== "STACK" && !input.note?.trim()) {
    throw new ValidationError(
      "Say why this is not going back on the shelf. Anything other than stacking is a decision somebody should be able to read back.",
    );
  }

  const line = await db.employeeReturnItem.findUnique({
    where: { id: input.lineId },
    include: { return: { select: { id: true, number: true, status: true } } },
  });
  if (!line || line.return.id !== input.returnId) throw new NotFoundError("Return line");
  if (["CLOSED", "CANCELLED", "STACKED"].includes(line.return.status)) {
    throw new RuleViolationError(`${line.return.number} is ${line.return.status.toLowerCase()}.`);
  }
  if (line.movementTxnId) {
    throw new RuleViolationError(
      `Line ${line.lineNo} is already back in stock. Adjust the ledger rather than changing the return.`,
    );
  }

  const row = await db.employeeReturnItem.update({
    where: { id: line.id },
    data: { disposition: input.disposition, dispositionNote: input.note?.trim() || null },
  });
  await writeAudit(
    {
      entityType: "EmployeeReturn",
      entityId: line.return.id,
      entityRef: line.return.number,
      action: "EMPLOYEE_RETURN_DISPOSITION",
      newValue: { line: line.lineNo, disposition: input.disposition },
      reason: input.note?.trim() ?? null,
      actor: user,
    },
    db,
  );
  return row;
}

export async function closeEmployeeReturn(
  user: SessionUser,
  input: { returnId: string; cancel?: boolean; reason?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.RECEIVE_GOODS, P.STORE_ISSUE, P.INVENTORY_ADJUST)) {
    throw new RuleViolationError("You do not have permission to close a return.");
  }
  if (input.cancel && !input.reason?.trim()) {
    throw new ValidationError("State why the return is being cancelled.");
  }
  const ret = await db.employeeReturn.findUnique({ where: { id: input.returnId } });
  if (!ret) throw new NotFoundError("Employee return");
  if (["CLOSED", "CANCELLED"].includes(ret.status)) {
    throw new RuleViolationError(`${ret.number} is already ${ret.status.toLowerCase()}.`);
  }

  const updated = await db.employeeReturn.update({
    where: { id: ret.id },
    data: { status: input.cancel ? "CANCELLED" : "CLOSED", closedAt: new Date() },
  });
  await writeAudit(
    {
      entityType: "EmployeeReturn",
      entityId: ret.id,
      entityRef: ret.number,
      action: input.cancel ? "EMPLOYEE_RETURN_CANCELLED" : "EMPLOYEE_RETURN_CLOSED",
      reason: input.reason?.trim() ?? null,
      actor: user,
    },
    db,
  );
  return updated;
}

export async function listEmployeeReturns(
  filter: { entityIds?: string[] | null; storeId?: string | null; status?: string | null } = {},
  db: DbClient = prisma,
) {
  return db.employeeReturn.findMany({
    where: {
      ...(filter.entityIds ? { entityId: { in: filter.entityIds } } : {}),
      ...(filter.storeId ? { storeId: filter.storeId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    include: {
      store: { select: { name: true } },
      receivedBy: { select: { name: true } },
      inspectedBy: { select: { name: true } },
      _count: { select: { items: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
}

export async function employeeReturnDetail(id: string, db: DbClient = prisma) {
  return db.employeeReturn.findUnique({
    where: { id },
    include: {
      store: { select: { id: true, name: true } },
      receivedBy: { select: { name: true, title: true } },
      inspectedBy: { select: { name: true, title: true } },
      createdBy: { select: { name: true } },
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
