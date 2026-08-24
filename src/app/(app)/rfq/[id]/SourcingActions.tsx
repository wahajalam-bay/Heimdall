"use client";

import { useState } from "react";
import { ActionButton, ActionForm, Modal } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { money } from "@/lib/format";
import {
  addRfqVendorAction,
  buildComparativeAction,
  closeRfqAction,
  declineVendorAction,
  issueRfqAction,
  recordNegotiationAction,
} from "../actions";

const NEGOTIATION_CHANNELS = ["CALL", "EMAIL", "MEETING", "WHATSAPP", "PORTAL"];
const OUTCOMES = ["OPEN", "ACCEPTED", "REJECTED", "VENDOR_DECLINED"];

export function IssueRfqButton({ rfqId, vendorCount }: { rfqId: string; vendorCount: number }) {
  return (
    <ActionButton
      action={issueRfqAction}
      payload={{ rfqId }}
      label="Issue to vendors"
      tone="primary"
      confirm={`Issue this RFQ to ${vendorCount} vendor(s)? They will be recorded as invited and a follow-up task is created for procurement.`}
    />
  );
}

export function CloseRfqButton({ rfqId, outstanding }: { rfqId: string; outstanding: number }) {
  return (
    <ActionButton
      action={closeRfqAction}
      payload={{ rfqId }}
      label="Close RFQ"
      tone="secondary"
      confirm={
        outstanding > 0
          ? `${outstanding} vendor(s) have not responded. Closing marks them as no-response. Continue?`
          : "Close this RFQ to further quotations?"
      }
    />
  );
}

export function DeclineVendorButton({ rfqId, vendorId, vendorName }: { rfqId: string; vendorId: string; vendorName: string }) {
  return (
    <ActionButton
      action={declineVendorAction}
      payload={{ rfqId, vendorId }}
      label="Mark declined"
      tone="ghost"
      size="xs"
      reasonLabel={`Why did ${vendorName} decline or fail to quote?`}
      reasonRequired
    />
  );
}

