"use client";

import Link from "next/link";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { classNames, compactNumber } from "@/lib/format";
import { useIsomorphicLayoutEffect } from "@/lib/hooks";

/**
 * Hand-rolled SVG chart set.
 *
 * Specs held constant across every form: bars ≤24px with a 4px rounded
 * data-end squared at the baseline, 2px lines, ≥8px markers with a 2px surface
 * ring, 2px surface gaps between touching fills, hairline recessive gridlines,
 * a legend whenever there are two or more series, sparing direct labels, and a
 * hover layer plus an equivalent table view on every plot.
 *
 * Series colours come from --c-viz-1..8 in fixed order (never cycled, never
 * rank-dependent) and were validated for CVD separation in both themes.
 */

export const VIZ_SLOTS = 8;
export const vizColor = (i: number) => `var(--c-viz-${(i % VIZ_SLOTS) + 1})`;


/* ── Value formatting ─────────────────────────────────────── */

/**
 * Charts are client components, so formatting cannot be passed as a function
 * from a server component. Callers name a format instead and the chart resolves
 * it locally.
 */
export type ValueFormat = "number" | "compact" | "money" | "moneyCompact" | "percent" | "decimal";

function formatter(kind: ValueFormat = "compact", currency = "PKR"): (v: number) => string {
  switch (kind) {
    case "number":
      return (v) => Math.round(v).toLocaleString("en-PK");
    case "money":
      return (v) => `${currency} ${Math.round(v).toLocaleString("en-PK")}`;
    case "moneyCompact":
      return (v) => `${currency} ${compactNumber(v)}`;
    case "percent":
      return (v) => `${v.toFixed(1)}%`;
    case "decimal":
      return (v) => v.toFixed(2);
    default:
      return (v) => compactNumber(v);
  }
}

/* ── Sizing ───────────────────────────────────────────────── */

function useWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(fallback);

  // Measured before paint, so a chart is never drawn at the fallback width and
  // then snapped to its container. The observer keeps it aligned afterwards,
  // including while the navigation rail animates the content width.
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = (px: number) => {
      const next = Math.max(220, Math.floor(px));
      setW((prev) => (Math.abs(prev - next) > 0.5 ? next : prev));
    };
    const ro = new ResizeObserver((entries) => read(entries[0].contentRect.width));
    ro.observe(el);
    read(el.clientWidth || fallback);
    return () => ro.disconnect();
  }, [fallback]);

  return { ref, width: w };
}

/**
 * Props that make an SVG fit its box at any width. The viewBox means a width that
 * is briefly stale — the first server-rendered frame, or any moment while the
 * navigation rail animates the content width — scales the drawing to fit instead
 * of overflowing the card, and the plot snaps to exact proportions the moment the
 * measurement lands.
 */
function fitted(width: number, height: number) {
  return {
    viewBox: `0 0 ${Math.max(1, Math.round(width))} ${height}`,
    width: "100%",
    height,
    preserveAspectRatio: "xMinYMin meet",
    style: { display: "block" },
  } as const;
}

/**
 * Room for the value axis, taken from the widest tick actually rendered, so
 * labels never clip and two charts of similar magnitude share a plot edge.
 */
function axisPad(ticks: number[]) {
  const widest = ticks.reduce((a, t) => Math.max(a, compactNumber(t).length), 1);
  return Math.min(64, Math.max(34, Math.ceil((widest * 6.4 + 14) / 4) * 4));
}

/* ── Frame ────────────────────────────────────────────────── */

export type SeriesDef = { key: string; label: string; colorIndex?: number };

