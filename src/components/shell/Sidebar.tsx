"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { classNames } from "@/lib/format";
import { useIsomorphicLayoutEffect } from "@/lib/hooks";
import { moduleColor, moduleForGroup } from "@/lib/modules";
import { NAV_COOKIE } from "@/lib/nav-state";
import type { NavGroup } from "@/lib/navigation";
import { NavIcon } from "./NavIcon";

export type BadgeCounts = Partial<Record<string, number>>;

const GROUPS_KEY = "heimdall.nav.groups";
const ONE_YEAR = 60 * 60 * 24 * 365;

const DANGER_BADGES = new Set(["invoiceMismatch", "exceptions"]);
const WARNING_BADGES = new Set(["openPo", "inspections", "grnPending"]);

/** Fixed-position label for a rail item, so it is never clipped by the scroller. */
type RailTip = { label: string; top: number } | null;

export function Sidebar({
  groups,
  counts,
  entityLabel,
  initialRail = false,
}: {
  groups: NavGroup[];
  counts: BadgeCounts;
  entityLabel: string;
  /** Server-resolved from the navigation cookie, so the first paint is correct. */
  initialRail?: boolean;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [rail, setRail] = useState(initialRail);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [tip, setTip] = useState<RailTip>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  /* ── Persisted state ──────────────────────────────────── */

  // Which groups are folded away is a local preference, so it stays in local
  // storage; the rail is a cookie because the server renders against it.
  useIsomorphicLayoutEffect(() => {
    try {
      const raw = window.localStorage.getItem(GROUPS_KEY);
      if (raw) setCollapsedGroups(JSON.parse(raw) as string[]);
    } catch {
      /* a corrupt preference is not worth failing over */
    }
  }, []);

  const applyRail = useCallback((next: boolean) => {
    setRail(next);
    setTip(null);
    // The attribute drives the width token immediately; the cookie makes the
    // choice survive the next request.
    document.documentElement.dataset.nav = next ? "rail" : "full";
    document.cookie = `${NAV_COOKIE}=${next ? "rail" : "full"}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
  }, []);

  const toggleGroup = (label: string) => {
    setCollapsedGroups((prev) => {
      const next = prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label];
      try {
        window.localStorage.setItem(GROUPS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  /* ── Navigation side effects ──────────────────────────── */

  const isActive = useCallback(
    (href: string, exact?: boolean) => {
      if (exact) return pathname === href;
      if (href === "/") return pathname === "/";
      return pathname === href || pathname.startsWith(`${href}/`);
    },
    [pathname],
  );

  // Close the drawer and drop the filter on navigation.
  useEffect(() => {
    setMobileOpen(false);
    setQuery("");
  }, [pathname]);

  // A group holding the current page opens itself rather than hiding where you are.
  useEffect(() => {
    const owning = groups.find((g) => g.items.some((i) => isActive(i.href, i.exact)));
    if (!owning) return;
    setCollapsedGroups((prev) => {
      if (!prev.includes(owning.label)) return prev;
      const next = prev.filter((l) => l !== owning.label);
      try {
        window.localStorage.setItem(GROUPS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [groups, isActive]);

  // Publish which module is in view: the page eyebrow, the rule under the top
  // bar and the active row all take their colour from it.
  useEffect(() => {
    const owning = groups.find((g) => g.items.some((i) => isActive(i.href, i.exact)));
    document.documentElement.dataset.module = owning ? moduleForGroup(owning.label) : "home";
  }, [groups, isActive]);

  // Keep the active entry in view when the nav is long enough to scroll.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const active = scroller?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!scroller || !active) return;
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    if (top < scroller.scrollTop || bottom > scroller.scrollTop + scroller.clientHeight) {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [pathname, rail, collapsedGroups]);

  /* ── Keyboard ─────────────────────────────────────────── */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        applyRail(!rail);
        return;
      }
      if (e.key === "Escape") {
        if (mobileOpen) setMobileOpen(false);
        else if (document.activeElement === searchRef.current) {
          setQuery("");
          searchRef.current?.blur();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyRail, rail, mobileOpen]);

  /* ── Filtering ────────────────────────────────────────── */

  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? groups
        .map((g) => ({ ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(needle)) }))
        .filter((g) => g.items.length > 0)
    : groups;

  const matchCount = filtered.reduce((a, g) => a + g.items.length, 0);

  /* ── Rendering ────────────────────────────────────────── */

  const badgeTone = (badge: string | undefined, active: boolean) =>
    badge && DANGER_BADGES.has(badge)
      ? "bg-[var(--c-danger-soft)] text-[var(--c-danger)]"
      : badge && WARNING_BADGES.has(badge)
        ? "bg-[var(--c-warning-soft)] text-[var(--c-warning)]"
        : active
          ? "bg-[var(--c-nav-mark)] text-[var(--c-nav-mark-ink)]"
          : "bg-[var(--c-nav-bg-hover)] text-[var(--c-nav-text-muted)]";

  /** `railMode` is forced off inside the mobile drawer, which is always full width. */
  const renderNav = (railMode: boolean) => (
    <nav className="flex h-full flex-col" aria-label="Main">
      <div
        className={classNames(
          "flex h-[var(--topbar-h)] shrink-0 items-center border-b border-[var(--c-nav-border)]",
          railMode ? "justify-center px-2" : "gap-2 px-3.5",
        )}
      >
        <Link
          href="/"
          className="flex min-w-0 items-center gap-2 rounded-lg outline-offset-2"
          title={railMode ? `Heimdall · ${entityLabel}` : undefined}
        >
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-lg text-[0.6875rem] font-700"
            style={{ background: "var(--c-nav-mark)", color: "var(--c-nav-mark-ink)" }}
            aria-hidden
          >
            H
          </span>
          {!railMode && (
            <span className="min-w-0">
              <span className="block truncate text-[0.8125rem] font-600 leading-4 text-[var(--c-nav-text)]">Heimdall</span>
              <span className="block truncate text-2xs leading-3.5 text-[var(--c-nav-text-dim)]">
                {entityLabel}
              </span>
            </span>
          )}
        </Link>
      </div>

      {!railMode && (
        <div className="shrink-0 px-2 pt-2.5">
          <div className="relative">
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter navigation"
              aria-label="Filter navigation"
              className="field !border-[var(--c-nav-border)] !bg-[var(--c-nav-bg-hover)] !py-1 !pl-7 !pr-2 text-xs !text-[var(--c-nav-text)] placeholder:!text-[var(--c-nav-text-dim)]"
            />
            <svg
              viewBox="0 0 24 24"
              className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-[var(--c-nav-text-dim)]"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M16.5 16.5 21 21" />
            </svg>
          </div>
        </div>
      )}

      <div
        ref={scrollerRef}
        className="scroll-y flex-1 px-2 py-3"
      >
        {needle && matchCount === 0 && (
          <p className="px-2 py-6 text-center text-xs text-[var(--c-nav-text-muted)]">
            Nothing matches “{query.trim()}”.
          </p>
        )}

        {filtered.map((g, gi) => {
          const collapsed = !needle && collapsedGroups.includes(g.label);
          const groupActive = g.items.some((i) => isActive(i.href, i.exact));
          const hue = moduleColor(moduleForGroup(g.label), "rail");
          return (
            <div
              key={g.label}
              className={classNames("mb-1", railMode && gi > 0 && "mt-1 border-t border-[var(--c-nav-border)] pt-1")}
            >
              {railMode ? (
                <span className="sr-only">{g.label}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => toggleGroup(g.label)}
                  className="flex w-full items-center justify-between gap-1 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-[var(--c-nav-bg-hover)]"
                  aria-expanded={!collapsed}
                >
                  {/* The module hue lives in the label itself; a separate bar
                      read as a stray pipe character at this size. */}
                  <span
                    className="label flex items-center gap-1.5"
                    style={{ color: groupActive ? hue : "var(--c-nav-text-dim)" }}
                  >
                    {g.label}
                    {collapsed && groupActive && (
                      <span className="size-1.5 rounded-full" style={{ background: hue }} aria-hidden />
                    )}
                  </span>
                  <svg
                    viewBox="0 0 24 24"
                    className={classNames(
                      "size-3 text-[var(--c-nav-text-dim)] transition-transform duration-150",
                      collapsed && "-rotate-90",
                    )}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
              )}

              {(railMode || !collapsed) && (
                <ul className={classNames("space-y-px", railMode ? "" : "mt-0.5")}>
                  {g.items.map((it) => {
                    const active = isActive(it.href, it.exact);
                    const count = it.badge ? counts[it.badge] : undefined;
                    const hasCount = count !== undefined && count > 0;
                    return (
                      <li key={it.href}>
                        <Link
                          href={it.href}
                          aria-label={railMode ? `${it.label}${hasCount ? ` · ${count}` : ""}` : undefined}
                          onMouseEnter={
                            railMode
                              ? (e) =>
                                  setTip({
                                    label: `${it.label}${hasCount ? ` · ${count}` : ""}`,
                                    top: e.currentTarget.getBoundingClientRect().top,
                                  })
                              : undefined
                          }
                          onMouseLeave={railMode ? () => setTip(null) : undefined}
                          onFocus={
                            railMode
                              ? (e) =>
                                  setTip({
                                    label: `${it.label}${hasCount ? ` · ${count}` : ""}`,
                                    top: e.currentTarget.getBoundingClientRect().top,
                                  })
                              : undefined
                          }
                          onBlur={railMode ? () => setTip(null) : undefined}
                          className={classNames(
                            "group relative flex items-center rounded-lg text-[0.8125rem] leading-5 transition-colors",
                            railMode ? "justify-center px-0 py-1.5" : "gap-2 px-2 py-[0.3125rem]",
                            active
                              ? "bg-[var(--c-nav-active-bg)] font-500 text-[var(--c-nav-text)]"
                              : "text-[var(--c-nav-text-muted)] hover:bg-[var(--c-nav-bg-hover)] hover:text-[var(--c-nav-text)]",
                          )}
                          style={active ? { boxShadow: `inset 2px 0 0 0 ${hue}` } : undefined}
                          aria-current={active ? "page" : undefined}
                        >
                          <span className="relative shrink-0">
                            <NavIcon
                              name={it.icon}
                              className={classNames(
                                railMode ? "size-[1.125rem]" : "size-4",
                                !active && "text-[var(--c-nav-text-dim)] group-hover:text-[var(--c-nav-text-muted)]",
                              )}
                              style={active ? { color: hue } : undefined}
                            />
                            {railMode && hasCount && (
                              <span
                                className={classNames(
                                  "absolute -right-1.5 -top-1 size-2 rounded-full ring-2 ring-[var(--c-nav-bg)]",
                                  it.badge && DANGER_BADGES.has(it.badge)
                                    ? "bg-[var(--c-danger)]"
                                    : it.badge && WARNING_BADGES.has(it.badge)
                                      ? "bg-[var(--c-warning)]"
                                      : "bg-[var(--c-accent)]",
                                )}
                                aria-hidden
                              />
                            )}
                          </span>
                          {!railMode && (
                            <>
                              <span className="min-w-0 flex-1 truncate">{it.label}</span>
                              {hasCount && (
                                <span
                                  className={classNames(
                                    "tnum shrink-0 rounded-full px-1.5 text-2xs font-600 leading-[1.125rem]",
                                    badgeTone(it.badge, active),
                                  )}
                                >
                                  {count > 99 ? "99+" : count}
                                </span>
                              )}
                            </>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {/* Collapsing is a desktop affordance: the drawer is either open or shut. */}
      <div className="hidden shrink-0 border-t border-[var(--c-nav-border)] p-2 lg:block">
        <button
          type="button"
          onClick={() => applyRail(!railMode)}
          className={classNames(
            "flex w-full items-center rounded-lg px-2 py-1.5 text-xs text-[var(--c-nav-text-muted)] transition-colors hover:bg-[var(--c-nav-bg-hover)] hover:text-[var(--c-nav-text)]",
            railMode ? "justify-center" : "gap-2",
          )}
          title={railMode ? "Expand navigation (Ctrl+B)" : "Collapse navigation (Ctrl+B)"}
          aria-label={railMode ? "Expand navigation" : "Collapse navigation"}
        >
          <svg
            viewBox="0 0 24 24"
            className="size-4 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M4 5h16M4 19h16" />
            {railMode ? <path d="m10 9 3 3-3 3M15 8v8" /> : <path d="m14 9-3 3 3 3M9 8v8" />}
          </svg>
          {!railMode && (
            <>
              <span className="flex-1 text-left">Collapse</span>
              <kbd className="mono rounded border border-[var(--c-nav-border)] px-1 text-2xs text-[var(--c-nav-text-dim)]">
                Ctrl B
              </kbd>
            </>
          )}
        </button>
      </div>
    </nav>
  );

  return (
    <>
      {/* Mobile trigger */}
      {!mobileOpen && (
        <button
          type="button"
          className="btn btn-secondary btn-sm fixed left-3 top-2.5 z-40 lg:hidden"
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation"
          aria-expanded={mobileOpen}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      )}

      <aside
        className={classNames(
          "fixed inset-y-0 left-0 z-30 hidden w-[var(--nav-w)] border-r border-[var(--c-nav-border)] bg-[var(--c-nav-bg)] lg:block",
          "transition-[width] duration-150 ease-out",
        )}
        data-rail={rail ? "true" : "false"}
      >
        {renderNav(rail)}
      </aside>

      {/* Rail tooltip: fixed, so the nav scroller cannot clip it. */}
      {rail && tip && (
        <div
          className="pointer-events-none fixed z-40 hidden -translate-y-1/2 whitespace-nowrap rounded-lg border border-border bg-overlay px-2 py-1 text-xs text-[var(--c-text)] shadow-overlay lg:block"
          style={{ left: "calc(var(--nav-w) + 0.5rem)", top: tip.top + 14 }}
          role="presentation"
        >
          {tip.label}
        </div>
      )}

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div
            className="absolute inset-0"
            style={{ background: "var(--c-overlay)" }}
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-[17rem] border-r border-[var(--c-nav-border)] bg-[var(--c-nav-bg)]">
            <button
              type="button"
              className="absolute right-2 top-2.5 z-10 flex size-7 items-center justify-center rounded-lg text-[var(--c-nav-text-muted)] transition-colors hover:bg-[var(--c-nav-bg-hover)] hover:text-[var(--c-nav-text)]"
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
            {renderNav(false)}
          </div>
        </div>
      )}
    </>
  );
}
