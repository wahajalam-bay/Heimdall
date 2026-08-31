import { prisma, type DbClient } from "@/lib/db";
import { round2 } from "@/lib/format";
import { treatmentClass } from "@/lib/treatment";

/**
 * The Expense Book.
 *
 * The question it exists to answer is the one an Item Master flag cannot: of the
 * ten air conditioners bought this year, how many became office assets and how
 * many became project cost — and what was each worth.
 *
 * The evidence is the receipt line, because that is where the treatment was
 * decided. Every figure here traces back to a GRN line, a purchase order and a
 * requisition, so a number on this page can always be walked back to the
 * document that produced it.
 */

export type ExpenseBookFilter = {
  entityIds?: string[] | null;
  from?: Date | null;
  to?: Date | null;
  categoryId?: string | null;
  itemId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  vendorId?: string | null;
};

export type TreatmentTotals = {
  assetQty: number;
  assetValue: number;
  consumableQty: number;
  consumableValue: number;
  inventoryQty: number;
  inventoryValue: number;
  lines: number;
};

const empty = (): TreatmentTotals => ({
  assetQty: 0,
  assetValue: 0,
  consumableQty: 0,
  consumableValue: 0,
  inventoryQty: 0,
  inventoryValue: 0,
  lines: 0,
});

function add(t: TreatmentTotals, cls: ReturnType<typeof treatmentClass>, qty: number, value: number) {
  t.lines += 1;
  if (cls === "ASSET") {
    t.assetQty = round2(t.assetQty + qty);
    t.assetValue = round2(t.assetValue + value);
  } else if (cls === "CONSUMABLE") {
    t.consumableQty = round2(t.consumableQty + qty);
    t.consumableValue = round2(t.consumableValue + value);
  } else {
    t.inventoryQty = round2(t.inventoryQty + qty);
    t.inventoryValue = round2(t.inventoryValue + value);
  }
}

export type ExpenseBookRow = {
  key: string;
  label: string;
  sublabel: string | null;
  totals: TreatmentTotals;
};

export type ExpenseBook = {
  overall: TreatmentTotals;
  byItem: ExpenseBookRow[];
  byCategory: ExpenseBookRow[];
  byDepartment: ExpenseBookRow[];
  byProject: ExpenseBookRow[];
  byVendor: ExpenseBookRow[];
  /** Lines whose treatment departed from the item's default. */
  overrides: Array<{
    grnId: string;
    grnNumber: string;
    poNumber: string;
    prNumber: string | null;
    lineNo: number;
    description: string;
    from: string;
    to: string;
    reason: string | null;
    approvedBy: string | null;
    belowThreshold: boolean;
    qty: number;
    value: number;
    postedAt: Date | null;
  }>;
  /** Same item treated both ways in the period — not wrong, but worth seeing. */
  splitTreatment: Array<{
    itemId: string;
    name: string;
    sku: string;
    assetQty: number;
    consumableQty: number;
    assetValue: number;
    consumableValue: number;
  }>;
};

/**
 * Reads the book.
 *
 * One query for the lines, then grouped in memory. The alternative — a query per
 * dimension — costs six round trips for the same rows, and this page shows all
 * six dimensions at once.
 */
