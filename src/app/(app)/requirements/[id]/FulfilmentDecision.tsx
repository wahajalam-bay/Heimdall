"use client";

import { useMemo, useState } from "react";
import { ActionForm } from "@/components/ui/forms";
import { Field, Select, TextArea, TextInput } from "@/components/ui/field";
import { Badge, InlineAlert } from "@/components/ui/primitives";
import { round2 } from "@/lib/format";
import { decideFulfilmentAction } from "../actions";

export type DecisionLine = {
  requirementItemId: string;
  lineNo: number;
  sku: string | null;
  description: string;
  unit: string;
  quantity: number;
  primaryAvailable: number;
  elsewhereAvailable: number;
  suggestedFromStock: number;
  suggestedProcure: number;
  suggestedSourceStoreId: string | null;
  stores: Array<{ storeId: string; storeCode: string; storeName: string; available: number; isPrimary: boolean }>;
};

/**
 * The decision the whole demand layer exists for.
 *
 * The arithmetic proposes a split; a person may change it, because a storekeeper
 * can see reasons the numbers cannot — stock earmarked for a shutdown, a batch
 * about to expire, a quantity that is technically free but physically spoken for.
 * What a person may *not* do is quietly buy what the shelf already holds, so
 * reducing the stock quantity below what is available demands a reason before the
 * button will submit.
 */
