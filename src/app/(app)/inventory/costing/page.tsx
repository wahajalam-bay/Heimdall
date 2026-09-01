import { prisma } from "@/lib/db";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  InlineAlert,
  Mono,
  PageHeader,
  SectionCard,
  StatTile,
} from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/DataTable";
import { money, amount, fmtDate } from "@/lib/format";
import { costingPolicy, fifoValuation, openLayers } from "@/server/costing";

export const metadata = { title: "Inventory costing" };
export const dynamic = "force-dynamic";

/**
 * FIFO cost layers against the weighted average the buckets carry.
 *
 * The page exists for the gap between the two columns. Where they agree, prices
 * have not moved and the method does not matter; where they diverge, stock is
 * being carried at a number nobody paid, and every issue out of it lands the
 * difference in cost of sales.
 */
export default async function InventoryCostingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { ctx, authorized } = await pageContext(P.INVENTORY_VIEW);
  if (!authorized) {
    return <AccessDenied title="Inventory costing" message="You do not have access to inventory." />;
  }

  const sp = await searchParams;
  const storeId = first(sp.store) ?? null;

  const [policy, rows, layers, stores] = await Promise.all([
    costingPolicy(ctx.entityId, new Date()),
    fifoValuation({ storeId, entityIds: visibleEntityIds(ctx.user) }),
    openLayers({ storeId: storeId ?? undefined, entityIds: visibleEntityIds(ctx.user) }),
    prisma.store.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const fifoTotal = rows.reduce((a, r) => a + r.fifoValue, 0);
  const avgTotal = rows.reduce((a, r) => a + r.averageValue, 0);
  const diverging = rows.filter((r) => Math.abs(r.difference) >= 1);
  const unlayered = rows.filter((r) => r.unlayeredQty > 0);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Stores", href: "/inventory" }, { label: "Costing" }]} />

      <PageHeader
        eyebrow="Stores"
        title="Inventory costing"
        subtitle="What the stock on hand cost, layer by layer, against the weighted average the buckets carry. FIFO decides what a carton is valued at; FEFO decides which carton leaves the shelf. They are different questions and the system keeps them apart."
      />

      {!policy.active ? (
        <InlineAlert tone="warning">
          Cost layers have not started. Set a start date under Business rules → Stores → &ldquo;Cost layers
          begin&rdquo; and every receipt from that date opens a layer. Stock received before it has no layer and
          never will, so this page will show that quantity as unlayered rather than valuing it at a price nobody
          paid.
        </InlineAlert>
      ) : (
        <InlineAlert tone="info">
          Layers began {fmtDate(policy.from!)}. Issues are valued at{" "}
          <strong>{policy.method === "FIFO" ? "FIFO" : "weighted average"}</strong>, which is what the ledger&rsquo;s
          value column holds. The FIFO figure is recorded alongside either way, so switching the method changes what
          future issues cost without restating a single posted row.
        </InlineAlert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="FIFO value of stock" value={money(fifoTotal)} hint={`${layers.length} open layers`} />
        <StatTile label="Weighted-average value" value={money(avgTotal)} hint={`${rows.length} item-store lines`} />
        <StatTile
          label="Difference"
          value={money(fifoTotal - avgTotal)}
          hint={fifoTotal >= avgTotal ? "FIFO carries it higher" : "FIFO carries it lower"}
          tone={Math.abs(fifoTotal - avgTotal) >= 1 ? "warning" : undefined}
        />
        <StatTile
          label="Unlayered stock"
          value={unlayered.length}
          hint={unlayered.length ? "Received before the cutover" : "None"}
          tone={unlayered.length ? "warning" : undefined}
        />
      </div>

      <div className="card flex flex-row flex-wrap items-end gap-3 px-3.5 py-3">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="min-w-[14rem]">
            <span className="label mb-1 block">Store</span>
            <select className="field" name="store" defaultValue={storeId ?? ""}>
              <option value="">All stores</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-primary btn-sm">
            Show
          </button>
        </form>
      </div>

      {diverging.length > 0 && (
        <InlineAlert tone="warning">
          {diverging.length} item{diverging.length === 1 ? "" : "s"} {diverging.length === 1 ? "is" : "are"} carried
          at a materially different figure under the two methods. That difference is real money: it goes into cost of
          sales the moment the stock is issued.
        </InlineAlert>
      )}

      <DataTable
        id="inventory-costing"
        columns={[
          { key: "sku", header: "Item", sortable: true, filterable: false },
          { key: "store", header: "Store", filterable: true, sortable: true, width: "12rem" },
          { key: "onHand", header: "On hand", sortable: true, align: "right", width: "8rem" },
          { key: "layered", header: "Layered", sortable: true, align: "right", width: "8rem" },
          { key: "fifo", header: "FIFO value", sortable: true, align: "right", width: "10rem" },
          { key: "avg", header: "Average value", sortable: true, align: "right", width: "10rem" },
          { key: "diff", header: "Difference", sortable: true, align: "right", width: "10rem" },
        ]}
        rows={rows.map((r) => ({
          id: `${r.itemId}|${r.storeId}`,
          search: `${r.sku} ${r.name} ${r.storeName}`,
          flag: r.unlayeredQty > 0 ? ("warning" as const) : null,
          cells: {
            sku: (
              <>
                {r.name}
                <Mono className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{r.sku}</Mono>
              </>
            ),
            store: r.storeName,
            onHand: `${amount(r.bucketQty, 2)} ${r.unit}`,
            layered:
              r.unlayeredQty > 0 ? (
                <>
                  {amount(r.layeredQty, 2)}
                  <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                    {amount(r.unlayeredQty, 2)} unlayered
                  </span>
                </>
              ) : (
                amount(r.layeredQty, 2)
              ),
            fifo: r.layeredQty > 0 ? money(r.fifoValue) : "—",
            avg: money(r.averageValue),
            diff:
              r.unlayeredQty > 0 ? (
                <span className="text-[var(--c-text-tertiary)]">Not comparable</span>
              ) : Math.abs(r.difference) < 0.01 ? (
                "—"
              ) : (
                <Badge tone={r.difference > 0 ? "warning" : "info"}>{money(r.difference)}</Badge>
              ),
          },
          values: {
            sku: r.sku,
            store: r.storeName,
            onHand: r.bucketQty,
            layered: r.layeredQty,
            fifo: r.fifoValue,
            avg: r.averageValue,
            diff: r.difference,
          },
        }))}
        emptyState={
          policy.active
            ? "No stock on hand for this filter."
            : "No cost layers yet. They begin on the date set under Business rules."
        }
      />

      <SectionCard
        title="Open layers"
        description="Every receipt still holding stock, oldest first — the order the next issue will draw them in."
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ minWidth: "12rem" }}>Item</th>
                <th style={{ width: "11rem" }}>Store</th>
                <th style={{ width: "9rem" }}>Received</th>
                <th style={{ minWidth: "10rem" }}>Source</th>
                <th style={{ width: "8rem" }} className="text-right">
                  Received qty
                </th>
                <th style={{ width: "8rem" }} className="text-right">
                  Remaining
                </th>
                <th style={{ width: "8rem" }} className="text-right">
                  Unit cost
                </th>
                <th style={{ width: "9rem" }} className="text-right">
                  Value
                </th>
              </tr>
            </thead>
            <tbody>
              {layers.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-[var(--c-text-tertiary)]">
                    No open layers.
                  </td>
                </tr>
              )}
              {layers.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.item.name}
                    <Mono className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{l.item.sku}</Mono>
                  </td>
                  <td>{l.store.name}</td>
                  <td>{fmtDate(l.receivedAt)}</td>
                  <td className="text-2xs">{l.sourceRef ?? l.sourceType}</td>
                  <td className="tnum text-right">{amount(l.quantityReceived, 2)}</td>
                  <td className="tnum text-right">{amount(l.quantityRemaining, 2)}</td>
                  <td className="tnum text-right">{money(l.unitCost)}</td>
                  <td className="tnum text-right">{money(l.quantityRemaining * l.unitCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        A layer is one receipt at the price that receipt was bought at. An issue draws the oldest layers first and
        records which layer each unit came from, so the FIFO figure can be checked against the receipts rather than
        taken on trust. Physical picking still follows earliest expiry — the two can legitimately disagree, and a
        carton picked for its expiry date may be valued against an older, cheaper layer.
      </p>
    </div>
  );
}
