import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, InlineAlert, PageHeader, RefLink, StatTile, StatusBadge } from "@/components/ui/primitives";
import { voucherStats } from "@/server/vouchers";
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, money } from "@/lib/format";

export const metadata = { title: "Payment Vouchers" };
export const dynamic = "force-dynamic";

/**
 * The voucher register.
 *
 * A voucher exists between an approved invoice and money leaving the building,
 * so this screen is read by people who want to know what is about to be paid and
 * what is stuck waiting for a signature.
 */
export default async function VouchersPage() {
  const { user, ctx, authorized } = await pageContext(P.VOUCHER_VIEW);
  if (!authorized) {
    return <AccessDenied title="Payment vouchers" message="You do not have permission to view payment vouchers." />;
  }

  const where = ctx.entityFilter;
  const [vouchers, stats] = await Promise.all([
    prisma.voucher.findMany({
      where,
      orderBy: [{ preparedAt: "desc" }],
      take: 400,
      include: {
        entity: { select: { code: true } },
        invoice: {
          select: {
            id: true,
            number: true,
            vendorInvoiceNumber: true,
            vendor: { select: { id: true, name: true } },
            po: { select: { id: true, number: true } },
          },
        },
        preparedBy: { select: { name: true } },
        signatures: { orderBy: { sequence: "asc" }, select: { sequence: true, roleCode: true, status: true } },
      },
    }),
    voucherStats(where),
  ]);

  const mine = vouchers.filter((v) => {
    if (v.status !== "PENDING_SIGNATORIES") return false;
    const step = v.signatures.find((s) => s.status === "PENDING");
    return step ? user.roleCodes.includes(step.roleCode) : false;
  });

  const columns: TableColumn[] = [
    { key: "number", header: "Voucher", locked: true, sortable: true, width: "11rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "vendor", header: "Vendor", filterable: true, sortable: true, width: "16rem" },
    { key: "invoice", header: "Invoice", sortable: true, width: "12rem" },
    { key: "order", header: "Order", sortable: true, width: "11rem" },
    { key: "net", header: "Net payable", numeric: true, sortable: true, width: "11rem" },
    { key: "withholding", header: "Withheld", numeric: true, sortable: true, width: "9rem", defaultHidden: true },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "13rem" },
    { key: "signatures", header: "Signatures", sortable: true, width: "10rem" },
    { key: "waitingOn", header: "Waiting on", filterable: true, sortable: true, width: "12rem" },
    { key: "prepared", header: "Prepared", sortable: true, width: "9rem" },
    { key: "preparedBy", header: "Prepared by", sortable: true, width: "12rem" },
    { key: "age", header: "Age (days)", numeric: true, sortable: true, width: "7.5rem", defaultHidden: true },
  ];

  const rows: TableRow[] = vouchers.map((v) => {
    const signed = v.signatures.filter((s) => s.status === "APPROVED").length;
    const step = v.signatures.find((s) => s.status === "PENDING");
    const waitingOn = v.status === "PENDING_SIGNATORIES" ? (step?.roleCode ?? "") : "";
    const stale = v.status === "PENDING_SIGNATORIES" && (ageDays(v.preparedAt) ?? 0) > 3;
    return {
      id: v.id,
      href: `/finance/vouchers/${v.id}`,
      flag:
        v.status === "REJECTED"
          ? "danger"
          : v.status === "PAID"
            ? "success"
            : stale
              ? "warning"
              : null,
      search: `${v.number} ${v.invoice.vendor.name} ${v.invoice.vendorInvoiceNumber} ${v.invoice.po?.number ?? ""}`,
      values: {
        number: v.number,
        entity: v.entity.code,
        vendor: v.invoice.vendor.name,
        invoice: v.invoice.vendorInvoiceNumber,
        order: v.invoice.po?.number ?? "",
        net: v.netAmount,
        withholding: v.withholdingTax,
        status: humanize(v.status),
        signatures: `${signed}/${v.signatures.length}`,
        waitingOn: waitingOn ? humanize(waitingOn) : "",
        prepared: v.preparedAt.toISOString(),
        preparedBy: v.preparedBy.name,
        age: ageDays(v.preparedAt) ?? 0,
      },
      cells: {
        number: <RefLink href={`/finance/vouchers/${v.id}`}>{v.number}</RefLink>,
        entity: <Badge tone="neutral">{v.entity.code}</Badge>,
        vendor: (
          <Link href={`/vendors/${v.invoice.vendor.id}`} className="text-[var(--c-accent-text)]">
            {v.invoice.vendor.name}
          </Link>
        ),
        invoice: <RefLink href={`/invoices/${v.invoice.id}`}>{v.invoice.vendorInvoiceNumber}</RefLink>,
        order: v.invoice.po ? <RefLink href={`/po/${v.invoice.po.id}`}>{v.invoice.po.number}</RefLink> : "—",
        net: money(v.netAmount, v.currency, { compact: true }),
        withholding: v.withholdingTax ? money(v.withholdingTax, v.currency, { compact: true }) : "—",
        status: <StatusBadge status={v.status} />,
        signatures: (
          <span className="tnum text-xs">
            {signed}/{v.signatures.length}
          </span>
        ),
        waitingOn: waitingOn ? <Badge tone="warning">{humanize(waitingOn)}</Badge> : "—",
        prepared: fmtDate(v.preparedAt),
        preparedBy: v.preparedBy.name,
        age: ageDays(v.preparedAt) ?? 0,
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Finance"
        title="Payment vouchers"
        subtitle="What is about to be paid, and who still has to sign it. A voucher is only raised once the order, the receipt, the match and the tax all stand up."
      />

      {mine.length > 0 && (
        <InlineAlert tone="warning">
          {mine.length} voucher{mine.length === 1 ? "" : "s"} waiting on your signature:{" "}
          {mine.map((v) => (
            <Link key={v.id} href={`/finance/vouchers/${v.id}`} className="mono mr-2 text-[var(--c-accent-text)]">
              {v.number}
            </Link>
          ))}
        </InlineAlert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Awaiting signature"
          value={stats.awaitingSignature}
          hint="Raised, not yet fully signed"
          tone={stats.awaitingSignature ? "warning" : "default"}
        />
        <StatTile label="Signed, awaiting payment" value={stats.approved} hint="Ready for release" tone="accent" />
        <StatTile
          label="Value in the queue"
          value={money(stats.valueAwaiting, "PKR", { compact: true })}
          hint="Raised but not yet paid"
        />
        <StatTile label="Paid" value={stats.paid} hint="Settled through a voucher" tone="success" />
      </div>

      <DataTable
        id="vouchers"
        columns={columns}
        rows={rows}
        exportName="payment-vouchers"
        defaultSort={{ key: "prepared", dir: "desc" }}
        emptyState={
          <EmptyState
            title="No vouchers raised"
            description="A voucher is raised from an approved invoice once its order, receipt, match and tax are all in order."
          />
        }
      />
    </div>
  );
}
