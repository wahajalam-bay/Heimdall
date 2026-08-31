"use client";

import { ActionButton, ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea } from "@/components/ui/field";
import type { CostAnalysis } from "@/server/cost-analysis";
import { saveCostAnalysisAction, verifyCostAnalysisAction } from "./actions";

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