export function FulfilmentDecision({
  requirementId,
  lines,
  mode,
  crossStoreEnabled,
}: {
  requirementId: string;
  lines: DecisionLine[];
  mode: "SPLIT" | "ALL_TO_PROCUREMENT";
  crossStoreEnabled: boolean;
}) {
  const [state, setState] = useState(() =>
    Object.fromEntries(
      lines.map((l) => [
        l.requirementItemId,
        {
          fromStock: String(l.suggestedFromStock),
          procure: String(l.suggestedProcure),
          sourceStoreId: l.suggestedSourceStoreId ?? "",
        },
      ]),
    ),
  );

  const set = (id: string, patch: Partial<{ fromStock: string; procure: string; sourceStoreId: string }>) =>
    setState((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  /** Keeps stock + procurement equal to what was asked for as one side is edited. */
  const setStock = (line: DecisionLine, raw: string) => {
    const asked = line.quantity;
    const stock = Math.max(0, Math.min(Number(raw) || 0, line.primaryAvailable + line.elsewhereAvailable, asked));
    set(line.requirementItemId, { fromStock: String(round2(stock)), procure: String(round2(asked - stock)) });
  };

  const totals = useMemo(() => {
    let stock = 0;
    let procure = 0;
    let short = 0;
    let overrode = false;
    for (const l of lines) {
      const s = Number(state[l.requirementItemId]?.fromStock) || 0;
      const p = Number(state[l.requirementItemId]?.procure) || 0;
      stock += s;
      procure += p;
      if (round2(s + p) < l.quantity) short += 1;
      if (s + 1e-9 < l.suggestedFromStock) overrode = true;
    }
    return { stock: round2(stock), procure: round2(procure), short, overrode };
  }, [lines, state]);

  const payload = lines.map((l) => ({
    requirementItemId: l.requirementItemId,
    fromStockQty: Number(state[l.requirementItemId]?.fromStock) || 0,
    procureQty: Number(state[l.requirementItemId]?.procure) || 0,
    sourceStoreId: state[l.requirementItemId]?.sourceStoreId || null,
  }));

  return (
    <ActionForm
      action={decideFulfilmentAction}
      submitLabel="Route this requirement"
      hiddenFields={{ id: requirementId, lines: JSON.stringify(payload) }}
      layout="bare"
    >
      <div className="space-y-4">
        {mode === "ALL_TO_PROCUREMENT" && (
          <InlineAlert tone="info">
            Configuration sends partly-available lines to procurement in full. A line can still be split by hand here.
          </InlineAlert>
        )}

        {totals.overrode && (
          <InlineAlert tone="warning">
            You have reduced the quantity taken from stock below what is available. Record why below — buying what the
            store already holds is the one decision on this screen that needs explaining.
          </InlineAlert>
        )}

        {totals.short > 0 && (
          <InlineAlert tone="danger">
            {totals.short} line{totals.short === 1 ? " has" : "s have"} a quantity allocated to neither stock nor
            procurement. That quantity will simply not be met.
          </InlineAlert>
        )}

        <div className="table-wrap">
          <table className="dt min-w-[52rem]">
            <thead>
              <tr>
                <th style={{ width: "3rem" }}>#</th>
                <th>Item</th>
                <th className="text-right">Needed</th>
                <th className="text-right">Own store</th>
                <th className="text-right">Elsewhere</th>
                <th className="text-right" style={{ width: "9rem" }}>
                  From stock
                </th>
                <th className="text-right" style={{ width: "9rem" }}>
                  To buy
                </th>
                {crossStoreEnabled && <th style={{ width: "15rem" }}>Issue from</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const row = state[l.requirementItemId];
                const stock = Number(row?.fromStock) || 0;
                const otherStores = l.stores.filter((s) => s.available > 0);
                return (
                  <tr key={l.requirementItemId}>
                    <td className="tnum">{l.lineNo}</td>
                    <td>
                      <div className="text-xs font-500">{l.description}</div>
                      <div className="mono text-2xs text-[var(--c-text-tertiary)]">
                        {l.sku ?? "Not in the catalogue — cannot be checked"}
                      </div>
                    </td>
                    <td className="num">
                      {l.quantity} {l.unit}
                    </td>
                    <td className="num">{l.primaryAvailable}</td>
                    <td className="num">
                      {l.elsewhereAvailable > 0 ? (
                        <span className="text-[var(--c-accent-text)]">{l.elsewhereAvailable}</span>
                      ) : (
                        <span className="text-[var(--c-text-tertiary)]">—</span>
                      )}
                    </td>
                    <td>
                      <TextInput
                        type="number"
                        step="any"
                        min="0"
                        max={l.quantity}
                        value={row?.fromStock ?? "0"}
                        onChange={(e) => setStock(l, e.target.value)}
                        className="text-right"
                        aria-label={`Quantity from stock for line ${l.lineNo}`}
                      />
                    </td>
                    <td>
                      <div className="tnum py-1 text-right text-xs">
                        {row?.procure ?? "0"} {l.unit}
                      </div>
                    </td>
                    {crossStoreEnabled && (
                      <td>
                        {stock > 0 && otherStores.length > 0 ? (
                          <Select
                            value={row?.sourceStoreId ?? ""}
                            onChange={(e) => set(l.requirementItemId, { sourceStoreId: e.target.value })}
                            aria-label={`Issuing store for line ${l.lineNo}`}
                            placeholder="Automatic"
                            className="w-full"
                            options={otherStores.map((s) => ({
                              value: s.storeId,
                              // Short enough to read inside the column; the full
                              // name is a hover away on the store itself.
                              label: `${s.storeCode}${s.isPrimary ? " (own)" : ""} · ${s.available}`,
                            }))}
                          />
                        ) : (
                          <span className="text-2xs text-[var(--c-text-tertiary)]">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
          <span className="flex items-center gap-1.5">
            <Badge tone="success">Store</Badge>
            <span className="tnum font-500">{totals.stock}</span>
            <span className="text-muted">to be issued</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Badge tone="accent">Procurement</Badge>
            <span className="tnum font-500">{totals.procure}</span>
            <span className="text-muted">to be bought</span>
          </span>
        </div>

        <Field
          label="Decision note"
          hint="Required if you are buying something the store could have issued."
          required={totals.overrode}
        >
          <TextArea name="note" rows={2} required={totals.overrode} placeholder="Why this split." />
        </Field>
      </div>
    </ActionForm>
  );
}
