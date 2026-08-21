"use client";

import { useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { adjustStockAction } from "@/app/(app)/stores/actions";

/**
 * Manual stock adjustment. Deliberately friction-heavy: a substantive reason is
 * mandatory and the movement lands in the same immutable ledger as every other
 * inventory change.
 */
export function AdjustStockForm({
  stores,
  items,
}: {
  stores: Array<{ id: string; code: string; name: string; kind: string }>;
  items: Array<{ id: string; sku: string; name: string; unit: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<"increase" | "decrease">("decrease");
  const [magnitude, setMagnitude] = useState("");
  const [itemId, setItemId] = useState("");

  const item = items.find((i) => i.id === itemId);
  const signed = direction === "increase" ? Number(magnitude) || 0 : -(Number(magnitude) || 0);

  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        Adjust stock
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Adjust stock"
        description="For physical count variances, write-offs and corrections. Every adjustment is a permanent ledger entry attributed to you."
        size="lg"
      >
        <ActionForm
          action={adjustStockAction}
          layout="bare"
          submitLabel="Record adjustment"
          hiddenFields={{ quantityDelta: String(signed), unit: item?.unit ?? "EA" }}
          onSuccessRedirect="/inventory"
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <InlineAlert tone="warning">
            Adjustments bypass the receipt and issue controls, so they are the most closely audited movement type. Use a
            GRN, issue or transfer wherever one applies.
          </InlineAlert>

          <FormSection columns={2}>
            <Field label="Store" name="storeId" required>
              <Select
                name="storeId"
                placeholder="Select store…"
                options={stores.map((s) => ({ value: s.id, label: `${s.name} · ${humanize(s.kind)}` }))}
              />
            </Field>
            <Field label="Item" name="itemId" required>
              <Select
                name="itemId"
                placeholder="Select item…"
                options={items.map((i) => ({ value: i.id, label: `${i.sku} — ${i.name}` }))}
                value={itemId}
                onChange={(e) => setItemId(e.target.value)}
              />
            </Field>
            <Field label="Direction" name="direction" required>
              <Select
                name="direction"
                value={direction}
                onChange={(e) => setDirection(e.target.value as "increase" | "decrease")}
                options={[
                  { value: "decrease", label: "Decrease — write-off, loss, count short" },
                  { value: "increase", label: "Increase — count surplus, found stock" },
                ]}
              />
            </Field>
            <Field
              label={`Quantity to ${direction}`}
              name="magnitude"
              required
              hint={item ? `Unit of measure: ${item.unit}` : undefined}
            >
              <TextInput
                type="number"
                step="any"
                min="0"
                name="magnitude"
                value={magnitude}
                onChange={(e) => setMagnitude(e.target.value)}
              />
            </Field>
            <Field label="Batch number" name="batchNumber" hint="Leave blank for unbatched stock.">
              <TextInput name="batchNumber" />
            </Field>
            <Field label="Serial number" name="serialNumber" hint="Leave blank for non-serialised stock.">
              <TextInput name="serialNumber" />
            </Field>
            <Field
              label="Reason"
              name="reason"
              required
              span
              hint="At least a sentence. State what was counted, what was found, and what evidence exists."
            >
              <TextArea
                name="reason"
                rows={4}
                placeholder="e.g. Quarterly physical count variance: 3 reams water-damaged by a pantry leak and written off. Damaged stock photographed and disposed of."
              />
            </Field>
          </FormSection>

          {signed !== 0 && (
            <InlineAlert tone={signed < 0 ? "danger" : "info"}>
              This will {signed < 0 ? "reduce" : "increase"} the balance by{" "}
              <span className="font-600">
                {Math.abs(signed)} {item?.unit ?? "units"}
              </span>
              . An outbound adjustment is refused if the store does not hold that much free stock.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}
