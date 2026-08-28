import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import {
  Badge,
  EmptyState,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { ColumnChart } from "@/components/ui/charts";
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, money, round2 } from "@/lib/format";
import { statusLink } from "@/lib/links";

export const metadata = { title: "Finance handoffs" };
export const dynamic = "force-dynamic";

export default async function HandoffsPage() {
  const { user, authorized } = await pageContext(P.INVOICE_VIEW, P.FINANCE_HANDOFF, P.FINANCE_ACK);
  if (!authorized) {
    return <AccessDenied title="Finance handoffs" message="You do not have permission to view finance handoffs." />;
  }

  const scoped = visibleEntityIds(user);
  const [handoffs, savedViews] = await Promise.all([
    prisma.paymentHandoff.findMany({
      where: scoped ? { invoice: { po: { entityId: { in: scoped } } } } : {},
      orderBy: { handedOffAt: "desc" },
      take: 500,
      include: {
        handedOffBy: { select: { name: true } },
        invoice: {
          select: {
            id: true,
            number: true,
            vendorInvoiceNumber: true,
            total: true,
            netPayable: true,
            dueDate: true,
            matchStatus: true,
            vendor: { select: { id: true, name: true } },
            po: { select: { id: true, number: true, entity: { select: { code: true } } } },
          },
        },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "finance-handoffs", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const ackIds = [...new Set(handoffs.map((h) => h.financeAckById).filter((x): x is string => !!x))];
  const ackUsers = ackIds.length
    ? await prisma.user.findMany({ where: { id: { in: ackIds } }, select: { id: true, name: true } })
    : [];
  const ackName = new Map(ackUsers.map((u) => [u.id, u.name]));

  const pending = handoffs.filter((h) => h.status === "PENDING");
  const scheduled = handoffs.filter((h) => ["ACKNOWLEDGED", "SCHEDULED"].includes(h.status));
  const paid = handoffs.filter((h) => h.status === "PAID");
  const outstandingValue = round2(
    handoffs.filter((h) => h.status !== "PAID" && h.status !== "REJECTED").reduce((a, h) => a + h.amount, 0),
  );

  const ageBuckets = [
    { label: "0–3 days", min: 0, max: 4 },
    { label: "4–7 days", min: 4, max: 8 },
    { label: "8–14 days", min: 8, max: 15 },
    { label: "15+ days", min: 15, max: 100000 },
  ].map((b) => ({
    label: b.label,
    values: [
      handoffs.filter((h) => {
        if (h.status === "PAID" || h.status === "REJECTED") return false;
        const d = ageDays(h.handedOffAt) ?? 0;
        return d >= b.min && d < b.max;
      }).length,
    ],
  }));

  const columns: TableColumn[] = [
    { key: "number", header: "Handoff", locked: true, sortable: true, width: "10rem" },
    { key: "invoice", header: "Invoice", sortable: true, width: "11rem" },
    { key: "vendorRef", header: "Vendor reference", sortable: true, width: "12rem", defaultHidden: true },
    { key: "vendor", header: "Vendor", sortable: true, minWidth: "14rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "po", header: "Purchase order", sortable: true, width: "11rem" },
    { key: "amount", header: "Amount", numeric: true, sortable: true, width: "11rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "11rem" },
    { key: "method", header: "Method", filterable: true, sortable: true, width: "11rem" },
    { key: "reference", header: "Payment reference", sortable: true, width: "13rem" },
    { key: "handedOff", header: "Handed off", sortable: true, width: "9.5rem" },
    { key: "handedOffBy", header: "By", sortable: true, width: "12rem" },
    { key: "acknowledged", header: "Acknowledged", sortable: true, width: "12rem" },
    { key: "scheduled", header: "Scheduled", sortable: true, width: "9.5rem" },
    { key: "paid", header: "Paid", sortable: true, width: "9.5rem" },
    { key: "waiting", header: "Days waiting", numeric: true, sortable: true, width: "9rem" },
  ];

  const rows: TableRow[] = handoffs.map((h) => {
    const open = !["PAID", "REJECTED"].includes(h.status);
    const waiting = open ? (ageDays(h.handedOffAt) ?? 0) : 0;
    return {
      id: h.id,
      href: `/finance/handoffs/${h.id}`,
      flag: h.status === "REJECTED" ? "danger" : waiting > 14 ? "warning" : h.status === "PAID" ? "success" : null,
      search: `${h.number} ${h.invoice.number} ${h.invoice.vendorInvoiceNumber} ${h.invoice.vendor.name} ${h.paymentReference ?? ""}`,
      values: {
        number: h.number,
        invoice: h.invoice.number,
        vendorRef: h.invoice.vendorInvoiceNumber,
        vendor: h.invoice.vendor.name,
        entity: h.invoice.po.entity.code,
        po: h.invoice.po.number,
        amount: h.amount,
        status: humanize(h.status),
        method: h.paymentMethod ? humanize(h.paymentMethod) : "",
        reference: h.paymentReference ?? "",
        handedOff: h.handedOffAt.toISOString(),
        handedOffBy: h.handedOffBy.name,
        acknowledged: h.financeAckAt ? h.financeAckAt.toISOString() : "",
        scheduled: h.scheduledDate ? h.scheduledDate.toISOString() : "",
        paid: h.paidDate ? h.paidDate.toISOString() : "",
        waiting,
      },
      cells: {
        number: <RefLink href={`/finance/handoffs/${h.id}`}>{h.number}</RefLink>,
        invoice: (
          <span>
            <RefLink href={`/invoices/${h.invoice.id}`}>{h.invoice.number}</RefLink>
            {h.invoice.matchStatus === "OVERRIDDEN" && (
              <span className="mt-0.5 block">
                <Badge tone="warning">Waived mismatch</Badge>
              </span>
            )}
          </span>
        ),
        vendorRef: <Mono>{h.invoice.vendorInvoiceNumber}</Mono>,
        vendor: <RefLink href={`/vendors/${h.invoice.vendor.id}`}>{h.invoice.vendor.name}</RefLink>,
        entity: <Badge tone="neutral">{h.invoice.po.entity.code}</Badge>,
        po: <RefLink href={`/po/${h.invoice.po.id}`}>{h.invoice.po.number}</RefLink>,
        amount: <Mono>{money(h.amount)}</Mono>,
        status: <StatusBadge status={h.status} />,
        method: h.paymentMethod ? humanize(h.paymentMethod) : "—",
        reference: h.paymentReference ? <Mono>{h.paymentReference}</Mono> : "—",
        handedOff: fmtDate(h.handedOffAt),
        handedOffBy: h.handedOffBy.name,
        acknowledged: h.financeAckAt ? (
          <span>
            {fmtDate(h.financeAckAt)}
            <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
              {h.financeAckById ? (ackName.get(h.financeAckById) ?? "") : ""}
            </span>
          </span>
        ) : (
          <Badge tone="warning">Awaiting</Badge>
        ),
        scheduled: h.scheduledDate ? fmtDate(h.scheduledDate) : "—",
        paid: h.paidDate ? fmtDate(h.paidDate) : "—",
        waiting: open ? waiting : "—",
      },
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Finance", href: "/invoices" }, { label: "Handoffs" }]} />

      <PageHeader
        eyebrow="Finance"
        title="Payment handoffs"
        subtitle="The formal transfer of an approved invoice to finance, with the receipt and match evidence attached. Procurement's side ends here; the payment record continues."
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Handoffs raised" value={handoffs.length} href="/finance/handoffs" />
        <StatTile
          label="Awaiting finance acknowledgement"
          value={pending.length}
          tone={pending.length ? "warning" : "success"}
          href={statusLink("/finance/handoffs", "status", ["PENDING"])}
        />
        <StatTile
          label="Acknowledged or scheduled"
          value={scheduled.length}
          tone="accent"
          href={statusLink("/finance/handoffs", "status", ["ACKNOWLEDGED", "SCHEDULED"])}
        />
        <StatTile
          label="Outstanding value"
          value={money(outstandingValue)}
          hint={`${paid.length} paid to date`}
          href={statusLink("/finance/handoffs", "status", ["PENDING", "ACKNOWLEDGED", "SCHEDULED"])}
        />
      </div>

      {handoffs.some((h) => !["PAID", "REJECTED"].includes(h.status)) && (
        <SectionCard
          title="How long handoffs are sitting with finance"
          description="Age of open handoffs since procurement handed them over."
        >
          <ColumnChart data={ageBuckets} series={[{ key: "count", label: "Open handoffs", colorIndex: 2 }]} format="number" height={180} />
        </SectionCard>
      )}

      <DataTable
        id="finance-handoffs"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "handedOff", dir: "desc" }}
        exportName="finance-handoffs"
        emptyState={
          <EmptyState
            title="No handoffs raised"
            description="An approved invoice with a posted goods receipt and a clean or formally waived match can be handed to finance."
          />
        }
      />
    </div>
  );
}
