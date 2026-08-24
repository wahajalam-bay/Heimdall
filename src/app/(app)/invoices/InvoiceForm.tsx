"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ActionForm } from "@/components/ui/forms";
import { Checkbox, Field, FormSection, Select, TextInput } from "@/components/ui/field";
import { Badge, InlineAlert } from "@/components/ui/primitives";
import { fmtDate, money, round2, toInputDate } from "@/lib/format";
import { registerInvoiceAction } from "./actions";

export type InvoicePo = {
  id: string;
  number: string;
  total: number;
  currency: string;
  vendorId: string;
  vendorName: string;
  items: Array<{
    id: string;
    lineNo: number;
    description: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    taxRate: number;
    acceptedQty: number;
    invoicedQty: number;
  }>;
  grns: Array<{ id: string; number: string; receivedAt: string; totalValue: number }>;
  invoices: Array<{ id: string; number: string; total: number; status: string }>;
};

type Line = {
  poItemId: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxRate: string;
};

/**
 * Invoice registration. The form deliberately shows what was ordered, what was
 * actually accepted and what has already been invoiced on every line, so a
 * mismatch is visible before it is submitted — the server still refuses to let
 * a failing match reach payment.
 */
export function InvoiceForm({ pos, defaultPoId }: { pos: InvoicePo[]; defaultPoId?: string }) {
  const [poId, setPoId] = useState(defaultPoId && pos.some((p) => p.id === defaultPoId) ? defaultPoId : (pos[0]?.id ?? ""));
  const po = pos.find((p) => p.id === poId);

  const [lines, setLines] = useState<Record<string, Line>>({});
  const [grnIds, setGrnIds] = useState<string[]>([]);
  const [charges, setCharges] = useState({ delivery: "", other: "", discount: "", withholding: "" });

  // Reset the line editor whenever the order changes, defaulting to accepted quantities.
  const activeLines = useMemo(() => {
    if (!po) return [] as Array<Line & { poItem: InvoicePo["items"][number] }>;
    return po.items.map((it) => {
      const outstanding = round2(Math.max(0, it.acceptedQty - it.invoicedQty));
      const existing = lines[it.id];
      return {
        poItem: it,
        poItemId: it.id,
        description: existing?.description ?? it.description,
        quantity: existing?.quantity ?? String(outstanding || 0),
        unit: existing?.unit ?? it.unit,
        unitPrice: existing?.unitPrice ?? String(it.unitPrice),
        taxRate: existing?.taxRate ?? String(it.taxRate),
      };
    });
  }, [po, lines]);

  const patch = (id: string, changes: Partial<Line>) =>
    setLines((prev) => {
      const base = activeLines.find((l) => l.poItemId === id);
      const current = prev[id] ?? {
        poItemId: id,
        description: base?.description ?? "",
        quantity: base?.quantity ?? "0",
        unit: base?.unit ?? "EA",
        unitPrice: base?.unitPrice ?? "0",
        taxRate: base?.taxRate ?? "0",
      };
      return { ...prev, [id]: { ...current, ...changes } };
    });

  const totals = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    for (const l of activeLines) {
      const q = Number(l.quantity) || 0;
      const p = Number(l.unitPrice) || 0;
      const t = Number(l.taxRate) || 0;
      const lineNet = q * p;
      subtotal += lineNet;
      tax += (lineNet * t) / 100;
    }
    const delivery = Number(charges.delivery) || 0;
    const other = Number(charges.other) || 0;
    const discount = Number(charges.discount) || 0;
    const withholding = Number(charges.withholding) || 0;
    const total = round2(subtotal + tax + delivery + other - discount);
    return {
      subtotal: round2(subtotal),
      tax: round2(tax),
      total,
      netPayable: round2(total - withholding),
    };
  }, [activeLines, charges]);

  const warnings = useMemo(() => {
    const out: string[] = [];
    if (!po) return out;
    for (const l of activeLines) {
      const q = Number(l.quantity) || 0;
      const outstanding = round2(Math.max(0, l.poItem.acceptedQty - l.poItem.invoicedQty));
      if (q > outstanding + 1e-9) {
        out.push(
          `${l.poItem.description}: invoicing ${q} ${l.unit} but only ${outstanding} ${l.unit} has been accepted and not yet invoiced. This will fail the three-way match.`,
        );
      }
      const p = Number(l.unitPrice) || 0;
      if (Math.abs(p - l.poItem.unitPrice) > 0.01) {
        out.push(
          `${l.poItem.description}: unit price ${money(p)} differs from the ordered ${money(l.poItem.unitPrice)}.`,
        );
      }
    }
    if (po.grns.length === 0) {
      out.push("No posted goods receipt exists on this order. Payment cannot be released against an invoice with no GRN.");
    }
    return out;
  }, [po, activeLines]);

  const payload = JSON.stringify(
    activeLines
      .filter((l) => (Number(l.quantity) || 0) > 0)
      .map((l) => ({
        poItemId: l.poItemId,
        description: l.description,
        quantity: Number(l.quantity),
        unit: l.unit,
        unitPrice: Number(l.unitPrice) || 0,
        taxRate: Number(l.taxRate) || 0,
      })),
  );

  return (
    <ActionForm
      action={registerInvoiceAction}
      submitLabel="Register invoice and run match"
      hiddenFields={{ poId, items: payload }}
      onSuccessRedirect={(data) => {
        const d = data as { id?: string } | null;
        return d?.id ? `/invoices/${d.id}` : "/invoices";
      }}
      footerSticky
      secondary={
        <Link href="/invoices" className="btn btn-secondary">
          Cancel
        </Link>
      }
    >
      {grnIds.map((id) => (
        <input key={id} type="hidden" name="grnIds" value={id} />
      ))}

      <InlineAlert tone="info">
        Registering an invoice runs the three-way match immediately: purchase order against goods received against
        invoice. A failing match is recorded and blocks payment — it is never silently accepted.
      </InlineAlert>

      <FormSection title="Invoice" columns={3}>
        <Field label="Purchase order" name="poSelect" required>
          <Select
            name="poSelect"
            value={poId}
            onChange={(e) => {
              setPoId(e.target.value);
              setLines({});
              setGrnIds([]);
            }}
            options={pos.map((p) => ({ value: p.id, label: `${p.number} — ${p.vendorName} · ${money(p.total)}` }))}
          />
        </Field>
        <Field label="Vendor invoice number" name="vendorInvoiceNumber" required hint="Exactly as printed on the vendor's invoice.">
          <TextInput name="vendorInvoiceNumber" />
        </Field>
        <Field label="Invoice date" name="invoiceDate" required>
          <TextInput type="date" name="invoiceDate" defaultValue={toInputDate(new Date())} />
        </Field>
        <Field label="Due date" name="dueDate" hint="From the vendor's payment terms.">
          <TextInput type="date" name="dueDate" />
        </Field>
        <Field label="Delivery charges" name="deliveryCharges">
          <TextInput
            type="number"
            step="any"
            min="0"
            name="deliveryCharges"
            value={charges.delivery}
            onChange={(e) => setCharges((c) => ({ ...c, delivery: e.target.value }))}
          />
        </Field>
        <Field label="Other charges" name="otherCharges">
          <TextInput
            type="number"
            step="any"
            min="0"
            name="otherCharges"
            value={charges.other}
            onChange={(e) => setCharges((c) => ({ ...c, other: e.target.value }))}
          />
        </Field>
        <Field label="Discount" name="discount">
          <TextInput
            type="number"
            step="any"
            min="0"
            name="discount"
            value={charges.discount}
            onChange={(e) => setCharges((c) => ({ ...c, discount: e.target.value }))}
          />
        </Field>
        <Field label="Withholding tax" name="withholdingTax" hint="Deducted at source; reduces the net payable.">
          <TextInput
            type="number"
            step="any"
            min="0"
            name="withholdingTax"
            value={charges.withholding}
            onChange={(e) => setCharges((c) => ({ ...c, withholding: e.target.value }))}
          />
        </Field>
      </FormSection>

      {po && (
        <>
          <FormSection title="Lines" columns={1} description="Quantities default to what has been accepted and not yet invoiced.">
            <div className="sm:col-span-full">
              <div className="overflow-hidden rounded-xl border border-border">
                <table className="dt">
                  <thead>
                    <tr>
                      <th style={{ minWidth: "16rem" }}>Ordered line</th>
                      <th className="text-right" style={{ width: "6.5rem" }}>Ordered</th>
                      <th className="text-right" style={{ width: "6.5rem" }}>Accepted</th>
                      <th className="text-right" style={{ width: "7rem" }}>Already invoiced</th>
                      <th className="text-right" style={{ width: "7.5rem" }}>Invoice qty</th>
                      <th className="text-right" style={{ width: "8.5rem" }}>Unit price</th>
                      <th className="text-right" style={{ width: "6rem" }}>Tax %</th>
                      <th className="text-right" style={{ width: "9rem" }}>Line total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeLines.map((l) => {
                      const q = Number(l.quantity) || 0;
                      const p = Number(l.unitPrice) || 0;
                      const t = Number(l.taxRate) || 0;
                      const outstanding = round2(Math.max(0, l.poItem.acceptedQty - l.poItem.invoicedQty));
                      const over = q > outstanding + 1e-9;
                      const priceOff = Math.abs(p - l.poItem.unitPrice) > 0.01;
                      return (
                        <tr key={l.poItemId} className={over ? "bg-[var(--c-danger-soft)]/40" : undefined}>
                          <td>
                            <span className="block text-xs font-500">{l.poItem.description}</span>
                            <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                              Line {l.poItem.lineNo} · ordered at {money(l.poItem.unitPrice)}
                            </span>
                          </td>
                          <td className="num text-xs">{l.poItem.quantity}</td>
                          <td className="num text-xs">{l.poItem.acceptedQty}</td>
                          <td className="num text-xs">{l.poItem.invoicedQty}</td>
                          <td>
                            <input
                              className="field text-right"
                              type="number"
                              step="any"
                              min="0"
                              value={l.quantity}
                              onChange={(e) => patch(l.poItemId, { quantity: e.target.value })}
                              aria-label={`Invoice quantity for ${l.poItem.description}`}
                            />
                          </td>
                          <td>
                            <input
                              className={`field text-right ${priceOff ? "border-[var(--c-warning-border)]" : ""}`}
                              type="number"
                              step="any"
                              min="0"
                              value={l.unitPrice}
                              onChange={(e) => patch(l.poItemId, { unitPrice: e.target.value })}
                              aria-label={`Unit price for ${l.poItem.description}`}
                            />
                          </td>
                          <td>
                            <input
                              className="field text-right"
                              type="number"
                              step="any"
                              min="0"
                              value={l.taxRate}
                              onChange={(e) => patch(l.poItemId, { taxRate: e.target.value })}
                              aria-label={`Tax rate for ${l.poItem.description}`}
                            />
                          </td>
                          <td className="num text-xs">
                            <span className="tnum inline-block pt-2">{money(round2(q * p * (1 + t / 100)))}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </FormSection>

          <FormSection title="Goods receipts covered" columns={1}>
            <div className="sm:col-span-full">
              {po.grns.length === 0 ? (
                <InlineAlert tone="danger">
                  No posted goods receipt exists on {po.number}. An invoice can be registered for the record, but payment
                  is refused until goods have actually been received and a GRN posted.
                </InlineAlert>
              ) : (
                <div className="space-y-1.5">
                  {po.grns.map((g) => (
                    <Checkbox
                      key={g.id}
                      label={`${g.number} — ${money(g.totalValue)}`}
                      hint={`Received ${fmtDate(g.receivedAt)}`}
                      checked={grnIds.includes(g.id)}
                      onChange={() =>
                        setGrnIds((prev) => (prev.includes(g.id) ? prev.filter((x) => x !== g.id) : [...prev, g.id]))
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          </FormSection>

          {po.invoices.length > 0 && (
            <FormSection title="Invoices already on this order" columns={1}>
              <div className="sm:col-span-full">
                <ul className="space-y-1.5">
                  {po.invoices.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-3 text-xs">
                      <span>{i.number}</span>
                      <span className="flex items-center gap-2">
                        <Badge tone="neutral">{i.status.replace(/_/g, " ")}</Badge>
                        <span className="tnum">{money(i.total)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </FormSection>
          )}

          <div className="rounded-xl border border-border px-3.5 py-3">
            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <span className="label block">Subtotal</span>
                <span className="tnum text-[0.9375rem] font-600">{money(totals.subtotal)}</span>
              </div>
              <div>
                <span className="label block">Tax</span>
                <span className="tnum text-[0.9375rem] font-600">{money(totals.tax)}</span>
              </div>
              <div>
                <span className="label block">Invoice total</span>
                <span className="tnum text-[0.9375rem] font-600">{money(totals.total)}</span>
              </div>
              <div>
                <span className="label block">Net payable</span>
                <span className="tnum text-[0.9375rem] font-600">{money(totals.netPayable)}</span>
              </div>
            </div>
            <p className="mt-2 text-2xs text-[var(--c-text-tertiary)]">
              Order value {money(po.total)} · vendor {po.vendorName}
            </p>
          </div>

          {warnings.length > 0 && (
            <div className="rounded-2xl alert-warning px-3.5 py-3">
              <p className="text-[0.8125rem] font-600 text-[var(--c-warning)]">
                These differences will be flagged by the three-way match
              </p>
              <ul className="mt-1.5 space-y-1 pl-5 text-xs leading-5 text-muted">
                {warnings.map((w, i) => (
                  <li key={i} className="list-disc">
                    {w}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-2xs text-[var(--c-text-tertiary)]">
                Register it anyway if this is genuinely what the vendor invoiced — the mismatch belongs on the record, not
                hidden by adjusting the numbers.
              </p>
            </div>
          )}
        </>
      )}
    </ActionForm>
  );
}
