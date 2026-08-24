import type { ReactNode } from "react";
import Link from "next/link";
import { classNames } from "@/lib/format";

/** Tab strip driven by a query param so each tab loads its own server data. */
export function TabNav({
  tabs,
  active,
  baseHref,
  param = "tab",
  className,
}: {
  tabs: Array<{ key: string; label: string; count?: number | null; badge?: ReactNode; disabled?: boolean }>;
  active: string;
  baseHref: string;
  param?: string;
  className?: string;
}) {
  return (
    <nav
      className={classNames(
        "-mb-px flex gap-0.5 overflow-x-auto border-b border-border",
        className,
      )}
      aria-label="Sections"
    >
      {tabs.map((t) => {
        const isActive = t.key === active;
        const href = `${baseHref}${baseHref.includes("?") ? "&" : "?"}${param}=${t.key}`;
        const inner = (
          <>
            {t.label}
            {t.count !== null && t.count !== undefined && (
              <span
                className={classNames(
                  "tnum ml-1.5 rounded-full px-1.5 py-px text-2xs",
                  isActive
                    ? "bg-[var(--c-accent-soft)] text-[var(--c-accent-text)]"
                    : "bg-[var(--c-surface-active)] text-[var(--c-text-tertiary)]",
                )}
              >
                {t.count}
              </span>
            )}
            {t.badge}
          </>
        );
        const cls = classNames(
          "relative inline-flex shrink-0 items-center whitespace-nowrap px-3 py-2 text-[0.8125rem] font-500 transition-colors",
          isActive
            ? "text-[var(--c-text)] after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-[var(--c-accent)]"
            : "text-muted hover:text-[var(--c-text)]",
          t.disabled && "pointer-events-none opacity-40",
        );
        return t.disabled ? (
          <span key={t.key} className={cls} aria-disabled>
            {inner}
          </span>
        ) : (
          <Link key={t.key} href={href} className={cls} aria-current={isActive ? "page" : undefined} scroll={false}>
            {inner}
          </Link>
        );
      })}
    </nav>
  );
}

export function Breadcrumbs({
  items,
}: {
  items: Array<{ label: string; href?: string }>;
}) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-[var(--c-text-tertiary)]">
      {items.map((it, i) => (
        <span key={`${it.label}-${i}`} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden>/</span>}
          {it.href ? (
            <Link href={it.href} className="hover:text-[var(--c-text)]">
              {it.label}
            </Link>
          ) : (
            <span className="text-muted">{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** Sub-navigation pill row for module landing pages. */
export function PillNav({
  items,
  active,
}: {
  items: Array<{ label: string; href: string; count?: number }>;
  active: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map((it) => {
        const isActive = it.href === active;
        return (
          <Link
            key={it.href}
            href={it.href}
            className={classNames(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-500 transition-colors",
              isActive
                ? "border-[var(--c-accent-soft-border)] bg-[var(--c-accent-soft)] text-[var(--c-accent-text)]"
                : "border-border bg-[var(--c-surface)] text-muted hover:border-[var(--c-border-strong)] hover:text-[var(--c-text)]",
            )}
          >
            {it.label}
            {it.count !== undefined && <span className="tnum opacity-70">{it.count}</span>}
          </Link>
        );
      })}
    </div>
  );
}
