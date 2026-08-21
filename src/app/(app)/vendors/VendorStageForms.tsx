"use client";

import { useMemo, useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Checkbox, Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert, Meter } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { round2 } from "@/lib/format";
import {
  advanceCaseAction,
  decideVendorFormAction,
  evaluateVendorAction,
  openBlacklistCaseAction,
  raiseIssueAction,
  updateIssueAction,
} from "./actions";

/* ── Pre-qualification scoring ────────────────────────────── */

export type Criterion = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  maxScore: number;
  weight: number;
  group: string;
};

export function EvaluateVendorForm({
  vendorId,
  vendorName,
  criteria,
  passMark,
  configuredMax,
  previous,
  label = "Score pre-qualification",
  evaluationType = "PRE_QUALIFICATION",
}: {
  vendorId: string;
  vendorName: string;
  criteria: Criterion[];
  /** Configured pass mark — never a constant in the UI. */
  passMark: number;
  configuredMax: number;
  previous?: Record<string, number>;
  label?: string;
  evaluationType?: string;
}) {
  const [open, setOpen] = useState(false);
  const [scores, setScores] = useState<Record<string, string>>(() =>
    Object.fromEntries(criteria.map((c) => [c.id, previous?.[c.id] !== undefined ? String(previous[c.id]) : ""])),
  );
  const [comments, setComments] = useState<Record<string, string>>({});

  const rawMax = useMemo(() => round2(criteria.reduce((a, c) => a + c.maxScore * c.weight, 0)), [criteria]);
  const rawScore = useMemo(
    () =>
      round2(
        criteria.reduce((a, c) => a + (Number(scores[c.id]) || 0) * c.weight, 0),
      ),
    [criteria, scores],
  );
  const scaled = rawMax > 0 ? round2((rawScore / rawMax) * configuredMax) : 0;
  const percent = configuredMax > 0 ? round2((scaled / configuredMax) * 100) : 0;
  const passes = scaled >= passMark;
  const unscored = criteria.filter((c) => scores[c.id] === "");

  const groups = useMemo(() => {
    const map = new Map<string, Criterion[]>();
    for (const c of criteria) {
      const list = map.get(c.group) ?? [];
      list.push(c);
      map.set(c.group, list);
    }
    return [...map.entries()];
  }, [criteria]);

  const payload = JSON.stringify(
    criteria
      .filter((c) => scores[c.id] !== "")
      .map((c) => ({
        criterionId: c.id,
        score: Number(scores[c.id]),
        comment: comments[c.id] || null,
      })),
  );

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        {label}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Evaluate ${vendorName}`}
        description={`Scores are weighted and scaled to a maximum of ${configuredMax}. The pass mark is ${passMark} — both come from configuration, so policy changes do not need code changes.`}
        size="xl"
      >
        <ActionForm
          action={evaluateVendorAction}
          layout="bare"
          submitLabel="Record evaluation"
          hiddenFields={{ vendorId, scores: payload, evaluationType, submit: "true" }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <div className="rounded-[var(--radius-md)] border border-[var(--c-border)] px-3.5 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <span className="label block">Scaled score</span>
                <span className="tnum text-[1.25rem] font-600">
                  {scaled}
                  <span className="text-xs font-400 text-[var(--c-text-secondary)]"> / {configuredMax}</span>
                </span>
              </div>
              <div className="text-right">
                <span className="label block">Outcome</span>
                <span className={`badge ${passes ? "badge-success" : "badge-danger"}`}>
                  {passes ? `At or above the ${passMark} pass mark` : `Below the ${passMark} pass mark`}
                </span>
              </div>
            </div>
            <div className="mt-2.5">
              <Meter value={percent} max={100} tone={passes ? "success" : "danger"} />
            </div>
          </div>

          {groups.map(([group, list]) => (
            <div key={group} className="space-y-1.5">
              <h4 className="label">{group}</h4>
              <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--c-border)]">
                <table className="dt">
                  <thead>
                    <tr>
                      <th style={{ minWidth: "18rem" }}>Criterion</th>
                      <th className="text-right" style={{ width: "5rem" }}>Weight</th>
                      <th className="text-right" style={{ width: "6rem" }}>Max</th>
                      <th className="text-right" style={{ width: "7rem" }}>Score</th>
                      <th style={{ minWidth: "12rem" }}>Comment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <span className="block text-xs font-500">{c.name}</span>
                          {c.description && (
                            <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{c.description}</span>
                          )}
                        </td>
                        <td className="num text-xs">{c.weight}</td>
                        <td className="num text-xs">{c.maxScore}</td>
                        <td>
                          <input
                            className="field text-right"
                            type="number"
                            step="any"
                            min="0"
                            max={c.maxScore}
                            value={scores[c.id] ?? ""}
                            onChange={(e) => setScores((p) => ({ ...p, [c.id]: e.target.value }))}
                            aria-label={`Score for ${c.name}`}
                          />
                        </td>
                        <td>
                          <input
                            className="field"
                            value={comments[c.id] ?? ""}
                            onChange={(e) => setComments((p) => ({ ...p, [c.id]: e.target.value }))}
                            aria-label={`Comment on ${c.name}`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <FormSection columns={1}>
            <Field label="Recommendation" name="recommendation" hint="What procurement recommends on the strength of these scores.">
              <TextArea name="recommendation" rows={2} />
            </Field>
            <Field label="Notes" name="notes">
              <TextArea name="notes" rows={2} />
            </Field>
          </FormSection>

          {unscored.length > 0 && (
            <InlineAlert tone="warning">
              {unscored.length} criteri{unscored.length === 1 ? "on" : "a"} left unscored. Unscored criteria are excluded
              from the maximum, which flatters the percentage — score everything that applies.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

/* ── Approval decision ────────────────────────────────────── */

export function VendorDecisionForm({
  vendorId,
  vendorName,
  entities,
  currentEntityIds,
  hasEvaluation,
  latestPassed,
}: {
  vendorId: string;
  vendorName: string;
  entities: Array<{ id: string; code: string; name: string }>;
  currentEntityIds: string[];
  hasEvaluation: boolean;
  latestPassed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<"APPROVE" | "CONDITIONAL" | "REJECT">(
    latestPassed ? "APPROVE" : "CONDITIONAL",
  );
  const [selected, setSelected] = useState<string[]>(currentEntityIds.length ? currentEntityIds : entities.map((e) => e.id));

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Decide approval
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Approval decision — ${vendorName}`}
        description="Approval opens this vendor to RFQs and purchase orders. Conditional approval allows use with the stated caveat recorded against every future transaction."
        size="lg"
      >
        <ActionForm
          action={decideVendorFormAction}
          layout="bare"
          submitLabel="Record decision"
          hiddenFields={{ vendorId, decision }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          {selected.map((id) => (
            <input key={id} type="hidden" name="entityIds" value={id} />
          ))}

          {!hasEvaluation && (
            <InlineAlert tone="danger">
              No pre-qualification evaluation exists. Approval will be refused by the server until one is recorded.
            </InlineAlert>
          )}
          {hasEvaluation && !latestPassed && (
            <InlineAlert tone="warning">
              The most recent evaluation is below the configured pass mark. Full approval will be refused; conditional
              approval requires a documented reason.
            </InlineAlert>
          )}

          <FormSection columns={1}>
            <Field label="Decision" name="decisionChoice" required>
              <Select
                name="decisionChoice"
                value={decision}
                onChange={(e) => setDecision(e.target.value as typeof decision)}
                options={[
                  { value: "APPROVE", label: "Approve — full access to sourcing" },
                  { value: "CONDITIONAL", label: "Conditional — usable with a recorded caveat" },
                  { value: "REJECT", label: "Reject — not usable" },
                ]}
              />
            </Field>
            <Field
              label="Basis for the decision"
              name="reason"
              required
              hint="This is the audit record. State what was verified and what was relied on."
            >
              <TextArea name="reason" rows={3} />
            </Field>
          </FormSection>

          {decision !== "REJECT" && (
            <div>
              <span className="label mb-1.5 block">Entities this vendor may serve</span>
              <div className="space-y-1.5">
                {entities.map((e) => (
                  <Checkbox
                    key={e.id}
                    label={`${e.code} — ${e.name}`}
                    checked={selected.includes(e.id)}
                    onChange={() =>
                      setSelected((p) => (p.includes(e.id) ? p.filter((x) => x !== e.id) : [...p, e.id]))
                    }
                  />
                ))}
              </div>
            </div>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

/* ── Vendor issue ─────────────────────────────────────────── */

const ISSUE_TYPES = [
  "LATE_DELIVERY",
  "QUALITY",
  "QUANTITY_SHORT",
  "PRICE_MISMATCH",
  "FORGED_DOCUMENT",
  "ALTERED_DOCUMENT",
  "SERVICE_FAILURE",
  "AUDIT_FINDING",
  "WARRANTY_DENIED",
  "POLICY_VIOLATION",
  "OTHER",
];

export function RaiseIssueForm({
  vendorId,
  vendorName,
  targets,
}: {
  vendorId: string;
  vendorName: string;
  targets: {
    pos: Array<{ id: string; number: string; total: number }>;
    grns: Array<{ id: string; number: string }>;
    invoices: Array<{ id: string; number: string; vendorInvoiceNumber: string }>;
  };
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        Raise issue
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Raise an issue against ${vendorName}`}
        description="Issues feed the performance score and are the evidence base for any later investigation. Pin the issue to the document it came from."
        size="lg"
      >
        <ActionForm
          action={raiseIssueAction}
          layout="bare"
          submitLabel="Raise issue"
          hiddenFields={{ vendorId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={2}>
            <Field label="Issue type" name="issueType" required>
              <Select
                name="issueType"
                options={ISSUE_TYPES.map((t) => ({ value: t, label: humanize(t) }))}
                defaultValue="QUALITY"
              />
            </Field>
            <Field label="Severity" name="severity" required>
              <Select
                name="severity"
                options={["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((s) => ({ value: s, label: humanize(s) }))}
                defaultValue="MEDIUM"
              />
            </Field>
            <Field label="Title" name="title" required span>
              <TextInput name="title" placeholder="One line stating what went wrong" />
            </Field>
            <Field label="Description" name="description" required span hint="Facts, dates, quantities and who observed it.">
              <TextArea name="description" rows={4} />
            </Field>
            <Field label="Related purchase order" name="relatedPoId">
              <Select
                name="relatedPoId"
                placeholder="Not order specific"
                options={targets.pos.map((p) => ({ value: p.id, label: p.number }))}
              />
            </Field>
            <Field label="Related GRN" name="relatedGrnId">
              <Select
                name="relatedGrnId"
                placeholder="Not receipt specific"
                options={targets.grns.map((g) => ({ value: g.id, label: g.number }))}
              />
            </Field>
            <Field label="Related invoice" name="relatedInvoiceId">
              <Select
                name="relatedInvoiceId"
                placeholder="Not invoice specific"
                options={targets.invoices.map((i) => ({
                  value: i.id,
                  label: `${i.number} — ${i.vendorInvoiceNumber}`,
                }))}
              />
            </Field>
          </FormSection>
          <InlineAlert tone="info">
            A critical issue, or a pattern of them, is grounds to open an investigation. Blacklisting always follows an
            investigation — it is never a direct action.
          </InlineAlert>
        </ActionForm>
      </Modal>
    </>
  );
}

export function UpdateIssueForm({
  issueId,
  number,
  currentStatus,
}: {
  issueId: string;
  number: string;
  currentStatus: string;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(currentStatus);
  const closing = ["RESOLVED", "CLOSED"].includes(status);

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Update issue
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Update ${number}`}
        description="Record the vendor's response and the resolution. An issue cannot be closed without a resolution on file."
        size="lg"
      >
        <ActionForm
          action={updateIssueAction}
          layout="bare"
          submitLabel="Save update"
          hiddenFields={{ issueId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={1}>
            <Field label="Status" name="status" required>
              <Select
                name="status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                options={["OPEN", "UNDER_REVIEW", "VENDOR_RESPONDED", "RESOLVED", "ESCALATED", "CLOSED"].map((s) => ({
                  value: s,
                  label: humanize(s),
                }))}
              />
            </Field>
            <Field label="Vendor response" name="vendorResponse" hint="What the vendor said, in their words.">
              <TextArea name="vendorResponse" rows={3} />
            </Field>
            <Field
              label="Resolution"
              name="resolution"
              required={closing}
              hint={closing ? "Mandatory — the issue is being resolved or closed." : "What was ultimately done."}
            >
              <TextArea name="resolution" rows={3} />
            </Field>
          </FormSection>
        </ActionForm>
      </Modal>
    </>
  );
}

