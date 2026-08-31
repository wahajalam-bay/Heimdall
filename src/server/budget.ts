import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { round2 } from "@/lib/format";
import { CONFIG_KEYS, getConfig, getConfigNumber } from "@/lib/config";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";

/**
 * Budgets, and what is left of them.
 *
 * Allocated is the only figure held. Committed and utilised are computed from the
 * documents that caused them — an approved order commits money, a posted receipt
 * spends it — because a stored running total is a number that drifts the first
 * time an order is cancelled and nobody remembers to decrement it.
 *
 * Whether an over-commitment merely warns or actually blocks is configuration:
 * §89 leaves the control mechanism to finance, so the default warns loudly rather
 * than stopping an organisation that has not loaded its budgets yet.
 */

export type BudgetPosition = {
  budgetId: string;
  year: string;
  entityId: string;
  entityCode: string;
  departmentName: string | null;
  costCenterCode: string | null;
  categoryName: string | null;
  expenditureType: string;
  allocated: number;
  committed: number;
  utilised: number;
  available: number;
  utilisedPercent: number;
  committedPercent: number;
  hardLimit: boolean;
  /** OK | WARN | EXHAUSTED | OVERCOMMITTED */
  state: "OK" | "WARN" | "EXHAUSTED" | "OVERCOMMITTED";
};

/** The document filters a budget line's dimensions imply. */
function scopeFor(budget: {
  entityId: string;
  departmentId: string | null;
  costCenterId: string | null;
  categoryId: string | null;
  expenditureType: string;
}) {
  const po: Record<string, unknown> = { entityId: budget.entityId };
  if (budget.costCenterId) po.costCenterId = budget.costCenterId;
  if (budget.expenditureType !== "BOTH") po.expenditureType = budget.expenditureType;
  // Department and category live on the requisition, not the order.
  const prSide: Record<string, unknown> = {};
  if (budget.departmentId) prSide.departmentId = budget.departmentId;
  if (Object.keys(prSide).length) po.pr = prSide;
  return po;
}

/**
 * Reads one budget line's position.
 *
 * Committed counts orders that are live — approved or beyond, and not cancelled.
 * Utilised counts the value actually received, because money is spent when goods
 * arrive, not when an order is signed.
 */
export async function budgetPosition(budgetId: string, db: DbClient = prisma): Promise<BudgetPosition> {
  const budget = await db.budget.findUnique({
    where: { id: budgetId },
    include: {
      entity: { select: { code: true } },
      department: { select: { name: true } },
      costCenter: { select: { code: true } },
      category: { select: { name: true, id: true } },
    },
  });
  if (!budget) throw new NotFoundError("Budget");

  const poWhere = scopeFor(budget);
  const [committedAgg, receivedRows, warnPercent] = await Promise.all([
    db.purchaseOrder.aggregate({
      where: {
        ...poWhere,
        // Money committed by an order that has since closed is still money the
        // budget spent. Leaving CLOSED out made a fully-received order vanish
        // from commitment while its receipts still counted as utilised, which
        // reported utilisation above a commitment of nought.
        status: { in: ["APPROVED", "ISSUED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CLOSED", "ON_HOLD"] },
      },
      _sum: { total: true },
    }),
    db.grnItem.findMany({
      where: {
        grn: { status: "POSTED", po: poWhere },
        ...(budget.categoryId ? { item: { categoryId: budget.categoryId } } : {}),
      },
      select: { acceptedQty: true, unitPrice: true },
    }),
    getConfigNumber(CONFIG_KEYS.BUDGET_WARN_PERCENT, budget.entityId, db),
  ]);

  const committed = round2(committedAgg._sum.total ?? 0);
  const utilised = round2(receivedRows.reduce((a, r) => a + r.acceptedQty * r.unitPrice, 0));
  const available = round2(budget.allocated - committed);
  const utilisedPercent = budget.allocated > 0 ? round2((utilised / budget.allocated) * 100) : 0;
  const committedPercent = budget.allocated > 0 ? round2((committed / budget.allocated) * 100) : 0;

  const state: BudgetPosition["state"] =
    committed > budget.allocated + 1e-9
      ? "OVERCOMMITTED"
      : committedPercent >= 100
        ? "EXHAUSTED"
        : committedPercent >= warnPercent
          ? "WARN"
          : "OK";

  return {
    budgetId: budget.id,
    year: budget.year,
    entityId: budget.entityId,
    entityCode: budget.entity.code,
    departmentName: budget.department?.name ?? null,
    costCenterCode: budget.costCenter?.code ?? null,
    categoryName: budget.category?.name ?? null,
    expenditureType: budget.expenditureType,
    allocated: round2(budget.allocated),
    committed,
    utilised,
    available,
    utilisedPercent,
    committedPercent,
    hardLimit: budget.hardLimit,
    state,
  };
}

export async function budgetPositions(
  where: { entityIds?: string[] | null; year?: string | null },
  db: DbClient = prisma,
): Promise<BudgetPosition[]> {
  const budgets = await db.budget.findMany({
    where: {
      active: true,
      ...(where.entityIds ? { entityId: { in: where.entityIds } } : {}),
      ...(where.year ? { year: where.year } : {}),
    },
    select: { id: true },
    orderBy: [{ year: "desc" }],
  });
  return Promise.all(budgets.map((b) => budgetPosition(b.id, db)));
}

