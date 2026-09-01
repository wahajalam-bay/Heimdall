"use client";

import { useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { Badge, InlineAlert } from "@/components/ui/primitives";
import {
  classifyEmergencyAction,
  recordPriceCompetitivenessAction,
} from "@/app/(app)/comparatives/actions";

type Item = {
  step: string;
  label: string;
  applicable: boolean;
  applicableNote: string | null;
  satisfied: boolean;
  detail: string | null;
  excused: boolean;
  blocking: boolean;
};

/**
 * The Price Competitiveness Policy on a comparative.
 *
 * Each of the SOP's steps shows one of four states, and they are not
 * interchangeable: satisfied, not applicable to this exercise, excused by an
 * approved emergency, or outstanding. Collapsing "does not apply" into "done"
 * would make a local purchase look as though its international price study had
 * been carried out.
 */
export function PriceCompetitiveness({
  comparativeId,
  state,
  canRecord,
  canClassify,
}: {
  comparativeId: string;
  state: {
    items: Item[];
    complete: boolean;
    blockers: string[];
    emergency: boolean;
    emergencyReason: string | null;
    emergencyApprovedByName: string | null;
    sourcingBasis: string;
    quotationsObtained: number;
    minimumRequired: number;
    reviewId: string | null;
  };
  canRecord: boolean;
  canClassify: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [emergency, setEmergency] = useState(false);
  const [basis, setBasis] = useState(state.sourcingBasis);
  const [imported, setImported] = useState(
    state.items.find((i) => i.step === "INTERNATIONAL_PRICES")?.applicable ?? false,
  );
  const [newVendor, setNewVendor] = useState(
    state.items.find((i) => i.step === "NEW_VENDOR_PREREQUISITES")?.applicable ?? false,
  );

  return (
    <div className="space-y-3">
      {state.emergency && (
        <InlineAlert tone="warning">
          <span className="font-600">Classified as an emergency purchase. </span>
          {state.emergencyReason}
          <span className="mt-0.5 block text-2xs">
            Approved by {state.emergencyApprovedByName}. The SOP&rsquo;s words are that price competitiveness &ldquo;may
            not be considered in detail&rdquo; — this relaxes the market studies and the quotation minimum, and nothing
            else.
          </span>
        </InlineAlert>
      )}

      {!state.complete && (
        <InlineAlert tone="warning">
          Outstanding: {state.blockers.join(", ")}.
        </InlineAlert>
      )}

      <div className="table-wrap">
        <table className="dt">
          <thead>
            <tr>
              <th style={{ minWidth: "16rem" }}>Step</th>
              <th style={{ width: "9rem" }}>State</th>
              <th style={{ minWidth: "14rem" }}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {state.items.map((i) => (
              <tr key={i.step}>
                <td className="text-xs">{i.label}</td>
                <td>
                  {!i.applicable ? (
                    <span className="text-2xs text-[var(--c-text-tertiary)]">Not applicable</span>
                  ) : i.satisfied ? (
                    <Badge tone="success">Done</Badge>
                  ) : i.excused ? (
                    <Badge tone="warning">Excused</Badge>
                  ) : (
                    <Badge tone="danger">Outstanding</Badge>
                  )}
                </td>
                <td className="text-2xs leading-4 text-muted">
                  {i.detail ?? i.applicableNote ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-2">
        {canRecord && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
            {state.reviewId ? "Update the review" : "Record the review"}
          </button>
        )}
        {canClassify && !state.emergency && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEmergency(true)}>
            Classify as an emergency purchase
          </button>
        )}
      </div>

      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title="Price competitiveness review"
        description="ZAM/PUR/SOP-01's Price Competitiveness Policy. Steps that do not apply to this purchase are marked so rather than ticked."
        size="lg"
      >
        <ActionForm
          action={recordPriceCompetitivenessAction}
          layout="bare"
          submitLabel="Record"
          hiddenFields={{ comparativeId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={2}>
            <Field label="Sourcing route" name="sourcingBasis" required>
              <Select
                name="sourcingBasis"
                required
                value={basis}
                onChange={(e) => setBasis(e.target.value)}
                options={[
                  { value: "MULTIPLE", label: "Multiple sourcing" },
                  { value: "SINGLE", label: "Single sourcing" },
                ]}
              />
            </Field>
            <Field label="Imported goods" name="imported">
              <Select
                name="imported"
                value={imported ? "true" : "false"}
                onChange={(e) => setImported(e.target.value === "true")}
                options={[
                  { value: "false", label: "No — local purchase" },
                  { value: "true", label: "Yes — international prices apply" },
                ]}
              />
            </Field>
          </FormSection>

          {basis === "SINGLE" && (
            <Field
              label="Why the volumes point to a single source"
              name="volumeRationale"
              required
              hint="The SOP grounds single sourcing on the volumes. An unexplained one is not grounded at all."
            >
              <TextArea name="volumeRationale" rows={2} required />
            </Field>
          )}

          <FormSection columns={2}>
            <Field label="Last buying price reviewed" name="lastBuyingPriceReviewed">
              <Select
                name="lastBuyingPriceReviewed"
                defaultValue="true"
                options={[
                  { value: "true", label: "Yes" },
                  { value: "false", label: "Not yet" },
                ]}
              />
            </Field>
            <Field label="Last buying price" name="lastBuyingPrice">
              <TextInput type="number" step="any" min="0" name="lastBuyingPrice" />
            </Field>
            <Field label="Where that price came from" name="lastBuyingPriceSource" hint="A PO number, an invoice, a price list.">
              <TextInput name="lastBuyingPriceSource" />
            </Field>
            <Field label="Cost Analysis Summary attached" name="costAnalysisAttached">
              <Select
                name="costAnalysisAttached"
                defaultValue="true"
                options={[
                  { value: "true", label: "Yes" },
                  { value: "false", label: "Not yet" },
                ]}
              />
            </Field>
          </FormSection>

          <FormSection columns={2}>
            <Field label="Local vendor prices checked" name="localPricesChecked">
              <Select
                name="localPricesChecked"
                defaultValue="true"
                options={[
                  { value: "true", label: "Yes" },
                  { value: "false", label: "Not yet" },
                ]}
              />
            </Field>
            <Field label="What the local check found" name="localPriceNote">
              <TextInput name="localPriceNote" />
            </Field>
            {imported && (
              <>
                <Field label="International prices checked" name="internationalPricesChecked">
                  <Select
                    name="internationalPricesChecked"
                    defaultValue="true"
                    options={[
                      { value: "true", label: "Yes" },
                      { value: "false", label: "Not yet" },
                    ]}
                  />
                </Field>
                <Field label="What the international check found" name="internationalPriceNote">
                  <TextInput name="internationalPriceNote" />
                </Field>
              </>
            )}
          </FormSection>

          <FormSection columns={2}>
            <Field label="A newly inducted vendor is involved" name="newVendorInvolved">
              <Select
                name="newVendorInvolved"
                value={newVendor ? "true" : "false"}
                onChange={(e) => setNewVendor(e.target.value === "true")}
                options={[
                  { value: "false", label: "No" },
                  { value: "true", label: "Yes" },
                ]}
              />
            </Field>
            {newVendor && (
              <Field label="Their prerequisites are complete" name="newVendorPrerequisitesMet">
                <Select
                  name="newVendorPrerequisitesMet"
                  defaultValue="false"
                  options={[
                    { value: "true", label: "Yes" },
                    { value: "false", label: "Not yet" },
                  ]}
                />
              </Field>
            )}
          </FormSection>
        </ActionForm>
      </Modal>

      <Modal
        open={emergency}
        onClose={() => setEmergency(false)}
        title="Classify as an emergency purchase"
        description="ZAM/PUR/SOP-01: for emergency purchases price competitiveness may not be considered in detail."
        size="md"
      >
        <ActionForm
          action={classifyEmergencyAction}
          layout="bare"
          submitLabel="Classify"
          hiddenFields={{ comparativeId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setEmergency(false)}>
              Cancel
            </button>
          }
        >
          <InlineAlert tone="warning">
            This excuses the international and local market studies and the quotation minimum. It does{" "}
            <strong>not</strong> excuse the last buying price, the cost analysis, the sourcing basis or the vendor
            prerequisites — the SOP relaxes the depth of the analysis, not the policy.
          </InlineAlert>
          <Field
            label="The business criticality that makes this an emergency"
            name="reason"
            required
            hint="The SOP's own example cites a renovation needed in the shortest possible time. Your name goes on the record."
          >
            <TextArea name="reason" rows={3} required />
          </Field>
        </ActionForm>
      </Modal>
    </div>
  );
}
