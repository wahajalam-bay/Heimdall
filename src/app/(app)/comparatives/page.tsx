import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, PageHeader, RefLink, StatTile, StatusBadge } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { fmtDate, money, percent, round2 } from "@/lib/format";

export const metadata = { title: "Comparatives" };
export const dynamic = "force-dynamic";

export default async function ComparativesPage() {
  const { user, ctx, authorized } = await pageContext(P.COMPARATIVE_VIEW);
  if (!authorized) {
    return <AccessDenied title="Comparatives" message="You do not have permission to view comparative analyses." />;
  }

  const [comparatives, savedViews] = await Promise.all([
    prisma.comparative.findMany({
      where: { pr: ctx.entityFilter },
      orderBy: { preparedAt: "desc" },
      take: 400,
      include: {
        pr: {
          select: {
            id: true,
            number: true,
            title: true,
            estimatedValue: true,
            entity: { select: { code: true } },
            department: { select: { name: true } },
            cpcCases: { select: { id: true, number: true, status: true } },
            purchaseOrders: { select: { id: true, number: true, status: true } },
          },
        },
        rfq: { select: { id: true, number: true, quotes: { select: { id: true } } } },
        lines: {
          select: {
            id: true,
            isSelected: true,
            isLowest: true,
            isLowestCompliant: true,
            netTotal: true,
            technicalCompliance: true,
            vendor: { select: { id: true, name: true } },
          },
        },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "comparatives", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const stats = {
    total: comparatives.length,
    recommended: comparatives.filter((c) => c.status === "RECOMMENDED").length,
    approved: comparatives.filter((c) => c.status === "APPROVED").length,
    nonLowest: comparatives.filter((c) => Boolean(c.nonLowestJustification)).length,
    savings: round2(comparatives.reduce((a, c) => a + c.savingsAmount, 0)),
  };

  const columns: TableColumn[] = [
    { key: "number", header: "Comparative", locked: true, sortable: true, width: "10rem" },
    { key: "pr", header: "Requisition", sortable: true, width: "9.5rem" },
    { key: "title", header: "Case", sortable: true, minWidth: "18rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "department", header: "Department", filterable: true, sortable: true, width: "11rem", defaultHidden: true },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "9.5rem" },
    { key: "vendors", header: "Vendors", numeric: true, sortable: true, width: "6rem" },
    { key: "selected", header: "Awarded to", sortable: true, minWidth: "13rem" },
    { key: "lowest", header: "Lowest", numeric: true, sortable: true, width: "10rem" },
    { key: "selectedTotal", header: "Awarded value", numeric: true, sortable: true, width: "11rem" },
    { key: "previous", header: "Previous price", numeric: true, sortable: true, width: "10.5rem", defaultHidden: true },
    { key: "market", header: "Market price", numeric: true, sortable: true, width: "10.5rem", defaultHidden: true },
    { key: "savings", header: "Savings", numeric: true, sortable: true, width: "10rem" },
    { key: "savingsPct", header: "Savings %", numeric: true, sortable: true, width: "8rem" },
    { key: "prepared", header: "Prepared", sortable: true, width: "8rem" },
    { key: "flags", header: "Flags", sortable: false, minWidth: "13rem" },
  ];

  const rows: TableRow[] = comparatives.map((c) => {
    const selected = c.lines.find((l) => l.isSelected);
    const lowest = c.lines.find((l) => l.isLowest);
    const cpc = c.pr.cpcCases[0];
    const po = c.pr.purchaseOrders[0];
    return {
      id: c.id,
      href: `/comparatives/${c.id}`,
      flag: c.nonLowestJustification ? "warning" : c.status === "APPROVED" ? "success" : null,
      search: `${c.number} ${c.pr.number} ${c.pr.title} ${selected?.vendor.name ?? ""}`,
      values: {
        number: c.number,
        pr: c.pr.number,
        title: c.pr.title,
        entity: c.pr.entity.code,
        department: c.pr.department.name,
        status: humanize(c.status),
        vendors: c.lines.length,
        selected: selected?.vendor.name ?? "",
        lowest: lowest?.netTotal ?? c.lowestTotal ?? 0,
        selectedTotal: c.selectedTotal ?? 0,
        previous: c.previousPrice ?? 0,
        market: c.marketPrice ?? 0,
        savings: c.savingsAmount,
        savingsPct: c.savingsPercent,
        prepared: c.preparedAt.toISOString().slice(0, 10),
        flags: [c.nonLowestJustification ? "Non-lowest" : "", cpc ? "CPC" : "", po ? "PO raised" : ""]
          .filter(Boolean)
          .join(" "),
      },
      cells: {
        number: <RefLink href={`/comparatives/${c.id}`}>{c.number}</RefLink>,
        pr: <RefLink href={`/pr/${c.pr.id}`}>{c.pr.number}</RefLink>,
        title: (
          <span className="block max-w-[24rem] truncate" title={c.pr.title}>
            {c.pr.title}
          </span>
        ),
        entity: <Badge tone="neutral">{c.pr.entity.code}</Badge>,
        department: c.pr.department.name,
        status: <StatusBadge status={c.status} />,
        vendors: c.lines.length,
        selected: selected ? (
          <RefLink href={`/vendors/${selected.vendor.id}`}>{selected.vendor.name}</RefLink>
        ) : (
          <span className="text-2xs text-[var(--c-text-tertiary)]">Not recommended</span>
        ),
        lowest: lowest ? money(lowest.netTotal) : c.lowestTotal ? money(c.lowestTotal) : "—",
        selectedTotal: c.selectedTotal ? <span className="font-500">{money(c.selectedTotal)}</span> : "—",
        previous: c.previousPrice ? money(c.previousPrice) : "—",
        market: c.marketPrice ? money(c.marketPrice) : "—",
        savings: c.savingsAmount > 0 ? <span className="text-[var(--c-success)]">{money(c.savingsAmount)}</span> : "—",
        savingsPct: c.savingsPercent > 0 ? percent(c.savingsPercent) : "—",
        prepared: fmtDate(c.preparedAt),
        flags: (
          <span className="flex flex-wrap gap-1">
            {c.nonLowestJustification && <Badge tone="warning">Non-lowest, justified</Badge>}
            {cpc && <Badge tone={cpc.status === "APPROVED" ? "success" : "progress"}>CPC {humanize(cpc.status)}</Badge>}
            {po && <Badge tone="accent">{po.number}</Badge>}
          </span>
        ),
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Procurement"
        title="Cost comparatives"
        subtitle="Side-by-side vendor comparison against previous and market prices, with the lowest compliant quotation always identified."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Comparatives" value={stats.total} />
        <StatTile label="Recommended" value={stats.recommended} tone="accent" hint="Awaiting committee or PO" />
        <StatTile label="Approved" value={stats.approved} tone="success" />
        <StatTile
          label="Awarded above lowest"
          value={stats.nonLowest}
          hint="Each carries a written justification"
          tone={stats.nonLowest ? "warning" : "default"}
        />
        <StatTile label="Savings identified" value={money(stats.savings, "PKR", { compact: true })} tone="success" />
      </div>

      <DataTable
        id="comparatives"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "prepared", dir: "desc" }}
        exportName="comparatives"
        emptyState={
          <EmptyState
            title="No comparatives yet"
            description="A comparative is built from the quotations on an RFQ. Open an RFQ with quotations and choose “Build comparative”."
          />
        }
      />
    </div>
  );
}
