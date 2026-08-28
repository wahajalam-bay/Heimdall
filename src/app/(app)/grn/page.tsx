import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, PageHeader, RefLink, StatTile, StatusBadge } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { fmtDateTime, money, qty, round2 } from "@/lib/format";
import { statusLink, tableLink } from "@/lib/links";

export const metadata = { title: "GRNs" };
export const dynamic = "force-dynamic";

export default async function GrnListPage() {
  const { user, ctx, authorized } = await pageContext(P.GRN_VIEW);
  if (!authorized) {
    return <AccessDenied title="GRNs" message="You do not have permission to view goods receipt notes." />;
  }

  const [grns, savedViews] = await Promise.all([
    prisma.grn.findMany({
      where: { po: ctx.entityFilter },
      orderBy: { receivedAt: "desc" },
      take: 400,
      include: {
        po: { select: { id: true, number: true, entity: { select: { code: true } }, pr: { select: { id: true, number: true } } } },
        vendor: { select: { id: true, name: true } },
        store: { select: { id: true, name: true, kind: true } },
        receivedBy: { select: { name: true } },
        delivery: { select: { id: true, number: true } },
        inspection: { select: { id: true, number: true, result: true } },
        items: { select: { acceptedQty: true, rejectedQty: true, disposition: true } },
        invoiceMatches: { select: { invoiceId: true } },
        stacking: { select: { id: true } },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "grns", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const posted = grns.filter((g) => g.status === "POSTED");
  const stats = {
    total: grns.length,
    posted: posted.length,
    drafts: grns.filter((g) => g.status === "DRAFT").length,
    cancelled: grns.filter((g) => g.status === "CANCELLED").length,
    value: round2(posted.reduce((a, g) => a + g.totalValue, 0)),
    awaitingStacking: posted.filter((g) => g.stacking.length === 0).length,
    unmatched: posted.filter((g) => g.invoiceMatches.length === 0).length,
  };

  const columns: TableColumn[] = [
    { key: "number", header: "GRN", locked: true, sortable: true, width: "9.5rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "8rem" },
    { key: "po", header: "PO", sortable: true, width: "9.5rem" },
    { key: "pr", header: "Case", sortable: true, width: "9.5rem", defaultHidden: true },
    { key: "vendor", header: "Vendor", sortable: true, minWidth: "13rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "store", header: "Store", filterable: true, sortable: true, width: "14rem" },
    { key: "receipt", header: "From receipt", sortable: true, width: "9.5rem" },
    { key: "inspection", header: "Inspection", filterable: true, sortable: true, width: "11rem" },
    { key: "accepted", header: "Accepted", numeric: true, sortable: true, width: "8rem" },
    { key: "rejected", header: "Rejected", numeric: true, sortable: true, width: "8rem" },
    { key: "value", header: "Value taken in", numeric: true, sortable: true, width: "11rem" },
    { key: "stacking", header: "Stacked", filterable: true, sortable: true, width: "8rem" },
    { key: "invoiced", header: "Invoice matched", filterable: true, sortable: true, width: "11rem" },
    { key: "receivedBy", header: "Received by", sortable: true, width: "12rem", defaultHidden: true },
    { key: "receivedAt", header: "Received", sortable: true, width: "12rem" },
    { key: "postedAt", header: "Posted", sortable: true, width: "12rem", defaultHidden: true },
  ];

  const rows: TableRow[] = grns.map((g) => {
    const accepted = round2(g.items.reduce((a, i) => a + i.acceptedQty, 0));
    const rejected = round2(g.items.reduce((a, i) => a + i.rejectedQty, 0));
    const needsStacking = g.status === "POSTED" && g.stacking.length === 0;
    return {
      id: g.id,
      href: `/grn/${g.id}`,
      flag:
        g.status === "CANCELLED"
          ? "danger"
          : g.status === "DRAFT"
            ? "warning"
            : needsStacking
              ? "info"
              : "success",
      search: `${g.number} ${g.po.number} ${g.vendor.name} ${g.store.name}`,
      values: {
        number: g.number,
        status: humanize(g.status),
        po: g.po.number,
        pr: g.po.pr?.number ?? "",
        vendor: g.vendor.name,
        entity: g.po.entity.code,
        store: g.store.name,
        receipt: g.delivery?.number ?? "",
        inspection: g.inspection ? humanize(g.inspection.result) : humanize(g.inspectionStatus),
        accepted,
        rejected,
        value: g.totalValue,
        stacking: g.stacking.length ? "Yes" : "No",
        invoiced: g.invoiceMatches.length ? "Matched" : "Not matched",
        receivedBy: g.receivedBy.name,
        receivedAt: g.receivedAt.toISOString(),
        postedAt: g.postedAt ? g.postedAt.toISOString() : "",
      },
      cells: {
        number: <RefLink href={`/grn/${g.id}`}>{g.number}</RefLink>,
        status: <StatusBadge status={g.status} />,
        po: <RefLink href={`/po/${g.po.id}`}>{g.po.number}</RefLink>,
        pr: g.po.pr ? <RefLink href={`/pr/${g.po.pr.id}`}>{g.po.pr.number}</RefLink> : "—",
        vendor: <RefLink href={`/vendors/${g.vendor.id}`}>{g.vendor.name}</RefLink>,
        entity: <Badge tone="neutral">{g.po.entity.code}</Badge>,
        store: (
          <span>
            <RefLink href={`/stores/${g.store.id}`}>{g.store.name}</RefLink>
            <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{humanize(g.store.kind)}</span>
          </span>
        ),
        receipt: g.delivery ? <RefLink href={`/receiving/${g.delivery.id}`}>{g.delivery.number}</RefLink> : "—",
        inspection: g.inspection ? (
          <Link href={`/inspections/${g.inspection.id}`}>
            <Badge tone={g.inspection.result === "APPROVED" ? "success" : "warning"}>
              {humanize(g.inspection.result)}
            </Badge>
          </Link>
        ) : (
          <Badge tone="neutral">{humanize(g.inspectionStatus)}</Badge>
        ),
        accepted: <span className="font-500">{qty(accepted)}</span>,
        rejected: rejected > 0 ? <span className="text-[var(--c-danger)]">{qty(rejected)}</span> : "—",
        value: money(g.totalValue),
        stacking: g.stacking.length ? (
          <Badge tone="success">Stacked</Badge>
        ) : g.status === "POSTED" ? (
          <Badge tone="warning">Pending</Badge>
        ) : (
          "—"
        ),
        invoiced: g.invoiceMatches.length ? (
          <Badge tone="success">Matched</Badge>
        ) : g.status === "POSTED" ? (
          <span className="text-2xs text-[var(--c-text-tertiary)]">Awaiting invoice</span>
        ) : (
          "—"
        ),
        receivedBy: g.receivedBy.name,
        receivedAt: fmtDateTime(g.receivedAt),
        postedAt: g.postedAt ? fmtDateTime(g.postedAt) : "—",
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Operations"
        title="Goods receipt notes"
        subtitle="The official record that goods entered inventory. Where no GRN exists the system treats the item as not received, and no invoice against it can be paid."
        actions={
          userHasPermission(user, P.GRN_CREATE) && (
            <Link href="/grn/new" className="btn btn-primary btn-sm">
              Raise GRN
            </Link>
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="Posted GRNs"
          value={stats.posted}
          hint={`${stats.total} total including drafts`}
          tone="success"
          href={statusLink("/grn", "status", ["POSTED"])}
        />
        <StatTile
          label="Value taken into inventory"
          value={money(stats.value, "PKR", { compact: true })}
          href={tableLink("/grn", { status: humanize("POSTED") }, { sort: "value:desc" })}
        />
        <StatTile
          label="Drafts"
          value={stats.drafts}
          hint="Created but not posted — no inventory effect yet"
          tone={stats.drafts ? "warning" : "default"}
          href={statusLink("/grn", "status", ["DRAFT"])}
        />
        <StatTile
          label="Awaiting stacking"
          value={stats.awaitingStacking}
          hint="In inventory but no bin recorded"
          tone={stats.awaitingStacking ? "warning" : "default"}
          href={tableLink("/grn", { status: humanize("POSTED"), stacking: "No" })}
        />
        <StatTile
          label="Not yet invoiced"
          value={stats.unmatched}
          hint="Received, awaiting the vendor invoice"
          href={tableLink("/grn", { invoiced: "Not matched" })}
        />
      </div>

      <DataTable
        id="grns"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "receivedAt", dir: "desc" }}
        exportName="goods-receipt-notes"
        emptyState={
          <EmptyState
            title="No GRNs yet"
            description="A GRN is raised from a verified physical receipt once any mandatory inspection is cleared."
            action={
              userHasPermission(user, P.GRN_CREATE) && (
                <Link href="/grn/new" className="btn btn-primary btn-sm">
                  Raise GRN
                </Link>
              )
            }
          />
        }
      />
    </div>
  );
}
