import type { ReactNode } from "react";
import { classNames } from "@/lib/format";
import { fmtDateTime, relativeTime } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { Badge, Avatar } from "./primitives";

/* ── Lifecycle rail ───────────────────────────────────────── */

export type RailStep = {
  key: string;
  label: string;
  state: "done" | "current" | "pending" | "blocked" | "skipped";
  at?: Date | string | null;
  owner?: string | null;
  note?: string | null;
};

/**
 * Horizontal lifecycle visualiser. Makes "where is this stuck, and with whom"
 * answerable at a glance.
 */
/**
 * Depth of green for a completed stage. Six ramp steps spread across however
 * many stages this document has, so an early stage reads lighter than a late
 * one and progress is visible before any label is read.
 */
function stageColor(index: number, total: number) {
  const step = total <= 1 ? 6 : Math.min(6, Math.max(1, Math.round(1 + (index / (total - 1)) * 5)));
  return `var(--c-stage-${step})`;
}

/**
 * A named stretch of the rail.
 *
 * Some lifecycles are two pieces of work owned by two teams on one record. The
 * boundary belongs on the rail itself rather than in a note beside it: somebody
 * reading the rail is asking where this case is, and the answer includes whose
 * problem it currently is.
 */
export type RailSegment = { label: string; description?: string; upToKey: string };

