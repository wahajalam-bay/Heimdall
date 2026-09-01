"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { createWorkOrderAction } from "../actions";

type Line = { description: string; quantity: string; unit: string; rate: string; source: string };

const EMPTY: Line = { description: "", quantity: "1", unit: "JOB", rate: "", source: "" };

/**
 * Raising a work order.
 *
 * The rate source field is not optional decoration. §4.6 makes procurement's
 * negotiated rate the basis of the order, and a rate on a work order that
 * cannot be traced back to the negotiation that produced it is a number
 * somebody typed.
 */
export function WorkOrderForm({
  entities,
  vendors,
  comparatives,
  defaultEntityId,
}: {
  entities: Array<{ id: string; code: string; name: string }>;
  vendors: Array<{ id: string; name: string; code: string }>;
  comparatives: Array<{ id: string; label: string; prId: string | null }>;
  defaultEntityId: string;
}) {
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY }]);
  const [tax, setTax] = useState("0");
  const [comparativeId, setComparativeId] = useState("");

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const subtotal = lines.reduce(
    (a, l) => a + (Number(l.quantity) || 0) * (Number(l.rate) || 0),
    0,
  );
  const total = subtotal + (Number(tax) || 0);
  const prId = comparatives.find((c) => c.id === comparativeId)?.prId ?? "";

  return (
    <ActionForm
      action={createWorkOrderAction}
      submitLabel="Raise the work order"
      hiddenFields={{ prId }}
      onSuccessRedirect="/work-orders"
    >
      <FormSection columns={2}>
        <Field label="Company" name="entityId" required>
          <Select
            name="entityId"
            required
            defaultValue={defaultEntityId}
            options={entities.map((e) => ({ value: e.id, label: `${e.code} — ${e.name}` }))}
          />
        </Field>
        <Field label="Vendor" name="vendorId" required>
          <Select
            name="vendorId"
            required
            placeholder="Choose the vendor…"
            options={vendors.map((v) => ({ value: v.id, label: `${v.name} (${v.code})` }))}
          />
        </Field>
        <Field label="Title" name="title" required>
          <TextInput name="title" required placeholder="Short name for the work" />
        </Field>
        <Field
          label="Rates from"
          name="comparativeId"
          hint="The comparative the negotiated rates came from, where there is one."
        >
          <Select
            name="comparativeId"
            value={comparativeId}
            onChange={(e) => setComparativeId(e.target.value)}
            placeholder="Not from a comparative"
            options={comparatives.map((c) => ({ value: c.id, label: c.label }))}
          />
        </Field>
      </FormSection>

      <Field
        label="Scope of work"
        name="scopeOfWork"
        required
        hint="What the vendor is being asked to do. A work order without a scope cannot be checked against what was delivered."
      >
        <TextArea name="scopeOfWork" rows={4} required />
      </Field>

      <FormSection columns={2}>
        <Field label="Start" name="startDate">
          <TextInput type="date" name="startDate" />
        </Field>
        <Field label="End" name="endDate">
          <TextInput type="date" name="endDate" />
        </Field>
      </FormSection>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="label">Lines</span>
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            onClick={() => setLines((ls) => [...ls, { ...EMPTY }])}
          >
            Add a line
          </button>
        </div>

        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ minWidth: "14rem" }}>Description</th>
                <th style={{ width: "6rem" }}>Qty</th>
                <th style={{ width: "6rem" }}>Unit</th>
                <th style={{ width: "9rem" }}>Rate</th>
                <th style={{ width: "10rem" }}>Rate source</th>
                <th style={{ width: "9rem" }} className="text-right">
                  Amount
                </th>
                <th style={{ width: "3rem" }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <input
                      className="field"
                      name="lineDescription"
                      value={l.description}
                      onChange={(e) => setLine(i, { description: e.target.value })}
                      placeholder="What is being done"
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      type="number"
                      step="any"
                      min="0"
                      name="lineQuantity"
                      value={l.quantity}
                      onChange={(e) => setLine(i, { quantity: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      name="lineUnit"
                      value={l.unit}
                      onChange={(e) => setLine(i, { unit: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      type="number"
                      step="any"
                      min="0"
                      name="lineRate"
                      value={l.rate}
                      onChange={(e) => setLine(i, { rate: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      name="lineSource"
                      value={l.source}
                      onChange={(e) => setLine(i, { source: e.target.value })}
                      placeholder="e.g. NGM-2026-00004"
                    />
                  </td>
                  <td className="tnum text-right">
                    {((Number(l.quantity) || 0) * (Number(l.rate) || 0)).toLocaleString("en-PK", {
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td>
                    {lines.length > 1 && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <FormSection columns={2}>
        <Field label="Tax" name="taxAmount">
          <TextInput
            type="number"
            step="any"
            min="0"
            name="taxAmount"
            value={tax}
            onChange={(e) => setTax(e.target.value)}
          />
        </Field>
        <Field label="Total" name="_total">
          <TextInput
            readOnly
            name="_total"
            value={total.toLocaleString("en-PK", { maximumFractionDigits: 2 })}
          />
        </Field>
      </FormSection>

      <InlineAlert tone="info">
        Whether Internal Audit has to review this is decided from the value against the committee threshold when you
        raise it, and then held on the order. A threshold changed later will not make a signed order look as though
        it was never gated.
      </InlineAlert>
    </ActionForm>
  );
}
