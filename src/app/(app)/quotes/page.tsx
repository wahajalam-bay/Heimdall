import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, PageHeader, RefLink, StatTile, StatusBadge } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { fmtDate, money, percent, round2 } from "@/lib/format";
import { statusLink, tableLink } from "@/lib/links";

export const metadata = { title: "Quotations" };
export const dynamic = "force-dynamic";

export default async function QuotesPage() {
  const { user, ctx, authorized } = await pageContext(P.QUOTE_VIEW);
  if (!authorized) {
    return <AccessDenied title="Quotations" message="You do not have permission to view vendor quotations." />;
  }

  const [quotes, savedViews] = await Promise.all([
    prisma.vendorQuote.findMany({
      where: { rfq: { pr: ctx.entityFilter } },
      orderBy: { quoteDate: "desc" },
      take: 600,
      include: {
        vendor: { select: { id: true, code: true, name: true, status: true, taxStatus: true } },
        rfq: {
          select: {
            id: true,
            number: true,
            status: true,
            pr: { select: { id: true, number: true, title: true, entity: { select: { code: true } } } },
          },
        },
        items: { select: { id: true } },
        negotiations: { orderBy: { round: "desc" }, take: 1 },
        comparativeLines: { select: { isSelected: true, isLowest: true, isLowestCompliant: true } },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "quotes", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const now = new Date();
  const stats = {
    total: quotes.length,
    compliant: quotes.filter((q) => q.technicalCompliance === "COMPLIANT").length,
    negotiated: quotes.filter((q) => q.negotiations.length > 0).length,
    awarded: quotes.filter((q) => q.status === "SELECTED").length,
    expired: quotes.filter((q) => q.validUntil && q.validUntil < now && q.status !== "SELECTED").length,
    conceded: round2(quotes.reduce((a, q) => a + (q.negotiations[0]?.savings ?? 0), 0)),
  };

  const columns: TableColumn[] = [
    { key: "number", header: "Quotation", locked: true, sortable: true, width: "9.5rem" },
    { key: "vendor", header: "Vendor", sortable: true, minWidth: "14rem" },
    { key: "rfq", header: "RFQ", sortable: true, width: "9.5rem" },
    { key: "pr", header: "Requisition", sortable: true, width: "9.5rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "9rem" },
    { key: "compliance", header: "Compliance", filterable: true, sortable: true, width: "9rem" },
    { key: "total", header: "Quoted total", numeric: true, sortable: true, width: "10rem" },
    { key: "net", header: "Net after negotiation", numeric: true, sortable: true, width: "11rem" },
    { key: "conceded", header: "Conceded", numeric: true, sortable: true, width: "9rem" },
    { key: "lines", header: "Lines", numeric: true, sortable: true, width: "4.5rem", defaultHidden: true },
    { key: "lead", header: "Lead time", numeric: true, sortable: true, width: "7rem" },
    { key: "warranty", header: "Warranty", numeric: true, sortable: true, width: "7rem", defaultHidden: true },
    { key: "terms", header: "Payment terms", sortable: true, width: "12rem", defaultHidden: true },
    { key: "channel", header: "Channel", filterable: true, sortable: true, width: "7.5rem" },
    { key: "quoteDate", header: "Quoted", sortable: true, width: "8rem" },
    { key: "validUntil", header: "Valid until", sortable: true, width: "8.5rem" },
    { key: "flags", header: "Flags", sortable: false, width: "12rem" },
    // Two states the tiles count that no existing column can be filtered to:
    // whether a round of negotiation happened, and whether validity has run out
    // on a quotation nobody awarded.
    { key: "negotiated", header: "Negotiated", filterable: true, sortable: true, width: "9rem", defaultHidden: true },
    { key: "validity", header: "Validity", filterable: true, sortable: true, width: "10rem", defaultHidden: true },
  ];

  const rows: TableRow[] = quotes.map((q) => {
    const neg = q.negotiations[0];
    const net = neg ? (neg.finalTotal ?? neg.negotiatedTotal) : q.total;
    const expired = q.validUntil && q.validUntil < now && q.status !== "SELECTED";
    const line = q.comparativeLines[0];
    return {
      id: q.id,
      href: `/rfq/${q.rfq.id}`,
      flag: q.status === "SELECTED" ? "success" : expired ? "warning" : q.technicalCompliance === "NON_COMPLIANT" ? "danger" : null,
      search: `${q.number} ${q.vendor.name} ${q.rfq.number} ${q.rfq.pr.number} ${q.quoteRef ?? ""}`,
      values: {
        number: q.number,
        vendor: q.vendor.name,
        rfq: q.rfq.number,
        pr: q.rfq.pr.number,
        entity: q.rfq.pr.entity.code,
        status: humanize(q.status),
        compliance: humanize(q.technicalCompliance),
        total: q.total,
        net,
        conceded: neg?.savings ?? 0,
        lines: q.items.length,
        lead: q.deliveryDays ?? 0,
        warranty: q.warrantyMonths ?? 0,
        terms: q.paymentTerms ?? "",
        channel: humanize(q.channel),
        quoteDate: q.quoteDate.toISOString().slice(0, 10),
        validUntil: q.validUntil ? q.validUntil.toISOString().slice(0, 10) : "",
        flags: [q.status === "SELECTED" ? "Awarded" : "", expired ? "Expired" : ""].filter(Boolean).join(" "),
        negotiated: neg ? "Negotiated" : "As quoted",
        validity: expired ? "Expired & unawarded" : q.validUntil ? "Valid" : "No expiry",
      },
      cells: {
        negotiated: neg ? (
          <Badge tone="success">Negotiated</Badge>
        ) : (
          <span className="text-[var(--c-text-tertiary)]">As quoted</span>
        ),
        validity: expired ? (
          <Badge tone="warning">Expired &amp; unawarded</Badge>
        ) : (
          <span className="text-[var(--c-text-tertiary)]">{q.validUntil ? "Valid" : "No expiry"}</span>
        ),
        number: <RefLink href={`/rfq/${q.rfq.id}`}>{q.number}</RefLink>,
        vendor: (
          <span>
            <RefLink href={`/vendors/${q.vendor.id}`}>{q.vendor.name}</RefLink>
            {q.vendor.taxStatus === "NON_FILER" && (
              <span className="ml-1.5">
                <Badge tone="warning">Non-filer</Badge>
              </span>
            )}
          </span>
        ),
        rfq: <RefLink href={`/rfq/${q.rfq.id}`}>{q.rfq.number}</RefLink>,
        pr: <RefLink href={`/pr/${q.rfq.pr.id}`}>{q.rfq.pr.number}</RefLink>,
        entity: <Badge tone="neutral">{q.rfq.pr.entity.code}</Badge>,
        status: <StatusBadge status={q.status} />,
        compliance: (
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
        ),
        total: money(q.total),
        net: <span className="font-500">{money(net)}</span>,
        conceded: neg ? <span className="text-[var(--c-success)]">{money(neg.savings)}</span> : "—",
        lines: q.items.length,
        lead: q.deliveryDays ? `${q.deliveryDays}d` : "—",
        warranty: q.warrantyMonths ? `${q.warrantyMonths}m` : "—",
        terms: q.paymentTerms ?? "—",
        channel: <span className="text-xs">{humanize(q.channel)}</span>,
        quoteDate: fmtDate(q.quoteDate),
        validUntil: q.validUntil ? (
          <span className={expired ? "text-[var(--c-danger)]" : undefined}>{fmtDate(q.validUntil)}</span>
        ) : (
          "—"
        ),
        flags: (
          <span className="flex flex-wrap gap-1">
            {line?.isSelected && <Badge tone="accent">Awarded</Badge>}
            {line?.isLowest && <Badge tone="info">Lowest</Badge>}
            {line?.isLowestCompliant && <Badge tone="success">Lowest compliant</Badge>}
            {expired && <Badge tone="warning">Expired</Badge>}
          </span>
        ),
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Procurement"
        title="Vendor quotations"
        subtitle="Every quotation recorded against an RFQ, with its negotiation outcome and comparative standing."
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        <StatTile label="Quotations" value={stats.total} href="/quotes" />
        <StatTile
          label="Technically compliant"
          value={stats.compliant}
          hint={stats.total ? percent((stats.compliant / stats.total) * 100, 0) : "—"}
          href={statusLink("/quotes", "compliance", ["COMPLIANT"])}
        />
        <StatTile
          label="Negotiated"
          value={stats.negotiated}
          hint="At least one recorded round"
          href={tableLink("/quotes", { negotiated: "Negotiated" })}
        />
        <StatTile
          label="Total conceded"
          value={money(stats.conceded, "PKR", { compact: true })}
          tone="success"
          href={tableLink("/quotes", { negotiated: "Negotiated" }, { sort: "conceded:desc" })}
        />
        <StatTile
          label="Expired & unawarded"
          value={stats.expired}
          tone={stats.expired ? "warning" : "default"}
          href={tableLink("/quotes", { validity: "Expired & unawarded" })}
        />
      </div>

      <DataTable
        id="quotes"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "quoteDate", dir: "desc" }}
        exportName="vendor-quotations"
        emptyState={
          <EmptyState
            title="No quotations recorded"
            description="Quotations appear here once procurement records vendor responses against an RFQ."
          />
        }
      />
    </div>
  );
}
