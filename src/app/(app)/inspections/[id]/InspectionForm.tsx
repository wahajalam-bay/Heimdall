"use client";

import { useMemo, useState } from "react";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { Badge, InlineAlert, SectionCard } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { qty, round2 } from "@/lib/format";
import { recordInspectionAction } from "@/app/(app)/receiving/actions";

export type Criterion = {
  key: string;
  label: string;
  kind: "text" | "boolean" | "number" | "select";
  options?: string[];
  required?: boolean;
};

export type InspectionLine = {
  id: string;
  lineNo: number;
  description: string;
  quantityInspected: number;
  unit: string;
  serialNumber: string | null;
  existing?: {
    quantityPassed: number;
    quantityFailed: number;
    modelVerified: string | null;
    specVerified: string | null;
    configuration: string | null;
    condition: string | null;
    performanceNotes: string | null;
    accessoriesComplete: boolean;
    verdict: string;
    criteria: Array<{ key: string; label: string; value: string | number | boolean | null }>;
    notes: string | null;
  };
};

type LineState = {
  id: string;
  quantityPassed: string;
  quantityFailed: string;
  serialNumber: string;
  modelVerified: string;
  specVerified: string;
  configuration: string;
  condition: string;
  performanceNotes: string;
  accessoriesComplete: boolean;
  verdict: "PASS" | "FAIL" | "CONDITIONAL";
  criteria: Record<string, string | boolean>;
  notes: string;
};

/**
 * Technical inspection form. The criteria set comes from the configured template
 * for the item's category, so an IT inspection asks about configuration and
 * serials while a steel inspection asks about grade and mill certificates.
 */
