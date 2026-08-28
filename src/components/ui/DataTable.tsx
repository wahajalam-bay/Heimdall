"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { classNames, toCsv } from "@/lib/format";

/**
 * Enterprise data grid.
 *
 * Rows arrive from the server already rendered (`cells`) plus raw `values` used
 * for sorting, filtering and export — so cells keep server-side formatting,
 * links and badges while interaction stays client-side.
 */

export type TableColumn = {
  key: string;
  header: string;
  align?: "left" | "right" | "center";
  sortable?: boolean;
  /** Hidden by default; user can enable from the column menu. */
  defaultHidden?: boolean;
  /** Excluded from the column menu (always visible). */
  locked?: boolean;
  width?: string;
  minWidth?: string;
  /** Renders a select filter populated from distinct values. */
  filterable?: boolean;
  /** Explicit filter options; otherwise derived from data. */
  filterOptions?: string[];
  numeric?: boolean;
  /** Excluded from CSV export. */
  noExport?: boolean;
};

export type TableRow = {
  id: string;
  href?: string;
  cells: Record<string, ReactNode>;
  values: Record<string, string | number | boolean | null>;
  /** Extra searchable text not shown in any column. */
  search?: string;
  /** Highlights the row — e.g. overdue or blocked. */
  flag?: "danger" | "warning" | "success" | "info" | null;
  disabled?: boolean;
};

export type BulkAction = {
  id: string;
  label: string;
  /** POSTed { ids } — the endpoint enforces permissions server-side. */
  endpoint: string;
  confirm?: string;
  tone?: "default" | "danger" | "success";
  /** Optional free-text reason prompt appended to the payload. */
  promptLabel?: string;
};

export type SavedViewRecord = { id: string; name: string; config: string; isShared: boolean };

type SortState = { key: string; dir: "asc" | "desc" } | null;

type ViewConfig = {
  q?: string;
  sort?: SortState;
  filters?: Record<string, string>;
  hidden?: string[];
  pageSize?: number;
  /**
   * Path and query the view was saved from. Analytics filters live in the query
   * string, so without this a saved view would restore the columns and lose the
   * entity and date range that made it worth saving.
   */
  url?: string;
};

const PAGE_SIZES = [25, 50, 100, 250];

/**
 * Prefix for a column filter carried in the address.
 *
 * Namespaced so a table filter can never collide with a parameter the page
 * itself reads — an entity, a date range, a tab.
 */
const URL_FILTER_PREFIX = "f_";

/** Separates the several values one filter is allowed to accept. */
const FILTER_OR = "|";

/** Reads the parts of a view the address is allowed to carry. */
function readUrlView(search: string): { q?: string; filters?: Record<string, string>; sort?: SortState } {
  const params = new URLSearchParams(search);
  const out: { q?: string; filters?: Record<string, string>; sort?: SortState } = {};

  const q = params.get("q");
  if (q !== null) out.q = q;

  const filters: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (key.startsWith(URL_FILTER_PREFIX) && value) filters[key.slice(URL_FILTER_PREFIX.length)] = value;
  }
  if (Object.keys(filters).length) out.filters = filters;

  const sort = params.get("sort");
  if (sort) {
    const [key, dir] = sort.split(":");
    if (key) out.sort = { key, dir: dir === "desc" ? "desc" : "asc" };
  }
  return out;
}

