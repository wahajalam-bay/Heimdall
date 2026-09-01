"use client";

import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { createRncCaseAction } from "../actions";

export function NewRncCaseForm({
  entities,
  buildOuts,
  defaultEntityId,
}: {
  entities: Array<{ id: string; code: string; name: string }>;
  buildOuts: Array<{ id: string; number: string; name: string }>;
  defaultEntityId: string;
}) {
  return (
    <ActionForm
      action={createRncCaseAction}
      submitLabel="Raise the case"
      onSuccessRedirect={(data) => `/rnc/${(data as { id: string }).id}`}
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
        <Field
          label="Region"
          name="region"
          required
          hint="Decides which regional roster sits on it, and therefore what quorum applies."
        >
          <Select
            name="region"
            required
            defaultValue="CENTRAL"
            options={[
              { value: "CENTRAL", label: "Central" },
              { value: "NORTH", label: "North" },
              { value: "SOUTH", label: "South" },
            ]}
          />
        </Field>
        <Field label="Case" name="title" required className="sm:col-span-2">
          <TextInput name="title" required placeholder="Sales floor lease — Gulberg III" />
        </Field>
        <Field
          label="Build-out"
          name="buildOutId"
          hint="BO-003 — where the lease is for a build-out, link it so the two read together."
          className="sm:col-span-2"
        >
          <Select
            name="buildOutId"
            placeholder="None"
            options={buildOuts.map((b) => ({ value: b.id, label: `${b.number} — ${b.name}` }))}
          />
        </Field>
        <Field
          label="Need assessment"
          name="needAssessment"
          hint="RN-006 — why this location is needed. The committee cannot be convened without it."
          className="sm:col-span-2"
        >
          <TextArea name="needAssessment" rows={3} />
        </Field>
        <Field label="Location notes" name="locationNote" className="sm:col-span-2">
          <TextArea name="locationNote" rows={2} />
        </Field>
      </FormSection>
    </ActionForm>
  );
}
