"use client";

import { useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { Badge, InlineAlert } from "@/components/ui/primitives";
import {
  recordFarUpdateAction,
  recordFinanceValuationAction,
  recordInsignificantValueAction,
  recordPhysicalInspectionAction,
  recordWitnessAction,
} from "@/app/(app)/disposal/actions";

type Evidence = {
  step: string;
  label: string;
  owner: string;
  satisfied: boolean;
  detail: string | null;
};

type Witness = { function: string; label: string; name: string | null; attendedAt: string | null };

/**
 * The Scrap Material Policy's eight stages and what each has produced.
 *
 * The witness block is the one to read first. The SOP names five functions that
 * must be present when scrap is sold, and the point of naming five is that no
 * one of them conducts the sale alone.
 */
export function ScrapEvidence({
  caseId,
  items,
  witnesses,
  missingWitnesses,
  people,
  canRecord,
  canApprove,
  canFinance,
}: {
  caseId: string;
  items: Evidence[];
  witnesses: Witness[];
  missingWitnesses: string[];
  people: Array<{ id: string; name: string; title: string | null }>;
  canRecord: boolean;
  canApprove: boolean;
  canFinance: boolean;
}) {
  const [open, setOpen] = useState<null | "inspection" | "finance" | "insignificant" | "witness" | "far">(
    null,
  );
  const [witnessFn, setWitnessFn] = useState("INTERNAL_AUDIT");
  const [asUser, setAsUser] = useState(true);

  const outstanding = items.filter((i) => !i.satisfied);

  return (
    <div className="space-y-3">
      {outstanding.length > 0 && (
        <InlineAlert tone="warning">
          {outstanding.length} of the SOP&rsquo;s eight stages {outstanding.length === 1 ? "has" : "have"} produced
          nothing yet: {outstanding.map((i) => i.label).join(", ")}.
        </InlineAlert>
      )}

      <div className="table-wrap">
        <table className="dt">
          <thead>
            <tr>
              <th style={{ minWidth: "15rem" }}>Stage</th>
              <th style={{ width: "7rem" }}>State</th>
              <th style={{ minWidth: "12rem" }}>Detail</th>
              <th style={{ minWidth: "12rem" }}>Owner</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.step}>
                <td className="text-xs">{i.label}</td>
                <td>
                  {i.satisfied ? <Badge tone="success">Done</Badge> : <Badge tone="danger">Missing</Badge>}
                </td>
                <td className="text-2xs leading-4 text-muted">{i.detail ?? "—"}</td>
                <td className="text-2xs text-[var(--c-text-tertiary)]">{i.owner}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <p className="mb-1.5 text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
          Present at the sale
        </p>
        <div className="flex flex-wrap gap-1.5">
          {witnesses.map((w) => (
            <span key={w.function} className="inline-flex items-center gap-1.5">
              <Badge tone={w.name ? "success" : "danger"}>{w.label}</Badge>
              {w.name && <span className="text-2xs text-muted">{w.name}</span>}
            </span>
          ))}
        </div>
        {missingWitnesses.length > 0 && (
          <p className="mt-1.5 text-2xs text-[var(--c-text-tertiary)]">
            The SOP requires the sale to happen in the presence of all five. {missingWitnesses.join(", ")}{" "}
            {missingWitnesses.length === 1 ? "is" : "are"} not recorded.
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {canRecord && (
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen("inspection")}>
              Inspection report
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen("witness")}>
              Record a witness
            </button>
          </>
        )}
        {canFinance && (
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen("finance")}>
              Finance valuation
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen("far")}>
              FAR update
            </button>
          </>
        )}
        {canApprove && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen("insignificant")}>
            Insignificant value route
          </button>
        )}
      </div>

      <Modal
        open={open === "inspection"}
        onClose={() => setOpen(null)}
        title="Physical inspection report"
        description="Stage 1 — the SOP requires a Physical Inspection Report to be maintained."
        size="md"
      >
        <ActionForm
          action={recordPhysicalInspectionAction}
          layout="bare"
          submitLabel="Record"
          hiddenFields={{ caseId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(null)}>
              Cancel
            </button>
          }
        >
          <Field label="What the inspection found" name="report" required>
            <TextArea name="report" rows={4} required />
          </Field>
        </ActionForm>
      </Modal>

      <Modal
        open={open === "finance"}
        onClose={() => setOpen(null)}
        title="Finance valuation"
        description="Stage 3 — Finance determines the depreciated value and the residual value."
        size="md"
      >
        <ActionForm
          action={recordFinanceValuationAction}
          layout="bare"
          submitLabel="Record"
          hiddenFields={{ caseId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(null)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={2}>
            <Field label="Depreciated (net book) value" name="netBookValue" required>
              <TextInput type="number" step="any" min="0" name="netBookValue" required />
            </Field>
            <Field label="Residual value" name="residualValue" required>
              <TextInput type="number" step="any" min="0" name="residualValue" required />
            </Field>
          </FormSection>
          <Field label="Notes" name="notes">
            <TextArea name="notes" rows={2} />
          </Field>
          <InlineAlert tone="info">
            Two figures, not one. The write-off is the gap between what the books carry and what the sale realises,
            and collapsing them loses it.
          </InlineAlert>
        </ActionForm>
      </Modal>

      <Modal
        open={open === "insignificant"}
        onClose={() => setOpen(null)}
        title="Insignificant value route"
        description="Stage 4 — the SOP allows committee approval to be replaced by consulting the concerned business head where the value or quantum is insignificant."
        size="md"
      >
        <ActionForm
          action={recordInsignificantValueAction}
          layout="bare"
          submitLabel="Record"
          hiddenFields={{ caseId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(null)}>
              Cancel
            </button>
          }
        >
          <Field label="Business head consulted" name="businessHeadId" required>
            <Select
              name="businessHeadId"
              required
              placeholder="Choose…"
              options={people.map((p) => ({
                value: p.id,
                label: `${p.name}${p.title ? ` — ${p.title}` : ""}`,
              }))}
            />
          </Field>
          <Field
            label="Why the value or quantum is insignificant"
            name="justification"
            required
            hint="Without an argument this is a preference, not the SOP's exception."
          >
            <TextArea name="justification" rows={3} required />
          </Field>
        </ActionForm>
      </Modal>

      <Modal
        open={open === "witness"}
        onClose={() => setOpen(null)}
        title="Record a witness to the sale"
        description="Stage 6 — the scrap activity is done in the presence of IA, Finance, Admin, Procurement and Logistics."
        size="md"
      >
        <ActionForm
          action={recordWitnessAction}
          layout="bare"
          submitLabel="Record"
          hiddenFields={{ caseId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(null)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={2}>
            <Field label="Function" name="function" required>
              <Select
                name="function"
                required
                value={witnessFn}
                onChange={(e) => setWitnessFn(e.target.value)}
                options={witnesses.map((w) => ({ value: w.function, label: w.label }))}
              />
            </Field>
            <Field label="Who attended" name="_who">
              <Select
                name="_who"
                value={asUser ? "user" : "name"}
                onChange={(e) => setAsUser(e.target.value === "user")}
                options={[
                  { value: "user", label: "A system user" },
                  { value: "name", label: "Somebody else, by name" },
                ]}
              />
            </Field>
            {asUser ? (
              <Field label="Person" name="userId" required>
                <Select
                  name="userId"
                  required
                  placeholder="Choose…"
                  options={people.map((p) => ({
                    value: p.id,
                    label: `${p.name}${p.title ? ` — ${p.title}` : ""}`,
                  }))}
                />
              </Field>
            ) : (
              <>
                <Field label="Name" name="name" required>
                  <TextInput name="name" required />
                </Field>
                <Field label="Designation" name="designation">
                  <TextInput name="designation" />
                </Field>
              </>
            )}
          </FormSection>
          <Field label="Notes" name="notes">
            <TextInput name="notes" />
          </Field>
        </ActionForm>
      </Modal>

      <Modal
        open={open === "far"}
        onClose={() => setOpen(null)}
        title="FAR update"
        description="Stage 8 — Finance updates the fixed asset register; this records the hand-off and its reference."
        size="md"
      >
        <ActionForm
          action={recordFarUpdateAction}
          layout="bare"
          submitLabel="Record"
          hiddenFields={{ caseId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(null)}>
              Cancel
            </button>
          }
        >
          <Field
            label="Reference Finance gave the FAR update"
            name="reference"
            required
            hint="The register is Finance's system. This is the link to it, and a link with no reference is not one."
          >
            <TextInput name="reference" required />
          </Field>
          <Field
            label="Write-off amount"
            name="writeOffAmount"
            hint="Left blank, it is taken as the net book value less what the sale realised."
          >
            <TextInput type="number" step="any" name="writeOffAmount" />
          </Field>
        </ActionForm>
      </Modal>
    </div>
  );
}
