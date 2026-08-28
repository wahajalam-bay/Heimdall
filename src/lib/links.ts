import { humanize } from "@/lib/domain";

/**
 * Addresses that put a table into the state a figure describes.
 *
 * A tile reading "7 awaiting approval" is a claim about seven rows in the table
 * underneath it. Until the tile carried a link, the reader had to translate that
 * claim back into the filter controls themselves — and translate it wrongly,
 * because "awaiting approval" spans two statuses and the control takes one.
 *
 * These build the address `DataTable` reads on arrival: `f_<column>` names a
 * column, and several values for one column are separated by a pipe.
 */

/** Matches `DataTable`'s reserved prefix and separator. */
const FILTER_PREFIX = "f_";
const FILTER_OR = "|";

export type TableFilter = Record<string, string | string[] | null | undefined>;

/**
 * Builds a link to `path` with the table filters applied.
 *
 * `filters` are keyed by column, and a column's value must equal what the row
 * put in `values` for that column — usually `humanize(status)`. Empty values are
 * dropped rather than encoded, so a conditional filter needs no ceremony at the
 * call site.
 */
export function tableLink(path: string, filters?: TableFilter, extra?: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }

  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value === null || value === undefined) continue;
    const values = (Array.isArray(value) ? value : [value]).filter((v) => v !== "");
    if (!values.length) continue;
    params.set(FILTER_PREFIX + key, values.join(FILTER_OR));
  }

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * A link filtering one column to a set of enum values.
 *
 * The table stores humanised labels, so the enum names are humanised here and
 * the caller keeps naming statuses the way the rest of the code does rather than
 * repeating display strings that would silently drift.
 */
export function statusLink(path: string, column: string, statuses: readonly string[]): string {
  return tableLink(path, { [column]: statuses.map((s) => humanize(s)) });
}

/** A link that runs the table's free-text search — for anything no column filters. */
export function searchLink(path: string, query: string): string {
  return tableLink(path, undefined, { q: query });
}
