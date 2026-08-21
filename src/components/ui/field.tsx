import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

/** Presentational form scaffolding — no client JS required. */

export function FormSection({
  title,
  description,
  children,
  columns = 2,
  className,
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  columns?: 1 | 2 | 3 | 4;
  className?: string;
}) {
  const grid =
    columns === 1
      ? "grid-cols-1"
      : columns === 2
        ? "sm:grid-cols-2"
        : columns === 3
          ? "sm:grid-cols-2 lg:grid-cols-3"
          : "sm:grid-cols-2 lg:grid-cols-4";
  return (
    <section className={classNames("space-y-3", className)}>
      {(title || description) && (
        <div className="border-b border-[var(--c-border-subtle)] pb-2">
          {title && <h3 className="text-[0.8125rem] font-600">{title}</h3>}
          {description && (
            <p className="mt-0.5 text-xs leading-5 text-[var(--c-text-secondary)]">{description}</p>
          )}
        </div>
      )}
      <div className={classNames("grid gap-x-4 gap-y-3.5", grid)}>{children}</div>
    </section>
  );
}

export function Field({
  label,
  name,
  children,
  hint,
  error,
  required,
  span,
  className,
}: {
  label: string;
  name?: string;
  children: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  span?: boolean | "full";
  className?: string;
}) {
  return (
    <div className={classNames("min-w-0", span && "sm:col-span-full", className)}>
      <label
        htmlFor={name}
        className="mb-1 flex items-baseline gap-1 text-xs font-500 text-[var(--c-text-secondary)]"
      >
        {label}
        {required && (
          <span className="text-[var(--c-danger)]" aria-hidden title="Required">
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p className="mt-1 flex items-center gap-1 text-2xs text-[var(--c-danger)]">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
            <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 5.25v3.25M8 10.6h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-2xs leading-4 text-[var(--c-text-tertiary)]">{hint}</p>
      ) : null}
    </div>
  );
}

export function TextInput(
  props: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean },
) {
  const { invalid, className, ...rest } = props;
  return <input {...rest} id={rest.id ?? rest.name} className={classNames("field", className)} aria-invalid={invalid || undefined} />;
}

export function TextArea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean },
) {
  const { invalid, className, ...rest } = props;
  return (
    <textarea
      {...rest}
      id={rest.id ?? rest.name}
      className={classNames("field", className)}
      aria-invalid={invalid || undefined}
    />
  );
}

export function Select({
  options,
  placeholder,
  className,
  invalid,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  placeholder?: string;
  invalid?: boolean;
}) {
  return (
    <select
      {...rest}
      id={rest.id ?? rest.name}
      className={classNames("field", className)}
      aria-invalid={invalid || undefined}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({
  label,
  hint,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input type="checkbox" {...rest} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-[0.8125rem] leading-5">{label}</span>
        {hint && <span className="block text-2xs leading-4 text-[var(--c-text-tertiary)]">{hint}</span>}
      </span>
    </label>
  );
}

export function RadioGroup({
  name,
  options,
  defaultValue,
  columns = 1,
}: {
  name: string;
  options: Array<{ value: string; label: string; hint?: string }>;
  defaultValue?: string;
  columns?: 1 | 2 | 3;
}) {
  return (
    <div
      className={classNames(
        "grid gap-2",
        columns === 2 ? "sm:grid-cols-2" : columns === 3 ? "sm:grid-cols-3" : "grid-cols-1",
      )}
      role="radiogroup"
    >
      {options.map((o) => (
        <label
          key={o.value}
          className="flex cursor-pointer items-start gap-2 rounded-[var(--radius-sm)] border border-[var(--c-border)] px-2.5 py-2 transition-colors hover:border-[var(--c-border-strong)] has-checked:border-[var(--c-accent)] has-checked:bg-[var(--c-accent-soft)]"
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            defaultChecked={defaultValue === o.value}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block text-[0.8125rem] font-500 leading-5">{o.label}</span>
            {o.hint && <span className="block text-2xs leading-4 text-[var(--c-text-tertiary)]">{o.hint}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

export function FormActions({ children, sticky }: { children: ReactNode; sticky?: boolean }) {
  return (
    <div
      className={classNames(
        "flex flex-wrap items-center justify-end gap-2 border-t border-[var(--c-border)] px-4 py-3",
        sticky && "sticky bottom-0 z-10 bg-[var(--c-surface)]",
      )}
    >
      {children}
    </div>
  );
}
