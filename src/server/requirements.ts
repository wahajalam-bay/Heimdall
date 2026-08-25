import { prisma, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { round2 } from "@/lib/format";
import { CONFIG_KEYS, getConfigBool, getConfigNumber, getConfig } from "@/lib/config";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { freeQuantity, releaseFor, reserveStock } from "./reservations";

/**
 * The demand layer.
 *
 * A department states what it needs, and the system decides whether stock can
 * meet it before anybody is allowed to buy. That ordering is the whole point: a
 * requirement is not a purchase requisition, and it only becomes one for the
 * quantity no store can supply.
 *
 * The availability figures are written onto the requirement line at the moment
 * the decision is taken. They are deliberately not recomputed on later reads —
 * six months on, nobody can explain why a purchase was allowed if the only
 * available number is today's stock position.
 */

/* ── Availability ─────────────────────────────────────────── */

export type StoreAvailability = {
  storeId: string;
  storeCode: string;
  storeName: string;
  siteName: string | null;
  physical: number;
  reserved: number;
  available: number;
  /** True for the store that serves the requesting site. */
  isPrimary: boolean;
};

export type AvailabilityLine = {
  requirementItemId: string;
  lineNo: number;
  itemId: string | null;
  sku: string | null;
  description: string;
  unit: string;
  quantity: number;
  stores: StoreAvailability[];
  /** Free stock in the store that serves the requester. */
  primaryAvailable: number;
  /** Free stock in every other eligible store. */
  elsewhereAvailable: number;
  /** What the rules would do with this line. */
  suggestion: "STOCK" | "SPLIT" | "PROCURE";
  fromStockQty: number;
  procureQty: number;
  sourceStoreId: string | null;
};

export type AvailabilityResult = {
  lines: AvailabilityLine[];
  mode: "SPLIT" | "ALL_TO_PROCUREMENT";
  crossStoreEnabled: boolean;
  radiusKm: number;
  /** True when at least one line can be met, wholly or partly, from stock. */
  anyStock: boolean;
  /** True when at least one line has a quantity nothing can cover. */
  anyShortfall: boolean;
};

/** Stores a requirement may draw on: its own first, then the eligible rest. */
async function eligibleStores(
  requirement: { entityId: string; storeId: string | null; siteId: string | null },
  crossStore: boolean,
  db: DbClient,
) {
  const stores = await db.store.findMany({
    where: { active: true, entityId: requirement.entityId },
    select: { id: true, code: true, name: true, siteId: true, site: { select: { name: true } } },
    orderBy: { code: "asc" },
  });

  const primaryId =
    requirement.storeId ??
    stores.find((s) => requirement.siteId && s.siteId === requirement.siteId)?.id ??
    stores[0]?.id ??
    null;

  // Without cross-store fulfilment the search stops at the requester's own store.
  const usable = crossStore ? stores : stores.filter((s) => s.id === primaryId);
  return { stores: usable, primaryId };
}

/**
 * Reads the position for every line of a requirement.
 *
 * The geographic radius from the specification is not yet an agreed number, so
 * the setting exists and defaults to nought, which means "every store in the
 * entity the reader can see". When a radius is agreed, this is the one place
 * that changes.
 */
export async function checkAvailability(
  requirementId: string,
  db: DbClient = prisma,
): Promise<AvailabilityResult> {
  const requirement = await db.requirement.findUnique({
    where: { id: requirementId },
    include: { items: { orderBy: { lineNo: "asc" }, include: { item: { select: { sku: true } } } } },
  });
  if (!requirement) throw new NotFoundError("Requirement");

  const [mode, crossStoreEnabled, radiusKm] = await Promise.all([
    getConfig<string>(CONFIG_KEYS.PARTIAL_AVAILABILITY_MODE, requirement.entityId, db),
    getConfigBool(CONFIG_KEYS.CROSS_STORE_ENABLED, requirement.entityId, db),
    getConfigNumber(CONFIG_KEYS.CROSS_STORE_RADIUS_KM, requirement.entityId, db),
  ]);
  const splitMode = mode === "ALL_TO_PROCUREMENT" ? "ALL_TO_PROCUREMENT" : "SPLIT";

  const { stores, primaryId } = await eligibleStores(requirement, crossStoreEnabled, db);

  // The whole position in one read. Availability is summed per item and store
  // here rather than asked for a line at a time, because the line-by-line version
  // cost one round trip per line per store.
  const itemIds = requirement.items.map((i) => i.itemId).filter((v): v is string => Boolean(v));
  const buckets = itemIds.length
    ? await db.inventoryItem.findMany({
        where: { itemId: { in: itemIds }, storeId: { in: stores.map((s) => s.id) } },
        select: { itemId: true, storeId: true, quantity: true, reservedQty: true },
      })
    : [];
  const position = new Map<string, { physical: number; reserved: number }>();
  for (const b of buckets) {
    const key = `${b.itemId}|${b.storeId}`;
    const cur = position.get(key) ?? { physical: 0, reserved: 0 };
    cur.physical += b.quantity;
    cur.reserved += b.reservedQty;
    position.set(key, cur);
  }

  const lines: AvailabilityLine[] = [];
  for (const line of requirement.items) {
    const perStore: StoreAvailability[] = [];
    if (line.itemId) {
      for (const store of stores) {
        const held = position.get(`${line.itemId}|${store.id}`) ?? { physical: 0, reserved: 0 };
        const q = {
          physical: round2(held.physical),
          reserved: round2(held.reserved),
          available: round2(held.physical - held.reserved),
        };
        if (q.physical <= 0 && store.id !== primaryId) continue;
        perStore.push({
          storeId: store.id,
          storeCode: store.code,
          storeName: store.name,
          siteName: store.site?.name ?? null,
          physical: q.physical,
          reserved: q.reserved,
          available: q.available,
          isPrimary: store.id === primaryId,
        });
      }
    }

    const primary = perStore.find((s) => s.isPrimary);
    const primaryAvailable = primary?.available ?? 0;
    const elsewhere = perStore.filter((s) => !s.isPrimary);
    const elsewhereAvailable = round2(elsewhere.reduce((a, s) => a + s.available, 0));

    // Own store first — drawing on somebody else's shelf needs approval, so it
    // is never the cheaper option even when the quantity is there.
    const bestOther = elsewhere.slice().sort((a, b) => b.available - a.available)[0] ?? null;
    const coverable = round2(Math.min(line.quantity, primaryAvailable + elsewhereAvailable));

    let fromStockQty = 0;
    let procureQty = line.quantity;
    let sourceStoreId: string | null = null;

    if (coverable >= line.quantity - 1e-9 && line.quantity > 0) {
      // Fully coverable: stock wins outright.
      fromStockQty = line.quantity;
      procureQty = 0;
      sourceStoreId = primaryAvailable >= line.quantity - 1e-9 ? (primary?.storeId ?? null) : (bestOther?.storeId ?? null);
    } else if (coverable > 0 && splitMode === "SPLIT") {
      fromStockQty = coverable;
      procureQty = round2(line.quantity - coverable);
      sourceStoreId = primaryAvailable > 0 ? (primary?.storeId ?? null) : (bestOther?.storeId ?? null);
    }

    lines.push({
      requirementItemId: line.id,
      lineNo: line.lineNo,
      itemId: line.itemId,
      sku: line.item?.sku ?? null,
      description: line.description,
      unit: line.unit,
      quantity: line.quantity,
      stores: perStore,
      primaryAvailable,
      elsewhereAvailable,
      suggestion: procureQty <= 0 ? "STOCK" : fromStockQty > 0 ? "SPLIT" : "PROCURE",
      fromStockQty,
      procureQty,
      sourceStoreId,
    });
  }

  return {
    lines,
    mode: splitMode,
    crossStoreEnabled,
    radiusKm,
    anyStock: lines.some((l) => l.fromStockQty > 0),
    anyShortfall: lines.some((l) => l.procureQty > 0),
  };
}

/** Runs the check and records the snapshot against each line. */
export async function runStockCheck(user: SessionUser, requirementId: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.REQUIREMENT_CHECK_STOCK, P.REQUIREMENT_DECIDE)) {
    throw new ForbiddenError("You do not have permission to run the availability check.");
  }
  const result = await checkAvailability(requirementId, db);

  // Independent row writes, so they go together rather than one after another.
  // A partial write is not a hazard here: re-running the check rewrites it.
  await Promise.all([
    ...result.lines.map((line) => {
      const primary = line.stores.find((s) => s.isPrimary);
      return db.requirementItem.update({
        where: { id: line.requirementItemId },
        data: {
          physicalQty: round2(line.stores.reduce((a, s) => a + s.physical, 0)),
          reservedQty: round2(line.stores.reduce((a, s) => a + s.reserved, 0)),
          availableQty: round2(primary ? primary.available + line.elsewhereAvailable : line.elsewhereAvailable),
          fromStockQty: line.fromStockQty,
          procureQty: line.procureQty,
          sourceStoreId: line.sourceStoreId,
        },
      });
    }),
    db.requirement.update({
      where: { id: requirementId },
      data: { status: "CHECKING_STOCK", checkedAt: new Date() },
    }),
  ]);

  await writeAudit({
      entityType: "Requirement",
      entityId: requirementId,
      action: "STOCK_CHECKED",
      actor: user,
      reason: `${result.lines.filter((l) => l.fromStockQty > 0).length} of ${result.lines.length} line(s) can be met from stock.`,
    }, db);

  return result;
}

