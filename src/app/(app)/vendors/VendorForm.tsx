"use client";

import { useState } from "react";
import Link from "next/link";
import { ActionForm } from "@/components/ui/forms";
import { Checkbox, Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { createVendorAction, updateVendorAction } from "./actions";

const BUSINESS_TYPES = ["MANUFACTURER", "DISTRIBUTOR", "TRADER", "SERVICE_PROVIDER", "CONTRACTOR", "RETAILER"];
const TAX_STATUSES = ["FILER", "NON_FILER", "EXEMPT", "UNREGISTERED"];
const SOURCE_CHANNELS = ["INTERNET", "REFERENCE", "RELATIONSHIP", "MEDIA", "EMAIL", "WALK_IN", "MARKET", "TENDER"];

export type VendorFormValues = {
  id?: string;
  name: string;
  legalName: string | null;
  businessType: string;
  address: string | null;
  city: string | null;
  country: string;
  contactPerson: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  website: string | null;
  taxStatus: string;
  ntn: string | null;
  strn: string | null;
  registrationNumber: string | null;
  officeCount: number | null;
  citiesCovered: string | null;
  workforceCount: number | null;
  hasTransportation: boolean;
  transportationNotes: string | null;
  supportStaffCount: number | null;
  paymentTerms: string | null;
  creditDays: number | null;
  bankName: string | null;
  bankAccountTitle: string | null;
  bankAccountNumber: string | null;
  bankIban: string | null;
  references: string | null;
  productsServices: string | null;
  categories: string | null;
  sourceChannel: string;
  sourceNotes: string | null;
  isTrader: boolean;
  minimumOrderValue: number | null;
  entityIds: string[];
};

/**
 * Vendor registration and editing. The profile fields mirror what the
 * pre-qualification criteria actually score, so an evaluator is never left
 * guessing.
 */
export function VendorForm({
  entities,
  categories,
  initial,
  canSeeFinancials,
}: {
  entities: Array<{ id: string; code: string; name: string }>;
  categories: Array<{ id: string; code: string; name: string }>;
  initial?: VendorFormValues;
  canSeeFinancials: boolean;
}) {
  const editing = !!initial?.id;
  const [isTrader, setIsTrader] = useState(initial?.isTrader ?? false);
  const [hasTransport, setHasTransport] = useState(initial?.hasTransportation ?? false);
  const [selectedEntities, setSelectedEntities] = useState<string[]>(initial?.entityIds ?? entities.map((e) => e.id));
  const [selectedCategories, setSelectedCategories] = useState<string[]>(
    initial?.categories
      ? initial.categories
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
      : [],
  );

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

  return (
    <ActionForm
      action={editing ? updateVendorAction : createVendorAction}
      submitLabel={editing ? "Save vendor" : "Register vendor"}
      hiddenFields={{
        vendorId: initial?.id,
        categories: selectedCategories.join(", ") || undefined,
      }}
      draftKey={editing ? undefined : "vendor-new"}
      onSuccessRedirect={(data) => {
        const d = data as { id?: string } | null;
        return d?.id ? `/vendors/${d.id}` : "/vendors";
      }}
      footerSticky
      secondary={
        <Link href={editing ? `/vendors/${initial?.id}` : "/vendors"} className="btn btn-secondary">
          Cancel
        </Link>
      }
    >
      {selectedEntities.map((id) => (
        <input key={id} type="hidden" name="entityIds" value={id} />
      ))}

      {!editing && (
        <InlineAlert tone="info">
          Registering a vendor does not make it usable. It stays a prospect until a pre-qualification evaluation is
          scored and an authorised approver accepts it — RFQs and purchase orders are refused before then.
        </InlineAlert>
      )}

      <FormSection title="Identity" columns={3}>
        <Field label="Trading name" name="name" required>
          <TextInput name="name" defaultValue={initial?.name} />
        </Field>
        <Field label="Registered legal name" name="legalName">
          <TextInput name="legalName" defaultValue={initial?.legalName ?? ""} />
        </Field>
        <Field label="Business type" name="businessType" required>
          <Select
            name="businessType"
            options={BUSINESS_TYPES.map((b) => ({ value: b, label: humanize(b) }))}
            defaultValue={initial?.businessType ?? "DISTRIBUTOR"}
          />
        </Field>
        <Field label="Contact person" name="contactPerson">
          <TextInput name="contactPerson" defaultValue={initial?.contactPerson ?? ""} />
        </Field>
        <Field label="Phone" name="contactPhone">
          <TextInput name="contactPhone" defaultValue={initial?.contactPhone ?? ""} />
        </Field>
        <Field label="Email" name="contactEmail">
          <TextInput type="email" name="contactEmail" defaultValue={initial?.contactEmail ?? ""} />
        </Field>
        <Field label="City" name="city">
          <TextInput name="city" defaultValue={initial?.city ?? ""} />
        </Field>
        <Field label="Country" name="country">
          <TextInput name="country" defaultValue={initial?.country ?? "Pakistan"} />
        </Field>
        <Field label="Website" name="website">
          <TextInput name="website" defaultValue={initial?.website ?? ""} />
        </Field>
        <Field label="Address" name="address" span>
          <TextArea name="address" rows={2} defaultValue={initial?.address ?? ""} />
        </Field>
      </FormSection>

      <FormSection title="Registration and tax" columns={3}>
        <Field label="Tax status" name="taxStatus" required hint="Filer status affects withholding.">
          <Select
            name="taxStatus"
            options={TAX_STATUSES.map((t) => ({ value: t, label: humanize(t) }))}
            defaultValue={initial?.taxStatus ?? "FILER"}
          />
        </Field>
        <Field label="NTN" name="ntn">
          <TextInput name="ntn" defaultValue={initial?.ntn ?? ""} />
        </Field>
        <Field label="STRN" name="strn">
          <TextInput name="strn" defaultValue={initial?.strn ?? ""} />
        </Field>
        <Field label="Registration / incorporation number" name="registrationNumber">
          <TextInput name="registrationNumber" defaultValue={initial?.registrationNumber ?? ""} />
        </Field>
        <Field label="Source channel" name="sourceChannel" hint="How this vendor came to us.">
          <Select
            name="sourceChannel"
            options={SOURCE_CHANNELS.map((s) => ({ value: s, label: humanize(s) }))}
            defaultValue={initial?.sourceChannel ?? "MARKET"}
          />
        </Field>
        <Field label="Source notes" name="sourceNotes">
          <TextInput name="sourceNotes" defaultValue={initial?.sourceNotes ?? ""} />
        </Field>
      </FormSection>

      <FormSection title="Capacity" columns={3} description="These fields are what the pre-qualification criteria score.">
        <Field label="Number of offices" name="officeCount">
          <TextInput type="number" min="0" step="1" name="officeCount" defaultValue={initial?.officeCount ?? ""} />
        </Field>
        <Field label="Cities covered" name="citiesCovered">
          <TextInput name="citiesCovered" defaultValue={initial?.citiesCovered ?? ""} placeholder="Lahore, Karachi, Islamabad" />
        </Field>
        <Field label="Workforce" name="workforceCount">
          <TextInput type="number" min="0" step="1" name="workforceCount" defaultValue={initial?.workforceCount ?? ""} />
        </Field>
        <Field label="Support staff" name="supportStaffCount">
          <TextInput
            type="number"
            min="0"
            step="1"
            name="supportStaffCount"
            defaultValue={initial?.supportStaffCount ?? ""}
          />
        </Field>
        <Field label="Transportation" name="hasTransportation">
          <Checkbox
            name="hasTransportation"
            label="Owns delivery transport"
            checked={hasTransport}
            onChange={(e) => setHasTransport(e.target.checked)}
          />
        </Field>
        <Field label="Transport notes" name="transportationNotes">
          <TextInput
            name="transportationNotes"
            defaultValue={initial?.transportationNotes ?? ""}
            disabled={!hasTransport}
          />
        </Field>
        <Field label="Products and services" name="productsServices" span>
          <TextArea name="productsServices" rows={2} defaultValue={initial?.productsServices ?? ""} />
        </Field>
        <Field label="References" name="references" span hint="Other clients who can vouch for delivery.">
          <TextArea name="references" rows={2} defaultValue={initial?.references ?? ""} />
        </Field>
      </FormSection>

      <FormSection title="Commercial terms" columns={3}>
        <Field label="Payment terms" name="paymentTerms">
          <TextInput name="paymentTerms" defaultValue={initial?.paymentTerms ?? ""} placeholder="e.g. 30 days from GRN" />
        </Field>
        <Field label="Credit days" name="creditDays">
          <TextInput type="number" min="0" step="1" name="creditDays" defaultValue={initial?.creditDays ?? ""} />
        </Field>
        <Field label="Trader" name="isTrader" hint="Traders are tracked separately for MOQ decisions.">
          <Checkbox
            name="isTrader"
            label="This vendor is a trader, not the principal"
            checked={isTrader}
            onChange={(e) => setIsTrader(e.target.checked)}
          />
        </Field>
        <Field
          label="Minimum order value (PKR)"
          name="minimumOrderValue"
          hint="Used when comparing a principal's MOQ against a trader."
        >
          <TextInput
            type="number"
            min="0"
            step="any"
            name="minimumOrderValue"
            defaultValue={initial?.minimumOrderValue ?? ""}
          />
        </Field>
      </FormSection>

      {canSeeFinancials && (
        <FormSection
          title="Banking"
          columns={2}
          description="Visible only to roles holding the vendor financials permission. Payments are released against these details."
        >
          <Field label="Bank" name="bankName">
            <TextInput name="bankName" defaultValue={initial?.bankName ?? ""} />
          </Field>
          <Field label="Account title" name="bankAccountTitle">
            <TextInput name="bankAccountTitle" defaultValue={initial?.bankAccountTitle ?? ""} />
          </Field>
          <Field label="Account number" name="bankAccountNumber">
            <TextInput name="bankAccountNumber" defaultValue={initial?.bankAccountNumber ?? ""} />
          </Field>
          <Field label="IBAN" name="bankIban">
            <TextInput name="bankIban" defaultValue={initial?.bankIban ?? ""} />
          </Field>
        </FormSection>
      )}

      <FormSection title="Scope" columns={2} description="Which entities may transact with this vendor, and what it supplies.">
        <div>
          <span className="label mb-1.5 block">Entities</span>
          <div className="space-y-1.5">
            {entities.map((e) => (
              <Checkbox
                key={e.id}
                label={`${e.code} — ${e.name}`}
                checked={selectedEntities.includes(e.id)}
                onChange={() => setSelectedEntities((p) => toggle(p, e.id))}
              />
            ))}
          </div>
        </div>
        <div>
          <span className="label mb-1.5 block">Supply categories</span>
          <div className="max-h-[14rem] space-y-1.5 overflow-y-auto pr-1">
            {categories.map((c) => (
              <Checkbox
                key={c.id}
                label={c.name}
                checked={selectedCategories.includes(c.name)}
                onChange={() => setSelectedCategories((p) => toggle(p, c.name))}
              />
            ))}
          </div>
        </div>
      </FormSection>
    </ActionForm>
  );
}