/* ── Investigation ────────────────────────────────────────── */

const REASON_CODES = [
  "FORGED_DOCUMENTS",
  "ALTERED_DOCUMENTS",
  "QUALITY_COMPROMISE",
  "INVOICE_MISMATCH",
  "QUANTITY_MISMATCH",
  "PARTIAL_DELIVERIES",
  "LATE_DELIVERIES",
  "SERVICE_FAILURE",
  "AUDIT_FINDING",
  "POLICY_VIOLATION",
  "OTHER",
];

export function OpenInvestigationForm({
  vendorId,
  vendorName,
  openIssues,
}: {
  vendorId: string;
  vendorName: string;
  openIssues: number;
}) {
  const [open, setOpen] = useState(false);
  const [suspend, setSuspend] = useState(false);

  return (
    <>
      <button type="button" className="btn btn-danger-soft btn-sm" onClick={() => setOpen(true)}>
        Open investigation
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Open an investigation into ${vendorName}`}
        description="This starts the formal case that must run before any blacklisting decision. The vendor gets a right of reply, and audit reviews the evidence."
        size="lg"
      >
        <ActionForm
          action={openBlacklistCaseAction}
          layout="bare"
          submitLabel="Open investigation"
          hiddenFields={{ vendorId, suspendImmediately: suspend ? "true" : "" }}
          onSuccessRedirect={(data) => {
            const d = data as { id?: string } | null;
            return d?.id ? `/vendors/blacklist/${d.id}` : "/vendors/blacklist";
          }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={1}>
            <Field label="Reason code" name="reasonCode" required>
              <Select
                name="reasonCode"
                options={REASON_CODES.map((r) => ({ value: r, label: humanize(r) }))}
                defaultValue="QUALITY_COMPROMISE"
              />
            </Field>
            <Field label="Reason" name="reason" required hint="What prompted this, referencing the issues or documents concerned.">
              <TextArea name="reason" rows={3} />
            </Field>
            <Field label="Evidence held" name="evidence" hint="Documents, photographs, correspondence, audit findings.">
              <TextArea name="evidence" rows={3} />
            </Field>
            <Field label="Audit review" name="auditRequired">
              <Checkbox name="auditRequired" label="Audit review is required before a decision" defaultChecked value="true" />
            </Field>
            <Field label="Immediate suspension" name="suspendImmediatelyChoice">
              <Checkbox
                label="Suspend the vendor while the investigation runs"
                checked={suspend}
                onChange={(e) => setSuspend(e.target.checked)}
                hint="Use where continuing to trade would carry real risk. Suspension stops new RFQs and POs."
              />
            </Field>
          </FormSection>
          {openIssues > 0 && (
            <InlineAlert tone="info">
              {openIssues} open issue{openIssues === 1 ? "" : "s"} already exist against this vendor. They form part of
              the evidence base for this case.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

export function AdvanceCaseForm({
  caseId,
  number,
  stage,
  allowedStages,
  auditRequired,
}: {
  caseId: string;
  number: string;
  stage: string;
  allowedStages: string[];
  auditRequired: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(allowedStages[0] ?? "");
  const needsDecision = to === "DECISION_PENDING" || ["BLACKLISTED", "WARNING_ISSUED", "RETAINED"].includes(to);

  const decisionFor = (target: string) =>
    target === "BLACKLISTED"
      ? "BLACKLIST"
      : target === "WARNING_ISSUED"
        ? "WARNING"
        : target === "RETAINED"
          ? "RETAIN"
          : "";

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Advance case
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Advance ${number}`}
        description={`Currently at ${humanize(stage)}. Only the permitted next stages are offered, and the server re-checks both the transition and your authority.`}
        size="lg"
      >
        <ActionForm
          action={advanceCaseAction}
          layout="bare"
          submitLabel="Advance"
          hiddenFields={{ caseId, to, decision: decisionFor(to) || undefined }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={1}>
            <Field label="Move to" name="toChoice" required>
              <Select
                name="toChoice"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                options={allowedStages.map((s) => ({ value: s, label: humanize(s) }))}
              />
            </Field>
            <Field label="Investigation notes" name="notes">
              <TextArea name="notes" rows={3} />
            </Field>
            {to === "VENDOR_RESPONSE_AWAITED" || stage === "VENDOR_RESPONSE_AWAITED" ? (
              <Field label="Vendor response" name="vendorResponse" hint="Record the vendor's reply verbatim.">
                <TextArea name="vendorResponse" rows={3} />
              </Field>
            ) : null}
            {to === "PROCUREMENT_REVIEW" || stage === "PROCUREMENT_REVIEW" ? (
              <Field label="Procurement review" name="procurementReview">
                <TextArea name="procurementReview" rows={3} />
              </Field>
            ) : null}
            {to === "AUDIT_REVIEW" || stage === "AUDIT_REVIEW" ? (
              <Field label="Audit review" name="auditReview">
                <TextArea name="auditReview" rows={3} />
              </Field>
            ) : null}
            {needsDecision && (
              <Field
                label="Decision notes"
                name="decisionNotes"
                required
                hint="The reasoning behind the outcome. This is what an auditor will read."
              >
                <TextArea name="decisionNotes" rows={3} />
              </Field>
            )}
          </FormSection>

          {to === "DECISION_PENDING" && auditRequired && (
            <InlineAlert tone="info">
              Audit review is marked as required on this case, so the decision stage will be refused until the audit
              review is recorded.
            </InlineAlert>
          )}
          {to === "BLACKLISTED" && (
            <InlineAlert tone="danger">
              Blacklisting stops all sourcing with this vendor immediately and cannot be undone except by an explicit,
              reasoned reinstatement.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}