/* ── Creating a requirement ───────────────────────────────── */

export type RequirementLineInput = {
  itemId?: string | null;
  categoryId?: string | null;
  description: string;
  specification?: string | null;
  quantity: number;
  unit: string;
  estimatedUnitCost?: number | null;
};

export async function createRequirement(
  user: SessionUser,
  input: {
    entityId: string;
    departmentId: string;
    title: string;
    purpose?: string | null;
    justification?: string | null;
    priority?: string;
    requiredDate: Date;
    siteId?: string | null;
    projectId?: string | null;
    storeId?: string | null;
    costCenter?: string | null;
    costCenterId?: string | null;
    expenditureType?: string;
    items: RequirementLineInput[];
    submit?: boolean;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.REQUIREMENT_CREATE)) {
    throw new ForbiddenError("You do not have permission to raise requirements.");
  }
  if (!input.items.length) throw new ValidationError("Add at least one line to the requirement.");
  for (const line of input.items) {
    if (line.quantity <= 0) throw new ValidationError("Every line needs a quantity greater than zero.");
    if (!line.description.trim()) throw new ValidationError("Every line needs a description.");
  }

  const number = await nextNumber(SEQ.REQUIREMENT, db);
  const estimated = round2(
    input.items.reduce((a, l) => a + (l.estimatedUnitCost ?? 0) * l.quantity, 0),
  );

  const requirement = await db.requirement.create({
    data: {
      number,
      entityId: input.entityId,
      departmentId: input.departmentId,
      requesterId: user.id,
      title: input.title.trim(),
      purpose: input.purpose ?? null,
      justification: input.justification ?? null,
      priority: input.priority ?? "NORMAL",
      requiredDate: input.requiredDate,
      siteId: input.siteId ?? null,
      projectId: input.projectId ?? null,
      storeId: input.storeId ?? null,
      costCenter: input.costCenter ?? null,
      costCenterId: input.costCenterId ?? null,
      expenditureType: input.expenditureType === "CAPEX" ? "CAPEX" : "OPEX",
      estimatedValue: estimated,
      status: input.submit ? "SUBMITTED" : "DRAFT",
      submittedAt: input.submit ? new Date() : null,
      items: {
        create: input.items.map((l, i) => ({
          lineNo: i + 1,
          itemId: l.itemId ?? null,
          categoryId: l.categoryId ?? null,
          description: l.description.trim(),
          specification: l.specification ?? null,
          quantity: round2(l.quantity),
          unit: l.unit,
          estimatedUnitCost: l.estimatedUnitCost ?? null,
        })),
      },
    },
    include: { items: true },
  });

  await writeAudit({ entityType: "Requirement", entityId: requirement.id, action: "CREATED", actor: user, reason: number }, db);
  return requirement;
}

