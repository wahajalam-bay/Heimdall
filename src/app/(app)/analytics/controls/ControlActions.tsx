"use client";

import { useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Field, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { performControlAction, waiveControlAction } from "./actions";

export function ControlActions({
  runId,
  name,
  period,
}: {
  runId: string;
  name: string;
  period: string;
}) {
  const [open, setOpen] = useState<null | "perform" | "waive">(null);
  const [notApplicable, setNotApplicable] = useState(false);

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className="btn btn-primary btn-xs" onClick={() => setOpen("perform")}>
          Record
        </button>
        <button type="button" className="btn btn-secondary btn-xs" onClick={() => setOpen("waive")}>
          Excuse
        </button>
      </div>

      <Modal
        open={open === "perform"}
        onClose={() => setOpen(null)}
        title={`${name} — ${period}`}
        description="Record that the control was performed for this period."
        size="md"
      >
        <ActionForm
          action={performControlAction}
          layout="bare"
          submitLabel="Record as performed"
          hiddenFields={{ runId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(null)}>
              Cancel
            </button>
          }
        >
          <Field
            label="Evidence"
            name="evidenceRef"
            hint="The count sheet, the requisition, the report — whatever somebody could go and look at."
          >
            <TextInput name="evidenceRef" />
          </Field>
          <Field label="Notes" name="notes">
            <TextArea name="notes" rows={2} />
          </Field>
        </ActionForm>
      </Modal>

      <Modal
        open={open === "waive"}
        onClose={() => setOpen(null)}
        title={`Excuse ${name} for ${period}`}
        description="A control not performed is either missed or excused, and an excuse has a name against it."
        size="md"
      >
        <ActionForm
          action={waiveControlAction}
          layout="bare"
          submitLabel="Record the excuse"
          hiddenFields={{ runId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(null)}>
              Cancel
            </button>
          }
        >
          <Field label="Which is it" name="notApplicable" required>
            <Select
              name="notApplicable"
              required
              value={notApplicable ? "true" : "false"}
              onChange={(e) => setNotApplicable(e.target.value === "true")}
              options={[
                { value: "false", label: "Waived — it should have been done and was not" },
                { value: "true", label: "Not applicable — there was nothing for it to act on" },
              ]}
            />
          </Field>
          <Field
            label="Why"
            name="reason"
            required
            hint="A waiver with no reason is indistinguishable from an oversight."
          >
            <TextArea name="reason" rows={3} required />
          </Field>
          <InlineAlert tone="info">
            An excused period stays visible as excused rather than becoming indistinguishable from one that was
            performed. The two are different facts.
          </InlineAlert>
        </ActionForm>
      </Modal>
    </>
  );
}
