"use client";

import { useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { money, toInputDate } from "@/lib/format";
import { acknowledgeHandoffAction, recordPaymentAction } from "@/app/(app)/invoices/actions";

const METHODS = [
  { value: "BANK_TRANSFER", label: "Bank transfer" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "ONLINE", label: "Online payment" },
  { value: "CASH", label: "Cash" },
];

export function AcknowledgeForm({
  handoffId,
  number,
  amount,
  vendorName,
  suggestedAccount,
}: {
  handoffId: string;
  number: string;
  amount: number;
  vendorName: string;
  suggestedAccount: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Acknowledge
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Acknowledge ${number}`}
        description={`Finance confirms receipt of the invoice and its supporting documents, and schedules ${money(amount)} to ${vendorName}.`}
        size="md"
      >
        <ActionForm
          action={acknowledgeHandoffAction}
          layout="bare"
          submitLabel="Acknowledge and schedule"
          hiddenFields={{ handoffId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={2}>
            <Field label="Payment method" name="paymentMethod" required>
              <Select name="paymentMethod" options={METHODS} defaultValue="BANK_TRANSFER" />
            </Field>
            <Field label="Bank account" name="bankAccount" hint="The vendor account the payment will go to.">
              <TextInput name="bankAccount" defaultValue={suggestedAccount ?? ""} />
            </Field>
            <Field label="Scheduled payment date" name="scheduledDate" hint="When finance intends to release funds.">
              <TextInput type="date" name="scheduledDate" defaultValue={toInputDate(new Date())} />
            </Field>
            <Field label="Notes" name="notes" span>
              <TextArea name="notes" rows={2} placeholder="Anything procurement should know about the payment run." />
            </Field>
          </FormSection>
          <InlineAlert tone="info">
            Acknowledging does not release money. Recording the payment is a separate, re-checked step.
          </InlineAlert>
        </ActionForm>
      </Modal>
    </>
  );
}

export function RecordPaymentForm({
  handoffId,
  number,
  amount,
  vendorName,
  defaultMethod,
  blockers,
}: {
  handoffId: string;
  number: string;
  amount: number;
  vendorName: string;
  defaultMethod: string | null;
  blockers: string[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={() => setOpen(true)}
        disabled={blockers.length > 0}
        title={blockers[0]}
      >
        Record payment
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Record payment for ${number}`}
        description={`${money(amount)} to ${vendorName}. The integrity checks run again before this is accepted — a failing match or a missing goods receipt will refuse it.`}
        size="md"
      >
        <ActionForm
          action={recordPaymentAction}
          layout="bare"
          submitLabel="Record payment"
          hiddenFields={{ handoffId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          {blockers.length > 0 && (
            <InlineAlert tone="danger">
              This payment will be refused: {blockers.join(" ")}
            </InlineAlert>
          )}
          <FormSection columns={2}>
            <Field
              label="Payment reference"
              name="paymentReference"
              required
              hint="Bank transaction id, cheque number or online reference."
            >
              <TextInput name="paymentReference" />
            </Field>
            <Field label="Payment method" name="paymentMethod">
              <Select name="paymentMethod" options={METHODS} defaultValue={defaultMethod ?? "BANK_TRANSFER"} />
            </Field>
            <Field label="Payment date" name="paidDate">
              <TextInput type="date" name="paidDate" defaultValue={toInputDate(new Date())} />
            </Field>
          </FormSection>
          <InlineAlert tone="warning">
            Recording a payment closes the loop on this order and is permanent. Only record what has actually left the
            account.
          </InlineAlert>
        </ActionForm>
      </Modal>
    </>
  );
}
