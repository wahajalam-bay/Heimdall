import { prisma, type DbClient } from "@/lib/db";
import { round2 } from "@/lib/format";
import { RuleViolationError } from "@/lib/errors";

/**
 * What each order actually took from each requisition line.
 *
 * A requisition line can be split across several orders — three vendors, three
 * orders, one line — and a single order can carry lines from several
 * requisitions, which is how a buyer consolidates a month of small demands into
 * one negotiation. Neither shape fits in a column on the order, so the placed
 * quantity lives in its own row here.
 *
 * The legacy `purchase_orders.pr_id` is kept and still written: it names the case
 * an order was raised under, which is what every screen and export reads. What it
 * cannot do is carry a second requisition, or a quantity — and that is what this
 * table is for.
 */

export type AllocationInput = {
  prId: string;
  prItemId: string;
  poId: string;
  poItemId?: string | null;
  quantity: number;
  unit: string;
};

/** Records what an order took, refusing to place more than the line still has. */
export async function allocate(
  inputs: AllocationInput[],
  createdById: string | null,
  db: DbClient = prisma,
) {
  for (const a of inputs) {
    if (a.quantity <= 0) continue;
    const remaining = await unallocatedQuantity(a.prItemId, db, a.poId);
    if (a.quantity > remaining + 1e-9) {
      const line = await db.purchaseRequisitionItem.findUnique({
        where: { id: a.prItemId },
        select: { lineNo: true, description: true },
      });
      throw new RuleViolationError(
        `Requisition line ${line?.lineNo ?? "?"} (${line?.description ?? a.prItemId}) has ${round2(remaining)} ${a.unit} left to order; this order asks for ${round2(a.quantity)}.`,
      );
    }
    // A compound unique cannot be looked up through a null, so the pair is found
    // rather than upserted. In practice every allocation names an order line;
    // the nullable side exists for a line-less allocation, which is rare.
    const existing = await db.prPoAllocation.findFirst({
      where: { prItemId: a.prItemId, poItemId: a.poItemId ?? null },
      select: { id: true },
    });
    if (existing) {
      await db.prPoAllocation.update({
        where: { id: existing.id },
        data: { quantity: round2(a.quantity), poId: a.poId, unit: a.unit },
      });
    } else {
      await db.prPoAllocation.create({
        data: {
          prId: a.prId,
          prItemId: a.prItemId,
          poId: a.poId,
          poItemId: a.poItemId ?? null,
          quantity: round2(a.quantity),
          unit: a.unit,
          createdById,
        },
      });
    }
  }
}

/**
 * How much of a requisition line has not yet been ordered.
 *
 * `exceptPoId` lets an order being edited ignore its own existing allocation,
 * so re-saving the same order does not read as an over-order.
 */
export async function unallocatedQuantity(
  prItemId: string,
  db: DbClient = prisma,
  exceptPoId?: string,
) {
  const line = await db.purchaseRequisitionItem.findUnique({
    where: { id: prItemId },
    select: { quantity: true },
  });
  if (!line) return 0;
  const placed = await db.prPoAllocation.aggregate({
    where: { prItemId, ...(exceptPoId ? { poId: { not: exceptPoId } } : {}) },
    _sum: { quantity: true },
  });
  return round2(Math.max(0, line.quantity - (placed._sum.quantity ?? 0)));
}

export type LineCoverage = {
  prItemId: string;
  lineNo: number;
  description: string;
  unit: string;
  required: number;
  ordered: number;
  outstanding: number;
  orders: Array<{ poId: string; poNumber: string; status: string; quantity: number; vendorName: string | null }>;
};

/** Line-by-line: what was asked for, what has been ordered, and on which orders. */
export async function requisitionCoverage(prId: string, db: DbClient = prisma): Promise<LineCoverage[]> {
  const lines = await db.purchaseRequisitionItem.findMany({
    where: { prId },
    orderBy: { lineNo: "asc" },
    select: { id: true, lineNo: true, description: true, unit: true, quantity: true },
  });
  const allocations = await db.prPoAllocation.findMany({
    where: { prId },
    include: {
      po: { select: { id: true, number: true, status: true, vendor: { select: { name: true } } } },
    },
  });

  return lines.map((l) => {
    const mine = allocations.filter((a) => a.prItemId === l.id);
    const ordered = round2(mine.reduce((a, x) => a + x.quantity, 0));
    return {
      prItemId: l.id,
      lineNo: l.lineNo,
      description: l.description,
      unit: l.unit,
      required: l.quantity,
      ordered,
      outstanding: round2(Math.max(0, l.quantity - ordered)),
      orders: mine.map((a) => ({
        poId: a.po.id,
        poNumber: a.po.number,
        status: a.po.status,
        quantity: a.quantity,
        vendorName: a.po.vendor?.name ?? null,
      })),
    };
  });
}

/** Every requisition an order draws on — the many-to-many read in the other direction. */
export async function orderSources(poId: string, db: DbClient = prisma) {
  const allocations = await db.prPoAllocation.findMany({
    where: { poId },
    include: {
      pr: { select: { id: true, number: true, title: true, departmentId: true, department: { select: { name: true } } } },
      prItem: { select: { lineNo: true, description: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const byPr = new Map<
    string,
    { prId: string; number: string; title: string; department: string; lines: Array<{ lineNo: number; description: string; quantity: number; unit: string }> }
  >();
  for (const a of allocations) {
    const entry = byPr.get(a.prId) ?? {
      prId: a.pr.id,
      number: a.pr.number,
      title: a.pr.title,
      department: a.pr.department.name,
      lines: [],
    };
    entry.lines.push({
      lineNo: a.prItem.lineNo,
      description: a.prItem.description,
      quantity: a.quantity,
      unit: a.unit,
    });
    byPr.set(a.prId, entry);
  }
  return [...byPr.values()];
}

/**
 * Fills the table in for orders raised before it existed.
 *
 * Every order line already names the requisition line it came from, so the
 * history is recoverable exactly rather than estimated — which matters, because a
 * coverage figure built from a guess is worse than none.
 */
export async function backfillAllocations(db: DbClient = prisma) {
  const items = await db.purchaseOrderItem.findMany({
    where: { prItemId: { not: null } },
    select: {
      id: true,
      quantity: true,
      unit: true,
      prItemId: true,
      poId: true,
      po: { select: { prId: true } },
    },
  });

  let created = 0;
  let skipped = 0;
  for (const it of items) {
    if (!it.prItemId) continue;
    const prId = it.po.prId ?? (await db.purchaseRequisitionItem.findUnique({
      where: { id: it.prItemId },
      select: { prId: true },
    }))?.prId;
    if (!prId) {
      skipped += 1;
      continue;
    }
    const already = await db.prPoAllocation.findFirst({
      where: { prItemId: it.prItemId, poItemId: it.id },
      select: { id: true },
    });
    if (already) continue;
    await db.prPoAllocation.create({
      data: {
        prId,
        prItemId: it.prItemId,
        poId: it.poId,
        poItemId: it.id,
        quantity: it.quantity,
        unit: it.unit,
      },
    });
    created += 1;
  }
  return { created, skipped, scanned: items.length };
}
