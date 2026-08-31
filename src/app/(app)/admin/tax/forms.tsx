"use client";

import { ActionForm } from "@/components/ui/forms";
import { Field } from "@/components/ui/field";
import { SectionCard } from "@/components/ui/primitives";
import { createTaxRuleAction } from "./actions";

/**
 * Adding a rate.
 *
 * The source reference is asked for rather than optional-in-spirit: a percentage
 * with no SRO, circular or ordinance clause behind it is how 18% and 16% ended up
 * in this system in the first place.
 */
export function NewTaxRuleForm({
  entities,
}: {
  entities: Array<{ id: string; code: string; name: string }>;
}) {
  const today = new Date().toISOString().slice(0, 10);

  return (
    <SectionCard
      title="Record a tax rate"
      description="Effective-dated. To change a rate, close the old one off and record a new one — editing would restate transactions the old rate already priced."
    >
      <ActionForm
        action={createTaxRuleAction}
        layout="bare"
        submitLabel="Record rate"
        resetOnSuccess
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Code" name="code" hint="Short, e.g. GST or WHT-153.">
            <input className="field" name="code" required maxLength={20} placeholder="GST" />
          </Field>

          <Field label="Name" name="name">
            <input
              className="field"
              name="name"
              required
              maxLength={80}
              placeholder="General Sales Tax"
            />
          </Field>

          <Field
            label="Applies to"
            name="appliesTo"
            hint="Goods and services can carry different taxes."
          >
            <select className="field" name="appliesTo" defaultValue="BOTH">
              <option value="BOTH">Goods and services</option>
              <option value="GOODS">Goods only</option>
              <option value="SERVICES">Services only</option>
            </select>
          </Field>

          <Field label="Method" name="method">
            <select className="field" name="method" defaultValue="PERCENT">
              <option value="PERCENT">Percentage of line value</option>
              <option value="FIXED">Fixed amount per line</option>
            </select>
          </Field>

          <Field label="Rate" name="percent" hint="A percentage, or the fixed amount in PKR.">
            <input
              className="field"
              name="percent"
              type="number"
              step="0.01"
              min="0"
              required
              placeholder="18"
            />
          </Field>

          <Field
            label="Vendor tax status"
            name="vendorTaxStatus"
            hint="Where the rate depends on whether the vendor is a filer."
          >
            <select className="field" name="vendorTaxStatus" defaultValue="ANY">
              <option value="ANY">Any</option>
              <option value="FILER">Filer only</option>
              <option value="NON_FILER">Non-filer only</option>
            </select>
          </Field>

          <Field
            label="Entity"
            name="entityId"
            hint="Leave blank to apply group-wide. An entity's own rate supersedes it."
          >
            <select className="field" name="entityId" defaultValue="">
              <option value="">All entities</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.code} — {e.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Effective from" name="effectiveFrom">
            <input className="field" name="effectiveFrom" type="date" required defaultValue={today} />
          </Field>

          <Field
            label="Effective to"
            name="effectiveTo"
            hint="Leave blank while the rate is open-ended."
          >
            <input className="field" name="effectiveTo" type="date" />
          </Field>

          <Field
            label="Source reference"
            name="sourceReference"
            hint="The SRO, circular or ordinance clause this rate comes from."
          >
            <input
              className="field"
              name="sourceReference"
              maxLength={160}
              placeholder="Sales Tax Act 1990, s.3(1)(a)"
            />
          </Field>

          <Field
            label="Withholding"
            name="withholding"
            hint="Retained from the vendor's payment rather than added to the invoice."
          >
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" name="withholding" />
              This is a withholding tax
            </label>
          </Field>
        </div>
      </ActionForm>
    </SectionCard>
  );
}