export function ChartFrame({
  title,
  subtitle,
  series,
  actions,
  children,
  tableView,
  footnote,
  className,
}: {
  title?: string;
  subtitle?: string;
  series?: SeriesDef[];
  actions?: ReactNode;
  children: ReactNode;
  tableView?: ReactNode;
  footnote?: ReactNode;
  className?: string;
}) {
  const [showTable, setShowTable] = useState(false);
  // A legend is only warranted from two series up; one series is named by the title.
  const showLegend = (series?.length ?? 0) >= 2;
  return (
    <figure className={classNames("card flex h-full flex-col overflow-hidden", className)}>
      {(title || actions || showLegend) && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-separator px-4 py-3">
          <div className="min-w-0">
            {title && <h3 className="text-[0.8125rem] font-600">{title}</h3>}
            {subtitle && (
              <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {showLegend && (
              <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {series!.map((s, i) => (
                  <li key={s.key} className="flex items-center gap-1.5 text-xs text-muted">
                    <span
                      className="size-2 shrink-0 rounded-[2px]"
                      style={{ background: vizColor(s.colorIndex ?? i) }}
                      aria-hidden
                    />
                    {s.label}
                  </li>
                ))}
              </ul>
            )}
            {actions}
            {tableView && (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => setShowTable((v) => !v)}
                aria-expanded={showTable}
              >
                {showTable ? "Chart" : "Table"}
              </button>
            )}
          </div>
        </header>
      )}
      <div className="flex-1 px-3 py-3">{showTable && tableView ? tableView : children}</div>
      {footnote && (
        <figcaption className="border-t border-separator px-4 py-2 text-2xs text-[var(--c-text-tertiary)]">
          {footnote}
        </figcaption>
      )}
    </figure>
  );
}

/* ── Tooltip ──────────────────────────────────────────────── */

type TipState = { x: number; y: number; rows: Array<{ label: string; value: string; color?: string }>; heading: string } | null;

