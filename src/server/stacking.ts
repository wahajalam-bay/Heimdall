import { prisma, type DbClient } from "@/lib/db";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";

/**
 * The stacking taxonomy and its rules — RC-015, RC-016, Annexure 5.
 *
 * Annexure 5 is a page of practical instructions: FIFO, liquids on wooden
 * pallets, heavy goods at ground level, nothing near wires or electrical
 * appliances, handsets and laptops in strong cabinets with entry/exit
 * management, aisles for slow-moving goods, empty boxes stacked separately,
 * distance maintained to avoid mixing, only authorised persons in stacking
 * areas.
 *
 * Most of that is guidance a storekeeper follows. Four of them are checkable
 * from the goods themselves, so those four are flags on the category and the
 * system can say when a stacking record contradicts them. The rest is carried as
 * the annexure's own text against the category, shown at the point of stacking —
 * which is more use than a policy document nobody opens while holding a box.
 *
 * What this deliberately does not do is refuse a stacking record. The annexure
 * describes good practice in a warehouse, not a control on a transaction, and a
 * system that blocked a receipt because a pallet was unavailable would be
 * inventing a rule the SOP does not state. Contradictions are surfaced.
 */

export type StackingAdvice = {
  categoryName: string | null;
  guidance: string | null;
  /** Where the record and the category's own rules disagree. */
  conflicts: string[];
  /** Rules that apply and cannot be checked from what was recorded. */
  unverifiable: string[];
};

/**
 * Advice and conflicts for one stacking record.
 *
 * A conflict is a statement about what was recorded, not a prediction: "this
 * category wants a pallet and the method says floor" is checkable. Whether the
 * cabinet was actually locked is not, and is listed as such rather than assumed
 * either way.
 */
export async function stackingAdvice(
  input: {
    stackingCategoryId?: string | null;
    itemId?: string | null;
    stackingMethod: string;
    goodsClass: string;
    locationId?: string | null;
  },
  db: DbClient = prisma,
): Promise<StackingAdvice> {
  let categoryId = input.stackingCategoryId ?? null;
  if (!categoryId && input.itemId) {
    const item = await db.item.findUnique({
      where: { id: input.itemId },
      select: { stackingCategoryId: true },
    });
    categoryId = item?.stackingCategoryId ?? null;
  }
  if (!categoryId) {
    return {
      categoryName: null,
      guidance: null,
      conflicts: [],
      unverifiable: [
        "No stacking category is set for this item, so Annexure 5's rules cannot be applied to it. Classify the item to get its guidance.",
      ],
    };
  }

  const category = await db.stackingCategory.findUnique({ where: { id: categoryId } });
  if (!category) return { categoryName: null, guidance: null, conflicts: [], unverifiable: [] };

  const conflicts: string[] = [];
  const unverifiable: string[] = [];

  if (category.requiresPallet && !["PALLET", "RACK"].includes(input.stackingMethod)) {
    conflicts.push(
      `Annexure 5 puts ${category.name.toLowerCase()} on wooden pallets, and this is stacked on ${input.stackingMethod.toLowerCase()}.`,
    );
  }
  if (category.groundLevelOnly && ["RACK", "SHELF"].includes(input.stackingMethod)) {
    conflicts.push(
      `Annexure 5 keeps heavy goods at ground level, and ${input.stackingMethod.toLowerCase()} storage is not that.`,
    );
  }
  if (category.requiresSecureStorage) {
    if (input.stackingMethod !== "CAGE" && input.goodsClass !== "HIGH_VALUE") {
      conflicts.push(
        `Annexure 5 keeps ${category.name.toLowerCase()} in strong cabinets or a strong room with entry/exit management. ` +
          `This is stacked on ${input.stackingMethod.toLowerCase()} and classed ${input.goodsClass.toLowerCase()}.`,
      );
    }
    unverifiable.push(
      "Entry and exit management for the secure area is a physical control the system cannot observe.",
    );
  }
  if (category.keepFromElectrical) {
    unverifiable.push(
      `Annexure 5 keeps ${category.name.toLowerCase()} away from wires and electrical appliances — a placement the system cannot see.`,
    );
  }

  return {
    categoryName: category.name,
    guidance: category.guidance,
    conflicts,
    unverifiable,
  };
}

/** Classifies an item into one of Annexure 5's ten stacking categories. */
export async function setItemStackingCategory(
  user: SessionUser,
  input: { itemId: string; stackingCategoryId: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.MASTER_MANAGE, P.MASTER_DATA_MANAGE)) {
    throw new RuleViolationError("You do not have permission to classify items.");
  }
  const item = await db.item.findUnique({ where: { id: input.itemId }, select: { id: true } });
  if (!item) throw new NotFoundError("Item");
  if (input.stackingCategoryId) {
    const category = await db.stackingCategory.findUnique({
      where: { id: input.stackingCategoryId },
      select: { id: true, active: true },
    });
    if (!category?.active) throw new ValidationError("That stacking category is not active.");
  }
  return db.item.update({
    where: { id: item.id },
    data: { stackingCategoryId: input.stackingCategoryId },
  });
}