export function DataTable({
  id,
  columns,
  rows,
  emptyState,
  toolbarExtra,
  bulkActions,
  savedViews,
  defaultSort,
  defaultPageSize = 25,
  dense = false,
  exportName,
  stickyFirstColumn = false,
  footerSummary,
  className,
  maxHeight,
}: {
  id: string;
  columns: TableColumn[];
  rows: TableRow[];
  emptyState?: ReactNode;
  toolbarExtra?: ReactNode;
  bulkActions?: BulkAction[];
  savedViews?: SavedViewRecord[];
  defaultSort?: { key: string; dir: "asc" | "desc" };
  defaultPageSize?: number;
  dense?: boolean;
  exportName?: string;
  stickyFirstColumn?: boolean;
  footerSummary?: ReactNode;
  className?: string;
  maxHeight?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const storageKey = `pos.table.${id}`;

  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortState>(defaultSort ?? null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<string[]>(
    columns.filter((c) => c.defaultHidden).map((c) => c.key),
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [colMenu, setColMenu] = useState(false);
  const [viewMenu, setViewMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const deferredQ = useDeferredValue(q);
  const colMenuRef = useRef<HTMLDivElement>(null);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  /**
   * The last query string this component itself wrote.
   *
   * Following a tile link is a navigation within the same route, so React keeps
   * this component mounted and no mount effect fires. Without a record of what we
   * wrote, the sync effect below could not tell the difference between "the
   * address changed because we changed it" and "the address changed because
   * somebody navigated" — and it chose wrongly, erasing the very filter the link
   * had just asked for.
   */
  const writtenSearch = useRef<string | null>(null);

  // Restore view state: the address first, then whatever this browser last used.
  //
  // A link that names a filter was written by somebody who meant it — a tile on
  // the page above, or a colleague sharing what they were looking at — so it wins
  // over the local memory of the last visit. Without this, following a link into
  // "12 awaiting approval" landed on last week's filter instead.
  //
  // This runs again whenever the address changes, not only on mount: a tile links
  // within the same route, which React serves by keeping this component mounted.
  // Changes we made ourselves are recognised by `writtenSearch` and ignored.
  const search = searchParams.toString();
  useEffect(() => {
    if (writtenSearch.current === search) return;

    // Column choice and page size are workspace preferences rather than part of
    // what an address points at, so they always come from local state.
    let stored: ViewConfig | null = null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) stored = JSON.parse(raw) as ViewConfig;
    } catch {
      /* ignore corrupt local state */
    }
    if (stored?.hidden) setHidden(stored.hidden);
    if (stored?.pageSize) setPageSize(stored.pageSize);

    let url: ReturnType<typeof readUrlView> = {};
    try {
      url = readUrlView(search);
    } catch {
      /* a malformed address is not worth failing the table over */
    }
    const fromUrl = url.q !== undefined || Boolean(url.filters) || Boolean(url.sort);

    if (fromUrl) {
      setQ(url.q ?? "");
      setFilters(url.filters ?? {});
      setSort(url.sort ?? defaultSort ?? null);
    } else if (!hydrated) {
      // First arrival with a bare address: pick up where this browser left off.
      if (stored?.sort) setSort(stored.sort);
      if (stored?.filters) setFilters(stored.filters);
    } else {
      // The address was navigated back to its bare form — usually the reader
      // clicking the module in the navigation. That means "show me everything",
      // and leaving the previous filter applied would quietly contradict it.
      setQ("");
      setFilters({});
      setSort(defaultSort ?? null);
    }

    writtenSearch.current = search;
    setHydrated(true);
    // `hydrated` is read to tell first arrival from a later navigation, but must
    // not re-trigger this effect: it is set here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ sort, filters, hidden, pageSize } satisfies ViewConfig),
      );
    } catch {
      /* storage full or blocked — non-critical */
    }
  }, [hydrated, storageKey, sort, filters, hidden, pageSize]);

  // Keep the address describing what is on screen, so the back button, a reload
  // and a copied link all reproduce the same rows. history.replaceState rather
  // than the router: this filtering is entirely client-side, and a router push
  // would re-run the server component to render rows it already has.
  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const before = url.search;

    for (const key of [...url.searchParams.keys()]) {
      if (key === "q" || key === "sort" || key.startsWith(URL_FILTER_PREFIX)) url.searchParams.delete(key);
    }
    if (q.trim()) url.searchParams.set("q", q.trim());
    for (const [key, value] of Object.entries(filters)) {
      if (value && value !== "__all") url.searchParams.set(URL_FILTER_PREFIX + key, value);
    }
    if (sort && (sort.key !== defaultSort?.key || sort.dir !== defaultSort?.dir)) {
      url.searchParams.set("sort", `${sort.key}:${sort.dir}`);
    }

    if (url.search !== before) {
      writtenSearch.current = url.searchParams.toString();
      window.history.replaceState(null, "", url.toString());
    } else {
      writtenSearch.current = url.searchParams.toString();
    }
  }, [hydrated, q, filters, sort, defaultSort?.key, defaultSort?.dir]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (colMenuRef.current && !colMenuRef.current.contains(e.target as Node)) setColMenu(false);
      if (viewMenuRef.current && !viewMenuRef.current.contains(e.target as Node)) setViewMenu(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    setPage(1);
  }, [deferredQ, filters, pageSize]);

  const visibleColumns = useMemo(
    () => columns.filter((c) => !hidden.includes(c.key) || c.locked),
    [columns, hidden],
  );

  const filterableColumns = useMemo(() => columns.filter((c) => c.filterable), [columns]);

  const filterOptionsByKey = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const col of filterableColumns) {
      if (col.filterOptions) {
        map[col.key] = col.filterOptions;
        continue;
      }
      const set = new Set<string>();
      for (const r of rows) {
        const v = r.values[col.key];
        if (v !== null && v !== undefined && v !== "") set.add(String(v));
      }
      map[col.key] = [...set].sort((a, b) => a.localeCompare(b));
    }
    return map;
  }, [filterableColumns, rows]);

  const filtered = useMemo(() => {
    const needle = deferredQ.trim().toLowerCase();
    // A filter may name several values, separated by a pipe. That is how a tile
    // reading "Awaiting approval" links to the rows behind it: the count spans
    // more than one status, and a single-value filter could not express it.
    const activeFilters = Object.entries(filters)
      .filter(([, v]) => v !== "" && v !== "__all")
      .map(([k, v]) => [k, new Set(v.split(FILTER_OR))] as const);
    return rows.filter((r) => {
      for (const [k, allowed] of activeFilters) {
        if (!allowed.has(String(r.values[k] ?? ""))) return false;
      }
      if (!needle) return true;
      if (r.search && r.search.toLowerCase().includes(needle)) return true;
      for (const v of Object.values(r.values)) {
        if (v !== null && v !== undefined && String(v).toLowerCase().includes(needle)) return true;
      }
      return false;
    });
  }, [rows, deferredQ, filters]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const { key, dir } = sort;
    const mul = dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a.values[key];
      const bv = b.values[key];
      if (av === bv) return 0;
      if (av === null || av === undefined || av === "") return 1;
      if (bv === null || bv === undefined || bv === "") return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * mul;
      if (typeof av === "boolean" && typeof bv === "boolean") return (Number(av) - Number(bv)) * mul;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * mul;
    });
  }, [filtered, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => sorted.slice((safePage - 1) * pageSize, safePage * pageSize),
    [sorted, safePage, pageSize],
  );

  const toggleSort = useCallback((key: string) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }, []);

  const allPageSelected = pageRows.length > 0 && pageRows.every((r) => selected.has(r.id));
  const selectable = Boolean(bulkActions?.length);

  const togglePageSelection = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageRows.forEach((r) => next.delete(r.id));
      else pageRows.forEach((r) => !r.disabled && next.add(r.id));
      return next;
    });
  };

  const exportCsv = (onlySelected: boolean) => {
    const source = onlySelected ? sorted.filter((r) => selected.has(r.id)) : sorted;
    const cols = visibleColumns.filter((c) => !c.noExport);
    const data = source.map((r) => {
      const o: Record<string, unknown> = {};
      for (const c of cols) o[c.header] = r.values[c.key] ?? "";
      return o;
    });
    const csv = toCsv(data, cols.map((c) => c.header));
    const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportName ?? id}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const runBulk = async (action: BulkAction) => {
    const ids = [...selected];
    if (!ids.length) return;
    if (action.confirm && !window.confirm(action.confirm.replace("{n}", String(ids.length)))) return;
    let reason: string | null = null;
    if (action.promptLabel) {
      reason = window.prompt(action.promptLabel) ?? null;
      if (reason === null) return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(action.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, reason }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok || json.ok === false) {
        setNotice({ tone: "err", text: json.error ?? `Request failed (${res.status}).` });
      } else {
        setNotice({ tone: "ok", text: json.message ?? `${ids.length} record(s) updated.` });
        setSelected(new Set());
        router.refresh();
      }
    } catch (e) {
      setNotice({ tone: "err", text: e instanceof Error ? e.message : "Network error." });
    } finally {
      setBusy(false);
    }
  };

  const applyView = (cfgRaw: string) => {
    try {
      const cfg = JSON.parse(cfgRaw) as ViewConfig;
      setQ(cfg.q ?? "");
      setSort(cfg.sort ?? null);
      setFilters(cfg.filters ?? {});
      setHidden(cfg.hidden ?? []);
      if (cfg.pageSize) setPageSize(cfg.pageSize);
      setViewMenu(false);
      // Restore the address too, so filters held in the query string come back
      // with the view rather than silently reverting to the current page's.
      if (cfg.url && typeof window !== "undefined") {
        const here = `${window.location.pathname}${window.location.search}`;
        if (cfg.url !== here) router.push(cfg.url);
      }
    } catch {
      setNotice({ tone: "err", text: "This saved view could not be applied." });
    }
  };

  /**
   * Copies a link that reproduces this view for somebody else.
   *
   * The address is already kept in step with the search, filters and sort, so
   * there is nothing to assemble here — what is on screen is what the link says.
   */
  const copyLink = async () => {
    if (typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(window.location.href);
      setNotice({ tone: "ok", text: "Link copied. It reproduces this filter set." });
    } catch {
      setNotice({ tone: "err", text: "The browser would not give access to the clipboard." });
    }
  };

  const saveView = async () => {
    const name = window.prompt("Name this view");
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/saved-views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: id,
          name: name.trim(),
          config: JSON.stringify({
            q,
            sort,
            filters,
            hidden,
            pageSize,
            url: `${window.location.pathname}${window.location.search}`,
          } satisfies ViewConfig),
        }),
      });
      if (res.ok) {
        setNotice({ tone: "ok", text: `View "${name.trim()}" saved.` });
        router.refresh();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice({ tone: "err", text: j.error ?? "Could not save view." });
      }
    } finally {
      setBusy(false);
      setViewMenu(false);
    }
  };

  const deleteView = async (viewId: string) => {
    if (!window.confirm("Delete this saved view?")) return;
    setBusy(true);
    try {
      await fetch(`/api/saved-views?id=${encodeURIComponent(viewId)}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const activeFilterCount =
    Object.values(filters).filter((v) => v && v !== "__all").length + (q.trim() ? 1 : 0);

  const clearAll = () => {
    setQ("");
    setFilters({});
    setSort(defaultSort ?? null);
  };

  const cellPad = dense ? "px-2.5 py-1.5" : "px-3 py-2";

  return (
    <div className={classNames("card overflow-hidden", className)}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <div className="relative min-w-[11rem] flex-1 sm:max-w-xs">
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
            className="field pl-8"
            style={{ paddingLeft: "1.9rem" }}
            placeholder="Search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search table"
          />
        </div>

        {filterableColumns.map((col) => {
          const current = filters[col.key] ?? "__all";
          const parts = current === "__all" ? [] : current.split(FILTER_OR);
          // A link may have asked for several values at once. The select cannot
          // show that, so the combination is named as its own option and stays
          // selected until the reader picks something else or clears it.
          const combined = parts.length > 1;
          return (
            <select
              key={col.key}
              className="field w-auto min-w-[8rem] max-w-[12rem]"
              value={current}
              onChange={(e) => setFilters((f) => ({ ...f, [col.key]: e.target.value }))}
              aria-label={`Filter by ${col.header}`}
            >
              <option value="__all">All {col.header.toLowerCase()}</option>
              {combined && <option value={current}>{parts.length} selected</option>}
              {(filterOptionsByKey[col.key] ?? []).map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          );
        })}

        {activeFilterCount > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={clearAll}>
            Clear ({activeFilterCount})
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          {toolbarExtra}

          <div className="relative" ref={viewMenuRef}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setViewMenu((v) => !v)}
              aria-expanded={viewMenu}
            >
              Views
            </button>
            {viewMenu && (
              <div className="absolute right-0 z-30 mt-1 w-60 overlay-panel py-1">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--c-surface-hover)]"
                  onClick={saveView}
                  disabled={busy}
                >
                  + Save current view
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--c-surface-hover)]"
                  onClick={() => {
                    void copyLink();
                    setViewMenu(false);
                  }}
                >
                  Copy link to this view
                </button>
                {savedViews && savedViews.length > 0 && (
                  <>
                    <div className="my-1 border-t border-separator" />
                    {savedViews.map((v) => (
                      <div
                        key={v.id}
                        className="flex items-center justify-between gap-1 px-1 hover:bg-[var(--c-surface-hover)]"
                      >
                        <button
                          type="button"
                          className="flex-1 truncate px-2 py-1.5 text-left text-xs"
                          onClick={() => applyView(v.config)}
                        >
                          {v.name}
                          {v.isShared && (
                            <span className="ml-1 text-2xs text-[var(--c-text-tertiary)]">shared</span>
                          )}
                        </button>
                        <button
                          type="button"
                          className="px-2 py-1.5 text-2xs text-[var(--c-text-tertiary)] hover:text-[var(--c-danger)]"
                          onClick={() => deleteView(v.id)}
                          aria-label={`Delete view ${v.name}`}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>

          <div className="relative" ref={colMenuRef}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setColMenu((v) => !v)}
              aria-expanded={colMenu}
            >
              Columns
            </button>
            {colMenu && (
              <div className="absolute right-0 z-30 mt-1 max-h-72 w-56 overflow-y-auto rounded-xl border border-border bg-overlay p-1 shadow-overlay">
                {columns
                  .filter((c) => !c.locked)
                  .map((c) => (
                    <label
                      key={c.key}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-[var(--c-surface-hover)]"
                    >
                      <input
                        type="checkbox"
                        checked={!hidden.includes(c.key)}
                        onChange={(e) =>
                          setHidden((h) =>
                            e.target.checked ? h.filter((k) => k !== c.key) : [...h, c.key],
                          )
                        }
                      />
                      {c.header}
                    </label>
                  ))}
              </div>
            )}
          </div>

          <button type="button" className="btn btn-secondary btn-sm" onClick={() => exportCsv(false)}>
            Export
          </button>
        </div>
      </div>

      {/* Bulk bar */}
      {selectable && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--c-accent-soft-border)] bg-[var(--c-accent-soft)] px-3 py-2">
          <span className="text-xs font-500 text-[var(--c-accent-text)]">
            {selected.size} selected
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <button type="button" className="btn btn-secondary btn-xs" onClick={() => exportCsv(true)}>
              Export selected
            </button>
            {bulkActions?.map((a) => (
              <button
                key={a.id}
                type="button"
                className={classNames(
                  "btn btn-xs",
                  a.tone === "danger"
                    ? "btn-danger-soft"
                    : a.tone === "success"
                      ? "btn-success"
                      : "btn-secondary",
                )}
                disabled={busy}
                onClick={() => runBulk(a)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {notice && (
        <div
          className={classNames(
            "border-b px-3 py-2 text-xs",
            notice.tone === "ok"
              ? "border-[var(--c-success-border)] bg-[var(--c-success-soft)] text-[var(--c-success)]"
              : "border-[var(--c-danger-border)] bg-[var(--c-danger-soft)] text-[var(--c-danger)]",
          )}
          role="status"
        >
          {notice.text}
        </div>
      )}

      {/* Grid */}
      {sorted.length === 0 ? (
        rows.length === 0 ? (
          (emptyState ?? (
            <div className="px-4 py-12 text-center text-xs text-muted">
              No records yet.
            </div>
          ))
        ) : (
          <div className="px-4 py-12 text-center">
            <p className="text-[0.8125rem] font-600">No results</p>
            <p className="mt-1 text-xs text-muted">
              No rows match your search or filters.
            </p>
            <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={clearAll}>
              Reset filters
            </button>
          </div>
        )
      ) : (
        <div className="table-wrap" style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>
          <table className="dt">
            <thead>
              <tr>
                {selectable && (
                  <th style={{ width: "2.75rem" }} className="!px-2">
                    <label className="-m-1 flex min-h-6 cursor-[var(--cursor-interactive)] items-center justify-center p-1">
                      <input
                        type="checkbox"
                        checked={allPageSelected}
                        onChange={togglePageSelection}
                        aria-label="Select all rows on this page"
                      />
                    </label>
                  </th>
                )}
                {visibleColumns.map((c, ci) => {
                  const active = sort?.key === c.key;
                  return (
                    <th
                      key={c.key}
                      style={{ width: c.width, minWidth: c.minWidth }}
                      className={classNames(
                        c.align === "right" && "text-right",
                        c.align === "center" && "text-center",
                        stickyFirstColumn && ci === 0 && "sticky left-0 z-3",
                      )}
                    >
                      {c.sortable === false ? (
                        c.header
                      ) : (
                        <button
                          type="button"
                          onClick={() => toggleSort(c.key)}
                          className={classNames(
                            "-my-1 inline-flex min-h-6 items-center gap-1 py-1 uppercase tracking-[0.04em] hover:text-[var(--c-text)]",
                            active && "text-[var(--c-text)]",
                          )}
                        >
                          {c.header}
                          <span className="text-[0.5rem] leading-none opacity-70">
                            {active ? (sort?.dir === "asc" ? "▲" : "▼") : "⇅"}
                          </span>
                        </button>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr
                  key={r.id}
                  data-clickable={r.href ? "true" : undefined}
                  onClick={(e) => {
                    if (!r.href) return;
                    const t = e.target as HTMLElement;
                    if (t.closest("a,button,input,select,label")) return;
                    router.push(r.href!);
                  }}
                  style={
                    r.flag
                      ? { boxShadow: `inset 2px 0 0 0 var(--c-${r.flag === "info" ? "info" : r.flag})` }
                      : undefined
                  }
                >
                  {selectable && (
                    <td className="!px-2">
                      <label className="-m-1 flex min-h-6 cursor-[var(--cursor-interactive)] items-center justify-center p-1">
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          disabled={r.disabled}
                          onChange={(e) =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(r.id);
                              else next.delete(r.id);
                              return next;
                            })
                          }
                          aria-label={`Select row ${r.id}`}
                        />
                      </label>
                    </td>
                  )}
                  {visibleColumns.map((c, ci) => (
                    <td
                      key={c.key}
                      className={classNames(
                        cellPad,
                        // A column that declared a minimum width is there to hold
                        // prose, so it is the one allowed to wrap.
                        c.minWidth && "wrap",
                        (c.align === "right" || c.numeric) && "num",
                        c.align === "center" && "text-center",
                        stickyFirstColumn && ci === 0 && "sticky left-0 z-1 bg-[var(--c-surface)]",
                      )}
                    >
                      {r.cells[c.key] ?? <span className="text-[var(--c-text-tertiary)]">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {footerSummary && (
              <tfoot>
                <tr>
                  <td colSpan={visibleColumns.length + (selectable ? 1 : 0)}>{footerSummary}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* Pagination */}
      {sorted.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3 py-2">
          <div className="text-xs text-muted">
            <span className="tnum font-500 text-[var(--c-text)]">
              {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, sorted.length)}
            </span>{" "}
            of <span className="tnum font-500 text-[var(--c-text)]">{sorted.length}</span>
            {sorted.length !== rows.length && (
              <span className="text-[var(--c-text-tertiary)]"> (filtered from {rows.length})</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <select
              className="field w-auto py-1 text-xs"
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              aria-label="Rows per page"
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s} / page
                </option>
              ))}
            </select>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                disabled={safePage <= 1}
                onClick={() => setPage(1)}
              >
                ««
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </button>
              <span className="tnum px-1.5 text-xs text-muted">
                {safePage} / {totalPages}
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                disabled={safePage >= totalPages}
                onClick={() => setPage(totalPages)}
              >
                »»
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
