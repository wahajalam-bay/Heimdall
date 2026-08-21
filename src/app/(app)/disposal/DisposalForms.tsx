"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { Badge, InlineAlert } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { money, round2, toInputDate } from "@/lib/format";
import { addBidAction, advanceDisposalAction, createDisposalAction } from "@/app/(app)/assets/actions";

const CATEGORIES = [
  "FURNITURE",
  "IT_HARDWARE",
  "MOBILE",
  "MARKETING_MATERIAL",
  "CONSTRUCTION_SCRAP",
  "COMPLETE_WASTE",
  "EQUIPMENT",
  "OTHER",
];
const ACTIONS = ["REUSE", "TRANSFER", "REPAIR", "SCRAP", "DISPOSE", "SALE"];
const CONDITIONS = ["IDLE", "OBSOLETE", "DAMAGED", "UNREPAIRABLE", "EXPIRED", "SCRAP"];

export type Candidate = {
  kind: "asset" | "stock";
  key: string;
  assetId: string | null;
  itemId: string | null;
  storeId: string | null;
  label: string;
  sub: string;
  entityId: string;
  quantity: number;
  unit: string;
  bookValue: number;
};

type Line = {
  key: string;
  candidateKey: string;
  description: string;
  quantity: string;
  unit: string;
  condition: string;
  bookValue: string;
  estimatedValue: string;
  notes: string;
};

let seq = 0;

/* ── Raise a disposal case ────────────────────────────────── */