export async function submitRequirement(user: SessionUser, id: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.REQUIREMENT_SUBMIT)) {
    throw new ForbiddenError("You do not have permission to submit requirements.");
  }
  const requirement = await db.requirement.findUnique({ where: { id }, include: { items: true } });
  if (!requirement) throw new NotFoundError("Requirement");
  if (requirement.status !== "DRAFT") {
    throw new RuleViolationError("Only a draft requirement can be submitted.");
  }
  if (!requirement.items.length) throw new ValidationError("A requirement needs at least one line.");

  const updated = await db.requirement.update({
    where: { id },
    data: { status: "SUBMITTED", submittedAt: new Date() },
  });
  await writeAudit({ entityType: "Requirement", entityId: id, action: "SUBMITTED", actor: user }, db);
  return updated;
}

/* ── The fulfilment decision ──────────────────────────────── */

export type FulfilmentDecision = {
  /** Per line: how much comes off the shelf and how much gets bought. */
  lines: Array<{ requirementItemId: string; fromStockQty: number; procureQty: number; sourceStoreId?: string | null }>;
  /** Required when stock existed and procurement was chosen regardless. */
  note?: string | null;
};

export type FulfilmentOutcome = {
  requirementId: string;
  status: string;
  storeIssueId: string | null;
  storeIssueNumber: string | null;
  requisitionId: string | null;
  requisitionNumber: string | null;
  reservedLines: number;
};

