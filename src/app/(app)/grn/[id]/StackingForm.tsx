"use client";

import { useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { FormSection } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { qty } from "@/lib/format";
import { recordStackingAction } from "@/app/(app)/receiving/actions";

const METHODS = ["PALLET", "RACK", "SHELF", "FLOOR", "BULK", "CAGE", "COLD_STORAGE"];
const CLASSES = ["GENERAL", "HIGH_VALUE", "SENSITIVE", "HAZARDOUS", "PROJECT_MATERIAL"];

export type StackCandidate = {
  itemId: string | null;
  description: string;
  quantity: number;
  unit: string;
  suggestedLocationId: string | null;
  suggestedClass: string;
};

type Entry = {
  key: string;
  itemId: string | null;
  description: string;
  quantity: string;
  unit: string;
  locationId: string;
  stackingMethod: string;
  goodsClass: string;
  handlingRequirements: string;
  notes: string;
};

/**
 * Goods stacking. Records where the received material physically went, and how
 * it must be handled — high-value, sensitive and hazardous goods are treated
 * differently from general stock.
 */
export function StackingForm({
  grnId,
  grnNumber,
  storeId,
  storeName,
  candidates,
  locations,
}: {
  grnId: string;
  grnNumber: string;
  storeId: string;
  storeName: string;
  candidates: StackCandidate[];
  locations: Array<{ id: string; label: string; zone: string | null; rack: string | null; bin: string | null; handling: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>(
    candidates.map((c, i) => ({
      key: `c-${i}`,
      itemId: c.itemId,
      description: c.description,
      quantity: String(c.quantity),
      unit: c.unit,
      locationId: c.suggestedLocationId ?? "",
      stackingMethod: c.suggestedClass === "PROJECT_MATERIAL" ? "BULK" : "RACK",
      goodsClass: c.suggestedClass,
      handlingRequirements: "",
      notes: "",
    })),
  );

  const patch = (key: string, changes: Partial<Entry>) =>
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, ...changes } : e)));

  const payload = JSON.stringify(
    entries
      .filter((e) => Number(e.quantity) > 0)
      .map((e) => ({
        itemId: e.itemId,
        description: e.description,
        quantity: Number(e.quantity),
        unit: e.unit,
        locationId: e.locationId || null,
        stackingMethod: e.stackingMethod,
        goodsClass: e.goodsClass,
        handlingRequirements: e.handlingRequirements.trim() || null,
        notes: e.notes.trim() || null,
      })),
  );

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Record stacking
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Record goods stacking — ${grnNumber}`}
        description={`Where the received material has been put away in ${storeName}, and any special handling it needs.`}
        size="xl"
      >
        <ActionForm
          action={recordStackingAction}
          layout="bare"
          submitLabel="Record stacking"
          hiddenFields={{ grnId, storeId, entries: payload }}
          onSuccessRedirect={`/grn/${grnId}`}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          {locations.length === 0 && (
            <InlineAlert tone="warning">
              This store has no bin locations configured. Stacking can still be recorded, but assigning a bin makes stock
              findable. Locations are managed under Admin → Stores &amp; locations.
            </InlineAlert>
          )}

          <FormSection columns={1}>
            <div className="sm:col-span-full overflow-hidden rounded-xl border border-border">
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th style={{ minWidth: "14rem" }}>Material</th>
                      <th className="text-right" style={{ width: "7rem" }}>Quantity</th>
                      <th style={{ width: "12rem" }}>Bin location</th>
                      <th style={{ width: "9rem" }}>Method</th>
                      <th style={{ width: "11rem" }}>Goods class</th>
                      <th style={{ minWidth: "14rem" }}>Handling requirements</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => (
                      <tr key={e.key}>
                        <td className="align-top">
                          <input
                            className="field"
                            value={e.description}
                            onChange={(ev) => patch(e.key, { description: ev.target.value })}
                            aria-label="Material description"
                          />
                        </td>
                        <td className="align-top">
                          <input
                            className="field text-right"
                            type="number"
                            step="any"
                            min="0"
                            value={e.quantity}
                            onChange={(ev) => patch(e.key, { quantity: ev.target.value })}
                            aria-label="Quantity stacked"
                          />
                          <span className="mt-1 block text-center text-2xs text-[var(--c-text-tertiary)]">{e.unit}</span>
                        </td>
                        <td className="align-top">
                          <select
                            className="field"
                            value={e.locationId}
                            onChange={(ev) => patch(e.key, { locationId: ev.target.value })}
                            aria-label="Bin location"
                          >
                            <option value="">Unassigned</option>
                            {locations.map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.label} · {humanize(l.handling)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="align-top">
                          <select
                            className="field"
                            value={e.stackingMethod}
                            onChange={(ev) => patch(e.key, { stackingMethod: ev.target.value })}
                            aria-label="Stacking method"
                          >
                            {METHODS.map((m) => (
                              <option key={m} value={m}>
                                {humanize(m)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="align-top">
                          <select
                            className="field"
                            value={e.goodsClass}
                            onChange={(ev) => patch(e.key, { goodsClass: ev.target.value })}
                            aria-label="Goods class"
                          >
                            {CLASSES.map((c) => (
                              <option key={c} value={c}>
                                {humanize(c)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="align-top">
                          <textarea
                            className="field"
                            rows={2}
                            placeholder="Stack height, dunnage, temperature, segregation, access control…"
                            value={e.handlingRequirements}
                            onChange={(ev) => patch(e.key, { handlingRequirements: ev.target.value })}
                          />
                          <input
                            className="field mt-1"
                            placeholder="Notes"
                            value={e.notes}
                            onChange={(ev) => patch(e.key, { notes: ev.target.value })}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="sm:col-span-full">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() =>
                  setEntries((prev) => [
                    ...prev,
                    {
                      key: `manual-${prev.length}-${Math.random().toString(36).slice(2, 6)}`,
                      itemId: null,
                      description: "",
                      quantity: "1",
                      unit: "EA",
                      locationId: "",
                      stackingMethod: "RACK",
                      goodsClass: "GENERAL",
                      handlingRequirements: "",
                      notes: "",
                    },
                  ])
                }
              >
                + Add entry
              </button>
            </div>
          </FormSection>
        </ActionForm>
      </Modal>
    </>
  );
}
