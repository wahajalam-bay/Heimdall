"use client";

import { useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { Badge, InlineAlert, Mono } from "@/components/ui/primitives";
import {
  finaliseMinutesAction,
  openMinutesAction,
  recordBasisAction,
} from "@/app/(app)/rfq/actions";

type Basis = {
  id: string;
  basis: string;
  label: string | null;
  discussed: boolean;
  notes: string | null;
};

type Minute = {
  id: string;
  number: string;
  status: string;
  channel: string;
  heldAt: string;
  location: string | null;
  conclusion: string | null;
  preparedByName: string;
  recommendedVendorName: string | null;
  participants: Array<{ id: string; side: string; name: string; designation: string | null }>;
  bases: Basis[];
};

/**
 * Negotiation Minutes on an RFQ.
 *
 * §4.5.1 asks for the minutes, the six bases, and the conclusion — so the form
 * lays the six out rather than offering a blank box, and each is answered one
 * way or the other before the minutes can close. A basis that never came up is
 * recorded as not raised, which is a different fact from a blank.
 */
export function NegotiationMinutes({
  rfqId,
  minutes,
  vendors,
  basisLabels,
  canRecord,
}: {
  rfqId: string;
  minutes: Minute[];
  vendors: Array<{ id: string; name: string }>;
  basisLabels: Record<string, string>;
  canRecord: boolean;
}) {
  const [openNew, setOpenNew] = useState(false);
  const [editing, setEditing] = useState<{ minuteId: string; basis: Basis } | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [discussed, setDiscussed] = useState(true);

  return (
    <div className="space-y-4">
      {canRecord && (
        <div className="flex justify-end">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpenNew(true)}>
            Record a negotiation
          </button>
        </div>
      )}

      {minutes.length === 0 && (
        <InlineAlert tone="warning">
          No negotiation minutes on this RFQ. §4.5.1 requires the negotiation, its bases and its conclusion to be
          documented — the price movements on their own record the outcome, not what was conceded to reach it.
        </InlineAlert>
      )}

      {minutes.map((m) => {
        const unanswered = m.bases.filter((b) => !b.discussed && !b.notes);
        return (
          <div key={m.id} className="rounded border border-[var(--c-border)]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--c-border)] px-3.5 py-2.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <Mono className="text-xs font-semibold">{m.number}</Mono>
                <Badge tone={m.status === "FINALISED" ? "success" : "warning"}>{m.status}</Badge>
                <span className="text-2xs text-[var(--c-text-tertiary)]">
                  {basisLabels[m.channel] ?? m.channel} · {new Date(m.heldAt).toLocaleDateString()}
                  {m.location ? ` · ${m.location}` : ""}
                </span>
              </div>
              {m.status === "DRAFT" && canRecord && (
                <button type="button" className="btn btn-primary btn-xs" onClick={() => setClosing(m.id)}>
                  Finalise
                </button>
              )}
            </div>

            <div className="px-3.5 py-2.5 text-2xs">
              <span className="text-[var(--c-text-tertiary)]">Attending: </span>
              {m.participants
                .map((p) => `${p.name}${p.designation ? ` (${p.designation})` : ""}`)
                .join(" · ")}
            </div>

            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: "16rem" }}>Basis</th>
                    <th style={{ width: "7rem" }}>Raised</th>
                    <th style={{ minWidth: "18rem" }}>What was discussed</th>
                    {m.status === "DRAFT" && canRecord && <th style={{ width: "5rem" }} />}
                  </tr>
                </thead>
                <tbody>
                  {m.bases.map((b) => (
                    <tr key={b.id}>
                      <td className="text-xs">{b.label ?? basisLabels[b.basis] ?? b.basis}</td>
                      <td>
                        {b.discussed ? (
                          <Badge tone="success">Yes</Badge>
                        ) : b.notes ? (
                          <Badge tone="info">Not raised</Badge>
                        ) : (
                          <span className="text-2xs text-[var(--c-text-tertiary)]">Unanswered</span>
                        )}
                      </td>
                      <td className="text-2xs leading-4 text-muted">{b.notes ?? "—"}</td>
                      {m.status === "DRAFT" && canRecord && (
                        <td>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => {
                              setDiscussed(b.discussed);
                              setEditing({ minuteId: m.id, basis: b });
                            }}
                          >
                            Record
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {m.conclusion ? (
              <p className="border-t border-[var(--c-border)] px-3.5 py-2.5 text-xs leading-5">
                <span className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Conclusion — </span>
                {m.conclusion}
                {m.recommendedVendorName ? ` (${m.recommendedVendorName})` : ""}
                <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                  Prepared and signed by {m.preparedByName}
                </span>
              </p>
            ) : (
              unanswered.length > 0 && (
                <p className="border-t border-[var(--c-border)] px-3.5 py-2 text-2xs text-[var(--c-text-tertiary)]">
                  {unanswered.length} bas{unanswered.length === 1 ? "is" : "es"} unanswered — the minutes cannot be
                  finalised until each is either recorded or marked as not raised.
                </p>
              )
            )}
          </div>
        );
      })}

      <Modal
        open={openNew}
        onClose={() => setOpenNew(false)}
        title="Record a negotiation"
        description="§4.5.1: a price negotiating call or meeting conducted by procurement with the vendors."
        size="md"
      >
        <ActionForm
          action={openMinutesAction}
          layout="bare"
          submitLabel="Open the minutes"
          hiddenFields={{ rfqId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpenNew(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={2}>
            <Field label="When it took place" name="heldAt" required>
              <TextInput type="datetime-local" name="heldAt" required />
            </Field>
            <Field label="How" name="channel" required>
              <Select
                name="channel"
                required
                defaultValue="CALL"
                options={[
                  { value: "CALL", label: "Call" },
                  { value: "MEETING", label: "Meeting" },
                  { value: "EMAIL", label: "Email" },
                  { value: "PORTAL", label: "Portal" },
                  { value: "WHATSAPP", label: "WhatsApp" },
                ]}
              />
            </Field>
            <Field label="Where" name="location" hint="For a meeting. Leave blank for a call.">
              <TextInput name="location" />
            </Field>
            <Field label="Vendor" name="vendorId" required>
              <Select
                name="vendorId"
                required
                placeholder="Choose the vendor…"
                options={vendors.map((v) => ({ value: v.id, label: v.name }))}
              />
            </Field>
            <Field label="Who attended for the vendor" name="vendorName" required>
              <TextInput name="vendorName" required placeholder="Name as given" />
            </Field>
            <Field label="Their designation" name="vendorTitle">
              <TextInput name="vendorTitle" />
            </Field>
          </FormSection>
          <InlineAlert tone="info">
            You are recorded as attending for procurement. The six bases §4.5.1 names are laid out once the minutes
            open, and each has to be answered before they can be finalised.
          </InlineAlert>
        </ActionForm>
      </Modal>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? (editing.basis.label ?? basisLabels[editing.basis.basis] ?? editing.basis.basis) : ""}
        description="What was discussed against this basis — or that it was not raised."
        size="md"
      >
        {editing && (
          <ActionForm
            action={recordBasisAction}
            layout="bare"
            submitLabel="Record"
            hiddenFields={{
              rfqId,
              minuteId: editing.minuteId,
              basis: editing.basis.basis,
              label: editing.basis.label ?? "",
            }}
            secondary={
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
            }
          >
            <Field label="Was it raised?" name="discussed">
              <Select
                name="discussed"
                value={discussed ? "true" : "false"}
                onChange={(e) => setDiscussed(e.target.value === "true")}
                options={[
                  { value: "true", label: "Yes — it was discussed" },
                  { value: "false", label: "No — it was not raised" },
                ]}
              />
            </Field>
            <Field
              label={discussed ? "What was discussed and agreed" : "Why it was not raised"}
              name="notes"
              required
              hint={
                discussed
                  ? "A basis ticked as covered with nothing written against it records that a box was ticked."
                  : "A basis that genuinely did not come up is worth recording as such."
              }
            >
              <TextArea name="notes" rows={3} required defaultValue={editing.basis.notes ?? ""} />
            </Field>
          </ActionForm>
        )}
      </Modal>

      <Modal
        open={!!closing}
        onClose={() => setClosing(null)}
        title="Finalise the minutes"
        description="§4.5.1 requires the conclusion to be documented. Finalised minutes are signed and cannot be edited."
        size="md"
      >
        {closing && (
          <ActionForm
            action={finaliseMinutesAction}
            layout="bare"
            submitLabel="Finalise and sign"
            hiddenFields={{ rfqId, minuteId: closing }}
            secondary={
              <button type="button" className="btn btn-secondary" onClick={() => setClosing(null)}>
                Cancel
              </button>
            }
          >
            <Field label="Conclusion" name="conclusion" required>
              <TextArea name="conclusion" rows={3} required />
            </Field>
            <Field label="Vendor concluded for" name="recommendedVendorId">
              <Select
                name="recommendedVendorId"
                placeholder="None yet"
                options={vendors.map((v) => ({ value: v.id, label: v.name }))}
              />
            </Field>
            <InlineAlert tone="warning">
              Your name and the office you hold go on the record, along with a hash of the minutes as signed. They
              cannot be edited afterwards.
            </InlineAlert>
          </ActionForm>
        )}
      </Modal>
    </div>
  );
}