function Tooltip({ tip, width }: { tip: TipState; width: number }) {
  if (!tip) return null;
  const flip = tip.x > width * 0.6;
  return (
    <div
      className="pointer-events-none absolute z-10 min-w-[8rem] rounded-lg border border-border bg-overlay px-2.5 py-1.5 shadow-overlay"
      style={{
        left: flip ? undefined : tip.x + 12,
        right: flip ? width - tip.x + 12 : undefined,
        top: Math.max(0, tip.y - 10),
      }}
      role="tooltip"
    >
      <div className="mb-1 text-2xs font-600 text-[var(--c-text)]">{tip.heading}</div>
      {tip.rows.map((r, i) => (
        <div key={i} className="flex items-baseline justify-between gap-3 text-2xs leading-4">
          <span className="flex items-center gap-1.5 text-muted">
            {r.color && <span className="size-1.5 rounded-full" style={{ background: r.color }} aria-hidden />}
            {r.label}
          </span>
          <span className="tnum font-500 text-[var(--c-text)]">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Axis helpers ─────────────────────────────────────────── */

/** Rounds the domain up to clean tick values (0 / 1,000 / 2,000 …). */
function niceTicks(max: number, count = 4): { ticks: number[]; top: number } {
  if (!Number.isFinite(max) || max <= 0) return { ticks: [0, 1], top: 1 };
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { ticks, top };
}

const GRID = "var(--c-border-subtle)";
const AXIS_TEXT = "var(--c-text-tertiary)";

/* ── Column chart (vertical bars, 1..n series grouped) ────── */

export type ColumnDatum = { label: string; values: number[]; href?: string };

export function ColumnChart({
  data,
  series,
  height = 220,
  format = "compact",
  currency = "PKR",
  valueLabel,
  highlightLast,
}: {
  data: ColumnDatum[];
  series: SeriesDef[];
  height?: number;
  format?: ValueFormat;
  currency?: string;
  valueLabel?: string;
  /** Direct-labels only the final column, keeping labels sparing. */
  highlightLast?: boolean;
}) {
  const fmt = formatter(format, currency);
  const { ref, width } = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState>(null);

  const max = Math.max(0, ...data.flatMap((d) => d.values));
  const { ticks, top } = niceTicks(max);
  const pad = { top: 14, right: 8, bottom: 26, left: axisPad(ticks) };
  const plotW = Math.max(40, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const y = (v: number) => pad.top + plotH - (v / top) * plotH;

  const band = plotW / Math.max(1, data.length);
  const GAP = 2; // surface gap between adjacent bars
  const groupW = Math.min(24 * series.length + GAP * (series.length - 1), band * 0.62);
  const barW = Math.max(3, (groupW - GAP * (series.length - 1)) / series.length);

  return (
    <div ref={ref} className="relative">
      <svg {...fitted(width, height)} role="img" aria-label={valueLabel ?? "Column chart"}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={pad.left - 7} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill={AXIS_TEXT} className="tnum">
              {compactNumber(t)}
            </text>
          </g>
        ))}

        {data.map((d, di) => {
          const cx = pad.left + band * di + band / 2;
          const startX = cx - groupW / 2;
          return (
            <g key={`${d.label}-${di}`}>
              {series.map((s, si) => {
                const v = d.values[si] ?? 0;
                const h = Math.max(v > 0 ? 2 : 0, (v / top) * plotH);
                const x = startX + si * (barW + GAP);
                const r = Math.min(4, barW / 2, h);
                const yy = pad.top + plotH - h;
                // Rounded data-end, squared at the baseline.
                const path =
                  h <= r
                    ? `M${x} ${pad.top + plotH} h${barW} v${-h} h${-barW} Z`
                    : `M${x} ${pad.top + plotH} V${yy + r} a${r} ${r} 0 0 1 ${r} ${-r} h${barW - 2 * r} a${r} ${r} 0 0 1 ${r} ${r} V${pad.top + plotH} Z`;
                return (
                  <path
                    key={s.key}
                    d={path}
                    fill={vizColor(s.colorIndex ?? si)}
                    onMouseEnter={(e) =>
                      setTip({
                        x: e.nativeEvent.offsetX,
                        y: e.nativeEvent.offsetY,
                        heading: d.label,
                        rows: series.map((ss, ii) => ({
                          label: ss.label,
                          value: fmt(d.values[ii] ?? 0),
                          color: vizColor(ss.colorIndex ?? ii),
                        })),
                      })
                    }
                    onMouseLeave={() => setTip(null)}
                  >
                    <title>{`${d.label} · ${s.label}: ${fmt(v)}`}</title>
                  </path>
                );
              })}
              {highlightLast && di === data.length - 1 && series.length === 1 && (
                <text
                  x={cx}
                  y={y(d.values[0] ?? 0) - 5}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={600}
                  fill="var(--c-text-secondary)"
                >
                  {fmt(d.values[0] ?? 0)}
                </text>
              )}
              <text x={cx} y={height - 8} textAnchor="middle" fontSize={10} fill={AXIS_TEXT}>
                {d.label}
              </text>
            </g>
          );
        })}
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={pad.top + plotH}
          y2={pad.top + plotH}
          stroke="var(--c-border)"
          strokeWidth={1}
        />
      </svg>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

/* ── Ranked horizontal bars ───────────────────────────────── */

export function RankedBars({
  data,
  format = "compact",
  currency = "PKR",
  colorIndex = 0,
  maxRows = 10,
  secondaryLabel,
}: {
  data: Array<{ label: string; value: number; sub?: string; href?: string }>;
  format?: ValueFormat;
  currency?: string;
  colorIndex?: number;
  maxRows?: number;
  barHeight?: number;
  secondaryLabel?: string;
}) {
  const fmt = formatter(format, currency);
  const rows = data.slice(0, maxRows);
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) {
    return (
      <p className="py-8 text-center text-xs text-muted">No data for this period.</p>
    );
  }
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="group">
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="truncate text-xs text-[var(--c-text)]" title={r.label}>
              {r.label}
            </span>
            <span className="tnum shrink-0 text-xs font-500 text-[var(--c-text)]">{fmt(r.value)}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-[8px] flex-1 overflow-hidden rounded-[4px] bg-surface-secondary">
              <div
                className="h-full rounded-r-[4px]"
                style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%`, background: vizColor(colorIndex) }}
                title={`${r.label}: ${fmt(r.value)}`}
              />
            </div>
            {r.sub && (
              <span className="tnum w-16 shrink-0 text-right text-2xs text-[var(--c-text-tertiary)]">
                {r.sub}
              </span>
            )}
          </div>
        </div>
      ))}
      {secondaryLabel && (
        <p className="pt-1 text-2xs text-[var(--c-text-tertiary)]">{secondaryLabel}</p>
      )}
    </div>
  );
}

/* ── Trend (line / area) ──────────────────────────────────── */

export type TrendPoint = { label: string; values: Array<number | null> };

/**
 * Places the end-of-line labels so two series finishing at similar values do not
 * print on top of each other: they are nudged apart, in order, inside the plot.
 */
function endLabelPositions(
  paths: Array<{ last: { i: number; v: number } | null }>,
  x: (i: number) => number,
  y: (v: number) => number,
  minY: number,
  maxY: number,
) {
  const placed = paths
    .map((p, si) => (p.last ? { si, v: p.last.v, x: x(p.last.i) + 8, y: y(p.last.v) + 3.5 } : null))
    .filter((p): p is { si: number; v: number; x: number; y: number } => p !== null)
    .sort((a, b) => a.y - b.y);

  const GAP = 12;
  for (let i = 1; i < placed.length; i += 1) {
    if (placed[i].y - placed[i - 1].y < GAP) placed[i].y = placed[i - 1].y + GAP;
  }
  const overflow = placed.length ? placed[placed.length - 1].y - (maxY + 3.5) : 0;
  if (overflow > 0) for (const p of placed) p.y -= overflow;
  for (const p of placed) p.y = Math.max(minY + 6, p.y);
  return placed;
}

export function TrendChart({
  data,
  series,
  height = 220,
  area = false,
  format = "compact",
  currency = "PKR",
  labelEnds = true,
}: {
  data: TrendPoint[];
  series: SeriesDef[];
  height?: number;
  area?: boolean;
  format?: ValueFormat;
  currency?: string;
  labelEnds?: boolean;
}) {
  const fmt = formatter(format, currency);
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const max = Math.max(
    0,
    ...data.flatMap((d) => d.values.map((v) => (v === null ? 0 : v))),
  );
  const { ticks, top } = niceTicks(max);

  // The end labels are the point of this chart — the last figure, named. Room is
  // measured from the widest label rather than assumed, because a fixed 46px
  // left "PKR 371.1K" sliced off at the frame's edge.
  const showEnds = labelEnds && series.length <= 4;
  const lastValues = series.map((_, si) => {
    for (let i = data.length - 1; i >= 0; i -= 1) {
      const v = data[i].values[si];
      if (v !== null && v !== undefined) return { i, v };
    }
    return null;
  });
  const endTexts = showEnds ? lastValues.filter(Boolean).map((p) => fmt(p!.v)) : [];
  const widest = endTexts.reduce((w, t) => Math.max(w, t.length), 0);
  const endLabelRoom = showEnds && widest ? Math.min(Math.round(widest * 6.1) + 12, Math.max(48, width * 0.32)) : 8;
  const pad = { top: 16, right: endLabelRoom, bottom: 26, left: axisPad(ticks) };
  const plotW = Math.max(40, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (data.length <= 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v: number) => pad.top + plotH - (v / top) * plotH;

  const paths = useMemo(
    () =>
      series.map((_, si) => {
        const pts = data
          .map((d, i) => ({ i, v: d.values[si] }))
          .filter((p): p is { i: number; v: number } => p.v !== null && p.v !== undefined);
        if (!pts.length) return { line: "", fill: "", last: null as null | { i: number; v: number } };
        const line = pts.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i)} ${y(p.v)}`).join(" ");
        const fill = `${line} L${x(pts[pts.length - 1].i)} ${pad.top + plotH} L${x(pts[0].i)} ${pad.top + plotH} Z`;
        return { line, fill, last: pts[pts.length - 1] };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, series, width, height, top],
  );

  if (!data.length) {
    return <p className="py-10 text-center text-xs text-muted">No data for this period.</p>;
  }

  const hoverIdx = hover;

  return (
    <div ref={ref} className="relative">
      <svg
        {...fitted(width, height)}
        role="img"
        aria-label="Trend chart"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          // The pointer is in CSS pixels and the plot in viewBox units; the two
          // differ while the container is mid-resize.
          const scale = rect.width > 0 ? width / rect.width : 1;
          const px = (e.clientX - rect.left) * scale;
          const rel = (px - pad.left) / plotW;
          const i = Math.round(rel * (data.length - 1));
          setHover(Math.min(data.length - 1, Math.max(0, i)));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={pad.left - 7} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill={AXIS_TEXT} className="tnum">
              {compactNumber(t)}
            </text>
          </g>
        ))}

        {area &&
          paths.map((p, si) =>
            p.fill ? (
              <path key={`f-${si}`} d={p.fill} fill={vizColor(series[si].colorIndex ?? si)} opacity={0.1} />
            ) : null,
          )}

        {hoverIdx !== null && (
          <line
            x1={x(hoverIdx)}
            x2={x(hoverIdx)}
            y1={pad.top}
            y2={pad.top + plotH}
            stroke="var(--c-border-strong)"
            strokeWidth={1}
          />
        )}

        {paths.map((p, si) =>
          p.line ? (
            <path
              key={`l-${si}`}
              d={p.line}
              fill="none"
              stroke={vizColor(series[si].colorIndex ?? si)}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null,
        )}

        {/* End markers carry a 2px surface ring so crossings stay legible */}
        {paths.map((p, si) =>
          p.last ? (
            <circle
              key={`d-${si}`}
              cx={x(p.last.i)}
              cy={y(p.last.v)}
              r={4}
              fill={vizColor(series[si].colorIndex ?? si)}
              stroke="var(--c-surface)"
              strokeWidth={2}
            />
          ) : null,
        )}

        {hoverIdx !== null &&
          series.map((s, si) => {
            const v = data[hoverIdx].values[si];
            if (v === null || v === undefined) return null;
            return (
              <circle
                key={`h-${si}`}
                cx={x(hoverIdx)}
                cy={y(v)}
                r={4}
                fill={vizColor(s.colorIndex ?? si)}
                stroke="var(--c-surface)"
                strokeWidth={2}
              />
            );
          })}

        {showEnds &&
          endLabelPositions(paths, x, y, pad.top, pad.top + plotH).map((p) => (
            <text
              key={`t-${p.si}`}
              x={p.x}
              y={p.y}
              fontSize={10}
              fontWeight={600}
              fill="var(--c-text-secondary)"
              className="tnum"
            >
              {fmt(p.v)}
            </text>
          ))}

        {data.map((d, i) => {
          const stride = Math.ceil(data.length / Math.max(3, Math.floor(plotW / 56)));
          if (i % stride !== 0 && i !== data.length - 1) return null;
          return (
            <text key={`x-${i}`} x={x(i)} y={height - 8} textAnchor="middle" fontSize={10} fill={AXIS_TEXT}>
              {d.label}
            </text>
          );
        })}

        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={pad.top + plotH}
          y2={pad.top + plotH}
          stroke="var(--c-border)"
          strokeWidth={1}
        />
      </svg>
      <Tooltip
        tip={
          hoverIdx === null
            ? null
            : {
                x: x(hoverIdx),
                y: pad.top,
                heading: data[hoverIdx].label,
                rows: series.map((s, si) => ({
                  label: s.label,
                  value: data[hoverIdx].values[si] === null ? "—" : fmt(data[hoverIdx].values[si] as number),
                  color: vizColor(s.colorIndex ?? si),
                })),
              }
        }
        width={width}
      />
    </div>
  );
}

