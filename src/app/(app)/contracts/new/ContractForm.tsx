"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { createContractAction } from "../actions";

/**
 * Raising a contract.
 *
 * The end date is required for every type that has a term, and the form says
 * why: a standing obligation with no end date is the thing that keeps being paid
 * for after it stops being needed.
 */
export function ContractForm({
  entities,
  vendors,
  defaultEntityId,
}: {
  entities: Array<{ id: string; code: string; name: string }>;
  vendors: Array<{ id: string; name: string; code: string }>;
  defaultEntityId: string;
}) {
  const [type, setType] = useState("SERVICE_CONTRACT");
  const [autoRenew, setAutoRenew] = useState("false");
  const termless = type === "ONE_TIME" || type === "OTHER";

  return (
    <ActionForm
      action={createContractAction}
      submitLabel="Raise the contract"
      onSuccessRedirect="/contracts"
    >
      <FormSection columns={2}>
        <Field label="Company" name="entityId" required>
          <Select
            name="entityId"
            required
            defaultValue={defaultEntityId}
            options={entities.map((e) => ({ value: e.id, label: `${e.code} — ${e.name}` }))}
          />
        </Field>
        <Field label="Vendor" name="vendorId" required>
          <Select
            name="vendorId"
            required
            placeholder="Choose the vendor…"
            options={vendors.map((v) => ({ value: v.id, label: `${v.name} (${v.code})` }))}
          />
        </Field>
        <Field label="Title" name="title" required>
          <TextInput name="title" required />
        </Field>
        <Field
          label="Type"
          name="contractType"
          required
          hint="The first five are the committee mandate's own list."
        >
          <Select
            name="contractType"
            required
            value={type}
            onChange={(e) => setType(e.target.value)}
            options={[
              { value: "SLA", label: "Service level agreement" },
              { value: "SERVICE_CONTRACT", label: "Service contract" },
              { value: "AMC", label: "Annual maintenance contract" },
              { value: "BUILDOUT", label: "Build-out" },
              { value: "ONE_TIME", label: "One-time purchase" },
              { value: "RENTAL", label: "Rental agreement" },
              { value: "FRAMEWORK", label: "Framework / rate agreement" },
              { value: "OTHER", label: "Other" },
            ]}
          />
        </Field>
      </FormSection>

      <Field label="Description" name="description">
        <TextArea name="description" rows={2} />
      </Field>

      <FormSection columns={2}>
        <Field
          label="Contract value"
          name="contractValue"
          hint="Leave blank for a framework or rate agreement — that commits nothing, which is different from committing zero."
        >
          <TextInput type="number" step="any" min="0" name="contractValue" />
        </Field>
        <Field label="Currency" name="currency">
          <TextInput name="currency" defaultValue="PKR" />
        </Field>
        <Field label="Starts" name="startDate">
          <TextInput type="date" name="startDate" />
        </Field>
        <Field
          label="Ends"
          name="endDate"
          required={!termless}
          hint={
            termless
              ? "Optional for a one-time purchase."
              : "Required. A standing obligation with no end date is exactly what gets paid for after it stops being needed."
          }
        >
          <TextInput type="date" name="endDate" required={!termless} />
        </Field>
        <Field
          label="Notice period (days)"
          name="noticeDays"
          hint="How long before the end date the contract starts asking for a decision."
        >
          <TextInput type="number" min="0" name="noticeDays" defaultValue="60" />
        </Field>
        <Field label="Renews automatically" name="autoRenew">
          <Select
            name="autoRenew"
            value={autoRenew}
            onChange={(e) => setAutoRenew(e.target.value)}
            options={[
              { value: "false", label: "No — only by agreement" },
              { value: "true", label: "Yes — rolls on unless stopped" },
            ]}
          />
        </Field>
      </FormSection>

      <FormSection columns={2}>
        <Field label="Payment terms" name="paymentTerms" hint="§4.6 names this specifically.">
          <TextInput name="paymentTerms" />
        </Field>
        <Field label="Delivery location" name="deliveryLocation" hint="§4.6 names this too.">
          <TextInput name="deliveryLocation" />
        </Field>
      </FormSection>

      {(type === "SLA" || type === "AMC" || type === "SERVICE_CONTRACT") && (
        <Field label="Service levels" name="slaTerms">
          <TextArea name="slaTerms" rows={3} />
        </Field>
      )}

      <Field label="Legal terms" name="legalTerms">
        <TextArea name="legalTerms" rows={3} />
      </Field>

      {autoRenew === "true" && (
        <InlineAlert tone="warning">
          The system will never renew this for you. The flag records what the paper says, and acting on it
          automatically would create an obligation nobody chose — instead the contract is flagged loudly inside its
          notice period so somebody can decide.
        </InlineAlert>
      )}
    </ActionForm>
  );
}
