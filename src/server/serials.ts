import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { round2 } from "@/lib/format";

/**
 * Serialised units.
 *
 * Ten laptops received is ten machines. Each has its own serial, its own
 * custodian and its own history — which laptop went to whom, which one came back
 * broken, which one was capitalised and which was written off.
 *
 * Holding that as a comma-joined string on a receipt line gave the tenth laptop
 * no identity. It could not be issued individually, its custodian could not be
 * recorded, and nothing prevented the same serial being received twice — which
 * is the failure that matters, because a duplicate serial means two records
 * claiming to be one physical thing and no way to tell which is real.
 *
 * The uniqueness constraint is per item rather than global, deliberately. Two
 * manufacturers reusing the same string is their business; a single item having
 * two units with one serial is an error in ours.
 */

export const SERIAL_STATUSES = [
  "IN_STOCK",
  "ISSUED",
  "WITH_EMPLOYEE",
  "IN_REPAIR",
  "RETURNED_TO_VENDOR",
  "CAPITALISED",
  "DISPOSED",
  "LOST",
] as const;

export type SerialStatus = (typeof SERIAL_STATUSES)[number];

/** Statuses in which a unit is still the company's to account for. */
const LIVE_STATUSES: SerialStatus[] = [
  "IN_STOCK",
  "ISSUED",
  "WITH_EMPLOYEE",
  "IN_REPAIR",
  "CAPITALISED",
];

/**
 * Splits what the receiver typed into serials.
 *
 * Accepts commas, semicolons, newlines and runs of whitespace, because a person
 * pasting ten serials from a delivery note will use whichever of those the note
 * used. Blanks are dropped; case and surrounding space are normalised, so
 * "ABC123 " and "abc123" are recognised as the same unit rather than becoming
 * two.
 */
export function parseSerials(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[\n,;]+|\s{2,}/)
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

/**
 * Checks a set of serials before anything is written.
 *
 * Returns every problem at once rather than the first, because somebody pasting
 * ten serials wants to fix all the bad ones in one pass.
 */
export async function checkSerials(
  itemId: string,
  serials: string[],
  expectedCount: number | null,
  db: DbClient = prisma,
): Promise<{ ok: boolean; problems: string[]; duplicatesInInput: string[]; alreadyHeld: string[] }> {
  const problems: string[] = [];

  // A duplicate within one paste is almost always a typo or a double-paste.
  const seen = new Map<string, number>();
  for (const s of serials) seen.set(s, (seen.get(s) ?? 0) + 1);
  const duplicatesInInput = [...seen.entries()].filter(([, n]) => n > 1).map(([s]) => s);
  if (duplicatesInInput.length) {
    problems.push(
      `These serials appear more than once in what was entered: ${duplicatesInInput.join(", ")}.`,
    );
  }

  const existing = serials.length
    ? await db.serialUnit.findMany({
        where: { itemId, serial: { in: serials }, status: { in: LIVE_STATUSES } },
        select: { serial: true, status: true, store: { select: { name: true } } },
      })
    : [];
  const alreadyHeld = existing.map((e) => e.serial);
  if (existing.length) {
    problems.push(
      `Already recorded against this item: ${existing
        .map(
          (e) =>
            `${e.serial} (${e.status.replace(/_/g, " ").toLowerCase()}${e.store ? ` at ${e.store.name}` : ""})`,
        )
        .join(", ")}. A serial identifies one physical unit, so it cannot be received twice.`,
    );
  }

  if (expectedCount !== null && serials.length !== expectedCount) {
    problems.push(
      `${serials.length} serial${serials.length === 1 ? "" : "s"} entered for ${expectedCount} unit${expectedCount === 1 ? "" : "s"} accepted. A serialised item needs one serial per unit.`,
    );
  }

  return { ok: problems.length === 0, problems, duplicatesInInput, alreadyHeld };
}

export type RegisterSerialsInput = {
  itemId: string;
  serials: string[];
  grnId?: string | null;
  grnItemId?: string | null;
  poId?: string | null;
  vendorId?: string | null;
  storeId?: string | null;
  storeLocationId?: string | null;
  unitCost?: number;
  warrantyMonths?: number | null;
  expiryDate?: Date | null;
  batchNumber?: string | null;
};

/**
 * Creates one unit per serial, with its first history row.
 *
 * Called from receipt posting, inside that transaction, so serials either all
 * exist or none do — a half-registered delivery is worse than an unregistered
 * one, because it looks complete.
 */
