import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { runThreeWayMatch } from "@/server/invoice";
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
import { LifecycleRail, Timeline, buildRail } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, fmtDateTime, money, qty } from "@/lib/format";
import { AcknowledgeForm, RecordPaymentForm } from "./FinanceForms";

export const dynamic = "force-dynamic";

const HANDOFF_LIFECYCLE = ["PENDING", "ACKNOWLEDGED", "SCHEDULED", "PAID"] as const;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const h = await prisma.paymentHandoff.findUnique({ where: { id }, select: { number: true } });
  return { title: h ? `${h.number} — Payment handoff` : "Payment handoff" };
}

export default async function HandoffDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.INVOICE_VIEW, P.FINANCE_HANDOFF, P.FINANCE_ACK);
  if (!authorized) return <AccessDenied title="Payment handoff" />;

  const handoff = await prisma.paymentHandoff.findUnique({
    where: { id },
    include: {
      handedOffBy: { select: { name: true, title: true } },
      invoice: {
        include: {
          vendor: {
            select: {
              id: true,
              code: true,
              name: true,
              status: true,
              paymentTerms: true,
              bankName: true,
              bankAccountNumber: true,
              bankAccountTitle: true,
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
          po: {
            select: {
              id: true,
              number: true,
              total: true,
              entityId: true,
              entity: { select: { code: true, name: true } },
              pr: { select: { id: true, number: true, title: true } },
            },
          },
        },
      },
    },
  });
  if (!handoff) notFound();

  const [events, match, ackUser, blockingExceptions] = await Promise.all([
    documentTimeline("PaymentHandoff", handoff.id),
    runThreeWayMatch(handoff.invoiceId).catch(() => null),
    handoff.financeAckById
      ? prisma.user.findUnique({ where: { id: handoff.financeAckById }, select: { name: true, title: true } })
      : Promise.resolve(null),
    prisma.exception.count({
      where: { invoiceId: handoff.invoiceId, status: { in: ["OPEN", "IN_PROGRESS"] }, blocking: true },
    }),
  ]);

  const canAck = userHasPermission(user, P.FINANCE_ACK);
  const canPay = userHasPermission(user, P.PAYMENT_RECORD);
  const canSeeBank = userHasPermission(user, P.VENDOR_FINANCIALS_VIEW);

  const invoice = handoff.invoice;
  const blockers: string[] = [];
  if (invoice.matchStatus === "FAILED") {
    blockers.push("The invoice fails the three-way match and has not been formally waived.");
  }
  if (invoice.grnLinks.length === 0) {
    blockers.push("No goods receipt is linked to the invoice.");
  }
  if (blockingExceptions > 0) {
    blockers.push(`${blockingExceptions} blocking exception${blockingExceptions === 1 ? "" : "s"} open on the invoice.`);
  }
  if (invoice.vendor.status === "BLACKLISTED") {
    blockers.push(`${invoice.vendor.name} is blacklisted.`);
  }

  const rail = buildRail(
    HANDOFF_LIFECYCLE,
    handoff.status === "REJECTED" ? "PENDING" : handoff.status,
    {
      PENDING: { at: handoff.handedOffAt, owner: handoff.handedOffBy.name },
      ACKNOWLEDGED: { at: handoff.financeAckAt, owner: ackUser?.name ?? null },
      SCHEDULED: { at: handoff.scheduledDate, owner: ackUser?.name ?? null },
      PAID: { at: handoff.paidDate, owner: null },
    },
    { terminalBad: handoff.status === "REJECTED", blockedNote: blockers[0] ?? null },
  );

  const waiting = handoff.status === "PAID" ? null : (ageDays(handoff.handedOffAt) ?? 0);

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Finance", href: "/invoices" },
          { label: "Handoffs", href: "/finance/handoffs" },
          { label: handoff.number },
        ]}
      />

      <PageHeader
        eyebrow={`${invoice.po.entity.code} · ${invoice.vendor.name}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{handoff.number}</span>
            <span>{money(handoff.amount)} payable</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={handoff.status} />
            </MetaItem>
            <MetaItem label="Invoice">
              <RefLink href={`/invoices/${invoice.id}`}>{invoice.number}</RefLink>
            </MetaItem>
            <MetaItem label="Match">
              <Badge
                tone={
                  invoice.matchStatus === "PASSED"
                    ? "success"
                    : invoice.matchStatus === "OVERRIDDEN"
                      ? "warning"
                      : invoice.matchStatus === "FAILED"
                        ? "danger"
                        : "neutral"
                }
              >
                {humanize(invoice.matchStatus)}
              </Badge>
            </MetaItem>
            <MetaItem label="Handed off">{fmtDate(handoff.handedOffAt)}</MetaItem>
            {waiting !== null && <MetaItem label="Waiting">{waiting} days</MetaItem>}
          </>
        }
        actions={
          <>
            {canAck && handoff.status === "PENDING" && (
              <AcknowledgeForm
                handoffId={handoff.id}
                number={handoff.number}
                amount={handoff.amount}
                vendorName={invoice.vendor.name}
                suggestedAccount={canSeeBank ? invoice.vendor.bankAccountNumber : null}
              />
            )}
            {canPay && ["PENDING", "ACKNOWLEDGED", "SCHEDULED"].includes(handoff.status) && (
              <RecordPaymentForm
                handoffId={handoff.id}
                number={handoff.number}
                amount={handoff.amount}
                vendorName={invoice.vendor.name}
                defaultMethod={handoff.paymentMethod}
                blockers={blockers}
              />
            )}
            <Link href={`/invoices/${invoice.id}`} className="btn btn-secondary btn-sm">
              Invoice
            </Link>
            <Link href={`/po/${invoice.po.id}`} className="btn btn-secondary btn-sm">
              {invoice.po.number}
            </Link>
          </>
        }
      />

      {blockers.length > 0 && (
        <BlockedNotice
          tone="danger"
          title="Payment cannot be released"
          reasons={[...blockers, "These checks run again on the server when a payment is recorded."]}
        />
      )}

      {handoff.status === "PAID" && (
        <InlineAlert tone="success">
          Paid{handoff.paidDate ? ` on ${fmtDate(handoff.paidDate)}` : ""}
          {handoff.paymentReference ? ` · reference ${handoff.paymentReference}` : ""}
          {handoff.paymentMethod ? ` · ${humanize(handoff.paymentMethod).toLowerCase()}` : ""}.
        </InlineAlert>
      )}

      {handoff.status === "PENDING" && waiting !== null && waiting > 7 && (
        <InlineAlert tone="warning">
          This handoff has been with finance for {waiting} days without acknowledgement. Vendors judge us on payment
          timeliness — chase it.
        </InlineAlert>
      )}

      <LifecycleRail steps={rail} title="Handoff lifecycle" />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Amount payable" value={money(handoff.amount)} />
        <StatTile label="Invoice total" value={money(invoice.total)} hint={`Order ${money(invoice.po.total)}`} />
        <StatTile
          label="Receipts backing this"
          value={invoice.grnLinks.length}
          tone={invoice.grnLinks.length === 0 ? "danger" : "success"}
        />
        <StatTile
          label="Mismatched lines"
          value={invoice.items.filter((i) => i.matchFlag !== "OK").length}
          tone={invoice.items.some((i) => i.matchFlag !== "OK") ? "danger" : "success"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-4">
          <SectionCard
            title="What finance is being asked to pay"
            description="The invoice as verified, with the match outcome that authorised the handoff."
            bodyClassName="px-0 py-0"
          >
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: "3rem" }}>#</th>
                    <th>Description</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">Unit price</th>
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
                      <td className="num text-xs font-500">{money(i.lineTotal)}</td>
                      <td>
                        <Badge tone={i.matchFlag === "OK" ? "success" : "danger"}>{humanize(i.matchFlag)}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} className="text-xs font-600">
                      Net payable
                    </td>
                    <td className="num text-xs font-600">{money(invoice.netPayable)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </SectionCard>

          <SectionCard title="Goods receipts backing the payment" bodyClassName="px-0 py-0">
            {invoice.grnLinks.length === 0 ? (
              <div className="px-4 py-4">
                <InlineAlert tone="danger">
                  No goods receipt is linked. This handoff should not have been raised, and payment will be refused.
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

          {match && !match.passed && (
            <SectionCard title="Outstanding match issues" description="Recorded at the time of the last match run.">
              <ul className="space-y-1 pl-5 text-xs leading-5">
                {match.failures.map((f, i) => (
                  <li key={i} className="list-disc text-muted">
                    {f}
                  </li>
                ))}
              </ul>
              {invoice.matchStatus === "OVERRIDDEN" && invoice.exceptionReason && (
                <div className="mt-3 border-t border-separator pt-2.5">
                  <span className="label mb-1 block">Waiver on record</span>
                  <p className="text-xs leading-5 text-muted">{invoice.exceptionReason}</p>
                </div>
              )}
            </SectionCard>
          )}
        </div>

        <div className="space-y-4">
          <SectionCard title="Handoff detail">
            <DefList
              columns={1}
              items={[
                { label: "Handoff number", value: <Mono>{handoff.number}</Mono> },
                { label: "Amount", value: money(handoff.amount) },
                { label: "Currency", value: handoff.currency },
                { label: "Status", value: <StatusBadge status={handoff.status} /> },
                {
                  label: "Handed off by",
                  value: `${handoff.handedOffBy.name}${handoff.handedOffBy.title ? ` — ${handoff.handedOffBy.title}` : ""}`,
                },
                { label: "Handed off at", value: fmtDateTime(handoff.handedOffAt) },
                {
                  label: "Acknowledged by",
                  value: ackUser ? `${ackUser.name}${ackUser.title ? ` — ${ackUser.title}` : ""}` : "Not acknowledged",
                },
                { label: "Acknowledged at", value: handoff.financeAckAt ? fmtDateTime(handoff.financeAckAt) : "—" },
                { label: "Payment method", value: handoff.paymentMethod ? humanize(handoff.paymentMethod) : "—" },
                { label: "Scheduled date", value: handoff.scheduledDate ? fmtDate(handoff.scheduledDate) : "—" },
                { label: "Paid date", value: handoff.paidDate ? fmtDate(handoff.paidDate) : "Not paid" },
                {
                  label: "Payment reference",
                  value: handoff.paymentReference ? <Mono>{handoff.paymentReference}</Mono> : "—",
                },
                { label: "Notes", value: handoff.notes ?? "—", span: true },
              ]}
            />
          </SectionCard>

          <SectionCard title="Payee">
            <DefList
              columns={1}
              items={[
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
                ...(canSeeBank
                  ? [
                      { label: "Bank", value: invoice.vendor.bankName ?? "—" },
                      { label: "Account title", value: invoice.vendor.bankAccountTitle ?? "—" },
                      {
                        label: "Account number",
                        value: invoice.vendor.bankAccountNumber ? (
                          <Mono>{invoice.vendor.bankAccountNumber}</Mono>
                        ) : (
                          "—"
                        ),
                      },
                    ]
                  : [
                      {
                        label: "Banking details",
                        value: "Withheld — requires the vendor financials permission.",
                      },
                    ]),
                { label: "Invoice", value: <RefLink href={`/invoices/${invoice.id}`}>{invoice.number}</RefLink> },
                { label: "Vendor reference", value: <Mono>{invoice.vendorInvoiceNumber}</Mono> },
                { label: "Purchase order", value: <RefLink href={`/po/${invoice.po.id}`}>{invoice.po.number}</RefLink> },
                {
                  label: "Case",
                  value: invoice.po.pr ? <RefLink href={`/pr/${invoice.po.pr.id}`}>{invoice.po.pr.number}</RefLink> : "—",
                },
              ]}
            />
          </SectionCard>

          <SectionCard title="Activity">
            <Timeline events={events} emptyLabel="No activity recorded yet." />
          </SectionCard>
        </div>
      </div>

      <DocumentsPanel
        user={user}
        linkedType="INVOICE"
        linkedId={invoice.id}
        entityId={invoice.po.entityId}
        title="Payment pack"
        description="Invoice, GRN, purchase order and any waiver — the file finance needs to release money."
        defaultCategory="Invoice"
      />
    </div>
  );
}
