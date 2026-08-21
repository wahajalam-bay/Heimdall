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
  UserChip,
  InlineAlert,
  BlockedNotice,
} from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { amount, fmtDate, fmtDateTime, money, percent, qty, round2 } from "@/lib/format";
import type { MatchResult } from "@/server/invoice";

/* ── CPC ──────────────────────────────────────────────────── */

export function CpcPanel({ pr }: { pr: ProcurementCase }) {
  if (!pr.cpcCases.length) {
    return (
      <Card>
        <EmptyState
          title="No committee case"
          description="A Central Procurement Committee case is raised automatically when the case value reaches the configured threshold for this entity."
        />
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {pr.cpcCases.map((k) => (
        <SectionCard
          key={k.id}
          title={
            <span className="flex flex-wrap items-center gap-2">
              <RefLink href={`/cpc/cases/${k.id}`}>{k.number}</RefLink>
              <StatusBadge status={k.status} />
            </span>
          }
          description={
            k.meeting
              ? `Scheduled for ${k.meeting.title} on ${fmtDateTime(k.meeting.scheduledAt)}`
              : "Not yet scheduled to a meeting"
          }
          actions={
            <span className="text-right">
              <span className="tnum block text-[0.9375rem] font-600">{money(k.amount)}</span>
              {k.savingsAmount > 0 && (
                <span className="block text-2xs text-[var(--c-success)]">{money(k.savingsAmount)} saving</span>
              )}
            </span>
          }
          bodyClassName="px-0 py-0"
        >
          {k.recommendation && (
            <div className="border-b border-[var(--c-border-subtle)] px-4 py-3">
              <div className="label mb-1">Recommendation to the committee</div>
              <p className="text-xs leading-5">{k.recommendation}</p>
              {k.riskNotes && (
                <>
                  <div className="label mt-2.5 mb-1">Risks noted</div>
                  <p className="text-xs leading-5 text-[var(--c-warning)]">{k.riskNotes}</p>
                </>
              )}
            </div>
          )}

          <div className="grid gap-0 sm:grid-cols-2">
            <div className="border-b border-[var(--c-border-subtle)] px-4 py-3 sm:border-r sm:border-b-0">
              <div className="label mb-2">Committee members</div>
              <ul className="space-y-2">
                {k.members.map((m) => {
                  const vote = k.decisions.find((d) => d.memberId === m.userId);
                  return (
                    <li key={m.id} className="flex items-start justify-between gap-3">
                      <span className="min-w-0">
                        <UserChip name={m.user.name} sub={m.roleLabel} />
                      </span>
                      <span className="shrink-0 text-right">
                        {vote ? (
                          <StatusBadge status={vote.vote === "APPROVE" ? "APPROVED" : vote.vote} />
                        ) : (
                          <Badge tone={m.required ? "progress" : "neutral"}>
                            {m.required ? "Awaiting vote" : "Optional"}
                          </Badge>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="px-4 py-3">
              <div className="label mb-2">Decisions</div>
              {k.decisions.length === 0 ? (
                <p className="text-xs text-[var(--c-text-secondary)]">No decisions recorded yet.</p>
              ) : (
                <ul className="space-y-2.5">
                  {k.decisions.map((d) => (
                    <li key={d.id} className="border-l-2 border-[var(--c-border-strong)] pl-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-500">{d.member.name}</span>
                        <StatusBadge status={d.vote === "APPROVE" ? "APPROVED" : d.vote} />
                        <span className="text-2xs text-[var(--c-text-tertiary)]">{fmtDateTime(d.decidedAt)}</span>
                      </div>
                      {d.comment && <p className="mt-0.5 text-xs leading-5 text-[var(--c-text-secondary)]">{d.comment}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </SectionCard>
      ))}
    </div>
  );
}

/* ── Purchase orders ──────────────────────────────────────── */

export function PoPanel({ pr }: { pr: ProcurementCase }) {
  if (!pr.purchaseOrders.length) {
    return (
      <Card>
        <EmptyState
          title="No purchase order"
          description="A purchase order is generated from the approved comparative once all required governance is complete."
        />
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {pr.purchaseOrders.map((po) => {
        const ordered = po.items.reduce((a, i) => a + i.quantity, 0);
        const accepted = po.items.reduce((a, i) => a + i.acceptedQty, 0);
        return (
          <SectionCard
            key={po.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                <RefLink href={`/po/${po.id}`}>{po.number}</RefLink>
                <StatusBadge status={po.status} />
              </span>
            }
            description={
              <span>
                <Link href={`/vendors/${po.vendor.id}`} className="hover:text-[var(--c-accent-text)]">
                  {po.vendor.name}
                </Link>
                {" · "}
                raised by {po.createdBy.name}
                {po.issuedAt ? ` · issued ${fmtDate(po.issuedAt)}` : ""}
              </span>
            }
            actions={
              <span className="text-right">
                <span className="tnum block text-[0.9375rem] font-600">{money(po.total)}</span>
                <span className="block text-2xs text-[var(--c-text-tertiary)]">
                  {po.paymentTerms ?? "terms not stated"}
                </span>
              </span>
            }
            bodyClassName="px-0 py-0"
          >
            <div className="border-b border-[var(--c-border-subtle)] px-4 py-3">
              <DefList
                columns={3}
                items={[
                  { label: "Delivery location", value: po.deliveryStore?.name ?? po.deliveryAddress ?? "—" },
                  { label: "Promised delivery", value: po.deliveryDate ? fmtDate(po.deliveryDate) : "—" },
                  { label: "Credit days", value: po.creditDays !== null ? String(po.creditDays) : "—" },
                  { label: "Warranty", value: po.warrantyTerms ?? "—" },
                  { label: "Incoterms", value: po.incoterms ?? "—" },
                  {
                    label: "Advance",
                    value: po.advanceRequired ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        {money(po.advanceAmount ?? 0)} ({po.advancePercent}%)
                        <StatusBadge status={po.advanceStatus ?? "PENDING"} />
                        {po.collateralType && <Badge tone="info">{humanize(po.collateralType)}</Badge>}
                      </span>
                    ) : (
                      "Not required"
                    ),
                  },
                ]}
              />
              {po.advanceRequired && po.collateralRef && (
                <p className="mt-2 text-2xs text-[var(--c-text-secondary)]">
                  <span className="label mr-2">Collateral</span>
                  {po.collateralRef}
                  {po.collateralNotes ? ` — ${po.collateralNotes}` : ""}
                </p>
              )}
            </div>

            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: "2.5rem" }}>#</th>
                    <th style={{ minWidth: "16rem" }}>Description</th>
                    <th className="text-right">Ordered</th>
                    <th className="text-right">Unit price</th>
                    <th className="text-right">Tax</th>
                    <th className="text-right">Line total</th>
                    <th className="text-right">Accepted</th>
                    <th className="text-right">Pending</th>
                    <th style={{ width: "9rem" }}>Disposition</th>
                  </tr>
                </thead>
                <tbody>
                  {po.items.map((i) => {
                    const pending = round2(Math.max(0, i.quantity - i.acceptedQty));
                    return (
                      <tr key={i.id}>
                        <td className="tnum text-[var(--c-text-tertiary)]">{i.lineNo}</td>
                        <td>
                          <div>{i.description}</div>
                          {i.specification && (
                            <div className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">{i.specification}</div>
                          )}
                          {i.requiresInspection && <Badge tone="warning">Inspection required</Badge>}
                        </td>
                        <td className="num">{qty(i.quantity, i.unit)}</td>
                        <td className="num">{money(i.unitPrice)}</td>
                        <td className="num">{money(i.taxAmount)}</td>
                        <td className="num font-500">{money(i.lineTotal)}</td>
                        <td className="num">{qty(i.acceptedQty)}</td>
                        <td className="num">
                          <span className={pending > 0 ? "font-500 text-[var(--c-warning)]" : undefined}>{qty(pending)}</span>
                        </td>
                        <td>
                          <Badge tone="neutral">{humanize(i.disposition)}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5} className="text-right">Total</td>
                    <td className="num">{money(po.total)}</td>
                    <td colSpan={3}>
                      <Meter value={accepted} max={ordered} label="Received" tone={accepted < ordered ? "warning" : "success"} />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {po.termsConditions && (
              <div className="border-t border-[var(--c-border-subtle)] px-4 py-3">
                <div className="label mb-1">Terms & conditions</div>
                <p className="whitespace-pre-line text-xs leading-5 text-[var(--c-text-secondary)]">{po.termsConditions}</p>
              </div>
            )}
            {po.closureReason && (
              <div className="border-t border-[var(--c-border-subtle)] px-4 py-2.5">
                <InlineAlert tone="warning">
                  <span className="font-600">Closure reason: </span>
                  {po.closureReason}
                </InlineAlert>
              </div>
            )}
          </SectionCard>
        );
      })}
    </div>
  );
}

/* ── Delivery ─────────────────────────────────────────────── */

export function DeliveryPanel({ pr }: { pr: ProcurementCase }) {
  const gatePasses = pr.purchaseOrders.flatMap((po) => po.gatePasses.map((g) => ({ ...g, poNumber: po.number })));
  const deliveries = pr.purchaseOrders.flatMap((po) =>
    po.deliveries.map((d) => ({ ...d, poNumber: po.number, poId: po.id })),
  );

  if (!gatePasses.length && !deliveries.length) {
    return (
      <Card>
        <EmptyState
          title="Nothing delivered yet"
          description="When the vendor arrives, security records an inward gate pass and the store performs physical verification."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {gatePasses.length > 0 && (
        <SectionCard title="Inward gate passes" description={`${gatePasses.length} vehicle arrival(s) recorded`} bodyClassName="px-0 py-0">
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Gate pass</th>
                  <th>Serial</th>
                  <th>PO</th>
                  <th>Store</th>
                  <th>Vehicle</th>
                  <th>Driver</th>
                  <th className="text-right">Packages</th>
                  <th>Arrived</th>
                  <th>Status</th>
                  <th>Recorded by</th>
                </tr>
              </thead>
              <tbody>
                {gatePasses.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <RefLink href={`/gate-passes/${g.id}`}>{g.number}</RefLink>
                    </td>
                    <td>
                      <Mono>{g.serial}</Mono>
                    </td>
                    <td className="text-xs">{g.poNumber}</td>
                    <td className="text-xs">{g.store.name}</td>
                    <td className="text-xs">{g.vehicleNumber ?? "—"}</td>
                    <td className="text-xs">{g.driverName ?? "—"}</td>
                    <td className="num">{g.declaredPackages ?? "—"}</td>
                    <td className="text-xs">{fmtDateTime(g.arrivedAt)}</td>
                    <td>
                      <StatusBadge status={g.status} />
                    </td>
                    <td className="text-xs">{g.recordedBy.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {deliveries.map((d) => (
        <SectionCard
          key={d.id}
          title={
            <span className="flex flex-wrap items-center gap-2">
              <RefLink href={`/receiving/${d.id}`}>{d.number}</RefLink>
              <StatusBadge status={d.status} />
            </span>
          }
          description={`${d.poNumber} · received at ${d.store.name} by ${d.receivedBy.name} on ${fmtDateTime(d.deliveryDate)}`}
          bodyClassName="px-0 py-0"
        >
          <div className="grid gap-x-6 gap-y-2 border-b border-[var(--c-border-subtle)] px-4 py-3 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ["Delivery note", d.deliveryNoteRef ?? "—"],
              ["Packages", d.totalPackages !== null ? `${d.packagesVerified ?? 0} of ${d.totalPackages} verified` : "—"],
              ["Packaging", d.packagingCondition ?? "—"],
              ["Physical condition", d.physicalCondition ?? "—"],
              ["Weight recorded", d.weightRecorded !== null ? `${amount(d.weightRecorded, 3)} ${d.weightUnit ?? ""}` : "—"],
              ["Documentation", d.documentationComplete ? "Complete" : "Incomplete"],
            ].map(([label, value]) => (
              <div key={label}>
                <div className="label">{label}</div>
                <div className="text-[0.8125rem]">{value}</div>
              </div>
            ))}
          </div>

          {(d.damageObserved || d.leakageObserved) && (
            <div className="border-b border-[var(--c-border-subtle)] px-4 py-2.5">
              <BlockedNotice
                title="Condition issues recorded at receipt"
                reasons={[
                  ...(d.damageObserved ? [`Damage observed${d.damageNotes ? `: ${d.damageNotes}` : ""}`] : []),
                  ...(d.leakageObserved ? ["Leakage observed"] : []),
                  ...(d.handlingNotes ? [`Handling: ${d.handlingNotes}`] : []),
                ]}
              />
            </div>
          )}

          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: "2.5rem" }}>#</th>
                  <th style={{ minWidth: "15rem" }}>Description</th>
                  <th className="text-right">Ordered</th>
                  <th className="text-right">Expected</th>
                  <th className="text-right">Delivered</th>
                  <th className="text-right">Accepted</th>
                  <th className="text-right">Rejected</th>
                  <th>Batch / serial</th>
                  <th>Discrepancy</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((i) => (
                  <tr key={i.id}>
                    <td className="tnum text-[var(--c-text-tertiary)]">{i.lineNo}</td>
                    <td>
                      <div>{i.description}</div>
                      {i.conditionNotes && (
                        <div className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">{i.conditionNotes}</div>
                      )}
                    </td>
                    <td className="num">{qty(i.orderedQty, i.unit)}</td>
                    <td className="num">{qty(i.expectedQty)}</td>
                    <td className="num font-500">{qty(i.actualQty)}</td>
                    <td className="num">{qty(i.acceptedQty)}</td>
                    <td className="num">
                      <span className={i.rejectedQty > 0 ? "text-[var(--c-danger)]" : undefined}>{qty(i.rejectedQty)}</span>
                    </td>
                    <td className="text-2xs">
                      {i.batchNumber && <div>Batch {i.batchNumber}</div>}
                      {i.serialNumbers && (
                        <div className="max-w-[14rem] truncate" title={i.serialNumbers}>
                          {i.serialNumbers}
                        </div>
                      )}
                      {i.expiryDate && <div>Expires {fmtDate(i.expiryDate)}</div>}
                      {!i.batchNumber && !i.serialNumbers && !i.expiryDate && "—"}
                    </td>
                    <td>
                      {i.discrepancyType === "OK" ? (
                        <Badge tone="success">OK</Badge>
                      ) : (
                        <span>
                          <StatusBadge status={i.discrepancyType} />
                          {i.discrepancyNotes && (
                            <span className="mt-0.5 block max-w-[16rem] text-2xs leading-4 text-[var(--c-warning)]">
                              {i.discrepancyNotes}
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {d.remarks && (
            <div className="border-t border-[var(--c-border-subtle)] px-4 py-3">
              <div className="label mb-1">Receiver remarks</div>
              <p className="text-xs leading-5 text-[var(--c-text-secondary)]">{d.remarks}</p>
            </div>
          )}
        </SectionCard>
      ))}
    </div>
  );
}

/* ── Inspection ───────────────────────────────────────────── */

type CriterionResult = { key: string; label: string; value: string | number | boolean | null };

export function InspectionPanel({ pr }: { pr: ProcurementCase }) {
  const inspections = pr.purchaseOrders.flatMap((po) =>
    po.deliveries.flatMap((d) => d.inspections.map((i) => ({ ...i, deliveryNumber: d.number, poNumber: po.number }))),
  );
  if (!inspections.length) {
    return (
      <Card>
        <EmptyState
          title="No inspection required or recorded"
          description="Technical inspection is raised automatically for categories configured to require it. A GRN cannot be posted until a required inspection is signed off."
        />
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {inspections.map((insp) => (
        <SectionCard
          key={insp.id}
          title={
            <span className="flex flex-wrap items-center gap-2">
              <RefLink href={`/inspections/${insp.id}`}>{insp.number}</RefLink>
              <StatusBadge status={insp.result} />
              <Badge tone="neutral">{humanize(insp.inspectionType)}</Badge>
            </span>
          }
          description={`${insp.poNumber} · ${insp.deliveryNumber}${insp.inspector ? ` · inspected by ${insp.inspector.name}` : ""}${insp.inspectedAt ? ` on ${fmtDateTime(insp.inspectedAt)}` : ""}`}
          actions={
            insp.signedByName && (
              <span className="text-right text-2xs text-[var(--c-text-tertiary)]">
                Signed by
                <span className="block text-[0.8125rem] font-500 text-[var(--c-text)]">{insp.signedByName}</span>
              </span>
            )
          }
          bodyClassName="px-0 py-0"
        >
          {insp.findings && (
            <div className="border-b border-[var(--c-border-subtle)] px-4 py-3">
              <div className="label mb-1">Findings</div>
              <p className="text-xs leading-5">{insp.findings}</p>
              {insp.conditions && (
                <>
                  <div className="label mt-2.5 mb-1">Conditions attached</div>
                  <p className="text-xs leading-5 text-[var(--c-warning)]">{insp.conditions}</p>
                </>
              )}
            </div>
          )}
          <div className="divide-y divide-[var(--c-border-subtle)]">
            {insp.items.map((it) => {
              let criteria: CriterionResult[] = [];
              try {
                criteria = JSON.parse(it.criteriaResults) as CriterionResult[];
              } catch {
                criteria = [];
              }
              return (
                <div key={it.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[0.8125rem] font-500">
                      Line {it.lineNo} · {it.description}
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge tone={it.verdict === "PASS" ? "success" : it.verdict === "FAIL" ? "danger" : "warning"}>
                        {humanize(it.verdict)}
                      </Badge>
                      <span className="tnum text-2xs text-[var(--c-text-secondary)]">
                        {qty(it.quantityPassed)} passed / {qty(it.quantityFailed)} failed of {qty(it.quantityInspected)}
                      </span>
                    </span>
                  </div>
                  <div className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-4">
                    {it.serialNumber && (
                      <div>
                        <div className="label">Serial</div>
                        <div className="mono max-w-[16rem] truncate" title={it.serialNumber}>{it.serialNumber}</div>
                      </div>
                    )}
                    {it.modelVerified && (
                      <div>
                        <div className="label">Model verified</div>
                        <div className="text-2xs">{it.modelVerified}</div>
                      </div>
                    )}
                    {it.specVerified && (
                      <div>
                        <div className="label">Specification verified</div>
                        <div className="text-2xs">{it.specVerified}</div>
                      </div>
                    )}
                    {it.condition && (
                      <div>
                        <div className="label">Condition</div>
                        <div className="text-2xs">{it.condition}</div>
                      </div>
                    )}
                  </div>
                  {criteria.length > 0 && (
                    <div className="mt-2.5 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--c-border-subtle)]">
                      <table className="dt">
                        <thead>
                          <tr>
                            <th>Criterion</th>
                            <th>Result</th>
                          </tr>
                        </thead>
                        <tbody>
                          {criteria.map((c) => (
                            <tr key={c.key}>
                              <td className="text-xs">{c.label}</td>
                              <td className="text-xs">
                                {typeof c.value === "boolean" ? (
                                  <Badge tone={c.value ? "success" : "danger"}>{c.value ? "Yes" : "No"}</Badge>
                                ) : (
                                  (c.value ?? "—")
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {it.performanceNotes && (
                    <p className="mt-2 text-2xs leading-4 text-[var(--c-text-secondary)]">{it.performanceNotes}</p>
                  )}
                </div>
              );
            })}
          </div>
        </SectionCard>
      ))}
    </div>
  );
}

/* ── GRN ──────────────────────────────────────────────────── */

export function GrnPanel({ pr }: { pr: ProcurementCase }) {
  const grns = pr.purchaseOrders.flatMap((po) => po.grns.map((g) => ({ ...g, poNumber: po.number })));
  if (!grns.length) {
    return (
      <Card>
        <EmptyState
          title="No goods receipt note"
          description="Until a GRN is posted, nothing on this case is considered received into inventory — and no invoice can be paid."
        />
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {grns.map((g) => (
        <SectionCard
          key={g.id}
          title={
            <span className="flex flex-wrap items-center gap-2">
              <RefLink href={`/grn/${g.id}`}>{g.number}</RefLink>
              <StatusBadge status={g.status} />
              <Badge tone={g.inspectionStatus === "APPROVED" ? "success" : g.inspectionStatus === "NOT_REQUIRED" ? "neutral" : "warning"}>
                Inspection: {humanize(g.inspectionStatus)}
              </Badge>
            </span>
          }
          description={`${g.poNumber} · ${g.store.name} · received by ${g.receivedBy.name} on ${fmtDateTime(g.receivedAt)}${g.postedAt ? ` · posted ${fmtDateTime(g.postedAt)}` : ""}`}
          actions={
            <span className="text-right">
              <span className="tnum block text-[0.9375rem] font-600">{money(g.totalValue)}</span>
              <span className="block text-2xs text-[var(--c-text-tertiary)]">taken into inventory</span>
            </span>
          }
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: "2.5rem" }}>#</th>
                  <th style={{ minWidth: "15rem" }}>Description</th>
                  <th className="text-right">Ordered</th>
                  <th className="text-right">Received</th>
                  <th className="text-right">Accepted</th>
                  <th className="text-right">Rejected</th>
                  <th className="text-right">Unit price</th>
                  <th className="text-right">Line value</th>
                  <th>Batch / serial</th>
                  <th>Disposition</th>
                </tr>
              </thead>
              <tbody>
                {g.items.map((i) => (
                  <tr key={i.id}>
                    <td className="tnum text-[var(--c-text-tertiary)]">{i.lineNo}</td>
                    <td>{i.description}</td>
                    <td className="num">{qty(i.orderedQty, i.unit)}</td>
                    <td className="num">{qty(i.receivedQty)}</td>
                    <td className="num font-500">{qty(i.acceptedQty)}</td>
                    <td className="num">
                      <span className={i.rejectedQty > 0 ? "text-[var(--c-danger)]" : undefined}>{qty(i.rejectedQty)}</span>
                    </td>
                    <td className="num">{money(i.unitPrice)}</td>
                    <td className="num font-500">{money(i.lineValue)}</td>
                    <td className="text-2xs">
                      {i.batchNumber && <div>Batch {i.batchNumber}</div>}
                      {i.serialNumbers && (
                        <div className="max-w-[14rem] truncate" title={i.serialNumbers}>
                          {i.serialNumbers}
                        </div>
                      )}
                      {i.warrantyMonths && <div>{i.warrantyMonths}m warranty</div>}
                      {!i.batchNumber && !i.serialNumbers && !i.warrantyMonths && "—"}
                    </td>
                    <td>
                      <Badge tone="neutral">{humanize(i.disposition)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={7} className="text-right">Total received value</td>
                  <td className="num">{money(g.totalValue)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
          {g.remarks && (
            <div className="border-t border-[var(--c-border-subtle)] px-4 py-3">
              <p className="text-xs leading-5 text-[var(--c-text-secondary)]">{g.remarks}</p>
            </div>
          )}
        </SectionCard>
      ))}
    </div>
  );
}

/* ── Invoice ──────────────────────────────────────────────── */

function parseMatch(raw: string): MatchResult | null {
  try {
    return JSON.parse(raw) as MatchResult;
  } catch {
    return null;
  }
}

export function InvoicePanel({ pr }: { pr: ProcurementCase }) {
  const invoices = pr.purchaseOrders.flatMap((po) => po.invoices.map((i) => ({ ...i, poNumber: po.number })));
  if (!invoices.length) {
    return (
      <Card>
        <EmptyState
          title="No invoice registered"
          description="Vendor invoices are registered against the purchase order and matched three ways — purchase order, GRN and invoice — before any payment."
        />
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {invoices.map((inv) => {
        const match = parseMatch(inv.matchResult);
        return (
          <SectionCard
            key={inv.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                <RefLink href={`/invoices/${inv.id}`}>{inv.number}</RefLink>
                <StatusBadge status={inv.status} />
                <Badge
                  tone={
                    inv.matchStatus === "PASSED"
                      ? "success"
                      : inv.matchStatus === "FAILED"
                        ? "danger"
                        : inv.matchStatus === "OVERRIDDEN"
                          ? "warning"
                          : "neutral"
                  }
                >
                  Match: {humanize(inv.matchStatus)}
                </Badge>
              </span>
            }
            description={`${inv.poNumber} · ${inv.vendor.name} · vendor ref ${inv.vendorInvoiceNumber} dated ${fmtDate(inv.invoiceDate)}`}
            actions={
              <span className="text-right">
                <span className="tnum block text-[0.9375rem] font-600">{money(inv.total)}</span>
                <span className="block text-2xs text-[var(--c-text-tertiary)]">
                  net payable {money(inv.netPayable)}
                </span>
              </span>
            }
            bodyClassName="px-0 py-0"
          >
            {match && !match.passed && (
              <div className="border-b border-[var(--c-border-subtle)] px-4 py-3">
                <BlockedNotice
                  title="Three-way match failed — payment is blocked"
                  reasons={match.failures}
                  tone="danger"
                />
                {match.warnings.length > 0 && (
                  <div className="mt-2">
                    <BlockedNotice title="Warnings" reasons={match.warnings} tone="warning" />
                  </div>
                )}
              </div>
            )}
            {inv.exceptionReason && (
              <div className="border-b border-[var(--c-border-subtle)] px-4 py-2.5">
                <InlineAlert tone="warning">
                  <span className="font-600">Mismatch waived by an authorised approver: </span>
                  {inv.exceptionReason}
                </InlineAlert>
              </div>
            )}

            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: "2.5rem" }}>#</th>
                    <th style={{ minWidth: "15rem" }}>Description</th>
                    <th className="text-right">Invoiced</th>
                    <th className="text-right">On PO</th>
                    <th className="text-right">GRN accepted</th>
                    <th className="text-right">Unit price</th>
                    <th className="text-right">PO price</th>
                    <th className="text-right">Line total</th>
                    <th>Match</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.items.map((i) => (
                    <tr key={i.id}>
                      <td className="tnum text-[var(--c-text-tertiary)]">{i.lineNo}</td>
                      <td>
                        <div>{i.description}</div>
                        {i.matchNotes && <div className="mt-0.5 text-2xs text-[var(--c-danger)]">{i.matchNotes}</div>}
                      </td>
                      <td className="num font-500">{qty(i.quantity, i.unit)}</td>
                      <td className="num">{i.poQuantity !== null ? qty(i.poQuantity) : "—"}</td>
                      <td className="num">{i.grnAcceptedQty !== null ? qty(i.grnAcceptedQty) : "—"}</td>
                      <td className="num">{money(i.unitPrice)}</td>
                      <td className="num">{i.poUnitPrice !== null ? money(i.poUnitPrice) : "—"}</td>
                      <td className="num font-500">{money(i.lineTotal)}</td>
                      <td>
                        <Badge tone={i.matchFlag === "OK" ? "success" : "danger"}>{humanize(i.matchFlag)}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={7} className="text-right">Invoice total</td>
                    <td className="num">{money(inv.total)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="grid gap-x-6 gap-y-2 border-t border-[var(--c-border-subtle)] px-4 py-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                ["Subtotal", money(inv.subtotal)],
                ["Tax", money(inv.taxAmount)],
                ["Delivery", money(inv.deliveryCharges)],
                ["Withholding tax", money(inv.withholdingTax)],
                ["Net payable", money(inv.netPayable)],
                ["Due date", inv.dueDate ? fmtDate(inv.dueDate) : "—"],
              ].map(([label, value]) => (
                <div key={label}>
                  <div className="label">{label}</div>
                  <div className="tnum text-[0.8125rem]">{value}</div>
                </div>
              ))}
            </div>
          </SectionCard>
        );
      })}
    </div>
  );
}

/* ── Finance ──────────────────────────────────────────────── */

export function FinancePanel({ pr }: { pr: ProcurementCase }) {
  const handoffs = pr.purchaseOrders.flatMap((po) =>
    po.invoices.flatMap((inv) => inv.handoffs.map((h) => ({ ...h, invoiceNumber: inv.number, vendorName: inv.vendor.name }))),
  );
  const advances = pr.purchaseOrders.filter((po) => po.advanceRequired);

  if (!handoffs.length && !advances.length) {
    return (
      <Card>
        <EmptyState
          title="Nothing with finance"
          description="Once an invoice is verified and approved, procurement hands it to finance for payment. Advance payments appear here too."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {advances.length > 0 && (
        <SectionCard title="Advance payments" description="Advances carry collateral and are settled against delivery." bodyClassName="px-0 py-0">
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Purchase order</th>
                  <th className="text-right">Advance</th>
                  <th className="text-right">%</th>
                  <th>Status</th>
                  <th>Collateral</th>
                  <th>Reference</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {advances.map((po) => (
                  <tr key={po.id}>
                    <td>
                      <RefLink href={`/po/${po.id}`}>{po.number}</RefLink>
                    </td>
                    <td className="num font-500">{money(po.advanceAmount ?? 0)}</td>
                    <td className="num">{po.advancePercent ?? "—"}</td>
                    <td>
                      <StatusBadge status={po.advanceStatus ?? "PENDING"} />
                    </td>
                    <td className="text-xs">{po.collateralType ? humanize(po.collateralType) : "—"}</td>
                    <td className="text-xs">{po.collateralRef ?? "—"}</td>
                    <td className="text-xs text-[var(--c-text-secondary)]">{po.collateralNotes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {handoffs.length > 0 && (
        <SectionCard title="Payment handoffs" description={`${handoffs.length} handoff(s) to finance`} bodyClassName="px-0 py-0">
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Handoff</th>
                  <th>Invoice</th>
                  <th>Vendor</th>
                  <th className="text-right">Amount</th>
                  <th>Status</th>
                  <th>Method</th>
                  <th>Handed off</th>
                  <th>Scheduled</th>
                  <th>Paid</th>
                  <th>Reference</th>
                </tr>
              </thead>
              <tbody>
                {handoffs.map((h) => (
                  <tr key={h.id}>
                    <td>
                      <RefLink href={`/finance/handoffs/${h.id}`}>{h.number}</RefLink>
                    </td>
                    <td className="text-xs">{h.invoiceNumber}</td>
                    <td className="text-xs">{h.vendorName}</td>
                    <td className="num font-500">{money(h.amount)}</td>
                    <td>
                      <StatusBadge status={h.status} />
                    </td>
                    <td className="text-xs">{h.paymentMethod ? humanize(h.paymentMethod) : "—"}</td>
                    <td className="text-xs">
                      {fmtDate(h.handedOffAt)}
                      <span className="block text-2xs text-[var(--c-text-tertiary)]">{h.handedOffBy.name}</span>
                    </td>
                    <td className="text-xs">{h.scheduledDate ? fmtDate(h.scheduledDate) : "—"}</td>
                    <td className="text-xs">{h.paidDate ? fmtDate(h.paidDate) : "—"}</td>
                    <td className="mono text-2xs">{h.paymentReference ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </div>
  );
}

/* ── Audit ────────────────────────────────────────────────── */

export function AuditPanel({
  rows,
}: {
  rows: Array<{
    id: string;
    createdAt: Date;
    entityType: string;
    entityRef: string | null;
    action: string;
    actorName: string | null;
    actorRoles: string | null;
    reason: string | null;
    ip: string | null;
    changes: Record<string, { from: unknown; to: unknown }> | null;
  }>;
}) {
  return (
    <SectionCard
      title="Audit trail"
      description={`${rows.length} immutable record(s). Every state change, who made it, when, and the before/after values.`}
      bodyClassName="px-0 py-0"
    >
      <div className="table-wrap">
        <table className="dt">
          <thead>
            <tr>
              <th style={{ width: "11rem" }}>When</th>
              <th style={{ width: "11rem" }}>Object</th>
              <th style={{ width: "9rem" }}>Reference</th>
              <th style={{ width: "15rem" }}>Action</th>
              <th style={{ width: "12rem" }}>Actor</th>
              <th style={{ minWidth: "18rem" }}>Change / reason</th>
              <th style={{ width: "8rem" }}>IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="text-2xs">{fmtDateTime(r.createdAt)}</td>
                <td className="text-2xs">{r.entityType}</td>
                <td className="mono text-2xs">{r.entityRef ?? "—"}</td>
                <td className="text-xs">{humanize(r.action)}</td>
                <td className="text-2xs">
                  {r.actorName ?? "System"}
                  {r.actorRoles && <span className="block text-[var(--c-text-tertiary)]">{r.actorRoles}</span>}
                </td>
                <td className="text-2xs leading-4">
                  {r.changes &&
                    Object.entries(r.changes).map(([k, v]) => (
                      <div key={k}>
                        <span className="text-[var(--c-text-tertiary)]">{k}:</span>{" "}
                        <span className="text-[var(--c-danger)]">{String(v.from ?? "—")}</span>
                        {" → "}
                        <span className="text-[var(--c-success)]">{String(v.to ?? "—")}</span>
                      </div>
                    ))}
                  {r.reason && <div className="mt-0.5 text-[var(--c-text-secondary)]">“{r.reason}”</div>}
                  {!r.changes && !r.reason && "—"}
                </td>
                <td className="mono text-2xs">{r.ip ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
