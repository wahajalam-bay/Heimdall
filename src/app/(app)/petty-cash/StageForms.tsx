"use client";

import { useMemo, useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Checkbox, Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { money, round2 } from "@/lib/format";
import {
  addQuoteAction,
  completeStoreEntryAction,
  recordPurchaseAction,
  selectQuoteAction,
} from "./actions";

const CHANNELS = ["PHYSICAL", "WHATSAPP", "EMAIL", "PHONE", "SKYPE", "WALK_IN"];

/* ── Record a market quote ────────────────────────────────── */

export function AddQuoteForm({
  requestId,
  vendors,
  quotesSoFar,
  minQuotes,
}: {
  requestId: string;
  vendors: Array<{ id: string; name: string }>;
  quotesSoFar: number;
  minQuotes: number;
}) {
  const [open, setOpen] = useState(false);
  const [vendorId, setVendorId] = useState("");
  const [vendorName, setVendorName] = useState("");

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Record market quote
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Record a market quote"
        description={`${quotesSoFar} of ${minQuotes} required quotation${minQuotes === 1 ? "" : "s"} recorded. Quotes taken over WhatsApp or by phone are acceptable, but the channel and contact reference must be stated.`}
        size="lg"
      >
        <ActionForm
          action={addQuoteAction}
          layout="bare"
          submitLabel="Record quote"
          hiddenFields={{ requestId, vendorId: vendorId || undefined }}
          resetOnSuccess
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Close
            </button>
          }
        >
          <FormSection columns={2}>
            <Field label="Registered vendor" name="vendorSelect" hint="Optional — most cash purchases are from local shops.">
              <Select
                name="vendorSelect"
                placeholder="Not a registered vendor"
                options={vendors.map((v) => ({ value: v.id, label: v.name }))}
                value={vendorId}
                onChange={(e) => {
                  setVendorId(e.target.value);
                  const v = vendors.find((x) => x.id === e.target.value);
                  if (v) setVendorName(v.name);
                }}
              />
            </Field>
            <Field label="Vendor / shop name" name="vendorName" required>
              <TextInput name="vendorName" value={vendorName} onChange={(e) => setVendorName(e.target.value)} />
            </Field>
            <Field label="Channel" name="channel" required hint="How the quote was obtained.">
              <Select
                name="channel"
                options={CHANNELS.map((c) => ({ value: c, label: humanize(c) }))}
                defaultValue="PHYSICAL"
              />
            </Field>
            <Field label="Contact reference" name="contactRef" hint="Phone number, WhatsApp handle or email the quote came from.">
              <TextInput name="contactRef" />
            </Field>
            <Field label="Quoted amount (PKR)" name="amount" required>
              <TextInput type="number" step="any" min="0" name="amount" />
            </Field>
            <Field label="Delivery in days" name="deliveryDays">
              <TextInput type="number" step="1" min="0" name="deliveryDays" />
            </Field>
            <Field label="Tax" name="taxIncluded">
              <Checkbox name="taxIncluded" label="Quoted amount includes tax" />
            </Field>
            <Field label="Notes" name="notes" span>
              <TextArea name="notes" rows={2} placeholder="Anything relevant — warranty, condition, stock availability." />
            </Field>
          </FormSection>
        </ActionForm>
      </Modal>
    </>
  );
}

/* ── Select the winning quote ─────────────────────────────── */

