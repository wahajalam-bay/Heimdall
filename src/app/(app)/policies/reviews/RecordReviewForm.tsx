"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { recordPolicyReviewAction } from "./actions";

export function RecordReviewForm({
  policies,
  departments,
  kinds,
}: {
  policies: Array<{ id: string; label: string }>;
  departments: Array<{ id: string; name: string }>;
  kinds: Array<{ value: string; label: string }>;
}) {
  const [kind, setKind] = useState(kinds[0]?.value ?? "TEAM_REVIEW");
  const isTeam = kind === "TEAM_REVIEW";
  const isPractice = kind === "PRACTICE_REVIEW";

  return (
    <ActionForm
      action={recordPolicyReviewAction}
      layout="bare"
      submitLabel="Record the review"
      resetOnSuccess
    >
      <FormSection columns={2}>
        <Field label="Policy" name="policyId" required>
          <Select
            name="policyId"
            required
            options={policies.map((p) => ({ value: p.id, label: p.label }))}
          />
        </Field>
        <Field label="Kind of review" name="kind" required>
          <Select
            name="kind"
            required
            value={kind}
            onChange={(e) => setKind(e.currentTarget.value)}
            options={kinds}
          />
        </Field>
        <Field
          label="Department"
          name="departmentId"
          required
          hint="The clause puts the duty on the business unit manager, so a review belongs to a team."
        >
          <Select
            name="departmentId"
            required
            placeholder="Choose the department…"
            options={departments.map((d) => ({ value: d.id, label: d.name }))}
          />
        </Field>
        <Field label="Date of the review" name="reviewedAt">
          <TextInput type="date" name="reviewedAt" />
        </Field>

        {isTeam && (
          <>
            <Field
              label="How many attended"
              name="attendeeCount"
              required
              hint="A review with the team is a meeting, and a meeting with nobody in it is not one."
            >
              <TextInput type="number" min="1" step="1" name="attendeeCount" required />
            </Field>
            <Field label="Who attended" name="attendeeNames">
              <TextInput name="attendeeNames" placeholder="Names, or a note on who was there" />
            </Field>
          </>
        )}

        <Field
          label="What the review covered"
          name="notes"
          required
          className="sm:col-span-2"
          hint="The clause asks for documentation of the review, and a record with no content is not documentation."
        >
          <TextArea name="notes" rows={3} required />
        </Field>

        {isPractice && (
          <Field
            label="What it found"
            name="findings"
            required
            className="sm:col-span-2"
            hint="Including 'nothing wanting', if that is the answer — a review with no findings cannot be told apart from one that did not happen."
          >
            <TextArea name="findings" rows={3} required />
          </Field>
        )}
      </FormSection>
    </ActionForm>
  );
}
