"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { Badge, InlineAlert, SectionCard } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { money, percent, qty, round2, toInputDate } from "@/lib/format";
import { createPoAction } from "./actions";

const COLLATERAL_TYPES = ["SECURITY_CHEQUE", "BANK_GUARANTEE", "POST_DATED_CHEQUE", "NONE"];
const INCOTERMS = ["", "DDP — delivered duty paid", "EXW — ex works", "FOB — free on board", "CIF — cost, insurance, freight"];

export function PoForm({
  pr,
  award,
  stores,
  advance,
  defaultTaxRate,
}: {
  pr: {
    id: string;
    number: string;
    title: string;
    entityCode: string;
    requiredDate: string;
    deliveryStoreId: string | null;
    siteName: string | null;
    procurementType: string;
  };
  award: {
    comparativeNumber: string;
    vendorId: string;
    vendorName: string;
    vendorAddress: string | null;
    vendorPaymentTerms: string | null;
    vendorCreditDays: number | null;
    quoteNumber: string;
    quotedTotal: number;
    netTotal: number;
    negotiatedRounds: number;
    deliveryDays: number | null;
    warrantyTerms: string | null;
    lines: Array<{
      id: string;
      description: string;
      quantity: number;
      unit: string;
      quotedUnitPrice: number;
      appliedUnitPrice: number;
      taxRate: number;
    }>;
  };
  stores: Array<{ id: string; code: string; name: string; kind: string; address: string | null; siteId: string | null }>;
  advance: { allowed: boolean; maxPercent: number; requiresCollateral: boolean };
  defaultTaxRate: number;
}) {
  const [advanceRequired, setAdvanceRequired] = useState(false);
  const [advancePercent, setAdvancePercent] = useState(String(Math.min(25, advance.maxPercent)));
  const [collateralType, setCollateralType] = useState("SECURITY_CHEQUE");
  const [submitNow, setSubmitNow] = useState(true);
  const [storeId, setStoreId] = useState(pr.deliveryStoreId ?? stores[0]?.id ?? "");

  const totals = useMemo(() => {
    let net = 0;
    let tax = 0;
    for (const l of award.lines) {
      const lineNet = l.appliedUnitPrice * l.quantity;
      net += lineNet;
      tax += lineNet * (l.taxRate / 100);
    }
    return { net: round2(net), tax: round2(tax), total: round2(net + tax) };
  }, [award.lines]);

  const advanceAmount = round2((award.netTotal * (Number(advancePercent) || 0)) / 100);
  const store = stores.find((s) => s.id === storeId);
  const isMd = pr.procurementType === "MATERIAL_DEMAND";

  const defaultDeliveryDate = toInputDate(
    award.deliveryDays ? new Date(Date.now() + award.deliveryDays * 86400000) : new Date(pr.requiredDate),
  );

  return (
    <ActionForm
      action={createPoAction}
      submitLabel={submitNow ? "Create & submit for approval" : "Create draft purchase order"}
      hiddenFields={{ prId: pr.id, submitNow: submitNow ? "true" : "" }}
      onSuccessRedirect={(data) => {
        const d = data as { id?: string } | null;
        return d?.id ? `/po/${d.id}` : "/po";
      }}
      footerSticky
      secondary={
        <>
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={submitNow} onChange={(e) => setSubmitNow(e.target.checked)} />
            Submit for approval immediately
          </label>
          <Link href={`/pr/${pr.id}`} className="btn btn-secondary">
            Cancel
          </Link>
        </>
      }
    >
      <InlineAlert tone="info">
        Awarding <span className="font-600">{pr.number}</span> to <span className="font-600">{award.vendorName}</span> per
        comparative {award.comparativeNumber} and quotation {award.quoteNumber}.
        {award.negotiatedRounds > 0 && (
          <>
            {" "}
            Quoted {money(award.quotedTotal)}, negotiated to {money(award.netTotal)} across {award.negotiatedRounds}{" "}
            round(s) — the negotiated outcome is applied proportionally to every line below.
          </>
        )}
      </InlineAlert>

      <SectionCard title="Order lines" description="Priced from the awarded quotation with the negotiated outcome applied." bodyClassName="px-0 py-0">
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ minWidth: "18rem" }}>Description</th>
                <th className="text-right">Quantity</th>
                <th className="text-right">Quoted price</th>
                <th className="text-right">Applied price</th>
                <th className="text-right">Tax</th>
                <th className="text-right">Line total</th>
              </tr>
            </thead>
            <tbody>
              {award.lines.map((l) => {
                const lineNet = round2(l.appliedUnitPrice * l.quantity);
                const lineTax = round2(lineNet * (l.taxRate / 100));
                const changed = Math.abs(l.appliedUnitPrice - l.quotedUnitPrice) > 0.005;
                return (
                  <tr key={l.id}>
                    <td>{l.description}</td>
                    <td className="num">{qty(l.quantity, l.unit)}</td>
                    <td className="num">{money(l.quotedUnitPrice)}</td>
                    <td className="num font-500">
                      {money(l.appliedUnitPrice)}
                      {changed && (
                        <span className="block text-2xs text-[var(--c-success)]">
                          {percent(((l.appliedUnitPrice - l.quotedUnitPrice) / l.quotedUnitPrice) * 100)}
                        </span>
                      )}
                    </td>
                    <td className="num">
                      {money(lineTax)}
                      <span className="block text-2xs text-[var(--c-text-tertiary)]">{l.taxRate}%</span>
                    </td>
                    <td className="num font-500">{money(round2(lineNet + lineTax))}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} className="text-right">
                  Order value (net {money(totals.net)} + tax {money(totals.tax)})
                </td>
                <td className="num">{money(totals.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </SectionCard>

      <FormSection title="Vendor & delivery" columns={2}>
        <Field label="Vendor" name="vendorLabel">
          <div className="rounded-lg border border-border bg-surface-secondary px-2.5 py-2 text-[0.8125rem]">
            <span className="font-500">{award.vendorName}</span>
            {award.vendorAddress && (
              <span className="mt-0.5 block text-2xs text-muted">{award.vendorAddress}</span>
            )}
          </div>
        </Field>
        <Field
          label="Delivery location"
          name="deliveryStoreId"
          required
          hint={
            isMd
              ? "Material demands are received at the site store rather than routed through the central warehouse."
              : undefined
          }
        >
          <Select
            name="deliveryStoreId"
            options={stores.map((s) => ({ value: s.id, label: `${s.name} · ${humanize(s.kind)}` }))}
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
          />
        </Field>
        <Field label="Delivery address override" name="deliveryAddress" hint={store?.address ?? undefined}>
          <TextInput name="deliveryAddress" defaultValue={store?.address ?? ""} />
        </Field>
        <Field
          label="Promised delivery date"
          name="deliveryDate"
          required
          hint={
            award.deliveryDays
              ? `Vendor quoted a ${award.deliveryDays}-day lead time. Requisition needs it by ${pr.requiredDate}.`
              : `Requisition needs it by ${pr.requiredDate}.`
          }
        >
          <TextInput type="date" name="deliveryDate" defaultValue={defaultDeliveryDate} />
        </Field>
        <Field label="Payment terms" name="paymentTerms" required>
          <TextInput name="paymentTerms" defaultValue={award.vendorPaymentTerms ?? "30 days from invoice"} />
        </Field>
        <Field label="Credit days" name="creditDays">
          <TextInput type="number" min="0" name="creditDays" defaultValue={award.vendorCreditDays ?? 30} />
        </Field>
        <Field label="Warranty terms" name="warrantyTerms" span>
          <TextInput name="warrantyTerms" defaultValue={award.warrantyTerms ?? ""} />
        </Field>
        <Field label="Incoterms" name="incoterms">
          <Select
            name="incoterms"
            options={INCOTERMS.filter(Boolean).map((i) => ({ value: i, label: i }))}
            placeholder="Not specified"
          />
        </Field>
      </FormSection>

      {advance.allowed && (
        <FormSection
          title="Advance payment"
          description={`Advances are permitted for this entity up to ${advance.maxPercent}% of order value${advance.requiresCollateral ? ", and require collateral" : ""}.`}
          columns={2}
        >
          <div className="sm:col-span-full">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                name="advanceRequired"
                className="mt-0.5"
                checked={advanceRequired}
                onChange={(e) => setAdvanceRequired(e.target.checked)}
              />
              <span>
                <span className="block text-[0.8125rem] leading-5">This order requires an advance payment</span>
                <span className="block text-2xs leading-4 text-[var(--c-text-tertiary)]">
                  The advance goes to finance as its own task once the order is issued, and is settled against delivery.
                </span>
              </span>
            </label>
          </div>

          {advanceRequired && (
            <>
              <Field
                label="Advance percentage"
                name="advancePercent"
                required
                hint={`Maximum ${advance.maxPercent}% — ${money(advanceAmount)} on this order.`}
              >
                <TextInput
                  type="number"
                  min="1"
                  max={advance.maxPercent}
                  name="advancePercent"
                  value={advancePercent}
                  onChange={(e) => setAdvancePercent(e.target.value)}
                />
              </Field>
              <Field label="Collateral type" name="collateralType" required={advance.requiresCollateral}>
                <Select
                  name="collateralType"
                  options={COLLATERAL_TYPES.map((c) => ({ value: c, label: humanize(c) }))}
                  value={collateralType}
                  onChange={(e) => setCollateralType(e.target.value)}
                />
              </Field>
              <Field
                label="Collateral reference"
                name="collateralRef"
                required={advance.requiresCollateral}
                hint="Cheque number, guarantee number or instrument reference held against the advance."
              >
                <TextInput name="collateralRef" placeholder="e.g. UBL CHQ 4471209" />
              </Field>
              <Field label="Collateral notes" name="collateralNotes">
                <TextInput name="collateralNotes" placeholder="Who holds the instrument and under what conditions it is released" />
              </Field>
              {advance.requiresCollateral && (
                <div className="sm:col-span-full">
                  <InlineAlert tone="warning">
                    Collateral is mandatory for advances on this entity. The order cannot be issued without a recorded
                    collateral reference.
                  </InlineAlert>
                </div>
              )}
              {Number(advancePercent) > advance.maxPercent && (
                <div className="sm:col-span-full">
                  <InlineAlert tone="danger">
                    {advancePercent}% exceeds the {advance.maxPercent}% maximum configured for this entity and will be
                    refused.
                  </InlineAlert>
                </div>
              )}
            </>
          )}
        </FormSection>
      )}

      <FormSection title="Terms & conditions" columns={1}>
        <Field
          label="Purchase order terms"
          name="termsConditions"
          span
          hint="These print on the order and bind the vendor. Include inspection, rejection, replacement and documentation requirements."
        >
          <TextArea
            name="termsConditions"
            rows={6}
            defaultValue={`1. Delivery to ${store?.name ?? "the stated location"} during working hours against an inward gate pass.
2. Delivery challan must state the purchase order number, and serial or batch numbers where applicable.
3. Goods are subject to physical verification and, where configured, technical inspection before acceptance.
4. Rejected or short-supplied items are to be replaced within 7 days at no additional cost.
5. Invoice must be submitted against the accepted quantity only; over-invoicing will be refused at three-way match.
6. Warranty documentation must be registered in the buyer's name before the invoice is released for payment.`}
          />
        </Field>
      </FormSection>
    </ActionForm>
  );
}
