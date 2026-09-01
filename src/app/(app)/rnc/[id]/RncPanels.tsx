"use client";

import { useState } from "react";
import { ActionButton, ActionForm } from "@/components/ui/forms";
import { Checkbox, Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { Badge, InlineAlert, SectionCard } from "@/components/ui/primitives";
import { fmtDate, fmtDateTime, money, percent } from "@/lib/format";
import { humanize } from "@/lib/domain";
import {
  addQuoteAction,
  recordDecisionEmailAction,
  recordTermsAction,
  resolveRncCaseAction,
  selectLandlordAction,
  setAttendanceAction,
} from "../actions";

type Quote = {
  id: string;
  landlordName: string;
  propertyRef: string | null;
  areaSqft: number | null;
  monthlyRent: number;
  annualEscalationPercent: number | null;
  advanceMonths: number | null;
  securityDeposit: number | null;
  leaseYears: number | null;
  technicalEvaluation: string | null;
  environmentalImpact: string | null;
  quoteAnalysisNote: string | null;
  isSelected: boolean;
  isLowest: boolean;
  selectionReason: string | null;
  indicativeLeaseCost: number | null;
};

export function RncPanels({
  kase,
  quotes,
  attendance,
  votes,
  quorum,
  caps,
}: {
  kase: {
    id: string;
    number: string;
    status: string;
    needAssessment: string | null;
    locationNote: string | null;
    commercialTerms: string | null;
    marketPracticeNote: string | null;
    landlordObligations: string | null;
    decisionSummary: string | null;
    decisionEmailRef: string | null;
    decisionEmailSentAt: Date | null;
    ceoOfficeCopied: boolean;
    quorumRequired: number | null;
    quorumPresent: number | null;
    headPresent: boolean;
  };
  quotes: Quote[];
  attendance: Array<{
    id: string;
    memberId: string;
    memberName: string;
    designation: string | null;
    memberType: string;
    isHead: boolean;
    attendance: string;
    proxyName: string | null;
  }>;
  votes: Array<{ id: string; memberName: string; vote: string; comment: string | null; castAt: Date }>;
  quorum: { required: number; present: number; headPresent: boolean; quorate: boolean; reason: string; mandatoryAbsent: string[] };
  caps: { canRaise: boolean; canManage: boolean; canVote: boolean };
}) {
  const decided = ["APPROVED", "REJECTED", "AGREEMENT_SIGNED", "CLOSED"].includes(kase.status);
  const open = !decided && kase.status !== "DEFERRED";

  return (
    <div className="space-y-4">
      {/* ── The comparative ───────────────────────────────── */}
      <SectionCard
        title="Landlord comparative — RN-007"
        description="Selection is on quote analysis, environmental impact and technical evaluation as well as price. A choice that is not the lowest rent needs its reasoning on the record."
        bodyClassName="px-0 py-0"
      >
        {quotes.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-xs text-muted">No quotations yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ minWidth: "12rem" }}>Landlord</th>
                  <th style={{ width: "7rem" }} className="text-right">Area sqft</th>
                  <th style={{ width: "8rem" }} className="text-right">Monthly rent</th>
                  <th style={{ width: "6rem" }} className="text-right">Escalation</th>
                  <th style={{ width: "6rem" }} className="text-right">Lease yrs</th>
                  <th style={{ width: "9rem" }} className="text-right">Over the lease</th>
                  <th style={{ width: "9rem" }}>Status</th>
                  {open && caps.canRaise && <th style={{ width: "7rem" }} />}
                </tr>
              </thead>
              <tbody>
                {quotes.map((q) => (
                  <tr key={q.id}>
                    <td className="text-xs">
                      {q.landlordName}
                      {q.propertyRef && (
                        <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{q.propertyRef}</span>
                      )}
                      {(q.technicalEvaluation || q.environmentalImpact) && (
                        <span className="mt-0.5 block text-2xs leading-4 text-muted">
                          {[q.technicalEvaluation, q.environmentalImpact].filter(Boolean).join(" · ")}
                        </span>
                      )}
                      {q.selectionReason && (
                        <span className="mt-0.5 block text-2xs leading-4 text-[var(--c-text-secondary)]">
                          Selected because: {q.selectionReason}
                        </span>
                      )}
                    </td>
                    <td className="tnum text-right">{q.areaSqft ?? "—"}</td>
                    <td className="tnum text-right">{money(q.monthlyRent)}</td>
                    <td className="tnum text-right text-2xs">
                      {q.annualEscalationPercent != null ? `${q.annualEscalationPercent}%` : "—"}
                    </td>
                    <td className="tnum text-right text-2xs">{q.leaseYears ?? "—"}</td>
                    <td className="tnum text-right">
                      {q.indicativeLeaseCost != null ? money(q.indicativeLeaseCost) : "—"}
                    </td>
                    <td className="text-2xs">
                      {q.isSelected && <Badge tone="success">Selected</Badge>}
                      {q.isLowest && !q.isSelected && <Badge tone="neutral">Lowest rent</Badge>}
                      {q.isLowest && q.isSelected && (
                        <span className="ml-1 text-[var(--c-text-tertiary)]">and lowest</span>
                      )}
                    </td>
                    {open && caps.canRaise && (
                      <td className="text-right">
                        {!q.isSelected && (
                          <ActionButton
                            action={selectLandlordAction}
                            payload={{ caseId: kase.id, quoteId: q.id }}
                            label="Select"
                            size="xs"
                            reasonLabel={
                              q.isLowest
                                ? "Note (optional)"
                                : "Why this landlord and not the lowest rent"
                            }
                            reasonRequired={!q.isLowest}
                          />
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {quotes.length === 1 && (
          <p className="px-3.5 py-2.5 text-2xs text-[var(--c-warning)]">
            One quotation is not a comparative. RN-007 selects the landlord on one, and selection is refused until
            there are at least two.
          </p>
        )}
      </SectionCard>

      {open && caps.canRaise && (
        <SectionCard title="Add a landlord quotation">
          <ActionForm
            action={addQuoteAction}
            layout="bare"
            submitLabel="Add"
            hiddenFields={{ caseId: kase.id }}
            resetOnSuccess
          >
            <FormSection columns={3}>
              <Field label="Landlord" name="landlordName" required>
                <TextInput name="landlordName" required />
              </Field>
              <Field label="Property reference" name="propertyRef">
                <TextInput name="propertyRef" />
              </Field>
              <Field label="Area (sqft)" name="areaSqft">
                <TextInput type="number" min="0" step="1" name="areaSqft" />
              </Field>
              <Field label="Monthly rent" name="monthlyRent" required>
                <TextInput type="number" min="0" step="0.01" name="monthlyRent" required />
              </Field>
              <Field label="Annual escalation %" name="annualEscalationPercent">
                <TextInput type="number" min="0" step="0.1" name="annualEscalationPercent" />
              </Field>
              <Field label="Lease years" name="leaseYears">
                <TextInput type="number" min="0" step="0.5" name="leaseYears" />
              </Field>
              <Field label="Advance months" name="advanceMonths">
                <TextInput type="number" min="0" step="1" name="advanceMonths" />
              </Field>
              <Field label="Security deposit" name="securityDeposit">
                <TextInput type="number" min="0" step="0.01" name="securityDeposit" />
              </Field>
              <Field label="Technical evaluation" name="technicalEvaluation">
                <TextInput name="technicalEvaluation" />
              </Field>
              <Field label="Environmental impact" name="environmentalImpact">
                <TextInput name="environmentalImpact" />
              </Field>
              <Field label="Quote analysis" name="quoteAnalysisNote" className="sm:col-span-2">
                <TextInput name="quoteAnalysisNote" />
              </Field>
            </FormSection>
          </ActionForm>
        </SectionCard>
      )}

      {/* ── Attendance and quorum ─────────────────────────── */}
      <SectionCard
        title="Attendance and quorum — RN-004"
        description={quorum.reason}
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ minWidth: "12rem" }}>Member</th>
                <th style={{ minWidth: "11rem" }}>Type</th>
                <th style={{ width: "9rem" }}>Attendance</th>
                {kase.status === "PENDING_RNC" && caps.canManage && <th style={{ minWidth: "13rem" }} />}
              </tr>
            </thead>
            <tbody>
              {attendance.map((a) => (
                <tr key={a.id}>
                  <td className="text-xs">
                    {a.memberName}
                    {a.isHead && <Badge tone="accent" className="ml-2">Head</Badge>}
                    {a.designation && (
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{a.designation}</span>
                    )}
                  </td>
                  <td className="text-2xs">{humanize(a.memberType)}</td>
                  <td className="text-2xs">
                    <Badge
                      tone={
                        a.attendance === "PRESENT"
                          ? "success"
                          : a.attendance === "PROXY"
                            ? "progress"
                            : "neutral"
                      }
                    >
                      {humanize(a.attendance)}
                    </Badge>
                    {a.proxyName && (
                      <span className="mt-0.5 block text-[var(--c-text-tertiary)]">by {a.proxyName}</span>
                    )}
                  </td>
                  {kase.status === "PENDING_RNC" && caps.canManage && (
                    <td>
                      <div className="flex flex-wrap gap-1.5">
                        <ActionButton
                          action={setAttendanceAction}
                          payload={{ caseId: kase.id, memberId: a.memberId, attendance: "PRESENT" }}
                          label="Present"
                          size="xs"
                          tone="success"
                        />
                        <ActionButton
                          action={setAttendanceAction}
                          payload={{ caseId: kase.id, memberId: a.memberId, attendance: "PROXY" }}
                          label="By proxy"
                          size="xs"
                          reasonLabel="Proxy's name"
                          reasonRequired
                        />
                        <ActionButton
                          action={setAttendanceAction}
                          payload={{ caseId: kase.id, memberId: a.memberId, attendance: "ABSENT" }}
                          label="Absent"
                          size="xs"
                        />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {quorum.mandatoryAbsent.length > 0 && (
          <p className="px-3.5 py-2.5 text-2xs text-[var(--c-warning)]">
            Mandatory member(s) neither present nor proxied: {quorum.mandatoryAbsent.join(", ")}. A permanent-mandatory
            seat is one the committee cannot sit without.
          </p>
        )}
      </SectionCard>

      {votes.length > 0 && (
        <SectionCard title="Votes" bodyClassName="px-0 py-0">
          <ul className="row-list">
            {votes.map((v) => (
              <li key={v.id} className="flex flex-wrap items-baseline gap-x-3 px-3.5 py-2">
                <span className="text-xs">{v.memberName}</span>
                <Badge tone={v.vote === "APPROVE" ? "success" : v.vote === "REJECT" ? "danger" : "warning"}>
                  {humanize(v.vote)}
                </Badge>
                <span className="text-2xs text-[var(--c-text-tertiary)]">{fmtDate(v.castAt)}</span>
                {v.comment && <span className="w-full text-2xs leading-4 text-muted">{v.comment}</span>}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* ── Terms ─────────────────────────────────────────── */}
      <SectionCard
        title="Commercial terms — RN-008 and RN-009"
        description="Whether the terms sit within general market practice, and the landlord's own obligations written into the agreement."
      >
        <div className="space-y-2 text-xs">
          {kase.commercialTerms && <p className="whitespace-pre-line leading-5">{kase.commercialTerms}</p>}
          {kase.marketPracticeNote && (
            <p className="whitespace-pre-line leading-5 text-muted">
              Market practice: {kase.marketPracticeNote}
            </p>
          )}
          {kase.landlordObligations && (
            <p className="whitespace-pre-line leading-5 text-muted">
              Landlord&rsquo;s obligations: {kase.landlordObligations}
            </p>
          )}
          {!kase.commercialTerms && !kase.landlordObligations && (
            <p className="text-muted">Not recorded yet.</p>
          )}
        </div>
        {open && caps.canRaise && (
          <div className="mt-3">
            <ActionForm
              action={recordTermsAction}
              layout="bare"
              submitLabel="Save terms"
              hiddenFields={{ caseId: kase.id }}
            >
              <FormSection columns={1}>
                <Field label="Commercial terms" name="commercialTerms">
                  <TextArea name="commercialTerms" rows={3} defaultValue={kase.commercialTerms ?? ""} />
                </Field>
                <Field
                  label="Why these are in line with market practice"
                  name="marketPracticeNote"
                  hint="RN-008. The evidence, not the assertion."
                >
                  <TextArea name="marketPracticeNote" rows={2} defaultValue={kase.marketPracticeNote ?? ""} />
                </Field>
                <Field
                  label="Landlord's obligations"
                  name="landlordObligations"
                  hint="RN-009 — discussed, agreed, and made part of the agreement."
                >
                  <TextArea name="landlordObligations" rows={3} defaultValue={kase.landlordObligations ?? ""} />
                </Field>
              </FormSection>
            </ActionForm>
          </div>
        )}
      </SectionCard>

      {/* ── The decision ──────────────────────────────────── */}
      {kase.status === "PENDING_RNC" && caps.canManage && (
        <SectionCard
          title="Record the committee's decision"
          description={
            quorum.quorate
              ? "The committee is quorate."
              : "Not quorate — only a deferral can be recorded, which is RN-004's own remedy."
          }
        >
          <ResolveForm caseId={kase.id} quorate={quorum.quorate} />
        </SectionCard>
      )}

      {kase.decisionSummary && (
        <SectionCard title="Decision" bodyClassName="px-3.5 py-3">
          <p className="whitespace-pre-line text-xs leading-5">{kase.decisionSummary}</p>
          {kase.quorumRequired != null && (
            <p className="mt-2 text-2xs text-[var(--c-text-tertiary)]">
              Quorate with {kase.quorumPresent} of {kase.quorumRequired} permanent members beside the head
              {kase.headPresent ? ", head present" : ""} — as the roster stood on the day.
            </p>
          )}
        </SectionCard>
      )}

      {kase.status === "APPROVED" && (
        <SectionCard
          title="Decision trail — RN-010"
          description="A detailed email of the decision to members, copying the CEO's office, with the documentation trail Finance needs to initiate payment."
        >
          {kase.decisionEmailRef ? (
            <p className="text-xs">
              {kase.decisionEmailRef}
              <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                {kase.decisionEmailSentAt ? fmtDateTime(kase.decisionEmailSentAt) : ""}
                {kase.ceoOfficeCopied ? " · CEO's office copied" : ""}
              </span>
            </p>
          ) : caps.canManage ? (
            <ActionForm
              action={recordDecisionEmailAction}
              layout="bare"
              submitLabel="Record the trail"
              hiddenFields={{ caseId: kase.id }}
            >
              <FormSection columns={1}>
                <Field
                  label="Email reference"
                  name="emailRef"
                  required
                  hint="A message id, subject line or filing reference — something that can be found again."
                >
                  <TextInput name="emailRef" required />
                </Field>
                <Field label="" name="ceoOfficeCopied">
                  <Checkbox
                    name="ceoOfficeCopied"
                    label="The CEO's office was copied"
                    hint="RN-010 requires it. Without it the trail is incomplete and payment should not start."
                  />
                </Field>
              </FormSection>
            </ActionForm>
          ) : (
            <p className="text-xs text-[var(--c-warning)]">Not recorded.</p>
          )}
        </SectionCard>
      )}
    </div>
  );
}

function ResolveForm({ caseId, quorate }: { caseId: string; quorate: boolean }) {
  const [outcome, setOutcome] = useState(quorate ? "APPROVED" : "DEFERRED");
  return (
    <ActionForm
      action={resolveRncCaseAction}
      layout="bare"
      submitLabel="Record the decision"
      hiddenFields={{ caseId, outcome }}
    >
      <FormSection columns={1}>
        <Field label="Outcome" name="outcomeChoice" required>
          <Select
            name="outcomeChoice"
            value={outcome}
            onChange={(e) => setOutcome(e.currentTarget.value)}
            options={[
              ...(quorate
                ? [
                    { value: "APPROVED", label: "Approved" },
                    { value: "REJECTED", label: "Rejected" },
                  ]
                : []),
              { value: "DEFERRED", label: "Deferred to the next RNC" },
            ]}
          />
        </Field>
        <Field label="What the committee decided, and why" name="summary" required>
          <TextArea name="summary" rows={3} required />
        </Field>
        {outcome === "DEFERRED" && (
          <Field label="Why it is being deferred" name="deferredReason">
            <TextInput name="deferredReason" placeholder="Left blank, the quorum shortfall is recorded." />
          </Field>
        )}
      </FormSection>
    </ActionForm>
  );
}
