import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext, first, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { listStock } from "@/server/inventory";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, PageHeader, RefLink, SectionCard, StatTile } from "@/components/ui/primitives";
import { ChartFrame, ChartTable, DonutChart, RankedBars } from "@/components/ui/charts";
import { AdjustStockForm } from "./AdjustStockForm";
import { humanize } from "@/lib/domain";
import { fmtDate, fmtDateTime, money, qty, round2 } from "@/lib/format";

export const metadata = { title: "Inventory" };
export const dynamic = "force-dynamic";

export default async function InventoryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, ctx, authorized } = await pageContext(P.INVENTORY_VIEW);
  if (!authorized) {
    return <AccessDenied title="Inventory" message="You do not have permission to view inventory." />;
  }

  const sp = await searchParams;
  const itemFilter = first(sp.item);
  const scoped = visibleEntityIds(user);

  const stores = await prisma.store.findMany({
    where: { ...(ctx.entityId ? { entityId: ctx.entityId } : scoped ? { entityId: { in: scoped } } : {}) },
    select: { id: true, code: true, name: true, kind: true, entity: { select: { code: true } } },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
  const storeIds = stores.map((s) => s.id);

  const [stock, recentTxns, savedViews, items] = await Promise.all([
    listStock({ storeIds, ...(itemFilter ? { itemId: itemFilter } : {}) }),
    prisma.inventoryTransaction.findMany({
      where: { storeId: { in: storeIds } },
      orderBy: { performedAt: "desc" },
      take: 40,
      include: { item: { select: { sku: true, name: true } }, store: { select: { name: true } } },
    }),
    prisma.savedView.findMany({
      where: { resource: "inventory", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
    prisma.item.findMany({
      where: { active: true },
      select: { id: true, sku: true, name: true, unit: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const totalValue = round2(stock.reduce((a, s) => a + s.totalValue, 0));
  const belowReorder = stock.filter((s) => s.belowReorder);
  const expiring = stock.filter((s) => s.expiringSoon);
  const unbinned = stock.filter((s) => !s.locationLabel && s.quantity > 0);
  const zeroValue = stock.filter((s) => s.quantity > 0 && s.unitCost === 0);

  const byStore = new Map<string, { label: string; value: number; count: number }>();
  const byCategory = new Map<string, { label: string; value: number; count: number }>();
  for (const s of stock) {
    const st = byStore.get(s.storeId) ?? { label: s.storeName, value: 0, count: 0 };
    st.value = round2(st.value + s.totalValue);
    st.count += 1;
    byStore.set(s.storeId, st);
    const ct = byCategory.get(s.categoryName) ?? { label: s.categoryName, value: 0, count: 0 };
    ct.value = round2(ct.value + s.totalValue);
    ct.count += 1;
    byCategory.set(s.categoryName, ct);
  }
  const storeValues = [...byStore.values()].sort((a, b) => b.value - a.value);
  const categoryValues = [...byCategory.values()].sort((a, b) => b.value - a.value);

  const columns: TableColumn[] = [
    { key: "sku", header: "SKU", locked: true, sortable: true, width: "10rem" },
    { key: "item", header: "Item", sortable: true, minWidth: "18rem" },
    { key: "category", header: "Category", filterable: true, sortable: true, width: "13rem" },
    { key: "store", header: "Store", filterable: true, sortable: true, width: "14rem" },
    { key: "storeKind", header: "Store type", filterable: true, sortable: true, width: "11rem", defaultHidden: true },
    { key: "location", header: "Bin", sortable: true, width: "9rem" },
    { key: "batch", header: "Batch", sortable: true, width: "11rem", defaultHidden: true },
    { key: "serial", header: "Serial", sortable: true, width: "11rem", defaultHidden: true },
    { key: "quantity", header: "On hand", numeric: true, sortable: true, width: "8rem" },
    { key: "available", header: "Available", numeric: true, sortable: true, width: "8rem" },
    { key: "unitCost", header: "Unit cost", numeric: true, sortable: true, width: "9rem" },
    { key: "value", header: "Value", numeric: true, sortable: true, width: "10rem" },
    { key: "reorder", header: "Reorder level", numeric: true, sortable: true, width: "9.5rem", defaultHidden: true },
    { key: "expiry", header: "Expiry", sortable: true, width: "8.5rem" },
    { key: "warranty", header: "Warranty until", sortable: true, width: "9.5rem", defaultHidden: true },
    { key: "project", header: "Project", filterable: true, sortable: true, width: "12rem", defaultHidden: true },
    { key: "flags", header: "Flags", sortable: false, width: "12rem" },
  ];

  const rows: TableRow[] = stock.map((s) => ({
    id: s.id,
    href: `/stores/${s.storeId}`,
    flag: s.expiringSoon ? "danger" : s.belowReorder ? "warning" : null,
    search: `${s.sku} ${s.itemName} ${s.storeName} ${s.batchNumber ?? ""} ${s.serialNumber ?? ""}`,
    values: {
      sku: s.sku,
      item: s.itemName,
      category: s.categoryName,
      store: s.storeName,
      storeKind: humanize(s.storeKind),
      location: s.locationLabel ?? "Unassigned",
      batch: s.batchNumber ?? "",
      serial: s.serialNumber ?? "",
      quantity: s.quantity,
      available: s.available,
      unitCost: s.unitCost,
      value: s.totalValue,
      reorder: s.reorderLevel ?? 0,
      expiry: s.expiryDate ? s.expiryDate.toISOString().slice(0, 10) : "",
      warranty: s.warrantyUntil ? s.warrantyUntil.toISOString().slice(0, 10) : "",
      project: s.projectName ?? "",
      flags: [s.belowReorder ? "Below reorder" : "", s.expiringSoon ? "Expiring" : ""].filter(Boolean).join(" "),
    },
    cells: {
      sku: <span className="mono">{s.sku}</span>,
      item: s.itemName,
      category: s.categoryName,
      store: <RefLink href={`/stores/${s.storeId}`}>{s.storeName}</RefLink>,
      storeKind: humanize(s.storeKind),
      location: s.locationLabel ? (
        <Badge tone="neutral">{s.locationLabel}</Badge>
      ) : (
        <span className="text-2xs text-[var(--c-text-tertiary)]">Unassigned</span>
      ),
      batch: s.batchNumber ?? "—",
      serial: s.serialNumber ?? "—",
      quantity: qty(s.quantity, s.unit),
      available: <span className="font-500">{qty(s.available)}</span>,
      unitCost: money(s.unitCost),
      value: money(s.totalValue),
      reorder: s.reorderLevel !== null ? qty(s.reorderLevel) : "—",
      expiry: s.expiryDate ? (
        <span className={s.expiringSoon ? "text-[var(--c-danger)]" : undefined}>{fmtDate(s.expiryDate)}</span>
      ) : (
        "—"
      ),
      warranty: s.warrantyUntil ? fmtDate(s.warrantyUntil) : "—",
      project: s.projectName ?? "—",
      flags: (
        <span className="flex flex-wrap gap-1">
          {s.belowReorder && <Badge tone="warning">Below reorder</Badge>}
          {s.expiringSoon && <Badge tone="danger">Expiring</Badge>}
          {s.reservedQty > 0 && <Badge tone="info">{qty(s.reservedQty)} reserved</Badge>}
        </span>
      ),
    },
  }));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Operations"
        title="Inventory"
        subtitle="Stock across every store you can access. Balances derive entirely from the movement ledger — they cannot be edited directly."
        actions={
          <>
            <Link href="/stores" className="btn btn-secondary btn-sm">
              Stores
            </Link>
            {userHasPermission(user, P.INVENTORY_ADJUST) && (
              <AdjustStockForm stores={stores} items={items} />
            )}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Inventory value" value={money(totalValue, "PKR", { compact: true })} tone="accent" />
        <StatTile label="Stock lines" value={stock.length} hint={`Across ${storeValues.length} store(s)`} />
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
          tone={unbinned.length ? "warning" : "default"}
        />
      </div>

      {(belowReorder.length > 0 || expiring.length > 0 || zeroValue.length > 0) && (
        <SectionCard title="Requires attention" bodyClassName="px-0 py-0">
          <div className="grid gap-0 lg:grid-cols-3">
            <div className="border-b border-[var(--c-border-subtle)] px-4 py-3 lg:border-r lg:border-b-0">
              <div className="label mb-2">Below reorder level</div>
              {belowReorder.length === 0 ? (
                <p className="text-2xs text-[var(--c-text-tertiary)]">Nothing below its reorder level.</p>
              ) : (
                <ul className="space-y-1">
                  {belowReorder.slice(0, 6).map((s) => (
                    <li key={s.id} className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate">
                        {s.itemName}
                        <span className="block text-2xs text-[var(--c-text-tertiary)]">{s.storeName}</span>
                      </span>
                      <span className="tnum shrink-0 text-[var(--c-warning)]">
                        {qty(s.quantity)} / {qty(s.reorderLevel ?? 0)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="border-b border-[var(--c-border-subtle)] px-4 py-3 lg:border-r lg:border-b-0">
              <div className="label mb-2">Expiring soon</div>
              {expiring.length === 0 ? (
                <p className="text-2xs text-[var(--c-text-tertiary)]">Nothing expiring within 60 days.</p>
              ) : (
                <ul className="space-y-1">
                  {expiring.slice(0, 6).map((s) => (
                    <li key={s.id} className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate">
                        {s.itemName}
                        <span className="block text-2xs text-[var(--c-text-tertiary)]">{s.storeName}</span>
                      </span>
                      <span className="tnum shrink-0 text-[var(--c-danger)]">{fmtDate(s.expiryDate)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="px-4 py-3">
              <div className="label mb-2">Zero-valued stock</div>
              {zeroValue.length === 0 ? (
                <p className="text-2xs text-[var(--c-text-tertiary)]">Every stock line carries a cost.</p>
              ) : (
                <ul className="space-y-1">
                  {zeroValue.slice(0, 6).map((s) => (
                    <li key={s.id} className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate">
                        {s.itemName}
                        <span className="block text-2xs text-[var(--c-text-tertiary)]">{s.storeName}</span>
                      </span>
                      <span className="tnum shrink-0">{qty(s.quantity)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </SectionCard>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartFrame
          title="Value by store"
          tableView={
            <ChartTable columns={["Store", "Value", "Lines"]} rows={storeValues.map((s) => [s.label, money(s.value), s.count])} />
          }
        >
          <RankedBars
            data={storeValues.map((s) => ({ label: s.label, value: s.value, sub: `${s.count} lines` }))}
            format="moneyCompact"
            maxRows={8}
            colorIndex={1}
          />
        </ChartFrame>
        <ChartFrame
          title="Value by category"
          tableView={
            <ChartTable
              columns={["Category", "Value", "Lines"]}
              rows={categoryValues.map((s) => [s.label, money(s.value), s.count])}
            />
          }
        >
          <DonutChart
            data={categoryValues.slice(0, 8).map((c) => ({ label: c.label, value: c.value }))}
            format="moneyCompact"
            centerLabel="Inventory value"
          />
        </ChartFrame>
      </div>

      <DataTable
        id="inventory"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "value", dir: "desc" }}
        exportName="inventory"
        emptyState={
          <EmptyState
            title="No stock on hand"
            description="Inventory is created only by posting a GRN, receiving a transfer, booking a petty cash purchase into store, or an explicit adjustment."
          />
        }
      />

      <SectionCard
        title="Latest movements"
        description="The most recent ledger entries across all stores"
        actions={
          <Link href="/analytics/audit" className="btn btn-ghost btn-xs">
            Full audit trail
          </Link>
        }
        bodyClassName="px-0 py-0"
      >
        {recentTxns.length === 0 ? (
          <EmptyState compact title="No movements yet" />
        ) : (
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Transaction</th>
                  <th>Type</th>
                  <th>Item</th>
                  <th>Store</th>
                  <th className="text-right">Quantity</th>
                  <th className="text-right">Balance after</th>
                  <th>Source</th>
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
                    <td className="text-xs">{t.store.name}</td>
                    <td className="num font-500">
                      <span className={t.quantity < 0 ? "text-[var(--c-danger)]" : "text-[var(--c-success)]"}>
                        {t.quantity > 0 ? "+" : ""}
                        {qty(t.quantity, t.unit)}
                      </span>
                    </td>
                    <td className="num text-xs">{qty(t.balanceAfter)}</td>
                    <td className="text-2xs">
                      {humanize(t.sourceType)}
                      {t.sourceRef && <span className="mono block">{t.sourceRef}</span>}
                    </td>
                    <td className="text-2xs">{fmtDateTime(t.performedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