/* ── Stacked bars ─────────────────────────────────────────── */

export function StackedBars({
  data,
  series,
  height = 220,
  format = "compact",
  currency = "PKR",
}: {
  data: ColumnDatum[];
  series: SeriesDef[];
  height?: number;
  format?: ValueFormat;
  currency?: string;
}) {
  const fmt = formatter(format, currency);
  const { ref, width } = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState>(null);

  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  const { ticks, top } = niceTicks(Math.max(0, ...totals));
  const pad = { top: 14, right: 8, bottom: 26, left: axisPad(ticks) };
  const plotW = Math.max(40, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const yScale = (v: number) => (v / top) * plotH;
  const band = plotW / Math.max(1, data.length);
  const barW = Math.min(24, band * 0.56);
  const GAP = 2;

  return (
    <div ref={ref} className="relative">
      <svg {...fitted(width, height)} role="img" aria-label="Stacked bar chart">
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={pad.top + plotH - yScale(t)}
              y2={pad.top + plotH - yScale(t)}
              stroke={GRID}
              strokeWidth={1}
            />
            <text
              x={pad.left - 7}
              y={pad.top + plotH - yScale(t) + 3.5}
              textAnchor="end"
              fontSize={10}
              fill={AXIS_TEXT}
              className="tnum"
            >
              {compactNumber(t)}
            </text>
          </g>
        ))}

        {data.map((d, di) => {
          const cx = pad.left + band * di + band / 2;
          let cursor = pad.top + plotH;
          const segs = series.map((s, si) => {
            const v = d.values[si] ?? 0;
            const h = Math.max(0, yScale(v) - (si > 0 ? GAP : 0));
            const yTop = cursor - h;
            cursor = yTop - GAP;
            return { s, si, v, h, yTop };
          });
          return (
            <g
              key={`${d.label}-${di}`}
              onMouseEnter={(e) =>
                setTip({
                  x: e.nativeEvent.offsetX,
                  y: e.nativeEvent.offsetY,
                  heading: d.label,
                  rows: [
                    ...series.map((ss, ii) => ({
                      label: ss.label,
                      value: fmt(d.values[ii] ?? 0),
                      color: vizColor(ss.colorIndex ?? ii),
                    })),
                    { label: "Total", value: fmt(totals[di]) },
                  ],
                })
              }
              onMouseLeave={() => setTip(null)}
            >
              {segs.map(({ s, si, v, h, yTop }) =>
                h <= 0 ? null : (
                  <rect
                    key={s.key}
                    x={cx - barW / 2}
                    y={yTop}
                    width={barW}
                    height={h}
                    rx={si === series.length - 1 ? Math.min(4, barW / 2) : 0}
                    fill={vizColor(s.colorIndex ?? si)}
                  >
                    <title>{`${d.label} · ${s.label}: ${fmt(v)}`}</title>
                  </rect>
                ),
              )}
              <text x={cx} y={height - 8} textAnchor="middle" fontSize={10} fill={AXIS_TEXT}>
                {d.label}
              </text>
            </g>
          );
        })}
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={pad.top + plotH}
          y2={pad.top + plotH}
          stroke="var(--c-border)"
          strokeWidth={1}
        />
      </svg>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

