import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { voucherReadiness } from "@/server/vouchers";
import { generateVoucherAction, verifyTaxLinesAction } from "@/app/(app)/finance/actions";
import { runThreeWayMatch, type MatchResult } from "@/server/invoice";
import { getApprovalTrail } from "@/lib/approvals";
import { documentTimeline } from "@/server/timeline";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  BlockedNotice,
  DefList,
  InlineAlert,
  MetaItem,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/forms";
import { ApprovalTrailView, LifecycleRail, Timeline, buildRail } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { PaymentPackPanel } from "@/components/domain/PaymentPackPanel";
import { ExceptionsPanel } from "@/components/domain/ExceptionsPanel";
import { humanize } from "@/lib/domain";
import { fmtDate, fmtDateTime, money, percent, qty, round2 } from "@/lib/format";
import {
  decideInvoiceAction,
  handoffAction,
  holdInvoiceAction,
  rematchAction,
  submitInvoiceAction,
  verifyInvoiceAction,
  waiveMismatchAction,
} from "../actions";

export const dynamic = "force-dynamic";

const INVOICE_LIFECYCLE = [
  "RECEIVED",
  "UNDER_VERIFICATION",
  "MATCHED",
  "PENDING_APPROVAL",
  "APPROVED",
  "SENT_TO_FINANCE",
  "PAID",
] as const;