export function InspectionForm({
  inspection,
  lines,
  criteria,
  inspectorName,
}: {
  inspection: { id: string; number: string; type: string; templateLabel: string };
  lines: InspectionLine[];
  criteria: Criterion[];
  inspectorName: string;
}) {
  const [state, setState] = useState<LineState[]>(
    lines.map((l) => ({
      id: l.id,
      quantityPassed: l.existing ? String(l.existing.quantityPassed) : String(l.quantityInspected),
      quantityFailed: l.existing ? String(l.existing.quantityFailed) : "0",
      serialNumber: l.existing?.modelVerified ? (l.serialNumber ?? "") : (l.serialNumber ?? ""),
      modelVerified: l.existing?.modelVerified ?? "",
      specVerified: l.existing?.specVerified ?? "",
      configuration: l.existing?.configuration ?? "",
      condition: l.existing?.condition ?? "",
      performanceNotes: l.existing?.performanceNotes ?? "",
      accessoriesComplete: l.existing?.accessoriesComplete ?? true,
      verdict: (l.existing?.verdict as LineState["verdict"]) ?? "PASS",
      criteria: Object.fromEntries(
        criteria.map((c) => {
          const prior = l.existing?.criteria.find((x) => x.key === c.key)?.value;
          if (c.kind === "boolean") return [c.key, prior === null || prior === undefined ? true : Boolean(prior)];
          return [c.key, prior === null || prior === undefined ? "" : String(prior)];
        }),
      ),
      notes: l.existing?.notes ?? "",
    })),
  );
  const [result, setResult] = useState<"APPROVED" | "REJECTED" | "CONDITIONAL" | "RE_INSPECTION_REQUIRED">("APPROVED");

  const patch = (id: string, changes: Partial<LineState>) =>
    setState((prev) => prev.map((s) => (s.id === id ? { ...s, ...changes } : s)));
  const patchCriterion = (id: string, key: string, value: string | boolean) =>
    setState((prev) => prev.map((s) => (s.id === id ? { ...s, criteria: { ...s.criteria, [key]: value } } : s)));

  const totals = useMemo(() => {
    let passed = 0;
    let failed = 0;
    let presented = 0;
    for (const l of lines) {
      const s = state.find((x) => x.id === l.id)!;
      passed += Number(s.quantityPassed) || 0;
      failed += Number(s.quantityFailed) || 0;
      presented += l.quantityInspected;
    }
    return { passed: round2(passed), failed: round2(failed), presented: round2(presented) };
  }, [state, lines]);

  const errors = useMemo(() => {
    const out: string[] = [];
    for (const l of lines) {
      const s = state.find((x) => x.id === l.id)!;
      const p = Number(s.quantityPassed) || 0;
      const f = Number(s.quantityFailed) || 0;
      if (round2(p + f) > l.quantityInspected + 1e-9) {
        out.push(`Line ${l.lineNo}: passed + failed (${round2(p + f)}) exceeds the ${l.quantityInspected} presented.`);
      }
      if (s.verdict === "FAIL" && f <= 0) out.push(`Line ${l.lineNo}: a failed verdict needs a failed quantity.`);
      for (const c of criteria.filter((x) => x.required)) {
        const v = s.criteria[c.key];
        if (c.kind !== "boolean" && (v === "" || v === undefined)) {
          out.push(`Line ${l.lineNo}: "${c.label}" is required.`);
        }
      }
    }
    if (result === "REJECTED" && totals.failed <= 0) {
      out.push("A rejected inspection needs at least one failed quantity recorded.");
    }
    return out;
  }, [state, lines, criteria, result, totals.failed]);

  const payload = JSON.stringify(
    state.map((s) => ({
      inspectionItemId: s.id,
      quantityPassed: Number(s.quantityPassed) || 0,
      quantityFailed: Number(s.quantityFailed) || 0,
      serialNumber: s.serialNumber.trim() || null,
      modelVerified: s.modelVerified.trim() || null,
      specVerified: s.specVerified.trim() || null,
      configuration: s.configuration.trim() || null,
      condition: s.condition.trim() || null,
      performanceNotes: s.performanceNotes.trim() || null,
      accessoriesComplete: s.accessoriesComplete,
      verdict: s.verdict,
      criteriaResults: criteria.map((c) => ({
        key: c.key,
        label: c.label,
        value: c.kind === "boolean" ? Boolean(s.criteria[c.key]) : (String(s.criteria[c.key] ?? "") || null),
      })),
      notes: s.notes.trim() || null,
    })),
  );

  return (
    <ActionForm
      action={recordInspectionAction}
      submitLabel="Sign and record inspection"
      hiddenFields={{ inspectionId: inspection.id, result, items: payload }}
      onSuccessRedirect={`/inspections/${inspection.id}`}
      footerSticky
      secondary={
        <span className="mr-auto text-2xs text-[var(--c-text-tertiary)]">
          {qty(totals.passed)} passed, {qty(totals.failed)} failed of {qty(totals.presented)} presented
        </span>
      }
    >
      <InlineAlert tone="info">
        {inspection.templateLabel} inspection template. A GRN for this receipt stays blocked until this inspection is
        approved or conditionally approved.
      </InlineAlert>

      <FormSection title="Inspection outcome" columns={2}>
        <Field label="Overall result" name="resultSelect" required>
          <Select
            name="resultSelect"
            value={result}
            onChange={(e) => setResult(e.target.value as typeof result)}
            options={[
              { value: "APPROVED", label: "Approved — accept into inventory" },
              { value: "CONDITIONAL", label: "Conditional — accept with stated conditions" },
              { value: "RE_INSPECTION_REQUIRED", label: "Re-inspection required" },
              { value: "REJECTED", label: "Rejected — do not accept" },
            ]}
          />
        </Field>
        <Field
          label="Signed by"
          name="signedByName"
          required
          hint="Your name and designation. The inspection is a signed record."
        >
          <TextInput name="signedByName" defaultValue={inspectorName} />
        </Field>
        <Field
          label="Findings"
          name="findings"
          span
          required={result === "REJECTED"}
          hint="What was checked and what was found. This is the substantive record of the inspection."
        >
          <TextArea name="findings" rows={4} />
        </Field>
        {result === "CONDITIONAL" && (
          <Field
            label="Conditions attached to acceptance"
            name="conditions"
            span
            required
            hint="What the vendor or the store must do for this acceptance to stand."
          >
            <TextArea name="conditions" rows={3} />
          </Field>
        )}
      </FormSection>

      {lines.map((l) => {
        const s = state.find((x) => x.id === l.id)!;
        return (
          <SectionCard
            key={l.id}
            title={`Line ${l.lineNo} — ${l.description}`}
            description={`${qty(l.quantityInspected, l.unit)} presented for inspection`}
            actions={
              <Badge tone={s.verdict === "PASS" ? "success" : s.verdict === "FAIL" ? "danger" : "warning"}>
                {humanize(s.verdict)}
              </Badge>
            }
          >
            <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-4">
              <label className="block">
                <span className="mb-1 block text-xs font-500 text-muted">Quantity passed</span>
                <input
                  className="field text-right"
                  type="number"
                  step="any"
                  min="0"
                  value={s.quantityPassed}
                  onChange={(e) => patch(l.id, { quantityPassed: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-500 text-muted">Quantity failed</span>
                <input
                  className="field text-right"
                  type="number"
                  step="any"
                  min="0"
                  value={s.quantityFailed}
                  onChange={(e) => patch(l.id, { quantityFailed: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-500 text-muted">Line verdict</span>
                <select
                  className="field"
                  value={s.verdict}
                  onChange={(e) => patch(l.id, { verdict: e.target.value as LineState["verdict"] })}
                >
                  <option value="PASS">Pass</option>
                  <option value="CONDITIONAL">Conditional</option>
                  <option value="FAIL">Fail</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-500 text-muted">Serial / batch verified</span>
                <input
                  className="field"
                  value={s.serialNumber}
                  onChange={(e) => patch(l.id, { serialNumber: e.target.value })}
                  placeholder="As recorded on the units"
                />
              </label>

              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs font-500 text-muted">Model verified</span>
                <input
                  className="field"
                  value={s.modelVerified}
                  onChange={(e) => patch(l.id, { modelVerified: e.target.value })}
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs font-500 text-muted">Specification verified</span>
                <input
                  className="field"
                  value={s.specVerified}
                  onChange={(e) => patch(l.id, { specVerified: e.target.value })}
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs font-500 text-muted">Configuration</span>
                <input
                  className="field"
                  value={s.configuration}
                  onChange={(e) => patch(l.id, { configuration: e.target.value })}
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs font-500 text-muted">Condition</span>
                <input
                  className="field"
                  value={s.condition}
                  onChange={(e) => patch(l.id, { condition: e.target.value })}
                />
              </label>
            </div>

            <div className="mt-4 overflow-hidden rounded-xl border border-border">
              <div className="border-b border-separator bg-surface-secondary px-3 py-2">
                <span className="label">Inspection criteria — {inspection.templateLabel}</span>
              </div>
              <div className="grid gap-x-4 gap-y-2.5 px-3 py-3 sm:grid-cols-2">
                {criteria.map((c) => (
                  <div key={c.key}>
                    <span className="mb-1 flex items-baseline gap-1 text-xs font-500 text-muted">
                      {c.label}
                      {c.required && <span className="text-[var(--c-danger)]">*</span>}
                    </span>
                    {c.kind === "boolean" ? (
                      <label className="flex cursor-pointer items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={Boolean(s.criteria[c.key])}
                          onChange={(e) => patchCriterion(l.id, c.key, e.target.checked)}
                        />
                        {Boolean(s.criteria[c.key]) ? "Yes" : "No"}
                      </label>
                    ) : c.kind === "select" ? (
                      <select
                        className="field"
                        value={String(s.criteria[c.key] ?? "")}
                        onChange={(e) => patchCriterion(l.id, c.key, e.target.value)}
                      >
                        <option value="">Select…</option>
                        {(c.options ?? []).map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="field"
                        type={c.kind === "number" ? "number" : "text"}
                        value={String(s.criteria[c.key] ?? "")}
                        onChange={(e) => patchCriterion(l.id, c.key, e.target.value)}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-3 grid gap-x-4 gap-y-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-500 text-muted">Performance notes</span>
                <textarea
                  className="field"
                  rows={2}
                  value={s.performanceNotes}
                  onChange={(e) => patch(l.id, { performanceNotes: e.target.value })}
                />
              </label>
              <div className="space-y-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-500 text-muted">Line notes</span>
                  <textarea
                    className="field"
                    rows={2}
                    value={s.notes}
                    onChange={(e) => patch(l.id, { notes: e.target.value })}
                  />
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={s.accessoriesComplete}
                    onChange={(e) => patch(l.id, { accessoriesComplete: e.target.checked })}
                  />
                  Accessories and documentation complete
                </label>
              </div>
            </div>
          </SectionCard>
        );
      })}

      {errors.length > 0 && (
        <div className="rounded-2xl alert-warning px-3 py-2.5">
          <p className="text-xs font-600 text-[var(--c-warning)]">Resolve before signing</p>
          <ul className="mt-1 space-y-0.5 pl-4 text-xs text-[var(--c-warning)]">
            {errors.map((e, i) => (
              <li key={i} className="list-disc">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}
    </ActionForm>
  );
}
