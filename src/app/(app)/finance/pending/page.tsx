import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  EmptyState,
  InlineAlert,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { ColumnChart, RankedBars } from "@/components/ui/charts";
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, money, round2 } from "@/lib/format";
import { statusLink, tableLink } from "@/lib/links";

export const metadata = { title: "Pending payments" };
export const dynamic = "force-dynamic";

/**
 * The finance queue: what is genuinely payable, what is stuck, and why. The
 * blocked section is the point of the page — it names the control that is
 * holding each payment rather than letting it disappear into an ageing report.
 */
export default async function PendingPaymentsPage() {
  const { user, authorized } = await pageContext(P.INVOICE_VIEW, P.FINANCE_ACK, P.PAYMENT_RECORD);
  if (!authorized) {
    return <AccessDenied title="Pending payments" message="You do not have permission to view the payment queue." />;
  }

  const scoped = visibleEntityIds(user);
  const poFilter = scoped ? { po: { entityId: { in: scoped } } } : {};

  const [openInvoices, openHandoffs] = await Promise.all([
    prisma.invoice.findMany({
      where: { status: { notIn: ["PAID", "REJECTED"] }, ...poFilter },
      orderBy: [{ dueDate: "asc" }, { invoiceDate: "asc" }],
      include: {
        vendor: { select: { id: true, name: true, status: true, paymentTerms: true } },
        po: { select: { id: true, number: true, entity: { select: { code: true } } } },
        items: { select: { id: true, matchFlag: true } },
        grnLinks: { select: { grnId: true } },
        handoffs: { select: { id: true, number: true, status: true } },
        exceptions: {
          where: { status: { in: ["OPEN", "IN_PROGRESS"] }, blocking: true },
          select: { id: true, title: true, type: true },
        },
      },
    }),
    prisma.paymentHandoff.findMany({
      where: { status: { in: ["PENDING", "ACKNOWLEDGED", "SCHEDULED"] }, invoice: poFilter },
      orderBy: { handedOffAt: "asc" },
      include: {
        invoice: {
          select: {
            id: true,
            number: true,
            dueDate: true,
            matchStatus: true,
            vendor: { select: { id: true, name: true } },
            po: { select: { id: true, number: true, entity: { select: { code: true } } } },
          },
        },
      },
    }),
  ]);

  const canPay = userHasPermission(user, P.PAYMENT_RECORD);

  type Blocked = { invoice: (typeof openInvoices)[number]; reasons: string[] };
  const blocked: Blocked[] = [];
  const payable: typeof openInvoices = [];
  const awaitingApproval: typeof openInvoices = [];

  for (const i of openInvoices) {
    const reasons: string[] = [];
    if (i.matchStatus === "FAILED") reasons.push("Three-way match failed and has not been waived");
    if (i.grnLinks.length === 0) reasons.push("No goods receipt linked");
    for (const e of i.exceptions) reasons.push(`Blocking exception: ${e.title}`);
    if (i.vendor.status === "BLACKLISTED") reasons.push("Vendor is blacklisted");

    if (reasons.length > 0) blocked.push({ invoice: i, reasons });
    else if (["APPROVED", "SENT_TO_FINANCE"].includes(i.status)) payable.push(i);
    else awaitingApproval.push(i);
  }

  const payableValue = round2(payable.reduce((a, i) => a + i.netPayable, 0));
  const blockedValue = round2(blocked.reduce((a, b) => a + b.invoice.netPayable, 0));
  const overdue = openInvoices.filter((i) => i.dueDate && i.dueDate.getTime() < Date.now());

  const ageBuckets = [
    { label: "Not yet due", test: (i: (typeof openInvoices)[number]) => !i.dueDate || i.dueDate.getTime() >= Date.now() },
    {
      label: "1–15 days late",
      test: (i: (typeof openInvoices)[number]) => {
        const d = i.dueDate ? -(ageDays(i.dueDate) ?? 0) : 0;
        return !!i.dueDate && d < 0 && -d <= 15;
      },
    },
    {
      label: "16–30 days late",
      test: (i: (typeof openInvoices)[number]) => {
        const d = i.dueDate ? (ageDays(i.dueDate) ?? 0) : 0;
        return !!i.dueDate && d > 15 && d <= 30;
      },
    },
    {
      label: "30+ days late",
      test: (i: (typeof openInvoices)[number]) => {
        const d = i.dueDate ? (ageDays(i.dueDate) ?? 0) : 0;
        return !!i.dueDate && d > 30;
      },
    },
  ].map((b) => ({ label: b.label, values: [openInvoices.filter(b.test).length] }));

  const byVendor = new Map<string, { value: number; id: string }>();
  for (const i of openInvoices) {
    const cur = byVendor.get(i.vendor.name) ?? { value: 0, id: i.vendor.id };
    cur.value = round2(cur.value + i.netPayable);
    byVendor.set(i.vendor.name, cur);
  }

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Finance", href: "/invoices" }, { label: "Pending payments" }]} />

      <PageHeader
        eyebrow="Finance"
        title="Pending payments"
        subtitle="What is payable, what is waiting on an approval, and what is genuinely blocked — with the control that is holding it named."
        actions={
          <Link href="/finance/handoffs" className="btn btn-secondary btn-sm">
            All handoffs
          </Link>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Clear to pay"
          value={money(payableValue)}
          tone="success"
          hint={`${payable.length} invoice(s)`}
          href={statusLink("/invoices", "status", ["APPROVED", "SENT_TO_FINANCE"])}
        />
        <StatTile
          label="Blocked"
          value={money(blockedValue)}
          tone={blocked.length ? "danger" : "default"}
          hint={`${blocked.length} invoice(s)`}
          href={statusLink("/invoices", "matchStatus", ["FAILED"])}
        />
        <StatTile
          label="Awaiting approval"
          value={awaitingApproval.length}
          href={statusLink("/invoices", "status", ["RECEIVED", "UNDER_VERIFICATION", "MATCHED", "PENDING_APPROVAL"])}
        />
        <StatTile
          label="Past due"
          value={overdue.length}
          tone={overdue.length ? "warning" : "default"}
          href={tableLink("/invoices", { dueState: "Past due" })}
        />
      </div>

      {blocked.length > 0 && (
        <SectionCard
          title="Blocked payments"
          description="Each of these is held by a specific control. Clearing them means fixing the underlying problem or recording a reasoned waiver — not overriding the check."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Vendor</th>
                  <th>Purchase order</th>
                  <th className="text-right">Net payable</th>
                  <th>Status</th>
                  <th>Why it is blocked</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {blocked.map(({ invoice: i, reasons }) => (
                  <tr key={i.id} className="bg-[var(--c-danger-soft)]/25">
                    <td>
                      <RefLink href={`/invoices/${i.id}`}>{i.number}</RefLink>
                      <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        {i.vendorInvoiceNumber}
                      </span>
                    </td>
                    <td className="text-xs">
                      <RefLink href={`/vendors/${i.vendor.id}`}>{i.vendor.name}</RefLink>
                    </td>
                    <td>
                      <RefLink href={`/po/${i.po.id}`}>{i.po.number}</RefLink>
                    </td>
                    <td className="num text-xs font-600">{money(i.netPayable)}</td>
                    <td>
                      <StatusBadge status={i.status} />
                    </td>
                    <td className="text-2xs">
                      <ul className="space-y-0.5">
                        {reasons.map((r, idx) => (
                          <li key={idx} className="text-[var(--c-danger)]">
                            {r}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      <Link href={`/invoices/${i.id}`} className="btn btn-primary btn-xs">
                        Resolve
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <SectionCard
        title="Clear to pay"
        description="Approved, matched and backed by a goods receipt."
        bodyClassName="px-0 py-0"
      >
        {payable.length === 0 ? (
          <EmptyState
            title="Nothing is clear to pay"
            description="Invoices appear here once they are approved, matched and supported by a posted goods receipt."
          />
        ) : (
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Entity</th>
                  <th>Vendor</th>
                  <th>Purchase order</th>
                  <th className="text-right">Net payable</th>
                  <th>Terms</th>
                  <th>Due</th>
                  <th>Match</th>
                  <th>Handoff</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {payable.map((i) => {
                  const handoff = i.handoffs[i.handoffs.length - 1];
                  const late = i.dueDate && i.dueDate.getTime() < Date.now();
                  return (
                    <tr key={i.id}>
                      <td>
                        <RefLink href={`/invoices/${i.id}`}>{i.number}</RefLink>
                      </td>
                      <td>
                        <Badge tone="neutral">{i.po.entity.code}</Badge>
                      </td>
                      <td className="text-xs">
                        <RefLink href={`/vendors/${i.vendor.id}`}>{i.vendor.name}</RefLink>
                      </td>
                      <td>
                        <RefLink href={`/po/${i.po.id}`}>{i.po.number}</RefLink>
                      </td>
                      <td className="num text-xs font-600">{money(i.netPayable)}</td>
                      <td className="text-2xs">{i.vendor.paymentTerms ?? "—"}</td>
                      <td className="text-xs">
                        {i.dueDate ? (
                          <span className={late ? "text-[var(--c-danger)] font-600" : undefined}>
                            {fmtDate(i.dueDate)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <Badge tone={i.matchStatus === "PASSED" ? "success" : "warning"}>
                          {humanize(i.matchStatus)}
                        </Badge>
                      </td>
                      <td className="text-2xs">
                        {handoff ? (
                          <RefLink href={`/finance/handoffs/${handoff.id}`}>{handoff.number}</RefLink>
                        ) : (
                          <Badge tone="warning">Not handed off</Badge>
                        )}
                      </td>
                      <td>
                        {handoff && canPay ? (
                          <Link href={`/finance/handoffs/${handoff.id}`} className="btn btn-primary btn-xs">
                            Pay
                          </Link>
                        ) : (
                          <Link href={`/invoices/${i.id}`} className="btn btn-secondary btn-xs">
                            Open
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {openHandoffs.length > 0 && (
        <SectionCard
          title="Handoffs in progress"
          description="Already with finance, awaiting acknowledgement, scheduling or the payment record."
          bodyClassName="px-0 py-0"
        >
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
                  <th>Scheduled</th>
                  <th className="text-right">Days waiting</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {openHandoffs.map((h) => {
                  const waiting = ageDays(h.handedOffAt) ?? 0;
                  return (
                    <tr key={h.id}>
                      <td>
                        <RefLink href={`/finance/handoffs/${h.id}`}>{h.number}</RefLink>
                      </td>
                      <td>
                        <RefLink href={`/invoices/${h.invoice.id}`}>{h.invoice.number}</RefLink>
                      </td>
                      <td className="text-xs">{h.invoice.vendor.name}</td>
                      <td className="num text-xs">{money(h.amount)}</td>
                      <td>
                        <StatusBadge status={h.status} />
                      </td>
                      <td className="text-2xs">{h.paymentMethod ? humanize(h.paymentMethod) : "—"}</td>
                      <td className="text-xs">{h.scheduledDate ? fmtDate(h.scheduledDate) : "—"}</td>
                      <td className="num text-xs">
                        <span className={waiting > 14 ? "text-[var(--c-danger)] font-600" : undefined}>{waiting}</span>
                      </td>
                      <td>
                        <Link href={`/finance/handoffs/${h.id}`} className="btn btn-secondary btn-xs">
                          Open
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Payment ageing" description="Open invoices against their due date.">
          <ColumnChart data={ageBuckets} series={[{ key: "count", label: "Open invoices", colorIndex: 2 }]} format="number" height={190} />
        </SectionCard>
        <SectionCard title="Outstanding by vendor" description="Where the unpaid value sits.">
          <RankedBars
            data={[...byVendor.entries()]
              .map(([label, v]) => ({ label, value: v.value, href: `/vendors/${v.id}` }))
              .sort((a, b) => b.value - a.value)}
            format="moneyCompact"
            maxRows={8}
          />
        </SectionCard>
      </div>

      {awaitingApproval.length > 0 && (
        <InlineAlert tone="info">
          {awaitingApproval.length} invoice{awaitingApproval.length === 1 ? "" : "s"} are matched but still inside the
          approval chain. They are not blocked — they simply have not been approved yet.
        </InlineAlert>
      )}
    </div>
  );
}