const FLAG_TONE: Record<string, "success" | "danger" | "warning" | "neutral"> = {
  OK: "success",
  QTY_MISMATCH: "danger",
  PRICE_MISMATCH: "danger",
  NOT_ON_PO: "danger",
  NOT_RECEIVED: "danger",
  TAX_MISMATCH: "warning",
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const i = await prisma.invoice.findUnique({ where: { id }, select: { number: true } });
  return { title: i ? `${i.number} — Invoice` : "Invoice" };
}

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.INVOICE_VIEW);
  if (!authorized) return <AccessDenied title="Invoice" />;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      vendor: { select: { id: true, code: true, name: true, status: true, paymentTerms: true, creditDays: true } },
      po: {
        select: {
          id: true,
          number: true,
          total: true,
          entityId: true,
          status: true,
          procurementKind: true,
          entity: { select: { code: true, name: true } },
          pr: { select: { id: true, number: true, title: true } },
          items: {
            orderBy: { lineNo: "asc" },
            select: {
              id: true,
              lineNo: true,
              description: true,
              quantity: true,
              unit: true,
              unitPrice: true,
              acceptedQty: true,
              invoicedQty: true,
            },
          },
        },
      },
      items: { orderBy: { lineNo: "asc" } },
      grnLinks: {
        include: {
          grn: {
            select: {
              id: true,
              number: true,
              receivedAt: true,
              totalValue: true,
              status: true,
              store: { select: { name: true } },
            },
          },
        },
      },
      handoffs: { orderBy: { handedOffAt: "desc" }, include: { handedOffBy: { select: { name: true } } } },
      verifiedBy: { select: { name: true, title: true } },
      taxLines: { orderBy: { label: "asc" } },
      vouchers: { orderBy: { preparedAt: "desc" }, select: { id: true, number: true, status: true, netAmount: true } },
      matches: { orderBy: { runAt: "desc" }, take: 5 },
    },
  });
  if (!invoice) notFound();

  const [events, trail, match, exceptionApprover, voucherCheck] = await Promise.all([
    documentTimeline("Invoice", invoice.id),
    getApprovalTrail("INVOICE", invoice.id),
    runThreeWayMatch(invoice.id).catch(() => null),
    invoice.exceptionApprovedById
      ? prisma.user.findUnique({ where: { id: invoice.exceptionApprovedById }, select: { name: true, title: true } })
      : Promise.resolve(null),
    // Everything standing between this invoice and a voucher, listed rather than
    // discovered one refusal at a time.
    voucherReadiness(invoice.id).catch(() => ({ ready: false, blockers: ["Readiness could not be established."], warnings: [] })),
  ]);

  const stored: MatchResult | null = (() => {
    try {
      const parsed = JSON.parse(invoice.matchResult) as MatchResult;
      return parsed && Array.isArray(parsed.lines) ? parsed : null;
    } catch {
      return null;
    }
  })();
  const result = match ?? stored;

  const canVerify = userHasPermission(user, P.INVOICE_VERIFY);
  const canApprove = userHasPermission(user, P.INVOICE_APPROVE);
  const canWaive = userHasPermission(user, P.INVOICE_EXCEPTION_APPROVE);
  const canHandoff = userHasPermission(user, P.FINANCE_HANDOFF);
  const canVerifyTax = userHasPermission(user, P.TAX_VERIFY);
  const liveVoucher = invoice.vouchers.find((v) => !["CANCELLED", "REJECTED"].includes(v.status)) ?? null;
  const canGenerateVoucher = userHasPermission(user, P.VOUCHER_GENERATE) && !liveVoucher;

  const handoff = invoice.handoffs[0];
  const mismatchLines = invoice.items.filter((i) => i.matchFlag !== "OK");
  const blockingExceptions = await prisma.exception.count({
    where: { invoiceId: invoice.id, status: { in: ["OPEN", "IN_PROGRESS"] }, blocking: true },
  });

  const paymentBlockers: string[] = [];
  if (invoice.matchStatus === "FAILED") {
    paymentBlockers.push(
      `The three-way match failed: ${(result?.failures ?? [invoice.matchNotes ?? "see match detail"]).join(" ")}`,
    );
  }
  if (invoice.grnLinks.length === 0) {
    paymentBlockers.push("No goods receipt is linked to this invoice — nothing proves the goods arrived.");
  }
  if (blockingExceptions > 0) {
    paymentBlockers.push(
      `${blockingExceptions} blocking exception${blockingExceptions === 1 ? "" : "s"} open against this invoice.`,
    );
  }
  if (invoice.vendor.status === "BLACKLISTED") {
    paymentBlockers.push(`${invoice.vendor.name} is blacklisted.`);
  }

  const rail = buildRail(
    INVOICE_LIFECYCLE,
    invoice.status === "MISMATCH" || invoice.status === "EXCEPTION_APPROVED" ? "MATCHED" : invoice.status,
    {
      RECEIVED: { at: invoice.receivedDate, owner: null },
      MATCHED: { at: invoice.verifiedAt, owner: invoice.verifiedBy?.name ?? null },
      SENT_TO_FINANCE: { at: handoff?.handedOffAt ?? null, owner: handoff?.handedOffBy.name ?? null },
      PAID: { at: handoff?.paidDate ?? null, owner: null },
    },
    {
      terminalBad: invoice.status === "REJECTED" || invoice.matchStatus === "FAILED",
      blockedNote: paymentBlockers[0] ?? null,
    },
  );

  const alreadyInvoiced = round2(
    invoice.po.items.reduce((a, it) => a + it.invoicedQty * it.unitPrice, 0),
  );

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Finance", href: "/invoices" },
          { label: "Invoices", href: "/invoices" },
          { label: invoice.number },
        ]}
      />

      <PageHeader
        eyebrow={`${invoice.po.entity.code} · ${invoice.vendor.name}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{invoice.number}</span>
            <span>Vendor reference {invoice.vendorInvoiceNumber}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={invoice.status} />
            </MetaItem>
            <MetaItem label="Three-way match">
              <Badge
                tone={
                  invoice.matchStatus === "PASSED"
                    ? "success"
                    : invoice.matchStatus === "FAILED"
                      ? "danger"
                      : invoice.matchStatus === "OVERRIDDEN"
                        ? "warning"
                        : "neutral"
                }
              >
                {humanize(invoice.matchStatus)}
              </Badge>
            </MetaItem>
            <MetaItem label="Total">{money(invoice.total)}</MetaItem>
            <MetaItem label="Net payable">{money(invoice.netPayable)}</MetaItem>
            <MetaItem label="Invoice date">{fmtDate(invoice.invoiceDate)}</MetaItem>
            <MetaItem label="Due">{invoice.dueDate ? fmtDate(invoice.dueDate) : "—"}</MetaItem>
          </>
        }
        actions={
          <>
            {canVerify && ["RECEIVED", "UNDER_VERIFICATION", "MISMATCH"].includes(invoice.status) && (
              <ActionButton
                action={verifyInvoiceAction}
                payload={{ invoiceId: invoice.id }}
                label="Verify and match"
                tone="primary"
              />
            )}
            {canVerify && (
              <ActionButton
                action={rematchAction}
                payload={{ invoiceId: invoice.id }}
                label="Re-run match"
                tone="secondary"
              />
            )}
            {canWaive && invoice.matchStatus === "FAILED" && (
              <ActionButton
                action={waiveMismatchAction}
                payload={{ invoiceId: invoice.id }}
                label="Waive mismatch"
                tone="danger-soft"
                reasonLabel="Why is this mismatch being waived? At least a full sentence — this override is permanent and attributed to you."
                reasonRequired
              />
            )}
            {canVerify && ["MATCHED", "EXCEPTION_APPROVED"].includes(invoice.status) && (
              <ActionButton
                action={submitInvoiceAction}
                payload={{ invoiceId: invoice.id }}
                label="Submit for approval"
                tone="primary"
              />
            )}
            {canApprove && invoice.status === "PENDING_APPROVAL" && (
              <>
                <ActionButton
                  action={decideInvoiceAction}
                  payload={{ invoiceId: invoice.id, decision: "APPROVED" }}
                  label="Approve"
                  tone="primary"
                  confirm={`Approve ${invoice.number} for ${money(invoice.netPayable)}?`}
                />
                <ActionButton
                  action={decideInvoiceAction}
                  payload={{ invoiceId: invoice.id, decision: "REJECTED" }}
                  label="Reject"
                  tone="danger-soft"
                  reasonLabel="Why is this invoice being rejected?"
                  reasonRequired
                />
              </>
            )}
            {canHandoff && invoice.status === "APPROVED" && (
              <ActionButton
                action={handoffAction}
                payload={{ invoiceId: invoice.id }}
                label="Hand to finance"
                tone="primary"
                disabled={paymentBlockers.length > 0}
                disabledReason={paymentBlockers[0]}
                reasonLabel="Notes for finance (optional)"
              />
            )}
            {canVerifyTax && invoice.taxLines.length > 0 && invoice.taxLines.some((t) => t.status !== "VERIFIED") && (
              <ActionButton
                action={verifyTaxLinesAction}
                payload={{ invoiceId: invoice.id }}
                label="Verify tax"
                tone="secondary"
                confirm={`Verify ${invoice.taxLines.length} tax line(s)? A voucher cannot be raised until tax is verified.`}
              />
            )}
            {canGenerateVoucher && (
              <ActionButton
                action={generateVoucherAction}
                payload={{ invoiceId: invoice.id }}
                label="Raise payment voucher"
                tone="primary"
                disabled={!voucherCheck.ready}
                disabledReason={voucherCheck.blockers[0]}
                confirm={`Raise a voucher for ${money(invoice.netPayable, invoice.currency)}? It goes to the signatories configured for that amount.`}
              />
            )}
            {liveVoucher && (
              <Link href={`/finance/vouchers/${liveVoucher.id}`} className="btn btn-secondary btn-sm">
                {liveVoucher.number}
              </Link>
            )}
            {canVerify && !["PAID", "REJECTED", "ON_HOLD"].includes(invoice.status) && (
              <ActionButton
                action={holdInvoiceAction}
                payload={{ invoiceId: invoice.id }}
                label="Hold"
                tone="secondary"
                reasonLabel="Why is this invoice being held?"
                reasonRequired
              />
            )}
            <Link href={`/po/${invoice.po.id}`} className="btn btn-secondary btn-sm">
              {invoice.po.number}
            </Link>
          </>
        }
      />

      {paymentBlockers.length > 0 && (
        <BlockedNotice
          tone="danger"
          title="Payment is blocked on this invoice"
          reasons={paymentBlockers}
        />
      )}

      {invoice.matchStatus === "OVERRIDDEN" && (
        <InlineAlert tone="warning">
          The match failure on this invoice was formally waived
          {exceptionApprover ? ` by ${exceptionApprover.name}` : ""}
          {invoice.exceptionApprovedAt ? ` on ${fmtDateTime(invoice.exceptionApprovedAt)}` : ""}.
          {invoice.exceptionReason ? ` Reason: ${invoice.exceptionReason}` : ""}
        </InlineAlert>
      )}

      {invoice.status === "PAID" && handoff?.paidDate && (
        <InlineAlert tone="success">
          Paid on {fmtDate(handoff.paidDate)}
          {handoff.paymentReference ? ` · reference ${handoff.paymentReference}` : ""}
          {handoff.paymentMethod ? ` · ${humanize(handoff.paymentMethod).toLowerCase()}` : ""}.
        </InlineAlert>
      )}

      <LifecycleRail steps={rail} title="Invoice lifecycle" />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Invoice total" value={money(invoice.total)} />
        <StatTile
          label="Order value"
          value={money(invoice.po.total)}
          hint={`${money(alreadyInvoiced)} invoiced on this order so far`}
        />
        <StatTile
          label="Mismatched lines"
          value={mismatchLines.length}
          tone={mismatchLines.length ? "danger" : "success"}
        />
        <StatTile
          label="Receipts linked"
          value={invoice.grnLinks.length}
          tone={invoice.grnLinks.length === 0 ? "danger" : "success"}
        />
      </div>

      {result && (
        <SectionCard
          title="Three-way match"
          description={`Purchase order against goods received against invoice. Tolerances in force: ${result.tolerances.qtyPercent}% on quantity, ${result.tolerances.pricePercent}% on price, ${money(result.tolerances.valueAbsolute)} absolute on value.`}
          bodyClassName="px-0 py-0"
        >
          <div className="flex flex-wrap gap-4 border-b border-separator px-4 py-3">
            <div>
              <span className="label block">Overall</span>
              <Badge tone={result.passed ? "success" : "danger"}>{result.passed ? "Passed" : "Failed"}</Badge>
            </div>
            <div>
              <span className="label block">Vendor matches order</span>
              <Badge tone={result.vendorMatches ? "success" : "danger"}>{result.vendorMatches ? "Yes" : "No"}</Badge>
            </div>
            <div>
              <span className="label block">Goods receipt present</span>
              <Badge tone={result.grnPresent ? "success" : "danger"}>{result.grnPresent ? "Yes" : "No"}</Badge>
            </div>
            <div>
              <span className="label block">Totals agree</span>
              <Badge tone={result.totalsMatch ? "success" : "danger"}>{result.totalsMatch ? "Yes" : "No"}</Badge>
            </div>
            <div>
              <span className="label block">Invoice total</span>
              <span className="tnum text-xs font-600">{money(result.invoiceTotal)}</span>
            </div>
            <div>
              <span className="label block">Computed from lines</span>
              <span className="tnum text-xs font-600">{money(result.computedTotal)}</span>
            </div>
            <div>
              <span className="label block">Variance</span>
              <span
                className={`tnum text-xs font-600 ${Math.abs(result.totalVariance) > 1 ? "text-[var(--c-danger)]" : ""}`}
              >
                {money(result.totalVariance)}
              </span>
            </div>
          </div>

          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: "3rem" }}>#</th>
                  <th style={{ minWidth: "16rem" }}>Line</th>
                  <th className="text-right">Invoiced qty</th>
                  <th className="text-right">Ordered qty</th>
                  <th className="text-right">Accepted qty</th>
                  <th className="text-right">Already invoiced</th>
                  <th className="text-right">Invoice price</th>
                  <th className="text-right">Order price</th>
                  <th>Flag</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {result.lines.map((l) => (
                  <tr key={l.lineNo} className={l.flag !== "OK" ? "bg-[var(--c-danger-soft)]/40" : undefined}>
                    <td className="num text-xs text-[var(--c-text-tertiary)]">{l.lineNo}</td>
                    <td className="text-xs">{l.description}</td>
                    <td className="num text-xs font-500">{qty(l.invoiceQty)}</td>
                    <td className="num text-xs">{l.poQty !== null ? qty(l.poQty) : "—"}</td>
                    <td className="num text-xs">{l.grnAcceptedQty !== null ? qty(l.grnAcceptedQty) : "—"}</td>
                    <td className="num text-xs">{qty(l.alreadyInvoicedQty)}</td>
                    <td className="num text-xs">{money(l.invoiceUnitPrice)}</td>
                    <td className="num text-xs">{l.poUnitPrice !== null ? money(l.poUnitPrice) : "—"}</td>
                    <td>
                      <Badge tone={FLAG_TONE[l.flag] ?? "neutral"}>{humanize(l.flag)}</Badge>
                    </td>
                    <td className="max-w-[22rem] text-2xs text-muted">{l.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(result.failures.length > 0 || result.warnings.length > 0) && (
            <div className="space-y-2.5 border-t border-separator px-4 py-3">
              {result.failures.length > 0 && (
                <div>
                  <span className="label mb-1 block text-[var(--c-danger)]">Failures</span>
                  <ul className="space-y-1 pl-5 text-xs leading-5">
                    {result.failures.map((f, i) => (
                      <li key={i} className="list-disc text-muted">
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {result.warnings.length > 0 && (
                <div>
                  <span className="label mb-1 block text-[var(--c-warning)]">Warnings</span>
                  <ul className="space-y-1 pl-5 text-xs leading-5">
                    {result.warnings.map((w, i) => (
                      <li key={i} className="list-disc text-muted">
                        {w}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </SectionCard>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-4">
          <SectionCard title="Invoice lines as submitted" bodyClassName="px-0 py-0">
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: "3rem" }}>#</th>
                    <th>Description</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">Unit price</th>
                    <th className="text-right">Tax %</th>
                    <th className="text-right">Tax</th>
                    <th className="text-right">Line total</th>
                    <th>Match</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.items.map((i) => (
                    <tr key={i.id}>
                      <td className="num text-xs text-[var(--c-text-tertiary)]">{i.lineNo}</td>
                      <td className="text-xs">{i.description}</td>
                      <td className="num text-xs">{qty(i.quantity, i.unit)}</td>
                      <td className="num text-xs">{money(i.unitPrice)}</td>
                      <td className="num text-xs">{i.taxRate}</td>
                      <td className="num text-xs">{money(i.taxAmount)}</td>
                      <td className="num text-xs font-500">{money(i.lineTotal)}</td>
                      <td>
                        <Badge tone={FLAG_TONE[i.matchFlag] ?? "neutral"}>{humanize(i.matchFlag)}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5} className="text-xs font-600">
                      Subtotal
                    </td>
                    <td className="num text-xs">{money(invoice.taxAmount)}</td>
                    <td className="num text-xs font-600">{money(invoice.subtotal)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </SectionCard>

          <SectionCard title="Goods receipts linked" bodyClassName="px-0 py-0">
            {invoice.grnLinks.length === 0 ? (
              <div className="px-4 py-4">
                <InlineAlert tone="danger">
                  No goods receipt is linked. Nothing on file shows the goods were received, so payment is refused
                  regardless of approvals.
                </InlineAlert>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>GRN</th>
                      <th>Store</th>
                      <th>Status</th>
                      <th className="text-right">Value</th>
                      <th>Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.grnLinks.map((l) => (
                      <tr key={l.id}>
                        <td>
                          <RefLink href={`/grn/${l.grn.id}`}>{l.grn.number}</RefLink>
                        </td>
                        <td className="text-xs">{l.grn.store.name}</td>
                        <td>
                          <StatusBadge status={l.grn.status} />
                        </td>
                        <td className="num text-xs">{money(l.grn.totalValue)}</td>
                        <td className="text-xs">{fmtDate(l.grn.receivedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          {trail.length > 0 && (
            <SectionCard title="Approval trail">
              <ApprovalTrailView trails={trail} />
            </SectionCard>
          )}

          {invoice.handoffs.length > 0 && (
            <SectionCard title="Finance handoffs" bodyClassName="px-0 py-0">
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Handoff</th>
                      <th>Status</th>
                      <th className="text-right">Amount</th>
                      <th>Method</th>
                      <th>Reference</th>
                      <th>Handed off</th>
                      <th>Scheduled</th>
                      <th>Paid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.handoffs.map((h) => (
                      <tr key={h.id}>
                        <td>
                          <RefLink href={`/finance/handoffs/${h.id}`}>{h.number}</RefLink>
                        </td>
                        <td>
                          <StatusBadge status={h.status} />
                        </td>
                        <td className="num text-xs">{money(h.amount)}</td>
                        <td className="text-2xs">{h.paymentMethod ? humanize(h.paymentMethod) : "—"}</td>
                        <td className="text-2xs">{h.paymentReference ?? "—"}</td>
                        <td className="text-xs">
                          {fmtDate(h.handedOffAt)}
                          <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                            {h.handedOffBy.name}
                          </span>
                        </td>
                        <td className="text-xs">{h.scheduledDate ? fmtDate(h.scheduledDate) : "—"}</td>
                        <td className="text-xs">{h.paidDate ? fmtDate(h.paidDate) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}
        </div>

        <div className="space-y-4">
          <SectionCard title="Invoice detail">
            <DefList
              columns={1}
              items={[
                { label: "Invoice number", value: <Mono>{invoice.number}</Mono> },
                { label: "Vendor reference", value: <Mono>{invoice.vendorInvoiceNumber}</Mono> },
                {
                  label: "Vendor",
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      <RefLink href={`/vendors/${invoice.vendor.id}`}>{invoice.vendor.name}</RefLink>
                      <StatusBadge status={invoice.vendor.status} />
                    </span>
                  ),
                },
                { label: "Payment terms", value: invoice.vendor.paymentTerms ?? "—" },
                { label: "Purchase order", value: <RefLink href={`/po/${invoice.po.id}`}>{invoice.po.number}</RefLink> },
                {
                  label: "Case",
                  value: invoice.po.pr ? <RefLink href={`/pr/${invoice.po.pr.id}`}>{invoice.po.pr.number}</RefLink> : "—",
                },
                { label: "Entity", value: invoice.po.entity.name },
                { label: "Invoice date", value: fmtDate(invoice.invoiceDate) },
                { label: "Received", value: fmtDate(invoice.receivedDate) },
                { label: "Due date", value: invoice.dueDate ? fmtDate(invoice.dueDate) : "—" },
                {
                  label: "Verified by",
                  value: invoice.verifiedBy
                    ? `${invoice.verifiedBy.name}${invoice.verifiedAt ? ` · ${fmtDateTime(invoice.verifiedAt)}` : ""}`
                    : "Not verified",
                },
                { label: "Match notes", value: invoice.matchNotes ?? "—" },
              ]}
            />
          </SectionCard>

          <SectionCard title="Amounts">
            <div className="space-y-2 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">Subtotal</span>
                <span className="tnum">{money(invoice.subtotal)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">Tax</span>
                <span className="tnum">{money(invoice.taxAmount)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">Delivery charges</span>
                <span className="tnum">{money(invoice.deliveryCharges)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">Other charges</span>
                <span className="tnum">{money(invoice.otherCharges)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">Discount</span>
                <span className="tnum">−{money(invoice.discount)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-separator pt-2">
                <span className="text-muted">Invoice total</span>
                <span className="tnum font-600">{money(invoice.total)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">Withholding tax</span>
                <span className="tnum">−{money(invoice.withholdingTax)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-separator pt-2">
                <span className="text-muted">Net payable</span>
                <span className="tnum text-[0.9375rem] font-600">{money(invoice.netPayable)}</span>
              </div>
              {invoice.po.total > 0 && (
                <p className="pt-1 text-2xs text-[var(--c-text-tertiary)]">
                  {percent(round2((invoice.total / invoice.po.total) * 100), 1)} of the order value.
                </p>
              )}
            </div>
          </SectionCard>

          <ExceptionsPanel where={{ invoiceId: invoice.id }} title="Exceptions on this invoice" />

          <SectionCard title="Activity">
            <Timeline events={events} emptyLabel="No activity recorded yet." />
          </SectionCard>
        </div>
      </div>

      <PaymentPackPanel
        user={user}
        documentType="INVOICE"
        documentId={invoice.id}
        entityId={invoice.po.entityId}
        transactionType={invoice.po.procurementKind}
      />

      <DocumentsPanel
        user={user}
        linkedType="INVOICE"
        linkedId={invoice.id}
        entityId={invoice.po.entityId}
        title="Invoice documents"
        description="The vendor invoice, tax documents and anything supporting a waiver."
        defaultCategory="Invoice"
      />
    </div>
  );
}
