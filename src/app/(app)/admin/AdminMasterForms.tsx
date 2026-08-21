"use client";

import { useState, type ReactNode } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Checkbox, Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";

import type { ServerAction } from "@/components/ui/forms";
import {
  saveCategoryAction,
  saveCriterionAction,
  saveDepartmentAction,
  saveDocumentTypeAction,
  saveEntityAction,
  saveItemAction,
  saveProjectAction,
  saveStoreAction,
} from "./actions";

/** Common shell for the master-data editors: one trigger, one modal, one form. */
function EditorModal({
  trigger,
  title,
  description,
  size = "lg",
  action,
  submitLabel,
  hiddenFields,
  children,
}: {
  trigger: ReactNode;
  title: string;
  description?: string;
  size?: "sm" | "md" | "lg" | "xl";
  action: ServerAction;
  submitLabel: string;
  hiddenFields?: Record<string, string | number | null | undefined>;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span onClick={() => setOpen(true)} role="presentation">
        {trigger}
      </span>
      <Modal open={open} onClose={() => setOpen(false)} title={title} description={description} size={size}>
        <ActionForm
          action={action}
          layout="bare"
          submitLabel={submitLabel}
          hiddenFields={hiddenFields}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          {children(() => setOpen(false))}
        </ActionForm>
      </Modal>
    </>
  );
}

const ReasonField = ({ hint }: { hint?: string }) => (
  <FormSection columns={1}>
    <Field label="Reason" name="reason" hint={hint ?? "Recorded in the audit trail with the change."}>
      <TextInput name="reason" />
    </Field>
  </FormSection>
);

/* ── Entities ─────────────────────────────────────────────── */

export function EntityForm({
  initial,
  label,
}: {
  initial?: {
    id: string;
    code: string;
    name: string;
    legalName: string | null;
    taxNumber: string | null;
    logoText: string | null;
    address: string | null;
    city: string | null;
    currency: string;
    active: boolean;
  };
  label?: string;
}) {
  const [active, setActive] = useState(initial?.active ?? true);
  return (
    <EditorModal
      trigger={
        <button type="button" className={initial ? "btn btn-secondary btn-xs" : "btn btn-primary btn-sm"}>
          {label ?? (initial ? "Edit" : "Add entity")}
        </button>
      }
      title={initial ? `Edit ${initial.name}` : "Add an entity"}
      description="An entity is a legal company. Almost everything in the system is scoped to one, and configuration can be overridden per entity."
      action={saveEntityAction}
      submitLabel={initial ? "Save entity" : "Create entity"}
      hiddenFields={{ id: initial?.id, active: active ? "true" : "" }}
    >
      {() => (
        <>
          <FormSection columns={3}>
            <Field label="Code" name="code" required hint="Short, uppercase, used across the interface.">
              <TextInput name="code" defaultValue={initial?.code} />
            </Field>
            <Field label="Name" name="name" required>
              <TextInput name="name" defaultValue={initial?.name} />
            </Field>
            <Field label="Registered legal name" name="legalName">
              <TextInput name="legalName" defaultValue={initial?.legalName ?? ""} />
            </Field>
            <Field label="Tax number" name="taxNumber" hint="NTN or equivalent registration.">
              <TextInput name="taxNumber" defaultValue={initial?.taxNumber ?? ""} />
            </Field>
            <Field label="Short label" name="logoText" hint="Shown in the entity switcher.">
              <TextInput name="logoText" defaultValue={initial?.logoText ?? ""} />
            </Field>
            <Field label="Currency" name="currency">
              <TextInput name="currency" defaultValue={initial?.currency ?? "PKR"} />
            </Field>
            <Field label="City" name="city">
              <TextInput name="city" defaultValue={initial?.city ?? ""} />
            </Field>
            <Field label="Address" name="address" span>
              <TextArea name="address" rows={2} defaultValue={initial?.address ?? ""} />
            </Field>
            <Field label="Status" name="activeChoice">
              <Checkbox label="Active" checked={active} onChange={(e) => setActive(e.target.checked)} />
            </Field>
          </FormSection>
          <ReasonField />
        </>
      )}
    </EditorModal>
  );
}

/* ── Departments ──────────────────────────────────────────── */

