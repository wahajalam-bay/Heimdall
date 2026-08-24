import { Children, type ReactNode } from "react";
import Link from "next/link";
import { classNames } from "@/lib/format";
import { EmptyState } from "./primitives";

/**
 * Lists of records, and the pieces a dashboard is assembled from.
 *
 * Twelve screens were each spelling out the same list of documents — a divided
 * ul, a link per row, a badge line, a muted second line — with slightly
 * different padding and no focus treatment. These are that pattern, once, on the
 * system's own surfaces and rings.
 */

/* ── Record lists ─────────────────────────────────────────── */

export function ActivityList({
  children,
  empty,
  className,
  maxHeight,
}: {
  children: ReactNode;
  /** Shown when there is nothing to list. A quiet default is used if omitted. */
  empty?: ReactNode;
  className?: string;
  /** Caps the list and scrolls, for lists that would otherwise run off the page. */
  maxHeight?: string;
}) {
  const rows = Children.toArray(children).filter(Boolean);
  if (!rows.length) {
    return <>{empty ?? <EmptyState compact title="Nothing to show" />}</>;
  }
  return (
    <ul
      className={classNames("row-list", maxHeight && "scroll-y", className)}
      style={maxHeight ? { maxHeight } : undefined}
    >
      {rows}
    </ul>
  );
}

export function ActivityRow({
  href,
  lead,
  title,
  meta,
  aside,
}: {
  href?: string;
  /** Badges and references — what kind of thing this is. */
  lead?: ReactNode;
  /** What it is called. The line people scan. */
  title: ReactNode;
  /** Who, where and when. */
  meta?: ReactNode;
  /** Right-aligned figure on the lead line: a value, an age, a due date. */
  aside?: ReactNode;
}) {
  const inner = (
    <>
      {(lead || aside) && (
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          {lead}
          {aside != null && (
            <span className="tnum ml-auto shrink-0 text-2xs text-[var(--c-text-tertiary)]">{aside}</span>
          )}
        </div>
      )}
      <div className="truncate text-[0.8125rem] leading-5 font-500">{title}</div>
      {meta && <div className="mt-0.5 text-2xs leading-4 text-muted">{meta}</div>}
    </>
  );

  return (
    <li>
      {href ? (
        <Link href={href} className="row-link">
          {inner}
        </Link>
      ) : (
        <div className="row-static">{inner}</div>
      )}
    </li>
  );
}

/* ── What needs doing ─────────────────────────────────────── */

export type ActionTone = "default" | "accent" | "success" | "warning" | "danger";

const DOT: Record<ActionTone, string | null> = {
  default: null,
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

const FIGURE: Record<ActionTone, string> = {
  default: "text-foreground",
  accent: "text-foreground",
  success: "text-foreground",
  warning: "text-warning-soft-foreground",
  danger: "text-danger-soft-foreground",
};

/**
 * One thing that wants doing: how many, what it is, and what happens next.
 *
 * A count of nothing keeps its place but loses its colour, so the layout stays
 * where people learned it while the eye still goes straight to the one cell that
 * is not calm.
 */
export function ActionTile({
  label,
  count,
  context,
  href,
  tone = "default",
}: {
  label: string;
  count: number | string;
  context: ReactNode;
  href: string;
  tone?: ActionTone;
}) {
  const quiet = count === 0 || count === "0";
  const effective: ActionTone = quiet ? "default" : tone;
  const dot = DOT[effective];

  return (
    <Link href={href} className="row-link px-4 py-3.5">
      <div className="label flex items-center gap-1.5">
        {dot && <span aria-hidden className={classNames("size-1.5 shrink-0 rounded-full", dot)} />}
        {label}
      </div>
      <div
        className={classNames(
          "tnum mt-1.5 text-2xl leading-8 font-semibold tracking-[-0.02em]",
          quiet ? "text-muted" : FIGURE[effective],
        )}
      >
        {count}
      </div>
      <div className="mt-0.5 text-xs leading-5 text-muted">{context}</div>
    </Link>
  );
}

/**
 * A labelled band of the page.
 *
 * Three of these carry the whole dashboard — what needs doing, where things
 * stand, and the detail behind it. Naming the bands is what lets someone answer
 * "what am I looking at" without reading a single figure.
 */
export function BandHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-separator pb-1.5">
      <h2 className="label">{children}</h2>
      {action}
    </div>
  );
}

const BAND_COLS: Record<number, string> = {
  // One tile across a wide page reads as an unfinished row, so it keeps to a
  // tile's own width instead of stretching.
  1: "sm:max-w-xs",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 xl:grid-cols-3",
  4: "sm:grid-cols-2 xl:grid-cols-4",
};

/**
 * The card the action tiles sit in — one surface, hairline-divided, rather than
 * four separate cards competing with the summary tiles further down. Columns
 * follow the number of tiles a reader is permitted to see, so a shorter list
 * fills its row instead of trailing off into empty space.
 */
export function ActionTiles({ children, allClear }: { children: ReactNode; allClear?: ReactNode }) {
  const tiles = Children.toArray(children).filter(Boolean);
  if (!tiles.length) {
    return (
      <div className="card flex items-center gap-2 px-4 py-3.5 text-xs text-muted">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
        {allClear ?? "Nothing is waiting on you."}
      </div>
    );
  }
  return (
    <div
      className={classNames(
        "card grid gap-px overflow-hidden bg-separator",
        BAND_COLS[Math.min(tiles.length, 4)] ?? BAND_COLS[4],
      )}
    >
      {tiles.map((tile, i) => (
        <div key={i} className="bg-surface">
          {tile}
        </div>
      ))}
    </div>
  );
}

/* ── Secondary metrics ────────────────────────────────────── */

export type Metric = {
  label: string;
  value: ReactNode;
  href?: string;
  /** Marks a figure that is itself a problem — a gap, a breach, an overdue count. */
  alert?: boolean;
};

/**
 * A column of supporting figures.
 *
 * These are the numbers that were each wearing their own KPI card. As a labelled
 * column they stay available without claiming the attention a headline deserves.
 */
export function MetricGroup({ title, items }: { title: string; items: Metric[] }) {
  return (
    <div className="min-w-0">
      <h4 className="label border-b border-separator pb-1.5">{title}</h4>
      <ul>
        {items.map((m) => {
          const row = (
            <>
              <span className="min-w-0 truncate text-muted">{m.label}</span>
              <span
                className={classNames(
                  "tnum shrink-0 font-500",
                  m.alert ? "text-danger-soft-foreground" : "text-foreground",
                )}
              >
                {m.value}
              </span>
            </>
          );
          return (
            <li key={m.label} className="border-b border-separator last:border-b-0">
              {m.href ? (
                <Link href={m.href} className="row-link flex items-baseline justify-between gap-3 px-0 py-1.5 text-xs">
                  {row}
                </Link>
              ) : (
                <div className="flex items-baseline justify-between gap-3 py-1.5 text-xs">{row}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