/**
 * Splits a requirement into what the stores will issue and what procurement will
 * buy, and creates the two documents.
 *
 * The caller may override the suggested split — a storekeeper can see a reason
 * the arithmetic cannot — but overriding *downwards*, choosing to buy what is
 * already on the shelf, has to be explained. That note is the answer to the only
 * question an auditor ever asks about this screen.
 */
export async function decideFulfilment(
  user: SessionUser,
  requirementId: string,
  decision: FulfilmentDecision,
  db: DbClient = prisma,
): Promise<FulfilmentOutcome> {
  if (!userHasPermission(user, P.REQUIREMENT_DECIDE)) {
    throw new ForbiddenError("You do not have permission to decide how a requirement is met.");
  }

  const requirement = await db.requirement.findUnique({
    where: { id: requirementId },
    include: {
      items: { orderBy: { lineNo: "asc" }, include: { item: { select: { categoryId: true } } } },
      department: true,
    },
  });
  if (!requirement) throw new NotFoundError("Requirement");
  if (!["SUBMITTED", "CHECKING_STOCK"].includes(requirement.status)) {
    throw new RuleViolationError(`A requirement at ${requirement.status} cannot be decided.`);
  }

  const requireCheck = await getConfigBool(CONFIG_KEYS.REQUIRE_INVENTORY_CHECK, requirement.entityId, db);
  if (requireCheck && !requirement.checkedAt) {
    throw new RuleViolationError(
      "Stock must be checked before this requirement can be routed. Run the availability check first.",
    );
  }

  const live = await checkAvailability(requirementId, db);
  const byId = new Map(live.lines.map((l) => [l.requirementItemId, l]));
  const chosen = new Map(decision.lines.map((l) => [l.requirementItemId, l]));

  // A decision to buy what the shelf already holds is the one that needs saying.
  let overrodeStock = false;
  for (const line of requirement.items) {
    const suggested = byId.get(line.id);
    const picked = chosen.get(line.id);
    if (!suggested || !picked) continue;
    if (picked.fromStockQty + 1e-9 < suggested.fromStockQty) overrodeStock = true;
    if (picked.fromStockQty + picked.procureQty > line.quantity + 1e-9) {
      throw new ValidationError(
        `Line ${line.lineNo}: stock plus procurement (${round2(picked.fromStockQty + picked.procureQty)}) exceeds the ${line.quantity} required.`,
      );
    }
    if (picked.fromStockQty > suggested.fromStockQty + 1e-9) {
      throw new RuleViolationError(
        `Line ${line.lineNo}: only ${suggested.fromStockQty} ${line.unit} is unreserved; ${picked.fromStockQty} cannot be issued from stock.`,
      );
    }
  }
  if (overrodeStock && !decision.note?.trim()) {
    throw new ValidationError(
      "Stock is available for at least one line but procurement was chosen. Record why before continuing.",
    );
  }

  const stockLines = requirement.items
    .map((line) => ({ line, pick: chosen.get(line.id) }))
    .filter((x) => x.pick && x.pick.fromStockQty > 0);
  const buyLines = requirement.items
    .map((line) => ({ line, pick: chosen.get(line.id) }))
    .filter((x) => x.pick && x.pick.procureQty > 0);

  if (!stockLines.length && !buyLines.length) {
    throw new ValidationError("Nothing was allocated. Give every line a stock or procurement quantity.");
  }

  /** A requisition line cannot exist without a category, so this refuses rather than guessing. */
  const categoryFor = (line: (typeof requirement.items)[number]) => {
    const id = line.categoryId ?? line.item?.categoryId ?? null;
    if (!id) {
      throw new ValidationError(
        `Line ${line.lineNo} ("${line.description}") has no category. Pick a catalogue item or set a category before routing this to procurement.`,
      );
    }
    return id;
  };

  const reserveOnDecision = await getConfigBool(CONFIG_KEYS.RESERVE_ON_DECISION, requirement.entityId, db);
  const expiryDays = await getConfigNumber(CONFIG_KEYS.RESERVATION_EXPIRY_DAYS, requirement.entityId, db);
  const requireHod = await getConfigBool(CONFIG_KEYS.SR_REQUIRE_HOD, requirement.entityId, db);

  let storeIssueId: string | null = null;
  let storeIssueNumber: string | null = null;
  let reservedLines = 0;

  /* ── Store requisition for the quantity on the shelf ── */
  if (stockLines.length) {
    // Every line issued from one store keeps the requisition simple; a line
    // sourced elsewhere marks the whole document as cross-store, which is what
    // needs the extra approval.
    const sourceIds = new Set(
      stockLines.map((x) => x.pick!.sourceStoreId ?? byId.get(x.line.id)?.sourceStoreId ?? null).filter(Boolean),
    );
    const issuingStoreId =
      (requirement.storeId && sourceIds.has(requirement.storeId) ? requirement.storeId : null) ??
      ([...sourceIds][0] as string | undefined) ??
      requirement.storeId;
    if (!issuingStoreId) throw new ValidationError("No store could be determined to issue from.");

    const crossStore = issuingStoreId !== requirement.storeId && requirement.storeId !== null;
    const number = await nextNumber(SEQ.ISSUE, db);
    const issue = await db.storeIssue.create({
      data: {
        number,
        storeId: issuingStoreId,
        requestedById: user.id,
        recipientName: requirement.department.name,
        departmentId: requirement.departmentId,
        projectId: requirement.projectId,
        purpose: requirement.title,
        requirementId: requirement.id,
        sourceStoreId: crossStore ? issuingStoreId : null,
        status: crossStore
          ? "PENDING_CROSS_STORE_APPROVAL"
          : requireHod
            ? "PENDING_HOD_APPROVAL"
            : "PENDING_DEPARTMENT_APPROVAL",
        submittedAt: new Date(),
        remarks: `Raised from requirement ${requirement.number}.`,
        items: {
          create: stockLines.map((x, i) => ({
            lineNo: i + 1,
            itemId: x.line.itemId!,
            requestedQty: round2(x.pick!.fromStockQty),
            unit: x.line.unit,
            availableQty: byId.get(x.line.id)?.primaryAvailable ?? 0,
            requirementItemId: x.line.id,
            notes: x.line.specification ?? null,
          })),
        },
      },
    });
    storeIssueId = issue.id;
    storeIssueNumber = issue.number;

    if (reserveOnDecision) {
      const expiresAt = expiryDays > 0 ? new Date(Date.now() + expiryDays * 86400000) : null;
      for (const x of stockLines) {
        if (!x.line.itemId) continue;
        await reserveStock(
          {
            itemId: x.line.itemId,
            storeId: issuingStoreId,
            quantity: round2(x.pick!.fromStockQty),
            unit: x.line.unit,
            requirementItemId: x.line.id,
            storeIssueId: issue.id,
            reason: `Held for ${requirement.number} / ${issue.number}`,
            createdById: user.id,
            expiresAt,
          },
          db,
        );
        reservedLines += 1;
      }
    }

    await writeAudit({
        entityType: "StoreIssue",
        entityId: issue.id,
        action: "CREATED",
        actor: user,
        reason: `Store requisition ${issue.number} raised from requirement ${requirement.number}.`,
      }, db);
  }

  /* ── Purchase requisition for the shortfall ── */
  let requisitionId: string | null = null;
  let requisitionNumber: string | null = null;
  if (buyLines.length) {
    const prNumber = await nextNumber(SEQ.PR, db);
    const pr = await db.purchaseRequisition.create({
      data: {
        number: prNumber,
        entityId: requirement.entityId,
        departmentId: requirement.departmentId,
        requesterId: requirement.requesterId,
        procurementType: "ON_DEMAND",
        title: requirement.title,
        justification:
          requirement.justification ??
          `Raised from requirement ${requirement.number}: quantity not available in stock.`,
        projectId: requirement.projectId,
        siteId: requirement.siteId,
        costCenter: requirement.costCenter,
        costCenterId: requirement.costCenterId,
        expenditureType: requirement.expenditureType,
        deliveryStoreId: requirement.storeId,
        requiredDate: requirement.requiredDate,
        priority: requirement.priority,
        estimatedValue: round2(
          buyLines.reduce((a, x) => a + (x.line.estimatedUnitCost ?? 0) * x.pick!.procureQty, 0),
        ),
        requirementId: requirement.id,
        status: "SUBMITTED",
        submittedAt: new Date(),
        items: {
          create: buyLines.map((x, i) => ({
            lineNo: i + 1,
            itemId: x.line.itemId ?? null,
            categoryId: categoryFor(x.line),
            description: x.line.description,
            specification: x.line.specification ?? null,
            quantity: round2(x.pick!.procureQty),
            unit: x.line.unit,
            estimatedUnitPrice: x.line.estimatedUnitCost ?? null,
            estimatedTotal: round2((x.line.estimatedUnitCost ?? 0) * x.pick!.procureQty),
            requiredDate: requirement.requiredDate,
          })),
        },
      },
    });
    requisitionId = pr.id;
    requisitionNumber = pr.number;

    await writeAudit({
        entityType: "PurchaseRequisition",
        entityId: pr.id,
        action: "CREATED",
        actor: user,
        reason: `${pr.number} raised from requirement ${requirement.number} for the quantity stock could not meet.`,
      }, db);
  }

  const status =
    storeIssueId && requisitionId
      ? "SPLIT"
      : storeIssueId
        ? "FULFILLED_FROM_STOCK"
        : "SENT_TO_PROCUREMENT";

  await db.requirement.update({
    where: { id: requirementId },
    data: {
      status,
      decidedAt: new Date(),
      decidedById: user.id,
      decisionNote: decision.note?.trim() || null,
    },
  });

  for (const line of requirement.items) {
    const pick = chosen.get(line.id);
    if (!pick) continue;
    await db.requirementItem.update({
      where: { id: line.id },
      data: {
        fromStockQty: round2(pick.fromStockQty),
        procureQty: round2(pick.procureQty),
        sourceStoreId: pick.sourceStoreId ?? byId.get(line.id)?.sourceStoreId ?? null,
      },
    });
  }

  await writeAudit({
      entityType: "Requirement",
      entityId: requirementId,
      action: "FULFILMENT_DECIDED",
      actor: user,
      reason:
        [storeIssueNumber && `Store requisition ${storeIssueNumber}`, requisitionNumber && `Requisition ${requisitionNumber}`]
          .filter(Boolean)
          .join(" · ") + (decision.note?.trim() ? ` — ${decision.note.trim()}` : ""),
    }, db);

  return {
    requirementId,
    status,
    storeIssueId,
    storeIssueNumber,
    requisitionId,
    requisitionNumber,
    reservedLines,
  };
}

