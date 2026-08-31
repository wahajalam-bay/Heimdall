"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { LineItemsEditor, type CatalogueItem, type CategoryOption, type LineDraft } from "@/components/forms/LineItemsEditor";
import { PROCUREMENT_TYPES, PROCUREMENT_TYPE_LABELS, PRIORITIES, humanize } from "@/lib/domain";
import {
  PROCUREMENT_KINDS,
  PROCUREMENT_KIND_LABELS,
  kindFromProcurementType,
  type ProcurementKind,
} from "@/lib/kind";
import { toInputDate } from "@/lib/format";
import type { ActionResult } from "@/lib/errors";

export type PrFormOptions = {
  entities: Array<{ id: string; code: string; name: string }>;
  departments: Array<{ id: string; code: string; name: string; entityId: string; costCenter: string | null }>;
  projects: Array<{ id: string; code: string; name: string; entityId: string }>;
  sites: Array<{ id: string; code: string; name: string; entityId: string; projectId: string | null }>;
  stores: Array<{ id: string; code: string; name: string; kind: string; entityId: string; siteId: string | null }>;
  categories: CategoryOption[];
  items: CatalogueItem[];
  pmUsers: Array<{ id: string; name: string; title: string | null }>;
};

export type PrFormInitial = {
  id?: string;
  number?: string;
  entityId: string;
  departmentId: string;
  procurementType: string;
  procurementKind?: string;
  title: string;
  justification: string;
  projectId: string;
  siteId: string;
  costCenter: string;
  deliveryStoreId: string;
  deliveryLocationNote: string;
  requiredDate: string;
  priority: string;
  budgetAmount: string;
  budgetCode: string;
  pmOwnerId: string;
  boqReference: string;
  drawingReference: string;
  technicalNotes: string;
  lines: LineDraft[];
};

/**
 * Requisition editor.
 *
 * Progressive disclosure: the Material Demand block (project, site, PM, BOQ,
 * drawing) only appears for that procurement type, which is also where the
 * server enforces those fields.
 */