/* ── Donut ────────────────────────────────────────────────── */

export function DonutChart({
  data,
  size = 168,
  thickness = 20,
  centerLabel,
  centerValue,
  format = "compact",
  currency = "PKR",
}: {
  /** `href` makes the segment and its legend row a link into the filtered rows. */
  data: Array<{ label: string; value: number; colorIndex?: number; href?: string }>;
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
  format?: ValueFormat;
  currency?: string;
}) {
  const fmt = formatter(format, currency);
  const total = data.reduce((a, d) => a + d.value, 0);
  const [hover, setHover] = useState<number | null>(null);
  if (total <= 0) {
    return <p className="py-8 text-center text-xs text-muted">No data for this period.</p>;
  }
  const r = (size - thickness) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  // 2px surface gap between adjacent segments.
  const gap = 2;
  let offset = 0;

  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative shrink-0" style={{ width: size, maxWidth: "100%", height: size }}>
        <svg
          viewBox={`0 0 ${size} ${size}`}
          width="100%"
          height={size}
          preserveAspectRatio="xMidYMid meet"
          style={{ display: "block" }}
          role="img"
          aria-label="Composition chart"
        >
          <circle cx={c} cy={c} r={r} fill="none" stroke="var(--c-surface-sunken)" strokeWidth={thickness} />
          {data.map((d, i) => {
            const frac = d.value / total;
            const len = Math.max(0, frac * circ - gap);
            const arc = (
              <circle
                cx={c}
                cy={c}
                r={r}
                fill="none"
                stroke={vizColor(d.colorIndex ?? i)}
                strokeWidth={hover === i ? thickness + 3 : thickness}
                strokeDasharray={`${len} ${circ - len}`}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${c} ${c})`}
                style={{ transition: "stroke-width 120ms ease", cursor: d.href ? "var(--cursor-interactive)" : undefined }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                <title>{`${d.label}: ${fmt(d.value)} (${((frac * 100) | 0)}%)`}</title>
              </circle>
            );
            const el = d.href ? (
              <a key={d.label} href={d.href} aria-label={`${d.label}: ${fmt(d.value)}`}>
                {arc}
              </a>
            ) : (
              <g key={d.label}>{arc}</g>
            );
            offset += frac * circ;
            return el;
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-[1.125rem] font-600 leading-6">
            {hover !== null ? fmt(data[hover].value) : (centerValue ?? fmt(total))}
          </span>
          <span className="max-w-[6.5rem] text-2xs leading-3.5 text-[var(--c-text-tertiary)]">
            {hover !== null ? data[hover].label : (centerLabel ?? "Total")}
          </span>
        </div>
      </div>
      <ul className="min-w-[9rem] flex-1 space-y-1.5">
        {data.map((d, i) => {
          const row = (
            <>
              <span className="flex min-w-0 items-center gap-1.5 text-muted">
                <span
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ background: vizColor(d.colorIndex ?? i) }}
                  aria-hidden
                />
                <span className="truncate" title={d.label}>
                  {d.label}
                </span>
              </span>
              <span className="tnum shrink-0 font-500">
                {fmt(d.value)}
                <span className="ml-1.5 text-[var(--c-text-tertiary)]">
                  {((d.value / total) * 100).toFixed(0)}%
                </span>
              </span>
            </>
          );
          return (
            <li
              key={d.label}
              className="text-xs"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {d.href ? (
                <Link
                  href={d.href}
                  className="-mx-1.5 flex items-baseline justify-between gap-3 rounded-md px-1.5 py-1 transition-colors hover:bg-[var(--c-surface-hover)]"
                >
                  {row}
                </Link>
              ) : (
                <span className="flex items-baseline justify-between gap-3">{row}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── Sparkline ────────────────────────────────────────────── */

export function Sparkline({
  values,
  width = 96,
  height = 26,
  colorIndex = 0,
}: {
  values: number[];
  width?: number;
  height?: number;
  colorIndex?: number;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * (width - 4) + 2;
  const y = (v: number) => height - 3 - ((v - min) / span) * (height - 8);
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)} ${y(v)}`).join(" ");
  return (
    <svg width={width} height={height} aria-hidden className="overflow-visible">
      <path d={line} fill="none" stroke={vizColor(colorIndex)} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" opacity={0.55} />
      <circle
        cx={x(values.length - 1)}
        cy={y(values[values.length - 1])}
        r={3}
        fill={vizColor(colorIndex)}
        stroke="var(--c-surface)"
        strokeWidth={2}
      />
    </svg>
  );
}

/* ── Table view helper ────────────────────────────────────── */

export function ChartTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: Array<Array<string | number>>;
}) {
  return (
    <div className="table-wrap max-h-64 overflow-y-auto">
      <table className="dt">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={c} className={i > 0 ? "text-right" : undefined}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((cell, ci) => (
                <td key={ci} className={ci > 0 ? "num" : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
