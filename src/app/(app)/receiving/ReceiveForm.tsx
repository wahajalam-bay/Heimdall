"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { Badge, InlineAlert, SectionCard } from "@/components/ui/primitives";
import { DISCREPANCY_TYPES, humanize } from "@/lib/domain";
import { money, qty, round2 } from "@/lib/format";
import { recordDeliveryAction } from "./actions";

export type ReceiveLine = {
  poItemId: string;
  lineNo: number;
  description: string;
  specification: string | null;
  unit: string;
  orderedQty: number;
  alreadyAccepted: number;
  expectedQty: number;
  unitPrice: number;
  requiresInspection: boolean;
  trackSerial: boolean;
  trackBatch: boolean;
  trackExpiry: boolean;
};

type Draft = {
  poItemId: string;
  actualQty: string;
  acceptedQty: string;
  packages: string;
  batchNumber: string;
  serialNumbers: string;
  expiryDate: string;
  warrantyMonths: string;
  specificationMatch: boolean;
  conditionNotes: string;
  discrepancyType: string;
  discrepancyNotes: string;
};

const CONDITIONS = [
  "New, no damage",
  "Original sealed packaging",
  "Light transit marks, acceptable",
  "Surface rust within tolerance",
  "Damaged — see notes",
];

/**
 * Physical verification at receipt.
 *
 * Deliberately does not pre-accept the full quantity: the receiver must enter
 * what actually arrived and what is being accepted, and any shortfall or
 * condition problem forces a discrepancy classification.
 */
