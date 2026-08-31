"use client";

import { ActionButton, ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea } from "@/components/ui/field";
import type { CostAnalysis } from "@/server/cost-analysis";
import { SectionCard } from "@/components/ui/primitives";
import { MANUAL_SOURCE_TYPES } from "@/lib/domain";
import {
  addManualComparisonAction,
  saveCostAnalysisAction,
  verifyCostAnalysisAction,
} from "./actions";

/**
 * Answering what the form asks.
 *
 * The three yes/no questions default to unanswered rather than to "no": the
 * paper form has a blank there until somebody decides, and a stored "no" that
 * nobody chose is exactly the kind of quiet default this system exists to avoid.
 */

const YES_NO = [
  { value: "", label: "Not answered" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

function tri(v: boolean | null): string {
  return v === null ? "" : v ? "yes" : "no";
}

export function CostAnalysisForm({ comparativeId, form }: { comparativeId: string; form: CostAnalysis }) {
  const awarded = form.vendors.find((v) => v.isSelected);
  const lowest = form.vendors.find((v) => v.isLowest);
  const aboveLowest = Boolean(awarded && lowest && awarded.vendorId !== lowest.vendorId);

  return (
    <ActionForm
      action={saveCostAnalysisAction}
      submitLabel="Save cost analysis"
      successMessage="Cost analysis form saved."
      hiddenFields={{ comparativeId }}
    >
      <FormSection
        title="Compliance"
        columns={2}
        description="The three questions the form asks before an award can be signed off."
      >
        <Field label="Is the vendor single sourced?" name="singleSourced">
          <Select name="singleSourced" options={YES_NO} defaultValue={tri(form.singleSourced)} />
        </Field>
        <Field label="Are rates already locked with the vendor?" name="ratesLocked">
          <Select name="ratesLocked" options={YES_NO} defaultValue={tri(form.ratesLocked)} />
        </Field>
        <Field label="Is the vendor selection form fulfilled and approved?" name="vendorSelectionForm">
          <Select name="vendorSelectionForm" options={YES_NO} defaultValue={tri(form.vendorSelectionForm)} />
        </Field>
        <Field
          label="Reason for approving higher rates"
          name="higherRateReason"
          span="full"
          required={aboveLowest}
          hint={
            aboveLowest
              ? `${awarded?.vendorName} is not the lowest quotation, so the form cannot be signed without a stated reason.`
              : "Required only where the award is above the lowest quotation."
          }
        >
          <TextArea name="higherRateReason" rows={2} defaultValue={form.higherRateReason ?? ""} />
        </Field>
      </FormSection>

      <FormSection title="Charging and tax" columns={2}>
        <Field label="Invoice charged to" name="invoiceChargedTo">
          <input className="field" name="invoiceChargedTo" defaultValue={form.invoiceChargedTo ?? ""} />
        </Field>
        {form.layout.computesTax ? (
          <Field
            label="Tax rate (%)"
            name="taxPercent"
            hint={
              form.taxPercent === null
                ? "No rate is configured for this entity, so the sheet prints the tax line as unset. Set one under Policy."
                : (form.taxBasis ?? "From the entity's policy pack.")
            }
          >
            <input
              className="field"
              name="taxPercent"
              type="number"
              step="0.01"
              defaultValue={form.taxPercent ?? ""}
              readOnly
            />
          </Field>
        ) : (
          <Field
            label="GST / Tax"
            name="taxNote"
            hint={`${form.layout.label} carries tax as a stated term rather than a computed row, so there is no rate to apply here.`}
          >
            <input className="field" value="As per quotation" readOnly />
          </Field>
        )}
      </FormSection>

      <FormSection
        title="Terms offered"
        columns={1}
        description="What each vendor committed to. These print in the terms grid on the form."
      >
        <div className="table-wrap sm:col-span-full">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ minWidth: "10rem" }}>Vendor</th>
                <th style={{ minWidth: "9rem" }}>Payment terms</th>
                <th style={{ minWidth: "11rem" }}>Specifications</th>
                <th style={{ minWidth: "10rem" }}>Delivery / completion</th>
                <th style={{ minWidth: "10rem" }}>Tax information</th>
              </tr>
            </thead>
            <tbody>
              {form.vendors.map((v) => (
                <tr key={v.lineId}>
                  <td className="text-xs font-500">{v.vendorName}</td>
                  <td>
                    <input
                      className="field"
                      name={`terms.${v.lineId}.paymentTerms`}
                      defaultValue={v.paymentTerms ?? ""}
                      placeholder="Credit"
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      name={`terms.${v.lineId}.specifications`}
                      defaultValue={v.specifications ?? ""}
                      placeholder="As per requirement"
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      name={`terms.${v.lineId}.deliveryCommitment`}
                      defaultValue={v.deliveryCommitment ?? ""}
                      placeholder="5 days"
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      name={`terms.${v.lineId}.taxInformation`}
                      defaultValue={v.taxInformation ?? ""}
                      placeholder="Commercial invoice"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </FormSection>

      <FormSection title="Notes" columns={2}>
        <Field label="Remarks" name="remarks">
          <TextArea name="remarks" rows={2} defaultValue={form.remarks ?? ""} />
        </Field>
        <Field label="Special notes" name="specialNotes">
          <TextArea name="specialNotes" rows={2} defaultValue={form.specialNotes ?? ""} />
        </Field>
      </FormSection>
    </ActionForm>
  );
}

/** The second signature. Refused server-side when it is the preparer's own. */
export function VerifyForm({ comparativeId, disabled }: { comparativeId: string; disabled?: boolean }) {
  return (
    <ActionButton
      action={verifyCostAnalysisAction}
      label="Verify form"
      tone="primary"
      payload={{ comparativeId }}
      disabled={disabled}
      disabledReason="Answer everything the form asks before verifying it."
      confirm="Verify this cost analysis form? Your name is recorded as the second signature."
    />
  );
}


/**
 * Adding a comparison option that is not a vendor quotation.
 *
 * The reason field is required and it is not bureaucracy: a price from a call
 * carries less weight than a price from a submitted quotation, and a reader can
 * only judge that if the sheet says which it is.
 */
export function ManualComparisonForm({
  comparativeId,
  vendors,
  taxRules,
  units,
}: {
  comparativeId: string;
  vendors: Array<{ id: string; name: string }>;
  taxRules: Array<{ id: string; code: string; name: string; percent: number }>;
  units: string[];
}) {
  return (
    <SectionCard
      title="Add a manual comparison option"
      description="For a price list, a rate contract, a prior purchase or a verbal indication — anything that is real evidence but not a submitted quotation. It appears on the sheet labelled MANUAL and cannot be awarded against."
    >
      <ActionForm
        action={addManualComparisonAction}
        layout="bare"
        hiddenFields={{ comparativeId }}
        submitLabel="Add option"
        resetOnSuccess
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Source" name="sourceName" hint="Who or what quoted this price.">
            <input className="field" name="sourceName" required maxLength={120} placeholder="Al-Karam Traders" />
          </Field>

          <Field label="Registered vendor" name="vendorId" hint="Optional — link it where the source is a known vendor.">
            <select className="field" name="vendorId" defaultValue="">
              <option value="">Not a registered vendor</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Kind of source" name="sourceType">
            <select className="field" name="sourceType" defaultValue="PRICE_LIST">
              {MANUAL_SOURCE_TYPES.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Description" name="description" span>
            <input
              className="field"
              name="description"
              required
              maxLength={200}
              placeholder="What this price is for"
            />
          </Field>

          <Field label="Unit" name="unit">
            <select className="field" name="unit" defaultValue={units[0] ?? "EA"}>
              {units.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Quantity" name="quantity">
            <input className="field" name="quantity" type="number" step="0.01" min="0.01" required />
          </Field>

          <Field label="Rate" name="rate" hint="Per unit, before tax.">
            <input className="field" name="rate" type="number" step="0.01" min="0" required />
          </Field>

          <Field
            label="Tax"
            name="taxRuleId"
            hint={
              taxRules.length
                ? "From the tax master."
                : "No tax rates are configured, so tax shows as unset on the sheet."
            }
          >
            <select className="field" name="taxRuleId" defaultValue="">
              <option value="">No tax / unset</option>
              {taxRules.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} — {t.percent}%
                </option>
              ))}
            </select>
          </Field>

          <Field label="Delivery terms" name="deliveryTerms">
            <input className="field" name="deliveryTerms" maxLength={120} />
          </Field>

          <Field label="Payment terms" name="paymentTerms">
            <input className="field" name="paymentTerms" maxLength={120} />
          </Field>

          <Field label="Price valid until" name="validUntil">
            <input className="field" name="validUntil" type="date" />
          </Field>

          <Field
            label="Evidence reference"
            name="evidenceRef"
            hint="Where this can be checked — a price list date, an email, a call log."
          >
            <input className="field" name="evidenceRef" maxLength={160} />
          </Field>

          <Field
            label="Why entered by hand"
            name="reason"
            span
            hint="Required. A reader needs to know why this is not a quotation before deciding how much weight it carries."
          >
            <textarea
              className="field"
              name="reason"
              rows={2}
              required
              placeholder="e.g. Vendor declined to quote formally for a single unit; price taken from their published November list."
            />
          </Field>
        </div>
      </ActionForm>
    </SectionCard>
  );
}
