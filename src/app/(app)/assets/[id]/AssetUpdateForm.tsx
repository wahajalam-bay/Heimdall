"use client";

import { useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { ASSET_STATUSES, humanize } from "@/lib/domain";
import { updateAssetAction } from "@/app/(app)/assets/actions";

/**
 * Custody, condition and status changes. A reason is mandatory — the asset
 * register is only trustworthy if every movement carries its explanation.
 */
export function AssetUpdateForm({
  assetId,
  tag,
  current,
  users,
  departments,
}: {
  assetId: string;
  tag: string;
  current: {
    status: string;
    custodianId: string | null;
    location: string | null;
    office: string | null;
    departmentId: string | null;
    conditionNotes: string | null;
    currentValue: number | null;
  };
  users: Array<{ id: string; name: string; title: string | null }>;
  departments: Array<{ id: string; name: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(current.status);

  const terminal = ["DISPOSED", "SCRAPPED"].includes(status);

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Update asset
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Update ${tag}`}
        description="Status, custody, location and value. Every change is written to the asset's own transaction history."
        size="lg"
      >
        <ActionForm
          action={updateAssetAction}
          layout="bare"
          submitLabel="Save change"
          hiddenFields={{ assetId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={2}>
            <Field label="Status" name="status" required>
              <Select
                name="status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                options={ASSET_STATUSES.filter((s) => !["DISPOSED", "SCRAPPED"].includes(s)).map((s) => ({
                  value: s,
                  label: humanize(s),
                }))}
              />
            </Field>
            <Field label="Custodian" name="custodianId" hint="Who is answerable for the asset.">
              <Select
                name="custodianId"
                placeholder="No custodian"
                options={users.map((u) => ({ value: u.id, label: `${u.name}${u.title ? ` — ${u.title}` : ""}` }))}
                defaultValue={current.custodianId ?? ""}
              />
            </Field>
            <Field label="Department" name="departmentId">
              <Select
                name="departmentId"
                placeholder="Not department assigned"
                options={departments.map((d) => ({ value: d.id, label: d.name }))}
                defaultValue={current.departmentId ?? ""}
              />
            </Field>
            <Field label="Office" name="office">
              <TextInput name="office" defaultValue={current.office ?? ""} />
            </Field>
            <Field label="Location" name="location" hint="Room, floor, site or store.">
              <TextInput name="location" defaultValue={current.location ?? ""} />
            </Field>
            <Field label="Current value" name="currentValue" hint="Written-down value after depreciation.">
              <TextInput
                type="number"
                step="any"
                min="0"
                name="currentValue"
                defaultValue={current.currentValue ?? ""}
              />
            </Field>
            <Field label="Condition notes" name="conditionNotes" span>
              <TextArea name="conditionNotes" rows={2} defaultValue={current.conditionNotes ?? ""} />
            </Field>
            <Field
              label="Reason for this change"
              name="reason"
              required
              span
              hint="Mandatory. What changed and why — this is the audit record."
            >
              <TextArea
                name="reason"
                rows={3}
                placeholder="e.g. Reassigned to the Lahore site office following the marketing team relocation; condition checked and intact."
              />
            </Field>
          </FormSection>

          {status === "IDLE" && (
            <InlineAlert tone="info">
              Marking an asset idle makes it a disposal candidate. Redeploy it or raise a disposal case rather than
              leaving it idle indefinitely.
            </InlineAlert>
          )}
          {terminal && (
            <InlineAlert tone="warning">
              Disposal and scrapping are not set here — they are the outcome of a governed disposal case so the audit
              trail and any sale proceeds are recorded properly.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}
