"use client";

import { ActionForm } from "@/components/ui/forms";
import { Checkbox, Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { upsertTaxAction } from "../actions";

/**
 * Adding or amending a rate.
 *
 * The withholding flag matters more than it looks: a rate marked withheld is
 * subtracted from the vendor's payment, and one that is not is added to the
 * amount owed. Getting it the wrong way round pays the vendor twice the tax.
 */
export function TaxForm({ entities }: { entities: Array<{ id: string; code: string; name: string }> }) {
  return (
    <ActionForm action={upsertTaxAction} submitLabel="Save rate" resetOnSuccess>
      <FormSection title="Add or amend a rate" description="Codes are unique; saving an existing code amends it.">
        <Field label="Code" required hint="Short, unique, e.g. GST-18.">
          <TextInput name="code" required placeholder="GST-18" />
        </Field>
        <Field label="Name" required>
          <TextInput name="name" required placeholder="General sales tax at 18%" />
        </Field>
        <Field label="Type" required>
          <Select
            name="type"
            defaultValue="SALES"
            options={[
              { value: "SALES", label: "Sales tax" },
              { value: "INCOME", label: "Income tax" },
              { value: "WITHHOLDING", label: "Withholding tax" },
              { value: "FED", label: "Federal excise" },
              { value: "PROVINCIAL", label: "Provincial" },
              { value: "CUSTOMS", label: "Customs" },
              { value: "OTHER", label: "Other" },
            ]}
          />
        </Field>
        <Field label="Rate (%)" required>
          <TextInput type="number" step="any" min="0" max="100" name="rate" required placeholder="18" />
        </Field>
        <Field label="Entity" hint="Leave blank to apply to every entity.">
          <Select
            name="entityId"
            defaultValue=""
            placeholder="All entities"
            options={entities.map((e) => ({ value: e.id, label: `${e.code} — ${e.name}` }))}
          />
        </Field>
        <Field label="Ledger account">
          <TextInput name="glAccount" placeholder="Optional" />
        </Field>
        <Field label="Direction" span>
          <Checkbox
            name="withheld"
            label="Withheld from the vendor's payment"
            hint="Leave unticked for a tax added to the amount owed."
          />
        </Field>
        <Field label="Notes" span>
          <TextArea name="notes" rows={2} placeholder="Where this rate comes from, and when it changed." />
        </Field>
      </FormSection>
    </ActionForm>
  );
}