export function DisposalForm({
  entities,
  candidates,
  defaultEntityId,
  preselectAssetId,
  biddingThresholds,
}: {
  entities: Array<{ id: string; code: string; name: string }>;
  candidates: Candidate[];
  defaultEntityId: string;
  preselectAssetId?: string;
  /** Configured value above which competitive bidding is mandatory. */
  biddingThresholds: Record<string, number>;
}) {
  const [entityId, setEntityId] = useState(defaultEntityId);
  const eligible = useMemo(() => candidates.filter((c) => c.entityId === entityId), [candidates, entityId]);

  const [lines, setLines] = useState<Line[]>(() => {
    const pre = preselectAssetId ? candidates.find((c) => c.assetId === preselectAssetId) : null;
    if (pre) {
      return [
        {
          key: `dl-${++seq}`,
          candidateKey: pre.key,
          description: pre.label,
          quantity: String(pre.quantity),
          unit: pre.unit,
          condition: "OBSOLETE",
          bookValue: String(pre.bookValue),
          estimatedValue: "",
          notes: "",
        },
      ];
    }
    return [
      {
        key: `dl-${++seq}`,
        candidateKey: "",
        description: "",
        quantity: "1",
        unit: "EA",
        condition: "OBSOLETE",
        bookValue: "",
        estimatedValue: "",
        notes: "",
      },
    ];
  });

  const patch = (key: string, changes: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...changes } : l)));

  const chooseCandidate = (key: string, candidateKey: string) => {
    const c = candidates.find((x) => x.key === candidateKey);
    patch(key, {
      candidateKey,
      description: c ? c.label : "",
      quantity: c ? String(c.quantity) : "1",
      unit: c ? c.unit : "EA",
      bookValue: c ? String(round2(c.bookValue)) : "",
    });
  };

  const estimated = round2(lines.reduce((a, l) => a + (Number(l.estimatedValue) || 0), 0));
  const bookTotal = round2(lines.reduce((a, l) => a + (Number(l.bookValue) || 0), 0));
  const threshold = biddingThresholds[entityId] ?? 0;
  const biddingRequired = threshold > 0 && estimated > threshold;

  const payload = JSON.stringify(
    lines
      .filter((l) => l.description.trim() && Number(l.quantity) > 0)
      .map((l) => {
        const c = candidates.find((x) => x.key === l.candidateKey);
        return {
          assetId: c?.assetId ?? null,
          itemId: c?.itemId ?? null,
          storeId: c?.storeId ?? null,
          description: l.description.trim(),
          quantity: Number(l.quantity),
          unit: l.unit || "EA",
          condition: l.condition,
          bookValue: l.bookValue === "" ? null : Number(l.bookValue),
          estimatedValue: l.estimatedValue === "" ? null : Number(l.estimatedValue),
          notes: l.notes || null,
        };
      }),
  );

  return (
    <ActionForm
      action={createDisposalAction}
      submitLabel="Raise disposal case"
      hiddenFields={{ entityId, items: payload, estimatedValue: estimated || undefined }}
      onSuccessRedirect={(data) => {
        const d = data as { id?: string } | null;
        return d?.id ? `/disposal/${d.id}` : "/disposal";
      }}
      footerSticky
      secondary={
        <Link href="/disposal" className="btn btn-secondary">
          Cancel
        </Link>
      }
    >
      <InlineAlert tone="info">
        Nothing leaves the business on this route without assessment, audit review and approval. Where the estimated
        value crosses the configured threshold, competitive bidding is mandatory rather than optional.
      </InlineAlert>

      <FormSection title="Case" columns={3}>
        <Field label="Entity" name="entitySelect" required>
          <Select
            name="entitySelect"
            value={entityId}
            onChange={(e) => {
              setEntityId(e.target.value);
              setLines((prev) => prev.map((l) => ({ ...l, candidateKey: "" })));
            }}
            options={entities.map((e) => ({ value: e.id, label: `${e.code} — ${e.name}` }))}
          />
        </Field>
        <Field label="Category" name="disposalCategory" required>
          <Select
            name="disposalCategory"
            options={CATEGORIES.map((c) => ({ value: c, label: humanize(c) }))}
            defaultValue="IT_HARDWARE"
          />
        </Field>
        <Field label="Recommended action" name="recommendedAction" required hint="What procurement believes should happen.">
          <Select
            name="recommendedAction"
            options={ACTIONS.map((a) => ({ value: a, label: humanize(a) }))}
            defaultValue="SALE"
          />
        </Field>
        <Field label="Title" name="title" required span>
          <TextInput name="title" placeholder="e.g. Obsolete IT hardware — Q1 refresh, Gulberg office" />
        </Field>
        <Field
          label="Assessment notes"
          name="assessmentNotes"
          span
          hint="Condition, why it cannot be redeployed, and the basis for the estimated value."
        >
          <TextArea name="assessmentNotes" rows={3} />
        </Field>
      </FormSection>

      <FormSection title="Items" columns={1}>
        <div className="space-y-2.5 sm:col-span-full">
          <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--c-border)]">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ minWidth: "16rem" }}>Asset or stock</th>
                  <th style={{ minWidth: "14rem" }}>Description</th>
                  <th className="text-right" style={{ width: "6.5rem" }}>Qty</th>
                  <th style={{ width: "5.5rem" }}>Unit</th>
                  <th style={{ width: "10rem" }}>Condition</th>
                  <th className="text-right" style={{ width: "9rem" }}>Book value</th>
                  <th className="text-right" style={{ width: "9rem" }}>Estimated value</th>
                  <th style={{ width: "4rem" }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key}>
                    <td>
                      <select
                        className="field"
                        value={l.candidateKey}
                        onChange={(e) => chooseCandidate(l.key, e.target.value)}
                        aria-label="Asset or stock"
                      >
                        <option value="">Free-text item</option>
                        {eligible.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label} · {c.sub}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="field"
                        value={l.description}
                        onChange={(e) => patch(l.key, { description: e.target.value })}
                        aria-label="Description"
                      />
                    </td>
                    <td>
                      <input
                        className="field text-right"
                        type="number"
                        step="any"
                        min="0"
                        value={l.quantity}
                        onChange={(e) => patch(l.key, { quantity: e.target.value })}
                        aria-label="Quantity"
                      />
                    </td>
                    <td>
                      <input
                        className="field"
                        value={l.unit}
                        onChange={(e) => patch(l.key, { unit: e.target.value })}
                        aria-label="Unit"
                      />
                    </td>
                    <td>
                      <select
                        className="field"
                        value={l.condition}
                        onChange={(e) => patch(l.key, { condition: e.target.value })}
                        aria-label="Condition"
                      >
                        {CONDITIONS.map((c) => (
                          <option key={c} value={c}>
                            {humanize(c)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="field text-right"
                        type="number"
                        step="any"
                        min="0"
                        value={l.bookValue}
                        onChange={(e) => patch(l.key, { bookValue: e.target.value })}
                        aria-label="Book value"
                      />
                    </td>
                    <td>
                      <input
                        className="field text-right"
                        type="number"
                        step="any"
                        min="0"
                        value={l.estimatedValue}
                        onChange={(e) => patch(l.key, { estimatedValue: e.target.value })}
                        aria-label="Estimated value"
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs text-[var(--c-danger)]"
                        onClick={() =>
                          setLines((prev) => (prev.length === 1 ? prev : prev.filter((x) => x.key !== l.key)))
                        }
                        disabled={lines.length === 1}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() =>
                setLines((prev) => [
                  ...prev,
                  {
                    key: `dl-${++seq}`,
                    candidateKey: "",
                    description: "",
                    quantity: "1",
                    unit: "EA",
                    condition: "OBSOLETE",
                    bookValue: "",
                    estimatedValue: "",
                    notes: "",
                  },
                ])
              }
            >
              + Add line
            </button>
            <div className="flex flex-wrap items-baseline gap-4 text-xs">
              <span>
                <span className="text-[var(--c-text-secondary)]">Book value </span>
                <span className="tnum font-600">{money(bookTotal)}</span>
              </span>
              <span>
                <span className="text-[var(--c-text-secondary)]">Estimated realisation </span>
                <span className="tnum font-600">{money(estimated)}</span>
              </span>
            </div>
          </div>

          {biddingRequired && (
            <InlineAlert tone="warning">
              At {money(estimated)} this case is above the {money(threshold)} bidding threshold for this entity, so
              competitive bids will be required before any sale is approved.
            </InlineAlert>
          )}
          {bookTotal > 0 && estimated > 0 && estimated < bookTotal * 0.25 && (
            <InlineAlert tone="info">
              The estimated realisation is less than a quarter of book value. Expect audit to question the valuation —
              make the basis explicit in the assessment notes.
            </InlineAlert>
          )}
        </div>
      </FormSection>
    </ActionForm>
  );
}

/* ── Advance the case ─────────────────────────────────────── */

export function AdvanceDisposalForm({
  caseId,
  number,
  stage,
  allowedStages,
  bids,
  estimatedValue,
}: {
  caseId: string;
  number: string;
  stage: string;
  allowedStages: string[];
  bids: Array<{ id: string; bidderName: string; amount: number; status: string }>;
  estimatedValue: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(allowedStages[0] ?? "");
  const highest = bids.length ? Math.max(...bids.map((b) => b.amount)) : 0;
  const [winningBidId, setWinningBidId] = useState(bids.find((b) => b.amount === highest)?.id ?? "");

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Advance case
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Advance ${number}`}
        description={`Currently at ${humanize(stage)}. Only permitted transitions are offered, and the server re-checks both the transition and your authority.`}
        size="lg"
      >
        <ActionForm
          action={advanceDisposalAction}
          layout="bare"
          submitLabel="Advance"
          hiddenFields={{
            caseId,
            to,
            winningBidId: to === "MANAGEMENT_APPROVAL" || to === "BID_EVALUATION" ? winningBidId || undefined : undefined,
          }}
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

            {(stage === "FLAGGED" || to === "ASSESSMENT") && (
              <Field label="Assessment notes" name="assessmentNotes" hint="Condition, redeployment options considered, valuation basis.">
                <TextArea name="assessmentNotes" rows={3} />
              </Field>
            )}
            {to === "AUDIT_REVIEW" || stage === "AUDIT_REVIEW" ? (
              <Field label="Audit notes" name="auditNotes" hint="Audit's view on the valuation and the process followed.">
                <TextArea name="auditNotes" rows={3} />
              </Field>
            ) : null}
            {to === "BIDDING" && (
              <Field label="Bid deadline" name="bidDeadline" required hint="Bids after this date are not considered.">
                <TextInput type="date" name="bidDeadline" defaultValue={toInputDate(new Date(Date.now() + 7 * 86400000))} />
              </Field>
            )}
            {["APPROVED", "MANAGEMENT_APPROVAL", "COMPLETED", "PAYMENT_PENDING"].includes(to) && (
              <Field label="Final action" name="finalAction" hint="What will actually be done with the items.">
                <Select
                  name="finalAction"
                  placeholder="Keep the recommended action"
                  options={ACTIONS.map((a) => ({ value: a, label: humanize(a) }))}
                />
              </Field>
            )}
            {to === "PAYMENT_RECEIVED" && (
              <>
                <Field label="Payment reference" name="paymentReference" required>
                  <TextInput name="paymentReference" placeholder="Bank transaction or receipt number" />
                </Field>
                <Field
                  label="Realised value"
                  name="realisedValue"
                  required
                  hint={estimatedValue ? `Estimated at ${money(estimatedValue)}` : undefined}
                >
                  <TextInput type="number" step="any" min="0" name="realisedValue" defaultValue={highest || ""} />
                </Field>
              </>
            )}
            <Field label="Notes" name="notes">
              <TextArea name="notes" rows={2} />
            </Field>
          </FormSection>

          {(to === "MANAGEMENT_APPROVAL" || to === "BID_EVALUATION") && bids.length > 0 && (
            <div>
              <span className="label mb-1.5 block">Winning bid</span>
              <div className="space-y-1.5">
                {bids.map((b) => (
                  <label
                    key={b.id}
                    className={`flex cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-md)] border px-3 py-2 ${
                      winningBidId === b.id ? "border-[var(--c-accent)] bg-[var(--c-accent-soft)]" : "border-[var(--c-border)]"
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      <input
                        type="radio"
                        name="bidChoice"
                        checked={winningBidId === b.id}
                        onChange={() => setWinningBidId(b.id)}
                      />
                      <span className="text-xs">{b.bidderName}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {b.amount >= highest && <Badge tone="success">Highest</Badge>}
                      <span className="tnum text-xs font-600">{money(b.amount)}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {to === "COMPLETED" && (
            <InlineAlert tone="warning">
              Completing the case writes the assets off the register and removes any stock from inventory through the
              ledger. It cannot be undone.
            </InlineAlert>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

/* ── Record a bid ─────────────────────────────────────────── */

export function AddBidForm({
  caseId,
  number,
  vendors,
  bidCount,
  estimatedValue,
}: {
  caseId: string;
  number: string;
  vendors: Array<{ id: string; name: string }>;
  bidCount: number;
  estimatedValue: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [vendorId, setVendorId] = useState("");
  const [bidderName, setBidderName] = useState("");

  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        Record bid
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Record a bid on ${number}`}
        description={`${bidCount} bid${bidCount === 1 ? "" : "s"} recorded so far${estimatedValue ? ` against an estimate of ${money(estimatedValue)}` : ""}.`}
        size="md"
      >
        <ActionForm
          action={addBidAction}
          layout="bare"
          submitLabel="Record bid"
          hiddenFields={{ caseId, vendorId: vendorId || undefined }}
          resetOnSuccess
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Close
            </button>
          }
        >
          <FormSection columns={2}>
            <Field label="Registered vendor" name="vendorSelect" hint="Optional — scrap buyers are often unregistered.">
              <Select
                name="vendorSelect"
                placeholder="Not a registered vendor"
                options={vendors.map((v) => ({ value: v.id, label: v.name }))}
                value={vendorId}
                onChange={(e) => {
                  setVendorId(e.target.value);
                  const v = vendors.find((x) => x.id === e.target.value);
                  if (v) setBidderName(v.name);
                }}
              />
            </Field>
            <Field label="Bidder name" name="bidderName" required>
              <TextInput name="bidderName" value={bidderName} onChange={(e) => setBidderName(e.target.value)} />
            </Field>
            <Field label="Contact phone" name="contactPhone">
              <TextInput name="contactPhone" />
            </Field>
            <Field label="Bid amount (PKR)" name="amount" required>
              <TextInput type="number" step="any" min="0" name="amount" />
            </Field>
            <Field label="Notes" name="notes" span>
              <TextArea name="notes" rows={2} placeholder="Collection terms, condition accepted as seen, and so on." />
            </Field>
          </FormSection>
        </ActionForm>
      </Modal>
    </>
  );
}