export function PrForm({
  options,
  initial,
  action,
  mode,
  requireSpecification = true,
  returnReason,
}: {
  options: PrFormOptions;
  initial: PrFormInitial;
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  mode: "create" | "edit";
  requireSpecification?: boolean;
  returnReason?: string | null;
}) {
  const [entityId, setEntityId] = useState(initial.entityId);
  const [procurementType, setProcurementType] = useState(initial.procurementType);
  const [procurementKind, setProcurementKind] = useState<ProcurementKind>(
    (initial.procurementKind as ProcurementKind) ?? kindFromProcurementType(initial.procurementType),
  );
  const [departmentId, setDepartmentId] = useState(initial.departmentId);
  const [projectId, setProjectId] = useState(initial.projectId);
  const [siteId, setSiteId] = useState(initial.siteId);
  const [deliveryStoreId, setDeliveryStoreId] = useState(initial.deliveryStoreId);
  const [submitNow, setSubmitNow] = useState(mode === "edit");

  const isMd = procurementType === "MATERIAL_DEMAND";

  const departments = useMemo(
    () => options.departments.filter((d) => d.entityId === entityId),
    [options.departments, entityId],
  );
  const projects = useMemo(() => options.projects.filter((p) => p.entityId === entityId), [options.projects, entityId]);
  const sites = useMemo(
    () => options.sites.filter((s) => s.entityId === entityId && (!projectId || s.projectId === projectId)),
    [options.sites, entityId, projectId],
  );
  const stores = useMemo(() => options.stores.filter((s) => s.entityId === entityId), [options.stores, entityId]);

  // Material demands default to the site store rather than the central warehouse.
  const suggestedStore = useMemo(() => {
    if (!isMd) return stores.find((s) => s.kind === "OFFICE_STORE") ?? stores[0];
    const bySite = siteId ? stores.find((s) => s.siteId === siteId) : undefined;
    return bySite ?? stores.find((s) => s.kind === "SITE_STORE") ?? stores[0];
  }, [isMd, siteId, stores]);

  const selectedDept = departments.find((d) => d.id === departmentId);

  return (
    <ActionForm
      action={action}
      submitLabel={submitNow ? (mode === "edit" ? "Save & resubmit" : "Submit for approval") : "Save draft"}
      successMessage="Requisition saved."
      onSuccessRedirect={(data) => {
        const d = data as { id?: string } | null;
        return d?.id ? `/pr/${d.id}` : "/pr";
      }}
      hiddenFields={{ prId: initial.id, submitNow: submitNow ? "true" : "" }}
      draftKey={mode === "create" ? "pr-new" : undefined}
      footerSticky
      secondary={
        <>
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={submitNow} onChange={(e) => setSubmitNow(e.target.checked)} />
            Submit for approval immediately
          </label>
          <Link href={initial.id ? `/pr/${initial.id}` : "/pr"} className="btn btn-secondary">
            Cancel
          </Link>
        </>
      }
    >
      {returnReason && (
        <InlineAlert tone="warning">
          <span className="font-600">Returned for revision: </span>
          {returnReason}
        </InlineAlert>
      )}

      <FormSection
        title="Requisition"
        description="Identify who is buying, for which entity and department, and why."
        columns={3}
      >
        <Field label="Entity" name="entityId" required>
          <Select
            name="entityId"
            options={options.entities.map((e) => ({ value: e.id, label: `${e.code} — ${e.name}` }))}
            value={entityId}
            onChange={(e) => {
              setEntityId(e.target.value);
              setDepartmentId("");
              setProjectId("");
              setSiteId("");
              setDeliveryStoreId("");
            }}
          />
        </Field>
        <Field label="Department" name="departmentId" required>
          <Select
            name="departmentId"
            placeholder="Select department…"
            options={departments.map((d) => ({ value: d.id, label: d.name }))}
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
          />
        </Field>
        <Field
          label="Procurement type"
          name="procurementType"
          required
          hint={
            isMd
              ? "Material Demand requires project, site, PM owner, BOQ and drawing references."
              : procurementType === "MONTHLY_RECURRING"
                ? "Recurring purchases follow the routine approval chain regardless of value."
                : undefined
          }
        >
          <Select
            name="procurementType"
            options={PROCUREMENT_TYPES.map((t) => ({ value: t, label: PROCUREMENT_TYPE_LABELS[t] }))}
            value={procurementType}
            onChange={(e) => {
              setProcurementType(e.target.value);
              // A service requisition is a service requisition. The other three
              // types carry no signal either way, so they leave the choice alone.
              if (e.target.value === "SERVICE") setProcurementKind("SERVICES");
            }}
          />
        </Field>

        <Field
          label="Goods or services"
          name="procurementKind"
          required
          hint={
            procurementKind === "SERVICES"
              ? "Services are accepted by the department that asked for them, not received into a store. There is no gate pass, no inspection and no GRN."
              : "Goods are gate-passed, delivered, inspected and received into stock or the asset register before they can be invoiced."
          }
        >
          <Select
            name="procurementKind"
            options={PROCUREMENT_KINDS.map((k) => ({ value: k, label: PROCUREMENT_KIND_LABELS[k] }))}
            value={procurementKind}
            onChange={(e) => setProcurementKind(e.target.value as ProcurementKind)}
          />
        </Field>

        <Field label="Title" name="title" required span>
          <TextInput
            name="title"
            defaultValue={initial.title}
            placeholder="e.g. Laptop refresh — Sales & Marketing (12 units)"
            maxLength={180}
          />
        </Field>

        <Field
          label="Business justification"
          name="justification"
          span
          hint="Required at or above the configured value threshold. Explain the operational need, not just the item."
        >
          <TextArea
            name="justification"
            defaultValue={initial.justification}
            rows={3}
            placeholder="Why is this needed, what happens if it is not bought, and why now?"
          />
        </Field>

        <Field label="Priority" name="priority">
          <Select
            name="priority"
            options={PRIORITIES.map((p) => ({ value: p, label: humanize(p) }))}
            defaultValue={initial.priority}
          />
        </Field>
        <Field label="Required delivery date" name="requiredDate" required>
          <TextInput type="date" name="requiredDate" defaultValue={initial.requiredDate} min={toInputDate(new Date())} />
        </Field>
        <Field label="Cost centre" name="costCenter" hint={selectedDept?.costCenter ? `Department default: ${selectedDept.costCenter}` : undefined}>
          <TextInput name="costCenter" defaultValue={initial.costCenter || (selectedDept?.costCenter ?? "")} />
        </Field>
      </FormSection>

      {isMd && (
        <FormSection
          title="Project & technical context"
          description="A Material Demand cannot be submitted without these — they are what the site team and vendors work from."
          columns={3}
        >
          <Field label="Project" name="projectId" required>
            <Select
              name="projectId"
              placeholder="Select project…"
              options={projects.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }))}
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setSiteId("");
              }}
            />
          </Field>
          <Field label="Site" name="siteId" required>
            <Select
              name="siteId"
              placeholder="Select site…"
              options={sites.map((s) => ({ value: s.id, label: s.name }))}
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
            />
          </Field>
          <Field label="PM owner" name="pmOwnerId" required>
            <Select
              name="pmOwnerId"
              placeholder="Select project manager…"
              options={options.pmUsers.map((u) => ({ value: u.id, label: `${u.name}${u.title ? ` — ${u.title}` : ""}` }))}
              defaultValue={initial.pmOwnerId}
            />
          </Field>
          <Field label="BOQ reference" name="boqReference" required hint="Attach the BOQ file below as well.">
            <TextInput name="boqReference" defaultValue={initial.boqReference} placeholder="e.g. BOQ-OPL-03.02.01 (Rev C)" />
          </Field>
          <Field label="Drawing reference" name="drawingReference" required hint="Attach the drawing pack below as well.">
            <TextInput name="drawingReference" defaultValue={initial.drawingReference} placeholder="e.g. S-201 to S-208 (Rev D)" />
          </Field>
          <Field label="Technical notes" name="technicalNotes" span>
            <TextArea
              name="technicalNotes"
              rows={3}
              defaultValue={initial.technicalNotes}
              placeholder="Standards, certification requirements, testing, handling and site constraints."
            />
          </Field>
        </FormSection>
      )}

      {!isMd && (
        <FormSection title="Project allocation" description="Optional — link the spend to a project or site." columns={2}>
          <Field label="Project" name="projectId">
            <Select
              name="projectId"
              placeholder="Not project related"
              options={projects.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }))}
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setSiteId("");
              }}
            />
          </Field>
          <Field label="Site" name="siteId">
            <Select
              name="siteId"
              placeholder="No site"
              options={sites.map((s) => ({ value: s.id, label: s.name }))}
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
            />
          </Field>
        </FormSection>
      )}

      <FormSection title="Delivery & budget" columns={2}>
        <Field
          label="Preferred delivery location"
          name="deliveryStoreId"
          required
          hint={
            suggestedStore
              ? `Suggested: ${suggestedStore.name}${isMd ? " (material demands are received at the site store, not the central warehouse)" : ""}`
              : undefined
          }
        >
          <Select
            name="deliveryStoreId"
            placeholder="Select receiving store…"
            options={stores.map((s) => ({ value: s.id, label: `${s.name} · ${humanize(s.kind)}` }))}
            value={deliveryStoreId || (suggestedStore?.id ?? "")}
            onChange={(e) => setDeliveryStoreId(e.target.value)}
          />
        </Field>
        <Field label="Delivery notes" name="deliveryLocationNote" hint="Floor, contact person, access constraints or delivery window.">
          <TextInput name="deliveryLocationNote" defaultValue={initial.deliveryLocationNote} />
        </Field>
        <Field label="Budget amount (PKR)" name="budgetAmount" hint="Submission is blocked if the estimated value exceeds this.">
          <TextInput type="number" step="any" min="0" name="budgetAmount" defaultValue={initial.budgetAmount} />
        </Field>
        <Field label="Budget code" name="budgetCode">
          <TextInput name="budgetCode" defaultValue={initial.budgetCode} placeholder="e.g. ZM-CAPEX-IT-2026" />
        </Field>
      </FormSection>

      <FormSection
        title="Requisition lines"
        description="Add every item you need. A precise specification is what makes vendor quotations comparable."
        columns={1}
      >
        <div className="sm:col-span-full">
          <LineItemsEditor
            categories={options.categories}
            items={options.items}
            initial={initial.lines}
            requireSpecification={requireSpecification}
          />
        </div>
      </FormSection>
    </ActionForm>
  );
}
