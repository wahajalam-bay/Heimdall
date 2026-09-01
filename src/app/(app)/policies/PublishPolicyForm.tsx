"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { publishPolicyAction } from "./actions";

export function PublishPolicyForm({
  roles,
  entityId,
}: {
  roles: Array<{ code: string; name: string }>;
  entityId: string | null;
}) {
  const [everybody, setEverybody] = useState(true);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <ActionForm
      action={publishPolicyAction}
      layout="bare"
      submitLabel="Publish the version"
      hiddenFields={entityId ? { entityId } : {}}
    >
      <FormSection columns={2}>
        <Field label="Code" name="code" required hint="e.g. ZAM/PUR/SOP-01. Stable across versions.">
          <TextInput name="code" required />
        </Field>
        <Field
          label="Version"
          name="version"
          required
          hint="What people actually sign. A version already published cannot be edited."
        >
          <TextInput name="version" required placeholder="e.g. 2026.1" />
        </Field>
        <Field label="Title" name="title" required>
          <TextInput name="title" required />
        </Field>
        <Field label="Effective from" name="effectiveFrom" required>
          <TextInput type="date" name="effectiveFrom" required defaultValue={today} />
        </Field>
      </FormSection>

      <Field label="Summary" name="summary">
        <TextArea name="summary" rows={2} />
      </Field>

      <Field
        label="What changed in this version"
        name="changeNote"
        hint="This is what makes a second acknowledgement mean something different from the first. Without it, signing a new version is a click."
      >
        <TextArea name="changeNote" rows={3} />
      </Field>

      <Field label="Who must acknowledge it" name="_who">
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={everybody}
              onChange={(e) => setEverybody(e.target.checked)}
            />
            Everybody
          </label>
          {!everybody && (
            <div className="max-h-[14rem] overflow-y-auto rounded border border-[var(--c-border)] px-3 py-2">
              <div className="grid gap-1 sm:grid-cols-2">
                {roles.map((r) => (
                  <label key={r.code} className="flex items-center gap-2 text-xs">
                    <input type="checkbox" name="roleCode" value={r.code} />
                    {r.name}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </Field>

      <InlineAlert tone="warning">
        Publishing this starts its register at zero. Earlier versions keep the acknowledgements they have — what
        somebody signed then is still what they signed — but nobody has yet acknowledged this text.
      </InlineAlert>
    </ActionForm>
  );
}
