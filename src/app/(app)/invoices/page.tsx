import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type BulkAction, type TableColumn, type TableRow } from "@/components/ui/DataTable";
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
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, money, round2 } from "@/lib/format";

export const metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

const MATCH_TONE: Record<string, "success" | "danger" | "warning" | "neutral"> = {
  PASSED: "success",
  FAILED: "danger",
  OVERRIDDEN: "warning",
  PENDING: "neutral",
};

export default async function InvoicesPage() {
  const { user, ctx, authorized } = await pageContext(P.INVOICE_VIEW);
  if (!authorized) {
    return <AccessDenied title="Invoices" message="You do not have permission to view vendor invoices." />;
  }

  const [invoices, savedViews] = await Promise.all([
    prisma.invoice.findMany({
      where: { po: ctx.entityFilter },
      orderBy: { receivedDate: "desc" },
      take: 500,
      include: {
        vendor: { select: { id: true, name: true, status: true } },
        po: {
          select: {
            id: true,
            number: true,
            total: true,
            entity: { select: { code: true } },
            pr: { select: { id: true, number: true } },
          },
        },
        items: { select: { id: true, matchFlag: true } },
        grnLinks: { select: { grnId: true } },
        handoffs: { select: { id: true, number: true, status: true, paidDate: true } },
        exceptions: {
          where: { status: { in: ["OPEN", "IN_PROGRESS"] } },
          select: { id: true, blocking: true, severity: true },
        },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "invoices", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const canCreate = userHasPermission(user, P.INVOICE_CREATE);
  // Re-running the match in bulk is what finance actually needs after a GRN
  // posts: a failure caused only by goods not yet received clears itself.
  const bulkActions: BulkAction[] | undefined = userHasPermission(user, P.INVOICE_VERIFY)
    ? [
        {
          id: "rematch",
          label: "Re-run three-way match",
          endpoint: "/api/bulk/invoice",
          tone: "default",
          confirm:
            "Re-run the three-way match on {n} invoice(s)? Nothing is approved or paid — the match result is simply recomputed against the current receipts.",
        },
      ]
    : undefined;

  const failing = invoices.filter((i) => i.matchStatus === "FAILED");
  const blocked = invoices.filter((i) => i.exceptions.some((e) => e.blocking));
  const unpaid = invoices.filter((i) => !["PAID", "REJECTED"].includes(i.status));
  const overdue = unpaid.filter((i) => i.dueDate && i.dueDate.getTime() < Date.now());

  const columns: TableColumn[] = [
    { key: "number", header: "Invoice", locked: true, sortable: true, width: "10rem" },
    { key: "vendorRef", header: "Vendor reference", sortable: true, width: "12rem" },
    { key: "vendor", header: "Vendor", sortable: true, minWidth: "14rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "po", header: "Purchase order", sortable: true, width: "11rem" },
    { key: "case", header: "Case", sortable: true, width: "11rem", defaultHidden: true },
    { key: "invoiceDate", header: "Invoice date", sortable: true, width: "9.5rem" },
    { key: "dueDate", header: "Due", sortable: true, width: "9.5rem" },
    { key: "total", header: "Total", numeric: true, sortable: true, width: "11rem" },
    { key: "netPayable", header: "Net payable", numeric: true, sortable: true, width: "11rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "12rem" },
    { key: "matchStatus", header: "Three-way match", filterable: true, sortable: true, width: "11rem" },
    { key: "mismatches", header: "Mismatched lines", numeric: true, sortable: true, width: "10rem" },
    { key: "grns", header: "GRNs linked", numeric: true, sortable: true, width: "9rem" },
    { key: "blocking", header: "Blocking exception", filterable: true, sortable: true, width: "10rem" },
    { key: "handoff", header: "Finance handoff", sortable: true, width: "11rem" },
    { key: "paid", header: "Paid", sortable: true, width: "9.5rem" },
    { key: "age", header: "Age (days)", numeric: true, sortable: true, width: "8rem", defaultHidden: true },
  ];

  const rows: TableRow[] = invoices.map((i) => {
    const mismatches = i.items.filter((x) => x.matchFlag !== "OK").length;
    const blocker = i.exceptions.find((e) => e.blocking);
    const handoff = i.handoffs[i.handoffs.length - 1];
    const isOverdue = i.dueDate && i.dueDate.getTime() < Date.now() && !["PAID", "REJECTED"].includes(i.status);
    return {
      id: i.id,
      href: `/invoices/${i.id}`,
      flag:
        i.matchStatus === "FAILED" || blocker
          ? "danger"
          : isOverdue
            ? "warning"
            : i.status === "PAID"
              ? "success"
              : null,
      search: `${i.number} ${i.vendorInvoiceNumber} ${i.vendor.name} ${i.po.number}`,
      values: {
        number: i.number,
        vendorRef: i.vendorInvoiceNumber,
        vendor: i.vendor.name,
        entity: i.po.entity.code,
        po: i.po.number,
        case: i.po.pr?.number ?? "",
        invoiceDate: i.invoiceDate.toISOString(),
        dueDate: i.dueDate ? i.dueDate.toISOString() : "",
        total: i.total,
        netPayable: i.netPayable,
        status: humanize(i.status),
        matchStatus: humanize(i.matchStatus),
        mismatches,
        grns: i.grnLinks.length,
        blocking: blocker ? "Yes" : "No",
        handoff: handoff?.number ?? "",
        paid: handoff?.paidDate ? handoff.paidDate.toISOString() : "",
        age: ageDays(i.receivedDate) ?? 0,
      },
      cells: {
        number: <RefLink href={`/invoices/${i.id}`}>{i.number}</RefLink>,
        vendorRef: <Mono>{i.vendorInvoiceNumber}</Mono>,
        vendor: (
          <span className="flex flex-wrap items-center gap-1.5">
            <RefLink href={`/vendors/${i.vendor.id}`}>{i.vendor.name}</RefLink>
            {i.vendor.status !== "APPROVED" && <StatusBadge status={i.vendor.status} />}
          </span>
        ),
        entity: <Badge tone="neutral">{i.po.entity.code}</Badge>,
        po: <RefLink href={`/po/${i.po.id}`}>{i.po.number}</RefLink>,
        case: i.po.pr ? <RefLink href={`/pr/${i.po.pr.id}`}>{i.po.pr.number}</RefLink> : "—",
        invoiceDate: fmtDate(i.invoiceDate),
        dueDate: i.dueDate ? (
          <span className={isOverdue ? "text-[var(--c-danger)] font-600" : undefined}>{fmtDate(i.dueDate)}</span>
        ) : (
          "—"
        ),
        total: <Mono>{money(i.total)}</Mono>,
        netPayable: <Mono>{money(i.netPayable)}</Mono>,
        status: <StatusBadge status={i.status} />,
        matchStatus: <Badge tone={MATCH_TONE[i.matchStatus] ?? "neutral"}>{humanize(i.matchStatus)}</Badge>,
        mismatches: mismatches > 0 ? <Badge tone="danger">{mismatches}</Badge> : "—",
        grns: i.grnLinks.length === 0 ? <Badge tone="warning">None</Badge> : i.grnLinks.length,
        blocking: blocker ? <Badge tone="danger">Blocked</Badge> : "—",
        handoff: handoff ? (
          <span className="flex items-center gap-1.5">
            <RefLink href={`/finance/handoffs/${handoff.id}`}>{handoff.number}</RefLink>
          </span>
        ) : (
          "—"
        ),
        paid: handoff?.paidDate ? fmtDate(handoff.paidDate) : "—",
        age: ageDays(i.receivedDate) ?? 0,
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Finance"
        title="Vendor invoices"
        subtitle="Every invoice is matched against the purchase order and the goods actually received. A failing match blocks payment — it is never quietly passed."
        actions={
          canCreate && (
            <Link href="/invoices/new" className="btn btn-primary btn-sm">
              Register invoice
            </Link>
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Invoices on file" value={invoices.length} />
        <StatTile
          label="Failing the match"
          value={failing.length}
          tone={failing.length ? "danger" : "success"}
          hint="Payment blocked until resolved or waived"
        />
        <StatTile
          label="Unpaid value"
          value={money(round2(unpaid.reduce((a, i) => a + i.netPayable, 0)))}
          hint={`${unpaid.length} open invoice${unpaid.length === 1 ? "" : "s"}`}
        />
        <StatTile label="Past due" value={overdue.length} tone={overdue.length ? "warning" : "default"} />
      </div>

      {failing.length > 0 && (
        <SectionCard
          title="Invoices failing the three-way match"
          description="These are the ones that matter. Each needs the mismatch resolved, or a formally reasoned waiver from an authorised approver."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Vendor</th>
                  <th>Purchase order</th>
                  <th className="text-right">Invoice total</th>
                  <th className="text-right">Order total</th>
                  <th className="text-right">Mismatched lines</th>
                  <th>Match notes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {failing.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <RefLink href={`/invoices/${i.id}`}>{i.number}</RefLink>
                      <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        {i.vendorInvoiceNumber}
                      </span>
                    </td>
                    <td className="text-xs">{i.vendor.name}</td>
                    <td>
                      <RefLink href={`/po/${i.po.id}`}>{i.po.number}</RefLink>
                    </td>
                    <td className="num text-xs font-600">{money(i.total)}</td>
                    <td className="num text-xs">{money(i.po.total)}</td>
                    <td className="num text-xs font-600 text-[var(--c-danger)]">
                      {i.items.filter((x) => x.matchFlag !== "OK").length}
                    </td>
                    <td className="max-w-[24rem] text-2xs text-[var(--c-text-secondary)]">{i.matchNotes ?? "—"}</td>
                    <td>
                      <Link href={`/invoices/${i.id}`} className="btn btn-primary btn-xs">
                        Review
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {blocked.length > 0 && failing.length === 0 && (
        <InlineAlert tone="danger">
          {blocked.length} invoice{blocked.length === 1 ? " has" : "s have"} a blocking exception open. Payment stays
          refused while the exception stands, regardless of approval status.
        </InlineAlert>
      )}

      <DataTable
        id="invoices"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        bulkActions={bulkActions}
        defaultSort={{ key: "invoiceDate", dir: "desc" }}
        exportName="invoices"
        emptyState={
          <EmptyState
            title="No invoices registered"
            description="Register a vendor invoice against its purchase order. The match runs immediately and its result is permanent."
            action={
              canCreate && (
                <Link href="/invoices/new" className="btn btn-primary btn-sm">
                  Register invoice
                </Link>
              )
            }
          />
        }
      />
    </div>
  );
}
