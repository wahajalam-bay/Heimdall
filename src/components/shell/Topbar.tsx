"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { classNames, relativeTime } from "@/lib/format";
import type { Density } from "@/lib/nav-state";
import { DensityToggle } from "./DensityToggle";
import { Avatar } from "@/components/ui/primitives";
import { ThemeToggle, Spinner } from "@/components/ui/forms";

export type SearchHit = {
  id: string;
  type: string;
  ref: string;
  title: string;
  sub?: string | null;
  href: string;
  status?: string | null;
};

export type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  priority: string;
  linkUrl: string | null;
  read: boolean;
  createdAt: string;
};

export function Topbar({
  user,
  notifications,
  unreadCount,
  entities,
  activeEntityId,
  density = "comfortable",
}: {
  user: { name: string; email: string; title: string | null; roleNames: string[] };
  notifications: NotificationItem[];
  unreadCount: number;
  entities: Array<{ id: string; code: string; name: string }>;
  activeEntityId: string | null;
  density?: Density;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  /** Highlighted result, so search can be driven from the keyboard alone. */
  const [cursor, setCursor] = useState(0);
  const [bellOpen, setBellOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [pending, start] = useTransition();

  const searchRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cmd/Ctrl-K focuses global search; the arrows and Enter drive the results.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setSearchOpen(true);
        return;
      }
      if (e.key === "Escape") {
        setSearchOpen(false);
        setBellOpen(false);
        setUserOpen(false);
        return;
      }

      const inSearch = document.activeElement === inputRef.current;
      if (!inSearch || !searchOpen || hits.length === 0) return;

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => {
          const next = e.key === "ArrowDown" ? c + 1 : c - 1;
          return (next + hits.length) % hits.length;
        });
      } else if (e.key === "Enter") {
        const hit = hits[cursor];
        if (!hit) return;
        e.preventDefault();
        setSearchOpen(false);
        setQ("");
        router.push(hit.href);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cursor, hits, router, searchOpen]);

  // A new set of results always starts at the top.
  useEffect(() => {
    setCursor(0);
  }, [hits]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchOpen(false);
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false);
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`);
        if (res.ok) {
          const json = (await res.json()) as { hits: SearchHit[] };
          setHits(json.hits ?? []);
        }
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [q]);

  const markRead = (id?: string) => {
    start(async () => {
      await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(id ? { id } : { all: true }),
      });
      router.refresh();
    });
  };

  const switchEntity = (id: string) => {
    start(async () => {
      await fetch("/api/context/entity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId: id }),
      });
      router.refresh();
    });
  };

  const signOut = () => {
    start(async () => {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    });
  };

  return (
    <header className="relative sticky top-0 z-20 flex h-[var(--topbar-h)] items-center gap-2 border-b border-border bg-[var(--c-surface)]/95 px-3 backdrop-blur-sm sm:px-4">
      {/* Which part of the system you are in, as a hairline. */}
      <span
        className="pointer-events-none absolute inset-x-0 bottom-[-1px] h-[2px]"
        style={{ background: "var(--c-mod)" }}
        aria-hidden
      />
      <div className="ml-9 flex-1 lg:ml-0" ref={searchRef}>
        <div className="relative max-w-md">
          <svg
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--c-text-tertiary)]"
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden
          >
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="field"
            style={{ paddingLeft: "1.9rem", paddingRight: "2.75rem" }}
            placeholder="Search PR, PO, RFQ, GRN, invoice, vendor, asset…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
            aria-label="Global search"
            role="combobox"
            aria-expanded={searchOpen && hits.length > 0}
            aria-controls="global-search-results"
            aria-activedescendant={hits[cursor] ? `search-hit-${hits[cursor].type}-${hits[cursor].id}` : undefined}
            autoComplete="off"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border bg-surface-secondary px-1 text-2xs text-[var(--c-text-tertiary)]">
            ⌘K
          </kbd>

          {searchOpen && q.trim().length >= 2 && (
            <div
              id="global-search-results"
              role="listbox"
              aria-label="Search results"
              className="scroll-y absolute left-0 right-0 top-full z-30 mt-1 max-h-[26rem] overlay-panel py-1"
            >
              {searching && (
                <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted">
                  <Spinner size={12} /> Searching…
                </div>
              )}
              {!searching && hits.length === 0 && (
                <div className="px-3 py-3 text-xs text-muted">
                  No records match “{q.trim()}”.
                </div>
              )}
              {hits.map((h, i) => (
                <Link
                  key={`${h.type}-${h.id}`}
                  id={`search-hit-${h.type}-${h.id}`}
                  href={h.href}
                  role="option"
                  aria-selected={i === cursor}
                  ref={
                    i === cursor
                      ? (el) => el?.scrollIntoView({ block: "nearest" })
                      : undefined
                  }
                  className={classNames(
                    "flex items-center gap-2.5 px-3 py-2",
                    i === cursor ? "bg-[var(--c-surface-active)]" : "hover:bg-[var(--c-surface-hover)]",
                  )}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => {
                    setSearchOpen(false);
                    setQ("");
                  }}
                >
                  <span className="badge badge-neutral shrink-0">{h.type}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="mono shrink-0 text-[var(--c-accent-text)]">{h.ref}</span>
                      <span className="truncate text-xs">{h.title}</span>
                    </span>
                    {h.sub && (
                      <span className="block truncate text-2xs text-[var(--c-text-tertiary)]">{h.sub}</span>
                    )}
                  </span>
                  {h.status && (
                    <span className="shrink-0 text-2xs text-[var(--c-text-tertiary)]">{h.status}</span>
                  )}
                </Link>
              ))}
              {hits.length > 0 && (
                <div className="mt-1 flex items-center gap-3 border-t border-separator px-3 pt-1.5 text-2xs text-[var(--c-text-tertiary)]">
                  <span>
                    <kbd className="mono">↑</kbd> <kbd className="mono">↓</kbd> to move
                  </span>
                  <span>
                    <kbd className="mono">Enter</kbd> to open
                  </span>
                  <span>
                    <kbd className="mono">Esc</kbd> to dismiss
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {entities.length > 1 && (
        /* Switching entity re-renders every panel on the page against a different
           scope, which takes as long as it takes. The control stays closed to a
           second switch mid-flight, but it says so rather than just going dead. */
        <select
          className="field hidden w-auto py-1 text-xs sm:block"
          value={activeEntityId ?? ""}
          onChange={(e) => switchEntity(e.target.value)}
          aria-label="Active entity"
          aria-busy={pending}
          title={pending ? "Switching entity…" : undefined}
          disabled={pending}
        >
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.code} — {e.name}
            </option>
          ))}
        </select>
      )}

      {entities.length > 1 && pending && (
        <span className="hidden items-center gap-1.5 text-2xs text-muted sm:flex" role="status">
          <Spinner size={11} />
          Switching…
        </span>
      )}

      <DensityToggle initial={density} />

      <ThemeToggle />

      <div className="relative" ref={bellRef}>
        <button
          type="button"
          className="btn btn-ghost btn-sm relative"
          onClick={() => setBellOpen((v) => !v)}
          aria-label={`Notifications${unreadCount ? ` (${unreadCount} unread)` : ""}`}
          aria-expanded={bellOpen}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M4 6.5a4 4 0 0 1 8 0c0 2.4.6 3.4 1.1 4H2.9C3.4 9.9 4 8.9 4 6.5Z"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinejoin="round"
            />
            <path d="M6.4 12.5a1.7 1.7 0 0 0 3.2 0" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          </svg>
          {unreadCount > 0 && (
            <span
              className="absolute right-1 top-1 size-2 rounded-full ring-2 ring-[var(--c-surface)]"
              style={{ background: "var(--c-danger)" }}
              aria-hidden
            />
          )}
        </button>

        {bellOpen && (
          <div className="absolute right-0 z-30 mt-1 w-[22rem] overlay-panel">
            <div className="flex items-center justify-between border-b border-separator px-3 py-2">
              <span className="text-xs font-600">Notifications</span>
              {unreadCount > 0 && (
                <button type="button" className="btn btn-ghost btn-xs" onClick={() => markRead()} disabled={pending}>
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-[22rem] overflow-y-auto">
              {notifications.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted">
                  You&apos;re all caught up.
                </p>
              ) : (
                notifications.map((n) => {
                  const inner = (
                    <>
                      <span className="flex items-start gap-2">
                        <span
                          className="mt-1.5 size-1.5 shrink-0 rounded-full"
                          style={{
                            background: n.read
                              ? "transparent"
                              : n.priority === "CRITICAL"
                                ? "var(--c-danger)"
                                : n.priority === "HIGH"
                                  ? "var(--c-warning)"
                                  : "var(--c-accent)",
                          }}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1">
                          <span
                            className={classNames(
                              "block text-xs leading-4",
                              n.read ? "text-muted" : "font-500 text-[var(--c-text)]",
                            )}
                          >
                            {n.title}
                          </span>
                          {n.body && (
                            <span className="mt-0.5 block truncate-2 text-2xs leading-4 text-[var(--c-text-tertiary)]">
                              {n.body}
                            </span>
                          )}
                          <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                            {relativeTime(n.createdAt)}
                          </span>
                        </span>
                      </span>
                    </>
                  );
                  return n.linkUrl ? (
                    <Link
                      key={n.id}
                      href={n.linkUrl}
                      className="block border-b border-separator px-3 py-2.5 last:border-0 hover:bg-[var(--c-surface-hover)]"
                      onClick={() => {
                        if (!n.read) markRead(n.id);
                        setBellOpen(false);
                      }}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div key={n.id} className="border-b border-separator px-3 py-2.5 last:border-0">
                      {inner}
                    </div>
                  );
                })
              )}
            </div>
            <div className="border-t border-separator px-3 py-2 text-center">
              <Link href="/alerts" className="text-xs text-[var(--c-accent-text)]" onClick={() => setBellOpen(false)}>
                View all alerts
              </Link>
            </div>
          </div>
        )}
      </div>

      <div className="relative" ref={userRef}>
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-[var(--c-surface-active)]"
          onClick={() => setUserOpen((v) => !v)}
          aria-expanded={userOpen}
          aria-label="Account menu"
        >
          <Avatar name={user.name} size={24} />
          <span className="hidden min-w-0 text-left sm:block">
            <span className="block max-w-[9rem] truncate text-xs font-500 leading-4">{user.name}</span>
            <span className="block max-w-[9rem] truncate text-2xs leading-3.5 text-[var(--c-text-tertiary)]">
              {user.roleNames[0] ?? user.title ?? ""}
            </span>
          </span>
        </button>

        {userOpen && (
          <div className="absolute right-0 z-30 mt-1 w-64 overlay-panel py-1">
            <div className="border-b border-separator px-3 py-2.5">
              <p className="text-[0.8125rem] font-600">{user.name}</p>
              <p className="truncate text-2xs text-[var(--c-text-tertiary)]">{user.email}</p>
              {user.title && <p className="mt-0.5 text-2xs text-muted">{user.title}</p>}
              <div className="mt-1.5 flex flex-wrap gap-1">
                {user.roleNames.map((r) => (
                  <span key={r} className="badge badge-neutral">
                    {r}
                  </span>
                ))}
              </div>
            </div>
            <Link
              href="/workspace"
              className="block px-3 py-1.5 text-xs hover:bg-[var(--c-surface-hover)]"
              onClick={() => setUserOpen(false)}
            >
              My workspace
            </Link>
            <Link
              href="/settings"
              className="block px-3 py-1.5 text-xs hover:bg-[var(--c-surface-hover)]"
              onClick={() => setUserOpen(false)}
            >
              Notification preferences
            </Link>
            <div className="my-1 border-t border-separator" />
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--c-danger)] hover:bg-[var(--c-surface-hover)]"
              onClick={signOut}
              disabled={pending}
            >
              {pending && <Spinner size={11} />}
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
