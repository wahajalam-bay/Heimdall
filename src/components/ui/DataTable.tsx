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
import { useRouter } from "next/navigation";
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

  // Restore last-used local view state.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const cfg = JSON.parse(raw) as ViewConfig;
        if (cfg.sort) setSort(cfg.sort);
        if (cfg.filters) setFilters(cfg.filters);
        if (cfg.hidden) setHidden(cfg.hidden);
        if (cfg.pageSize) setPageSize(cfg.pageSize);
      }
    } catch {
      /* ignore corrupt local state */
    }
    setHydrated(true);
  }, [storageKey]);

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
    const activeFilters = Object.entries(filters).filter(([, v]) => v !== "" && v !== "__all");
    return rows.filter((r) => {
      for (const [k, v] of activeFilters) {
        if (String(r.values[k] ?? "") !== v) return false;
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

  /** Copies a link that reproduces this view for somebody else. */
  const copyLink = async () => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (q.trim()) url.searchParams.set("q", q.trim());
    else url.searchParams.delete("q");
    try {
      await navigator.clipboard.writeText(url.toString());
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

        {filterableColumns.map((col) => (
          <select
            key={col.key}
            className="field w-auto min-w-[8rem] max-w-[12rem]"
            value={filters[col.key] ?? "__all"}
            onChange={(e) => setFilters((f) => ({ ...f, [col.key]: e.target.value }))}
            aria-label={`Filter by ${col.header}`}
          >
            <option value="__all">All {col.header.toLowerCase()}</option>
            {(filterOptionsByKey[col.key] ?? []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        ))}

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
                  <th style={{ width: "2.25rem" }} className="!px-3">
                    <input
                      type="checkbox"
                      checked={allPageSelected}
                      onChange={togglePageSelection}
                      aria-label="Select all rows on this page"
                    />
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
                            "inline-flex items-center gap-1 uppercase tracking-[0.04em] hover:text-[var(--c-text)]",
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
                    <td className="!px-3">
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
