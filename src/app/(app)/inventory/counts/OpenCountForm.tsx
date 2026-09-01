"use client";

import { useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Field, FormSection, Select, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { openStockCountAction } from "./actions";

export function OpenCountForm({
  stores,
  categories,
}: {
  stores: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; label: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("CYCLE");

  return (
    <div className="flex justify-end">
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Open a count
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Open a stock count"
        description="The ledger is frozen against the sheet the moment it is cut, so stock that moves during the count shows up as a movement rather than as a discrepancy."
        size="md"
      >
        <ActionForm
          action={openStockCountAction}
          layout="bare"
          submitLabel="Cut the sheet"
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={2}>
            <Field label="Store" name="storeId" required>
              <Select
                name="storeId"
                required
                placeholder="Choose the store…"
                options={stores.map((s) => ({ value: s.id, label: s.name }))}
              />
            </Field>
            <Field label="Type" name="countType" required>
              <Select
                name="countType"
                required
                value={type}
                onChange={(e) => setType(e.target.value)}
                options={[
                  { value: "CYCLE", label: "Cycle — a slice on a rota" },
                  { value: "FULL", label: "Full — the whole store" },
                  { value: "SPOT", label: "Spot — one thing in particular" },
                ]}
              />
            </Field>
            {type !== "FULL" && (
              <Field label="Limit to a category" name="categoryId" hint="Leave blank for everything in the store.">
                <Select
                  name="categoryId"
                  placeholder="All categories"
                  options={categories.map((c) => ({ value: c.id, label: c.label }))}
                />
              </Field>
            )}
            <Field label="Scope note" name="scopeNote">
              <TextInput name="scopeNote" placeholder="Why this count, or what it covers" />
            </Field>
          </FormSection>

          <InlineAlert tone="info">
            Only one count may be open on a store at a time. Two sheets running together produce two sets of expected
            quantities and neither can be trusted.
          </InlineAlert>
        </ActionForm>
      </Modal>
    </div>
  );
}