export function ReceiveForm({
  po,
  lines,
  stores,
  gatePasses,
  overReceiptPercent,
}: {
  po: {
    id: string;
    number: string;
    vendorName: string;
    deliveryStoreId: string | null;
    deliveryStoreName: string | null;
    deliveryDate: string | null;
    isOverdue: boolean;
  };
  lines: ReceiveLine[];
  stores: Array<{ id: string; name: string; kind: string }>;
  gatePasses: Array<{ id: string; number: string; serial: string; vehicleNumber: string | null; arrivedAt: string }>;
  overReceiptPercent: number;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(
    lines.map((l) => ({
      poItemId: l.poItemId,
      actualQty: "",
      acceptedQty: "",
      packages: "",
      batchNumber: "",
      serialNumbers: "",
      expiryDate: "",
      warrantyMonths: "",
      specificationMatch: true,
      conditionNotes: "",
      discrepancyType: "OK",
      discrepancyNotes: "",
    })),
  );
  const [storeId, setStoreId] = useState(po.deliveryStoreId ?? stores[0]?.id ?? "");
  const [damage, setDamage] = useState(false);

  const patch = (poItemId: string, changes: Partial<Draft>) =>
    setDrafts((prev) => prev.map((d) => (d.poItemId === poItemId ? { ...d, ...changes } : d)));

  // Filling the delivered quantity suggests, but does not force, the accepted quantity.
  const setDelivered = (l: ReceiveLine, value: string) => {
    const v = Number(value) || 0;
    const current = drafts.find((d) => d.poItemId === l.poItemId);
    const acceptWasEmpty = !current?.acceptedQty;
    const short = v > 0 && v < l.expectedQty;
    patch(l.poItemId, {
      actualQty: value,
      ...(acceptWasEmpty ? { acceptedQty: value } : {}),
      discrepancyType: short ? "SHORT_DELIVERY" : current?.discrepancyType === "SHORT_DELIVERY" ? "OK" : (current?.discrepancyType ?? "OK"),
    });
  };

  const summary = useMemo(() => {
    let delivered = 0;
    let accepted = 0;
    let rejected = 0;
    let value = 0;
    let issues = 0;
    for (const l of lines) {
      const d = drafts.find((x) => x.poItemId === l.poItemId)!;
      const a = Number(d.actualQty) || 0;
      const acc = Number(d.acceptedQty) || 0;
      delivered += a;
      accepted += acc;
      rejected += Math.max(0, a - acc);
      value += acc * l.unitPrice;
      if (d.discrepancyType !== "OK" || a < l.expectedQty) issues += 1;
    }
    return {
      delivered: round2(delivered),
      accepted: round2(accepted),
      rejected: round2(rejected),
      value: round2(value),
      issues,
    };
  }, [drafts, lines]);

  const errors = useMemo(() => {
    const out: string[] = [];
    for (const l of lines) {
      const d = drafts.find((x) => x.poItemId === l.poItemId)!;
      const a = Number(d.actualQty) || 0;
      const acc = Number(d.acceptedQty) || 0;
      if (acc > a + 1e-9) out.push(`Line ${l.lineNo}: accepted (${acc}) exceeds delivered (${a}).`);
      const ceiling = l.orderedQty * (1 + overReceiptPercent / 100);
      if (round2(l.alreadyAccepted + a) > ceiling + 1e-9) {
        out.push(
          `Line ${l.lineNo}: total receipts would reach ${round2(l.alreadyAccepted + a)} ${l.unit} against ${l.orderedQty} ${l.unit} ordered.`,
        );
      }
      if (a < acc) out.push(`Line ${l.lineNo}: cannot accept more than was delivered.`);
      if (d.discrepancyType !== "OK" && !d.discrepancyNotes.trim()) {
        out.push(`Line ${l.lineNo}: describe the ${humanize(d.discrepancyType).toLowerCase()}.`);
      }
    }
    if (summary.delivered <= 0) out.push("Enter the quantity actually delivered on at least one line.");
    return out;
  }, [drafts, lines, overReceiptPercent, summary.delivered]);

  const payload = JSON.stringify(
    drafts
      .filter((d) => Number(d.actualQty) > 0)
      .map((d) => ({
        poItemId: d.poItemId,
        actualQty: Number(d.actualQty) || 0,
        acceptedQty: Number(d.acceptedQty) || 0,
        rejectedQty: Math.max(0, (Number(d.actualQty) || 0) - (Number(d.acceptedQty) || 0)),
        packages: d.packages === "" ? null : Number(d.packages),
        batchNumber: d.batchNumber.trim() || null,
        serialNumbers: d.serialNumbers.trim() || null,
        expiryDate: d.expiryDate || null,
        warrantyMonths: d.warrantyMonths === "" ? null : Number(d.warrantyMonths),
        specificationMatch: d.specificationMatch,
        conditionNotes: d.conditionNotes.trim() || null,
        discrepancyType: d.discrepancyType,
        discrepancyNotes: d.discrepancyNotes.trim() || null,
      })),
  );

  const needsInspection = lines.some((l) => l.requiresInspection);

  return (
    <ActionForm
      action={recordDeliveryAction}
      submitLabel="Record physical verification"
      hiddenFields={{ poId: po.id, items: payload }}
      onSuccessRedirect={(data) => {
        const d = data as { id?: string } | null;
        return d?.id ? `/receiving/${d.id}` : "/receiving";
      }}
      footerSticky
      secondary={
        <>
          <span className="mr-auto text-2xs text-[var(--c-text-tertiary)]">
            Accepting {qty(summary.accepted)} of {qty(summary.delivered)} delivered · value {money(summary.value)}
            {summary.rejected > 0 && ` · rejecting ${qty(summary.rejected)}`}
          </span>
          <Link href={`/po/${po.id}`} className="btn btn-secondary">
            Cancel
          </Link>
        </>
      }
    >
      <InlineAlert tone={po.isOverdue ? "warning" : "info"}>
        Receiving against <span className="font-600">{po.number}</span> from{" "}
        <span className="font-600">{po.vendorName}</span>
        {po.deliveryDate && (
          <>
            {" "}
            · promised {po.deliveryDate}
            {po.isOverdue && " (overdue — a late-delivery exception will be recorded)"}
          </>
        )}
        .
      </InlineAlert>

      {needsInspection && (
        <InlineAlert tone="info">
          One or more lines require technical inspection. Recording this receipt raises the inspection automatically, and
          the GRN stays blocked until it is signed off.
        </InlineAlert>
      )}

      <FormSection title="Delivery header" columns={3}>
        <Field label="Receiving store" name="storeId" required>
          <Select
            name="storeId"
            options={stores.map((s) => ({ value: s.id, label: `${s.name} · ${humanize(s.kind)}` }))}
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
          />
        </Field>
        <Field label="Gate pass" name="gatePassId" hint="Links the receipt to the recorded vehicle arrival.">
          <Select
            name="gatePassId"
            placeholder="No gate pass recorded"
            options={gatePasses.map((g) => ({
              value: g.id,
              label: `${g.number} · ${g.vehicleNumber ?? "no vehicle"} · ${g.arrivedAt}`,
            }))}
          />
        </Field>
        <Field label="Delivery note / challan" name="deliveryNoteRef" required>
          <TextInput name="deliveryNoteRef" placeholder="Vendor challan number" />
        </Field>
        <Field label="Total packages on the challan" name="totalPackages">
          <TextInput type="number" min="0" name="totalPackages" />
        </Field>
        <Field label="Packages physically verified" name="packagesVerified" hint="Count them; do not take the challan on trust.">
          <TextInput type="number" min="0" name="packagesVerified" />
        </Field>
        <Field label="Weight recorded" name="weightRecorded" hint="For bulk material, from the weighbridge.">
          <div className="flex gap-2">
            <TextInput type="number" step="any" min="0" name="weightRecorded" className="flex-1" />
            <Select
              name="weightUnit"
              options={["TON", "KG", "LB"].map((u) => ({ value: u, label: u }))}
              placeholder="Unit"
              className="w-24"
            />
          </div>
        </Field>
        <Field label="Packaging condition" name="packagingCondition">
          <Select
            name="packagingCondition"
            options={CONDITIONS.map((c) => ({ value: c, label: c }))}
            placeholder="Select…"
          />
        </Field>
        <Field label="Physical condition" name="physicalCondition">
          <Select
            name="physicalCondition"
            options={CONDITIONS.map((c) => ({ value: c, label: c }))}
            placeholder="Select…"
          />
        </Field>
        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              name="damageObserved"
              checked={damage}
              onChange={(e) => setDamage(e.target.checked)}
            />
            Damage observed
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input type="checkbox" name="leakageObserved" />
            Leakage observed
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input type="checkbox" name="documentationComplete" defaultChecked />
            Documentation complete
          </label>
        </div>
        {damage && (
          <Field label="Damage detail" name="damageNotes" required span>
            <TextArea name="damageNotes" rows={2} placeholder="What is damaged, how many units, and whether it is being accepted or rejected." />
          </Field>
        )}
        <Field label="Special handling notes" name="handlingNotes" span>
          <TextInput name="handlingNotes" placeholder="Lifting, temperature, hazardous or fragile handling requirements" />
        </Field>
      </FormSection>

      <SectionCard
        title="Line verification"
        description="Enter what actually arrived, then what you are accepting. The difference is recorded as a rejection and classified."
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "2.5rem" }}>#</th>
                <th style={{ minWidth: "15rem" }}>Line</th>
                <th className="text-right" style={{ width: "6.5rem" }}>Ordered</th>
                <th className="text-right" style={{ width: "6.5rem" }}>Outstanding</th>
                <th className="text-right" style={{ width: "7rem" }}>Delivered</th>
                <th className="text-right" style={{ width: "7rem" }}>Accepted</th>
                <th className="text-right" style={{ width: "6rem" }}>Rejected</th>
                <th style={{ width: "11rem" }}>Discrepancy</th>
                <th style={{ minWidth: "14rem" }}>Batch / serial / condition</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const d = drafts.find((x) => x.poItemId === l.poItemId)!;
                const delivered = Number(d.actualQty) || 0;
                const accepted = Number(d.acceptedQty) || 0;
                const rejected = round2(Math.max(0, delivered - accepted));
                const short = delivered > 0 && delivered < l.expectedQty;
                return (
                  <tr key={l.poItemId} className={short || rejected > 0 ? "bg-[var(--c-warning-soft)]/40" : undefined}>
                    <td className="tnum align-top text-[var(--c-text-tertiary)]">{l.lineNo}</td>
                    <td className="align-top">
                      <div className="font-500">{l.description}</div>
                      {l.specification && (
                        <div className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">{l.specification}</div>
                      )}
                      {l.requiresInspection && <Badge tone="warning">Inspection required</Badge>}
                    </td>
                    <td className="num align-top text-2xs">{qty(l.orderedQty, l.unit)}</td>
                    <td className="num align-top">
                      <span className="tnum font-500">{qty(l.expectedQty)}</span>
                      {l.alreadyAccepted > 0 && (
                        <span className="block text-2xs text-[var(--c-text-tertiary)]">
                          {qty(l.alreadyAccepted)} already in
                        </span>
                      )}
                    </td>
                    <td className="align-top">
                      <input
                        className="field text-right"
                        type="number"
                        step="any"
                        min="0"
                        value={d.actualQty}
                        onChange={(e) => setDelivered(l, e.target.value)}
                        aria-label={`Delivered quantity for line ${l.lineNo}`}
                      />
                    </td>
                    <td className="align-top">
                      <input
                        className="field text-right"
                        type="number"
                        step="any"
                        min="0"
                        value={d.acceptedQty}
                        onChange={(e) => patch(l.poItemId, { acceptedQty: e.target.value })}
                        aria-label={`Accepted quantity for line ${l.lineNo}`}
                      />
                    </td>
                    <td className="num align-top">
                      <span className={rejected > 0 ? "tnum pt-2 font-500 text-[var(--c-danger)]" : "tnum pt-2"}>
                        {rejected > 0 ? qty(rejected) : "—"}
                      </span>
                    </td>
                    <td className="align-top">
                      <select
                        className="field"
                        value={d.discrepancyType}
                        onChange={(e) => patch(l.poItemId, { discrepancyType: e.target.value })}
                        aria-label={`Discrepancy for line ${l.lineNo}`}
                      >
                        {DISCREPANCY_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t === "OK" ? "No discrepancy" : humanize(t)}
                          </option>
                        ))}
                      </select>
                      {d.discrepancyType !== "OK" && (
                        <textarea
                          className="field mt-1"
                          rows={2}
                          placeholder="Describe the discrepancy — required"
                          value={d.discrepancyNotes}
                          onChange={(e) => patch(l.poItemId, { discrepancyNotes: e.target.value })}
                        />
                      )}
                    </td>
                    <td className="align-top">
                      <div className="space-y-1">
                        {l.trackBatch && (
                          <input
                            className="field"
                            placeholder="Batch / heat number"
                            value={d.batchNumber}
                            onChange={(e) => patch(l.poItemId, { batchNumber: e.target.value })}
                          />
                        )}
                        {l.trackSerial && (
                          <input
                            className="field"
                            placeholder="Serial numbers, comma separated"
                            value={d.serialNumbers}
                            onChange={(e) => patch(l.poItemId, { serialNumbers: e.target.value })}
                          />
                        )}
                        {l.trackExpiry && (
                          <input
                            className="field"
                            type="date"
                            value={d.expiryDate}
                            onChange={(e) => patch(l.poItemId, { expiryDate: e.target.value })}
                            aria-label="Expiry date"
                          />
                        )}
                        <div className="flex gap-1">
                          <input
                            className="field"
                            type="number"
                            min="0"
                            placeholder="Packages"
                            value={d.packages}
                            onChange={(e) => patch(l.poItemId, { packages: e.target.value })}
                          />
                          <input
                            className="field"
                            type="number"
                            min="0"
                            placeholder="Warranty (m)"
                            value={d.warrantyMonths}
                            onChange={(e) => patch(l.poItemId, { warrantyMonths: e.target.value })}
                          />
                        </div>
                        <input
                          className="field"
                          placeholder="Condition notes"
                          value={d.conditionNotes}
                          onChange={(e) => patch(l.poItemId, { conditionNotes: e.target.value })}
                        />
                        <label className="flex cursor-pointer items-center gap-1.5 text-2xs">
                          <input
                            type="checkbox"
                            checked={d.specificationMatch}
                            onChange={(e) => patch(l.poItemId, { specificationMatch: e.target.checked })}
                          />
                          Matches specification
                        </label>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="text-right">Totals</td>
                <td className="num">{qty(summary.delivered)}</td>
                <td className="num">{qty(summary.accepted)}</td>
                <td className="num">{summary.rejected > 0 ? qty(summary.rejected) : "—"}</td>
                <td colSpan={2}>
                  {summary.issues > 0 && (
                    <span className="text-2xs text-[var(--c-warning)]">
                      {summary.issues} line(s) with a discrepancy — each raises a tracked exception
                    </span>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </SectionCard>

      {errors.length > 0 && (
        <div className="rounded-2xl alert-warning px-3 py-2.5">
          <p className="text-xs font-600 text-[var(--c-warning)]">Resolve before submitting</p>
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
        <Field label="Receiver remarks" name="remarks" span>
          <TextArea
            name="remarks"
            rows={3}
            placeholder="Anything the store, procurement or finance needs to know about this receipt."
          />
        </Field>
      </FormSection>
    </ActionForm>
  );
}
