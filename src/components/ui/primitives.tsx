import type { ReactNode } from "react";
import Link from "next/link";
import { classNames } from "@/lib/format";
import { humanize, toneFor, type BadgeTone } from "@/lib/domain";

/* ── Badges ───────────────────────────────────────────────── */

export function Badge({
  children,
  tone = "neutral",
  className,
  dot,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span className={classNames("badge", `badge-${tone}`, className)}>
      {dot && <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden />}
      {children}
    </span>
  );
}

/** Status badge that derives its tone from the domain status vocabulary. */
export function StatusBadge({
  status,
  className,
  label,
}: {
  status: string | null | undefined;
  className?: string;
  label?: string;
}) {
  if (!status) return <span className="text-[var(--c-text-tertiary)]">—</span>;
  return (
    <Badge tone={toneFor(status)} className={className} dot>
      {label ?? humanize(status)}
    </Badge>
  );
}

/* ── Cards & surfaces ─────────────────────────────────────── */

export function Card({
  children,
  className,
  pad = true,
}: {
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return <div className={classNames("card", pad && "card-pad", className)}>{children}</div>;
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  footer,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  footer?: ReactNode;
}) {
  return (
    <section className={classNames("card overflow-hidden", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
          <div className="min-w-0">
            {title && <h3 className="text-sm leading-6 font-medium text-foreground">{title}</h3>}
            {description && <p className="text-sm leading-5 text-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={classNames(bodyClassName ?? "px-4 pb-4")}>{children}</div>
      {footer && <footer className="bg-surface-secondary px-4 py-3">{footer}</footer>}
    </section>
  );
}

/* ── Page scaffolding ─────────────────────────────────────── */

export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  meta,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <header className={classNames("flex flex-wrap items-start justify-between gap-x-6 gap-y-3", className)}>
      {/* A minimum width the actions cannot bargain away: below it they wrap onto
          their own row instead of crushing the title into one word per line. */}
      <div className="min-w-[min(100%,20rem)] flex-1">
        {eyebrow && (
          <div className="label mb-1 flex items-center gap-1.5">
            <span
              className="h-2.5 w-[2px] shrink-0 rounded-full"
              style={{ background: "var(--c-mod)" }}
              aria-hidden
            />
            {eyebrow}
          </div>
        )}
        <h1 className="text-[1.375rem] leading-7 font-600 tracking-[-0.018em]">{title}</h1>
        {subtitle && (
          <p className="mt-1 max-w-3xl text-[0.8125rem] leading-5 text-muted">{subtitle}</p>
        )}
        {meta && <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5 text-xs">
      <span className="text-[var(--c-text-tertiary)]">{label}</span>
      <span className="font-500 text-[var(--c-text)]">{children}</span>
    </div>
  );
}

/** Two-column definition list used across detail panels. */
export function DefList({
  items,
  columns = 2,
  className,
}: {
  items: Array<{ label: string; value: ReactNode; span?: boolean }>;
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  const gridCls = columns === 1 ? "grid-cols-1" : columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";
  return (
    <dl className={classNames("grid gap-x-6 gap-y-3", gridCls, className)}>
      {items.map((it, i) => (
        <div key={`${it.label}-${i}`} className={classNames("min-w-0", it.span && "sm:col-span-full")}>
          <dt className="label mb-0.5">{it.label}</dt>
          <dd className="text-[0.8125rem] leading-5 break-words">{it.value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ── KPI tiles ────────────────────────────────────────────── */

export function StatTile({
  label,
  value,
  hint,
  delta,
  tone,
  href,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  delta?: { value: string; direction: "up" | "down" | "flat"; good?: boolean };
  tone?: "default" | "success" | "warning" | "danger" | "accent";
  href?: string;
  icon?: ReactNode;
}) {
  const dot =
    tone === "success"
      ? "bg-success"
      : tone === "warning"
        ? "bg-warning"
        : tone === "danger"
          ? "bg-danger"
          : tone === "accent"
            ? "bg-accent"
            : null;

  // Only a figure that is itself the alarm takes a colour; the rest stay in ink,
  // so a screen of tiles does not read as a warning.
  const valueTone =
    tone === "danger" ? "text-danger-soft-foreground" : tone === "warning" ? "text-warning-soft-foreground" : "";

  const body = (
    <div
      className={classNames(
        "card card-pad h-full gap-0 transition-colors",
        href && "hover:bg-surface-hover",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="label flex items-center gap-1.5">
          {dot && <span aria-hidden className={classNames("size-1.5 shrink-0 rounded-full", dot)} />}
          {label}
        </span>
        {icon && <span className="text-muted">{icon}</span>}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className={classNames("tnum text-2xl leading-8 font-semibold tracking-[-0.02em]", valueTone)}>
          {value}
        </span>
        {delta && (
          <span
            className={classNames(
              "tnum text-xs font-500",
              delta.direction === "flat"
                ? "text-muted"
                : (delta.direction === "up") === (delta.good ?? true)
                  ? "text-success-soft-foreground"
                  : "text-danger-soft-foreground",
            )}
          >
            {delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "•"} {delta.value}
          </span>
        )}
      </div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );

  return href ? (
    <Link href={href} className="block h-full focus-visible:rounded-2xl">
      {body}
    </Link>
  ) : (
    body
  );
}

/* ── States ───────────────────────────────────────────────── */

export function EmptyState({
  title,
  description,
  action,
  icon,
  compact,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={classNames(
        "flex flex-col items-center justify-center text-center",
        compact ? "px-4 py-8" : "px-6 py-14",
      )}
    >
      <div className="mb-3 flex size-9 items-center justify-center rounded-xl border border-border bg-surface-secondary text-[var(--c-text-tertiary)]">
        {icon ?? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
            <path d="M5.5 8h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        )}
      </div>
      <h4 className="text-[0.8125rem] font-600">{title}</h4>
      {description && (
        <p className="mt-1 max-w-sm text-xs leading-5 text-muted">{description}</p>
      )}
      {action && <div className="mt-3.5">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  description,
  action,
}: {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 flex size-9 items-center justify-center rounded-2xl alert-danger text-[var(--c-danger)]">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M8 5.5v4M8 11.5h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </div>
      <h4 className="text-[0.8125rem] font-600">{title}</h4>
      {description && (
        <p className="mt-1 max-w-md text-xs leading-5 text-muted">{description}</p>
      )}
      {action && <div className="mt-3.5">{action}</div>}
    </div>
  );
}

export function UnauthorizedState({ message }: { message?: string }) {
  return (
    <Card className="mx-auto max-w-lg">
      <div className="flex gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-2xl alert-warning text-[var(--c-warning)]">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
            <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M5.75 7V5.25a2.25 2.25 0 0 1 4.5 0V7" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </div>
        <div>
          <h4 className="text-[0.875rem] font-600">Access restricted</h4>
          <p className="mt-1 text-[0.8125rem] leading-5 text-muted">
            {message ??
              "You do not have permission to view this area. If you need access, contact your procurement system administrator."}
          </p>
        </div>
      </div>
    </Card>
  );
}

export function BlockedNotice({
  title,
  reasons,
  tone = "warning",
}: {
  title: string;
  reasons: string[];
  tone?: "warning" | "danger" | "info";
}) {
  const map = {
    warning: ["var(--c-warning-soft)", "var(--c-warning-border)", "var(--c-warning)"],
    danger: ["var(--c-danger-soft)", "var(--c-danger-border)", "var(--c-danger)"],
    info: ["var(--c-info-soft)", "var(--c-info-border)", "var(--c-info)"],
  }[tone];
  return (
    <div
      className="rounded-xl border px-3.5 py-3"
      style={{ background: map[0], borderColor: map[1] }}
    >
      <div className="flex items-center gap-2 text-[0.8125rem] font-600" style={{ color: map[2] }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.2" />
          <path d="M8 5.25v3.5M8 10.75h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        {title}
      </div>
      {reasons.length > 0 && (
        <ul className="mt-1.5 space-y-1 pl-5 text-xs leading-5 text-muted">
          {reasons.map((r, i) => (
            <li key={i} className="list-disc">
              {r}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Skeletons ────────────────────────────────────────────── */

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={classNames("space-y-2", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="skeleton h-3"
          style={{ width: i === lines - 1 ? "62%" : `${88 - i * 6}%` }}
        />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex gap-3 border-b border-border bg-surface-secondary px-3 py-2.5">
        {Array.from({ length: cols }).map((_, i) => (
          <div key={i} className="skeleton h-2.5 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3 border-b border-separator px-3 py-3 last:border-0">
          {Array.from({ length: cols }).map((_, c) => (
            <div key={c} className="skeleton h-3 flex-1" style={{ opacity: 1 - r * 0.06 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonTiles({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card card-pad">
          <div className="skeleton h-2.5 w-20" />
          <div className="skeleton mt-3 h-6 w-28" />
          <div className="skeleton mt-2 h-2.5 w-32" />
        </div>
      ))}
    </div>
  );
}

/* ── Misc atoms ───────────────────────────────────────────── */

export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  const inits = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  // Stable hue per person so avatars read as identity, not decoration.
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-600"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `hsl(${h} 58% 92%)`,
        color: `hsl(${h} 52% 32%)`,
        border: `1px solid hsl(${h} 45% 84%)`,
      }}
      title={name}
    >
      {inits}
    </span>
  );
}

export function UserChip({ name, sub, size = 22 }: { name: string; sub?: string | null; size?: number }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Avatar name={name} size={size} />
      <span className="min-w-0">
        <span className="block truncate text-[0.8125rem] leading-4">{name}</span>
        {sub && <span className="block truncate text-2xs text-[var(--c-text-tertiary)]">{sub}</span>}
      </span>
    </span>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={classNames("mono", className)}>{children}</span>;
}

export function RefLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="mono font-500 text-[var(--c-accent-text)] underline decoration-[var(--c-accent-soft-border)] decoration-1 underline-offset-2 hover:decoration-[var(--c-accent)]"
    >
      {children}
    </Link>
  );
}

/** Horizontal progress meter, used for received/ordered style ratios. */
export function Meter({
  value,
  max,
  tone = "accent",
  label,
  showValue = true,
  height = 5,
}: {
  value: number;
  max: number;
  tone?: "accent" | "success" | "warning" | "danger" | "info";
  label?: string;
  showValue?: boolean;
  height?: number;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const color = `var(--c-${tone === "accent" ? "accent" : tone})`;
  return (
    <div className="min-w-[5rem]">
      {(label || showValue) && (
        <div className="mb-1 flex items-baseline justify-between gap-2 text-2xs text-muted">
          {label && <span>{label}</span>}
          {showValue && <span className="tnum">{pct.toFixed(0)}%</span>}
        </div>
      )}
      <div
        className="w-full overflow-hidden rounded-full bg-[var(--c-surface-active)]"
        style={{ height }}
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label ?? "progress"}
      >
        <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

export function Divider({ className }: { className?: string }) {
  return <hr className={classNames("border-0 border-t border-separator", className)} />;
}

export function KeyValueRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="tnum text-[0.8125rem] font-500">{children}</span>
    </div>
  );
}

export function InlineAlert({
  tone = "info",
  children,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  return (
    <div className={classNames("alert px-4 py-3 text-xs leading-5", `alert-${tone}`)}>{children}</div>
  );
}
