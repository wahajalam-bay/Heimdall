"use client";

import { useMemo, useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { COMPLIANCE_LEVELS, QUOTE_CHANNELS, humanize } from "@/lib/domain";
import { money, round2, toInputDate } from "@/lib/format";
import { saveQuoteAction } from "../actions";

export type QuoteLineDraft = {
  key: string;
  prItemId: string | null;
  itemId: string | null;
  description: string;
  brand: string;
  model: string;
  specification: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxRate: string;
  deliveryDays: string;
  compliance: string;
  notes: string;
};

/**
 * Vendor quotation capture. Quotes arrive by email, WhatsApp, physically or in
 * person, so the channel is recorded alongside the figures.
 */
export function QuoteEntry({
  rfqId,
  vendor,
  existing,
  prLines,
  defaultTaxRate,
  triggerLabel,
  triggerTone = "primary",
}: {
  rfqId: string;
  vendor: { id: string; name: string; code: string; paymentTerms: string | null; creditDays: number | null };
  existing?: {
    quoteRef: string | null;
    quoteDate: string;
    validUntil: string;
    deliveryCharges: number;
    otherCharges: number;
    discount: number;
    taxRegistered: boolean;
    deliveryDays: number | null;
    paymentTerms: string | null;
    creditDays: number | null;
    warrantyMonths: number | null;
    warrantyTerms: string | null;
    technicalCompliance: string;
    complianceNotes: string | null;
    exceptions: string | null;
    notes: string | null;
    channel: string;
    lines: QuoteLineDraft[];
  };
  prLines: Array<{
    id: string;
    itemId: string | null;
    lineNo: number;
    description: string;
    brand: string | null;
    model: string | null;
    specification: string | null;
    quantity: number;
    unit: string;
    estimatedUnitPrice: number | null;
  }>;
  defaultTaxRate: number;
  triggerLabel: string;
  triggerTone?: "primary" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<QuoteLineDraft[]>(
    existing?.lines ??
      prLines.map((p) => ({
        key: `pr-${p.id}`,
        prItemId: p.id,
        itemId: p.itemId,
        description: p.description,
        brand: p.brand ?? "",
        model: p.model ?? "",
        specification: p.specification ?? "",
        quantity: String(p.quantity),
        unit: p.unit,
        unitPrice: p.estimatedUnitPrice ? String(p.estimatedUnitPrice) : "",
        taxRate: String(defaultTaxRate),
        deliveryDays: "",
        compliance: "COMPLIANT",
        notes: "",
      })),
  );
  const [deliveryCharges, setDeliveryCharges] = useState(String(existing?.deliveryCharges ?? 0));
  const [otherCharges, setOtherCharges] = useState(String(existing?.otherCharges ?? 0));
  const [discount, setDiscount] = useState(String(existing?.discount ?? 0));

  const patch = (key: string, changes: Partial<QuoteLineDraft>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...changes } : l)));

  const totals = useMemo(() => {
    let net = 0;
    let tax = 0;
    for (const l of lines) {
      const lineNet = (Number(l.unitPrice) || 0) * (Number(l.quantity) || 0);
      net += lineNet;
      tax += lineNet * ((Number(l.taxRate) || 0) / 100);
    }
    const total =
      net + tax + (Number(deliveryCharges) || 0) + (Number(otherCharges) || 0) - (Number(discount) || 0);
    return { net: round2(net), tax: round2(tax), total: round2(total) };
  }, [lines, deliveryCharges, otherCharges, discount]);

  const payload = JSON.stringify(
    lines.map((l) => ({
      prItemId: l.prItemId,
      itemId: l.itemId,
      description: l.description.trim(),
      brand: l.brand.trim() || null,
      model: l.model.trim() || null,
      specification: l.specification.trim() || null,
      quantity: Number(l.quantity) || 0,
      unit: l.unit,
      unitPrice: Number(l.unitPrice) || 0,
      taxRate: Number(l.taxRate) || 0,
      deliveryDays: l.deliveryDays === "" ? null : Number(l.deliveryDays),
      compliance: l.compliance,
      notes: l.notes.trim() || null,
    })),
  );

  return (
    <>
      <button type="button" className={`btn btn-${triggerTone} btn-sm`} onClick={() => setOpen(true)}>
        {triggerLabel}
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`${existing ? "Update" : "Record"} quotation — ${vendor.name}`}
        description="Capture the quotation exactly as received, including the channel it arrived through and any technical exceptions the vendor stated."
        size="xl"
      >
        <ActionForm
          action={saveQuoteAction}
          layout="bare"
          submitLabel={existing ? "Update quotation" : "Save quotation"}
          hiddenFields={{ rfqId, vendorId: vendor.id, items: payload }}
          onSuccessRedirect={`/rfq/${rfqId}`}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection title="Quotation header" columns={3}>
            <Field label="Vendor reference" name="quoteRef">
              <TextInput name="quoteRef" defaultValue={existing?.quoteRef ?? ""} placeholder="Vendor's own quote number" />
            </Field>
            <Field label="Quotation date" name="quoteDate" required>
              <TextInput type="date" name="quoteDate" defaultValue={existing?.quoteDate ?? toInputDate(new Date())} />
            </Field>
            <Field label="Valid until" name="validUntil" hint="Quotations past validity are flagged when comparing.">
              <TextInput type="date" name="validUntil" defaultValue={existing?.validUntil ?? ""} />
            </Field>
            <Field label="Received via" name="channel" required>
              <Select
                name="channel"
                options={QUOTE_CHANNELS.map((c) => ({ value: c, label: humanize(c) }))}
                defaultValue={existing?.channel ?? "EMAIL"}
              />
            </Field>
            <Field label="Lead time (days)" name="deliveryDays">
              <TextInput type="number" min="0" name="deliveryDays" defaultValue={existing?.deliveryDays ?? ""} />
            </Field>
            <Field label="Warranty (months)" name="warrantyMonths">
              <TextInput type="number" min="0" name="warrantyMonths" defaultValue={existing?.warrantyMonths ?? ""} />
            </Field>
            <Field label="Payment terms" name="paymentTerms">
              <TextInput
                name="paymentTerms"
                defaultValue={existing?.paymentTerms ?? vendor.paymentTerms ?? ""}
                placeholder="e.g. 30 days from invoice"
              />
            </Field>
            <Field label="Credit days" name="creditDays">
              <TextInput
                type="number"
                min="0"
                name="creditDays"
                defaultValue={existing?.creditDays ?? vendor.creditDays ?? ""}
              />
            </Field>
            <Field label="Technical compliance" name="technicalCompliance" required>
              <Select
                name="technicalCompliance"
                options={COMPLIANCE_LEVELS.map((c) => ({ value: c, label: humanize(c) }))}
                defaultValue={existing?.technicalCompliance ?? "COMPLIANT"}
              />
            </Field>
            <Field label="Warranty terms" name="warrantyTerms" span>
              <TextInput name="warrantyTerms" defaultValue={existing?.warrantyTerms ?? ""} />
            </Field>
            <Field
              label="Compliance notes"
              name="complianceNotes"
              span
              hint="State precisely where the offer differs from the specification — this is what justifies a non-lowest award later."
            >
              <TextArea name="complianceNotes" rows={2} defaultValue={existing?.complianceNotes ?? ""} />
            </Field>
            <Field label="Vendor exceptions / conditions" name="exceptions" span>
              <TextArea name="exceptions" rows={2} defaultValue={existing?.exceptions ?? ""} />
            </Field>
            <div className="sm:col-span-full">
              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <input type="checkbox" name="taxRegistered" defaultChecked={existing?.taxRegistered ?? true} />
                Vendor is sales-tax registered (a tax invoice will be issued)
              </label>
            </div>
          </FormSection>

          <FormSection title="Priced lines" columns={1}>
            <div className="sm:col-span-full overflow-hidden rounded-xl border border-border">
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th style={{ minWidth: "16rem" }}>Line</th>
                      <th className="text-right" style={{ width: "6.5rem" }}>Qty</th>
                      <th className="text-right" style={{ width: "9rem" }}>Unit price</th>
                      <th className="text-right" style={{ width: "6rem" }}>Tax %</th>
                      <th className="text-right" style={{ width: "10rem" }}>Line total</th>
                      <th style={{ width: "9rem" }}>Compliance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => {
                      const lineNet = (Number(l.unitPrice) || 0) * (Number(l.quantity) || 0);
                      const lineTotal = round2(lineNet * (1 + (Number(l.taxRate) || 0) / 100));
                      return (
                        <tr key={l.key}>
                          <td>
                            <input
                              className="field mb-1"
                              value={l.description}
                              onChange={(e) => patch(l.key, { description: e.target.value })}
                              aria-label="Line description"
                            />
                            <div className="grid grid-cols-2 gap-1">
                              <input
                                className="field"
                                placeholder="Brand"
                                value={l.brand}
                                onChange={(e) => patch(l.key, { brand: e.target.value })}
                              />
                              <input
                                className="field"
                                placeholder="Model"
                                value={l.model}
                                onChange={(e) => patch(l.key, { model: e.target.value })}
                              />
                            </div>
                            <input
                              className="field mt-1"
                              placeholder="Specification offered (state deviations explicitly)"
                              value={l.specification}
                              onChange={(e) => patch(l.key, { specification: e.target.value })}
                            />
                            <input
                              className="field mt-1"
                              placeholder="Line note"
                              value={l.notes}
                              onChange={(e) => patch(l.key, { notes: e.target.value })}
                            />
                          </td>
                          <td className="align-top">
                            <input
                              className="field text-right"
                              type="number"
                              step="any"
                              min="0"
                              value={l.quantity}
                              onChange={(e) => patch(l.key, { quantity: e.target.value })}
                              aria-label="Quantity"
                            />
                            <span className="mt-1 block text-center text-2xs text-[var(--c-text-tertiary)]">{l.unit}</span>
                          </td>
                          <td className="align-top">
                            <input
                              className="field text-right"
                              type="number"
                              step="any"
                              min="0"
                              value={l.unitPrice}
                              onChange={(e) => patch(l.key, { unitPrice: e.target.value })}
                              aria-label="Unit price"
                            />
                          </td>
                          <td className="align-top">
                            <input
                              className="field text-right"
                              type="number"
                              step="any"
                              min="0"
                              max="100"
                              value={l.taxRate}
                              onChange={(e) => patch(l.key, { taxRate: e.target.value })}
                              aria-label="Tax rate"
                            />
                          </td>
                          <td className="num align-top">
                            <span className="tnum inline-block pt-2 font-500">
                              {lineTotal > 0 ? money(lineTotal) : "—"}
                            </span>
                          </td>
                          <td className="align-top">
                            <select
                              className="field"
                              value={l.compliance}
                              onChange={(e) => patch(l.key, { compliance: e.target.value })}
                              aria-label="Line compliance"
                            >
                              {COMPLIANCE_LEVELS.map((c) => (
                                <option key={c} value={c}>
                                  {humanize(c)}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </FormSection>

          <FormSection title="Charges and totals" columns={4}>
            <Field label="Delivery charges" name="deliveryCharges">
              <TextInput
                type="number"
                step="any"
                min="0"
                name="deliveryCharges"
                value={deliveryCharges}
                onChange={(e) => setDeliveryCharges(e.target.value)}
              />
            </Field>
            <Field label="Other charges" name="otherCharges">
              <TextInput
                type="number"
                step="any"
                min="0"
                name="otherCharges"
                value={otherCharges}
                onChange={(e) => setOtherCharges(e.target.value)}
              />
            </Field>
            <Field label="Discount" name="discount">
              <TextInput
                type="number"
                step="any"
                min="0"
                name="discount"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
              />
            </Field>
            <div>
              <div className="label mb-1">Quotation total</div>
              <div className="rounded-lg border border-border bg-surface-secondary px-2.5 py-2">
                <div className="tnum text-[1.0625rem] font-600">{money(totals.total)}</div>
                <div className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">
                  net {money(totals.net)} + tax {money(totals.tax)}
                </div>
              </div>
            </div>
            <Field label="Internal notes" name="notes" span>
              <TextArea name="notes" rows={2} defaultValue={existing?.notes ?? ""} />
            </Field>
          </FormSection>

          {lines.some((l) => l.compliance !== "COMPLIANT") && (
            <InlineAlert tone="warning">
              One or more lines are marked as less than fully compliant. Non-compliant offers cannot be awarded without
              a recorded justification, and the comparative will rank them accordingly.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

