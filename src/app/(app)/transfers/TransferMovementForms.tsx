"use client";

import { useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Field, FormSection, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { dispatchTransferFormAction, receiveTransferFormAction } from "@/app/(app)/stores/actions";

/** Dispatch captures the vehicle and gate pass reference alongside the movement. */
export function DispatchTransferForm({
  transferId,
  number,
  fromStore,
  toStore,
  summary,
}: {
  transferId: string;
  number: string;
  fromStore: string;
  toStore: string;
  summary: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Dispatch stock
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Dispatch ${number}`}
        description={`Releases ${summary} from ${fromStore}. Stock leaves the source balance immediately and is only added to ${toStore} when it is received there.`}
        size="md"
      >
        <ActionForm
          action={dispatchTransferFormAction}
          layout="bare"
          submitLabel="Dispatch and reduce source store"
          hiddenFields={{ transferId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={2}>
            <Field label="Vehicle number" name="vehicleNumber" hint="Recorded on the outward gate pass.">
              <TextInput name="vehicleNumber" placeholder="e.g. LES-4471" />
            </Field>
            <Field label="Gate pass reference" name="gatePassRef" hint="Outward gate pass or challan number.">
              <TextInput name="gatePassRef" placeholder="e.g. OGP-2026-0184" />
            </Field>
          </FormSection>
          <InlineAlert tone="warning">
            Once dispatched, this stock sits in neither store&apos;s balance until the destination confirms receipt. Any
            shortfall on arrival is recorded as a discrepancy against this transfer.
          </InlineAlert>
        </ActionForm>
      </Modal>
    </>
  );
}

/** Receipt closes the transfer and adds the stock to the destination store. */
export function ReceiveTransferForm({
  transferId,
  number,
  toStore,
  summary,
}: {
  transferId: string;
  number: string;
  toStore: string;
  summary: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Receive into store
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Receive ${number}`}
        description={`Confirms ${summary} has physically arrived at ${toStore} and adds it to that store's balance.`}
        size="md"
      >
        <ActionForm
          action={receiveTransferFormAction}
          layout="bare"
          submitLabel="Confirm receipt"
          hiddenFields={{ transferId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={1}>
            <Field
              label="Receiving remarks"
              name="reason"
              hint="Note the condition on arrival, any damage, and anything short of the dispatched quantity."
            >
              <TextArea name="reason" rows={3} placeholder="e.g. All 40 bags arrived intact; seal numbers matched." />
            </Field>
          </FormSection>
          <InlineAlert tone="info">
            Confirm only what has physically been counted into the store. The dispatched quantity is the ceiling — you
            cannot receive more than was sent.
          </InlineAlert>
        </ActionForm>
      </Modal>
    </>
  );
}
