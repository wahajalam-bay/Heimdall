"use client";

import { useEffect, useMemo, useState } from "react";
import { classNames, qty, round2 } from "@/lib/format";

export type StockLine = {
  itemId: string;
  sku: string;
  name: string;
  unit: string;
  available: number;
  trackSerial: boolean;
  trackBatch: boolean;
  batches: string[];
};

export type MovementLine = {
  key: string;
  itemId: string;
  requestedQty: string;
  batchNumber: string;
  serialNumber: string;
  assetTag: string;
  custodianUserId: string;
  notes: string;
};

let seq = 0;
const key = () => `ml-${++seq}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * Shared line editor for stock issues and transfers. Availability is shown per
 * line and the total is checked client-side; the server re-checks against the
 * live ledger before any movement is written.
 */
export function MovementEditor({
  name = "items",
  stock,
  showCustody = false,
  users = [],
  emptyMessage = "This store holds no stock.",
}: {
  name?: string;
  stock: StockLine[];
  showCustody?: boolean;
  users?: Array<{ id: string; name: string; title: string | null }>;
  emptyMessage?: string;
}) {
  const [lines, setLines] = useState<MovementLine[]>([
    { key: key(), itemId: "", requestedQty: "", batchNumber: "", serialNumber: "", assetTag: "", custodianUserId: "", notes: "" },
  ]);

  // Reset when the source store changes and the previous items no longer exist.
  useEffect(() => {
    setLines((prev) =>
      prev.map((l) => (l.itemId && !stock.some((s) => s.itemId === l.itemId) ? { ...l, itemId: "", requestedQty: "" } : l)),
    );
  }, [stock]);

  const patch = (k: string, changes: Partial<MovementLine>) =>
    setLines((prev) => prev.map((l) => (l.key === k ? { ...l, ...changes } : l)));

  const errors = useMemo(() => {
    const out: string[] = [];
    const byItem = new Map<string, number>();
    for (const l of lines) {
      if (!l.itemId) continue;
      byItem.set(l.itemId, (byItem.get(l.itemId) ?? 0) + (Number(l.requestedQty) || 0));
    }
    for (const [itemId, total] of byItem) {
      const s = stock.find((x) => x.itemId === itemId);
      if (!s) continue;
      if (total > s.available + 1e-9) {
        out.push(`${s.name}: requesting ${round2(total)} ${s.unit} but only ${s.available} ${s.unit} is available.`);
      }
    }
    if (!lines.some((l) => l.itemId && Number(l.requestedQty) > 0)) {
      out.push("Add at least one line with a quantity.");
    }
    return out;
  }, [lines, stock]);

  const payload = JSON.stringify(
    lines
      .filter((l) => l.itemId && Number(l.requestedQty) > 0)
      .map((l) => {
        const s = stock.find((x) => x.itemId === l.itemId);
        return {
          itemId: l.itemId,
          requestedQty: Number(l.requestedQty),
          unit: s?.unit ?? "EA",
          batchNumber: l.batchNumber || null,
          serialNumber: l.serialNumber || null,
          assetTag: l.assetTag || null,
          custodianUserId: l.custodianUserId || null,
          notes: l.notes || null,
        };
      }),
  );

  if (stock.length === 0) {
    return (
      <div className="rounded-2xl alert-warning px-3 py-3 text-xs text-[var(--c-warning)]">
        {emptyMessage}
        <input type="hidden" name={name} value="[]" />
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <input type="hidden" name={name} value={payload} />
      <div className="table-wrap rounded-xl border border-border">
        <table className="dt">
          <thead>
            <tr>
              <th style={{ minWidth: "16rem" }}>Item</th>
              <th className="text-right" style={{ width: "8rem" }}>Available</th>
              <th className="text-right" style={{ width: "8rem" }}>Quantity</th>
              <th style={{ width: "10rem" }}>Batch</th>
              <th style={{ width: "10rem" }}>Serial</th>
              {showCustody && <th style={{ width: "12rem" }}>Custodian / asset tag</th>}
              <th style={{ minWidth: "10rem" }}>Notes</th>
              <th style={{ width: "4rem" }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const s = stock.find((x) => x.itemId === l.itemId);
              const over = s ? (Number(l.requestedQty) || 0) > s.available + 1e-9 : false;
              return (
                <tr key={l.key} className={classNames(over && "bg-[var(--c-danger-soft)]/40")}>
                  <td className="align-top">
                    <select
                      className="field"
                      value={l.itemId}
                      onChange={(e) => patch(l.key, { itemId: e.target.value, batchNumber: "", serialNumber: "" })}
                      aria-label="Item"
                    >
                      <option value="">Select item…</option>
                      {stock.map((x) => (
                        <option key={x.itemId} value={x.itemId}>
                          {x.sku} — {x.name} ({x.available} {x.unit})
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num align-top">
                    <span className="tnum inline-block pt-2 text-xs">
                      {s ? qty(s.available, s.unit) : "—"}
                    </span>
                  </td>
                  <td className="align-top">
                    <input
                      className="field text-right"
                      type="number"
                      step="any"
                      min="0"
                      max={s?.available}
                      value={l.requestedQty}
                      onChange={(e) => patch(l.key, { requestedQty: e.target.value })}
                      aria-label="Quantity"
                    />
                  </td>
                  <td className="align-top">
                    {s?.trackBatch && s.batches.length > 0 ? (
                      <select
                        className="field"
                        value={l.batchNumber}
                        onChange={(e) => patch(l.key, { batchNumber: e.target.value })}
                        aria-label="Batch"
                      >
                        <option value="">Any batch</option>
                        {s.batches.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="field"
                        placeholder="—"
                        value={l.batchNumber}
                        onChange={(e) => patch(l.key, { batchNumber: e.target.value })}
                        aria-label="Batch"
                      />
                    )}
                  </td>
                  <td className="align-top">
                    <input
                      className="field"
                      placeholder={s?.trackSerial ? "Serial number" : "—"}
                      value={l.serialNumber}
                      onChange={(e) => patch(l.key, { serialNumber: e.target.value })}
                      aria-label="Serial"
                    />
                  </td>
                  {showCustody && (
                    <td className="align-top">
                      <input
                        className="field mb-1"
                        placeholder="Asset tag"
                        value={l.assetTag}
                        onChange={(e) => patch(l.key, { assetTag: e.target.value })}
                        aria-label="Asset tag"
                      />
                      <select
                        className="field"
                        value={l.custodianUserId}
                        onChange={(e) => patch(l.key, { custodianUserId: e.target.value })}
                        aria-label="Custodian"
                      >
                        <option value="">No custodian</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                  <td className="align-top">
                    <input
                      className="field"
                      value={l.notes}
                      onChange={(e) => patch(l.key, { notes: e.target.value })}
                      aria-label="Notes"
                    />
                  </td>
                  <td className="align-top">
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs text-[var(--c-danger)]"
                      onClick={() => setLines((prev) => (prev.length === 1 ? prev : prev.filter((x) => x.key !== l.key)))}
                      disabled={lines.length === 1}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() =>
            setLines((prev) => [
              ...prev,
              { key: key(), itemId: "", requestedQty: "", batchNumber: "", serialNumber: "", assetTag: "", custodianUserId: "", notes: "" },
            ])
          }
        >
          + Add line
        </button>
      </div>

      {errors.length > 0 && (
        <div className="rounded-2xl alert-warning px-3 py-2">
          <ul className="space-y-0.5 pl-4 text-xs text-[var(--c-warning)]">
            {errors.map((e, i) => (
              <li key={i} className="list-disc">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
