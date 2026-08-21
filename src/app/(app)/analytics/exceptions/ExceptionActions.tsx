"use client";

import { useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { resolveExceptionAction } from "./actions";

/**
 * Closing out an exception. The outcome wording is deliberate: resolving means
 * the cause is gone, accepting means it stands and is tolerated, waiving means a
 * control was overridden — and only the last of those clears a blocking flag.
 */
export function ResolveExceptionForm({
  exceptionId,
  number,
  title,
  blocking,
  status,
  canWaive,
}: {
  exceptionId: string;
  number: string;
  title: string;
  blocking: boolean;
  status: string;
  canWaive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState(status === "OPEN" ? "IN_PROGRESS" : "RESOLVED");

  const options = [
    { value: "IN_PROGRESS", label: "Take it up — work has started" },
    { value: "RESOLVED", label: "Resolved — the underlying cause is fixed" },
    { value: "ACCEPTED", label: "Accepted — it stands and is tolerated" },
    ...(canWaive || !blocking ? [{ value: "WAIVED", label: "Waived — a control was deliberately overridden" }] : []),
    { value: "CLOSED", label: "Closed — no longer relevant" },
  ];

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        {status === "OPEN" ? "Act on exception" : "Close out"}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`${number} — ${title}`}
        description="Every outcome other than taking it up requires a written resolution. What is recorded here is what an auditor reads."
        size="lg"
      >
        <ActionForm
          action={resolveExceptionAction}
          layout="bare"
          submitLabel="Record outcome"
          hiddenFields={{ exceptionId, outcome }}
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
                options={options}
              />
            </Field>
            <Field
              label="Resolution"
              name="resolution"
              required={outcome !== "IN_PROGRESS"}
              hint={
                outcome === "WAIVED"
                  ? "State precisely what was overridden, on whose authority and why the risk is acceptable."
                  : "What was actually done, and what stops it recurring."
              }
            >
              <TextArea name="resolution" rows={4} />
            </Field>
          </FormSection>

          {outcome === "WAIVED" && blocking && (
            <InlineAlert tone="danger">
              This exception is blocking. Waiving it removes the block and lets the transaction proceed. The override is
              permanent, attributed to you, and notified to the Procurement Director, Finance and Audit.
            </InlineAlert>
          )}
          {outcome === "ACCEPTED" && (
            <InlineAlert tone="warning">
              Accepting leaves the condition in place. If it is blocking, it stays blocking — use a waiver if the
              transaction genuinely needs to move.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}
