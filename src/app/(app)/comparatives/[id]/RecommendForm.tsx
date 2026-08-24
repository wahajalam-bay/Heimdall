"use client";

import { useMemo, useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Field, FormSection, TextArea } from "@/components/ui/field";
import { Badge, BlockedNotice, InlineAlert } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { money, percent, round2 } from "@/lib/format";
import { raiseCpcCaseAction, recommendVendorAction } from "@/app/(app)/rfq/actions";

export type CandidateLine = {
  quoteId: string;
  vendorId: string;
  vendorName: string;
  netTotal: number;
  technicalCompliance: string;
  deliveryDays: number | null;
  warrantyMonths: number | null;
  paymentTerms: string | null;
  vendorScore: number | null;
  onTimePercent: number | null;
  scoreTotal: number | null;
  isLowest: boolean;
  isLowestCompliant: boolean;
  isSelected: boolean;
};

/**
 * Records the sourcing recommendation. The lowest compliant quotation is
 * computed and displayed, and choosing anything above it forces a written
 * justification — which the server enforces independently.
 */
export function RecommendForm({
  comparativeId,
  lines,
  requireJustification,
}: {
  comparativeId: string;
  lines: CandidateLine[];
  requireJustification: boolean;
}) {
  const [open, setOpen] = useState(false);
  const preselected = lines.find((l) => l.isSelected)?.quoteId ?? "";
  const [quoteId, setQuoteId] = useState(preselected);

  const benchmark = useMemo(() => {
    const compliant = lines.filter((l) => l.technicalCompliance === "COMPLIANT");
    const pool = compliant.length ? compliant : lines;
    return pool.length ? Math.min(...pool.map((l) => l.netTotal)) : 0;
  }, [lines]);

  const chosen = lines.find((l) => l.quoteId === quoteId);
  const isBenchmark = chosen ? chosen.netTotal <= benchmark + 0.01 : true;
  const needsJustification = Boolean(chosen && !isBenchmark && requireJustification);
  const delta = chosen ? round2(chosen.netTotal - benchmark) : 0;

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        {preselected ? "Revise recommendation" : "Recommend a vendor"}
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Record the sourcing recommendation"
        description="Selection is not automatic. Choose on the merits — price, compliance, delivery, vendor performance, warranty and terms — and record why."
        size="xl"
      >
        <ActionForm
          action={recommendVendorAction}
          layout="bare"
          submitLabel="Record recommendation"
          hiddenFields={{ comparativeId, quoteId }}
          onSuccessRedirect={`/comparatives/${comparativeId}`}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: "2.5rem" }} />
                    <th style={{ minWidth: "13rem" }}>Vendor</th>
                    <th className="text-right">Net total</th>
                    <th className="text-right">vs benchmark</th>
                    <th>Compliance</th>
                    <th className="text-right">Lead</th>
                    <th className="text-right">Warranty</th>
                    <th>Terms</th>
                    <th className="text-right">Vendor score</th>
                    <th className="text-right">On-time</th>
                    <th className="text-right">Weighted</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {[...lines]
                    .sort((a, b) => a.netTotal - b.netTotal)
                    .map((l) => {
                      const diff = round2(l.netTotal - benchmark);
                      return (
                        <tr
                          key={l.quoteId}
                          className={quoteId === l.quoteId ? "bg-[var(--c-accent-soft)]" : undefined}
                          onClick={() => setQuoteId(l.quoteId)}
                          data-clickable="true"
                        >
                          <td>
                            <input
                              type="radio"
                              name="candidate"
                              checked={quoteId === l.quoteId}
                              onChange={() => setQuoteId(l.quoteId)}
                              aria-label={`Recommend ${l.vendorName}`}
                            />
                          </td>
                          <td className="font-500">{l.vendorName}</td>
                          <td className="num font-500">{money(l.netTotal)}</td>
                          <td className="num">
                            {diff <= 0.01 ? (
                              <span className="text-[var(--c-success)]">benchmark</span>
                            ) : (
                              <span className="text-[var(--c-danger)]">+{money(diff)}</span>
                            )}
                          </td>
                          <td>
                            <Badge
                              tone={
                                l.technicalCompliance === "COMPLIANT"
                                  ? "success"
                                  : l.technicalCompliance === "PARTIAL"
                                    ? "warning"
                                    : l.technicalCompliance === "NON_COMPLIANT"
                                      ? "danger"
                                      : "neutral"
                              }
                            >
                              {humanize(l.technicalCompliance)}
                            </Badge>
                          </td>
                          <td className="num text-2xs">{l.deliveryDays ? `${l.deliveryDays}d` : "—"}</td>
                          <td className="num text-2xs">{l.warrantyMonths ? `${l.warrantyMonths}m` : "—"}</td>
                          <td className="text-2xs">{l.paymentTerms ?? "—"}</td>
                          <td className="num text-2xs">
                            {l.vendorScore !== null ? percent(l.vendorScore, 0) : "—"}
                          </td>
                          <td className="num text-2xs">
                            {l.onTimePercent !== null ? percent(l.onTimePercent, 0) : "—"}
                          </td>
                          <td className="num text-2xs font-500">{l.scoreTotal !== null ? l.scoreTotal.toFixed(1) : "—"}</td>
                          <td>
                            <span className="flex flex-wrap gap-1">
                              {l.isLowest && <Badge tone="info">Lowest</Badge>}
                              {l.isLowestCompliant && <Badge tone="success">Lowest compliant</Badge>}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>

          {chosen && (
            <InlineAlert tone={isBenchmark ? "success" : "warning"}>
              {isBenchmark ? (
                <>
                  <span className="font-600">{chosen.vendorName}</span> is the lowest compliant quotation at{" "}
                  {money(chosen.netTotal)}. No additional justification is required.
                </>
              ) : (
                <>
                  <span className="font-600">{chosen.vendorName}</span> at {money(chosen.netTotal)} is {money(delta)} above
                  the lowest compliant quotation of {money(benchmark)}. A written justification is mandatory.
                </>
              )}
            </InlineAlert>
          )}

          {chosen?.technicalCompliance === "NON_COMPLIANT" && (
            <BlockedNotice
              title="This quotation is marked technically non-compliant"
              reasons={[
                "Awarding a non-compliant offer is a material control exception. Confirm the compliance assessment is correct before proceeding, and state in the justification why the deviation is acceptable.",
              ]}
              tone="danger"
            />
          )}

          <FormSection columns={1}>
            <Field
              label="Basis of recommendation"
              name="basis"
              required
              span
              hint="What made this the right award — this is what the committee and audit will read."
            >
              <TextArea
                name="basis"
                rows={4}
                placeholder="e.g. Lowest compliant quotation after two negotiation rounds. Full specification match, 3-year onsite warranty, 10-day delivery and the strongest on-time record of the three vendors."
              />
            </Field>
            {needsJustification && (
              <Field
                label="Justification for not selecting the lowest compliant quotation"
                name="nonLowestJustification"
                required
                span
                hint="Explain concretely why the cheaper compliant offer was not acceptable. A tracked exception is raised either way."
              >
                <TextArea
                  name="nonLowestJustification"
                  rows={4}
                  placeholder="e.g. The lower offer is from a non-filer trader supplying mixed-mill stock without per-heat mill certificates, which cannot be accepted for structural reinforcement."
                />
              </Field>
            )}
          </FormSection>
        </ActionForm>
      </Modal>
    </>
  );
}

export function RaiseCpcButton({
  comparativeId,
  suggestedRecommendation,
  suggestedRisk,
  threshold,
  amount,
}: {
  comparativeId: string;
  suggestedRecommendation: string;
  suggestedRisk: string;
  threshold: number;
  amount: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Raise CPC case
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Raise a Central Procurement Committee case"
        description={`Case value ${money(amount)} is at or above the configured committee threshold of ${money(threshold)} for this entity.`}
        size="lg"
      >
        <ActionForm
          action={raiseCpcCaseAction}
          layout="bare"
          submitLabel="Raise case"
          hiddenFields={{ comparativeId }}
          onSuccessRedirect={(data) => {
            const d = data as { id?: string } | null;
            return d?.id ? `/cpc/cases/${d.id}` : "/cpc/cases";
          }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={1}>
            <Field
              label="Recommendation to the committee"
              name="recommendation"
              span
              hint="Committee members see this first, alongside the full comparative and the vendor's history."
            >
              <TextArea name="recommendation" rows={4} defaultValue={suggestedRecommendation} />
            </Field>
            <Field
              label="Risks and control notes"
              name="riskNotes"
              span
              hint="Vendor concentration, price volatility, advance payment exposure, warranty dependence, anything the committee should weigh."
            >
              <TextArea name="riskNotes" rows={3} defaultValue={suggestedRisk} />
            </Field>
          </FormSection>
        </ActionForm>
      </Modal>
    </>
  );
}
