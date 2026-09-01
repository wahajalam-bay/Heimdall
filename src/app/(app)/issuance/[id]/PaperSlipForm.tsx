"use client";

import { useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Field, FormSection, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { recordPaperSlipAction } from "@/app/(app)/stores/actions";

/**
 * Records an Issuance Slip that was signed on paper.
 *
 * Most receivers are not system users, and refusing to record their signature
 * would mean the control only ever applied to the minority who are. But a
 * transcription is not a signature, so the form says whose signature it is
 * recording and whose hand recorded it, and both go on the attestation.
 */
export function PaperSlipForm({
  issueId,
  recipientName,
}: {
  issueId: string;
  recipientName: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        Record a signed paper slip
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Record a signed paper slip"
        description="For a receiver who signed the printed slip rather than acknowledging it here."
        size="md"
      >
        <ActionForm
          action={recordPaperSlipAction}
          layout="bare"
          submitLabel="Record the slip"
          hiddenFields={{ issueId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <InlineAlert tone="info">
            This goes on the record as a transcription, not a signature: the person named below signed, and your name
            is recorded as the one who entered it. Keep the paper.
          </InlineAlert>

          <FormSection columns={2}>
            <Field label="Who signed the slip" name="signatoryName" required>
              <TextInput name="signatoryName" defaultValue={recipientName} required />
            </Field>
            <Field label="Date signed" name="signedOn">
              <TextInput type="date" name="signedOn" />
            </Field>
            <Field label="Slip reference" name="slipRef" hint="Whatever the paper bore, if anything.">
              <TextInput name="slipRef" />
            </Field>
            <Field label="Note" name="comment">
              <TextArea name="comment" rows={2} />
            </Field>
          </FormSection>
        </ActionForm>
      </Modal>
    </>
  );
}