export function AddVendorButton({
  rfqId,
  vendors,
}: {
  rfqId: string;
  vendors: Array<{ id: string; name: string; code: string; status: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [vendorId, setVendorId] = useState("");
  const [channel, setChannel] = useState("EMAIL");
  const [reason, setReason] = useState("");
  const selected = vendors.find((v) => v.id === vendorId);
  const needsOverride = selected && !["APPROVED", "CONDITIONAL"].includes(selected.status);

  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        Invite another vendor
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Invite another vendor"
        description="Adding a vendor mid-RFQ is recorded in the audit trail."
        footer={
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <ActionButton
              action={addRfqVendorAction}
              payload={{ rfqId, vendorId, channel, reason }}
              label="Invite"
              tone="primary"
              disabled={!vendorId || Boolean(needsOverride && !reason.trim())}
              disabledReason={needsOverride ? "An override reason is required for a non-approved vendor." : "Select a vendor."}
            />
          </>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-500 text-muted">Vendor</span>
            <select className="field" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Select vendor…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} — {humanize(v.status)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-500 text-muted">Invitation channel</span>
            <select className="field" value={channel} onChange={(e) => setChannel(e.target.value)}>
              {["EMAIL", "PORTAL", "WHATSAPP", "PHYSICAL", "SKYPE", "PHONE", "WALK_IN"].map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </select>
          </label>
          {needsOverride && (
            <>
              <InlineAlert tone="warning">
                {selected?.name} is {humanize(selected?.status ?? "")} and is not normally sourceable. An override
                requires the vendor-blacklist permission and a recorded reason.
              </InlineAlert>
              <label className="block">
                <span className="mb-1 block text-xs font-500 text-muted">Override reason</span>
                <textarea className="field" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}

export function NegotiationButton({
  quoteId,
  vendorName,
  currentTotal,
  round,
}: {
  quoteId: string;
  vendorName: string;
  currentTotal: number;
  round: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-secondary btn-xs" onClick={() => setOpen(true)}>
        Record negotiation
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Negotiation round ${round} — ${vendorName}`}
        description={`Opening position for this round is ${money(currentTotal)}. Record what the vendor conceded and through which channel.`}
        size="lg"
      >
        <ActionForm
          action={recordNegotiationAction}
          layout="bare"
          submitLabel="Record round"
          hiddenFields={{ quoteId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={2}>
            <Field
              label="Negotiated total"
              name="negotiatedTotal"
              required
              hint={`Must be the new all-in total, not the reduction. Opening position ${money(currentTotal)}.`}
            >
              <TextInput type="number" step="any" min="0" name="negotiatedTotal" />
            </Field>
            <Field label="Final agreed total" name="finalTotal" hint="Only if this round concluded the negotiation.">
              <TextInput type="number" step="any" min="0" name="finalTotal" />
            </Field>
            <Field label="Channel" name="channel" required>
              <Select
                name="channel"
                options={NEGOTIATION_CHANNELS.map((c) => ({ value: c, label: humanize(c) }))}
                defaultValue="CALL"
              />
            </Field>
            <Field label="Outcome" name="outcome" required>
              <Select name="outcome" options={OUTCOMES.map((c) => ({ value: c, label: humanize(c) }))} defaultValue="ACCEPTED" />
            </Field>
            <Field
              label="What was discussed and conceded"
              name="notes"
              span
              required
              hint="Record the leverage used — previous price, competing offer, market rate, volume — so the saving is defensible."
            >
              <TextArea name="notes" rows={4} />
            </Field>
          </FormSection>
        </ActionForm>
      </Modal>
    </>
  );
}

export function ComparativeBuilder({
  rfqId,
  quoteCount,
  minQuotes,
  suggestedMarketPrice,
  criteria,
}: {
  rfqId: string;
  quoteCount: number;
  minQuotes: number;
  suggestedMarketPrice: number | null;
  criteria: Array<{ key: string; label: string; weight: number }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Build comparative
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Build cost comparative"
        description="Compares every quotation side by side against the previous purchase price and the market rate, and scores them on weighted criteria. Nothing is auto-selected — you record the recommendation separately."
        size="lg"
      >
        <ActionForm
          action={buildComparativeAction}
          layout="bare"
          submitLabel="Build comparative"
          hiddenFields={{ rfqId }}
          onSuccessRedirect={(data) => {
            const d = data as { id?: string } | null;
            return d?.id ? `/comparatives/${d.id}` : `/rfq/${rfqId}`;
          }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          {quoteCount < minQuotes && (
            <InlineAlert tone="warning">
              Only {quoteCount} of the {minQuotes} required quotations have been recorded. The comparative will still be
              built, but an insufficient-quotations exception is raised unless the case is below the configured waiver
              value.
            </InlineAlert>
          )}

          <FormSection title="Baselines" columns={2}>
            <Field
              label="Market price for the full basket"
              name="marketPrice"
              hint="Prevailing market cost for the same quantity. Used to measure timing and negotiation savings when there is no recent purchase history."
            >
              <TextInput
                type="number"
                step="any"
                min="0"
                name="marketPrice"
                defaultValue={suggestedMarketPrice ?? ""}
              />
            </Field>
            <Field label="Notes on the comparison" name="notes" span>
              <TextArea
                name="notes"
                rows={3}
                placeholder="Where offers differ materially, and anything a reviewer needs to know to judge them fairly."
              />
            </Field>
          </FormSection>

          <FormSection
            title="Evaluation weighting"
            description="Weights determine the advisory score. The lowest compliant quotation is always flagged separately, so a low score never hides a cheaper compliant offer."
            columns={3}
          >
            {criteria.map((c) => (
              <Field key={c.key} label={c.label} name={`weight_${c.key}`}>
                <TextInput type="number" min="0" max="100" name={`weight_${c.key}`} defaultValue={c.weight} />
              </Field>
            ))}
          </FormSection>
        </ActionForm>
      </Modal>
    </>
  );
}
