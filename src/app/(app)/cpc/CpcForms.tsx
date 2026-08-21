"use client";

import { useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Checkbox, Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { money } from "@/lib/format";
import {
  castVoteAction,
  recordMinutesAction,
  resolveCaseAction,
  scheduleMeetingAction,
} from "./actions";

/* ── Voting ───────────────────────────────────────────────── */

const VOTES = [
  { value: "APPROVE", label: "Approve — proceed to purchase order" },
  { value: "REJECT", label: "Reject — do not proceed" },
  { value: "RETURN", label: "Return to procurement for rework" },
  { value: "REQUEST_CLARIFICATION", label: "Request clarification before deciding" },
  { value: "ABSTAIN", label: "Abstain — conflict of interest or no view" },
];

export function CastVoteForm({
  caseId,
  number,
  amount,
  vendorName,
  isChair,
  existingVote,
}: {
  caseId: string;
  number: string;
  amount: number;
  vendorName: string | null;
  isChair: boolean;
  existingVote: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [vote, setVote] = useState(existingVote ?? "APPROVE");
  const [final, setFinal] = useState(false);
  const needsComment = vote !== "APPROVE";

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        {existingVote ? "Change vote" : "Cast decision"}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Your decision on ${number}`}
        description={`${vendorName ? `${vendorName} · ` : ""}${money(amount)}. Anything other than an approval needs a written reason, and every vote is attributed to you permanently.`}
        size="lg"
      >
        <ActionForm
          action={castVoteAction}
          layout="bare"
          submitLabel="Record my decision"
          hiddenFields={{ caseId, vote, final: final ? "true" : "" }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={1}>
            <Field label="Decision" name="voteChoice" required>
              <Select name="voteChoice" value={vote} onChange={(e) => setVote(e.target.value)} options={VOTES} />
            </Field>
            <Field
              label="Comment"
              name="comment"
              required={needsComment}
              hint={
                needsComment
                  ? "Mandatory. State precisely what needs to change or why the committee should not proceed."
                  : "Optional, but a line of reasoning helps whoever reads this later."
              }
            >
              <TextArea name="comment" rows={4} />
            </Field>
            {isChair && (
              <Field label="Chair authority" name="finalChoice">
                <Checkbox
                  label="Conclude the case on this vote"
                  checked={final}
                  onChange={(e) => setFinal(e.target.checked)}
                  hint="As chair you may close the case without waiting for every required member. Use sparingly — the missing votes are visible on the record."
                />
              </Field>
            )}
          </FormSection>

          {existingVote && (
            <InlineAlert tone="info">
              You have already voted {humanize(existingVote).toLowerCase()} on this case. Submitting again replaces your
              vote, and the change is logged.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

/* ── Chair resolution ─────────────────────────────────────── */

export function ResolveCaseForm({
  caseId,
  number,
  votesCast,
  votesRequired,
}: {
  caseId: string;
  number: string;
  votesCast: number;
  votesRequired: number;
}) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState("APPROVED");
  const incomplete = votesCast < votesRequired;

  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        Record committee outcome
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Committee outcome for ${number}`}
        description="The chair records the committee's conclusion. Approval releases the requisition to PO preparation; everything else sends it back with reasons."
        size="lg"
      >
        <ActionForm
          action={resolveCaseAction}
          layout="bare"
          submitLabel="Record outcome"
          hiddenFields={{ caseId, outcome }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={1}>
            <Field label="Outcome" name="outcomeChoice" required>
              <Select
                name="outcomeChoice"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
                options={[
                  { value: "APPROVED", label: "Approved — proceed to purchase order" },
                  { value: "REJECTED", label: "Rejected — do not proceed" },
                  { value: "RETURNED", label: "Returned to procurement for rework" },
                  { value: "CLARIFICATION", label: "Clarification required before deciding" },
                  { value: "DEFERRED", label: "Deferred to a later meeting" },
                ]}
              />
            </Field>
            <Field
              label="Minuted reasoning"
              name="comment"
              required={outcome !== "APPROVED"}
              hint="This becomes part of the case record and the requisition's timeline."
            >
              <TextArea name="comment" rows={4} />
            </Field>
          </FormSection>

          {incomplete && (
            <InlineAlert tone="warning">
              Only {votesCast} of {votesRequired} required members have voted. Recording an outcome now closes the case
              regardless — the absent members stay visible on the record.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

/* ── Meetings ─────────────────────────────────────────────── */

export function ScheduleMeetingForm({
  entities,
  pendingCases,
  defaultEntityId,
}: {
  entities: Array<{ id: string; code: string; name: string }>;
  pendingCases: Array<{ id: string; number: string; title: string; amount: number; entityId: string; prNumber: string }>;
  defaultEntityId: string;
}) {
  const [open, setOpen] = useState(false);
  const [entityId, setEntityId] = useState(defaultEntityId);
  const [selected, setSelected] = useState<string[]>([]);

  const eligible = pendingCases.filter((c) => c.entityId === entityId);

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Schedule meeting
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Schedule a CPC meeting"
        description="Set the sitting and pull pending cases onto the agenda. Members are notified against each case they are required to decide."
        size="lg"
      >
        <ActionForm
          action={scheduleMeetingAction}
          layout="bare"
          submitLabel="Schedule meeting"
          hiddenFields={{ entityId }}
          onSuccessRedirect={(data) => {
            const d = data as { id?: string } | null;
            return d?.id ? `/cpc/meetings/${d.id}` : "/cpc/meetings";
          }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          {selected.map((id) => (
            <input key={id} type="hidden" name="caseIds" value={id} />
          ))}

          <FormSection columns={2}>
            <Field label="Entity" name="entitySelect" required>
              <Select
                name="entitySelect"
                value={entityId}
                onChange={(e) => {
                  setEntityId(e.target.value);
                  setSelected([]);
                }}
                options={entities.map((e) => ({ value: e.id, label: `${e.code} — ${e.name}` }))}
              />
            </Field>
            <Field label="Meeting type" name="meetingType" required>
              <Select
                name="meetingType"
                defaultValue="WEEKLY"
                options={[
                  { value: "WEEKLY", label: "Weekly sitting" },
                  { value: "ON_DEMAND", label: "On demand" },
                ]}
              />
            </Field>
            <Field label="Title" name="title" required>
              <TextInput name="title" placeholder="e.g. CPC weekly sitting" />
            </Field>
            <Field label="Date and time" name="scheduledAt" required>
              <TextInput type="datetime-local" name="scheduledAt" />
            </Field>
            <Field label="Location" name="location">
              <TextInput name="location" placeholder="e.g. Head office board room" />
            </Field>
            <Field label="Agenda" name="agenda" span>
              <TextArea name="agenda" rows={3} placeholder="Standing items and anything beyond the listed cases." />
            </Field>
          </FormSection>

          <div>
            <span className="label mb-1.5 block">Cases to table ({eligible.length} pending)</span>
            {eligible.length === 0 ? (
              <p className="text-xs text-[var(--c-text-secondary)]">
                No pending cases for this entity. The meeting can still be scheduled.
              </p>
            ) : (
              <div className="max-h-[16rem] space-y-1.5 overflow-y-auto pr-1">
                {eligible.map((c) => (
                  <Checkbox
                    key={c.id}
                    label={`${c.number} — ${c.title}`}
                    hint={`${c.prNumber} · ${money(c.amount)}`}
                    checked={selected.includes(c.id)}
                    onChange={() =>
                      setSelected((p) => (p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p, c.id]))
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </ActionForm>
      </Modal>
    </>
  );
}

export function MinutesForm({
  meetingId,
  number,
  existing,
  undecided,
}: {
  meetingId: string;
  number: string;
  existing: string | null;
  undecided: number;
}) {
  const [open, setOpen] = useState(false);
  const [complete, setComplete] = useState(false);

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        {existing ? "Update minutes" : "Record minutes"}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Minutes for ${number}`}
        description="What was discussed, who attended, and what the committee concluded. Closing the meeting does not decide the cases — each case carries its own recorded outcome."
        size="lg"
      >
        <ActionForm
          action={recordMinutesAction}
          layout="bare"
          submitLabel={complete ? "Save and close meeting" : "Save minutes"}
          hiddenFields={{ meetingId, complete: complete ? "true" : "" }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={1}>
            <Field label="Minutes" name="minutes" required>
              <TextArea name="minutes" rows={10} defaultValue={existing ?? ""} />
            </Field>
            <Field label="Close the meeting" name="completeChoice">
              <Checkbox
                label="Mark this meeting as completed"
                checked={complete}
                onChange={(e) => setComplete(e.target.checked)}
              />
            </Field>
          </FormSection>

          {complete && undecided > 0 && (
            <InlineAlert tone="warning">
              {undecided} case{undecided === 1 ? "" : "s"} on this agenda still have no recorded outcome. Closing the
              meeting leaves them open — they will need to be decided or moved to the next sitting.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}
