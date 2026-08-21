"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { loginAction } from "./actions";
import { Spinner } from "@/components/ui/forms";
import type { ActionResult } from "@/lib/errors";

export type DemoAccount = {
  email: string;
  name: string;
  title: string | null;
  entity: string;
  role: string;
};

export function LoginForm({ accounts }: { accounts: DemoAccount[] }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    async (prev, fd) => loginAction(prev, fd),
    null,
  );
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showDirectory, setShowDirectory] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (state?.ok) {
      router.push("/");
      router.refresh();
    }
  }, [state, router]);

  const filtered = accounts.filter((a) => {
    const t = filter.trim().toLowerCase();
    if (!t) return true;
    return (
      a.name.toLowerCase().includes(t) ||
      a.role.toLowerCase().includes(t) ||
      a.email.toLowerCase().includes(t) ||
      a.entity.toLowerCase().includes(t)
    );
  });

  return (
    <>
      <form action={action} className="mt-6 space-y-3.5">
        {state && !state.ok && (
          <div
            role="alert"
            className="rounded-[var(--radius-sm)] border border-[var(--c-danger-border)] bg-[var(--c-danger-soft)] px-3 py-2 text-xs text-[var(--c-danger)]"
          >
            {state.error}
          </div>
        )}
        <div>
          <label htmlFor="email" className="mb-1 block text-xs font-500 text-[var(--c-text-secondary)]">
            Work email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            className="field"
            placeholder="name@zameen.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="password" className="mb-1 block text-xs font-500 text-[var(--c-text-secondary)]">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="field"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-primary btn-lg w-full" disabled={pending}>
          {pending && <Spinner />}
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>

      {accounts.length > 0 && (
        <div className="mt-7 rounded-[var(--radius-md)] border border-[var(--c-border)] bg-[var(--c-surface)]">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
            onClick={() => setShowDirectory((v) => !v)}
            aria-expanded={showDirectory}
          >
            <span>
              <span className="block text-xs font-600">Role directory</span>
              <span className="block text-2xs text-[var(--c-text-tertiary)]">
                {accounts.length} seeded accounts · password{" "}
                <code className="mono rounded bg-[var(--c-surface-sunken)] px-1">Passw0rd!</code>
              </span>
            </span>
            <span className="text-xs text-[var(--c-text-tertiary)]">{showDirectory ? "▲" : "▼"}</span>
          </button>
          {showDirectory && (
            <div className="border-t border-[var(--c-border-subtle)]">
              <div className="p-2">
                <input
                  className="field"
                  placeholder="Filter by role, name or entity…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  aria-label="Filter accounts"
                />
              </div>
              <ul className="max-h-72 overflow-y-auto px-1 pb-2">
                {filtered.map((a) => (
                  <li key={a.email}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-[var(--radius-xs)] px-2 py-1.5 text-left hover:bg-[var(--c-surface-hover)]"
                      onClick={() => {
                        setEmail(a.email);
                        setPassword("Passw0rd!");
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-500">{a.name}</span>
                        <span className="block truncate text-2xs text-[var(--c-text-tertiary)]">
                          {a.role} · {a.email}
                        </span>
                      </span>
                      <span className="badge badge-neutral shrink-0">{a.entity}</span>
                    </button>
                  </li>
                ))}
                {filtered.length === 0 && (
                  <li className="px-2 py-3 text-center text-2xs text-[var(--c-text-tertiary)]">
                    No accounts match that filter.
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </>
  );
}
