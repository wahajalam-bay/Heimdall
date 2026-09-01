"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { createLossReportAction } from "../actions";

type Line = {
  description: string;
  quantity: string;
  unit: string;
  itemId: string;
  assetId: string;
  serial: string;
  unitValue: string;
};

const EMPTY: Line = {
  description: "",
  quantity: "1",
  unit: "EA",
  itemId: "",
  assetId: "",
  serial: "",
  unitValue: "",
};

/**
 * Filing a loss report.
 *
 * "Unexplained shortage" is the default kind, and deliberately so. Calling a
 * shortage theft is an accusation; calling it a loss implies somebody knows what
 * happened. Making the honest answer the easy one is what keeps the register
 * from filling with wrong labels.
 */
export function LossReportForm({
  entityId,
  stores,
  items,
  assets,
}: {
  entityId: string;
  stores: Array<{ id: string; name: string }>;
  items: Array<{ id: string; label: string; unit: string }>;
  assets: Array<{ id: string; label: string }>;
}) {
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY }]);
  const [type, setType] = useState("SHORTAGE_UNEXPLAINED");
  const [police, setPolice] = useState("false");

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const today = new Date().toISOString().slice(0, 10);
  const estimated = lines.reduce(
    (a, l) => a + (Number(l.quantity) || 0) * (Number(l.unitValue) || 0),
    0,
  );

  return (
    <ActionForm
      action={createLossReportAction}
      submitLabel="File the report"
      hiddenFields={{ entityId }}
      onSuccessRedirect="/inventory/losses"
    >
      <FormSection columns={2}>
        <Field
          label="What kind"
          name="lossType"
          required
          hint="Unexplained shortage is the honest answer where nobody knows what happened — and the most common one."
        >
          <Select
            name="lossType"
            required
            value={type}
            onChange={(e) => setType(e.target.value)}
            options={[
              { value: "SHORTAGE_UNEXPLAINED", label: "Unexplained shortage — we cannot account for it" },
              { value: "LOSS", label: "Loss — we know how it went" },
              { value: "THEFT", label: "Theft" },
              { value: "DAMAGE", label: "Damage" },
              { value: "MISPLACED", label: "Misplaced — expected to turn up" },
            ]}
          />
        </Field>
        <Field label="Store" name="storeId" hint="Leave blank if it was not in a store.">
          <Select
            name="storeId"
            placeholder="No store"
            options={stores.map((s) => ({ value: s.id, label: s.name }))}
          />
        </Field>
        <Field label="Title" name="title" required>
          <TextInput name="title" required placeholder="Short summary for the register" />
        </Field>
        <Field label="Discovered on" name="discoveredOn" required>
          <TextInput type="date" name="discoveredOn" required defaultValue={today} max={today} />
        </Field>
        <Field
          label="Believed to have happened on"
          name="occurredOn"
          hint="Leave blank if unknown — rarely the same day it was found."
        >
          <TextInput type="date" name="occurredOn" max={today} />
        </Field>
        <Field
          label="How it came to light"
          name="discoveryRoute"
          hint="A stock count, a cupboard found open, a complaint. Often the most useful fact in the file."
        >
          <TextInput name="discoveryRoute" />
        </Field>
      </FormSection>

      <Field
        label="What happened"
        name="description"
        required
        hint="Read by somebody who was not there. Two words will not tell them anything."
      >
        <TextArea name="description" rows={4} required />
      </Field>

      {type === "THEFT" && (
        <FormSection columns={2}>
          <Field label="Reported to the police" name="policeReported">
            <Select
              name="policeReported"
              value={police}
              onChange={(e) => setPolice(e.target.value)}
              options={[
                { value: "false", label: "Not reported" },
                { value: "true", label: "Reported" },
              ]}
            />
          </Field>
          {police === "true" && (
            <Field
              label="Police reference"
              name="policeReference"
              required
              hint="A report marked as reported with no reference cannot be followed up."
            >
              <TextInput name="policeReference" required />
            </Field>
          )}
        </FormSection>
      )}

      <Field
        label="Anything about who or how"
        name="suspicionNote"
        hint="Free text on purpose. Naming a person in a structured field turns a suspicion into a record about them, which a form entry should not do."
      >
        <TextArea name="suspicionNote" rows={2} />
      </Field>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="label">What is missing</span>
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            onClick={() => setLines((ls) => [...ls, { ...EMPTY }])}
          >
            Add a line
          </button>
        </div>

        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ minWidth: "12rem" }}>Description</th>
                <th style={{ minWidth: "11rem" }}>Catalogue item</th>
                <th style={{ minWidth: "10rem" }}>Asset tag</th>
                <th style={{ width: "5rem" }}>Qty</th>
                <th style={{ width: "8rem" }}>Serial</th>
                <th style={{ width: "8rem" }}>Unit value</th>
                <th style={{ width: "3rem" }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <input
                      className="field"
                      name="lineDescription"
                      value={l.description}
                      onChange={(e) => setLine(i, { description: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="field"
                      name="lineItemId"
                      value={l.itemId}
                      onChange={(e) => {
                        const chosen = items.find((it) => it.id === e.target.value);
                        setLine(i, {
                          itemId: e.target.value,
                          unit: chosen?.unit ?? l.unit,
                          description: l.description || (chosen?.label ?? ""),
                        });
                      }}
                    >
                      <option value="">Not in the catalogue</option>
                      {items.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.label}
                        </option>
                      ))}
                    </select>
                    <input type="hidden" name="lineUnit" value={l.unit} />
                  </td>
                  <td>
                    <select
                      className="field"
                      name="lineAssetId"
                      value={l.assetId}
                      onChange={(e) => setLine(i, { assetId: e.target.value })}
                    >
                      <option value="">Not tagged</option>
                      {assets.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="field"
                      type="number"
                      step="any"
                      min="0"
                      name="lineQuantity"
                      value={l.quantity}
                      onChange={(e) => setLine(i, { quantity: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      name="lineSerial"
                      value={l.serial}
                      onChange={(e) => setLine(i, { serial: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      type="number"
                      step="any"
                      min="0"
                      name="lineUnitValue"
                      value={l.unitValue}
                      onChange={(e) => setLine(i, { unitValue: e.target.value })}
                      placeholder="from ledger"
                    />
                  </td>
                  <td>
                    {lines.length > 1 && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <InlineAlert tone="info">
        Leave a unit value blank and it is taken from the inventory ledger&rsquo;s cost for that item — a loss valued
        at zero disappears from every figure it belongs in.
        {estimated > 0 && (
          <span className="mt-1 block">
            Estimated so far: {estimated.toLocaleString("en-PK", { maximumFractionDigits: 2 })}.
          </span>
        )}
      </InlineAlert>
    </ActionForm>
  );
}
