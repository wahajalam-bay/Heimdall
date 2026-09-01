"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { Badge, InlineAlert } from "@/components/ui/primitives";
import { createEmployeeReturnAction } from "../actions";

type Line = {
  description: string;
  quantity: string;
  unit: string;
  itemId: string;
  assetId: string;
  serial: string;
  condition: string;
  conditionNote: string;
};

const EMPTY: Line = {
  description: "",
  quantity: "1",
  unit: "EA",
  itemId: "",
  assetId: "",
  serial: "",
  condition: "GOOD",
  conditionNote: "",
};

/**
 * The Store Receiving Note.
 *
 * Naming the catalogue item or the asset tag is what decides whether the IT
 * inspection applies, so the form shows that consequence as the line is filled
 * in rather than springing it after submission.
 */
export function ReceiveReturnForm({
  stores,
  people,
  items,
  assets,
}: {
  stores: Array<{ id: string; name: string }>;
  people: Array<{ id: string; label: string; name: string }>;
  items: Array<{ id: string; label: string; unit: string; isIt: boolean }>;
  assets: Array<{ id: string; label: string }>;
}) {
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY }]);
  const [knownPerson, setKnownPerson] = useState(true);

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const anyIt = lines.some((l) => items.find((it) => it.id === l.itemId)?.isIt);

  return (
    <ActionForm
      action={createEmployeeReturnAction}
      submitLabel="Record the receiving note"
      onSuccessRedirect="/inventory/returns"
    >
      <FormSection columns={2}>
        <Field label="Store receiving it" name="storeId" required>
          <Select
            name="storeId"
            required
            placeholder="Choose the store…"
            options={stores.map((s) => ({ value: s.id, label: s.name }))}
          />
        </Field>
        <Field label="Who is handing it back" name="_who">
          <Select
            name="_who"
            value={knownPerson ? "user" : "name"}
            onChange={(e) => setKnownPerson(e.target.value === "user")}
            options={[
              { value: "user", label: "A person on the system" },
              { value: "name", label: "By name — their account is gone" },
            ]}
          />
        </Field>
        {knownPerson ? (
          <Field label="Person" name="returnedById" required>
            <Select
              name="returnedById"
              required
              placeholder="Choose…"
              options={people.map((p) => ({ value: p.id, label: p.label }))}
            />
          </Field>
        ) : null}
        <Field
          label="Name for the record"
          name="returnedByName"
          required
          hint="A leaver's account is often already disabled by the time the equipment arrives, so the name is what the record keeps."
        >
          <TextInput name="returnedByName" required />
        </Field>
        <Field label="Department" name="department">
          <TextInput name="department" />
        </Field>
        <Field label="Why it is coming back" name="reason" required>
          <Select
            name="reason"
            required
            defaultValue="RESIGNATION"
            options={[
              { value: "RESIGNATION", label: "Leaving the company" },
              { value: "TRANSFER", label: "Transfer" },
              { value: "ROLE_CHANGE", label: "Role change" },
              { value: "UPGRADE", label: "Replaced with an upgrade" },
              { value: "FAULTY", label: "Faulty" },
              { value: "END_OF_PROJECT", label: "End of project" },
              { value: "OTHER", label: "Other" },
            ]}
          />
        </Field>
      </FormSection>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="label">What came back</span>
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
                <th style={{ width: "8rem" }}>Condition</th>
                <th style={{ minWidth: "10rem" }}>What is wrong</th>
                <th style={{ width: "3rem" }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const item = items.find((it) => it.id === l.itemId);
                return (
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
                      {item?.isIt && (
                        <Badge tone="info" className="mt-1">
                          IT — will be inspected
                        </Badge>
                      )}
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
                      <input type="hidden" name="lineUnit" value={l.unit} />
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
                      <select
                        className="field"
                        name="lineCondition"
                        value={l.condition}
                        onChange={(e) => setLine(i, { condition: e.target.value })}
                      >
                        <option value="GOOD">Good</option>
                        <option value="USABLE">Usable</option>
                        <option value="DAMAGED">Damaged</option>
                        <option value="FAULTY">Faulty</option>
                        <option value="BEYOND_REPAIR">Beyond repair</option>
                      </select>
                    </td>
                    <td>
                      <input
                        className="field"
                        name="lineConditionNote"
                        value={l.conditionNote}
                        onChange={(e) => setLine(i, { conditionNote: e.target.value })}
                        placeholder={l.condition !== "GOOD" ? "Required" : ""}
                        required={l.condition !== "GOOD"}
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
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Field label="Receipt notes" name="receiptNotes">
        <TextArea name="receiptNotes" rows={2} />
      </Field>

      <InlineAlert tone={anyIt ? "warning" : "info"}>
        {anyIt
          ? "This return holds IT equipment, so the SOP sends it for inspection before anything is stacked. A unit that fails goes to Repair and Maintenance, not back on the shelf."
          : "No IT equipment on this note, so no inspection applies — the SOP inspects IT equipment only."}
      </InlineAlert>
    </ActionForm>
  );
}
