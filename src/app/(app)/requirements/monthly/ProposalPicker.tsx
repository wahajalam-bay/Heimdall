"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextInput } from "@/components/ui/field";
import { Badge, InlineAlert, Mono } from "@/components/ui/primitives";
import { draftMonthlyAction } from "./actions";

type Line = {
  itemId: string;
  sku: string;
  name: string;
  categoryName: string | null;
  ownerRole: string | null;
  unit: string;
  perMonth: number;
  movements: number;
  onHand: number;
  reserved: number;
  onOrder: number;
  suggestedQty: number;
  estimatedValue: number;
};

/**
 * Picking the lines to draft.
 *
 * The arithmetic is on every row on purpose. A projected quantity somebody
 * cannot check is a number they will either rubber-stamp or ignore, and both are
 * worse than a smaller list they believe.
 */
export function ProposalPicker({
  entityId,
  storeId,
  ownerRole,
  period,
  lines,
  departments,
  canDraft,
}: {
  entityId: string;
  storeId: string | null;
  ownerRole: string | null;
  period: string;
  lines: Line[];
  departments: Array<{ id: string; label: string }>;
  canDraft: boolean;
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set(lines.map((l) => l.itemId)));

  const toggle = (id: string) =>
    setChosen((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selected = lines.filter((l) => chosen.has(l.itemId));
  const total = selected.reduce((a, l) => a + l.estimatedValue, 0);

  const table = (
    <div className="table-wrap">
      <table className="dt">
        <thead>
          <tr>
            <th style={{ width: "3rem" }} className="no-print">
              <span className="sr-only">Include</span>
            </th>
            <th style={{ minWidth: "13rem" }}>Item</th>
            <th style={{ width: "11rem" }}>Compiled by</th>
            <th style={{ width: "9rem" }} className="text-right">
              Used / month
            </th>
            <th style={{ width: "9rem" }} className="text-right">
              Available
            </th>
            <th style={{ width: "8rem" }} className="text-right">
              On order
            </th>
            <th style={{ width: "9rem" }} className="text-right">
              Propose
            </th>
            <th style={{ width: "10rem" }} className="text-right">
              Value
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const on = chosen.has(l.itemId);
            return (
              <tr key={l.itemId}>
                <td className="no-print">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(l.itemId)}
                    aria-label={`Include ${l.sku}`}
                  />
                  {on && <input type="hidden" name="itemId" value={l.itemId} />}
                </td>
                <td>
                  {l.name}
                  <Mono className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                    {l.sku}
                    {l.categoryName ? ` · ${l.categoryName}` : ""}
                  </Mono>
                </td>
                <td>
                  {l.ownerRole ? (
                    <span className="text-2xs">{l.ownerRole.replace(/_/g, " ").toLowerCase()}</span>
                  ) : (
                    <Badge tone="warning">No owner in §4.1</Badge>
                  )}
                </td>
                <td className="tnum text-right">
                  {l.perMonth}
                  <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                    {l.movements} issues
                  </span>
                </td>
                <td className="tnum text-right">
                  {(l.onHand - l.reserved).toFixed(2)}
                  {l.reserved > 0 && (
                    <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                      {l.reserved} reserved
                    </span>
                  )}
                </td>
                <td className="tnum text-right">{l.onOrder || "—"}</td>
                <td className="tnum text-right font-semibold">
                  {l.suggestedQty} {l.unit}
                </td>
                <td className="tnum text-right">
                  {l.estimatedValue
                    ? l.estimatedValue.toLocaleString("en-PK", { maximumFractionDigits: 0 })
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  if (!canDraft) {
    return (
      <div className="card overflow-hidden">
        {table}
        <p className="px-3.5 py-2.5 text-2xs text-[var(--c-text-tertiary)]">
          You do not have permission to raise requirements, so this is a projection only.
        </p>
      </div>
    );
  }

  return (
    <ActionForm
      action={draftMonthlyAction}
      submitLabel={`Create a draft with ${selected.length} line${selected.length === 1 ? "" : "s"}`}
      hiddenFields={{
        entityId,
        ...(storeId ? { storeId } : {}),
        ...(ownerRole ? { ownerRole } : {}),
      }}
      onSuccessRedirect="/requirements"
    >
      <FormSection columns={2}>
        <Field label="Department" name="departmentId" required>
          <Select
            name="departmentId"
            required
            placeholder="Choose the department…"
            options={departments.map((d) => ({ value: d.id, label: d.label }))}
          />
        </Field>
        <Field label="Title" name="title">
          <TextInput name="title" defaultValue={`Monthly repeat requirement — ${period}`} />
        </Field>
      </FormSection>

      {table}

      <InlineAlert tone="info">
        This creates a <strong>draft</strong>, not a submission. §4.1 has the team generate the requisition, and one
        nobody chose to raise is a commitment nobody owns — so the projection&rsquo;s arithmetic goes into the
        justification and a person reviews it.
        {total > 0 && (
          <span className="mt-1 block">
            {selected.length} line(s), roughly{" "}
            {total.toLocaleString("en-PK", { maximumFractionDigits: 0 })} at standard prices.
          </span>
        )}
      </InlineAlert>
    </ActionForm>
  );
}