export function SelectQuoteForm({
  requestId,
  quotes,
}: {
  requestId: string;
  quotes: Array<{ id: string; vendorName: string; amount: number; channel: string; deliveryDays: number | null }>;
}) {
  const [open, setOpen] = useState(false);
  const lowest = useMemo(() => Math.min(...quotes.map((q) => q.amount)), [quotes]);
  const [quoteId, setQuoteId] = useState(quotes.find((q) => q.amount === lowest)?.id ?? "");
  const chosen = quotes.find((q) => q.id === quoteId);
  const notLowest = !!chosen && chosen.amount > lowest + 0.01;

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Select quote
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Select the winning quote"
        description="Choosing anything other than the lowest quote requires a written justification, which is kept on the record."
        size="lg"
      >
        <ActionForm
          action={selectQuoteAction}
          layout="bare"
          submitLabel="Select and send for approval"
          hiddenFields={{ requestId, quoteId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <div className="space-y-2">
            {quotes.map((q) => {
              const isLowest = q.amount <= lowest + 0.01;
              return (
                <label
                  key={q.id}
                  className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-2.5 ${
                    quoteId === q.id
                      ? "border-[var(--c-accent)] bg-[var(--c-accent-soft)]"
                      : "border-border"
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <input
                      type="radio"
                      name="quoteChoice"
                      checked={quoteId === q.id}
                      onChange={() => setQuoteId(q.id)}
                    />
                    <span>
                      <span className="block text-xs font-500">{q.vendorName}</span>
                      <span className="block text-2xs text-[var(--c-text-tertiary)]">
                        {humanize(q.channel)}
                        {q.deliveryDays !== null ? ` · ${q.deliveryDays} day delivery` : ""}
                      </span>
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {isLowest && <span className="badge badge-success">Lowest</span>}
                    <span className="tnum text-xs font-600">{money(q.amount)}</span>
                  </span>
                </label>
              );
            })}
          </div>

          <FormSection columns={1}>
            <Field
              label="Justification"
              name="justification"
              required={notLowest}
              hint={
                notLowest
                  ? "Mandatory — this is not the lowest quote."
                  : "Optional when selecting the lowest quote."
              }
            >
              <TextArea
                name="justification"
                rows={3}
                placeholder="e.g. Lowest quote was for a non-branded refill; this vendor supplies the certified type required by the fire inspection."
              />
            </Field>
          </FormSection>

          {notLowest && (
            <InlineAlert tone="warning">
              {chosen?.vendorName} at {money(chosen?.amount ?? 0)} is {money(round2((chosen?.amount ?? 0) - lowest))}{" "}
              above the lowest quote. The server will refuse the selection without a justification.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

/* ── Record the actual purchase ───────────────────────────── */

export function RecordPurchaseForm({
  requestId,
  approvedAmount,
  items,
  defaultVendor,
}: {
  requestId: string;
  approvedAmount: number;
  items: Array<{ id: string; description: string; quantity: number; unit: string; estimatedUnitPrice: number | null }>;
  defaultVendor: string;
}) {
  const [open, setOpen] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [total, setTotal] = useState("");

  const lineSum = round2(Object.values(amounts).reduce((a, v) => a + (Number(v) || 0), 0));
  const declared = Number(total) || 0;
  const mismatch = lineSum > 0 && declared > 0 && Math.abs(lineSum - declared) > 1;
  const variance = declared > 0 && approvedAmount > 0 ? round2(declared - approvedAmount) : 0;

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Record purchase
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Record the purchase"
        description="Enter what was actually spent and attach the receipt. The voucher cannot be generated until a receipt is on file."
        size="lg"
      >
        <ActionForm
          action={recordPurchaseAction}
          layout="bare"
          submitLabel="Record purchase"
          hiddenFields={{
            requestId,
            lineAmounts: JSON.stringify(
              Object.fromEntries(
                Object.entries(amounts)
                  .filter(([, v]) => v !== "" && Number(v) >= 0)
                  .map(([k, v]) => [k, Number(v)]),
              ),
            ),
          }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={2}>
            <Field label="Purchased from" name="purchasedFromVendor" required>
              <TextInput name="purchasedFromVendor" defaultValue={defaultVendor} />
            </Field>
            <Field label="Receipt reference" name="receiptRef" hint="Cash memo or receipt number.">
              <TextInput name="receiptRef" />
            </Field>
            <Field
              label="Total actually spent (PKR)"
              name="actualAmount"
              required
              hint={approvedAmount > 0 ? `Approved: ${money(approvedAmount)}` : undefined}
            >
              <TextInput
                type="number"
                step="any"
                min="0"
                name="actualAmount"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
              />
            </Field>
          </FormSection>

          <div className="table-wrap rounded-xl border border-border">
            <table className="dt">
              <thead>
                <tr>
                  <th>Line</th>
                  <th className="text-right">Quantity</th>
                  <th className="text-right">Estimated</th>
                  <th className="text-right">Actual line amount</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td className="text-xs">{it.description}</td>
                    <td className="num text-xs">
                      {it.quantity} {it.unit}
                    </td>
                    <td className="num text-xs">
                      {it.estimatedUnitPrice ? money(round2(it.estimatedUnitPrice * it.quantity)) : "—"}
                    </td>
                    <td>
                      <input
                        className="field text-right"
                        type="number"
                        step="any"
                        min="0"
                        value={amounts[it.id] ?? ""}
                        onChange={(e) => setAmounts((p) => ({ ...p, [it.id]: e.target.value }))}
                        aria-label={`Actual amount for ${it.description}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="text-xs font-600">
                    Line total
                  </td>
                  <td className="num text-xs font-600">{lineSum > 0 ? money(lineSum) : "—"}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {mismatch && (
            <InlineAlert tone="warning">
              The line amounts add up to {money(lineSum)} but the declared total is {money(declared)}. Correct one of them
              so the receipt reconciles.
            </InlineAlert>
          )}
          {variance !== 0 && approvedAmount > 0 && Math.abs(variance) / approvedAmount > 0.1 && (
            <InlineAlert tone="warning">
              This is {money(Math.abs(variance))} {variance > 0 ? "more" : "less"} than the approved{" "}
              {money(approvedAmount)} — more than 10%. The purchase is allowed but a price variance exception will be
              raised for review.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

/* ── Store entry — the gap this system closes ─────────────── */

export function StoreEntryForm({
  requestId,
  stores,
  defaultStoreId,
  catalogue,
  items,
}: {
  requestId: string;
  stores: Array<{ id: string; code: string; name: string; kind: string }>;
  defaultStoreId: string | null;
  catalogue: Array<{ id: string; sku: string; name: string; unit: string }>;
  items: Array<{
    id: string;
    description: string;
    quantity: number;
    unit: string;
    disposition: string;
    itemId: string | null;
    actualUnitPrice: number | null;
    estimatedUnitPrice: number | null;
    storeEntered: boolean;
  }>;
}) {
  const [open, setOpen] = useState(false);
  const pending = items.filter((i) => !i.storeEntered);
  const [lines, setLines] = useState<Record<string, { itemId: string; quantity: string; unitCost: string }>>(() =>
    Object.fromEntries(
      pending.map((i) => [
        i.id,
        {
          itemId: i.itemId ?? "",
          quantity: String(i.quantity),
          unitCost: String(i.actualUnitPrice ?? i.estimatedUnitPrice ?? 0),
        },
      ]),
    ),
  );

  const payload = JSON.stringify(
    Object.entries(lines)
      .filter(([, v]) => v.itemId && Number(v.quantity) > 0)
      .map(([pettyCashItemId, v]) => ({
        pettyCashItemId,
        itemId: v.itemId,
        quantity: Number(v.quantity),
        unitCost: Number(v.unitCost) || 0,
      })),
  );

  const unmapped = pending.filter((i) => !lines[i.id]?.itemId);

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Record store entry
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Record the store entry"
        description="Each stored line must be booked against a catalogue item so it lands in inventory. Until every one is booked, this request cannot be reconciled or closed."
        size="xl"
      >
        <ActionForm
          action={completeStoreEntryAction}
          layout="bare"
          submitLabel="Post store entry to inventory"
          hiddenFields={{ requestId, lines: payload }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={2}>
            <Field label="Store" name="storeId" required>
              <Select
                name="storeId"
                placeholder="Select the receiving store…"
                options={stores.map((s) => ({ value: s.id, label: `${s.name} · ${humanize(s.kind)}` }))}
                defaultValue={defaultStoreId ?? undefined}
              />
            </Field>
          </FormSection>

          <div className="table-wrap rounded-xl border border-border">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ minWidth: "14rem" }}>Purchased line</th>
                  <th style={{ width: "7rem" }}>Disposition</th>
                  <th style={{ minWidth: "14rem" }}>Book against catalogue item</th>
                  <th className="text-right" style={{ width: "8rem" }}>Quantity</th>
                  <th className="text-right" style={{ width: "9rem" }}>Unit cost</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((i) => {
                  const row = lines[i.id] ?? { itemId: "", quantity: String(i.quantity), unitCost: "0" };
                  return (
                    <tr key={i.id}>
                      <td className="text-xs">
                        {i.description}
                        <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                          {i.quantity} {i.unit} purchased
                        </span>
                      </td>
                      <td className="text-2xs">{humanize(i.disposition)}</td>
                      <td>
                        <select
                          className="field"
                          value={row.itemId}
                          onChange={(e) =>
                            setLines((p) => ({ ...p, [i.id]: { ...row, itemId: e.target.value } }))
                          }
                          aria-label="Catalogue item"
                        >
                          <option value="">Select item…</option>
                          {catalogue.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.sku} — {c.name}
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
                          max={i.quantity}
                          value={row.quantity}
                          onChange={(e) => setLines((p) => ({ ...p, [i.id]: { ...row, quantity: e.target.value } }))}
                          aria-label="Quantity"
                        />
                      </td>
                      <td>
                        <input
                          className="field text-right"
                          type="number"
                          step="any"
                          min="0"
                          value={row.unitCost}
                          onChange={(e) => setLines((p) => ({ ...p, [i.id]: { ...row, unitCost: e.target.value } }))}
                          aria-label="Unit cost"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {unmapped.length > 0 && (
            <InlineAlert tone="warning">
              {unmapped.length} line{unmapped.length === 1 ? "" : "s"} still have no catalogue item. Unmapped lines will
              not be posted, and the request stays blocked until they are.
            </InlineAlert>
          )}
          <InlineAlert tone="info">
            Posting writes a permanent receipt into the inventory ledger at the cost you enter here — the same ledger a
            GRN writes to.
          </InlineAlert>
        </ActionForm>
      </Modal>
    </>
  );
}