export function LifecycleRail({
  steps,
  title,
  segments,
}: {
  steps: RailStep[];
  title?: string;
  /** Splits the rail into labelled stretches, each ending at `upToKey`. */
  segments?: RailSegment[];
}) {
  // Which segment each step belongs to, resolved once so the header can be drawn
  // above the first step of each stretch.
  const segmentOf = new Map<string, { segment: RailSegment; first: boolean; span: number }>();
  if (segments?.length) {
    let cursor = 0;
    for (const segment of segments) {
      const end = steps.findIndex((s, i) => i >= cursor && s.key === segment.upToKey);
      const last = end === -1 ? steps.length - 1 : end;
      for (let i = cursor; i <= last && i < steps.length; i += 1) {
        segmentOf.set(steps[i].key, { segment, first: i === cursor, span: last - cursor + 1 });
      }
      cursor = last + 1;
      if (cursor >= steps.length) break;
    }
  }

  return (
    <div className="card overflow-hidden">
      {title && (
        <div className="border-b border-separator px-4 py-2.5">
          <h3 className="text-[0.8125rem] font-600">{title}</h3>
        </div>
      )}
      <div className="rail px-4 pb-3 pt-0.5">
        {steps.map((s, i) => (
          <div
            key={s.key}
            className="rail-step"
            data-state={s.state}
            data-handover={segmentOf.get(s.key)?.first && i > 0 ? "true" : undefined}
          >
            {(() => {
              const seg = segmentOf.get(s.key);
              if (!seg) return null;
              // Every step carries the row so the headings line up across a
              // rail that scrolls; only the first of each stretch is labelled.
              return (
                <div className="relative mb-1.5 h-8">
                  {seg.first && (
                    // The heading names a stretch, not a step, so it runs across
                    // its stretch instead of being squeezed into one column.
                    <div className="absolute top-0 left-0 whitespace-nowrap">
                      <div className="label text-[var(--c-accent-text)]">{seg.segment.label}</div>
                      {seg.segment.description && (
                        <div className="text-2xs text-muted">{seg.segment.description}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
            <div className="flex items-center gap-1.5">
              <StepGlyph state={s.state} color={stageColor(i, steps.length)} />
              <span
                className={classNames(
                  "truncate text-xs font-500",
                  s.state === "pending" && "text-[var(--c-text-tertiary)]",
                  s.state === "skipped" && "text-[var(--c-text-tertiary)] line-through",
                  s.state === "current" && "text-[var(--c-accent-text)]",
                  s.state === "blocked" && "text-[var(--c-danger)]",
                )}
                title={s.label}
              >
                {s.label}
              </span>
            </div>
            <div className="mt-0.5 space-y-0.5 pl-[1.125rem]">
              {s.at && (
                <div className="text-2xs text-[var(--c-text-tertiary)]">{fmtDateTime(s.at)}</div>
              )}
              {s.owner && (
                <div className="truncate text-2xs text-muted" title={s.owner}>
                  {s.owner}
                </div>
              )}
              {s.note && <div className="text-2xs text-[var(--c-warning)]">{s.note}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StepGlyph({ state, color }: { state: RailStep["state"]; color: string }) {
  if (state === "done") {
    return (
      <span
        className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full text-white"
        style={{ background: color }}
      >
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path d="m2 5.2 2 2 4-4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (state === "current") {
    return (
      <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-[var(--c-accent)] opacity-25" />
        <span className="size-2.5 rounded-full border-2 border-[var(--c-accent)] bg-[var(--c-surface)]" />
      </span>
    );
  }
  if (state === "blocked") {
    return (
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full bg-[var(--c-danger)] text-white">
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path d="M5 2.4v3M5 7.3h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return (
    <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
      <span className="size-2 rounded-full border border-[var(--c-border-strong)] bg-[var(--c-surface)]" />
    </span>
  );
}

/**
 * Derives rail steps from an ordered status list and the document's current
 * status, marking anything the document never reached as pending/skipped.
 */
export function buildRail(
  lifecycle: readonly string[],
  current: string,
  reached: Record<string, { at?: Date | string | null; owner?: string | null }> = {},
  opts?: { skipped?: string[]; blockedNote?: string | null; terminalBad?: boolean },
): RailStep[] {
  const idx = lifecycle.indexOf(current);
  const bad = opts?.terminalBad ?? false;
  return lifecycle.map((s, i) => {
    if (opts?.skipped?.includes(s)) {
      return { key: s, label: humanize(s), state: "skipped" as const };
    }
    let state: RailStep["state"];
    if (idx === -1) {
      state = i === 0 ? "done" : "pending";
    } else if (i < idx) state = "done";
    else if (i === idx) state = bad ? "blocked" : "current";
    else state = "pending";
    const meta = reached[s] ?? {};
    return {
      key: s,
      label: humanize(s),
      state,
      at: meta.at ?? null,
      owner: meta.owner ?? null,
      note: state === "current" && opts?.blockedNote ? opts.blockedNote : null,
    };
  });
}

/* ── Timeline ─────────────────────────────────────────────── */

export type TimelineEvent = {
  id: string;
  at: Date | string;
  title: string;
  detail?: ReactNode;
  actor?: string | null;
  actorRoles?: string | null;
  tone?: "neutral" | "success" | "warning" | "danger" | "info" | "accent";
  ref?: string | null;
};

export function Timeline({ events, emptyLabel }: { events: TimelineEvent[]; emptyLabel?: string }) {
  if (!events.length) {
    return (
      <p className="px-1 py-6 text-center text-xs text-muted">
        {emptyLabel ?? "No activity recorded yet."}
      </p>
    );
  }
  return (
    <ol className="tl">
      {events.map((e) => (
        <li key={e.id} className="tl-item">
          <span
            className="tl-dot"
            style={{
              background:
                e.tone === "success"
                  ? "var(--c-success)"
                  : e.tone === "warning"
                    ? "var(--c-warning)"
                    : e.tone === "danger"
                      ? "var(--c-danger)"
                      : e.tone === "info"
                        ? "var(--c-info)"
                        : e.tone === "accent"
                          ? "var(--c-accent)"
                          : "var(--c-border-strong)",
            }}
          />
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[0.8125rem] font-500 leading-5">{e.title}</span>
            {e.ref && <span className="mono text-[var(--c-text-tertiary)]">{e.ref}</span>}
            <span className="ml-auto shrink-0 text-2xs text-[var(--c-text-tertiary)]" title={fmtDateTime(e.at)}>
              {fmtDateTime(e.at)}
            </span>
          </div>
          {e.detail && (
            <div className="mt-0.5 text-xs leading-5 text-muted">{e.detail}</div>
          )}
          {e.actor && (
            <div className="mt-1 flex items-center gap-1.5">
              <Avatar name={e.actor} size={16} />
              <span className="text-2xs text-muted">
                {e.actor}
                {e.actorRoles && <span className="text-[var(--c-text-tertiary)]"> · {e.actorRoles}</span>}
              </span>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

/* ── Approval trail ───────────────────────────────────────── */

export function ApprovalTrailView({
  trails,
}: {
  trails: Array<{
    instanceId: string;
    status: string;
    amount: number;
    ruleName: string | null;
    startedAt: Date;
    completedAt: Date | null;
    steps: Array<{
      id: string;
      sequence: number;
      stepName: string;
      action: string;
      actorName: string | null;
      assignedRoleCode: string | null;
      comment: string | null;
      dueAt: Date | null;
      actedAt: Date | null;
      overdue: boolean;
    }>;
  }>;
}) {
  if (!trails.length) {
    return (
      <p className="py-6 text-center text-xs text-muted">
        No approval chain has been started for this document.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {trails.map((t) => (
        <div key={t.instanceId} className="rounded-xl border border-border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-separator bg-surface-secondary px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-600">{t.ruleName ?? "Approval chain"}</span>
              <Badge tone={t.status === "APPROVED" ? "success" : t.status === "PENDING" ? "progress" : t.status === "REJECTED" ? "danger" : "warning"}>
                {humanize(t.status)}
              </Badge>
            </div>
            <span className="text-2xs text-[var(--c-text-tertiary)]">
              Started {fmtDateTime(t.startedAt)}
              {t.completedAt && ` · Completed ${fmtDateTime(t.completedAt)}`}
            </span>
          </div>
          <ul className="row-list">
            {t.steps.map((s) => (
              <li key={s.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5">
                <span className="tnum mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-surface-secondary text-2xs font-600 text-muted">
                  {s.sequence}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[0.8125rem] font-500">{s.stepName}</span>
                    <Badge
                      tone={
                        s.action === "APPROVED"
                          ? "success"
                          : s.action === "PENDING"
                            ? s.overdue
                              ? "danger"
                              : "progress"
                            : s.action === "REJECTED"
                              ? "danger"
                              : s.action === "SKIPPED"
                                ? "neutral"
                                : "warning"
                      }
                    >
                      {s.action === "PENDING" && s.overdue ? "Overdue" : humanize(s.action)}
                    </Badge>
                    {s.assignedRoleCode && (
                      <span className="text-2xs text-[var(--c-text-tertiary)]">{humanize(s.assignedRoleCode)}</span>
                    )}
                  </div>
                  {s.comment && (
                    <p className="mt-1 rounded-sm border-l-2 border-[var(--c-border-strong)] bg-surface-secondary px-2 py-1 text-xs leading-5 text-muted">
                      {s.comment}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right text-2xs text-[var(--c-text-tertiary)]">
                  {s.actorName && <div className="text-muted">{s.actorName}</div>}
                  {s.actedAt ? (
                    <div>{fmtDateTime(s.actedAt)}</div>
                  ) : s.dueAt ? (
                    <div className={s.overdue ? "text-[var(--c-danger)]" : undefined}>
                      Due {relativeTime(s.dueAt)}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
