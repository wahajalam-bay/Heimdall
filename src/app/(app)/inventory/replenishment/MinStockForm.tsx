"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { setMinimumStockAction } from "./actions";

type Row = {
  id: string;
  label: string;
  current: number;
  suggested: number | null;
  unit: string;
};

/**
 * Records a minimum stock level and the ground it rests on.
 *
 * The basis is not decoration. ZAM/PUR/SOP-01 §3.3 gives Manager Logistics two
 * grounds for a minimum — past consumption, or the advice of the requesting
 * department's POC — and they are not interchangeable. Consumption is evidence
 * and cites the ledger; POC advice is judgement and has to name whose.
 */
export function MinStockForm({ items }: { items: Row[] }) {
  const [itemId, setItemId] = useState("");
  const [basis, setBasis] = useState("CONSUMPTION");
  const item = items.find((i) => i.id === itemId);

  return (
    <ActionForm action={setMinimumStockAction} layout="bare" submitLabel="Record minimum">
      <FormSection columns={2}>
        <Field label="Item" name="itemId" required>
          <Select
            name="itemId"
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
            required
            placeholder="Choose an item…"
            options={items.map((i) => ({ value: i.id, label: i.label }))}
          />
        </Field>

        <Field
          label="Minimum level"
          name="level"
          hint={
            item
              ? `Currently ${item.current} ${item.unit}.` +
                (item.suggested !== null ? ` Consumption history suggests ${item.suggested} ${item.unit}.` : "")
              : "Blank removes the minimum, and the item stops appearing here."
          }
        >
          <TextInput
            type="number"
            step="any"
            min="0"
            name="level"
            key={itemId}
            defaultValue={item?.suggested ?? item?.current ?? ""}
          />
        </Field>

        <Field label="Basis" name="basis" required>
          <Select
            name="basis"
            value={basis}
            onChange={(e) => setBasis(e.target.value)}
            required
            options={[
              { value: "CONSUMPTION", label: "Derived from consumption history" },
              { value: "POC_ADVICE", label: "On the advice of the department POC" },
              { value: "MANUAL", label: "Set by hand" },
            ]}
          />
        </Field>

        <Field
          label={basis === "POC_ADVICE" ? "Who advised, and what they said" : "Note"}
          name="note"
          required={basis === "POC_ADVICE"}
          hint={
            basis === "POC_ADVICE"
              ? "Name the POC and the date. Unattributed advice is hearsay."
              : "Optional — anything a reviewer would want to know."
          }
        >
          <TextArea name="note" rows={2} required={basis === "POC_ADVICE"} />
        </Field>
      </FormSection>

      {basis === "MANUAL" && (
        <InlineAlert tone="warning">
          A hand-set minimum records that a person chose the number, and nothing about why. §3.3 offers two grounds
          that can be checked; this is neither, and the row will keep showing as unattributed.
        </InlineAlert>
      )}
    </ActionForm>
  );
}