export async function cancelRequirement(
  user: SessionUser,
  id: string,
  reason: string,
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.REQUIREMENT_CANCEL)) {
    throw new ForbiddenError("You do not have permission to cancel requirements.");
  }
  if (!reason?.trim()) throw new ValidationError("A cancellation reason is required.");
  const requirement = await db.requirement.findUnique({ where: { id }, include: { items: true } });
  if (!requirement) throw new NotFoundError("Requirement");
  if (["CLOSED", "CANCELLED"].includes(requirement.status)) {
    throw new RuleViolationError("This requirement is already closed.");
  }

  // Anything held for it goes back on the shelf.
  const released = await releaseFor(
    { requirementItemIds: requirement.items.map((i) => i.id) },
    user.id,
    `Requirement ${requirement.number} cancelled`,
    db,
  );

  const updated = await db.requirement.update({
    where: { id },
    data: { status: "CANCELLED", cancelledAt: new Date(), decisionNote: reason.trim() },
  });
  await writeAudit({
      entityType: "Requirement",
      entityId: id,
      action: "CANCELLED",
      actor: user,
      reason: `${reason.trim()}${released ? ` — ${released} reservation(s) released.` : ""}`,
    }, db);
  return updated;
}

/* ── Reading ──────────────────────────────────────────────── */

/** Requirements a user may read: their own, their department's, or everything. */
export function requirementVisibilityFilter(user: SessionUser) {
  if (userHasPermission(user, P.REQUIREMENT_VIEW_ALL)) return {};
  return {
    OR: [
      { requesterId: user.id },
      ...(user.primaryDepartmentId ? [{ departmentId: user.primaryDepartmentId }] : []),
    ],
  };
}

export const REQUIREMENT_OPEN_STATUSES = ["DRAFT", "SUBMITTED", "CHECKING_STOCK"];

export async function requirementStats(
  where: Record<string, unknown>,
  db: DbClient = prisma,
) {
  const [total, awaitingCheck, decided, fromStock, toProcurement] = await Promise.all([
    db.requirement.count({ where }),
    db.requirement.count({ where: { ...where, status: { in: ["SUBMITTED", "CHECKING_STOCK"] } } }),
    db.requirement.count({ where: { ...where, decidedAt: { not: null } } }),
    db.requirement.count({ where: { ...where, status: "FULFILLED_FROM_STOCK" } }),
    db.requirement.count({ where: { ...where, status: { in: ["SENT_TO_PROCUREMENT", "SPLIT"] } } }),
  ]);
  return { total, awaitingCheck, decided, fromStock, toProcurement };
}
