"use client";

import { useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { Badge, DefList, InlineAlert } from "@/components/ui/primitives";
import {
  recordAcknowledgementAction,
  recordDistributionAction,
} from "@/app/(app)/po/actions";

/**
 * §4.6 — how the order reached the vendor, and what they said about it.
 *
 * The four outcomes are kept apart on purpose. No response is not the same as
 * pending, and delivering without acknowledging is not the same as
 * acknowledging — writing either one as the other would record a fact that
 * never happened.
 */
export function VendorAcknowledgement({
  poId,
  vendorName,
  distribution,
  acknowledgement,
  canAct,
}: {
  poId: string;
  vendorName: string;
  distribution: { channel: string | null; at: string | null; reference: string | null };
  acknowledgement: {
    status: string;
    label: string;
    at: string | null;
    byName: string | null;
    notes: string | null;
    dueAt: string | null;
  };
  canAct: boolean;
}) {
  const [sending, setSending] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [state, setState] = useState("ACKNOWLEDGED");

  const tone =
    acknowledgement.status === "ACKNOWLEDGED"
      ? "success"
      : acknowledgement.status === "REJECTED" || acknowledgement.status === "NO_RESPONSE"
        ? "danger"
        : acknowledgement.status === "DEEMED_ACCEPTED_THROUGH_EXECUTION"
          ? "warning"
          : "info";

  const overdue =
    acknowledgement.status === "PENDING" &&
    acknowledgement.dueAt !== null &&
    new Date(acknowledgement.dueAt).getTime() < Date.now();

  return (
    <div className="space-y-3">
      <DefList
        columns={1}
        items={[
          {
            label: "Sent to vendor",
            value: distribution.at
              ? `${distribution.channel ?? "—"} · ${new Date(distribution.at).toLocaleDateString()}${
                  distribution.reference ? ` · ${distribution.reference}` : ""
                }`
              : "Not recorded",
          },
          {
            label: "Vendor response",
            value: (
              <span className="flex flex-wrap items-baseline gap-2">
                <Badge tone={tone}>{acknowledgement.label}</Badge>
                {acknowledgement.byName && <span className="text-2xs">{acknowledgement.byName}</span>}
              </span>
            ),
          },
          ...(acknowledgement.at
            ? [{ label: "Recorded", value: new Date(acknowledgement.at).toLocaleString() }]
            : acknowledgement.dueAt
              ? [{ label: "Response due", value: new Date(acknowledgement.dueAt).toLocaleDateString() }]
              : []),
          ...(acknowledgement.notes ? [{ label: "Notes", value: acknowledgement.notes }] : []),
        ]}
      />

      {!distribution.at && (
        <InlineAlert tone="warning">
          Nothing records that this order was sent. An order nobody can show was sent is one the vendor can deny
          receiving, and that argument is lost on the day the delivery is late.
        </InlineAlert>
      )}

      {overdue && (
        <InlineAlert tone="warning">
          The acknowledgement window closed on {new Date(acknowledgement.dueAt!).toLocaleDateString()} with no
          response recorded.
        </InlineAlert>
      )}

      {canAct && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSending(true)}>
            {distribution.at ? "Update how it was sent" : "Record how it was sent"}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAnswering(true)}>
            Record the vendor&rsquo;s response
          </button>
        </div>
      )}

      <Modal
        open={sending}
        onClose={() => setSending(false)}
        title="How the order reached the vendor"
        description="§4.6: procurement issues the order to the vendor. This is the evidence that it went."
        size="md"
      >
        <ActionForm
          action={recordDistributionAction}
          layout="bare"
          submitLabel="Record"
          hiddenFields={{ poId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setSending(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={2}>
            <Field label="Channel" name="channel" required>
              <Select
                name="channel"
                required
                defaultValue={distribution.channel ?? "EMAIL"}
                options={[
                  { value: "EMAIL", label: "Email" },
                  { value: "PORTAL", label: "Vendor portal" },
                  { value: "COURIER", label: "Courier" },
                  { value: "HAND", label: "By hand" },
                  { value: "WHATSAPP", label: "WhatsApp" },
                ]}
              />
            </Field>
            <Field label="When" name="sentAt" hint="Leave blank for now.">
              <TextInput type="datetime-local" name="sentAt" />
            </Field>
            <Field
              label="Reference"
              name="reference"
              hint="Message id, courier tracking number, receipt signature — whatever proves it went."
            >
              <TextInput name="reference" defaultValue={distribution.reference ?? ""} />
            </Field>
          </FormSection>
        </ActionForm>
      </Modal>

      <Modal
        open={answering}
        onClose={() => setAnswering(false)}
        title={`What ${vendorName} said`}
        description="Four outcomes, deliberately distinct. Recording one as another records something that did not happen."
        size="md"
      >
        <ActionForm
          action={recordAcknowledgementAction}
          layout="bare"
          submitLabel="Record"
          hiddenFields={{ poId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setAnswering(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={2}>
            <Field label="Outcome" name="state" required>
              <Select
                name="state"
                required
                value={state}
                onChange={(e) => setState(e.target.value)}
                options={[
                  { value: "ACKNOWLEDGED", label: "Acknowledged by the vendor" },
                  { value: "REJECTED", label: "Declined by the vendor" },
                  { value: "NO_RESPONSE", label: "No response within the window" },
                  {
                    value: "DEEMED_ACCEPTED_THROUGH_EXECUTION",
                    label: "Deemed accepted — delivered without acknowledging",
                  },
                ]}
              />
            </Field>
            <Field label="When" name="at" hint="Leave blank for now.">
              <TextInput type="datetime-local" name="at" />
            </Field>
            {state === "ACKNOWLEDGED" && (
              <Field
                label="Who acknowledged it"
                name="byName"
                required
                hint="An acknowledgement from nobody is not one."
              >
                <TextInput name="byName" required />
              </Field>
            )}
            <Field
              label={state === "REJECTED" ? "Why the vendor declined" : "Notes"}
              name="notes"
              required={state === "REJECTED"}
            >
              <TextArea name="notes" rows={2} required={state === "REJECTED"} />
            </Field>
          </FormSection>

          {state === "DEEMED_ACCEPTED_THROUGH_EXECUTION" && (
            <InlineAlert tone="warning">
              This records that the vendor never confirmed the order but performed against it. It is deliberately a
              different state from acknowledged: the order binds either way, and the record should say which of the
              two actually happened.
            </InlineAlert>
          )}
          {state === "NO_RESPONSE" && (
            <InlineAlert tone="warning">
              This is a fact about the vendor, not a status on the order, and it belongs in their performance record.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </div>
  );
}