/**
 * The budget line a requisition or order falls under, if any.
 *
 * Most specific first: a line naming the department, cost centre and category
 * beats one naming only the entity, because that is what somebody setting a
 * narrow allocation intended.
 */
export async function budgetFor(
  input: {
    entityId: string;
    departmentId?: string | null;
    costCenterId?: string | null;
    categoryId?: string | null;
    expenditureType?: string | null;
    year?: string | null;
  },
  db: DbClient = prisma,
) {
  const year = input.year ?? String(new Date().getFullYear());
  const candidates = await db.budget.findMany({
    where: {
      active: true,
      entityId: input.entityId,
      year,
      OR: [{ departmentId: input.departmentId ?? null }, { departmentId: null }],
    },
  });
  if (!candidates.length) return null;

  const score = (b: (typeof candidates)[number]) =>
    (b.departmentId === input.departmentId && b.departmentId ? 4 : 0) +
    (b.costCenterId === input.costCenterId && b.costCenterId ? 2 : 0) +
    (b.categoryId === input.categoryId && b.categoryId ? 1 : 0) +
    (b.expenditureType === input.expenditureType ? 1 : 0);

  const matching = candidates.filter(
    (b) =>
      (!b.costCenterId || b.costCenterId === input.costCenterId) &&
      (!b.categoryId || b.categoryId === input.categoryId) &&
      (b.expenditureType === "BOTH" || b.expenditureType === input.expenditureType),
  );
  if (!matching.length) return null;
  return matching.sort((a, b) => score(b) - score(a))[0];
}

export type BudgetCheck = {
  /** Null when no budget covers this spend — reported, not silently passed. */
  budgetId: string | null;
  allocated: number;
  committed: number;
  available: number;
  requested: number;
  /** OFF | WARN | BLOCK, from configuration. */
  control: string;
  /** True when the caller must refuse. */
  blocked: boolean;
  message: string | null;
};

/**
 * Tests a proposed commitment against its budget.
 *
 * Returns rather than throws, so a caller can decide whether this is a hard stop
 * or something to show the approver alongside the figure.
 */
export async function checkBudget(
  input: {
    entityId: string;
    amount: number;
    departmentId?: string | null;
    costCenterId?: string | null;
    categoryId?: string | null;
    expenditureType?: string | null;
    year?: string | null;
  },
  db: DbClient = prisma,
): Promise<BudgetCheck> {
  const control = ((await getConfig<string>(CONFIG_KEYS.BUDGET_CONTROL, input.entityId, db)) ?? "WARN").toUpperCase();
  const budget = await budgetFor(input, db);

  if (!budget) {
    return {
      budgetId: null,
      allocated: 0,
      committed: 0,
      available: 0,
      requested: round2(input.amount),
      control,
      blocked: false,
      message:
        control === "OFF" ? null : "No budget line covers this spend, so nothing was checked against an allocation.",
    };
  }

  const position = await budgetPosition(budget.id, db);
  const after = round2(position.committed + input.amount);
  const over = round2(after - position.allocated);
  const blocked = (control === "BLOCK" || budget.hardLimit) && over > 0;

  return {
    budgetId: budget.id,
    allocated: position.allocated,
    committed: position.committed,
    available: position.available,
    requested: round2(input.amount),
    control,
    blocked,
    message:
      over > 0
        ? `This would commit ${after} against an allocation of ${position.allocated} — over by ${over}.`
        : control === "OFF"
          ? null
          : `${position.available} of ${position.allocated} remains uncommitted on this budget.`,
  };
}

/* ── Maintenance ──────────────────────────────────────────── */

export async function upsertBudget(
  user: SessionUser,
  input: {
    id?: string | null;
    entityId: string;
    year: string;
    departmentId?: string | null;
    costCenterId?: string | null;
    categoryId?: string | null;
    expenditureType?: string;
    allocated: number;
    hardLimit?: boolean;
    notes?: string | null;
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.BUDGET_MANAGE)) {
      throw new ForbiddenError("You do not have permission to maintain budgets.");
    }
    if (!input.year?.trim()) throw new ValidationError("A financial year is required.");
    if (input.allocated < 0) throw new ValidationError("An allocation cannot be negative.");

    const data = {
      entityId: input.entityId,
      year: input.year.trim(),
      departmentId: input.departmentId ?? null,
      costCenterId: input.costCenterId ?? null,
      categoryId: input.categoryId ?? null,
      expenditureType: input.expenditureType ?? "BOTH",
      allocated: round2(input.allocated),
      hardLimit: Boolean(input.hardLimit),
      notes: input.notes ?? null,
    };

    // Reducing an allocation below what is already committed is refused: the money
    // is spoken for, and a negative remainder is not a budget.
    if (input.id) {
      const position = await budgetPosition(input.id, tx);
      if (data.allocated + 1e-9 < position.committed) {
        throw new RuleViolationError(
          `${position.committed} is already committed against this line; the allocation cannot be set below it.`,
        );
      }
    }

    const budget = input.id
      ? await tx.budget.update({ where: { id: input.id }, data })
      : await tx.budget.create({ data });

    await writeAudit(
      {
        entityType: "Budget",
        entityId: budget.id,
        entityRef: `${budget.year} ${budget.expenditureType}`,
        action: input.id ? "BUDGET_UPDATED" : "BUDGET_CREATED",
        newValue: { allocated: budget.allocated, hardLimit: budget.hardLimit },
        actor: user,
      },
      tx,
    );
    return budget;
  });
}