export function DepartmentForm({
  entities,
  users,
  initial,
  label,
}: {
  entities: Array<{ id: string; code: string; name: string }>;
  users: Array<{ id: string; name: string; title: string | null }>;
  initial?: {
    id: string;
    entityId: string;
    code: string;
    name: string;
    headId: string | null;
    costCentre: string | null;
    active: boolean;
  };
  label?: string;
}) {
  const [active, setActive] = useState(initial?.active ?? true);
  return (
    <EditorModal
      trigger={
        <button type="button" className={initial ? "btn btn-secondary btn-xs" : "btn btn-primary btn-sm"}>
          {label ?? (initial ? "Edit" : "Add department")}
        </button>
      }
      title={initial ? `Edit ${initial.name}` : "Add a department"}
      description="Departments own requisitions and budgets. The head is the default first approver where a rule delegates to the requesting department."
      action={saveDepartmentAction}
      submitLabel={initial ? "Save department" : "Create department"}
      hiddenFields={{ id: initial?.id, active: active ? "true" : "" }}
    >
      {() => (
        <>
          <FormSection columns={2}>
            <Field label="Entity" name="entityId" required>
              <Select
                name="entityId"
                options={entities.map((e) => ({ value: e.id, label: `${e.code} — ${e.name}` }))}
                defaultValue={initial?.entityId}
                placeholder={initial ? undefined : "Select entity…"}
              />
            </Field>
            <Field label="Code" name="code" required>
              <TextInput name="code" defaultValue={initial?.code} />
            </Field>
            <Field label="Name" name="name" required>
              <TextInput name="name" defaultValue={initial?.name} />
            </Field>
            <Field label="Department head" name="headId" hint="Used as the department approver.">
              <Select
                name="headId"
                placeholder="No head assigned"
                options={users.map((u) => ({ value: u.id, label: `${u.name}${u.title ? ` — ${u.title}` : ""}` }))}
                defaultValue={initial?.headId ?? ""}
              />
            </Field>
            <Field label="Cost centre" name="costCentre">
              <TextInput name="costCentre" defaultValue={initial?.costCentre ?? ""} />
            </Field>
            <Field label="Status" name="activeChoice">
              <Checkbox label="Active" checked={active} onChange={(e) => setActive(e.target.checked)} />
            </Field>
          </FormSection>
          <ReasonField />
        </>
      )}
    </EditorModal>
  );
}

/* ── Projects ─────────────────────────────────────────────── */

export function ProjectForm({
  entities,
  users,
  initial,
  label,
}: {
  entities: Array<{ id: string; code: string; name: string }>;
  users: Array<{ id: string; name: string; title: string | null }>;
  initial?: {
    id: string;
    entityId: string;
    code: string;
    name: string;
    city: string | null;
    managerId: string | null;
    budget: number | null;
    status: string;
    startDate: string | null;
    endDate: string | null;
  };
  label?: string;
}) {
  return (
    <EditorModal
      trigger={
        <button type="button" className={initial ? "btn btn-secondary btn-xs" : "btn btn-primary btn-sm"}>
          {label ?? (initial ? "Edit" : "Add project")}
        </button>
      }
      title={initial ? `Edit ${initial.name}` : "Add a project"}
      description="Projects carry construction and development spend. Material demands and site stores hang off them."
      action={saveProjectAction}
      submitLabel={initial ? "Save project" : "Create project"}
      hiddenFields={{ id: initial?.id }}
    >
      {() => (
        <>
          <FormSection columns={3}>
            <Field label="Entity" name="entityId" required>
              <Select
                name="entityId"
                options={entities.map((e) => ({ value: e.id, label: `${e.code} — ${e.name}` }))}
                defaultValue={initial?.entityId}
                placeholder={initial ? undefined : "Select entity…"}
              />
            </Field>
            <Field label="Code" name="code" required>
              <TextInput name="code" defaultValue={initial?.code} />
            </Field>
            <Field label="Name" name="name" required>
              <TextInput name="name" defaultValue={initial?.name} />
            </Field>
            <Field label="Project manager" name="managerId">
              <Select
                name="managerId"
                placeholder="No manager assigned"
                options={users.map((u) => ({ value: u.id, label: `${u.name}${u.title ? ` — ${u.title}` : ""}` }))}
                defaultValue={initial?.managerId ?? ""}
              />
            </Field>
            <Field label="Budget (PKR)" name="budget">
              <TextInput type="number" step="any" min="0" name="budget" defaultValue={initial?.budget ?? ""} />
            </Field>
            <Field label="Status" name="status">
              <Select
                name="status"
                options={["Active", "On Hold", "Completed", "Cancelled"].map((s) => ({ value: s, label: s }))}
                defaultValue={initial?.status ?? "Active"}
              />
            </Field>
            <Field label="Start date" name="startDate">
              <TextInput type="date" name="startDate" defaultValue={initial?.startDate ?? ""} />
            </Field>
            <Field label="End date" name="endDate">
              <TextInput type="date" name="endDate" defaultValue={initial?.endDate ?? ""} />
            </Field>
            <Field label="City" name="city">
              <TextInput name="city" defaultValue={initial?.city ?? ""} />
            </Field>
          </FormSection>
          <ReasonField />
        </>
      )}
    </EditorModal>
  );
}

