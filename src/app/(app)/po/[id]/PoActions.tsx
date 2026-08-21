"use client";

import Link from "next/link";
import { ActionButton } from "@/components/ui/forms";
import { BlockedNotice, InlineAlert } from "@/components/ui/primitives";
import {
  cancelPoAction,
  closePoAction,
  decidePoAction,
  holdPoAction,
  issuePoAction,
  setAdvanceStatusAction,
  submitPoAction,
} from "../actions";

export type PoCapabilities = {
  canSubmit: boolean;
  canDecide: boolean;
  decideReason: string | null;
  pendingStepName: string | null;
  canIssue: boolean;
  issueBlockers: string[];
  canClose: boolean;
  hasPending: boolean;
  canCancel: boolean;
  cancelBlockers: string[];
  canHold: boolean;
  canRecordGatePass: boolean;
  canReceive: boolean;
  canInvoice: boolean;
  canManageAdvance: boolean;
  advanceStatus: string | null;
  status: string;
};

export function PoActions({
  poId,
  poNumber,
  caps,
}: {
  poId: string;
  poNumber: string;
  caps: PoCapabilities;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {caps.canSubmit && (
          <ActionButton
            action={submitPoAction}
            payload={{ poId }}
            label="Submit for approval"
            tone="primary"
            confirm={`Submit ${poNumber} for approval? Routing follows the configured value thresholds.`}
          />
        )}

        {caps.canDecide && (
          <>
            <ActionButton
              action={decidePoAction}
              payload={{ poId, decision: "APPROVED" }}
              label={caps.pendingStepName ? `Approve — ${caps.pendingStepName}` : "Approve"}
              tone="success"
              reasonLabel="Approval comment (optional)"
            />
            <ActionButton
              action={decidePoAction}
              payload={{ poId, decision: "RETURNED" }}
              label="Return to buyer"
              tone="secondary"
              reasonLabel="What needs to change before this order can be approved?"
              reasonRequired
            />
            <ActionButton
              action={decidePoAction}
              payload={{ poId, decision: "REJECTED" }}
              label="Reject"
              tone="danger-soft"
              reasonLabel="Reason for rejection — recorded permanently."
              reasonRequired
            />
          </>
        )}

        {caps.canIssue && caps.issueBlockers.length === 0 && (
          <ActionButton
            action={issuePoAction}
            payload={{ poId }}
            label="Issue to vendor"
            tone="primary"
            confirm={`Issue ${poNumber} to the vendor? Receiving tasks are created for the delivery store.`}
          />
        )}

        {caps.canRecordGatePass && (
          <Link href={`/gate-passes/new?poId=${poId}`} className="btn btn-secondary btn-sm">
            Record gate pass
          </Link>
        )}
        {caps.canReceive && (
          <Link href={`/receiving/new?poId=${poId}`} className="btn btn-secondary btn-sm">
            Record receipt
          </Link>
        )}
        {caps.canInvoice && (
          <Link href={`/invoices/new?poId=${poId}`} className="btn btn-secondary btn-sm">
            Register invoice
          </Link>
        )}

        {caps.canManageAdvance && caps.advanceStatus && caps.advanceStatus !== "SETTLED" && (
          <ActionButton
            action={setAdvanceStatusAction}
            payload={{
              poId,
              status:
                caps.advanceStatus === "PENDING" ? "APPROVED" : caps.advanceStatus === "APPROVED" ? "PAID" : "SETTLED",
            }}
            label={
              caps.advanceStatus === "PENDING"
                ? "Approve advance"
                : caps.advanceStatus === "APPROVED"
                  ? "Mark advance paid"
                  : "Settle advance"
            }
            tone="secondary"
            reasonLabel="Payment or settlement reference"
          />
        )}

        {caps.canHold && !["CLOSED", "CANCELLED", "ON_HOLD"].includes(caps.status) && (
          <ActionButton
            action={holdPoAction}
            payload={{ poId }}
            label="Place on hold"
            tone="secondary"
            reasonLabel="Why is this order being held?"
            reasonRequired
          />
        )}

        {caps.canClose && (
          <ActionButton
            action={closePoAction}
            payload={{ poId }}
            label={caps.hasPending ? "Short-close" : "Close order"}
            tone={caps.hasPending ? "danger-soft" : "secondary"}
            reasonLabel={
              caps.hasPending
                ? "This order still has pending quantity. State why it is being short-closed — this is recorded as an exception."
                : "Closure note (optional)"
            }
            reasonRequired={caps.hasPending}
          />
        )}

        {caps.canCancel && caps.cancelBlockers.length === 0 && (
          <ActionButton
            action={cancelPoAction}
            payload={{ poId }}
            label="Cancel order"
            tone="danger-soft"
            reasonLabel="Reason for cancellation"
            reasonRequired
          />
        )}
      </div>

      {caps.issueBlockers.length > 0 && caps.canIssue && (
        <div className="mt-3">
          <BlockedNotice title="This order cannot be issued yet" reasons={caps.issueBlockers} />
        </div>
      )}

      {caps.cancelBlockers.length > 0 && (
        <div className="mt-3">
          <BlockedNotice
            title="This order can no longer be cancelled"
            reasons={caps.cancelBlockers}
            tone="info"
          />
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
    </>
  );
}
