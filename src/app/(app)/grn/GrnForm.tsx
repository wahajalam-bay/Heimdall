"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea } from "@/components/ui/field";
import { Badge, InlineAlert, SectionCard } from "@/components/ui/primitives";
import { DISPOSITIONS, STORE_ENTRY_DISPOSITIONS, humanize } from "@/lib/domain";
import { money, qty, round2, toInputDate } from "@/lib/format";
import { createGrnAction } from "@/app/(app)/receiving/actions";

export type GrnCandidateLine = {
  deliveryItemId: string;
  lineNo: number;
  description: string;
  unit: string;
  orderedQty: number;
  deliveredQty: number;
  acceptedAtReceipt: number;
  inspectionPassed: number | null;
  poOutstanding: number;
  unitPrice: number;
  disposition: string;
  batchNumber: string | null;
  serialNumbers: string | null;
  expiryDate: string | null;
  warrantyMonths: number | null;
  discrepancyType: string;
};

type LineState = {
  deliveryItemId: string;
  acceptedQty: string;
  batchNumber: string;
  serialNumbers: string;
  expiryDate: string;
  warrantyMonths: string;
  storeLocationId: string;
  disposition: string;
  remarks: string;
};

/**
 * GRN creation. The accepted quantity is capped by what was physically verified
 * and, where an inspection applies, by what the inspection passed — the server
 * enforces both caps again.
 */
