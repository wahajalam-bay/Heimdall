"use client";

import { useMemo, useState } from "react";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { money, round2 } from "@/lib/format";
import { createRequirementAction } from "./actions";

type Line = {
  key: string;
  itemId: string;
  categoryId: string;
  description: string;
  specification: string;
  quantity: string;
  unit: string;
  estimatedUnitCost: string;
};

let seq = 0;
const newLine = (): Line => ({
  key: `rq-${++seq}`,
  itemId: "",
  categoryId: "",
  description: "",
  specification: "",
  quantity: "1",
  unit: "EA",
  estimatedUnitCost: "",
});

/**
 * Raising a requirement.
 *
 * Deliberately not a purchase requisition: nothing here asks for a vendor or a
 * price to pay, because at this point nobody yet knows whether anything will be
 * bought. Picking a catalogue item matters more than it looks — an item code is
 * what lets the store be checked at all, so a free-text line is accepted but
 * flagged as un-checkable.
 */
export function RequirementForm({
  entities,
  departments,
  stores,
  sites,
  projects,
  items,
  categories,
  defaultEntityId,
  defaultDepartmentId,
}: {
  entities: Array<{ id: string; code: string; name: string }>;
  departments: Array<{ id: string; name: string; entityId: string }>;
  stores: Array<{ id: string; code: string; name: string; entityId: string }>;
  sites: Array<{ id: string; name: string; entityId: string }>;
  projects: Array<{ id: string; code: string; name: string; entityId: string }>;
  items: Array<{ id: string; sku: string; name: string; unit: string; categoryId: string }>;
  categories: Array<{ id: string; code: string; name: string }>;
  defaultEntityId: string;
  defaultDepartmentId: string;
}) {
  const [entityId, setEntityId] = useState(defaultEntityId);
  const [lines, setLines] = useState<Line[]>([newLine()]);

  const scopedDepartments = departments.filter((d) => d.entityId === entityId);
  const scopedStores = stores.filter((s) => s.entityId === entityId);
  const scopedSites = sites.filter((s) => s.entityId === entityId);
  const scopedProjects = projects.filter((p) => p.entityId === entityId);

  const update = (key: string, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const pickItem = (key: string, itemId: string) => {
    const item = items.find((i) => i.id === itemId);
    update(key, {
      itemId,
      ...(item ? { description: item.name, unit: item.unit, categoryId: item.categoryId } : {}),
    });
  };

  const estimated = useMemo(
    () =>
      round2(
        lines.reduce((a, l) => a + (Number(l.estimatedUnitCost) || 0) * (Number(l.quantity) || 0), 0),
      ),
    [lines],
  );

  const freeText = lines.filter((l) => l.description.trim() && !l.itemId).length;

  const payload = lines
    .filter((l) => l.description.trim() && Number(l.quantity) > 0)
    .map((l) => ({
      itemId: l.itemId || null,
      categoryId: l.categoryId || null,
      description: l.description.trim(),
      specification: l.specification.trim() || null,
      quantity: Number(l.quantity),
      unit: l.unit || "EA",
      estimatedUnitCost: l.estimatedUnitCost === "" ? null : Number(l.estimatedUnitCost),
    }));

  return (
    <ActionForm
      action={createRequirementAction}
      submitLabel="Submit requirement"
      secondary={
        <button type="submit" name="submit" value="false" className="btn btn-secondary btn-sm">
          Save as draft
        </button>
      }
      hiddenFields={{ items: JSON.stringify(payload), submit: "true" }}
      onSuccessRedirect={(data) => {
        const d = data as { id?: string } | null;
        return d?.id ? `/requirements/${d.id}` : "/requirements";
      }}
    >
      <FormSection title="What is needed" description="The requirement, not the purchase — that decision comes later.">
        <Field label="Title" required hint="One line a store manager would understand at a glance.">
          <TextInput name="title" required placeholder="e.g. Replacement chairs for the 3rd floor" />
        </Field>
        <Field label="Entity" required>
          <Select
            name="entityId"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            required
            options={entities.map((e) => ({ value: e.id, label: `${e.code} — ${e.name}` }))}
          />
        </Field>
        <Field label="Department" required>
          <Select
            name="departmentId"
            defaultValue={defaultDepartmentId}
            required
            placeholder="Select…"
            options={scopedDepartments.map((d) => ({ value: d.id, label: d.name }))}
          />
        </Field>
        <Field label="Needed by" required>
          <TextInput type="date" name="requiredDate" required />
        </Field>
        <Field label="Priority">
          <Select
            name="priority"
            defaultValue="NORMAL"
            options={[
              { value: "LOW", label: "Low" },
              { value: "NORMAL", label: "Normal" },
              { value: "HIGH", label: "High" },
              { value: "URGENT", label: "Urgent" },
            ]}
          />
        </Field>
        <Field label="Expenditure">
          <Select
            name="expenditureType"
            defaultValue="OPEX"
            options={[
              { value: "OPEX", label: "Operating (OpEx)" },
              { value: "CAPEX", label: "Capital (CapEx)" },
            ]}
          />
        </Field>
      </FormSection>

      <FormSection
        title="Where it is needed"
        description="The store that serves this location is checked first. Other stores are only offered if the rules allow it."
      >
        <Field label="Site">
          <Select
            name="siteId"
            defaultValue=""
            placeholder="Not site-specific"
            options={scopedSites.map((s) => ({ value: s.id, label: s.name }))}
          />
        </Field>
        <Field label="Serving store" hint="Leave blank to let the site's own store be used.">
          <Select
            name="storeId"
            defaultValue=""
            placeholder="Decide automatically"
            options={scopedStores.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` }))}
          />
        </Field>
        <Field label="Project">
          <Select
            name="projectId"
            defaultValue=""
            placeholder="None"
            options={scopedProjects.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }))}
          />
        </Field>
        <Field label="Cost centre">
          <TextInput name="costCenter" placeholder="Optional" />
        </Field>
        <Field label="Purpose" span>
          <TextArea name="purpose" rows={2} placeholder="What this is for." />
        </Field>
        <Field label="Business justification" span>
          <TextArea name="justification" rows={3} placeholder="Why it is needed now." />
        </Field>
      </FormSection>

      <FormSection
        title="Lines"
        description="Pick catalogue items where you can — an item code is what makes the stock check possible."
      >
        <div className="col-span-full space-y-3">
          {freeText > 0 && (
            <InlineAlert tone="warning">
              {freeText} line{freeText === 1 ? "" : "s"} without a catalogue item. Stock cannot be checked for those, so
              they will go straight to procurement.
            </InlineAlert>
          )}

          {lines.map((line, i) => (
            <div key={line.key} className="card card-pad grid gap-3 sm:grid-cols-12">
              <div className="sm:col-span-4">
                <Field label={`Line ${i + 1} — item`}>
                  <Select
                    value={line.itemId}
                    onChange={(e) => pickItem(line.key, e.target.value)}
                    placeholder="Not in the catalogue"
                    options={items.map((it) => ({ value: it.id, label: `${it.sku} — ${it.name}` }))}
                  />
                </Field>
              </div>
              <div className="sm:col-span-4">
                <Field label="Description" required>
                  <TextInput
                    value={line.description}
                    onChange={(e) => update(line.key, { description: e.target.value })}
                    placeholder="What it is"
                  />
                </Field>
              </div>
              {!line.itemId && (
                <div className="sm:col-span-4">
                  <Field label="Category" hint="Needed if this line ends up being bought.">
                    <Select
                      value={line.categoryId}
                      onChange={(e) => update(line.key, { categoryId: e.target.value })}
                      placeholder="Select…"
                      options={categories.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }))}
                    />
                  </Field>
                </div>
              )}
              <div className="sm:col-span-2">
                <Field label="Quantity" required>
                  <TextInput
                    type="number"
                    step="any"
                    min="0"
                    value={line.quantity}
                    onChange={(e) => update(line.key, { quantity: e.target.value })}
                  />
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="Unit">
                  <TextInput value={line.unit} onChange={(e) => update(line.key, { unit: e.target.value })} />
                </Field>
              </div>
              <div className="sm:col-span-3">
                <Field label="Estimated unit cost" hint="For budgeting only.">
                  <TextInput
                    type="number"
                    step="any"
                    min="0"
                    value={line.estimatedUnitCost}
                    onChange={(e) => update(line.key, { estimatedUnitCost: e.target.value })}
                  />
                </Field>
              </div>
              <div className="sm:col-span-9">
                <Field label="Specification">
                  <TextInput
                    value={line.specification}
                    onChange={(e) => update(line.key, { specification: e.target.value })}
                    placeholder="Size, model, finish, standard…"
                  />
                </Field>
              </div>
              <div className="flex items-end sm:col-span-12">
                {lines.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                  >
                    Remove line
                  </button>
                )}
              </div>
            </div>
          ))}

          <div className="flex items-center justify-between gap-3">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLines((p) => [...p, newLine()])}>
              Add line
            </button>
            <span className="text-xs text-muted">
              Estimated value <span className="tnum font-500 text-foreground">{money(estimated, "PKR")}</span>
            </span>
          </div>
        </div>
      </FormSection>
    </ActionForm>
  );
}
