import Link from "next/link";
import type { ProcurementCase } from "@/server/timeline";
import {
  Badge,
  Card,
  DefList,
  EmptyState,
  KeyValueRow,
  Meter,
  Mono,
  RefLink,
  SectionCard,
  StatusBadge,
  StatTile,
  UserChip,
  InlineAlert,
} from "@/components/ui/primitives";
import { ApprovalTrailView, Timeline, type TimelineEvent } from "@/components/ui/workflow";
import { COMPLIANCE_LEVELS, PRIORITY_TONE, PROCUREMENT_TYPE_LABELS, humanize, type ProcurementType } from "@/lib/domain";
import { amount, fmtDate, fmtDateTime, money, percent, qty, round2, variancePercent } from "@/lib/format";
import type { ApprovalTrail } from "@/lib/approvals";
import type { LineCoverage } from "@/server/allocations";

/* ── Overview ─────────────────────────────────────────────── */

export function OverviewPanel({
  pr,
  cpcInfo,
}: {
  pr: ProcurementCase;
  cpcInfo: { required: boolean; threshold: number; reason: string };
}) {
  const totalOrdered = pr.purchaseOrders.reduce((a, po) => a + po.items.reduce((s, i) => s + i.quantity, 0), 0);
  const totalAccepted = pr.purchaseOrders.reduce((a, po) => a + po.items.reduce((s, i) => s + i.acceptedQty, 0), 0);
  const poValue = pr.purchaseOrders
    .filter((po) => !["CANCELLED", "DRAFT"].includes(po.status))
    .reduce((a, po) => a + po.total, 0);
  const invoiced = pr.purchaseOrders.flatMap((po) => po.invoices).reduce((a, i) => a + i.total, 0);
  const paid = pr.purchaseOrders
    .flatMap((po) => po.invoices)
    .filter((i) => i.status === "PAID")
    .reduce((a, i) => a + i.total, 0);
  const comparative = pr.comparatives[0];
  const openExceptions = pr.exceptions.filter((e) => ["OPEN", "IN_PROGRESS"].includes(e.status));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Estimated value" value={money(pr.estimatedValue)} hint={pr.budgetAmount ? `Budget ${money(pr.budgetAmount)}` : "No budget stated"} />
        <StatTile
          label="Ordered value"
          value={poValue > 0 ? money(poValue) : "—"}
          hint={pr.purchaseOrders.length ? `${pr.purchaseOrders.length} purchase order(s)` : "No purchase order yet"}
          tone={poValue > 0 ? "accent" : "default"}
        />
        <StatTile
          label="Savings realised"
          value={comparative && comparative.savingsAmount > 0 ? money(comparative.savingsAmount) : "—"}
          hint={comparative && comparative.savingsAmount > 0 ? `${percent(comparative.savingsPercent)} against baseline` : "Recorded once a vendor is awarded"}
          tone={comparative && comparative.savingsAmount > 0 ? "success" : "default"}
        />
        <StatTile
          label="Paid to date"
          value={paid > 0 ? money(paid) : "—"}
          hint={invoiced > 0 ? `${money(invoiced)} invoiced` : "No invoice registered"}
          tone={openExceptions.length ? "warning" : "default"}
        />
      </div>

      {openExceptions.length > 0 && (
        <InlineAlert tone={openExceptions.some((e) => e.blocking) ? "danger" : "warning"}>
          <span className="font-600">
            {openExceptions.length} open exception{openExceptions.length > 1 ? "s" : ""} on this case
            {openExceptions.some((e) => e.blocking) ? " — one or more are blocking" : ""}:{" "}
          </span>
          {openExceptions.map((e) => e.title).join(" · ")}
        </InlineAlert>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <SectionCard title="Requisition detail">
          <DefList
            columns={2}
            items={[
              { label: "Entity", value: `${pr.entity.code} — ${pr.entity.name}` },
              { label: "Department", value: pr.department.name },
              { label: "Requester", value: <UserChip name={pr.requester.name} sub={pr.requester.title} /> },
              {
                label: "Procurement type",
                value: PROCUREMENT_TYPE_LABELS[pr.procurementType as ProcurementType] ?? humanize(pr.procurementType),
              },
              { label: "Priority", value: <Badge tone={PRIORITY_TONE[pr.priority] ?? "neutral"}>{humanize(pr.priority)}</Badge> },
              { label: "Required by", value: fmtDate(pr.requiredDate) },
              { label: "Cost centre", value: pr.costCenter ?? "—" },
              { label: "Budget code", value: pr.budgetCode ?? "—" },
              { label: "Project", value: pr.project ? `${pr.project.code} — ${pr.project.name}` : "—" },
              { label: "Site", value: pr.site?.name ?? "—" },
              {
                label: "Receiving location",
                value: pr.deliveryStore
                  ? `${pr.deliveryStore.name} · ${humanize(pr.deliveryStore.kind)}`
                  : (pr.deliveryLocationNote ?? "—"),
              },
              { label: "Delivery notes", value: pr.deliveryLocationNote ?? "—" },
              { label: "Business justification", value: pr.justification ?? "—", span: true },
            ]}
          />
          {pr.procurementType === "MATERIAL_DEMAND" && (
            <div className="mt-4 rounded-xl border border-border bg-surface-secondary px-3.5 py-3">
              <h4 className="label mb-2">Material Demand technical pack</h4>
              <DefList
                columns={2}
                items={[
                  { label: "BOQ reference", value: pr.boqReference ? <Mono>{pr.boqReference}</Mono> : "—" },
                  { label: "Drawing reference", value: pr.drawingReference ? <Mono>{pr.drawingReference}</Mono> : "—" },
                  { label: "Technical notes", value: pr.technicalNotes ?? "—", span: true },
                ]}
              />
            </div>
          )}
        </SectionCard>

        <div className="space-y-4">
          <SectionCard title="Governance">
            <KeyValueRow label="CPC threshold">{money(cpcInfo.threshold)}</KeyValueRow>
            <KeyValueRow label="Committee review">
              <Badge tone={cpcInfo.required ? "warning" : "neutral"}>{cpcInfo.required ? "Required" : "Not required"}</Badge>
            </KeyValueRow>
            <KeyValueRow label="CPC case">
              {pr.cpcCases[0] ? (
                <Link href={`/cpc/cases/${pr.cpcCases[0].id}`} className="text-[var(--c-accent-text)]">
                  {pr.cpcCases[0].number}
                </Link>
              ) : (
                "—"
              )}
            </KeyValueRow>
            <p className="mt-2 border-t border-separator pt-2 text-2xs leading-4 text-[var(--c-text-tertiary)]">
              {cpcInfo.reason}
            </p>
          </SectionCard>

          <SectionCard title="Fulfilment">
            {totalOrdered > 0 ? (
              <>
                <Meter value={totalAccepted} max={totalOrdered} label="Accepted against ordered" tone="success" />
                <div className="mt-3 space-y-0">
                  <KeyValueRow label="Ordered quantity">{amount(round2(totalOrdered), 3)}</KeyValueRow>
                  <KeyValueRow label="Accepted quantity">{amount(round2(totalAccepted), 3)}</KeyValueRow>
                  <KeyValueRow label="Pending quantity">
                    <span className={totalOrdered - totalAccepted > 0 ? "text-[var(--c-warning)]" : undefined}>
                      {amount(round2(Math.max(0, totalOrdered - totalAccepted)), 3)}
                    </span>
                  </KeyValueRow>
                  <KeyValueRow label="GRNs posted">
                    {pr.purchaseOrders.flatMap((po) => po.grns).filter((g) => g.status === "POSTED").length}
                  </KeyValueRow>
                </div>
              </>
            ) : (
              <p className="py-2 text-xs text-muted">
                Nothing ordered yet — fulfilment tracking starts when a purchase order is issued.
              </p>
            )}
          </SectionCard>

          <SectionCard title="Key dates">
            <KeyValueRow label="Created">{fmtDateTime(pr.createdAt)}</KeyValueRow>
            <KeyValueRow label="Submitted">{pr.submittedAt ? fmtDateTime(pr.submittedAt) : "—"}</KeyValueRow>
            <KeyValueRow label="Approved">{pr.approvedAt ? fmtDateTime(pr.approvedAt) : "—"}</KeyValueRow>
            <KeyValueRow label="Closed">{pr.closedAt ? fmtDateTime(pr.closedAt) : "—"}</KeyValueRow>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

/* ── Items ────────────────────────────────────────────────── */

export function ItemsPanel({
  pr,
  coverage,
}: {
  pr: ProcurementCase;
  /** What each line has already been ordered against, across every order. */
  coverage?: LineCoverage[];
}) {
  const poItems = pr.purchaseOrders.flatMap((po) => po.items.map((i) => ({ ...i, poNumber: po.number, poId: po.id })));
  const byLine = new Map((coverage ?? []).map((c) => [c.prItemId, c]));
  const outstanding = (coverage ?? []).filter((c) => c.outstanding > 0);

  return (
    <div className="space-y-4">
      <SectionCard
        title="Requisition lines"
        description={`${pr.items.length} line(s) · estimated ${money(pr.estimatedValue)}`}
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "2.5rem" }}>#</th>
                <th style={{ minWidth: "18rem" }}>Item</th>
                <th style={{ width: "11rem" }}>Category</th>
                <th className="text-right" style={{ width: "7rem" }}>Quantity</th>
                <th className="text-right" style={{ width: "9rem" }}>Est. unit price</th>
                <th className="text-right" style={{ width: "10rem" }}>Est. total</th>
                {coverage && <th style={{ width: "13rem" }}>Ordered</th>}
                <th style={{ width: "9rem" }}>Disposition</th>
              </tr>
            </thead>
            <tbody>
              {pr.items.map((it) => (
                <tr key={it.id}>
                  <td className="tnum align-top text-[var(--c-text-tertiary)]">{it.lineNo}</td>
                  <td className="align-top">
                    <div className="font-500">{it.description}</div>
                    {(it.brand || it.model || it.make) && (
                      <div className="mt-0.5 text-2xs text-muted">
                        {[it.brand, it.model, it.make].filter(Boolean).join(" · ")}
                      </div>
                    )}
                    {it.item && <div className="mono mt-0.5 text-[var(--c-text-tertiary)]">{it.item.sku}</div>}
                    {it.specification && (
                      <p className="mt-1 max-w-2xl rounded-sm border-l-2 border-[var(--c-border-strong)] bg-surface-secondary px-2 py-1 text-2xs leading-4 text-muted">
                        {it.specification}
                      </p>
                    )}
                    {it.notes && <p className="mt-1 text-2xs text-[var(--c-text-tertiary)]">Note: {it.notes}</p>}
                  </td>
                  <td className="align-top">
                    <span className="text-xs">{it.category.name}</span>
                    {it.category.requiresInspection && (
                      <span className="mt-1 block">
                        <Badge tone="warning">Inspection required</Badge>
                      </span>
                    )}
                  </td>
                  <td className="num align-top">{qty(it.quantity, it.unit)}</td>
                  <td className="num align-top">{it.estimatedUnitPrice ? money(it.estimatedUnitPrice) : "—"}</td>
                  <td className="num align-top font-500">{money(it.estimatedTotal)}</td>
                  {coverage && (
                    <td className="align-top">
                      {(() => {
                        const c = byLine.get(it.id);
                        if (!c || c.ordered <= 0) {
                          return <span className="text-2xs text-[var(--c-text-tertiary)]">Not ordered</span>;
                        }
                        return (
                          <div className="space-y-1">
                            <div className="tnum text-xs">
                              {c.ordered} of {c.required} {c.unit}
                              {c.outstanding > 0 && (
                                <span className="ml-1 text-warning-soft-foreground">({c.outstanding} left)</span>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {c.orders.map((o) => (
                                <Link
                                  key={o.poId}
                                  href={`/po/${o.poId}`}
                                  className="ref-chip mono text-2xs text-[var(--c-accent-text)]"
                                  title={`${o.quantity} ${c.unit}${o.vendorName ? ` — ${o.vendorName}` : ""}`}
                                >
                                  {o.poNumber}
                                </Link>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                    </td>
                  )}
                  <td className="align-top">
                    <Badge tone="neutral">{humanize(it.disposition)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} className="text-right">Estimated value</td>
                <td className="num">{money(pr.estimatedValue)}</td>
                {coverage && <td />}
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </SectionCard>

      {outstanding.length > 0 && (
        <InlineAlert tone="warning">
          {outstanding.length} line{outstanding.length === 1 ? "" : "s"} not fully ordered:{" "}
          {outstanding.map((c) => `line ${c.lineNo} (${c.outstanding} ${c.unit})`).join(", ")}. A further order can be
          raised against the balance.
        </InlineAlert>
      )}

      {poItems.length > 0 && (
        <SectionCard
          title="Ordered vs received"
          description="Actual quantities as ordered, physically received, accepted into inventory and invoiced."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: "9rem" }}>Purchase order</th>
                  <th style={{ minWidth: "16rem" }}>Line</th>
                  <th className="text-right">Ordered</th>
                  <th className="text-right">Received</th>
                  <th className="text-right">Accepted</th>
                  <th className="text-right">Rejected</th>
                  <th className="text-right">Pending</th>
                  <th className="text-right">Invoiced</th>
                  <th style={{ width: "8rem" }}>Progress</th>
                </tr>
              </thead>
              <tbody>
                {poItems.map((i) => {
                  const pending = round2(Math.max(0, i.quantity - i.acceptedQty));
                  return (
                    <tr key={i.id}>
                      <td>
                        <RefLink href={`/po/${i.poId}`}>{i.poNumber}</RefLink>
                      </td>
                      <td>
                        <span className="block max-w-[22rem] truncate" title={i.description}>
                          {i.description}
                        </span>
                        {i.requiresInspection && <Badge tone="warning">Inspection</Badge>}
                      </td>
                      <td className="num">{qty(i.quantity, i.unit)}</td>
                      <td className="num">{qty(i.receivedQty)}</td>
                      <td className="num font-500">{qty(i.acceptedQty)}</td>
                      <td className="num">
                        <span className={i.rejectedQty > 0 ? "text-[var(--c-danger)]" : undefined}>{qty(i.rejectedQty)}</span>
                      </td>
                      <td className="num">
                        <span className={pending > 0 ? "font-500 text-[var(--c-warning)]" : undefined}>{qty(pending)}</span>
                      </td>
                      <td className="num">{qty(i.invoicedQty)}</td>
                      <td>
                        <Meter value={i.acceptedQty} max={i.quantity} tone={pending > 0 ? "warning" : "success"} showValue />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </div>
  );
}

/* ── Approvals ────────────────────────────────────────────── */

export function ApprovalsPanel({ trails }: { trails: ApprovalTrail[] }) {
  return (
    <SectionCard
      title="Approval history"
      description="Every step of the configured approval chain, who it was assigned to, what they decided and when."
    >
      <ApprovalTrailView trails={trails} />
    </SectionCard>
  );
}

/* ── RFQs ─────────────────────────────────────────────────── */

export function RfqPanel({ pr }: { pr: ProcurementCase }) {
  if (!pr.rfqs.length) {
    return (
      <Card>
        <EmptyState
          title="No RFQ raised"
          description="Once the requisition is approved and in sourcing, procurement raises an RFQ and invites vendors to quote."
        />
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {pr.rfqs.map((rfq) => (
        <SectionCard
          key={rfq.id}
          title={
            <span className="flex items-center gap-2">
              <RefLink href={`/rfq/${rfq.id}`}>{rfq.number}</RefLink>
              <StatusBadge status={rfq.status} />
            </span>
          }
          description={rfq.title}
          actions={
            <span className="text-2xs text-[var(--c-text-tertiary)]">
              Deadline {fmtDate(rfq.responseDeadline)} · raised by {rfq.createdBy.name}
            </span>
          }
          bodyClassName="px-0 py-0"
        >
          {rfq.scope && (
            <p className="border-b border-separator px-4 py-2.5 text-xs leading-5 text-muted">
              {rfq.scope}
            </p>
          )}
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th style={{ width: "8rem" }}>Status</th>
                  <th style={{ width: "8rem" }}>Channel</th>
                  <th style={{ width: "10rem" }}>Invited</th>
                  <th style={{ width: "10rem" }}>Responded</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {rfq.vendors.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <Link href={`/vendors/${v.vendor.id}`} className="font-500 hover:text-[var(--c-accent-text)]">
                        {v.vendor.name}
                      </Link>
                      <span className="ml-2">
                        <StatusBadge status={v.vendor.status} />
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={v.status} />
                    </td>
                    <td className="text-xs">{humanize(v.channel)}</td>
                    <td className="text-xs">{fmtDate(v.invitedAt)}</td>
                    <td className="text-xs">{v.respondedAt ? fmtDate(v.respondedAt) : "—"}</td>
                    <td className="text-xs text-muted">{v.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ))}
    </div>
  );
}

/* ── Quotes ───────────────────────────────────────────────── */

export function QuotesPanel({ pr }: { pr: ProcurementCase }) {
  const quotes = pr.rfqs.flatMap((r) => r.quotes.map((q) => ({ ...q, rfqNumber: r.number, rfqId: r.id })));
  if (!quotes.length) {
    return (
      <Card>
        <EmptyState title="No quotations recorded" description="Vendor quotations appear here as procurement enters them against the RFQ." />
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {quotes.map((q) => {
        const neg = q.negotiations.at(-1);
        const net = neg ? (neg.finalTotal ?? neg.negotiatedTotal) : q.total;
        return (
          <SectionCard
            key={q.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                <Mono>{q.number}</Mono>
                <Link href={`/vendors/${q.vendor.id}`} className="hover:text-[var(--c-accent-text)]">
                  {q.vendor.name}
                </Link>
                <StatusBadge status={q.status} />
                <Badge
                  tone={
                    q.technicalCompliance === "COMPLIANT"
                      ? "success"
                      : q.technicalCompliance === "PARTIAL"
                        ? "warning"
                        : q.technicalCompliance === "NON_COMPLIANT"
                          ? "danger"
                          : "neutral"
                  }
                >
                  {humanize(q.technicalCompliance)}
                </Badge>
              </span>
            }
            description={`${q.rfqNumber} · vendor ref ${q.quoteRef ?? "—"} · received via ${humanize(q.channel)} on ${fmtDate(q.quoteDate)}`}
            actions={
              <span className="text-right">
                <span className="tnum block text-[0.9375rem] font-600">{money(net)}</span>
                {neg && (
                  <span className="block text-2xs text-[var(--c-success)]">
                    negotiated from {money(q.total)}
                  </span>
                )}
              </span>
            }
            bodyClassName="px-0 py-0"
          >
            <div className="grid gap-x-6 gap-y-2 border-b border-separator px-4 py-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                ["Subtotal", money(q.subtotal)],
                ["Tax", money(q.taxAmount)],
                ["Delivery", money(q.deliveryCharges)],
                ["Total", money(q.total)],
                ["Lead time", q.deliveryDays ? `${q.deliveryDays} days` : "—"],
                ["Warranty", q.warrantyMonths ? `${q.warrantyMonths} months` : "—"],
                ["Payment terms", q.paymentTerms ?? "—"],
                ["Credit days", q.creditDays !== null ? String(q.creditDays) : "—"],
                ["Tax registered", q.taxRegistered ? "Yes" : "No"],
                ["Valid until", q.validUntil ? fmtDate(q.validUntil) : "—"],
              ].map(([label, value]) => (
                <div key={label}>
                  <div className="label">{label}</div>
                  <div className="tnum text-[0.8125rem]">{value}</div>
                </div>
              ))}
            </div>

            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: "2.5rem" }}>#</th>
                    <th style={{ minWidth: "16rem" }}>Description</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">Unit price</th>
                    <th className="text-right">Tax</th>
                    <th className="text-right">Line total</th>
                    <th style={{ width: "8rem" }}>Compliance</th>
                  </tr>
                </thead>
                <tbody>
                  {q.items.map((li) => (
                    <tr key={li.id}>
                      <td className="tnum text-[var(--c-text-tertiary)]">{li.lineNo}</td>
                      <td>
                        <div>{li.description}</div>
                        {li.specification && (
                          <div className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">{li.specification}</div>
                        )}
                        {li.notes && <div className="mt-0.5 text-2xs text-[var(--c-warning)]">{li.notes}</div>}
                      </td>
                      <td className="num">{qty(li.quantity, li.unit)}</td>
                      <td className="num">{money(li.unitPrice)}</td>
                      <td className="num">{money(li.taxAmount)}</td>
                      <td className="num font-500">{money(li.lineTotal)}</td>
                      <td>
                        <Badge
                          tone={
                            li.compliance === "COMPLIANT"
                              ? "success"
                              : li.compliance === "PARTIAL"
                                ? "warning"
                                : li.compliance === "NON_COMPLIANT"
                                  ? "danger"
                                  : "neutral"
                          }
                        >
                          {humanize(li.compliance)}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {(q.complianceNotes || q.exceptions || q.notes) && (
              <div className="space-y-1.5 border-t border-separator px-4 py-3">
                {q.complianceNotes && (
                  <p className="text-xs leading-5">
                    <span className="label mr-2">Compliance</span>
                    {q.complianceNotes}
                  </p>
                )}
                {q.exceptions && (
                  <p className="text-xs leading-5 text-[var(--c-warning)]">
                    <span className="label mr-2">Exceptions</span>
                    {q.exceptions}
                  </p>
                )}
                {q.notes && (
                  <p className="text-xs leading-5 text-muted">
                    <span className="label mr-2">Notes</span>
                    {q.notes}
                  </p>
                )}
              </div>
            )}
          </SectionCard>
        );
      })}
    </div>
  );
}

/* ── Comparison ───────────────────────────────────────────── */

export function ComparisonPanel({ pr }: { pr: ProcurementCase }) {
  if (!pr.comparatives.length) {
    return (
      <Card>
        <EmptyState
          title="No comparative prepared"
          description="Once quotations are in, procurement builds a side-by-side cost comparative with previous and market price baselines."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {pr.comparatives.map((c) => {
        const selected = c.lines.find((l) => l.isSelected);
        const lowest = c.lines.find((l) => l.isLowest);
        const criteria = (() => {
          try {
            return JSON.parse(c.evaluationCriteria) as Array<{ key: string; label: string; weight: number }>;
          } catch {
            return [];
          }
        })();
        return (
          <SectionCard
            key={c.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                <RefLink href={`/comparatives/${c.id}`}>{c.number}</RefLink>
                <StatusBadge status={c.status} />
              </span>
            }
            description={`Prepared ${fmtDateTime(c.preparedAt)} · ${c.lines.length} vendor(s) compared`}
            actions={
              c.savingsAmount > 0 && (
                <span className="text-right">
                  <span className="tnum block text-[0.9375rem] font-600 text-[var(--c-success)]">
                    {money(c.savingsAmount)}
                  </span>
                  <span className="block text-2xs text-[var(--c-text-tertiary)]">saving · {percent(c.savingsPercent)}</span>
                </span>
              )
            }
            bodyClassName="px-0 py-0"
          >
            <div className="grid gap-x-6 gap-y-2 border-b border-separator px-4 py-3 sm:grid-cols-4">
              <div>
                <div className="label">Previous purchase price</div>
                <div className="tnum text-[0.8125rem]">{c.previousPrice ? money(c.previousPrice) : "No history"}</div>
              </div>
              <div>
                <div className="label">Market price</div>
                <div className="tnum text-[0.8125rem]">{c.marketPrice ? money(c.marketPrice) : "Not captured"}</div>
              </div>
              <div>
                <div className="label">Lowest quotation</div>
                <div className="tnum text-[0.8125rem]">{c.lowestTotal ? money(c.lowestTotal) : "—"}</div>
              </div>
              <div>
                <div className="label">Selected</div>
                <div className="tnum text-[0.8125rem] font-600">{c.selectedTotal ? money(c.selectedTotal) : "Not yet awarded"}</div>
              </div>
            </div>

            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ minWidth: "13rem" }}>Vendor</th>
                    <th className="text-right">Avg unit price</th>
                    <th className="text-right">Subtotal</th>
                    <th className="text-right">Tax</th>
                    <th className="text-right">Delivery</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">Negotiated</th>
                    <th className="text-right">Net total</th>
                    <th className="text-right">Variance</th>
                    <th className="text-right">Lead time</th>
                    <th>Payment terms</th>
                    <th className="text-right">Warranty</th>
                    <th>Compliance</th>
                    <th className="text-right">Vendor score</th>
                    <th className="text-right">On-time</th>
                    <th className="text-right">Weighted score</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {c.lines.map((l) => (
                    <tr
                      key={l.id}
                      style={
                        l.isSelected
                          ? { background: "var(--c-accent-soft)", boxShadow: "inset 2px 0 0 0 var(--c-accent)" }
                          : undefined
                      }
                    >
                      <td>
                        <Link href={`/vendors/${l.vendor.id}`} className="font-500 hover:text-[var(--c-accent-text)]">
                          {l.vendor.name}
                        </Link>
                        <div className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">
                          {humanize(l.vendor.businessType)}
                          {l.vendor.taxStatus === "NON_FILER" ? " · non-filer" : ""}
                        </div>
                      </td>
                      <td className="num">{money(l.unitPriceAvg)}</td>
                      <td className="num">{money(l.subtotal)}</td>
                      <td className="num">{money(l.taxAmount)}</td>
                      <td className="num">{money(l.deliveryCharges)}</td>
                      <td className="num">{money(l.total)}</td>
                      <td className="num">
                        {l.negotiatedTotal ? (
                          <span className="text-[var(--c-success)]">{money(l.negotiatedTotal)}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="num font-600">{money(l.netTotal)}</td>
                      <td className="num">
                        {l.variancePercent !== null ? (
                          <span
                            className={
                              l.variancePercent > 0 ? "text-[var(--c-danger)]" : "text-[var(--c-success)]"
                            }
                          >
                            {l.variancePercent > 0 ? "+" : ""}
                            {percent(l.variancePercent)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="num">{l.deliveryDays ? `${l.deliveryDays}d` : "—"}</td>
                      <td className="text-xs">{l.paymentTerms ?? "—"}</td>
                      <td className="num">{l.warrantyMonths ? `${l.warrantyMonths}m` : "—"}</td>
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
                      <td className="num">{l.vendorScore !== null ? percent(l.vendorScore, 0) : "—"}</td>
                      <td className="num">{l.vendorOnTimePercent !== null ? percent(l.vendorOnTimePercent, 0) : "—"}</td>
                      <td className="num font-500">{l.scoreTotal !== null ? l.scoreTotal.toFixed(1) : "—"}</td>
                      <td>
                        <span className="flex flex-wrap gap-1">
                          {l.isSelected && <Badge tone="accent">Awarded</Badge>}
                          {l.isLowest && <Badge tone="info">Lowest</Badge>}
                          {l.isLowestCompliant && <Badge tone="success">Lowest compliant</Badge>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-2.5 border-t border-separator px-4 py-3">
              {criteria.length > 0 && (
                <p className="text-2xs text-[var(--c-text-tertiary)]">
                  <span className="label mr-2">Evaluation weighting</span>
                  {criteria.map((cr) => `${cr.label} ${cr.weight}%`).join(" · ")}
                </p>
              )}
              {c.recommendationBasis && (
                <p className="text-xs leading-5">
                  <span className="label mr-2">Recommendation basis</span>
                  {c.recommendationBasis}
                </p>
              )}
              {c.nonLowestJustification && (
                <div className="rounded-2xl alert-warning px-3 py-2">
                  <p className="text-2xs font-600 text-[var(--c-warning)]">
                    Awarded above the lowest compliant quotation — justification recorded
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[var(--c-warning)]">{c.nonLowestJustification}</p>
                  {selected && lowest && (
                    <p className="mt-1 text-2xs text-[var(--c-warning)]">
                      Selected {money(selected.netTotal)} vs lowest {money(lowest.netTotal)} — difference{" "}
                      {money(round2(selected.netTotal - lowest.netTotal))}
                      {variancePercent(selected.netTotal, lowest.netTotal) !== null
                        ? ` (${percent(variancePercent(selected.netTotal, lowest.netTotal))})`
                        : ""}
                    </p>
                  )}
                </div>
              )}
              {c.notes && <p className="text-xs leading-5 text-muted">{c.notes}</p>}
            </div>
          </SectionCard>
        );
      })}
    </div>
  );
}

/* ── Negotiation ──────────────────────────────────────────── */

export function NegotiationPanel({ pr }: { pr: ProcurementCase }) {
  const rows = pr.rfqs.flatMap((r) =>
    r.quotes.flatMap((q) =>
      q.negotiations.map((n) => ({ ...n, vendorName: q.vendor.name, vendorId: q.vendor.id, quoteNumber: q.number })),
    ),
  );
  if (!rows.length) {
    return (
      <Card>
        <EmptyState
          title="No negotiation recorded"
          description="Each negotiation round — the original quote, what was conceded, through which channel and by whom — is recorded here."
        />
      </Card>
    );
  }
  const totalSavings = rows.reduce((a, r) => a + r.savings, 0);
  return (
    <SectionCard
      title="Negotiation history"
      description={`${rows.length} round(s) recorded across ${new Set(rows.map((r) => r.vendorId)).size} vendor(s)`}
      actions={
        <span className="text-right">
          <span className="tnum block text-[0.9375rem] font-600 text-[var(--c-success)]">{money(round2(totalSavings))}</span>
          <span className="block text-2xs text-[var(--c-text-tertiary)]">conceded in total</span>
        </span>
      }
      bodyClassName="px-0 py-0"
    >
      <div className="table-wrap">
        <table className="dt">
          <thead>
            <tr>
              <th>Vendor</th>
              <th style={{ width: "9rem" }}>Quotation</th>
              <th className="text-right" style={{ width: "5rem" }}>Round</th>
              <th className="text-right">Opening</th>
              <th className="text-right">Negotiated</th>
              <th className="text-right">Final</th>
              <th className="text-right">Conceded</th>
              <th className="text-right">%</th>
              <th style={{ width: "7rem" }}>Channel</th>
              <th style={{ width: "8rem" }}>Outcome</th>
              <th>Negotiated by</th>
              <th style={{ minWidth: "18rem" }}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.id}>
                <td>
                  <Link href={`/vendors/${n.vendorId}`} className="font-500 hover:text-[var(--c-accent-text)]">
                    {n.vendorName}
                  </Link>
                </td>
                <td>
                  <Mono>{n.quoteNumber}</Mono>
                </td>
                <td className="num">{n.round}</td>
                <td className="num">{money(n.originalTotal)}</td>
                <td className="num font-500">{money(n.negotiatedTotal)}</td>
                <td className="num">{n.finalTotal ? money(n.finalTotal) : "—"}</td>
                <td className="num font-500 text-[var(--c-success)]">{money(n.savings)}</td>
                <td className="num">{percent(n.savingsPercent)}</td>
                <td className="text-xs">{humanize(n.channel)}</td>
                <td>
                  <StatusBadge status={n.outcome} />
                </td>
                <td className="text-xs">{n.negotiatedBy.name}</td>
                <td className="text-xs leading-5 text-muted">{n.notes ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

/* ── Timeline ─────────────────────────────────────────────── */

export function TimelinePanel({ events }: { events: TimelineEvent[] }) {
  return (
    <SectionCard
      title="Case timeline"
      description={`${events.length} event(s), generated from the system's own audit records`}
    >
      <Timeline events={events} emptyLabel="No events recorded for this case yet." />
    </SectionCard>
  );
}