export async function registerSerials(
  user: SessionUser,
  input: RegisterSerialsInput,
  db: DbClient = prisma,
) {
  if (!input.serials.length) return [];

  const check = await checkSerials(input.itemId, input.serials, null, db);
  if (!check.ok) throw new RuleViolationError(check.problems.join(" "));

  const warrantyEnd =
    input.warrantyMonths && input.warrantyMonths > 0
      ? new Date(new Date().setMonth(new Date().getMonth() + input.warrantyMonths))
      : null;

  const created = [];
  for (const serial of input.serials) {
    const unit = await db.serialUnit.create({
      data: {
        serial,
        itemId: input.itemId,
        grnId: input.grnId ?? null,
        grnItemId: input.grnItemId ?? null,
        poId: input.poId ?? null,
        vendorId: input.vendorId ?? null,
        storeId: input.storeId ?? null,
        storeLocationId: input.storeLocationId ?? null,
        unitCost: round2(input.unitCost ?? 0),
        warrantyMonths: input.warrantyMonths ?? null,
        warrantyEnd,
        expiryDate: input.expiryDate ?? null,
        batchNumber: input.batchNumber ?? null,
        status: "IN_STOCK",
      },
    });
    await db.serialMovement.create({
      data: {
        serialUnitId: unit.id,
        event: "RECEIVED",
        toStatus: "IN_STOCK",
        toStoreId: input.storeId ?? null,
        documentType: input.grnId ? "GRN" : null,
        documentId: input.grnId ?? null,
        performedById: user.id,
      },
    });
    created.push(unit);
  }

  await writeAudit(
    {
      entityType: "SerialUnit",
      entityId: input.grnId ?? input.itemId,
      entityRef: null,
      action: "SERIALS_REGISTERED",
      newValue: { itemId: input.itemId, count: created.length, serials: input.serials },
      actor: user,
    },
    db,
  );

  return created;
}

/**
 * Moves one unit, recording what happened rather than only where it ended up.
 *
 * The history is the point: "which laptop did we give to whom, and when did it
 * come back" is a question about events, and a current-status column cannot
 * answer it.
 */
export async function moveSerial(
  user: SessionUser,
  input: {
    serialUnitId: string;
    event:
      | "STORED"
      | "ISSUED"
      | "RETURNED"
      | "SENT_FOR_REPAIR"
      | "REPAIRED"
      | "CAPITALISED"
      | "DISPOSED"
      | "LOST"
      | "TRANSFERRED";
    toStatus: SerialStatus;
    toStoreId?: string | null;
    toCustodianId?: string | null;
    assetId?: string | null;
    reference?: string | null;
    documentType?: string | null;
    documentId?: string | null;
    remarks?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.INVENTORY_ADJUST, P.STORE_ISSUE, P.ASSET_MANAGE)) {
    throw new RuleViolationError("You do not have permission to move serialised units.");
  }

  return withTransaction(db, async (tx) => {
    const unit = await tx.serialUnit.findUnique({
      where: { id: input.serialUnitId },
      include: { item: { select: { name: true, sku: true } } },
    });
    if (!unit) throw new NotFoundError("Serialised unit");

    // A unit that has left for good does not come back through a status change.
    if (["DISPOSED", "RETURNED_TO_VENDOR"].includes(unit.status)) {
      throw new RuleViolationError(
        `${unit.serial} is ${unit.status.replace(/_/g, " ").toLowerCase()} — it is no longer in the company's hands, so it cannot be moved. Reverse the disposal or the return first.`,
      );
    }
    if (input.event === "ISSUED" && !input.toCustodianId) {
      throw new ValidationError("Issuing a serialised unit needs the person taking it.");
    }

    const updated = await tx.serialUnit.update({
      where: { id: unit.id },
      data: {
        status: input.toStatus,
        storeId: input.toStoreId ?? unit.storeId,
        custodianId:
          input.toCustodianId ?? (input.event === "RETURNED" ? null : unit.custodianId),
        assetId: input.assetId ?? unit.assetId,
      },
    });

    await tx.serialMovement.create({
      data: {
        serialUnitId: unit.id,
        event: input.event,
        fromStatus: unit.status,
        toStatus: input.toStatus,
        fromStoreId: unit.storeId,
        toStoreId: input.toStoreId ?? unit.storeId,
        fromCustodianId: unit.custodianId,
        toCustodianId: input.toCustodianId ?? null,
        reference: input.reference ?? null,
        documentType: input.documentType ?? null,
        documentId: input.documentId ?? null,
        performedById: user.id,
        remarks: input.remarks ?? null,
      },
    });

    await writeAudit(
      {
        entityType: "SerialUnit",
        entityId: unit.id,
        entityRef: `${unit.item.sku} ${unit.serial}`,
        action: `SERIAL_${input.event}`,
        changes: { status: { from: unit.status, to: input.toStatus } },
        reason: input.remarks ?? null,
        actor: user,
      },
      tx,
    );

    return updated;
  });
}

/** One unit's whole life, for the page that shows it. */
export async function serialHistory(serialUnitId: string, db: DbClient = prisma) {
  return db.serialUnit.findUnique({
    where: { id: serialUnitId },
    include: {
      item: { select: { sku: true, name: true, unit: true } },
      store: { select: { name: true } },
      custodian: { select: { name: true } },
      vendor: { select: { name: true } },
      grn: { select: { id: true, number: true } },
      po: { select: { id: true, number: true } },
      asset: { select: { id: true, tag: true } },
      movements: {
        orderBy: { performedAt: "asc" },
        include: { performedBy: { select: { name: true } } },
      },
    },
  });
}

/** Finds a unit by its serial, which is how somebody holding the thing searches. */
export async function findBySerial(serial: string, db: DbClient = prisma) {
  return db.serialUnit.findMany({
    where: { serial: { contains: serial.trim().toUpperCase() } },
    take: 25,
    include: {
      item: { select: { sku: true, name: true } },
      store: { select: { name: true } },
      custodian: { select: { name: true } },
    },
    orderBy: { receivedAt: "desc" },
  });
}
