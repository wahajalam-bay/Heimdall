"use client";

import { useMemo, useState } from "react";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { createDelegationAction } from "./actions";

type Perm = { code: string; label: string; group: string };

/**
 * Recording a delegation.
 *
 * The permission list is what the delegator holds and nothing more — delegation
 * lends existing authority and never creates any. There is deliberately no
 * "select all": a wide delegation is what makes segregation of duties
 * unenforceable while it lasts, and making that one click away would guarantee
 * it happens.
 */
export function DelegationForm({
  people,
  delegators,
  selfId,
  selfName,
  permissions,
}: {
  people: Array<{ id: string; label: string }>;
  delegators: Array<{ id: string; label: string }>;
  selfId: string;
  selfName: string;
  permissions: Perm[];
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState<string>("");
  const [onBehalf, setOnBehalf] = useState(false);

  const groups = useMemo(
    () => [...new Set(permissions.map((p) => p.group))].sort(),
    [permissions],
  );
  const shown = group ? permissions.filter((p) => p.group === group) : permissions;

  const toggle = (code: string) =>
    setChosen((c) => {
      const next = new Set(c);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  const today = new Date().toISOString().slice(0, 10);

  return (
    <ActionForm action={createDelegationAction} layout="bare" submitLabel="Record the delegation">
      <FormSection columns={2}>
        {delegators.length > 0 && (
          <Field label="Whose authority" name="_whose">
            <Select
              name="_whose"
              value={onBehalf ? "other" : "self"}
              onChange={(e) => setOnBehalf(e.target.value === "other")}
              options={[
                { value: "self", label: `Mine — ${selfName}` },
                { value: "other", label: "Somebody else's" },
              ]}
            />
          </Field>
        )}
        {onBehalf ? (
          <Field
            label="Delegator"
            name="delegatorId"
            required
            hint="Recording somebody else's delegation is a statement about them, so who recorded it is stored separately."
          >
            <Select
              name="delegatorId"
              required
              placeholder="Choose…"
              options={delegators.map((p) => ({ value: p.id, label: p.label }))}
            />
          </Field>
        ) : (
          <input type="hidden" name="delegatorId" value={selfId} />
        )}
        <Field label="Delegate to" name="delegateId" required>
          <Select
            name="delegateId"
            required
            placeholder="Choose…"
            options={people.map((p) => ({ value: p.id, label: p.label }))}
          />
        </Field>
        <Field label="From" name="validFrom" required>
          <TextInput type="date" name="validFrom" required defaultValue={today} />
        </Field>
        <Field
          label="Until"
          name="validTo"
          required
          hint="Required. A delegation with no end date is a role reassignment wearing a delegation's name."
        >
          <TextInput type="date" name="validTo" required />
        </Field>
        <Field
          label="Value ceiling"
          name="valueLimit"
          hint="Leave blank and the delegator's own limits stand."
        >
          <TextInput type="number" step="any" min="0" name="valueLimit" />
        </Field>
      </FormSection>

      <Field
        label="Why"
        name="reason"
        required
        hint="'On leave until the 14th' is enough. Nothing is not."
      >
        <TextArea name="reason" rows={2} required />
      </Field>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="label">
            What is being lent
            {chosen.size > 0 && (
              <span className="ml-1.5 font-400 text-[var(--c-text-tertiary)]">
                {chosen.size} selected
              </span>
            )}
          </span>
          <select
            className="field max-w-[16rem]"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          >
            <option value="">Every group</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>

        {permissions.length === 0 ? (
          <InlineAlert tone="warning">
            You hold no permissions that could be delegated.
          </InlineAlert>
        ) : (
          <div className="max-h-[18rem] overflow-y-auto rounded border border-[var(--c-border)] px-3 py-2">
            <div className="grid gap-1 sm:grid-cols-2">
              {shown.map((p) => (
                <label key={p.code} className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={chosen.has(p.code)}
                    onChange={() => toggle(p.code)}
                    className="mt-0.5"
                  />
                  <span>
                    {p.label}
                    <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{p.group}</span>
                  </span>
                  {chosen.has(p.code) && <input type="hidden" name="permission" value={p.code} />}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      <Field
        label="Narrow to document types"
        name="_documentTypes"
        hint="Optional. Leave every box clear and the delegation covers whatever the permissions cover."
      >
        <div className="flex flex-wrap gap-3">
          {["PR", "PO", "INVOICE", "GRN", "REQUIREMENT", "CONTRACT", "WORK_ORDER"].map((t) => (
            <label key={t} className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" name="documentType" value={t} />
              {t.replace(/_/g, " ").toLowerCase()}
            </label>
          ))}
        </div>
      </Field>

      {chosen.size >= 8 && (
        <InlineAlert tone="warning">
          {chosen.size} permissions is a broad delegation. For as long as it lasts, the separations of duty that rely
          on these being held by different people do not hold. Narrow it to what the delegate actually has to do
          while the delegator is away.
        </InlineAlert>
      )}
    </ActionForm>
  );
}
