"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ActionButton, Modal, Spinner } from "@/components/ui/forms";
import { BlockedNotice, InlineAlert } from "@/components/ui/primitives";
import {
  amendPrAction,
  cancelPrAction,
  decidePrAction,
  holdPrAction,
  releaseHoldAction,
  startSourcingAction,
  submitPrAction,
  validatePrAction,
} from "../actions";

export type CaseCapabilities = {
  canEdit: boolean;
  /** An approved requisition can be amended — reopened with a reason, not edited. */
  canAmend: boolean;
  canSubmit: boolean;
  canDecide: boolean;
  decideReason: string | null;
  pendingStepName: string | null;
  canStartSourcing: boolean;
  canRaiseRfq: boolean;
  canHold: boolean;
  canCancel: boolean;
  canCreatePo: boolean;
  poReadinessIssues: string[];
  cpcRequired: boolean;
  cpcCleared: boolean;
  onHold: boolean;
  holdReason: string | null;
  status: string;
};

/**
 * The decision surface for a procurement case. Everything an approver needs is
 * on this bar; the server re-checks every permission and rule behind each action.
 */
export function CaseActions({
  prId,
  prNumber,
  caps,
}: {
  prId: string;
  prNumber: string;
  caps: CaseCapabilities;
}) {
  const router = useRouter();
  const [checkOpen, setCheckOpen] = useState(false);
  const [issues, setIssues] = useState<string[] | null>(null);
  const [pending, start] = useTransition();

  const runCheck = () => {
    setCheckOpen(true);
    setIssues(null);
    start(async () => {
      const fd = new FormData();
      fd.set("prId", prId);
      const res = await validatePrAction(fd);
      if (res.ok) setIssues((res.data as { issues: string[] }).issues);
      else setIssues([res.error]);
    });
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {caps.canEdit && (
          <Link href={`/pr/${prId}/edit`} className="btn btn-secondary btn-sm">
            Edit
          </Link>
        )}

        {caps.canAmend && (
          <ActionButton
            action={amendPrAction}
            payload={{ prId }}
            label="Amend"
            reasonLabel="Why the requisition is being amended"
            reasonRequired
            confirm={`Amend ${prNumber}? It goes back to the requester as a new version, and the approval already given will no longer cover it.`}
          />
        )}

        {caps.canSubmit && (
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={runCheck}>
              Readiness check
            </button>
            <ActionButton
              action={submitPrAction}
              payload={{ prId }}
              label="Submit for approval"
              tone="primary"
              confirm={`Submit ${prNumber} for approval? Approval routing is determined by the configured thresholds for this entity.`}
            />
          </>
        )}

        {caps.canDecide && (
          <>
            <ActionButton
              action={decidePrAction}
              payload={{ prId, decision: "APPROVED" }}
              label={caps.pendingStepName ? `Approve — ${caps.pendingStepName}` : "Approve"}
              tone="success"
              reasonLabel="Approval comment (optional)"
            />
            <ActionButton
              action={decidePrAction}
              payload={{ prId, decision: "RETURNED" }}
              label="Return"
              tone="secondary"
              reasonLabel="Why is this being returned? The requester will see this."
              reasonRequired
            />
            <ActionButton
              action={decidePrAction}
              payload={{ prId, decision: "CLARIFICATION_REQUESTED" }}
              label="Request clarification"
              tone="secondary"
              reasonLabel="What clarification do you need?"
              reasonRequired
            />
            <ActionButton
              action={decidePrAction}
              payload={{ prId, decision: "REJECTED" }}
              label="Reject"
              tone="danger-soft"
              reasonLabel="Reason for rejection — this is recorded permanently in the audit trail."
              reasonRequired
            />
          </>
        )}

        {caps.canStartSourcing && (
          <ActionButton
            action={startSourcingAction}
            payload={{ prId }}
            label="Start sourcing"
            tone="primary"
          />
        )}

        {caps.canRaiseRfq && (
          <Link href={`/rfq/new?prId=${prId}`} className="btn btn-primary btn-sm">
            Raise RFQ
          </Link>
        )}

        {caps.canCreatePo && (
          <Link href={`/po/new?prId=${prId}`} className="btn btn-primary btn-sm">
            Create purchase order
          </Link>
        )}

        {caps.canHold && !caps.onHold && (
          <ActionButton
            action={holdPrAction}
            payload={{ prId }}
            label="Place on hold"
            tone="secondary"
            reasonLabel="Why is this case being held?"
            reasonRequired
          />
        )}
        {caps.canHold && caps.onHold && (
          <ActionButton
            action={releaseHoldAction}
            payload={{ prId, to: "PROCUREMENT_REVIEW" }}
            label="Release hold"
            tone="secondary"
            reasonLabel="Note on releasing the hold (optional)"
          />
        )}

        {caps.canCancel && (
          <ActionButton
            action={cancelPrAction}
            payload={{ prId }}
            label="Cancel"
            tone="danger-soft"
            reasonLabel="Reason for cancellation"
            reasonRequired
          />
        )}
      </div>

      {caps.onHold && caps.holdReason && (
        <div className="mt-3">
          <InlineAlert tone="warning">
            <span className="font-600">On hold: </span>
            {caps.holdReason}
          </InlineAlert>
        </div>
      )}

      {!caps.canDecide && caps.decideReason && caps.pendingStepName && (
        <div className="mt-3">
          <InlineAlert tone="info">
            <span className="font-600">{caps.pendingStepName}: </span>
            {caps.decideReason}
          </InlineAlert>
        </div>
      )}

      {caps.poReadinessIssues.length > 0 && caps.status !== "CLOSED" && (
        <div className="mt-3">
          <BlockedNotice
            title="A purchase order cannot be raised yet"
            reasons={caps.poReadinessIssues}
            tone={caps.cpcRequired && !caps.cpcCleared ? "warning" : "info"}
          />
        </div>
      )}

      <Modal
        open={checkOpen}
        onClose={() => setCheckOpen(false)}
        title="Submission readiness"
        description={`Checks ${prNumber} against the mandatory-information rules configured for this entity and procurement type.`}
        footer={
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCheckOpen(false)}>
            Close
          </button>
        }
      >
        {pending || issues === null ? (
          <p className="flex items-center gap-2 text-xs text-muted">
            <Spinner size={12} /> Running checks…
          </p>
        ) : issues.length === 0 ? (
          <div className="rounded-2xl alert-success px-3 py-2.5 text-xs text-[var(--c-success)]">
            All mandatory information is present. This requisition is ready to submit.
          </div>
        ) : (
          <div>
            <p className="mb-2 text-xs text-muted">
              {issues.length} item(s) must be resolved before this requisition can be submitted:
            </p>
            <ul className="space-y-1.5">
              {issues.map((i, idx) => (
                <li
                  key={idx}
                  className="rounded-2xl alert-warning px-2.5 py-1.5 text-xs text-[var(--c-warning)]"
                >
                  {i}
                </li>
              ))}
            </ul>
            <div className="mt-3">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setCheckOpen(false);
                  router.push(`/pr/${prId}/edit`);
                }}
              >
                Edit requisition
              </button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
