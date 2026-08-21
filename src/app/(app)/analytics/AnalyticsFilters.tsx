"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { Select, TextInput } from "@/components/ui/field";

export type FilterOption = { value: string; label: string };

/**
 * Shared filter row. Filters live in the query string so a filtered view is
 * shareable and bookmarkable, and every page reads the same parameters.
 */
export function AnalyticsFilters({
  entities,
  departments,
  categories,
  vendors,
  projects,
  show = ["entity", "department", "category", "vendor", "from", "to"],
}: {
  entities?: FilterOption[];
  departments?: FilterOption[];
  categories?: FilterOption[];
  vendors?: FilterOption[];
  projects?: FilterOption[];
  show?: Array<"entity" | "department" | "category" | "vendor" | "project" | "from" | "to">;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const set = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      router.push(`?${next.toString()}`);
    },
    [params, router],
  );

  const clear = () => router.push("?");
  const active = ["entity", "department", "category", "vendor", "project", "from", "to"].filter((k) => params.get(k));

  return (
    <div className="card flex flex-wrap items-end gap-3 px-3.5 py-3">
      {show.includes("entity") && entities && (
        <label className="min-w-[10rem] flex-1">
          <span className="label mb-1 block">Entity</span>
          <Select
            options={entities}
            placeholder="All entities"
            value={params.get("entity") ?? ""}
            onChange={(e) => set("entity", e.target.value)}
          />
        </label>
      )}
      {show.includes("department") && departments && (
        <label className="min-w-[10rem] flex-1">
          <span className="label mb-1 block">Department</span>
          <Select
            options={departments}
            placeholder="All departments"
            value={params.get("department") ?? ""}
            onChange={(e) => set("department", e.target.value)}
          />
        </label>
      )}
      {show.includes("category") && categories && (
        <label className="min-w-[10rem] flex-1">
          <span className="label mb-1 block">Category</span>
          <Select
            options={categories}
            placeholder="All categories"
            value={params.get("category") ?? ""}
            onChange={(e) => set("category", e.target.value)}
          />
        </label>
      )}
      {show.includes("vendor") && vendors && (
        <label className="min-w-[10rem] flex-1">
          <span className="label mb-1 block">Vendor</span>
          <Select
            options={vendors}
            placeholder="All vendors"
            value={params.get("vendor") ?? ""}
            onChange={(e) => set("vendor", e.target.value)}
          />
        </label>
      )}
      {show.includes("project") && projects && (
        <label className="min-w-[10rem] flex-1">
          <span className="label mb-1 block">Project</span>
          <Select
            options={projects}
            placeholder="All projects"
            value={params.get("project") ?? ""}
            onChange={(e) => set("project", e.target.value)}
          />
        </label>
      )}
      {show.includes("from") && (
        <label className="min-w-[9rem]">
          <span className="label mb-1 block">From</span>
          <TextInput type="date" value={params.get("from") ?? ""} onChange={(e) => set("from", e.target.value)} />
        </label>
      )}
      {show.includes("to") && (
        <label className="min-w-[9rem]">
          <span className="label mb-1 block">To</span>
          <TextInput type="date" value={params.get("to") ?? ""} onChange={(e) => set("to", e.target.value)} />
        </label>
      )}
      {active.length > 0 && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={clear}>
          Clear {active.length} filter{active.length === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}
