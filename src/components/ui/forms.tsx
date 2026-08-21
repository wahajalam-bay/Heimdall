"use client";

import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { classNames } from "@/lib/format";
import type { ActionResult } from "@/lib/errors";

export type ServerAction = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

/**
 * Wraps a server action with inline error/success rendering and optional
 * autosave-draft support. All validation and authorization happen server-side;
 * this only surfaces the outcome.
 */
export function ActionForm({
  action,
  children,
  submitLabel = "Save",
  submitTone = "primary",
  secondary,
  onSuccessRedirect,
  successMessage,
  className,
  hiddenFields,
  resetOnSuccess,
  draftKey,
  footerSticky,
  confirm,
  layout = "card",
}: {
  action: ServerAction;
  children: ReactNode;
  submitLabel?: string;
  submitTone?: "primary" | "success" | "danger";
  secondary?: ReactNode;
  onSuccessRedirect?: string | ((data: unknown) => string);
  successMessage?: string;
  className?: string;
  hiddenFields?: Record<string, string | number | null | undefined>;
  resetOnSuccess?: boolean;
  /** localStorage key enabling draft autosave for long forms. */
  draftKey?: string;
  footerSticky?: boolean;
  confirm?: string;
  layout?: "card" | "bare";
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    async (prev, fd) => action(prev, fd),
    null,
  );
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      if (draftKey) window.localStorage.removeItem(`pos.draft.${draftKey}`);
      if (resetOnSuccess) formRef.current?.reset();
      if (onSuccessRedirect) {
        const to =
          typeof onSuccessRedirect === "function" ? onSuccessRedirect(state.data) : onSuccessRedirect;
        router.push(to);
      } else {
        router.refresh();
      }
    }
  }, [state, router, onSuccessRedirect, resetOnSuccess, draftKey]);

  // Draft autosave for multi-field forms.
  useEffect(() => {
    if (!draftKey || restored) return;
    try {
      const raw = window.localStorage.getItem(`pos.draft.${draftKey}`);
      if (raw && formRef.current) {
        const data = JSON.parse(raw) as Record<string, string>;
        for (const [k, v] of Object.entries(data)) {
          const el = formRef.current.elements.namedItem(k) as unknown as
            | { value?: string }
            | null;
          // Never clobber a value the user has already typed.
          if (el && typeof el.value === "string" && el.value === "") el.value = v;
        }
      }
    } catch {
      /* ignore */
    }
    setRestored(true);
  }, [draftKey, restored]);

  const persistDraft = () => {
    if (!draftKey || !formRef.current) return;
    const fd = new FormData(formRef.current);
    const obj: Record<string, string> = {};
    fd.forEach((v, k) => {
      if (typeof v === "string" && v) obj[k] = v;
    });
    try {
      window.localStorage.setItem(`pos.draft.${draftKey}`, JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  };

  return (
    <form
      ref={formRef}
      action={formAction}
      className={classNames(layout === "card" && "card overflow-hidden", className)}
      onChange={draftKey ? persistDraft : undefined}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      noValidate
    >
      {hiddenFields &&
        Object.entries(hiddenFields).map(([k, v]) =>
          v === null || v === undefined ? null : (
            <input key={k} type="hidden" name={k} value={String(v)} />
          ),
        )}

      <div className={layout === "card" ? "space-y-6 px-4 py-4" : "space-y-6"}>
        {state && !state.ok && (
          <div
            role="alert"
            className="rounded-[var(--radius-sm)] border border-[var(--c-danger-border)] bg-[var(--c-danger-soft)] px-3 py-2.5"
          >
            <p className="text-xs font-600 text-[var(--c-danger)]">Could not complete this action</p>
            <p className="mt-0.5 text-xs leading-5 text-[var(--c-danger)]">{state.error}</p>
            {Array.isArray(state.details) && state.details.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 pl-4 text-xs text-[var(--c-danger)]">
                {(state.details as string[]).map((d, i) => (
                  <li key={i} className="list-disc">
                    {d}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {state?.ok && (successMessage || state.message) && (
          <div
            role="status"
            className="rounded-[var(--radius-sm)] border border-[var(--c-success-border)] bg-[var(--c-success-soft)] px-3 py-2 text-xs text-[var(--c-success)]"
          >
            {state.message ?? successMessage}
          </div>
        )}
        {children}
      </div>

      <div
        className={classNames(
          "flex flex-wrap items-center justify-end gap-2 border-t border-[var(--c-border)] px-4 py-3",
          footerSticky && "sticky bottom-0 z-10 bg-[var(--c-surface)]",
          layout === "bare" && "-mx-0 mt-4",
        )}
      >
        {draftKey && (
          <span className="mr-auto text-2xs text-[var(--c-text-tertiary)]">
            Draft saved locally as you type
          </span>
        )}
        {secondary}
        <button
          type="submit"
          disabled={pending}
          className={classNames(
            "btn",
            submitTone === "success" ? "btn-success" : submitTone === "danger" ? "btn-danger" : "btn-primary",
          )}
        >
          {pending && <Spinner />}
          {pending ? "Working…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

export function Spinner({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className="animate-spin"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.75" />
      <path d="M14.25 8A6.25 6.25 0 0 0 8 1.75" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export function SubmitButton({
  children,
  tone = "primary",
  size,
  className,
  confirm,
  disabled,
}: {
  children: ReactNode;
  tone?: "primary" | "secondary" | "success" | "danger" | "ghost";
  size?: "sm" | "xs" | "lg";
  className?: string;
  confirm?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className={classNames("btn", `btn-${tone}`, size && `btn-${size}`, className)}
    >
      {pending && <Spinner size={12} />}
      {children}
    </button>
  );
}

/**
 * One-shot action trigger (approve, post, issue…). Optionally collects a
 * mandatory reason before dispatching.
 */
export function ActionButton({
  action,
  label,
  tone = "secondary",
  size = "sm",
  confirm,
  reasonLabel,
  reasonRequired,
  payload,
  disabled,
  disabledReason,
  redirectTo,
  icon,
  className,
}: {
  action: (fd: FormData) => Promise<ActionResult>;
  label: string;
  tone?: "primary" | "secondary" | "success" | "danger" | "danger-soft" | "ghost";
  size?: "sm" | "xs" | "lg";
  confirm?: string;
  reasonLabel?: string;
  reasonRequired?: boolean;
  payload?: Record<string, string | number | null | undefined>;
  disabled?: boolean;
  disabledReason?: string;
  redirectTo?: string;
  icon?: ReactNode;
  className?: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const router = useRouter();
  const fieldId = useId();

  const dispatch = (withReason?: string) => {
    setError(null);
    start(async () => {
      const fd = new FormData();
      if (payload) {
        for (const [k, v] of Object.entries(payload)) {
          if (v !== null && v !== undefined) fd.set(k, String(v));
        }
      }
      if (withReason !== undefined) fd.set("reason", withReason);
      const res = await action(fd);
      if (res.ok) {
        setReasonOpen(false);
        setReason("");
        if (redirectTo) router.push(redirectTo);
        else router.refresh();
      } else {
        setError(res.error);
      }
    });
  };

  const onClick = () => {
    if (reasonLabel) {
      setReasonOpen(true);
      return;
    }
    if (confirm && !window.confirm(confirm)) return;
    dispatch();
  };

  return (
    <span className={classNames("relative inline-flex flex-col items-stretch", className)}>
      <button
        type="button"
        className={classNames("btn", `btn-${tone}`, `btn-${size}`)}
        onClick={onClick}
        disabled={pending || disabled}
        title={disabled ? disabledReason : undefined}
      >
        {pending ? <Spinner size={12} /> : icon}
        {label}
      </button>

      {reasonOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal>
          <div
            className="absolute inset-0"
            style={{ background: "var(--c-overlay)" }}
            onClick={() => setReasonOpen(false)}
          />
          <div className="relative w-full max-w-md rounded-[var(--radius-lg)] border border-[var(--c-border)] bg-[var(--c-surface)] p-4 shadow-[var(--shadow-lg)]">
            <h3 className="text-[0.875rem] font-600">{label}</h3>
            <label htmlFor={fieldId} className="mt-3 mb-1 block text-xs font-500 text-[var(--c-text-secondary)]">
              {reasonLabel}
              {reasonRequired && <span className="text-[var(--c-danger)]"> *</span>}
            </label>
            <textarea
              id={fieldId}
              className="field"
              rows={4}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
              placeholder="Provide the reason that will be recorded in the audit trail…"
            />
            {error && <p className="mt-2 text-xs text-[var(--c-danger)]">{error}</p>}
            <div className="mt-3.5 flex justify-end gap-2">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setReasonOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className={classNames("btn btn-sm", tone === "danger" ? "btn-danger" : "btn-primary")}
                disabled={pending || (reasonRequired && !reason.trim())}
                onClick={() => dispatch(reason)}
              >
                {pending && <Spinner size={12} />}
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {error && !reasonOpen && (
        <span className="absolute left-0 top-full z-20 mt-1 w-max max-w-xs rounded-[var(--radius-sm)] border border-[var(--c-danger-border)] bg-[var(--c-danger-soft)] px-2 py-1 text-2xs leading-4 text-[var(--c-danger)] shadow-[var(--shadow-md)]">
          {error}
          <button
            type="button"
            className="ml-1.5 font-600 underline"
            onClick={() => setError(null)}
          >
            dismiss
          </button>
        </span>
      )}
    </span>
  );
}

/* ── Modal / drawer shells ────────────────────────────────── */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = "md",
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  const w = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[size];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8" role="dialog" aria-modal aria-label={title}>
      <div className="fixed inset-0" style={{ background: "var(--c-overlay)" }} onClick={onClose} />
      <div
        className={classNames(
          "relative my-auto w-full rounded-[var(--radius-xl)] border border-[var(--c-border)] bg-[var(--c-surface)] shadow-[var(--shadow-lg)]",
          w,
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--c-border-subtle)] px-4 py-3">
          <div>
            <h2 className="text-[0.9375rem] font-600">{title}</h2>
            {description && (
              <p className="mt-0.5 text-xs leading-5 text-[var(--c-text-secondary)]">{description}</p>
            )}
          </div>
          <button type="button" className="btn btn-ghost btn-xs" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-4 py-4">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-[var(--c-border-subtle)] px-4 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  width = "28rem",
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal aria-label={title}>
      <div className="absolute inset-0" style={{ background: "var(--c-overlay)" }} onClick={onClose} />
      <aside
        className="absolute inset-y-0 right-0 flex flex-col border-l border-[var(--c-border)] bg-[var(--c-surface)] shadow-[var(--shadow-lg)]"
        style={{ width: `min(${width}, 100vw)` }}
      >
        <header className="flex items-center justify-between gap-3 border-b border-[var(--c-border-subtle)] px-4 py-3">
          <h2 className="text-[0.9375rem] font-600">{title}</h2>
          <button type="button" className="btn btn-ghost btn-xs" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-[var(--c-border-subtle)] px-4 py-3">
            {footer}
          </footer>
        )}
      </aside>
    </div>
  );
}

/** Progressive disclosure block for optional/advanced form fields. */
export function Disclosure({
  summary,
  children,
  defaultOpen,
  badge,
}: {
  summary: string;
  children: ReactNode;
  defaultOpen?: boolean;
  badge?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--c-border)]">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-[0.8125rem] font-500">
          {summary}
          {badge}
        </span>
        <span className="text-xs text-[var(--c-text-tertiary)]">{open ? "▲" : "▼"}</span>
      </button>
      {open && <div className="border-t border-[var(--c-border-subtle)] px-3 py-3.5">{children}</div>}
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const stored = window.localStorage.getItem("pos.theme");
    const initial =
      stored === "dark" || stored === "light"
        ? stored
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    setTheme(initial as "light" | "dark");
    document.documentElement.dataset.theme = initial;
  }, []);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("pos.theme", next);
  };
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={flip}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
    >
      {theme === "dark" ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M13.2 10.3A5.6 5.6 0 0 1 5.7 2.8a5.6 5.6 0 1 0 7.5 7.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}