/* ── Stores ───────────────────────────────────────────────── */

const STORE_KINDS = ["CENTRAL_WAREHOUSE", "SITE_STORE", "PROJECT_STORE", "OFFICE_STORE", "OTHER"];

export function StoreForm({
  entities,
  sites,
  projects,
  users,
  initial,
  label,
}: {
  entities: Array<{ id: string; code: string; name: string }>;
  sites: Array<{ id: string; code: string; name: string; entityId: string }>;
  projects: Array<{ id: string; code: string; name: string; entityId: string }>;
  users: Array<{ id: string; name: string; title: string | null }>;
  initial?: {
    id: string;
    entityId: string;
    code: string;
    name: string;
    kind: string;
    siteId: string | null;
    projectId: string | null;
    address: string | null;
    city: string | null;
    managerId: string | null;
    active: boolean;
  };
  label?: string;
}) {
  const [entityId, setEntityId] = useState(initial?.entityId ?? entities[0]?.id ?? "");
  const [active, setActive] = useState(initial?.active ?? true);
  const eligibleSites = sites.filter((s) => s.entityId === entityId);
  const eligibleProjects = projects.filter((p) => p.entityId === entityId);

  return (
    <EditorModal
      trigger={
        <button type="button" className={initial ? "btn btn-secondary btn-xs" : "btn btn-primary btn-sm"}>
          {label ?? (initial ? "Edit" : "Add store")}
        </button>
      }
      title={initial ? `Edit ${initial.name}` : "Add a store"}
      description="Stores hold inventory. Every receipt, issue and transfer names one, and stock balances are per store."
      action={saveStoreAction}
      submitLabel={initial ? "Save store" : "Create store"}
      hiddenFields={{ id: initial?.id, entityId, active: active ? "true" : "" }}
    >
      {() => (
        <>
          <FormSection columns={3}>
            <Field label="Entity" name="entitySelect" required>
              <Select
                name="entitySelect"
                value={entityId}
                onChange={(e) => setEntityId(e.target.value)}
                options={entities.map((e) => ({ value: e.id, label: `${e.code} — ${e.name}` }))}
              />
            </Field>
            <Field label="Code" name="code" required>
              <TextInput name="code" defaultValue={initial?.code} />
            </Field>
            <Field label="Name" name="name" required>
              <TextInput name="name" defaultValue={initial?.name} />
            </Field>
            <Field label="Type" name="kind" required>
              <Select
                name="kind"
                options={STORE_KINDS.map((k) => ({ value: k, label: humanize(k) }))}
                defaultValue={initial?.kind ?? "OTHER"}
              />
            </Field>
            <Field label="Site" name="siteId" hint="For site stores.">
              <Select
                name="siteId"
                placeholder="Not site linked"
                options={eligibleSites.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` }))}
                defaultValue={initial?.siteId ?? ""}
              />
            </Field>
            <Field label="Project" name="projectId" hint="For project stores.">
              <Select
                name="projectId"
                placeholder="Not project linked"
                options={eligibleProjects.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }))}
                defaultValue={initial?.projectId ?? ""}
              />
            </Field>
            <Field label="Storekeeper" name="managerId" hint="Receives the tasks for this store.">
              <Select
                name="managerId"
                placeholder="No storekeeper assigned"
                options={users.map((u) => ({ value: u.id, label: `${u.name}${u.title ? ` — ${u.title}` : ""}` }))}
                defaultValue={initial?.managerId ?? ""}
              />
            </Field>
            <Field label="City" name="city">
              <TextInput name="city" defaultValue={initial?.city ?? ""} />
            </Field>
            <Field label="Status" name="activeChoice">
              <Checkbox label="Active" checked={active} onChange={(e) => setActive(e.target.checked)} />
            </Field>
            <Field label="Address" name="address" span>
              <TextArea name="address" rows={2} defaultValue={initial?.address ?? ""} />
            </Field>
          </FormSection>
          <ReasonField />
        </>
      )}
    </EditorModal>
  );
}

/* ── Catalogue ────────────────────────────────────────────── */

export function CategoryForm({
  categories,
  initial,
  label,
}: {
  categories: Array<{ id: string; code: string; name: string }>;
  initial?: {
    id: string;
    code: string;
    name: string;
    parentId: string | null;
    requiresInspection: boolean;
    inspectionTemplate: string | null;
    defaultDisposition: string;
    assetTagRequired: boolean;
    active: boolean;
  };
  label?: string;
}) {
  const [requiresInspection, setRequiresInspection] = useState(initial?.requiresInspection ?? false);
  const [assetTagRequired, setAssetTagRequired] = useState(initial?.assetTagRequired ?? false);
  const [active, setActive] = useState(initial?.active ?? true);

  return (
    <EditorModal
      trigger={
        <button type="button" className={initial ? "btn btn-secondary btn-xs" : "btn btn-primary btn-sm"}>
          {label ?? (initial ? "Edit" : "Add category")}
        </button>
      }
      title={initial ? `Edit ${initial.name}` : "Add a category"}
      description="Categories drive inspection requirements, specification rules and the functional director who sits on CPC."
      action={saveCategoryAction}
      submitLabel={initial ? "Save category" : "Create category"}
      hiddenFields={{
        id: initial?.id,
        requiresInspection: requiresInspection ? "true" : "",
        assetTagRequired: assetTagRequired ? "true" : "",
        active: active ? "true" : "",
      }}
      size="md"
    >
      {() => (
        <>
          <FormSection columns={2}>
            <Field label="Code" name="code" required>
              <TextInput name="code" defaultValue={initial?.code} />
            </Field>
            <Field label="Name" name="name" required>
              <TextInput name="name" defaultValue={initial?.name} />
            </Field>
            <Field label="Parent category" name="parentId" hint="For sub-categories.">
              <Select
                name="parentId"
                placeholder="Top level"
                options={categories
                  .filter((c) => c.id !== initial?.id)
                  .map((c) => ({ value: c.id, label: c.name }))}
                defaultValue={initial?.parentId ?? ""}
              />
            </Field>
            <Field label="Default disposition" name="defaultDisposition" hint="How items in this category are usually treated on receipt.">
              <Select
                name="defaultDisposition"
                options={["INVENTORY", "CONSUMABLE", "EXPENSE", "ASSET", "PROJECT_MATERIAL"].map((d) => ({
                  value: d,
                  label: humanize(d),
                }))}
                defaultValue={initial?.defaultDisposition ?? "INVENTORY"}
              />
            </Field>
            <Field label="Inspection template" name="inspectionTemplate" hint="Which QC checklist applies.">
              <Select
                name="inspectionTemplate"
                placeholder="General"
                options={["IT_EQUIPMENT", "CONSTRUCTION_MATERIAL", "MACHINERY", "ELECTRICAL", "GENERAL"].map((t2) => ({
                  value: t2,
                  label: humanize(t2),
                }))}
                defaultValue={initial?.inspectionTemplate ?? ""}
              />
            </Field>
            <Field label="Controls" name="controls" span>
              <div className="space-y-1.5">
                <Checkbox
                  label="Goods in this category must be inspected before a GRN"
                  checked={requiresInspection}
                  onChange={(e) => setRequiresInspection(e.target.checked)}
                />
                <Checkbox
                  label="Received items must be asset-tagged"
                  checked={assetTagRequired}
                  onChange={(e) => setAssetTagRequired(e.target.checked)}
                />
                <Checkbox label="Active" checked={active} onChange={(e) => setActive(e.target.checked)} />
              </div>
            </Field>
          </FormSection>
          <ReasonField />
          {requiresInspection && (
            <InlineAlert tone="info">
              Marking a category inspection-required means receiving cannot post a GRN for these goods until a QC
              inspection has been recorded.
            </InlineAlert>
          )}
        </>
      )}
    </EditorModal>
  );
}

export function ItemForm({
  categories,
  initial,
  label,
}: {
  categories: Array<{ id: string; code: string; name: string }>;
  initial?: {
    id: string;
    sku: string;
    name: string;
    description: string | null;
    categoryId: string;
    unit: string;
    brand: string | null;
    model: string | null;
    make: string | null;
    specification: string | null;
    hsCode: string | null;
    standardPrice: number | null;
    trackSerial: boolean;
    trackBatch: boolean;
    trackExpiry: boolean;
    reorderLevel: number | null;
    active: boolean;
  };
  label?: string;
}) {
  const [trackSerial, setTrackSerial] = useState(initial?.trackSerial ?? false);
  const [trackBatch, setTrackBatch] = useState(initial?.trackBatch ?? false);
  const [trackExpiry, setTrackExpiry] = useState(initial?.trackExpiry ?? false);
  const [active, setActive] = useState(initial?.active ?? true);

  return (
    <EditorModal
      trigger={
        <button type="button" className={initial ? "btn btn-secondary btn-xs" : "btn btn-primary btn-sm"}>
          {label ?? (initial ? "Edit" : "Add item")}
        </button>
      }
      title={initial ? `Edit ${initial.name}` : "Add a catalogue item"}
      description="Catalogued items give consistent descriptions, units and price history — the basis for any market comparison."
      action={saveItemAction}
      submitLabel={initial ? "Save item" : "Create item"}
      hiddenFields={{
        id: initial?.id,
        trackSerial: trackSerial ? "true" : "",
        trackBatch: trackBatch ? "true" : "",
        trackExpiry: trackExpiry ? "true" : "",
        active: active ? "true" : "",
      }}
      size="xl"
    >
      {() => (
        <>
          <FormSection columns={3}>
            <Field label="SKU" name="sku" required>
              <TextInput name="sku" defaultValue={initial?.sku} />
            </Field>
            <Field label="Name" name="name" required>
              <TextInput name="name" defaultValue={initial?.name} />
            </Field>
            <Field label="Category" name="categoryId" required>
              <Select
                name="categoryId"
                placeholder={initial ? undefined : "Select category…"}
                options={categories.map((c) => ({ value: c.id, label: c.name }))}
                defaultValue={initial?.categoryId}
              />
            </Field>
            <Field label="Unit of measure" name="unit" required>
              <TextInput name="unit" defaultValue={initial?.unit ?? "EA"} />
            </Field>
            <Field label="Brand" name="brand">
              <TextInput name="brand" defaultValue={initial?.brand ?? ""} />
            </Field>
            <Field label="Model" name="model">
              <TextInput name="model" defaultValue={initial?.model ?? ""} />
            </Field>
            <Field label="Make" name="make">
              <TextInput name="make" defaultValue={initial?.make ?? ""} />
            </Field>
            <Field label="HS code" name="hsCode">
              <TextInput name="hsCode" defaultValue={initial?.hsCode ?? ""} />
            </Field>
            <Field label="Standard price (PKR)" name="standardPrice" hint="Reference for variance analysis.">
              <TextInput type="number" step="any" min="0" name="standardPrice" defaultValue={initial?.standardPrice ?? ""} />
            </Field>
            <Field label="Reorder level" name="reorderLevel" hint="Below this, inventory flags the item.">
              <TextInput type="number" step="any" min="0" name="reorderLevel" defaultValue={initial?.reorderLevel ?? ""} />
            </Field>
            <Field label="Tracking" name="tracking" span>
              <div className="space-y-1.5">
                <Checkbox
                  label="Track serial numbers"
                  checked={trackSerial}
                  onChange={(e) => setTrackSerial(e.target.checked)}
                />
                <Checkbox label="Track batches" checked={trackBatch} onChange={(e) => setTrackBatch(e.target.checked)} />
                <Checkbox
                  label="Track expiry dates"
                  checked={trackExpiry}
                  onChange={(e) => setTrackExpiry(e.target.checked)}
                />
                <Checkbox label="Active" checked={active} onChange={(e) => setActive(e.target.checked)} />
              </div>
            </Field>
            <Field label="Specification" name="specification" span>
              <TextArea name="specification" rows={3} defaultValue={initial?.specification ?? ""} />
            </Field>
            <Field label="Description" name="description" span>
              <TextArea name="description" rows={2} defaultValue={initial?.description ?? ""} />
            </Field>
          </FormSection>
          <ReasonField />
        </>
      )}
    </EditorModal>
  );
}

/* ── Evaluation criteria ──────────────────────────────────── */

export function CriterionForm({
  groups,
  initial,
  label,
}: {
  groups: string[];
  initial?: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    maxScore: number;
    weight: number;
    group: string;
    sequence: number;
    active: boolean;
  };
  label?: string;
}) {
  const [active, setActive] = useState(initial?.active ?? true);
  const [group, setGroup] = useState(initial?.group ?? groups[0] ?? "General");
  const [custom, setCustom] = useState(false);

  return (
    <EditorModal
      trigger={
        <button type="button" className={initial ? "btn btn-secondary btn-xs" : "btn btn-primary btn-sm"}>
          {label ?? (initial ? "Edit" : "Add criterion")}
        </button>
      }
      title={initial ? `Edit ${initial.name}` : "Add an evaluation criterion"}
      description="Criteria are what every vendor pre-qualification is scored against. Weight multiplies the raw score; the total is scaled to the configured maximum."
      action={saveCriterionAction}
      submitLabel={initial ? "Save criterion" : "Create criterion"}
      hiddenFields={{ id: initial?.id, group, active: active ? "true" : "" }}
      size="md"
    >
      {() => (
        <>
          <FormSection columns={2}>
            <Field label="Code" name="code" required>
              <TextInput name="code" defaultValue={initial?.code} />
            </Field>
            <Field label="Name" name="name" required>
              <TextInput name="name" defaultValue={initial?.name} />
            </Field>
            <Field label="Group" name="groupSelect" required hint="Groups the criterion on the scoring sheet.">
              {custom ? (
                <TextInput value={group} onChange={(e) => setGroup(e.target.value)} placeholder="New group name" />
              ) : (
                <Select
                  name="groupSelect"
                  value={group}
                  onChange={(e) => {
                    if (e.target.value === "__new") {
                      setCustom(true);
                      setGroup("");
                    } else setGroup(e.target.value);
                  }}
                  options={[...groups.map((g) => ({ value: g, label: g })), { value: "__new", label: "New group…" }]}
                />
              )}
            </Field>
            <Field label="Sequence" name="sequence" hint="Display order within the group.">
              <TextInput type="number" step="1" name="sequence" defaultValue={initial?.sequence ?? 0} />
            </Field>
            <Field label="Maximum score" name="maxScore" required hint="The best possible raw score for this criterion.">
              <TextInput type="number" step="any" min="1" name="maxScore" defaultValue={initial?.maxScore ?? 3} />
            </Field>
            <Field label="Weight" name="weight" required hint="Multiplies the raw score when totalling.">
              <TextInput type="number" step="any" min="0.1" name="weight" defaultValue={initial?.weight ?? 1} />
            </Field>
            <Field label="Description" name="description" span hint="Tell the evaluator what a high score actually means.">
              <TextArea name="description" rows={3} defaultValue={initial?.description ?? ""} />
            </Field>
            <Field label="Status" name="activeChoice">
              <Checkbox label="Active" checked={active} onChange={(e) => setActive(e.target.checked)} />
            </Field>
          </FormSection>
          <ReasonField />
          <InlineAlert tone="info">
            Changing criteria does not restate past evaluations. Existing scores keep the sheet they were scored against.
          </InlineAlert>
        </>
      )}
    </EditorModal>
  );
}

/* ── Document types ───────────────────────────────────────── */

const APPLIES_TO = [
  "PR",
  "RFQ",
  "QUOTE",
  "COMPARATIVE",
  "CPC",
  "PO",
  "GATE_PASS",
  "DELIVERY",
  "INSPECTION",
  "GRN",
  "INVOICE",
  "PETTY_CASH",
  "VENDOR",
  "DISPOSAL",
  "ASSET",
  "STORE_TRANSFER",
  "STORE_ISSUE",
  "OTHER",
];

export function DocumentTypeForm({
  categories,
  initial,
  label,
}: {
  categories: string[];
  initial?: {
    id: string;
    code: string;
    name: string;
    category: string;
    appliesTo: string[];
    required: boolean;
    maxSizeMb: number;
    allowedExtensions: string;
    retentionMonths: number | null;
    viewPermission: string | null;
    active: boolean;
  };
  label?: string;
}) {
  const [mandatory, setMandatory] = useState(initial?.required ?? false);
  const [applies, setApplies] = useState<string[]>(initial?.appliesTo ?? ["OTHER"]);
  const [active, setActive] = useState(initial?.active ?? true);

  return (
    <EditorModal
      trigger={
        <button type="button" className={initial ? "btn btn-secondary btn-xs" : "btn btn-primary btn-sm"}>
          {label ?? (initial ? "Edit" : "Add document type")}
        </button>
      }
      title={initial ? `Edit ${initial.name}` : "Add a document type"}
      description="Document types decide what must be attached where, and which attachments are confidential."
      action={saveDocumentTypeAction}
      submitLabel={initial ? "Save document type" : "Create document type"}
      hiddenFields={{
        id: initial?.id,
        mandatory: mandatory ? "true" : "",
        active: active ? "true" : "",
      }}
      size="lg"
    >
      {() => (
        <>
          <FormSection columns={2}>
            <Field label="Code" name="code" required>
              <TextInput name="code" defaultValue={initial?.code} />
            </Field>
            <Field label="Name" name="name" required>
              <TextInput name="name" defaultValue={initial?.name} />
            </Field>
            <Field label="Category" name="category" required hint="Groups the type in the upload dialog.">
              <TextInput name="category" defaultValue={initial?.category ?? categories[0] ?? "General"} />
            </Field>
            <Field label="Retention (months)" name="retentionMonths" hint="How long the file must be kept.">
              <TextInput type="number" step="1" min="0" name="retentionMonths" defaultValue={initial?.retentionMonths ?? ""} />
            </Field>
            <Field label="Maximum size (MB)" name="maxSizeMb">
              <TextInput type="number" step="1" min="1" name="maxSizeMb" defaultValue={initial?.maxSizeMb ?? 20} />
            </Field>
            <Field label="Allowed extensions" name="allowedExtensions" hint="Comma separated.">
              <TextInput name="allowedExtensions" defaultValue={initial?.allowedExtensions ?? "pdf,png,jpg,jpeg,xlsx,xls,docx,doc,dwg,csv"} />
            </Field>
            <Field
              label="Restricted to permission"
              name="viewPermission"
              hint="Leave blank for anyone who can see the parent record. Set a permission code to make it confidential."
            >
              <TextInput name="viewPermission" defaultValue={initial?.viewPermission ?? ""} placeholder="e.g. vendor.view_financials" />
            </Field>
            <Field label="Controls" name="controls" span>
              <div className="space-y-1.5">
                <Checkbox
                  label="Mandatory — the document must be attached before the stage can complete"
                  checked={mandatory}
                  onChange={(e) => setMandatory(e.target.checked)}
                />
                <Checkbox label="Active" checked={active} onChange={(e) => setActive(e.target.checked)} />
              </div>
            </Field>
            <Field label="Applies to" name="appliesToChoice" required span hint="Which records this document may attach to.">
              <div className="grid max-h-[12rem] gap-1.5 overflow-y-auto pr-1 sm:grid-cols-3">
                {APPLIES_TO.map((a) => (
                  <Checkbox
                    key={a}
                    label={humanize(a)}
                    checked={applies.includes(a)}
                    onChange={() =>
                      setApplies((prev) => (prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]))
                    }
                  />
                ))}
              </div>
            </Field>
          </FormSection>
          {applies.map((a) => (
            <input key={a} type="hidden" name="appliesTo" value={a} />
          ))}
          <ReasonField />
          <InlineAlert tone="info">
            Where a view permission is set, the file is withheld from users without it — enforced when the file is served,
            not merely hidden from the list.
          </InlineAlert>
        </>
      )}
    </EditorModal>
  );
}
