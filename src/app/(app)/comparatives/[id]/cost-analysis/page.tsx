import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Badge, BlockedNotice, InlineAlert, PageHeader } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav";
import { costAnalysis, costAnalysisGaps } from "@/server/cost-analysis";
import { manualComparisons } from "@/server/manual-comparison";
import { applicableTaxRules } from "@/server/tax";
import { MANUAL_SOURCE_TYPES } from "@/lib/domain";
import { fmtDate, money, qty } from "@/lib/format";
import { CostAnalysisForm, ManualComparisonForm, VerifyForm } from "./forms";

export const metadata = { title: "Cost Analysis Form" };
export const dynamic = "force-dynamic";

/**
 * The Cost Analysis Form, as it is signed.
 *
 * This is the sheet procurement already fills in by hand, drawn from what the
 * system holds: the requisition, the quotations, the price actually last paid
 * for each item, and the four compliance questions. Laid out to print on one
 * page, because the copy that gets signed is the copy that gets filed.
 */
export default async function CostAnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, ctx, authorized } = await pageContext(P.COMPARATIVE_VIEW);
  if (!authorized) {
    return <AccessDenied title="Cost Analysis Form" message="You do not have permission to view comparatives." />;
  }

  const form = await costAnalysis(id);
  const manual = await manualComparisons(id);
  // Only offered while the sheet can still change — a comparison that moves
  // after approval is not the comparison that was approved.
  const canAddManual =
    !["APPROVED", "CANCELLED"].includes(form.status) &&
    userHasPermission(ctx.user, P.QUOTE_ENTER, P.COMPARATIVE_CREATE);
  const [manualVendors, manualTaxRules] = canAddManual
    ? await Promise.all([
        prisma.vendor.findMany({
          where: { status: { in: ["APPROVED", "CONDITIONAL"] } },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
          take: 200,
        }),
        applicableTaxRules({ entityId: ctx.entityId }),
      ])
    : [[], []];
  const gaps = costAnalysisGaps(form);
  const canEdit = userHasPermission(user, P.COMPARATIVE_CREATE);
  const canVerify = userHasPermission(user, P.COMPARATIVE_VERIFY);
  const locked = ["APPROVED", "AWARDED"].includes(form.status);

  const answer = (v: boolean | null) =>
    v === null ? (
      <Badge tone="warning">Not answered</Badge>
    ) : v ? (
      <Badge tone="danger">Yes</Badge>
    ) : (
      <Badge tone="success">No</Badge>
    );

  return (
    <div className="space-y-5">
      <div className="no-print">
        <Breadcrumbs
          items={[
            { label: "Procurement", href: "/pr" },
            { label: "Comparatives", href: "/comparatives" },
            { label: form.number, href: `/comparatives/${id}` },
            { label: "Cost analysis" },
          ]}
        />
      </div>

      <PageHeader
        eyebrow="Sourcing"
        title="Cost Analysis Form"
        subtitle={`${form.number} · ${form.prNumber} — ${form.prTitle}`}
        actions={
          <span className="no-print flex flex-wrap items-center gap-2">
            <Link href={`/comparatives/${id}`} className="btn btn-secondary btn-sm">
              Back to comparative
            </Link>
            {canVerify && !form.verifiedAt && <VerifyForm comparativeId={id} disabled={gaps.length > 0} />}
          </span>
        }
      />

      {gaps.length > 0 && (
        <div className="no-print">
          <BlockedNotice title="This form is not ready to be signed" reasons={gaps} />
        </div>
      )}

      {/* ── The form itself ─────────────────────────────────── */}
      <div className="card card-pad space-y-5 print:border-0 print:shadow-none">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
          <div>
            <p className="label">{form.entityName}</p>
            <h2 className="text-lg leading-6 font-600 tracking-[-0.01em]">Cost Analysis Form</h2>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
            <div>
              <dt className="label">PR No</dt>
              <dd className="mono">{form.prNumber}</dd>
            </div>
            <div>
              <dt className="label">Department</dt>
              <dd>{form.departmentName}</dd>
            </div>
            <div>
              <dt className="label">PR POC</dt>
              <dd>{form.pocName ?? <span className="text-[var(--c-text-tertiary)]">Not named</span>}</dd>
            </div>
            <div>
              <dt className="label">Date</dt>
              <dd className="tnum">{fmtDate(form.preparedAt)}</dd>
            </div>
          </dl>
        </header>

        {/* Cost comparison */}
        <section>
          <h3 className="label mb-2">Cost comparison</h3>
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: "3rem" }}>Sr.</th>
                  <th style={{ minWidth: "14rem" }}>Description</th>
                  <th className="text-right">Last PO price</th>
                  <th>Last PO date</th>
                  <th className="text-right">Qty</th>
                  <th>UOM</th>
                  {form.vendors.map((v) => (
                    <th key={v.lineId} colSpan={2} className="text-center">
                      <span className="flex items-center justify-center gap-1.5">
                        {v.vendorName}
                        {v.isSelected && <Badge tone="success">Awarded</Badge>}
                        {!v.isSelected && v.isLowest && <Badge tone="info">Lowest</Badge>}
                      </span>
                    </th>
                  ))}
                </tr>
                <tr>
                  <th colSpan={6} />
                  {form.vendors.map((v) => (
                    <>
                      <th key={`${v.lineId}-r`} className="text-right">
                        Rate/item
                      </th>
                      <th key={`${v.lineId}-t`} className="text-right">
                        Total
                      </th>
                    </>
                  ))}
                </tr>
              </thead>
              <tbody>
                {form.items.map((it) => (
                  <tr key={it.lineNo}>
                    <td className="num text-xs">{it.lineNo}</td>
                    <td className="wrap text-xs">{it.description}</td>
                    <td className="num text-xs">
                      {it.lastPoPrice !== null ? (
                        money(it.lastPoPrice)
                      ) : (
                        <span className="text-[var(--c-text-tertiary)]">Never bought</span>
                      )}
                    </td>
                    <td className="text-2xs">{it.lastPoDate ? fmtDate(it.lastPoDate) : "—"}</td>
                    <td className="num text-xs">{qty(it.quantity)}</td>
                    <td className="text-2xs">{it.unit}</td>
                    {form.vendors.map((v) => {
                      const cell = it.byVendor[v.lineId];
                      return (
                        <>
                          <td key={`${v.lineId}-${it.lineNo}-r`} className="num text-xs">
                            {cell?.rate !== null && cell?.rate !== undefined ? (
                              money(cell.rate)
                            ) : (
                              <span className="text-[var(--c-text-tertiary)]">Not offered</span>
                            )}
                          </td>
                          <td key={`${v.lineId}-${it.lineNo}-t`} className="num text-xs">
                            {cell?.total !== null && cell?.total !== undefined ? money(cell.total) : "—"}
                          </td>
                        </>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6} className="text-right text-xs font-500">
                    Total
                  </td>
                  {form.vendors.map((v) => (
                    <>
                      <td key={`${v.lineId}-st-r`} />
                      <td key={`${v.lineId}-st`} className="num text-xs font-500">
                        {money(v.subtotal)}
                      </td>
                    </>
                  ))}
                </tr>
                <tr>
                  <td colSpan={6} className="text-right text-xs">
                    Tax @ {form.taxPercent}%
                  </td>
                  {form.vendors.map((v) => (
                    <>
                      <td key={`${v.lineId}-tax-r`} />
                      <td key={`${v.lineId}-tax`} className="num text-xs">
                        {money(v.taxAmount)}
                      </td>
                    </>
                  ))}
                </tr>
                <tr>
                  <td colSpan={6} className="text-right text-xs font-600">
                    Net total
                  </td>
                  {form.vendors.map((v) => (
                    <>
                      <td key={`${v.lineId}-net-r`} />
                      <td
                        key={`${v.lineId}-net`}
                        className={`num text-xs font-600 ${v.isSelected ? "text-success-soft-foreground" : ""}`}
                      >
                        {money(v.netTotal)}
                      </td>
                    </>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        {/* Terms per vendor */}
        <section>
          <h3 className="label mb-2">Terms</h3>
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ minWidth: "10rem" }} />
                  {form.vendors.map((v) => (
                    <th key={v.lineId}>{v.vendorName}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["Payment terms", "paymentTerms"],
                    ["Specifications", "specifications"],
                    ["Delivery / job completion", "deliveryCommitment"],
                    ["Tax information", "taxInformation"],
                  ] as const
                ).map(([label, key]) => (
                  <tr key={key}>
                    <td className="text-xs font-500">{label}</td>
                    {form.vendors.map((v) => (
                      <td key={v.lineId} className="wrap text-xs">
                        {v[key] ?? <span className="text-[var(--c-text-tertiary)]">Not stated</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Manual comparison options — labelled, never mistaken for a quotation */}
        {manual.length > 0 && (
          <section>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="label">Manual comparison options</h3>
              <Badge tone="warning">MANUAL — not vendor-submitted</Badge>
            </div>
            <p className="mb-2 text-2xs leading-5 text-[var(--c-text-tertiary)]">
              Entered by hand from a price list, a rate contract, a prior purchase or a verbal indication. These widen
              the comparison but cannot be awarded against — an award needs a price the vendor actually offered.
            </p>
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ minWidth: "11rem" }}>Source</th>
                    <th style={{ minWidth: "12rem" }}>Description</th>
                    <th style={{ width: "6rem" }} className="text-right">
                      Rate
                    </th>
                    <th style={{ width: "6rem" }} className="text-right">
                      Qty
                    </th>
                    <th style={{ width: "8rem" }} className="text-right">
                      Gross
                    </th>
                    <th style={{ width: "7rem" }} className="text-right">
                      Tax
                    </th>
                    <th style={{ width: "8rem" }} className="text-right">
                      Net
                    </th>
                    <th style={{ minWidth: "12rem" }}>Why entered by hand</th>
                  </tr>
                </thead>
                <tbody>
                  {manual.map((m) => (
                    <tr key={m.id}>
                      <td>
                        {m.vendor?.name ?? m.sourceName}
                        <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                          {MANUAL_SOURCE_TYPES.find((t) => t.code === m.sourceType)?.label ?? m.sourceType}
                          {m.evidenceRef ? ` · ${m.evidenceRef}` : ""}
                        </span>
                      </td>
                      <td>{m.description}</td>
                      <td className="tnum text-right">{money(m.rate)}</td>
                      <td className="tnum text-right">
                        {m.quantity} {m.unit}
                      </td>
                      <td className="tnum text-right">{money(m.grossValue)}</td>
                      <td className="tnum text-right">
                        {m.taxRate === null ? (
                          <span className="text-[var(--c-text-tertiary)]">unset</span>
                        ) : (
                          <>
                            {money(m.taxAmount)}
                            <span className="block text-2xs text-[var(--c-text-tertiary)]">
                              {m.taxRule?.code ?? ""} {m.taxRate}%
                            </span>
                          </>
                        )}
                      </td>
                      <td className="tnum text-right font-500">{money(m.netValue)}</td>
                      <td className="text-2xs leading-5">
                        {m.reason}
                        <span className="mt-0.5 block text-[var(--c-text-tertiary)]">
                          {m.enteredBy.name} · {fmtDate(m.enteredAt)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {canAddManual && (
          <ManualComparisonForm
            comparativeId={id}
            vendors={manualVendors}
            taxRules={(manualTaxRules as Array<{ id: string; code: string; name: string; percent: number }>).map((t) => ({
              id: t.id,
              code: t.code,
              name: t.name,
              percent: t.percent,
            }))}
            units={[...new Set(form.items.map((i) => i.unit))].filter(Boolean)}
          />
        )}

        {/* Award and compliance */}
        <section className="grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="label mb-2">Award</h3>
            <dl className="row-list border-t border-separator text-xs">
              <div className="flex justify-between gap-3 py-1.5">
                <dt className="text-muted">PO awarded to</dt>
                <dd className="font-500">{form.awardedToVendorName ?? "Not yet decided"}</dd>
              </div>
              <div className="flex justify-between gap-3 py-1.5">
                <dt className="text-muted">Invoice charged to</dt>
                <dd className="font-500">{form.invoiceChargedTo}</dd>
              </div>
              <div className="flex justify-between gap-3 py-1.5">
                <dt className="text-muted">Prepared by</dt>
                <dd className="font-500">{form.preparedByName}</dd>
              </div>
              <div className="flex justify-between gap-3 py-1.5">
                <dt className="text-muted">Verified by</dt>
                <dd className="font-500">
                  {form.verifiedByName ? (
                    <>
                      {form.verifiedByName}
                      <span className="ml-1.5 text-2xs text-[var(--c-text-tertiary)]">
                        {form.verifiedAt ? fmtDate(form.verifiedAt) : ""}
                      </span>
                    </>
                  ) : (
                    <Badge tone="warning">Awaiting verification</Badge>
                  )}
                </dd>
              </div>
            </dl>
          </div>

          <div>
            <h3 className="label mb-2">Compliance</h3>
            <dl className="row-list border-t border-separator text-xs">
              <div className="flex items-center justify-between gap-3 py-1.5">
                <dt className="text-muted">Is the vendor single sourced?</dt>
                <dd>{answer(form.singleSourced)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-1.5">
                <dt className="text-muted">Are rates already locked with the vendor?</dt>
                <dd>{answer(form.ratesLocked)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-1.5">
                <dt className="text-muted">Is the vendor selection form fulfilled and approved?</dt>
                <dd>{answer(form.vendorSelectionForm)}</dd>
              </div>
              {form.higherRateReason && (
                <div className="py-1.5">
                  <dt className="text-muted">Reason for approving higher rates</dt>
                  <dd className="mt-0.5 leading-5">{form.higherRateReason}</dd>
                </div>
              )}
            </dl>
          </div>
        </section>

        {(form.remarks || form.specialNotes) && (
          <section className="grid gap-4 lg:grid-cols-2">
            {form.remarks && (
              <div>
                <h3 className="label mb-1">Remarks</h3>
                <p className="text-xs leading-5">{form.remarks}</p>
              </div>
            )}
            {form.specialNotes && (
              <div>
                <h3 className="label mb-1">Special notes</h3>
                <p className="text-xs leading-5">{form.specialNotes}</p>
              </div>
            )}
          </section>
        )}

        {/* The signature block only makes sense on paper. */}
        <section className="hidden border-t border-border pt-6 print:block">
          <div className="grid grid-cols-2 gap-12 text-xs">
            <div>
              <div className="mb-1 h-10 border-b border-[#999]" />
              Prepared by — {form.preparedByName}
            </div>
            <div>
              <div className="mb-1 h-10 border-b border-[#999]" />
              Verified by — {form.verifiedByName ?? ""}
            </div>
          </div>
          <div className="mt-8 w-1/2 text-xs">
            <div className="mb-1 h-10 border-b border-[#999]" />
            Relevant approval authority — signature &amp; stamp
          </div>
        </section>
      </div>

      {canEdit && !locked && (
        <div className="no-print">
          <CostAnalysisForm comparativeId={id} form={form} />
        </div>
      )}

      {locked && (
        <InlineAlert tone="info">
          {form.number} has been {form.status.toLowerCase()}. The form it was decided on is kept as it was signed.
        </InlineAlert>
      )}
    </div>
  );
}