/**
 * Which catalogue items have no stacking category.
 *
 * RC-016 asks for the taxonomy to exist; it is only useful once the goods are in
 * it, and an unclassified item gets no guidance at the point of stacking. This
 * is the gap, by procurement category so it can be worked through in batches.
 */
export async function unclassifiedItems(db: DbClient = prisma) {
  const rows = await db.item.findMany({
    where: { active: true, stackingCategoryId: null },
    select: { id: true, sku: true, name: true, category: { select: { code: true, name: true } } },
    orderBy: [{ category: { name: "asc" } }, { sku: "asc" }],
  });
  const byCategory = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.category.name;
    const held = byCategory.get(key);
    if (held) held.push(r);
    else byCategory.set(key, [r]);
  }
  return {
    total: rows.length,
    groups: [...byCategory.entries()].map(([category, items]) => ({ category, items })),
  };
}

/**
 * RC-003 — coverage of the box-by-box check on bulk receipts.
 *
 * "For bulk receipts, packing method verified and each box checked against
 * delivery documents." A package count alone does not say anybody opened them,
 * so the check is recorded separately and this reports where it fell short.
 *
 * Not a refusal. The clause describes what receiving should do; a system that
 * blocked a delivery for it would stop goods at the gate over paperwork, and the
 * SOP does not ask for that. It asks for the check — so the gap is reported to
 * the people who supervise receiving.
 */
export async function boxCheckCoverage(
  filter: { entityIds?: string[] | null; since?: Date | null } = {},
  db: DbClient = prisma,
) {
  const rows = await db.deliveryItem.findMany({
    where: {
      // "Bulk" in the clause's sense: a line delivered in multiple packages.
      packages: { gt: 1 },
      delivery: {
        ...(filter.since ? { deliveryDate: { gte: filter.since } } : {}),
        ...(filter.entityIds ? { po: { entityId: { in: filter.entityIds } } } : {}),
      },
    },
    select: {
      id: true,
      description: true,
      packages: true,
      boxesChecked: true,
      boxesWithDiscrepancy: true,
      packingMethodVerified: true,
      boxCheckNotes: true,
      delivery: {
        select: {
          id: true,
          number: true,
          deliveryDate: true,
          po: { select: { number: true, vendor: { select: { name: true } } } },
        },
      },
    },
    orderBy: { delivery: { deliveryDate: "desc" } },
    take: 300,
  });

  return rows.map((r) => {
    const packages = r.packages ?? 0;
    const checked = r.boxesChecked ?? 0;
    return {
      id: r.id,
      deliveryId: r.delivery.id,
      deliveryNumber: r.delivery.number,
      deliveryDate: r.delivery.deliveryDate,
      poNumber: r.delivery.po?.number ?? null,
      vendorName: r.delivery.po?.vendor?.name ?? null,
      description: r.description,
      packages,
      checked,
      withDiscrepancy: r.boxesWithDiscrepancy ?? 0,
      packingMethodVerified: r.packingMethodVerified,
      notes: r.boxCheckNotes,
      /** Nothing opened at all. */
      unchecked: checked === 0,
      /** Some opened, not all — the clause says each box. */
      partial: checked > 0 && checked < packages,
      coverage: packages > 0 ? Math.round((checked / packages) * 100) : null,
    };
  });
}

/** Records the box-by-box check against a delivery line. */
export async function recordBoxCheck(
  user: SessionUser,
  input: {
    deliveryItemId: string;
    packingMethodVerified: boolean;
    boxesChecked: number;
    boxesWithDiscrepancy?: number | null;
    notes?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.RECEIVE_GOODS, P.GRN_CREATE)) {
    throw new RuleViolationError("You do not have permission to record a receiving check.");
  }
  const line = await db.deliveryItem.findUnique({
    where: { id: input.deliveryItemId },
    select: { id: true, packages: true, description: true },
  });
  if (!line) throw new NotFoundError("Delivery line");

  if (input.boxesChecked < 0) throw new ValidationError("Boxes checked cannot be negative.");
  if (line.packages != null && input.boxesChecked > line.packages) {
    throw new ValidationError(
      `${input.boxesChecked} boxes checked against ${line.packages} received. More boxes cannot be checked than arrived.`,
    );
  }
  // A discrepancy found and not described cannot be chased.
  if ((input.boxesWithDiscrepancy ?? 0) > 0 && !input.notes?.trim()) {
    throw new ValidationError(
      "Say what was wrong with the boxes that did not match. A count of discrepancies with no description cannot be acted on.",
    );
  }
  if ((input.boxesWithDiscrepancy ?? 0) > input.boxesChecked) {
    throw new ValidationError(
      "More boxes cannot be found wanting than were opened.",
    );
  }

  return db.deliveryItem.update({
    where: { id: line.id },
    data: {
      packingMethodVerified: input.packingMethodVerified,
      boxesChecked: input.boxesChecked,
      boxesWithDiscrepancy: input.boxesWithDiscrepancy ?? 0,
      boxCheckNotes: input.notes?.trim() || null,
    },
  });
}
