"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Keyboard layer.
 *
 * Two jobs: `?` lists what the keyboard can do, and `g` followed by a letter
 * jumps between areas of the system — the pattern people already know from
 * issue trackers, and the fastest route for anyone who lives in the approvals
 * queue all day. Nothing fires while a field has focus, so typing "g" in a
 * search box does not teleport the page.
 */

type Jump = { keys: string; label: string; href: string };

const JUMPS: Jump[] = [
  { keys: "g d", label: "Executive dashboard", href: "/" },
  { keys: "g w", label: "My workspace", href: "/workspace" },
  { keys: "g r", label: "Requisitions", href: "/pr" },
  { keys: "g q", label: "RFQs and quotations", href: "/rfq" },
  { keys: "g o", label: "Purchase orders", href: "/po" },
  { keys: "g v", label: "Receiving", href: "/receiving" },
  { keys: "g n", label: "Inventory", href: "/inventory" },
  { keys: "g s", label: "Vendors", href: "/vendors" },
  { keys: "g c", label: "Committee cases", href: "/cpc/cases" },
  { keys: "g i", label: "Invoices", href: "/invoices" },
  { keys: "g a", label: "Analytics", href: "/analytics" },
  { keys: "g e", label: "Exceptions", href: "/analytics/exceptions" },
];

const ACTIONS: Array<{ keys: string; label: string }> = [
  { keys: "Ctrl K", label: "Search everything by document number, vendor or title" },
  { keys: "↑ ↓ Enter", label: "Move through search results and open one" },
  { keys: "Ctrl B", label: "Collapse or expand the navigation" },
  { keys: "?", label: "Show this list" },
  { keys: "Esc", label: "Close whatever is open" },
];

/** True when the keystroke belongs to whatever the user is typing into. */
function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function Shortcuts() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [awaitingJump, setAwaitingJump] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "Escape") {
        setOpen(false);
        setAwaitingJump(false);
        return;
      }
      if (isTyping(e.target)) return;

      if (e.key === "?") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }

      if (awaitingJump) {
        const jump = JUMPS.find((j) => j.keys.endsWith(e.key.toLowerCase()));
        setAwaitingJump(false);
        if (timer) clearTimeout(timer);
        if (jump) {
          e.preventDefault();
          setOpen(false);
          router.push(jump.href);
        }
        return;
      }

      if (e.key.toLowerCase() === "g") {
        e.preventDefault();
        setAwaitingJump(true);
        // The sequence expires, so a stray "g" does not lie in wait.
        timer = setTimeout(() => setAwaitingJump(false), 1500);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (timer) clearTimeout(timer);
    };
  }, [awaitingJump, router]);

  return (
    <>
      {awaitingJump && !open && (
        <div
          className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 tooltip-panel px-3 py-1.5"
          role="status"
        >
          Go to… press a letter, or <kbd className="mono">Esc</kbd> to cancel
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
          <div
            className="absolute inset-0"
            style={{ background: "var(--c-overlay)" }}
            onClick={() => setOpen(false)}
          />
          <div className="relative w-full max-w-2xl overflow-hidden overlay-panel">
            <header className="flex items-center justify-between gap-4 border-b border-separator px-4 py-3">
              <div>
                <h2 className="text-[0.9375rem] font-600">Keyboard shortcuts</h2>
                <p className="mt-0.5 text-xs text-muted">
                  Press <kbd className="mono">?</kbd> at any time to bring this back.
                </p>
              </div>
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => setOpen(false)}>
                Close
              </button>
            </header>

            <div className="grid gap-x-8 gap-y-6 px-4 py-4 sm:grid-cols-2">
              <section>
                <h3 className="label mb-2">Anywhere</h3>
                <ul className="space-y-1.5">
                  {ACTIONS.map((a) => (
                    <li key={a.keys} className="flex items-baseline gap-3 text-xs">
                      <kbd className="mono shrink-0 rounded border border-border bg-surface-secondary px-1.5 py-0.5 text-2xs">
                        {a.keys}
                      </kbd>
                      <span className="text-muted">{a.label}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="label mb-2">Go to</h3>
                <ul className="space-y-1.5">
                  {JUMPS.map((j) => (
                    <li key={j.keys} className="flex items-baseline gap-3 text-xs">
                      <kbd className="mono shrink-0 rounded border border-border bg-surface-secondary px-1.5 py-0.5 text-2xs">
                        {j.keys}
                      </kbd>
                      <span className="text-muted">{j.label}</span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
