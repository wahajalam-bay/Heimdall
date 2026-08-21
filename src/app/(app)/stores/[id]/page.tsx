import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext, first, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { listStock, itemLedger } from "@/server/inventory";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs, TabNav } from "@/components/ui/nav";
import {
  Badge,
  DefList,
  EmptyState,
  MetaItem,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { humanize } from "@/lib/domain";
import { amount, fmtDate, fmtDateTime, money, qty, round2 } from "@/lib/format";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await prisma.store.findUnique({ where: { id }, select: { name: true } });
  return { title: s ? `${s.name} — Store` : "Store" };
}

export default async function StoreDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const tab = first((await searchParams).tab) ?? "stock";
  const { user, authorized } = await pageContext(P.INVENTORY_VIEW);
  if (!authorized) return <AccessDenied title="Store" />;

  const store = await prisma.store.findUnique({
    where: { id },
    include: {
      entity: { select: { code: true, name: true } },
      site: { select: { id: true, name: true } },
      project: { select: { id: true, code: true, name: true } },
      locations: { orderBy: { label: "asc" } },
      _count: { select: { grns: true, gatePasses: true, deliveries: true, issues: true } },
    },
  });
  if (!store) notFound();

  const manager = store.managerId
    ? await prisma.user.findUnique({ where: { id: store.managerId }, select: { name: true, title: true, email: true } })
    : null;

  const [stock, recentTxns, issues, transfersIn, transfersOut, stacking, recentGrns] = await Promise.all([
    listStock({ storeIds: [store.id] }),
    prisma.inventoryTransaction.findMany({
      where: { storeId: store.id },
      orderBy: { performedAt: "desc" },
      take: 200,
      include: { item: { select: { sku: true, name: true } } },
    }),
    prisma.storeIssue.findMany({
      where: { storeId: store.id },
      orderBy: { requestedAt: "desc" },
      take: 60,
      include: { requestedBy: { select: { name: true } }, items: { select: { id: true } } },
    }),
    prisma.storeTransfer.findMany({
      where: { toStoreId: store.id },
      orderBy: { requestedAt: "desc" },
      take: 40,
      include: { fromStore: { select: { name: true } }, items: { select: { id: true } } },
    }),
    prisma.storeTransfer.findMany({
      where: { fromStoreId: store.id },
      orderBy: { requestedAt: "desc" },
      take: 40,
      include: { toStore: { select: { name: true } }, items: { select: { id: true } } },
    }),
    prisma.goodsStacking.findMany({
      where: { storeId: store.id },
      orderBy: { stackedAt: "desc" },
      take: 100,
      include: { location: { select: { label: true, handling: true } }, stackedBy: { select: { name: true } }, grn: { select: { id: true, number: true } } },
    }),
    prisma.grn.findMany({
      where: { storeId: store.id },
      orderBy: { receivedAt: "desc" },
      take: 40,
      include: { vendor: { select: { name: true } }, po: { select: { id: true, number: true } } },
    }),
  ]);

  const totalValue = round2(stock.reduce((a, s) => a + s.totalValue, 0));
  const belowReorder = stock.filter((s) => s.belowReorder);
  const expiring = stock.filter((s) => s.expiringSoon);
  const unbinned = stock.filter((s) => !s.locationLabel && s.quantity > 0);

  const stockColumns: TableColumn[] = [
    { key: "sku", header: "SKU", locked: true, sortable: true, width: "10rem" },
    { key: "item", header: "Item", sortable: true, minWidth: "18rem" },
    { key: "category", header: "Category", filterable: true, sortable: true, width: "13rem" },
    { key: "location", header: "Bin", filterable: true, sortable: true, width: "9rem" },
    { key: "batch", header: "Batch", sortable: true, width: "11rem" },
    { key: "serial", header: "Serial", sortable: true, width: "11rem", defaultHidden: true },
    { key: "quantity", header: "On hand", numeric: true, sortable: true, width: "8rem" },
    { key: "reserved", header: "Reserved", numeric: true, sortable: true, width: "8rem", defaultHidden: true },
    { key: "available", header: "Available", numeric: true, sortable: true, width: "8rem" },
    { key: "unitCost", header: "Unit cost", numeric: true, sortable: true, width: "9rem" },
    { key: "value", header: "Value", numeric: true, sortable: true, width: "10rem" },
    { key: "expiry", header: "Expiry", sortable: true, width: "8.5rem" },
    { key: "project", header: "Project", filterable: true, sortable: true, width: "12rem", defaultHidden: true },
    { key: "flags", header: "Flags", sortable: false, width: "11rem" },
  ];

  const stockRows: TableRow[] = stock.map((s) => ({
    id: s.id,
    flag: s.belowReorder ? "warning" : s.expiringSoon ? "danger" : null,
    search: `${s.sku} ${s.itemName} ${s.batchNumber ?? ""} ${s.serialNumber ?? ""}`,
    values: {
      sku: s.sku,
      item: s.itemName,
      category: s.categoryName,
      location: s.locationLabel ?? "Unassigned",
      batch: s.batchNumber ?? "",
      serial: s.serialNumber ?? "",
      quantity: s.quantity,
      reserved: s.reservedQty,
      available: s.available,
      unitCost: s.unitCost,
      value: s.totalValue,
      expiry: s.expiryDate ? s.expiryDate.toISOString().slice(0, 10) : "",
      project: s.projectName ?? "",
      flags: [s.belowReorder ? "Below reorder" : "", s.expiringSoon ? "Expiring" : ""].filter(Boolean).join(" "),
    },
    cells: {
      sku: <span className="mono">{s.sku}</span>,
      item: s.itemName,
      category: s.categoryName,
      location: s.locationLabel ? (
        <Badge tone="neutral">{s.locationLabel}</Badge>
      ) : (
        <span className="text-2xs text-[var(--c-text-tertiary)]">Unassigned</span>
      ),
      batch: s.batchNumber ?? "—",
      serial: s.serialNumber ?? "—",
      quantity: qty(s.quantity, s.unit),
      reserved: s.reservedQty > 0 ? qty(s.reservedQty) : "—",
      available: <span className="font-500">{qty(s.available)}</span>,
      unitCost: money(s.unitCost),
      value: money(s.totalValue),
      expiry: s.expiryDate ? (
        <span className={s.expiringSoon ? "text-[var(--c-danger)]" : undefined}>{fmtDate(s.expiryDate)}</span>
      ) : (
        "—"
      ),
      project: s.projectName ?? "—",
      flags: (
        <span className="flex flex-wrap gap-1">
          {s.belowReorder && <Badge tone="warning">Below reorder</Badge>}
          {s.expiringSoon && <Badge tone="danger">Expiring</Badge>}
        </span>
      ),
    },
  }));

  const tabs = [
    { key: "stock", label: "Stock", count: stock.length },
    { key: "movements", label: "Movements", count: recentTxns.length },
    { key: "receipts", label: "Receipts", count: recentGrns.length },
    { key: "issues", label: "Issues", count: issues.length },
    { key: "transfers", label: "Transfers", count: transfersIn.length + transfersOut.length },
    { key: "stacking", label: "Stacking", count: stacking.length },
    { key: "locations", label: "Bins", count: store.locations.length },
  ];

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Operations", href: "/stores" },
          { label: "Stores", href: "/stores" },
          { label: store.name },
        ]}
      />

      <PageHeader
        eyebrow={`${store.entity.code} · ${humanize(store.kind)}`}
        title={store.name}
        meta={
          <>
            <MetaItem label="Code">
              <span className="mono">{store.code}</span>
            </MetaItem>
            <MetaItem label="Status">
              <StatusBadge status={store.active ? "ACTIVE" : "INACTIVE"} />
            </MetaItem>
            <MetaItem label="Manager">{manager?.name ?? "Unassigned"}</MetaItem>
            <MetaItem label="City">{store.city ?? "—"}</MetaItem>
            {store.site && <MetaItem label="Site">{store.site.name}</MetaItem>}
            {store.project && <MetaItem label="Project">{store.project.name}</MetaItem>}
          </>
        }
        actions={
          <>
            {userHasPermission(user, P.STORE_ISSUE) && (
              <Link href={`/issuance/new?storeId=${store.id}`} className="btn btn-secondary btn-sm">
                Issue stock
              </Link>
            )}
            {userHasPermission(user, P.STORE_TRANSFER) && (
              <Link href={`/transfers/new?fromStoreId=${store.id}`} className="btn btn-secondary btn-sm">
                Transfer out
              </Link>
            )}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Stock value" value={money(totalValue, "PKR", { compact: true })} tone="accent" />
        <StatTile label="Stock lines" value={stock.length} hint={`${store.locations.length} bin(s) configured`} />
        <StatTile
          label="Below reorder"
          value={belowReorder.length}
          tone={belowReorder.length ? "warning" : "default"}
        />
        <StatTile
          label="Expiring within 60 days"
          value={expiring.length}
          tone={expiring.length ? "danger" : "default"}
        />
        <StatTile
          label="Unassigned to a bin"
          value={unbinned.length}
          hint="In stock but no location recorded"
          tone={unbinned.length ? "warning" : "default"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <SectionCard title="Store detail">
          <DefList
            columns={2}
            items={[
              { label: "Entity", value: `${store.entity.code} — ${store.entity.name}` },
              { label: "Kind", value: humanize(store.kind) },
              { label: "Address", value: store.address ?? "—", span: true },
              { label: "Manager", value: manager ? `${manager.name}${manager.title ? ` — ${manager.title}` : ""}` : "Unassigned" },
              { label: "Manager email", value: manager?.email ?? "—" },
              { label: "GRNs posted here", value: String(store._count.grns) },
              { label: "Gate passes", value: String(store._count.gatePasses) },
              { label: "Receipts", value: String(store._count.deliveries) },
              { label: "Issues raised", value: String(store._count.issues) },
            ]}
          />
        </SectionCard>
        <SectionCard title="Handling classes in use" description="Bins configured for special handling">
          {store.locations.length === 0 ? (
            <p className="text-xs text-[var(--c-text-secondary)]">No bin locations configured for this store.</p>
          ) : (
            <ul className="space-y-1.5">
              {Object.entries(
                store.locations.reduce<Record<string, number>>((acc, l) => {
                  acc[l.handling] = (acc[l.handling] ?? 0) + 1;
                  return acc;
                }, {}),
              ).map(([h, n]) => (
                <li key={h} className="flex items-baseline justify-between gap-3 text-xs">
                  <Badge
                    tone={
                      h === "HIGH_VALUE"
                        ? "accent"
                        : h === "HAZARDOUS"
                          ? "danger"
                          : h === "SENSITIVE"
                            ? "warning"
                            : "neutral"
                    }
                  >
                    {humanize(h)}
                  </Badge>
                  <span className="tnum font-500">{n} bin(s)</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <div>
        <TabNav tabs={tabs} active={tab} baseHref={`/stores/${store.id}`} />
        <div className="pt-4">
          {tab === "stock" && (
            <DataTable
              id={`store-stock-${store.id}`}
              columns={stockColumns}
              rows={stockRows}
              defaultSort={{ key: "value", dir: "desc" }}
              exportName={`stock-${store.code}`}
              emptyState={
                <EmptyState
                  title="No stock held"
                  description="Stock appears here once a GRN is posted or a transfer is received into this store."
                />
              }
            />
          )}

          {tab === "movements" && (
            <SectionCard
              title="Inventory ledger"
              description="Every movement in and out of this store, newest first. Balances derive from these entries."
              bodyClassName="px-0 py-0"
            >
              {recentTxns.length === 0 ? (
                <EmptyState compact title="No movements yet" />
              ) : (
                <div className="table-wrap max-h-[36rem] overflow-y-auto">
                  <table className="dt">
                    <thead>
                      <tr>
                        <th>Transaction</th>
                        <th>Type</th>
                        <th>Item</th>
                        <th className="text-right">Quantity</th>
                        <th className="text-right">Unit cost</th>
                        <th className="text-right">Value</th>
                        <th className="text-right">Balance after</th>
                        <th>Source</th>
                        <th>Reason</th>
                        <th>When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentTxns.map((t) => (
                        <tr key={t.id}>
                          <td className="mono text-2xs">{t.number}</td>
                          <td>
                            <Badge tone={t.quantity >= 0 ? "success" : "danger"}>{humanize(t.type)}</Badge>
                          </td>
                          <td className="text-xs">
                            {t.item.name}
                            <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{t.item.sku}</span>
                          </td>
                          <td className="num font-500">
                            <span className={t.quantity < 0 ? "text-[var(--c-danger)]" : "text-[var(--c-success)]"}>
                              {t.quantity > 0 ? "+" : ""}
                              {qty(t.quantity, t.unit)}
                            </span>
                          </td>
                          <td className="num text-xs">{money(t.unitCost)}</td>
                          <td className="num text-xs">{money(t.value)}</td>
                          <td className="num text-xs">{qty(t.balanceAfter)}</td>
                          <td className="text-2xs">
                            {humanize(t.sourceType)}
                            {t.sourceRef && <span className="mono block">{t.sourceRef}</span>}
                          </td>
                          <td className="max-w-[16rem] truncate text-2xs text-[var(--c-text-secondary)]" title={t.reason ?? ""}>
                            {t.reason ?? "—"}
                          </td>
                          <td className="text-2xs">{fmtDateTime(t.performedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          )}

          {tab === "receipts" && (
            <SectionCard title="Goods received here" bodyClassName="px-0 py-0">
              {recentGrns.length === 0 ? (
                <EmptyState compact title="No receipts" />
              ) : (
                <div className="table-wrap">
                  <table className="dt">
                    <thead>
                      <tr>
                        <th>GRN</th>
                        <th>PO</th>
                        <th>Vendor</th>
                        <th>Status</th>
                        <th className="text-right">Value</th>
                        <th>Received</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentGrns.map((g) => (
                        <tr key={g.id}>
                          <td>
                            <RefLink href={`/grn/${g.id}`}>{g.number}</RefLink>
                          </td>
                          <td>
                            <RefLink href={`/po/${g.po.id}`}>{g.po.number}</RefLink>
                          </td>
                          <td className="text-xs">{g.vendor.name}</td>
                          <td>
                            <StatusBadge status={g.status} />
                          </td>
                          <td className="num">{money(g.totalValue)}</td>
                          <td className="text-xs">{fmtDateTime(g.receivedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          )}

          {tab === "issues" && (
            <SectionCard title="Stock issued from here" bodyClassName="px-0 py-0">
              {issues.length === 0 ? (
                <EmptyState compact title="No issues raised" />
              ) : (
                <div className="table-wrap">
                  <table className="dt">
                    <thead>
                      <tr>
                        <th>Issue</th>
                        <th>Recipient</th>
                        <th>Purpose</th>
                        <th>Status</th>
                        <th className="text-right">Lines</th>
                        <th>Requested by</th>
                        <th>Requested</th>
                      </tr>
                    </thead>
                    <tbody>
                      {issues.map((i) => (
                        <tr key={i.id}>
                          <td>
                            <RefLink href={`/issuance/${i.id}`}>{i.number}</RefLink>
                          </td>
                          <td className="text-xs">{i.recipientName}</td>
                          <td className="max-w-[18rem] truncate text-xs">{i.purpose ?? "—"}</td>
                          <td>
                            <StatusBadge status={i.status} />
                          </td>
                          <td className="num">{i.items.length}</td>
                          <td className="text-xs">{i.requestedBy.name}</td>
                          <td className="text-2xs">{fmtDateTime(i.requestedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          )}

          {tab === "transfers" && (
            <div className="space-y-4">
              <SectionCard title="Inbound transfers" bodyClassName="px-0 py-0">
                {transfersIn.length === 0 ? (
                  <EmptyState compact title="No inbound transfers" />
                ) : (
                  <div className="table-wrap">
                    <table className="dt">
                      <thead>
                        <tr>
                          <th>Transfer</th>
                          <th>From</th>
                          <th>Status</th>
                          <th className="text-right">Lines</th>
                          <th>Requested</th>
                        </tr>
                      </thead>
                      <tbody>
                        {transfersIn.map((t) => (
                          <tr key={t.id}>
                            <td>
                              <RefLink href={`/transfers/${t.id}`}>{t.number}</RefLink>
                            </td>
                            <td className="text-xs">{t.fromStore.name}</td>
                            <td>
                              <StatusBadge status={t.status} />
                            </td>
                            <td className="num">{t.items.length}</td>
                            <td className="text-2xs">{fmtDateTime(t.requestedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </SectionCard>
              <SectionCard title="Outbound transfers" bodyClassName="px-0 py-0">
                {transfersOut.length === 0 ? (
                  <EmptyState compact title="No outbound transfers" />
                ) : (
                  <div className="table-wrap">
                    <table className="dt">
                      <thead>
                        <tr>
                          <th>Transfer</th>
                          <th>To</th>
                          <th>Status</th>
                          <th className="text-right">Lines</th>
                          <th>Requested</th>
                        </tr>
                      </thead>
                      <tbody>
                        {transfersOut.map((t) => (
                          <tr key={t.id}>
                            <td>
                              <RefLink href={`/transfers/${t.id}`}>{t.number}</RefLink>
                            </td>
                            <td className="text-xs">{t.toStore.name}</td>
                            <td>
                              <StatusBadge status={t.status} />
                            </td>
                            <td className="num">{t.items.length}</td>
                            <td className="text-2xs">{fmtDateTime(t.requestedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </SectionCard>
            </div>
          )}

          {tab === "stacking" && (
            <SectionCard title="Stacking record" description="Where received material was put away" bodyClassName="px-0 py-0">
              {stacking.length === 0 ? (
                <EmptyState compact title="No stacking recorded" />
              ) : (
                <div className="table-wrap">
                  <table className="dt">
                    <thead>
                      <tr>
                        <th>GRN</th>
                        <th>Material</th>
                        <th className="text-right">Quantity</th>
                        <th>Bin</th>
                        <th>Method</th>
                        <th>Class</th>
                        <th style={{ minWidth: "16rem" }}>Handling</th>
                        <th>Stacked by</th>
                        <th>When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stacking.map((s) => (
                        <tr key={s.id}>
                          <td>{s.grn ? <RefLink href={`/grn/${s.grn.id}`}>{s.grn.number}</RefLink> : "—"}</td>
                          <td className="text-xs">{s.description}</td>
                          <td className="num text-xs">{qty(s.quantity, s.unit)}</td>
                          <td className="text-xs">{s.location?.label ?? "Unassigned"}</td>
                          <td className="text-xs">{humanize(s.stackingMethod)}</td>
                          <td>
                            <Badge
                              tone={
                                s.goodsClass === "HIGH_VALUE"
                                  ? "accent"
                                  : s.goodsClass === "HAZARDOUS"
                                    ? "danger"
                                    : s.goodsClass === "SENSITIVE"
                                      ? "warning"
                                      : "neutral"
                              }
                            >
                              {humanize(s.goodsClass)}
                            </Badge>
                          </td>
                          <td className="text-2xs text-[var(--c-text-secondary)]">{s.handlingRequirements ?? "—"}</td>
                          <td className="text-xs">{s.stackedBy.name}</td>
                          <td className="text-2xs">{fmtDateTime(s.stackedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          )}

          {tab === "locations" && (
            <SectionCard
              title="Bin locations"
              description="Zones, racks and bins configured for this store"
              actions={
                userHasPermission(user, P.MASTER_DATA_MANAGE) && (
                  <Link href="/admin/stores" className="btn btn-ghost btn-xs">
                    Manage
                  </Link>
                )
              }
              bodyClassName="px-0 py-0"
            >
              {store.locations.length === 0 ? (
                <EmptyState compact title="No bins configured" description="Stock can still be held, but not located." />
              ) : (
                <div className="table-wrap">
                  <table className="dt">
                    <thead>
                      <tr>
                        <th>Label</th>
                        <th>Zone</th>
                        <th>Rack</th>
                        <th>Bin</th>
                        <th>Handling class</th>
                        <th className="text-right">Capacity</th>
                        <th className="text-right">Stock lines</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {store.locations.map((l) => {
                        const lines = stock.filter((s) => s.locationLabel === l.label).length;
                        return (
                          <tr key={l.id}>
                            <td className="mono">{l.label}</td>
                            <td className="text-xs">{l.zone ?? "—"}</td>
                            <td className="text-xs">{l.rack ?? "—"}</td>
                            <td className="text-xs">{l.bin ?? "—"}</td>
                            <td>
                              <Badge
                                tone={
                                  l.handling === "HIGH_VALUE"
                                    ? "accent"
                                    : l.handling === "HAZARDOUS"
                                      ? "danger"
                                      : l.handling === "SENSITIVE"
                                        ? "warning"
                                        : "neutral"
                                }
                              >
                                {humanize(l.handling)}
                              </Badge>
                            </td>
                            <td className="num text-xs">{l.capacity !== null ? amount(l.capacity, 0) : "—"}</td>
                            <td className="num text-xs">{lines}</td>
                            <td>
                              <StatusBadge status={l.active ? "ACTIVE" : "INACTIVE"} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          )}
        </div>
      </div>
    </div>
  );
}
