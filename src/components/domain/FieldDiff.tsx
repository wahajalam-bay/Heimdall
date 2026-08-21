import type { ReactNode } from "react";
import { humanize } from "@/lib/domain";
import { fmtDateTime, money } from "@/lib/format";

/**
 * Field-level before and after.
 *
 * The audit trail already records `{field: {from, to}}` for every change; this is
 * what makes it usable when somebody disputes a figure. Values are rendered by
 * what they are — a date as a date, an amount as an amount, an object as its
 * own small list — because "[object Object]" in a dispute is worse than useless.
 */

const MONEY_HINTS = /(amount|total|price|cost|value|payable|budget|saving|charges|discount|tax)/i;
const DATE_HINTS = /(date|at$|_at|deadline|expiry)/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One value, formatted for what the field appears to hold. */
export function DiffValue({ field, value }: { field: string; value: unknown }): ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span className="text-[var(--c-text-tertiary)]">empty</span>;
  }
  if (typeof value === "boolean") {
    return <span className="mono">{value ? "yes" : "no"}</span>;
  }
  if (typeof value === "number") {
    return <span className="mono tnum">{MONEY_HINTS.test(field) ? money(value) : String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-[var(--c-text-tertiary)]">none</span>;
    return (
      <ul className="space-y-0.5">
        {value.map((v, i) => (
          <li key={i} className="text-2xs">
            {isRecord(v) ? (
              <span className="mono">{JSON.stringify(v)}</span>
            ) : (
              <span>{String(v)}</span>
            )}
          </li>
        ))}
      </ul>
    );
  }
  if (isRecord(value)) {
    return (
      <dl className="space-y-0.5">
        {Object.entries(value).map(([k, v]) => (
          <div key={k} className="flex gap-1.5 text-2xs">
            <dt className="text-[var(--c-text-tertiary)]">{humanize(k)}</dt>
            <dd className="mono">{v === null ? "empty" : String(v)}</dd>
          </div>
        ))}
      </dl>
    );
  }

  const str = String(value);
  if (DATE_HINTS.test(field) && !Number.isNaN(Date.parse(str)) && /\d{4}-\d{2}-\d{2}/.test(str)) {
    return <span className="text-xs">{fmtDateTime(new Date(str))}</span>;
  }
  // Status-like values are upper snake case in the data and read better humanised.
  if (/^[A-Z][A-Z_]{2,}$/.test(str)) return <span className="text-xs">{humanize(str)}</span>;
  return <span className="text-xs">{str}</span>;
}

export type ChangeSet = Record<string, { from: unknown; to: unknown }> | null | undefined;

/** Counts the fields that actually moved, for a summary badge. */
export function changedFieldCount(changes: ChangeSet) {
  if (!changes) return 0;
  return Object.entries(changes).filter(([, v]) => JSON.stringify(v.from) !== JSON.stringify(v.to)).length;
}

export function FieldDiff({ changes, emptyLabel }: { changes: ChangeSet; emptyLabel?: string }) {
  const entries = Object.entries(changes ?? {});
  if (!entries.length) {
    return (
      <p className="px-4 py-6 text-center text-xs text-[var(--c-text-secondary)]">
        {emptyLabel ?? "This event recorded no field-level changes."}
      </p>
    );
  }

  return (
    <div className="table-wrap">
      <table className="dt">
        <thead>
          <tr>
            <th style={{ width: "16rem" }}>Field</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([field, { from, to }]) => {
            const moved = JSON.stringify(from) !== JSON.stringify(to);
            return (
              <tr key={field}>
                <td className="align-top">
                  <span className="text-xs font-500">{humanize(field)}</span>
                  <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{field}</span>
                </td>
                <td className="align-top">
                  <span
                    className={
                      moved
                        ? "block rounded-[var(--radius-xs)] bg-[var(--c-danger-soft)] px-1.5 py-1 line-through decoration-[var(--c-danger)]/40"
                        : "block px-1.5 py-1"
                    }
                  >
                    <DiffValue field={field} value={from} />
                  </span>
                </td>
                <td className="align-top">
                  <span
                    className={
                      moved
                        ? "block rounded-[var(--radius-xs)] bg-[var(--c-success-soft)] px-1.5 py-1"
                        : "block px-1.5 py-1 text-[var(--c-text-tertiary)]"
                    }
                  >
                    <DiffValue field={field} value={to} />
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