export function GrnForm({
  delivery,
  lines,
  locations,
  inspectionStatus,
}: {
  delivery: {
    id: string;
    number: string;
    poNumber: string;
    poId: string;
    vendorName: string;
    storeId: string;
    storeName: string;
  };
  lines: GrnCandidateLine[];
  locations: Array<{ id: string; label: string; zone: string | null; handling: string }>;
  inspectionStatus: string;
}) {
  const [state, setState] = useState<LineState[]>(
    lines.map((l) => ({
      deliveryItemId: l.deliveryItemId,
      acceptedQty: String(
        Math.min(
          l.acceptedAtReceipt,
          l.inspectionPassed ?? l.acceptedAtReceipt,
          l.poOutstanding,
        ),
      ),
      batchNumber: l.batchNumber ?? "",
      serialNumbers: l.serialNumbers ?? "",
      expiryDate: l.expiryDate ?? "",
      warrantyMonths: l.warrantyMonths ? String(l.warrantyMonths) : "",
      storeLocationId: "",
      disposition: l.disposition,
      remarks: "",
    })),
  );
  const [post, setPost] = useState(true);

  const patch = (id: string, changes: Partial<LineState>) =>
    setState((prev) => prev.map((s) => (s.deliveryItemId === id ? { ...s, ...changes } : s)));

  const totals = useMemo(() => {
    let value = 0;
    let accepted = 0;
    let stockLines = 0;
    for (const l of lines) {
      const s = state.find((x) => x.deliveryItemId === l.deliveryItemId)!;
      const a = Number(s.acceptedQty) || 0;
      accepted += a;
      value += a * l.unitPrice;
      if (a > 0 && STORE_ENTRY_DISPOSITIONS.includes(s.disposition as never)) stockLines += 1;
    }
    return { accepted: round2(accepted), value: round2(value), stockLines };
  }, [state, lines]);

  const errors = useMemo(() => {
    const out: string[] = [];
    for (const l of lines) {
      const s = state.find((x) => x.deliveryItemId === l.deliveryItemId)!;
      const a = Number(s.acceptedQty) || 0;
      if (a > l.acceptedAtReceipt + 1e-9) {
        out.push(`Line ${l.lineNo}: cannot take in ${a} — only ${l.acceptedAtReceipt} was accepted at verification.`);
      }
      if (l.inspectionPassed !== null && a > l.inspectionPassed + 1e-9) {
        out.push(`Line ${l.lineNo}: technical inspection passed only ${l.inspectionPassed} ${l.unit}.`);
      }
      if (a > l.poOutstanding + 1e-9) {
        out.push(`Line ${l.lineNo}: only ${l.poOutstanding} ${l.unit} remains outstanding on ${delivery.poNumber}.`);
      }
    }
    if (totals.accepted <= 0) out.push("A GRN needs at least one line with an accepted quantity.");
    return out;
  }, [state, lines, totals.accepted, delivery.poNumber]);

  const payload = JSON.stringify(
    state
      .filter((s) => Number(s.acceptedQty) > 0)
      .map((s) => {
        const l = lines.find((x) => x.deliveryItemId === s.deliveryItemId)!;
        return {
          deliveryItemId: s.deliveryItemId,
          acceptedQty: Number(s.acceptedQty) || 0,
          rejectedQty: round2(Math.max(0, l.deliveredQty - (Number(s.acceptedQty) || 0))),
          batchNumber: s.batchNumber.trim() || null,
          serialNumbers: s.serialNumbers.trim() || null,
          expiryDate: s.expiryDate || null,
          warrantyMonths: s.warrantyMonths === "" ? null : Number(s.warrantyMonths),
          storeLocationId: s.storeLocationId || null,
          disposition: s.disposition,
          remarks: s.remarks.trim() || null,
        };
      }),
  );

  return (
    <ActionForm
      action={createGrnAction}
      submitLabel={post ? "Create & post GRN" : "Create GRN draft"}
      hiddenFields={{ deliveryId: delivery.id, storeId: delivery.storeId, items: payload, post: post ? "true" : "" }}
      onSuccessRedirect={(data) => {
        const d = data as { id?: string } | null;
        return d?.id ? `/grn/${d.id}` : "/grn";
      }}
      footerSticky
      secondary={
        <>
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-[var(--c-text-secondary)]">
            <input type="checkbox" checked={post} onChange={(e) => setPost(e.target.checked)} />
            Post to inventory immediately
          </label>
          <Link href={`/receiving/${delivery.id}`} className="btn btn-secondary">
            Cancel
          </Link>
        </>
      }
    >
      <InlineAlert tone="info">
        Raising a GRN for <span className="font-600">{delivery.number}</span> against{" "}
        <span className="font-600">{delivery.poNumber}</span> from {delivery.vendorName}, into {delivery.storeName}.
        Posting is what actually takes the goods into inventory and reduces the purchase order balance.
      </InlineAlert>

      {inspectionStatus === "CONDITIONAL" && (
        <InlineAlert tone="warning">
          The technical inspection was <span className="font-600">conditionally</span> approved. The conditions recorded on
          the inspection remain outstanding against the vendor.
        </InlineAlert>
      )}

      <SectionCard
        title="Quantities to take into inventory"
        description="Capped by what was accepted at physical verification, what the inspection passed, and what remains outstanding on the order."
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "2.5rem" }}>#</th>
                <th style={{ minWidth: "15rem" }}>Line</th>
                <th className="text-right">Delivered</th>
                <th className="text-right">Accepted at receipt</th>
                <th className="text-right">Inspection passed</th>
                <th className="text-right">PO outstanding</th>
                <th className="text-right" style={{ width: "7.5rem" }}>Take in</th>
                <th className="text-right">Line value</th>
                <th style={{ width: "10rem" }}>Disposition</th>
                <th style={{ width: "11rem" }}>Bin location</th>
                <th style={{ minWidth: "12rem" }}>Traceability</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const s = state.find((x) => x.deliveryItemId === l.deliveryItemId)!;
                const a = Number(s.acceptedQty) || 0;
                const createsStock = STORE_ENTRY_DISPOSITIONS.includes(s.disposition as never);
                return (
                  <tr key={l.deliveryItemId}>
                    <td className="tnum align-top text-[var(--c-text-tertiary)]">{l.lineNo}</td>
                    <td className="align-top">
                      <div className="font-500">{l.description}</div>
                      {l.discrepancyType !== "OK" && (
                        <Badge tone="warning">{humanize(l.discrepancyType)}</Badge>
                      )}
                    </td>
                    <td className="num align-top text-2xs">{qty(l.deliveredQty, l.unit)}</td>
                    <td className="num align-top text-2xs">{qty(l.acceptedAtReceipt)}</td>
                    <td className="num align-top text-2xs">
                      {l.inspectionPassed !== null ? (
                        qty(l.inspectionPassed)
                      ) : (
                        <span className="text-[var(--c-text-tertiary)]">n/a</span>
                      )}
                    </td>
                    <td className="num align-top text-2xs">{qty(l.poOutstanding)}</td>
                    <td className="align-top">
                      <input
                        className="field text-right"
                        type="number"
                        step="any"
                        min="0"
                        value={s.acceptedQty}
                        onChange={(e) => patch(l.deliveryItemId, { acceptedQty: e.target.value })}
                        aria-label={`Quantity to take into inventory for line ${l.lineNo}`}
                      />
                    </td>
                    <td className="num align-top">
                      <span className="tnum inline-block pt-2 font-500">
                        {a > 0 ? money(round2(a * l.unitPrice)) : "—"}
                      </span>
                    </td>
                    <td className="align-top">
                      <select
                        className="field"
                        value={s.disposition}
                        onChange={(e) => patch(l.deliveryItemId, { disposition: e.target.value })}
                        aria-label={`Disposition for line ${l.lineNo}`}
                      >
                        {DISPOSITIONS.map((d) => (
                          <option key={d} value={d}>
                            {humanize(d)}
                          </option>
                        ))}
                      </select>
                      <span className="mt-1 block text-2xs text-[var(--c-text-tertiary)]">
                        {createsStock ? "Creates stock" : "No stock movement"}
                      </span>
                    </td>
                    <td className="align-top">
                      <select
                        className="field"
                        value={s.storeLocationId}
                        onChange={(e) => patch(l.deliveryItemId, { storeLocationId: e.target.value })}
                        aria-label={`Bin location for line ${l.lineNo}`}
                      >
                        <option value="">Unassigned</option>
                        {locations.map((loc) => (
                          <option key={loc.id} value={loc.id}>
                            {loc.label} · {humanize(loc.handling)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="align-top">
                      <div className="space-y-1">
                        <input
                          className="field"
                          placeholder="Batch / heat"
                          value={s.batchNumber}
                          onChange={(e) => patch(l.deliveryItemId, { batchNumber: e.target.value })}
                        />
                        <input
                          className="field"
                          placeholder="Serial numbers"
                          value={s.serialNumbers}
                          onChange={(e) => patch(l.deliveryItemId, { serialNumbers: e.target.value })}
                        />
                        <div className="flex gap-1">
                          <input
                            className="field"
                            type="date"
                            value={s.expiryDate}
                            onChange={(e) => patch(l.deliveryItemId, { expiryDate: e.target.value })}
                            aria-label="Expiry date"
                          />
                          <input
                            className="field"
                            type="number"
                            min="0"
                            placeholder="Warr. m"
                            value={s.warrantyMonths}
                            onChange={(e) => patch(l.deliveryItemId, { warrantyMonths: e.target.value })}
                          />
                        </div>
                        <input
                          className="field"
                          placeholder="Line remarks"
                          value={s.remarks}
                          onChange={(e) => patch(l.deliveryItemId, { remarks: e.target.value })}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6} className="text-right">Taking into inventory</td>
                <td className="num">{qty(totals.accepted)}</td>
                <td className="num">{money(totals.value)}</td>
                <td colSpan={3} className="text-2xs text-[var(--c-text-secondary)]">
                  {totals.stockLines} line(s) will create a stock movement
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </SectionCard>

      {errors.length > 0 && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--c-warning-border)] bg-[var(--c-warning-soft)] px-3 py-2.5">
          <p className="text-xs font-600 text-[var(--c-warning)]">Resolve before creating the GRN</p>
          <ul className="mt-1 space-y-0.5 pl-4 text-xs text-[var(--c-warning)]">
            {errors.map((e, i) => (
              <li key={i} className="list-disc">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}

      <FormSection columns={1}>
        <Field label="GRN remarks" name="remarks" span>
          <TextArea
            name="remarks"
            rows={3}
            placeholder="Anything procurement, finance or audit needs to know about what was taken into inventory."
          />
        </Field>
      </FormSection>
    </ActionForm>
  );
}
