"use client";

import { useState } from "react";
import Link from "next/link";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { money } from "@/lib/format";
import { createGatePassAction } from "@/app/(app)/receiving/actions";

const VEHICLE_TYPES = [
  "Suzuki Ravi / Bolan",
  "Shehzore",
  "Mazda / 6-wheeler",
  "10-wheeler truck",
  "22-wheeler trailer",
  "Container",
  "Car / van",
  "Motorcycle",
  "Other",
];

export function GatePassForm({
  stores,
  openPos,
  vendors,
  defaultPoId,
}: {
  stores: Array<{ id: string; name: string; kind: string }>;
  openPos: Array<{
    id: string;
    number: string;
    total: number;
    vendorId: string;
    vendorName: string;
    storeId: string | null;
    storeName: string | null;
  }>;
  vendors: Array<{ id: string; name: string; status: string }>;
  defaultPoId?: string;
}) {
  const [poId, setPoId] = useState(defaultPoId ?? "");
  const selectedPo = openPos.find((p) => p.id === poId);
  const [storeId, setStoreId] = useState(selectedPo?.storeId ?? stores[0]?.id ?? "");
  const [vendorId, setVendorId] = useState(selectedPo?.vendorId ?? "");

  const choosePo = (id: string) => {
    setPoId(id);
    const po = openPos.find((p) => p.id === id);
    if (po) {
      if (po.storeId) setStoreId(po.storeId);
      setVendorId(po.vendorId);
    }
  };

  return (
    <ActionForm
      action={createGatePassAction}
      submitLabel="Record gate pass"
      hiddenFields={{ poId: poId || undefined, vendorId: vendorId || undefined }}
      onSuccessRedirect={(data) => {
        const d = data as { id?: string } | null;
        return d?.id ? `/gate-passes/${d.id}` : "/gate-passes";
      }}
      secondary={
        <Link href="/gate-passes" className="btn btn-secondary">
          Cancel
        </Link>
      }
    >
      <InlineAlert tone="info">
        The gate pass is the first record of a delivery. It gets a unique serial, links to the purchase order, and routes
        the vehicle to the correct store — where physical verification happens next.
      </InlineAlert>

      <FormSection title="Delivery against" columns={2}>
        <Field
          label="Purchase order"
          name="poSelect"
          hint="Selecting the order fills the vendor and receiving store automatically."
        >
          <Select
            name="poSelect"
            placeholder="No purchase order (unsolicited or non-PO delivery)"
            options={openPos.map((p) => ({
              value: p.id,
              label: `${p.number} — ${p.vendorName} — ${money(p.total)}${p.storeName ? ` → ${p.storeName}` : ""}`,
            }))}
            value={poId}
            onChange={(e) => choosePo(e.target.value)}
          />
        </Field>
        <Field label="Vendor" name="vendorSelect" required={!poId}>
          <Select
            name="vendorSelect"
            placeholder="Select vendor…"
            options={vendors.map((v) => ({ value: v.id, label: `${v.name} — ${humanize(v.status)}` }))}
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
          />
        </Field>
        <Field label="Receiving store" name="storeId" required>
          <Select
            name="storeId"
            options={stores.map((s) => ({ value: s.id, label: `${s.name} · ${humanize(s.kind)}` }))}
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
          />
        </Field>
        <Field label="Arrival time" name="arrivedAt" hint="Leave blank to use the current time.">
          <TextInput type="datetime-local" name="arrivedAt" />
        </Field>
      </FormSection>

      <FormSection title="Vehicle & driver" columns={3}>
        <Field label="Vehicle number" name="vehicleNumber" required>
          <TextInput name="vehicleNumber" placeholder="e.g. LEA-4471" />
        </Field>
        <Field label="Vehicle type" name="vehicleType">
          <Select name="vehicleType" placeholder="Select…" options={VEHICLE_TYPES.map((v) => ({ value: v, label: v }))} />
        </Field>
        <Field label="Driver name" name="driverName" required>
          <TextInput name="driverName" />
        </Field>
        <Field label="Driver CNIC" name="driverCnic" hint="Recorded for site security.">
          <TextInput name="driverCnic" placeholder="00000-0000000-0" />
        </Field>
        <Field label="Driver phone" name="driverPhone">
          <TextInput name="driverPhone" placeholder="+92 300 0000000" />
        </Field>
      </FormSection>

      <FormSection title="Declared consignment" columns={2}>
        <Field label="Delivery note / challan" name="deliveryNoteRef" required>
          <TextInput name="deliveryNoteRef" placeholder="Vendor challan number" />
        </Field>
        <Field label="Vendor invoice reference" name="invoiceRef">
          <TextInput name="invoiceRef" placeholder="If the invoice travels with the goods" />
        </Field>
        <Field label="Declared packages" name="declaredPackages">
          <TextInput type="number" min="0" name="declaredPackages" />
        </Field>
        <Field label="Declared quantity" name="declaredQuantity" hint="As stated on the challan, before verification.">
          <TextInput type="number" step="any" min="0" name="declaredQuantity" />
        </Field>
        <Field label="Material summary" name="materialSummary" required span>
          <TextInput name="materialSummary" placeholder="e.g. 12 laptop cartons and 12 carry cases" />
        </Field>
        <Field
          label="Security remarks"
          name="securityRemarks"
          span
          hint="Seal condition, visible damage, document checks, anything noted at the gate."
        >
          <TextArea name="securityRemarks" rows={3} />
        </Field>
      </FormSection>
    </ActionForm>
  );
}
