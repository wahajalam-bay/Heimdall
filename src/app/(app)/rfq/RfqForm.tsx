"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { Badge, InlineAlert } from "@/components/ui/primitives";
import { QUOTE_CHANNELS, humanize, toneFor } from "@/lib/domain";
import { money, percent, toInputDate } from "@/lib/format";
import { createRfqAction } from "./actions";

export type VendorOption = {
  id: string;
  code: string;
  name: string;
  status: string;
  city: string | null;
  businessType: string;
  taxStatus: string;
  categories: string | null;
  isTrader: boolean;
  minimumOrderValue: number | null;
  performanceScore: number | null;
  onTimePercent: number | null;
  scorePercent: number | null;
  statusReason: string | null;
  creditDays: number | null;
  paymentTerms: string | null;
};

const SOURCEABLE = ["APPROVED", "CONDITIONAL"];

/**
 * RFQ creation. Vendor eligibility is shown inline — blocked vendors cannot be
 * selected, and the server refuses them again regardless of what the form sends.
 */
export function RfqForm({
  pr,
  vendors,
  minQuotes,
  defaultDeadlineDays,
}: {
  pr: {
    id: string;
    number: string;
    title: string;
    estimatedValue: number;
    requiredDate: string;
    entityCode: string;
    categoryNames: string[];
    itemSummary: string;
  };
  vendors: VendorOption[];
  minQuotes: number;
  defaultDeadlineDays: number;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [channels, setChannels] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [showBlocked, setShowBlocked] = useState(false);
  const [issueNow, setIssueNow] = useState(true);

  const eligible = useMemo(() => vendors.filter((v) => SOURCEABLE.includes(v.status)), [vendors]);
  const blocked = useMemo(() => vendors.filter((v) => !SOURCEABLE.includes(v.status)), [vendors]);

  const matches = (v: VendorOption) => {
    const t = filter.trim().toLowerCase();
    if (!t) return true;
    return (
      v.name.toLowerCase().includes(t) ||
      v.code.toLowerCase().includes(t) ||
      (v.city ?? "").toLowerCase().includes(t) ||
      (v.categories ?? "").toLowerCase().includes(t) ||
      v.businessType.toLowerCase().includes(t)
    );
  };

  // Vendors whose stated categories overlap the requisition's categories first.
  const relevance = (v: VendorOption) => {
    const cats = (v.categories ?? "").toLowerCase();
    return pr.categoryNames.some((c) => cats.includes(c.toLowerCase().slice(0, 6))) ? 0 : 1;
  };

  const shown = eligible.filter(matches).sort((a, b) => relevance(a) - relevance(b) || a.name.localeCompare(b.name));

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <ActionForm
      action={createRfqAction}
      submitLabel={issueNow ? "Create & issue RFQ" : "Save RFQ draft"}
      hiddenFields={{ prId: pr.id, issueNow: issueNow ? "true" : "" }}
      onSuccessRedirect={(data) => {
        const d = data as { id?: string } | null;
        return d?.id ? `/rfq/${d.id}` : "/rfq";
      }}
      footerSticky
      secondary={
        <>
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={issueNow} onChange={(e) => setIssueNow(e.target.checked)} />
            Issue to vendors immediately
          </label>
          <Link href={`/pr/${pr.id}`} className="btn btn-secondary">
            Cancel
          </Link>
        </>
      }
    >
      <InlineAlert tone="info">
        Sourcing <span className="font-600">{pr.number}</span> — {pr.title} · estimated{" "}
        {money(pr.estimatedValue)} · required by {pr.requiredDate}. {pr.itemSummary}
      </InlineAlert>

      <FormSection title="RFQ details" columns={2}>
        <Field label="Title" name="title" required span>
          <TextInput name="title" defaultValue={`RFQ — ${pr.title}`} maxLength={180} />
        </Field>
        <Field
          label="Response deadline"
          name="responseDeadline"
          required
          hint="Vendors that have not responded by this date are flagged in the bottleneck board."
        >
          <TextInput
            type="date"
            name="responseDeadline"
            defaultValue={toInputDate(new Date(Date.now() + defaultDeadlineDays * 86400000))}
            min={toInputDate(new Date())}
          />
        </Field>
        <Field label="Delivery requirement" name="deliveryRequirement">
          <TextInput
            name="deliveryRequirement"
            placeholder="e.g. Delivery to the site store within 14 days of purchase order"
          />
        </Field>
        <Field label="Scope of supply" name="scope" span hint="What exactly you are asking vendors to price.">
          <TextArea name="scope" rows={3} defaultValue={`Supply and delivery per the attached specification. ${pr.itemSummary}`} />
        </Field>
        <Field
          label="Commercial terms"
          name="terms"
          span
          hint="Tax treatment, delivery inclusion, payment terms, warranty expectations and any mandatory certification."
        >
          <TextArea
            name="terms"
            rows={3}
            defaultValue="Rates to be quoted inclusive of all applicable taxes and delivery to the stated location. State payment terms, warranty and lead time explicitly. Quotations must be valid for at least 15 days."
          />
        </Field>
      </FormSection>

      <FormSection
        title={`Invite vendors — ${selected.length} selected`}
        description={`Procurement policy requires ${minQuotes} quotations above the waiver value. Vendors relevant to this requisition's categories are listed first.`}
        columns={1}
      >
        <div className="sm:col-span-full space-y-3">
          {selected.length > 0 && selected.length < minQuotes && (
            <InlineAlert tone="warning">
              {selected.length} of {minQuotes} vendors selected. Fewer than {minQuotes} quotations will raise an
              insufficient-quotations exception when the comparative is prepared, unless the case is below the waiver
              value.
            </InlineAlert>
          )}

          <input
            className="field"
            placeholder="Filter vendors by name, code, city, category or type…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter vendors"
          />

          <div className="overflow-hidden rounded-xl border border-border">
            <div className="table-wrap max-h-[24rem] overflow-y-auto">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: "2.5rem" }} />
                    <th style={{ minWidth: "14rem" }}>Vendor</th>
                    <th style={{ width: "7rem" }}>Status</th>
                    <th style={{ width: "8rem" }}>Type</th>
                    <th style={{ width: "8rem" }}>City</th>
                    <th className="text-right" style={{ width: "6.5rem" }}>Score</th>
                    <th className="text-right" style={{ width: "6.5rem" }}>On-time</th>
                    <th style={{ width: "10rem" }}>Terms</th>
                    <th style={{ width: "9rem" }}>Channel</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((v) => {
                    const on = selected.includes(v.id);
                    return (
                      <tr key={v.id} className={on ? "bg-[var(--c-accent-soft)]" : undefined}>
                        <td>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggle(v.id)}
                            aria-label={`Invite ${v.name}`}
                          />
                          {on && <input type="hidden" name="vendorIds" value={v.id} />}
                        </td>
                        <td>
                          <div className="font-500">{v.name}</div>
                          <div className="mono text-2xs text-[var(--c-text-tertiary)]">{v.code}</div>
                          {v.isTrader && (
                            <Badge tone="warning">
                              Trader{v.minimumOrderValue ? ` · MOQ value ${money(v.minimumOrderValue)}` : ""}
                            </Badge>
                          )}
                        </td>
                        <td>
                          <Badge tone={toneFor(v.status)}>{humanize(v.status)}</Badge>
                        </td>
                        <td className="text-2xs">{humanize(v.businessType)}</td>
                        <td className="text-2xs">{v.city ?? "—"}</td>
                        <td className="num text-2xs">
                          {v.performanceScore !== null
                            ? percent(v.performanceScore, 0)
                            : v.scorePercent !== null
                              ? `${percent(v.scorePercent, 0)} PQ`
                              : "—"}
                        </td>
                        <td className="num text-2xs">{v.onTimePercent !== null ? percent(v.onTimePercent, 0) : "—"}</td>
                        <td className="text-2xs">
                          {v.paymentTerms ?? "—"}
                          {v.taxStatus === "NON_FILER" && (
                            <span className="mt-0.5 block">
                              <Badge tone="warning">Non-filer</Badge>
                            </span>
                          )}
                        </td>
                        <td>
                          <select
                            className="field py-1 text-2xs"
                            value={channels[v.id] ?? "EMAIL"}
                            onChange={(e) => setChannels((c) => ({ ...c, [v.id]: e.target.value }))}
                            disabled={!on}
                            aria-label={`Invitation channel for ${v.name}`}
                          >
                            {QUOTE_CHANNELS.map((c) => (
                              <option key={c} value={c}>
                                {humanize(c)}
                              </option>
                            ))}
                          </select>
                          {on && <input type="hidden" name={`channel_${v.id}`} value={channels[v.id] ?? "EMAIL"} />}
                        </td>
                      </tr>
                    );
                  })}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={9} className="py-6 text-center text-xs text-muted">
                        No sourceable vendors match that filter. Vendors must be approved or conditionally approved
                        before they can be invited.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {blocked.length > 0 && (
            <div className="rounded-xl border border-border">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
                onClick={() => setShowBlocked((s) => !s)}
                aria-expanded={showBlocked}
              >
                <span className="text-xs font-500">
                  {blocked.length} vendor(s) are not eligible for sourcing
                </span>
                <span className="text-2xs text-[var(--c-text-tertiary)]">{showBlocked ? "Hide" : "Show"}</span>
              </button>
              {showBlocked && (
                <ul className="row-list border-t border-separator">
                  {blocked.map((v) => (
                    <li key={v.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <span className="text-xs font-500">{v.name}</span>
                      <Badge tone={toneFor(v.status)}>{humanize(v.status)}</Badge>
                      {v.statusReason && (
                        <span className="text-2xs text-muted">{v.statusReason}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <Field
            label="Override reason (only if inviting a blocked vendor)"
            name="overrideReason"
            hint="An override requires the vendor-blacklist permission and is recorded permanently in the audit trail."
          >
            <TextInput name="overrideReason" placeholder="Leave empty unless an authorised override is being exercised" />
          </Field>
        </div>
      </FormSection>
    </ActionForm>
  );
}
