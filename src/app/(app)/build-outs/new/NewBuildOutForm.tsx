"use client";

import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextInput } from "@/components/ui/field";
import { createBuildOutAction } from "../actions";

export function NewBuildOutForm({
  entities,
  projects,
  sites,
  defaultEntityId,
}: {
  entities: Array<{ id: string; code: string; name: string }>;
  projects: Array<{ id: string; code: string; name: string }>;
  sites: Array<{ id: string; code: string; name: string }>;
  defaultEntityId: string;
}) {
  return (
    <ActionForm
      action={createBuildOutAction}
      submitLabel="Raise the build-out"
      onSuccessRedirect={(data) => `/build-outs/${(data as { id: string }).id}`}
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
        <Field label="Name" name="name" required hint="What the office is called, so it can be found later.">
          <TextInput name="name" required placeholder="Gulberg III sales floor" />
        </Field>
        <Field
          label="Region"
          name="region"
          required
          hint="The rental committee's rosters are cut by region, so this decides which committee sees the lease."
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
        <Field label="City" name="city">
          <TextInput name="city" placeholder="Lahore" />
        </Field>
        <Field label="Project" name="projectId" hint="Optional — links the spend to an existing project code.">
          <Select
            name="projectId"
            placeholder="None"
            options={projects.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }))}
          />
        </Field>
        <Field label="Site" name="siteId">
          <Select
            name="siteId"
            placeholder="None"
            options={sites.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` }))}
          />
        </Field>
        <Field
          label="Indicative budget"
          name="budgetAmount"
          hint="A starting figure. The BOQ replaces it as the budget once the architect has finalised one."
        >
          <TextInput type="number" min="0" step="0.01" name="budgetAmount" />
        </Field>
      </FormSection>
    </ActionForm>
  );
}
