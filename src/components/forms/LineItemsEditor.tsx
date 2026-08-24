"use client";

import { useEffect, useMemo, useState } from "react";
import { classNames, money, round2 } from "@/lib/format";
import { DISPOSITIONS, humanize } from "@/lib/domain";

export type CatalogueItem = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  brand: string | null;
  model: string | null;
  make: string | null;
  specification: string | null;
  standardPrice: number | null;
  categoryId: string;
};

export type CategoryOption = {
  id: string;
  code: string;
  name: string;
  defaultDisposition: string;
  requiresInspection: boolean;
};

export type LineDraft = {
  key: string;
  itemId: string | null;
  categoryId: string;
  description: string;
  brand: string;
  model: string;
  make: string;
  specification: string;
  quantity: string;
  unit: string;
  estimatedUnitPrice: string;
  disposition: string;
  notes: string;
};

const UNITS = ["EA", "BOX", "SET", "REAM", "PACK", "TON", "KG", "BAG", "CFT", "SQFT", "M", "LTR", "GAL", "SHEET", "CAN", "ROLL", "LOT"];

let seq = 0;
const newKey = () => `line-${++seq}-${Math.random().toString(36).slice(2, 7)}`;

export function emptyLine(categoryId = ""): LineDraft {
  return {
    key: newKey(),
    itemId: null,
    categoryId,
    description: "",
    brand: "",
    model: "",
    make: "",
    specification: "",
    quantity: "1",
    unit: "EA",
    estimatedUnitPrice: "",
    disposition: "INVENTORY",
    notes: "",
  };
}

/**
 * Requisition line editor.
 *
 * Serialises to a single hidden `items` field so the whole line set is
 * validated server-side in one place. Selecting a catalogue item pre-fills the
 * specification, unit and last known price — the fields stay editable because
 * requesters often need to vary a standard item.
 */
