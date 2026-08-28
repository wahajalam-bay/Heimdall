"use client";

import { useMemo, useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Checkbox, Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import {
  resetPasswordAction,
  saveApprovalRuleAction,
  saveConfigAction,
  saveRoleAction,
  saveUserAction,
} from "./actions";

/* ── Users ────────────────────────────────────────────────── */

export type UserRecord = {
  id: string;
  email: string;
  name: string;
  title: string | null;
  phone: string | null;
  departmentId: string | null;
  primaryEntityId: string | null;
  active: boolean;
  roleIds: string[];
  entityIds: string[];
};

export function UserForm({
  roles,
  entities,
  departments,
  initial,
  triggerLabel,
  triggerClass = "btn btn-primary btn-sm",
}: {
  roles: Array<{ id: string; code: string; name: string }>;
  entities: Array<{ id: string; code: string; name: string }>;
  departments: Array<{ id: string; name: string; entityId: string }>;
  initial?: UserRecord;
  triggerLabel?: string;
  triggerClass?: string;
}) {
  const editing = !!initial;
  const [open, setOpen] = useState(false);
  const [roleIds, setRoleIds] = useState<string[]>(initial?.roleIds ?? []);
  const [entityIds, setEntityIds] = useState<string[]>(initial?.entityIds ?? []);
  const [primaryEntityId, setPrimaryEntityId] = useState(initial?.primaryEntityId ?? entities[0]?.id ?? "");
  const [active, setActive] = useState(initial?.active ?? true);

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const visibleDepartments = departments.filter((d) => !primaryEntityId || d.entityId === primaryEntityId);

  return (
    <>
      <button type="button" className={triggerClass} onClick={() => setOpen(true)}>
        {triggerLabel ?? (editing ? "Edit" : "Add user")}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? `Edit ${initial!.name}` : "Add a user"}
        description="Roles decide what someone can do; entity access decides what they can see. Both are enforced on the server on every request."
        size="xl"
      >
        <ActionForm
          action={saveUserAction}
          layout="bare"
          submitLabel={editing ? "Save user" : "Create user"}
          hiddenFields={{
            userId: initial?.id,
            primaryEntityId: primaryEntityId || undefined,
            active: active ? "true" : "",
          }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          {roleIds.map((id) => (
            <input key={id} type="hidden" name="roleIds" value={id} />
          ))}
          {entityIds.map((id) => (
            <input key={id} type="hidden" name="entityIds" value={id} />
          ))}

          <FormSection columns={3}>
            <Field label="Name" name="name" required>
              <TextInput name="name" defaultValue={initial?.name} />
            </Field>
            <Field label="Email" name="email" required hint="Used to sign in.">
              <TextInput type="email" name="email" defaultValue={initial?.email} />
            </Field>
            <Field label="Job title" name="title">
              <TextInput name="title" defaultValue={initial?.title ?? ""} />
            </Field>
            <Field label="Phone" name="phone">
              <TextInput name="phone" defaultValue={initial?.phone ?? ""} />
            </Field>
            <Field label="Primary entity" name="primaryEntitySelect" required>
              <Select
                name="primaryEntitySelect"
                value={primaryEntityId}
                onChange={(e) => setPrimaryEntityId(e.target.value)}
                options={entities.map((e) => ({ value: e.id, label: `${e.code} — ${e.name}` }))}
              />
            </Field>
            <Field label="Department" name="departmentId">
              <Select
                name="departmentId"
                placeholder="Not department assigned"
                options={visibleDepartments.map((d) => ({ value: d.id, label: d.name }))}
                defaultValue={initial?.departmentId ?? ""}
              />
            </Field>
            {!editing && (
              <Field label="Initial password" name="password" required hint="At least 8 characters. The user should change it.">
                <TextInput type="password" name="password" autoComplete="new-password" />
              </Field>
            )}
            <Field label="Account" name="activeChoice">
              <Checkbox
                label="Active — may sign in"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
            </Field>
          </FormSection>

          <FormSection title="Roles" columns={1} description="A person may hold several roles; permissions are the union of all of them.">
            <div className="grid max-h-[16rem] gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
              {roles.map((r) => (
                <Checkbox
                  key={r.id}
                  label={r.name}
                  hint={r.code}
                  checked={roleIds.includes(r.id)}
                  onChange={() => setRoleIds((p) => toggle(p, r.id))}
                />
              ))}
            </div>
          </FormSection>

          <FormSection title="Entity access" columns={1} description="Which entities' records this person may read. Leave empty to restrict them to their primary entity only.">
            <div className="space-y-1.5">
              {entities.map((e) => (
                <Checkbox
                  key={e.id}
                  label={`${e.code} — ${e.name}`}
                  checked={entityIds.includes(e.id)}
                  onChange={() => setEntityIds((p) => toggle(p, e.id))}
                />
              ))}
            </div>
          </FormSection>

          <FormSection columns={1}>
            <Field label="Reason" name="reason" hint="Recorded in the audit trail alongside the change.">
              <TextInput name="reason" placeholder="e.g. New joiner in procurement, per the approved hiring request." />
            </Field>
          </FormSection>

          {roleIds.length === 0 && (
            <InlineAlert tone="warning">
              No roles selected. This person will be able to sign in but see almost nothing — every screen is
              permission-gated.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

export function ResetPasswordForm({ userId, name }: { userId: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-secondary btn-xs" onClick={() => setOpen(true)}>
        Reset password
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Reset password for ${name}`}
        description="Setting a new password signs the user out of every active session."
        size="sm"
      >
        <ActionForm
          action={async (_prev, fd) => resetPasswordAction(fd)}
          layout="bare"
          submitLabel="Reset password"
          hiddenFields={{ userId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={1}>
            <Field label="New password" name="password" required hint="At least 8 characters.">
              <TextInput type="password" name="password" autoComplete="new-password" />
            </Field>
            <Field label="Reason" name="reason">
              <TextInput name="reason" placeholder="e.g. User reported losing access; identity verified by phone." />
            </Field>
          </FormSection>
        </ActionForm>
      </Modal>
    </>
  );
}

/* ── Roles ────────────────────────────────────────────────── */

export function RoleForm({
  roleId,
  roleName,
  roleCode,
  current,
  permissionGroups,
  defaults,
}: {
  roleId: string;
  roleName: string;
  roleCode: string;
  current: string[];
  permissionGroups: Array<{ group: string; permissions: Array<{ code: string; name: string }> }>;
  defaults: string[];
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(current);

  const added = selected.filter((c) => !defaults.includes(c));
  const removed = defaults.filter((c) => !selected.includes(c));
  const drifted = added.length > 0 || removed.length > 0;

  const toggle = (code: string) =>
    setSelected((p) => (p.includes(code) ? p.filter((x) => x !== code) : [...p, code]));
  const toggleGroup = (codes: string[]) =>
    setSelected((p) => (codes.every((c) => p.includes(c)) ? p.filter((c) => !codes.includes(c)) : [...new Set([...p, ...codes])]));

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Edit permissions
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`${roleName} — permissions`}
        description={`${selected.length} of ${permissionGroups.reduce((a, g) => a + g.permissions.length, 0)} permissions granted. Every screen and every action checks these on the server.`}
        size="xl"
      >
        <ActionForm
          action={saveRoleAction}
          layout="bare"
          submitLabel="Save permissions"
          hiddenFields={{ roleId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          {selected.map((c) => (
            <input key={c} type="hidden" name="permissions" value={c} />
          ))}

          <div className="space-y-3">
            {permissionGroups.map((g) => {
              const codes = g.permissions.map((p) => p.code);
              const all = codes.every((c) => selected.includes(c));
              const some = codes.some((c) => selected.includes(c));
              return (
                <div key={g.group} className="rounded-xl border border-border px-3 py-2.5">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs font-600">
                      {g.group}
                      <span className="ml-2 font-400 text-[var(--c-text-tertiary)]">
                        {codes.filter((c) => selected.includes(c)).length} / {codes.length}
                      </span>
                    </span>
                    <button type="button" className="btn btn-ghost btn-xs" onClick={() => toggleGroup(codes)}>
                      {all ? "Clear group" : some ? "Select all" : "Select all"}
                    </button>
                  </div>
                  <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {g.permissions.map((p) => (
                      <Checkbox
                        key={p.code}
                        label={p.name}
                        hint={p.code}
                        checked={selected.includes(p.code)}
                        onChange={() => toggle(p.code)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <FormSection columns={1}>
            <Field
              label="Reason"
              name="reason"
              required
              hint="Mandatory. Changing a role changes what a group of people can do — say why."
            >
              <TextArea name="reason" rows={2} />
            </Field>
          </FormSection>

          {drifted && (
            <InlineAlert tone="warning">
              This differs from the shipped definition for {roleCode}: {added.length} added, {removed.length} removed.
              Drift is allowed, but it should be deliberate.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

/* ── Configuration ────────────────────────────────────────── */

export function ConfigForm({
  configKey,
  label,
  description,
  valueType,
  currentValue,
  defaultValue,
  entities,
  entityId,
  hasOverride,
}: {
  configKey: string;
  label: string;
  description: string;
  valueType: "number" | "boolean" | "string" | "json";
  currentValue: unknown;
  defaultValue: unknown;
  entities: Array<{ id: string; code: string; name: string }>;
  entityId: string | null;
  hasOverride: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState(entityId ?? "");
  const asText = (v: unknown) =>
    Array.isArray(v) ? v.join(", ") : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "");

  return (
    <>
      <button type="button" className="btn btn-secondary btn-xs" onClick={() => setOpen(true)}>
        {hasOverride ? "Change" : "Set"}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={label}
        description={description}
        size="md"
      >
        <ActionForm
          action={saveConfigAction}
          layout="bare"
          submitLabel="Save setting"
          hiddenFields={{ key: configKey, entityId: scope || undefined }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={1}>
            <Field
              label="Scope"
              name="scopeChoice"
              hint="An entity override takes precedence over the global value for that entity only."
            >
              <Select
                name="scopeChoice"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                options={[
                  { value: "", label: "Global — applies to every entity" },
                  ...entities.map((e) => ({ value: e.id, label: `${e.code} — ${e.name} only` })),
                ]}
              />
            </Field>

            {valueType === "boolean" ? (
              <Field label="Value" name="value">
                <Checkbox name="value" label="Enabled" defaultChecked={currentValue === true} value="true" />
              </Field>
            ) : valueType === "number" ? (
              <Field label="Value" name="value" required hint={`Current: ${asText(currentValue)} · shipped default: ${asText(defaultValue)}`}>
                <TextInput type="number" step="any" min="0" name="value" defaultValue={asText(currentValue)} />
              </Field>
            ) : valueType === "json" ? (
              <Field
                label="Value"
                name="value"
                required
                hint={`Comma-separated list, or raw JSON. Shipped default: ${asText(defaultValue)}`}
              >
                <TextArea name="value" rows={3} defaultValue={asText(currentValue)} />
              </Field>
            ) : (
              <Field label="Value" name="value" required hint={`Shipped default: ${asText(defaultValue)}`}>
                <TextInput name="value" defaultValue={asText(currentValue)} />
              </Field>
            )}

            <Field label="Reason" name="reason" required hint="Mandatory. Policy changes are audited with the reason given.">
              <TextArea name="reason" rows={2} placeholder="e.g. CPC threshold raised for ZD following the board decision of 12 March." />
            </Field>
          </FormSection>

          <InlineAlert tone="info">
            Changing this affects new transactions only. Anything already in flight keeps the rule that applied when it
            was raised.
          </InlineAlert>
        </ActionForm>
      </Modal>
    </>
  );
}

/* ── Approval rules ───────────────────────────────────────── */

const DOCUMENT_TYPES = ["PR", "PO", "INVOICE", "PETTY_CASH", "DISPOSAL", "VENDOR", "STORE_TRANSFER", "MATERIAL_DEMAND"];
const APPROVER_TYPES = [
  { value: "ROLE", label: "A role" },
  { value: "DEPARTMENT_HEAD", label: "The requesting department's head" },
  { value: "CPC", label: "The Central Procurement Committee" },
];

export type RuleStep = {
  key: string;
  sequence: number;
  name: string;
  roleId: string;
  approverType: string;
  slaHours: string;
  requireAll: boolean;
  optional: boolean;
  commentRequired: boolean;
};

let stepSeq = 0;
const newStep = (sequence: number): RuleStep => ({
  key: `st-${++stepSeq}`,
  sequence,
  name: "",
  roleId: "",
  approverType: "ROLE",
  slaHours: "24",
  requireAll: false,
  optional: false,
  commentRequired: false,
});

export function ApprovalRuleForm({
  roles,
  entities,
  departments,
  categories,
  initial,
  triggerLabel,
}: {
  roles: Array<{ id: string; code: string; name: string }>;
  entities: Array<{ id: string; code: string; name: string }>;
  departments: Array<{ id: string; name: string; entityId: string }>;
  categories: Array<{ id: string; name: string }>;
  initial?: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    documentType: string;
    entityId: string | null;
    departmentId: string | null;
    categoryId: string | null;
    procurementType: string | null;
    minAmount: number;
    maxAmount: number | null;
    priority: number;
    requiresCpc: boolean;
    active: boolean;
    steps: Array<{
      sequence: number;
      name: string;
      roleId: string | null;
      approverType: string;
      slaHours: number;
      requireAll: boolean;
      optional: boolean;
      commentRequired: boolean;
    }>;
  };
  triggerLabel?: string;
}) {
  const editing = !!initial;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(initial?.active ?? true);
  const [requiresCpc, setRequiresCpc] = useState(initial?.requiresCpc ?? false);
  const [steps, setSteps] = useState<RuleStep[]>(() =>
    initial?.steps.length
      ? initial.steps.map((st) => ({
          key: `st-${++stepSeq}`,
          sequence: st.sequence,
          name: st.name,
          roleId: st.roleId ?? "",
          approverType: st.approverType,
          slaHours: String(st.slaHours),
          requireAll: st.requireAll,
          optional: st.optional,
          commentRequired: st.commentRequired,
        }))
      : [newStep(1)],
  );

  const patch = (key: string, changes: Partial<RuleStep>) =>
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...changes } : s)));

  const payload = JSON.stringify(
    steps
      .filter((s) => s.approverType !== "ROLE" || s.roleId)
      .map((s, i) => ({
        sequence: i + 1,
        name: s.name || roles.find((r) => r.id === s.roleId)?.name || `Step ${i + 1}`,
        roleId: s.approverType === "ROLE" ? s.roleId : null,
        approverType: s.approverType,
        slaHours: Number(s.slaHours) || 24,
        requireAll: s.requireAll,
        optional: s.optional,
        commentRequired: s.commentRequired,
      })),
  );

  const incomplete = steps.filter((s) => s.approverType === "ROLE" && !s.roleId).length;

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        {triggerLabel ?? (editing ? "Edit rule" : "Add rule")}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? `Edit ${initial!.name}` : "Add an approval rule"}
        description="Rules are matched by specificity: entity, then department, then category, then procurement type — the most specific matching rule wins, and its steps become the chain."
        size="xl"
      >
        <ActionForm
          action={saveApprovalRuleAction}
          layout="bare"
          submitLabel={editing ? "Save rule" : "Create rule"}
          hiddenFields={{
            id: initial?.id,
            code: initial?.code,
            steps: payload,
            active: active ? "true" : "",
            requiresCpc: requiresCpc ? "true" : "",
          }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection title="Scope" columns={3}>
            <Field label="Name" name="name" required span>
              <TextInput name="name" defaultValue={initial?.name} placeholder="e.g. ZD purchase orders above 5 million" />
            </Field>
            <Field label="Document type" name="documentType" required>
              <Select
                name="documentType"
                options={DOCUMENT_TYPES.map((d) => ({ value: d, label: humanize(d) }))}
                defaultValue={initial?.documentType ?? "PR"}
              />
            </Field>
            <Field label="Entity" name="entityId" hint="Leave blank to apply to every entity.">
              <Select
                name="entityId"
                placeholder="Any entity"
                options={entities.map((e) => ({ value: e.id, label: `${e.code} — ${e.name}` }))}
                defaultValue={initial?.entityId ?? ""}
              />
            </Field>
            <Field label="Department" name="departmentId">
              <Select
                name="departmentId"
                placeholder="Any department"
                options={departments.map((d) => ({ value: d.id, label: d.name }))}
                defaultValue={initial?.departmentId ?? ""}
              />
            </Field>
            <Field label="Category" name="categoryId">
              <Select
                name="categoryId"
                placeholder="Any category"
                options={categories.map((c) => ({ value: c.id, label: c.name }))}
                defaultValue={initial?.categoryId ?? ""}
              />
            </Field>
            <Field label="Procurement type" name="procurementType">
              <Select
                name="procurementType"
                placeholder="Any type"
                options={["MONTHLY_RECURRING", "ON_DEMAND", "MATERIAL_DEMAND", "PETTY_CASH", "SERVICE"].map((t) => ({
                  value: t,
                  label: humanize(t),
                }))}
                defaultValue={initial?.procurementType ?? ""}
              />
            </Field>
            <Field label="From value (PKR)" name="minAmount" hint="Inclusive lower bound.">
              <TextInput type="number" step="any" min="0" name="minAmount" defaultValue={initial?.minAmount ?? 0} />
            </Field>
            <Field label="To value (PKR)" name="maxAmount" hint="Leave blank for no upper bound.">
              <TextInput type="number" step="any" min="0" name="maxAmount" defaultValue={initial?.maxAmount ?? ""} />
            </Field>
            <Field label="Priority" name="priority" hint="Lower wins when two rules are equally specific.">
              <TextInput type="number" step="1" name="priority" defaultValue={initial?.priority ?? 100} />
            </Field>
            <Field label="Description" name="description" span>
              <TextInput name="description" defaultValue={initial?.description ?? ""} />
            </Field>
            <Field label="Committee" name="requiresCpcChoice">
              <Checkbox
                label="Matching documents also need CPC clearance"
                checked={requiresCpc}
                onChange={(e) => setRequiresCpc(e.target.checked)}
              />
            </Field>
            <Field label="Status" name="activeChoice">
              <Checkbox label="Active" checked={active} onChange={(e) => setActive(e.target.checked)} />
            </Field>
          </FormSection>

          <FormSection title="Approval chain" columns={1} description="Steps run in order. An optional step can be skipped; a required one cannot.">
            <div className="space-y-2.5 sm:col-span-full">
              <div className="table-wrap rounded-xl border border-border">
                <table className="dt">
                  <thead>
                    <tr>
                      <th style={{ width: "3rem" }}>#</th>
                      <th style={{ width: "13rem" }}>Approver</th>
                      <th style={{ minWidth: "12rem" }}>Role</th>
                      <th style={{ minWidth: "10rem" }}>Step name</th>
                      <th className="text-right" style={{ width: "7rem" }}>SLA (h)</th>
                      <th style={{ width: "14rem" }}>Behaviour</th>
                      <th style={{ width: "4rem" }} />
                    </tr>
                  </thead>
                  <tbody>
                    {steps.map((s, i) => (
                      <tr key={s.key}>
                        <td className="num text-xs text-[var(--c-text-tertiary)]">{i + 1}</td>
                        <td>
                          <select
                            className="field"
                            value={s.approverType}
                            onChange={(e) => patch(s.key, { approverType: e.target.value, roleId: "" })}
                            aria-label="Approver type"
                          >
                            {APPROVER_TYPES.map((a) => (
                              <option key={a.value} value={a.value}>
                                {a.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            className="field"
                            value={s.roleId}
                            onChange={(e) => patch(s.key, { roleId: e.target.value })}
                            disabled={s.approverType !== "ROLE"}
                            aria-label="Role"
                          >
                            <option value="">{s.approverType === "ROLE" ? "Select role…" : "Not applicable"}</option>
                            {roles.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            className="field"
                            value={s.name}
                            onChange={(e) => patch(s.key, { name: e.target.value })}
                            placeholder="Optional label"
                            aria-label="Step name"
                          />
                        </td>
                        <td>
                          <input
                            className="field text-right"
                            type="number"
                            min="1"
                            step="1"
                            value={s.slaHours}
                            onChange={(e) => patch(s.key, { slaHours: e.target.value })}
                            aria-label="SLA hours"
                          />
                        </td>
                        <td className="space-y-1">
                          <Checkbox
                            label="Optional"
                            checked={s.optional}
                            onChange={(e) => patch(s.key, { optional: e.target.checked })}
                          />
                          <Checkbox
                            label="All assignees must approve"
                            checked={s.requireAll}
                            onChange={(e) => patch(s.key, { requireAll: e.target.checked })}
                          />
                          <Checkbox
                            label="Comment required"
                            checked={s.commentRequired}
                            onChange={(e) => patch(s.key, { commentRequired: e.target.checked })}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs text-[var(--c-danger)]"
                            onClick={() =>
                              setSteps((prev) => (prev.length === 1 ? prev : prev.filter((x) => x.key !== s.key)))
                            }
                            disabled={steps.length === 1}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setSteps((prev) => [...prev, newStep(prev.length + 1)])}
              >
                + Add step
              </button>
            </div>
          </FormSection>

          <FormSection columns={1}>
            <Field label="Reason" name="reason" required hint="Mandatory. Approval chains decide who can commit money.">
              <TextArea name="reason" rows={2} />
            </Field>
          </FormSection>

          {incomplete > 0 && (
            <InlineAlert tone="warning">
              {incomplete} step{incomplete === 1 ? " has" : "s have"} no role selected and will not be saved.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}
