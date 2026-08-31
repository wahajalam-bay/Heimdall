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
  RefLink,
  SectionCard,
  StatTile,
} from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/DataTable";
import { money, amount, fmtDate } from "@/lib/format";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { inventoryAgeing, summariseByBand } from "@/server/ageing";

export const metadata = { title: "Inventory ageing" };
export const dynamic = "force-dynamic";

/**
 * Ageing and expiry, side by side but not conflated.
 *
 * Ageing asks how long money has been sitting on a shelf. Expiry asks how long
 * the goods remain usable. The same carton can be old and fine, new and about to
 * expire, both, or neither — so they are separate columns and separate warnings.
 */
export default async function InventoryAgeingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { ctx, authorized } = await pageContext(P.INVENTORY_VIEW);
  if (!authorized) {
    return <AccessDenied title="Inventory ageing" message="You do not have access to inventory." />;
  }

  const sp = await searchParams;
  const storeId = first(sp.store) ?? null;
  const categoryId = first(sp.category) ?? null;
  const minAge = first(sp.minAge) ? Number(first(sp.minAge)) : null;

  const nearExpiryDays = await getConfigNumber(CONFIG_KEYS.NEAR_EXPIRY_DAYS, ctx.entityId);

  const [{ rows, bands }, stores, categories] = await Promise.all([
    inventoryAgeing({
      entityIds: visibleEntityIds(ctx.user),
      storeId,
      categoryId,
      minAgeDays: minAge,
      nearExpiryDays,
    }),
    prisma.store.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.category.findMany({ select: { id: true, name: true, code: true }, orderBy: { name: "asc" } }),
  ]);

  const byBand = summariseByBand(rows, bands);
  const totalValue = rows.reduce((a, r) => a + r.totalValue, 0);
  const expired = rows.filter((r) => r.expiryState === "EXPIRED");
  const nearExpiry = rows.filter((r) => r.expiryState === "NEAR_EXPIRY");
  const overYear = rows.filter((r) => (r.ageDays ?? 0) > 365);
  const stagnant = rows.filter((r) => (r.daysSinceMovement ?? 0) > 180);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Stores", href: "/inventory" }, { label: "Ageing" }]} />

      <PageHeader
        eyebrow="Stores"
        title="Inventory ageing"
        subtitle="How long stock has been held, and how long it remains usable. Age is taken from the earliest posted receipt into each bucket, so it is what the ledger says rather than an assumption."
      />

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
          <label className="min-w-[13rem]">
            <span className="label mb-1 block">Category</span>
            <select className="field" name="category" defaultValue={categoryId ?? ""}>
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-[10rem]">
            <span className="label mb-1 block">Older than</span>
            <select className="field" name="minAge" defaultValue={minAge ? String(minAge) : ""}>
              <option value="">Any age</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="180">180 days</option>
              <option value="365">One year</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary btn-sm">
            Show
          </button>
        </form>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Stock value held" value={money(totalValue)} hint={`${rows.length} buckets`} />
        <StatTile
          label="Held over a year"
          value={money(overYear.reduce((a, r) => a + r.totalValue, 0))}
          hint={`${overYear.length} buckets`}
          tone={overYear.length ? "warning" : undefined}
        />
        <StatTile
          label="Expired"
          value={expired.length}
          hint={expired.length ? money(expired.reduce((a, r) => a + r.totalValue, 0)) : "None"}
          tone={expired.length ? "danger" : undefined}
        />
        <StatTile
          label={`Expiring within ${nearExpiryDays} days`}
          value={nearExpiry.length}
          hint={nearExpiry.length ? money(nearExpiry.reduce((a, r) => a + r.totalValue, 0)) : "None"}
          tone={nearExpiry.length ? "warning" : undefined}
        />
      </div>

      {expired.length > 0 && (
        <InlineAlert tone="danger">
          {expired.length} bucket{expired.length === 1 ? "" : "s"} of stock has passed its expiry date, worth{" "}
          {money(expired.reduce((a, r) => a + r.totalValue, 0))}. Expired stock still counts as inventory until
          somebody writes it off, so this figure is on the balance sheet until it is dealt with.
        </InlineAlert>
      )}

      {stagnant.length > 0 && (
        <InlineAlert tone="warning">
          {stagnant.length} bucket{stagnant.length === 1 ? "" : "s"} has not moved in over six months. Age counts from
          receipt; this counts from the last movement either way, which is the better signal for stock nobody is
          asking for.
        </InlineAlert>
      )}

      <SectionCard
        title="Value by age band"
        description="Bands are configuration — see Business rules, group Stores."
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ minWidth: "10rem" }}>Band</th>
                <th style={{ width: "6rem" }} className="text-right">
                  Buckets
                </th>
                <th style={{ width: "8rem" }} className="text-right">
                  Quantity
                </th>
                <th style={{ width: "10rem" }} className="text-right">
                  Value
                </th>
                <th style={{ width: "7rem" }} className="text-right">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {byBand.map((b) => (
                <tr key={b.label}>
                  <td>{b.label}</td>
                  <td className="tnum text-right">{b.lines || "—"}</td>
                  <td className="tnum text-right">{b.quantity ? amount(b.quantity, 0) : "—"}</td>
                  <td className="tnum text-right">{b.value ? money(b.value) : "—"}</td>
                  <td className="tnum text-right">
                    {totalValue > 0 && b.value ? `${((b.value / totalValue) * 100).toFixed(1)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <DataTable
        id="inventory-ageing"
        columns={[
          { key: "sku", header: "Item", sortable: true, filterable: false },
          { key: "store", header: "Store", filterable: true, sortable: true, width: "12rem" },
          { key: "bin", header: "Bin", sortable: true, width: "7rem" },
          { key: "batch", header: "Batch / serial", sortable: true, width: "10rem" },
          { key: "qty", header: "Qty", sortable: true, align: "right", width: "7rem" },
          { key: "value", header: "Value", sortable: true, align: "right", width: "9rem" },
          { key: "received", header: "Received", sortable: true, width: "8rem" },
          { key: "age", header: "Age", sortable: true, align: "right", width: "6rem" },
          { key: "band", header: "Band", filterable: true, sortable: true, width: "9rem" },
          { key: "expiry", header: "Expiry", filterable: true, sortable: true, width: "10rem" },
          { key: "idle", header: "Unmoved", sortable: true, align: "right", width: "7rem" },
        ]}
        rows={rows.map((r) => ({
          id: r.id,
          search: `${r.sku} ${r.name} ${r.storeName} ${r.batchNumber ?? ""} ${r.serialNumber ?? ""}`,
          flag:
            r.expiryState === "EXPIRED"
              ? ("danger" as const)
              : r.expiryState === "NEAR_EXPIRY" || (r.ageDays ?? 0) > 365
                ? ("warning" as const)
                : null,
          cells: {
            sku: (
              <>
                {r.name}
                <Mono className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{r.sku}</Mono>
              </>
            ),
            store: r.storeName,
            bin: r.locationName ?? "—",
            batch: r.serialNumber ?? r.batchNumber ?? "—",
            qty: `${amount(r.quantity, 2)} ${r.unit}`,
            value: money(r.totalValue),
            received: r.grnId ? (
              <RefLink href={`/grn/${r.grnId}`}>{r.receivedAt ? fmtDate(r.receivedAt) : "—"}</RefLink>
            ) : (
              (r.receivedAt ? fmtDate(r.receivedAt) : "—")
            ),
            age: r.ageDays === null ? "—" : `${r.ageDays}d`,
            band: r.band,
            expiry:
              r.expiryState === "NOT_TRACKED" ? (
                <span className="text-[var(--c-text-tertiary)]">Not tracked</span>
              ) : (
                <>
                  <Badge
                    tone={
                      r.expiryState === "EXPIRED"
                        ? "danger"
                        : r.expiryState === "NEAR_EXPIRY"
                          ? "warning"
                          : "success"
                    }
                  >
                    {r.expiryState === "EXPIRED"
                      ? `${Math.abs(r.daysToExpiry ?? 0)}d ago`
                      : `${r.daysToExpiry}d`}
                  </Badge>
                  <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                    {r.expiryDate ? fmtDate(r.expiryDate) : ""}
                  </span>
                </>
              ),
            idle: r.daysSinceMovement === null ? "—" : `${r.daysSinceMovement}d`,
          },
          values: {
            sku: r.sku,
            store: r.storeName,
            bin: r.locationName ?? "—",
            batch: r.serialNumber ?? r.batchNumber ?? "—",
            qty: r.quantity,
            value: r.totalValue,
            received: r.receivedAt ? r.receivedAt.toISOString().slice(0, 10) : "",
            age: r.ageDays ?? -1,
            band: r.band,
            expiry:
              r.expiryState === "NOT_TRACKED" ? "Not tracked" : String(r.daysToExpiry ?? ""),
            idle: r.daysSinceMovement ?? -1,
          },
        }))}
        emptyState="No stock on hand for this filter."
      />

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        Age is the time since the earliest posted receipt into a bucket, read from the inventory ledger. Buckets with
        no receipt in the ledger show age as unknown rather than as zero — a missing fact and a fresh delivery are not
        the same thing.
      </p>
    </div>
  );
}