export function LineItemsEditor({
  name = "items",
  categories,
  items,
  initial,
  requireSpecification = true,
  currency = "PKR",
}: {
  name?: string;
  categories: CategoryOption[];
  items: CatalogueItem[];
  initial?: LineDraft[];
  requireSpecification?: boolean;
  currency?: string;
}) {
  const [lines, setLines] = useState<LineDraft[]>(initial?.length ? initial : [emptyLine(categories[0]?.id ?? "")]);
  const [expanded, setExpanded] = useState<string | null>(lines[0]?.key ?? null);

  const itemsByCategory = useMemo(() => {
    const m = new Map<string, CatalogueItem[]>();
    for (const it of items) {
      const arr = m.get(it.categoryId) ?? [];
      arr.push(it);
      m.set(it.categoryId, arr);
    }
    return m;
  }, [items]);

  const patch = (key: string, changes: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...changes } : l)));

  const pickCatalogueItem = (key: string, itemId: string) => {
    if (!itemId) {
      patch(key, { itemId: null });
      return;
    }
    const it = items.find((x) => x.id === itemId);
    if (!it) return;
    const cat = categories.find((c) => c.id === it.categoryId);
    patch(key, {
      itemId: it.id,
      categoryId: it.categoryId,
      description: it.name,
      brand: it.brand ?? "",
      model: it.model ?? "",
      make: it.make ?? "",
      specification: it.specification ?? "",
      unit: it.unit,
      estimatedUnitPrice: it.standardPrice ? String(it.standardPrice) : "",
      disposition: cat?.defaultDisposition ?? "INVENTORY",
    });
  };

  const total = lines.reduce(
    (a, l) => a + (Number(l.estimatedUnitPrice) || 0) * (Number(l.quantity) || 0),
    0,
  );

  // Only fully-formed lines are serialised; the server re-validates regardless.
  const payload = JSON.stringify(
    lines.map((l) => ({
      itemId: l.itemId,
      categoryId: l.categoryId,
      description: l.description.trim(),
      brand: l.brand.trim() || null,
      model: l.model.trim() || null,
      make: l.make.trim() || null,
      specification: l.specification.trim() || null,
      quantity: Number(l.quantity) || 0,
      unit: l.unit,
      estimatedUnitPrice: l.estimatedUnitPrice === "" ? null : Number(l.estimatedUnitPrice),
      disposition: l.disposition,
      notes: l.notes.trim() || null,
    })),
  );

  useEffect(() => {
    if (lines.length === 1) setExpanded(lines[0].key);
  }, [lines.length, lines]);

  const incomplete = (l: LineDraft) =>
    !l.description.trim() ||
    !l.categoryId ||
    !(Number(l.quantity) > 0) ||
    (requireSpecification && !l.specification.trim());

  return (
    <div className="space-y-2.5">
      <input type="hidden" name={name} value={payload} />

      <div className="overflow-hidden rounded-xl border border-border">
        <table className="dt">
          <thead>
            <tr>
              <th style={{ width: "2.5rem" }}>#</th>
              <th style={{ minWidth: "16rem" }}>Item / description</th>
              <th style={{ width: "10rem" }}>Category</th>
              <th style={{ width: "6.5rem" }} className="text-right">
                Quantity
              </th>
              <th style={{ width: "6rem" }}>Unit</th>
              <th style={{ width: "9rem" }} className="text-right">
                Est. unit price
              </th>
              <th style={{ width: "9rem" }} className="text-right">
                Line total
              </th>
              <th style={{ width: "4rem" }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, idx) => {
              const catItems = itemsByCategory.get(l.categoryId) ?? [];
              const lineTotal = round2((Number(l.estimatedUnitPrice) || 0) * (Number(l.quantity) || 0));
              const isOpen = expanded === l.key;
              return (
                <>
                  <tr key={l.key} className={classNames(incomplete(l) && "bg-[var(--c-warning-soft)]/40")}>
                    <td className="align-top">
                      <span className="tnum text-xs text-[var(--c-text-tertiary)]">{idx + 1}</span>
                    </td>
                    <td className="align-top">
                      <select
                        className="field mb-1.5"
                        value={l.itemId ?? ""}
                        onChange={(e) => pickCatalogueItem(l.key, e.target.value)}
                        aria-label={`Catalogue item for line ${idx + 1}`}
                      >
                        <option value="">Free text (not in catalogue)</option>
                        {(l.categoryId ? catItems : items).map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.sku} — {it.name}
                          </option>
                        ))}
                      </select>
                      <input
                        className="field"
                        placeholder="Description *"
                        value={l.description}
                        onChange={(e) => patch(l.key, { description: e.target.value })}
                        aria-label={`Description for line ${idx + 1}`}
                      />
                    </td>
                    <td className="align-top">
                      <select
                        className="field"
                        value={l.categoryId}
                        onChange={(e) => {
                          const cat = categories.find((c) => c.id === e.target.value);
                          patch(l.key, {
                            categoryId: e.target.value,
                            disposition: cat?.defaultDisposition ?? l.disposition,
                            itemId: null,
                          });
                        }}
                        aria-label={`Category for line ${idx + 1}`}
                      >
                        <option value="">Select…</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      {categories.find((c) => c.id === l.categoryId)?.requiresInspection && (
                        <span className="badge badge-warning mt-1.5">Inspection required</span>
                      )}
                    </td>
                    <td className="align-top">
                      <input
                        className="field text-right"
                        type="number"
                        step="any"
                        min="0"
                        value={l.quantity}
                        onChange={(e) => patch(l.key, { quantity: e.target.value })}
                        aria-label={`Quantity for line ${idx + 1}`}
                      />
                    </td>
                    <td className="align-top">
                      <select
                        className="field"
                        value={l.unit}
                        onChange={(e) => patch(l.key, { unit: e.target.value })}
                        aria-label={`Unit for line ${idx + 1}`}
                      >
                        {UNITS.map((u) => (
                          <option key={u} value={u}>
                            {u}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="align-top">
                      <input
                        className="field text-right"
                        type="number"
                        step="any"
                        min="0"
                        placeholder="0"
                        value={l.estimatedUnitPrice}
                        onChange={(e) => patch(l.key, { estimatedUnitPrice: e.target.value })}
                        aria-label={`Estimated unit price for line ${idx + 1}`}
                      />
                    </td>
                    <td className="num align-top">
                      <span className="tnum inline-block pt-2 text-[0.8125rem] font-500">
                        {lineTotal > 0 ? money(lineTotal, currency) : "—"}
                      </span>
                    </td>
                    <td className="align-top">
                      <div className="flex flex-col gap-1 pt-1">
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          onClick={() => setExpanded(isOpen ? null : l.key)}
                          aria-expanded={isOpen}
                          title="Specification and details"
                        >
                          {isOpen ? "Hide" : "Detail"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs text-[var(--c-danger)]"
                          onClick={() =>
                            setLines((prev) => (prev.length === 1 ? prev : prev.filter((x) => x.key !== l.key)))
                          }
                          disabled={lines.length === 1}
                          title="Remove line"
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={`${l.key}-detail`}>
                      <td />
                      <td colSpan={7} className="bg-surface-secondary">
                        <div className="grid gap-3 py-1 sm:grid-cols-3">
                          <label className="block">
                            <span className="mb-1 block text-2xs font-500 text-muted">Brand</span>
                            <input className="field" value={l.brand} onChange={(e) => patch(l.key, { brand: e.target.value })} />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-2xs font-500 text-muted">Model</span>
                            <input className="field" value={l.model} onChange={(e) => patch(l.key, { model: e.target.value })} />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-2xs font-500 text-muted">Make</span>
                            <input className="field" value={l.make} onChange={(e) => patch(l.key, { make: e.target.value })} />
                          </label>
                          <label className="block sm:col-span-2">
                            <span className="mb-1 block text-2xs font-500 text-muted">
                              Technical specification {requireSpecification && <span className="text-[var(--c-danger)]">*</span>}
                            </span>
                            <textarea
                              className="field"
                              rows={3}
                              placeholder="State the specification precisely — this is what vendors will quote against."
                              value={l.specification}
                              onChange={(e) => patch(l.key, { specification: e.target.value })}
                            />
                          </label>
                          <div className="space-y-3">
                            <label className="block">
                              <span className="mb-1 block text-2xs font-500 text-muted">Disposition</span>
                              <select
                                className="field"
                                value={l.disposition}
                                onChange={(e) => patch(l.key, { disposition: e.target.value })}
                              >
                                {DISPOSITIONS.map((d) => (
                                  <option key={d} value={d}>
                                    {humanize(d)}
                                  </option>
                                ))}
                              </select>
                              <span className="mt-1 block text-2xs text-[var(--c-text-tertiary)]">
                                Determines whether receipt creates stock, an asset or an expense.
                              </span>
                            </label>
                            <label className="block">
                              <span className="mb-1 block text-2xs font-500 text-muted">Notes</span>
                              <input className="field" value={l.notes} onChange={(e) => patch(l.key, { notes: e.target.value })} />
                            </label>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={6} className="text-right">
                Estimated value
              </td>
              <td className="num">{money(round2(total), currency)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() =>
            setLines((prev) => {
              const line = emptyLine(prev[prev.length - 1]?.categoryId ?? categories[0]?.id ?? "");
              setExpanded(line.key);
              return [...prev, line];
            })
          }
        >
          + Add line
        </button>
        {lines.some(incomplete) && (
          <span className="text-2xs text-[var(--c-warning)]">
            Highlighted lines are missing a description, category, quantity
            {requireSpecification ? " or specification" : ""}.
          </span>
        )}
      </div>
    </div>
  );
}
