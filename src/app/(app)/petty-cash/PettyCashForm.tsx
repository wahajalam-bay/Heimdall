"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { DISPOSITIONS, STORE_ENTRY_DISPOSITIONS, humanize } from "@/lib/domain";
import { money, round2 } from "@/lib/format";
import { createPettyCashAction } from "./actions";

type Line = {
  key: string;
  itemId: string;
  description: string;
  quantity: string;
  unit: string;
  estimatedUnitPrice: string;
  disposition: string;
};

let seq = 0;
const newLine = (): Line => ({
  key: `pcl-${++seq}`,
  itemId: "",
  description: "",
  quantity: "1",
  unit: "EA",
  estimatedUnitPrice: "",
  disposition: "EXPENSE",
});

export function PettyCashForm({
  entities,
  departments,
  stores,
  items,
  limits,
  defaultEntityId,
  minQuotes,
}: {
  entities: Array<{ id: string; code: string; name: string }>;
  departments: Array<{ id: string; name: string; entityId: string }>;
  stores: Array<{ id: string; code: string; name: string; kind: string; entityId: string }>;
  items: Array<{ id: string; sku: string; name: string; unit: string }>;
  /** Configured petty cash ceiling per entity — nothing is hard-coded. */
  limits: Record<string, number>;
  defaultEntityId: string;
  minQuotes: number;
}) {
  const [entityId, setEntityId] = useState(defaultEntityId);
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [submit, setSubmit] = useState(true);

  const patch = (k: string, changes: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.key === k ? { ...l, ...changes } : l)));

  const estimate = useMemo(
    () =>
      round2(
        lines.reduce((a, l) => a + (Number(l.quantity) || 0) * (Number(l.estimatedUnitPrice) || 0), 0),
      ),
    [lines],
  );
  const limit = limits[entityId] ?? 0;
  const overLimit = limit > 0 && estimate > limit;
  const needsStore = lines.some((l) => STORE_ENTRY_DISPOSITIONS.includes(l.disposition as never));

  const entityStores = stores.filter((s) => s.entityId === entityId);
  const entityDepartments = departments.filter((d) => d.entityId === entityId);

  const payload = JSON.stringify(
    lines
      .filter((l) => l.description.trim() && Number(l.quantity) > 0)
      .map((l) => ({
        itemId: l.itemId || null,
        description: l.description.trim(),
        quantity: Number(l.quantity),
        unit: l.unit || "EA",
        estimatedUnitPrice: l.estimatedUnitPrice === "" ? null : Number(l.estimatedUnitPrice),
        disposition: l.disposition,
      })),
  );

  return (
    <ActionForm
      action={createPettyCashAction}
      submitLabel={submit ? "Submit for evaluation" : "Save draft"}
      hiddenFields={{ items: payload, submit: submit ? "true" : "" }}
      draftKey="petty-cash-new"
      onSuccessRedirect={(data) => {
        const d = data as { id?: string } | null;
        return d?.id ? `/petty-cash/${d.id}` : "/petty-cash";
      }}
      footerSticky
      secondary={
        <>
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} />
            Submit immediately
          </label>
          <Link href="/petty-cash" className="btn btn-secondary">
            Cancel
          </Link>
        </>
      }
    >
      <InlineAlert tone="info">
        Petty cash is for small, urgent purchases below the configured ceiling. {minQuotes} market quotation
        {minQuotes === 1 ? "" : "s"} must be recorded before approval, and anything that ends up in a store cannot be
        closed until the store entry is posted.
      </InlineAlert>

      <FormSection title="Request" columns={3}>
        <Field label="Entity" name="entityId" required>
          <Select
            name="entityId"
            options={entities.map((e) => ({ value: e.id, label: `${e.code} — ${e.name}` }))}
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
          />
        </Field>
        <Field label="Department" name="departmentId" required>
          <Select
            name="departmentId"
            placeholder="Select department…"
            options={entityDepartments.map((d) => ({ value: d.id, label: d.name }))}
          />
        </Field>
        <Field label="Required by" name="requiredDate" hint="When the item is actually needed.">
          <TextInput type="date" name="requiredDate" />
        </Field>
        <Field label="Purpose" name="purpose" required span hint="What is being bought and why cash is appropriate.">
          <TextArea
            name="purpose"
            rows={2}
            placeholder="e.g. Two 5kg fire extinguisher refills for the Gulberg office — annual inspection is on Friday."
          />
        </Field>
        <Field label="Justification" name="justification" span hint="Why this cannot wait for a normal purchase order.">
          <TextArea name="justification" rows={2} />
        </Field>
        <Field
          label="Receiving store"
          name="storeId"
          hint={
            needsStore
              ? "Required — at least one line will end up in inventory."
              : "Only needed if any purchased item is stored rather than consumed."
          }
          required={needsStore}
        >
          <Select
            name="storeId"
            placeholder={needsStore ? "Select the store…" : "Not stored"}
            options={entityStores.map((s) => ({ value: s.id, label: `${s.name} · ${humanize(s.kind)}` }))}
          />
        </Field>
      </FormSection>

      <FormSection title="Items" columns={1}>
        <div className="space-y-2.5 sm:col-span-full">
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ minWidth: "18rem" }}>Description</th>
                  <th style={{ width: "13rem" }}>Catalogue item</th>
                  <th className="text-right" style={{ width: "6.5rem" }}>Qty</th>
                  <th style={{ width: "6rem" }}>Unit</th>
                  <th className="text-right" style={{ width: "9rem" }}>Est. unit price</th>
                  <th style={{ width: "11rem" }}>Disposition</th>
                  <th className="text-right" style={{ width: "9rem" }}>Line total</th>
                  <th style={{ width: "4rem" }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const lineTotal = round2((Number(l.quantity) || 0) * (Number(l.estimatedUnitPrice) || 0));
                  return (
                    <tr key={l.key}>
                      <td>
                        <input
                          className="field"
                          value={l.description}
                          onChange={(e) => patch(l.key, { description: e.target.value })}
                          placeholder="What exactly is being bought"
                          aria-label="Description"
                        />
                      </td>
                      <td>
                        <select
                          className="field"
                          value={l.itemId}
                          onChange={(e) => {
                            const it = items.find((x) => x.id === e.target.value);
                            patch(l.key, {
                              itemId: e.target.value,
                              unit: it?.unit ?? l.unit,
                              description: l.description || (it?.name ?? ""),
                            });
                          }}
                          aria-label="Catalogue item"
                        >
                          <option value="">Not catalogued</option>
                          {items.map((it) => (
                            <option key={it.id} value={it.id}>
                              {it.sku} — {it.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          className="field text-right"
                          type="number"
                          step="any"
                          min="0"
                          value={l.quantity}
                          onChange={(e) => patch(l.key, { quantity: e.target.value })}
                          aria-label="Quantity"
                        />
                      </td>
                      <td>
                        <input
                          className="field"
                          value={l.unit}
                          onChange={(e) => patch(l.key, { unit: e.target.value })}
                          aria-label="Unit"
                        />
                      </td>
                      <td>
                        <input
                          className="field text-right"
                          type="number"
                          step="any"
                          min="0"
                          value={l.estimatedUnitPrice}
                          onChange={(e) => patch(l.key, { estimatedUnitPrice: e.target.value })}
                          aria-label="Estimated unit price"
                        />
                      </td>
                      <td>
                        <select
                          className="field"
                          value={l.disposition}
                          onChange={(e) => patch(l.key, { disposition: e.target.value })}
                          aria-label="Disposition"
                        >
                          {DISPOSITIONS.map((d) => (
                            <option key={d} value={d}>
                              {humanize(d)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="num text-xs">
                        <span className="tnum inline-block pt-2">{lineTotal > 0 ? money(lineTotal) : "—"}</span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs text-[var(--c-danger)]"
                          onClick={() =>
                            setLines((prev) => (prev.length === 1 ? prev : prev.filter((x) => x.key !== l.key)))
                          }
                          disabled={lines.length === 1}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLines((p) => [...p, newLine()])}>
              + Add line
            </button>
            <div className="text-xs">
              <span className="text-muted">Estimated total </span>
              <span className="tnum font-600">{money(estimate)}</span>
              {limit > 0 && (
                <span className="ml-2 text-[var(--c-text-tertiary)]">
                  limit {money(limit)}
                </span>
              )}
            </div>
          </div>

          {overLimit && (
            <InlineAlert tone="danger">
              {money(estimate)} exceeds this entity&apos;s petty cash ceiling of {money(limit)}. Raise a purchase
              requisition instead — the server will refuse this request.
            </InlineAlert>
          )}

          {needsStore && (
            <InlineAlert tone="warning">
              At least one line is marked{" "}
              {[...new Set(lines.filter((l) => STORE_ENTRY_DISPOSITIONS.includes(l.disposition as never)).map((l) => humanize(l.disposition)))].join(", ")}
              , so a store entry will be mandatory before this request can be closed.
            </InlineAlert>
          )}
        </div>
      </FormSection>
    </ActionForm>
  );
}
