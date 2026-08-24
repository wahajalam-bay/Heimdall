"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui/forms";
import { Badge, EmptyState, InlineAlert, Mono, RefLink } from "@/components/ui/primitives";
import { classNames, relativeTime } from "@/lib/format";
import { decidePrAction } from "../pr/actions";
import { decidePoAction } from "../po/actions";
import { decideInvoiceAction } from "../invoices/actions";

export type QueueItem = {
  taskId: string;
  documentType: string;
  documentId: string;
  documentRef: string;
  title: string;
  description: string | null;
  linkUrl: string | null;
  dueAt: string | null;
  overdue: boolean;
};

type Decision = "APPROVED" | "RETURNED";

/** Which action handles which document, and what its id field is called. */
const HANDLERS: Record<string, { field: string; run: (fd: FormData) => Promise<{ ok: boolean; error?: string }> }> = {
  PR: { field: "prId", run: decidePrAction },
  MATERIAL_DEMAND: { field: "prId", run: decidePrAction },
  PO: { field: "poId", run: decidePoAction },
  INVOICE: { field: "invoiceId", run: decideInvoiceAction },
};

/**
 * The approvals queue, actionable in place.
 *
 * This is the highest-frequency action in the system, and opening a record to
 * press one button is most of the cost. A decision here shows immediately —
 * `useOptimistic` removes the row before the server answers — and a refusal puts
 * the row back with the reason the server gave, so nothing is quietly lost.
 */
export function ApprovalQueue({ items }: { items: QueueItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failures, setFailures] = useState<Record<string, string>>({});
  // Decisions the server has confirmed. The row leaves on confirmation rather
  // than waiting for the whole page to re-render, which on this screen means
  // several queries — a spinner sitting there for seconds after the work is done
  // reads as a hang.
  const [settled, setSettled] = useState<string[]>([]);

  // Optimistic state is "which rows are on their way out, and how".
  const [inFlight, markInFlight] = useOptimistic<Record<string, Decision>, { id: string; decision: Decision }>(
    {},
    (state, action) => ({ ...state, [action.id]: action.decision }),
  );

  const decide = (item: QueueItem, decision: Decision) => {
    const handler = HANDLERS[item.documentType];
    if (!handler) return;

    // A return has to be explained — that is the whole point of returning it.
    let reason: string | null = null;
    if (decision === "RETURNED") {
      reason = window.prompt(`Return ${item.documentRef} to the requester. What needs to change?`);
      if (!reason?.trim()) return;
    }

    setFailures((f) => {
      const { [item.taskId]: _dropped, ...rest } = f;
      return rest;
    });

    start(async () => {
      markInFlight({ id: item.taskId, decision });
      const fd = new FormData();
      fd.set(handler.field, item.documentId);
      fd.set("decision", decision);
      if (reason) fd.set("reason", reason.trim());
      const res = await handler.run(fd);
      if (res.ok) {
        setSettled((s) => [...s, item.taskId]);
      } else {
        setFailures((f) => ({ ...f, [item.taskId]: res.error ?? "The decision was refused." }));
      }
    });

    // Reconcile with the server outside the transition, so the queue does not
    // sit on a spinner while the page re-renders behind it.
    void Promise.resolve().then(() => router.refresh());
  };

  const remaining = items.filter((i) => !settled.includes(i.taskId));
  const actionable = remaining.filter((i) => HANDLERS[i.documentType]);
  const readOnly = remaining.filter((i) => !HANDLERS[i.documentType]);

  if (!remaining.length) {
    return (
      <EmptyState
        title={settled.length ? "Queue cleared" : "No approvals waiting"}
        description={
          settled.length
            ? `${settled.length} decision${settled.length === 1 ? "" : "s"} recorded. Anything that follows from them will appear as new work.`
            : "When a requisition, order or invoice needs your decision it appears here, and can be actioned without leaving the page."
        }
        compact
      />
    );
  }

  return (
    <div className="space-y-2">
      {actionable.map((item) => {
        const state = inFlight[item.taskId];
        const error = failures[item.taskId];
        return (
          <div
            key={item.taskId}
            className={classNames(
              "flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-xl border px-3 py-2.5 transition-opacity",
              state ? "border-separator opacity-55" : "border-border",
              item.overdue && !state && "border-[var(--c-warning-border)] bg-[var(--c-warning-soft)]",
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                {item.linkUrl ? (
                  <RefLink href={item.linkUrl}>{item.documentRef}</RefLink>
                ) : (
                  <Mono>{item.documentRef}</Mono>
                )}
                <span className="min-w-0 flex-1 truncate text-xs">{item.title}</span>
                {item.overdue && <Badge tone="warning">Overdue</Badge>}
              </div>
              {item.description && (
                <p className="mt-0.5 truncate text-2xs text-[var(--c-text-tertiary)]">{item.description}</p>
              )}
              {item.dueAt && (
                <p className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">
                  Due {relativeTime(new Date(item.dueAt))}
                </p>
              )}
              {error && (
                <p className="mt-1 text-2xs text-[var(--c-danger)]" role="alert">
                  {error}
                </p>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {state ? (
                <span className="flex items-center gap-1.5 text-2xs text-muted">
                  <Spinner size={11} />
                  {state === "APPROVED" ? "Approving…" : "Returning…"}
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs"
                    onClick={() => decide(item, "RETURNED")}
                    disabled={pending}
                  >
                    Return
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-xs"
                    onClick={() => decide(item, "APPROVED")}
                    disabled={pending}
                  >
                    Approve
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}

      {readOnly.length > 0 && (
        <InlineAlert tone="info">
          {readOnly.length} approval{readOnly.length === 1 ? "" : "s"} of a kind that has to be decided on its own
          screen — committee cases and inspections carry evidence that belongs with the decision.
          <ul className="mt-1.5 space-y-1">
            {readOnly.map((r) => (
              <li key={r.taskId} className="flex items-baseline gap-2 text-2xs">
                {r.linkUrl ? <Link href={r.linkUrl}>{r.documentRef}</Link> : <Mono>{r.documentRef}</Mono>}
                <span className="truncate">{r.title}</span>
              </li>
            ))}
          </ul>
        </InlineAlert>
      )}
    </div>
  );
}