export async function expenseBook(
  filter: ExpenseBookFilter = {},
  db: DbClient = prisma,
): Promise<ExpenseBook> {
  const lines = await db.grnItem.findMany({
    where: {
      grn: {
        status: "POSTED",
        ...(filter.entityIds ? { po: { entityId: { in: filter.entityIds } } } : {}),
        ...(filter.vendorId ? { vendorId: filter.vendorId } : {}),
        ...(filter.from || filter.to
          ? {
              postedAt: {
                ...(filter.from ? { gte: filter.from } : {}),
                ...(filter.to ? { lte: filter.to } : {}),
              },
            }
          : {}),
      },
      ...(filter.itemId ? { itemId: filter.itemId } : {}),
      ...(filter.categoryId ? { item: { categoryId: filter.categoryId } } : {}),
    },
    select: {
      grnId: true,
      lineNo: true,
      description: true,
      acceptedQty: true,
      lineValue: true,
      disposition: true,
      defaultDisposition: true,
      treatmentReason: true,
      capitalisedBelowThreshold: true,
      usageContext: true,
      itemId: true,
      item: {
        select: {
          id: true,
          sku: true,
          name: true,
          category: { select: { id: true, code: true, name: true } },
        },
      },
      treatmentApprovedBy: { select: { name: true } },
      grn: {
        select: {
          number: true,
          postedAt: true,
          vendor: { select: { id: true, name: true } },
          po: {
            select: {
              number: true,
              pr: {
                select: {
                  number: true,
                  departmentId: true,
                  department: { select: { name: true } },
                  projectId: true,
                  project: { select: { name: true } },
                },
              },
            },
          },
        },
      },
    },
    orderBy: { grn: { postedAt: "desc" } },
    take: 5000,
  });

  const filtered = lines.filter((l) => {
    if (filter.departmentId && l.grn.po?.pr?.departmentId !== filter.departmentId) return false;
    if (filter.projectId && l.grn.po?.pr?.projectId !== filter.projectId) return false;
    return true;
  });

  const overall = empty();
  const byItem = new Map<string, ExpenseBookRow>();
  const byCategory = new Map<string, ExpenseBookRow>();
  const byDepartment = new Map<string, ExpenseBookRow>();
  const byProject = new Map<string, ExpenseBookRow>();
  const byVendor = new Map<string, ExpenseBookRow>();

  const bucket = (
    map: Map<string, ExpenseBookRow>,
    key: string,
    label: string,
    sublabel: string | null,
  ) => {
    let row = map.get(key);
    if (!row) {
      row = { key, label, sublabel, totals: empty() };
      map.set(key, row);
    }
    return row;
  };

  const overrides: ExpenseBook["overrides"] = [];

  for (const l of filtered) {
    const cls = treatmentClass(l.disposition);
    const qty = l.acceptedQty;
    const value = l.lineValue;

    add(overall, cls, qty, value);
    add(
      bucket(byItem, l.itemId ?? `desc:${l.description}`, l.item?.name ?? l.description, l.item?.sku ?? null)
        .totals,
      cls,
      qty,
      value,
    );
    if (l.item?.category) {
      add(
        bucket(byCategory, l.item.category.id, l.item.category.name, l.item.category.code).totals,
        cls,
        qty,
        value,
      );
    }
    const pr = l.grn.po?.pr;
    if (pr?.departmentId) {
      add(bucket(byDepartment, pr.departmentId, pr.department?.name ?? "—", null).totals, cls, qty, value);
    }
    // Lines with no project are office spend, and that contrast is the point of
    // the report — so they are bucketed rather than dropped.
    add(
      bucket(
        byProject,
        pr?.projectId ?? "__office",
        pr?.project?.name ?? "Office / non-project",
        pr?.projectId ? null : "No project",
      ).totals,
      cls,
      qty,
      value,
    );
    add(bucket(byVendor, l.grn.vendor.id, l.grn.vendor.name, null).totals, cls, qty, value);

    const departed = l.defaultDisposition && l.defaultDisposition !== l.disposition;
    if (departed || l.capitalisedBelowThreshold) {
      overrides.push({
        grnId: l.grnId,
        grnNumber: l.grn.number,
        poNumber: l.grn.po?.number ?? "—",
        prNumber: pr?.number ?? null,
        lineNo: l.lineNo,
        description: l.item?.name ?? l.description,
        from: l.defaultDisposition ?? "—",
        to: l.disposition,
        reason: l.treatmentReason,
        approvedBy: l.treatmentApprovedBy?.name ?? null,
        belowThreshold: l.capitalisedBelowThreshold,
        qty,
        value,
      postedAt: l.grn.postedAt,
      });
    }
  }

  // The headline case: one item treated both ways. Ten air conditioners, four
  // capitalised in offices and six consumed on projects.
  const splitTreatment = [...byItem.values()]
    .filter((r) => r.totals.assetQty > 0 && r.totals.consumableQty > 0)
    .map((r) => ({
      itemId: r.key,
      name: r.label,
      sku: r.sublabel ?? "—",
      assetQty: r.totals.assetQty,
      consumableQty: r.totals.consumableQty,
      assetValue: r.totals.assetValue,
      consumableValue: r.totals.consumableValue,
    }))
    .sort((a, b) => b.assetValue + b.consumableValue - (a.assetValue + a.consumableValue));

  const sorted = (m: Map<string, ExpenseBookRow>) =>
    [...m.values()].sort(
      (a, b) =>
        b.totals.assetValue +
        b.totals.consumableValue +
        b.totals.inventoryValue -
        (a.totals.assetValue + a.totals.consumableValue + a.totals.inventoryValue),
    );

  return {
    overall,
    byItem: sorted(byItem),
    byCategory: sorted(byCategory),
    byDepartment: sorted(byDepartment),
    byProject: sorted(byProject),
    byVendor: sorted(byVendor),
    overrides,
    splitTreatment,
  };
}
