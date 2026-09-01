import Link from "next/link";
import { prisma } from "@/lib/db";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
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
import { amount, fmtDate } from "@/lib/format";
import {
  MIN_STOCK_BASIS_LABELS,
  replenishmentQueue,
  suggestMinimums,
  type MinStockBasis,
} from "@/server/replenishment";
import { MinStockForm } from "./MinStockForm";

export const metadata = { title: "Replenishment" };
export const dynamic = "force-dynamic";

/**
 * What has reached its minimum, and what to order.
 *
 * ZAM/PUR/SOP-01 Store Flow: when the minimum is reached the Store Manager
 * alerts the relevant procurement associate and a requisition is raised. The
 * alert now fires on the issue that causes it; this is the standing list, for
 * anyone who wants to see the whole position rather than wait to be told.
 *
 * The system does not raise the requisition itself. The SOP says one is issued;
 * it does not say the system issues it, and a purchase requisition nobody chose
 * to raise is a commitment nobody owns.
 */
export default async function ReplenishmentPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { ctx, authorized } = await pageContext(P.INVENTORY_VIEW);
  if (!authorized) {
    return <AccessDenied title="Replenishment" message="You do not have access to inventory." />;
  }

  const sp = await searchParams;
  const storeId = first(sp.store) ?? null;
  const canSetMinimum = userHasPermission(ctx.user, P.MASTER_MANAGE, P.INVENTORY_ADJUST);

  const [rows, stores] = await Promise.all([
    replenishmentQueue({ entityIds: visibleEntityIds(ctx.user), storeId }),
    prisma.store.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const suggestions = await suggestMinimums(
    [...new Set(rows.map((r) => r.itemId))],
    { entityId: ctx.entityId, storeId },
  );

  const empty = rows.filter((r) => r.outOfStock);
  const unattributed = rows.filter((r) => !r.basis || r.basis === "MANUAL");

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Stores", href: "/inventory" }, { label: "Replenishment" }]} />

      <PageHeader
        eyebrow="Stores"
        title="Replenishment"
        subtitle="Items at or below their minimum stock level, with what the issue history says to order. ZAM/PUR/SOP-01 §3.3 allows a minimum derived from past consumption or set on a POC's advice — the two are different grounds, and each row says which one it rests on."
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="At or below minimum" value={rows.length} hint={storeId ? "This store" : "All stores"} />
        <StatTile
          label="Out of stock"
          value={empty.length}
          hint={empty.length ? "Nothing on the shelf" : "None"}
          tone={empty.length ? "danger" : undefined}
        />
        <StatTile
          label="Minimum set by hand"
          value={unattributed.length}
          hint={unattributed.length ? "No consumption or POC basis recorded" : "All attributed"}
          tone={unattributed.length ? "warning" : undefined}
        />
        <StatTile
          label="Suggestion available"
          value={[...suggestions.values()].filter((s) => s.suggested !== null).length}
          hint="From issue history"
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

      {empty.length > 0 && (
        <InlineAlert tone="danger">
          {empty.length} item{empty.length === 1 ? " has" : "s have"} nothing on the shelf. The alert went to
          procurement when the last unit was issued; this is what is still outstanding.
        </InlineAlert>
      )}

      {unattributed.length > 0 && (
        <InlineAlert tone="warning">
          {unattributed.length} minimum{unattributed.length === 1 ? "" : "s"} here {unattributed.length === 1 ? "is" : "are"}{" "}
          a figure somebody typed with no basis recorded. §3.3 gives two grounds — past consumption, or the department
          POC&rsquo;s advice — and a number nobody can attribute is a number nobody defends when the store runs out.
        </InlineAlert>
      )}

      <DataTable
        id="replenishment"
        columns={[
          { key: "sku", header: "Item", sortable: true, filterable: false },
          { key: "store", header: "Store", filterable: true, sortable: true, width: "11rem" },
          { key: "available", header: "Available", sortable: true, align: "right", width: "8rem" },
          { key: "minimum", header: "Minimum", sortable: true, align: "right", width: "8rem" },
          { key: "basis", header: "Basis", filterable: true, sortable: true, width: "12rem" },
          { key: "perMonth", header: "Used / month", sortable: true, align: "right", width: "9rem" },
          { key: "suggestMin", header: "Suggested min", sortable: true, align: "right", width: "10rem" },
          { key: "order", header: "Order", sortable: true, align: "right", width: "8rem" },
        ]}
        rows={rows.map((r) => {
          const sug = suggestions.get(r.itemId);
          return {
            id: `${r.itemId}|${r.storeId}`,
            search: `${r.sku} ${r.name} ${r.storeName}`,
            flag: r.outOfStock ? ("danger" as const) : ("warning" as const),
            cells: {
              sku: (
                <>
                  {r.name}
                  <Mono className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{r.sku}</Mono>
                </>
              ),
              store: r.storeName,
              available: (
                <>
                  {amount(r.available, 2)} {r.unit}
                  {r.reserved > 0 && (
                    <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                      {amount(r.reserved, 2)} reserved
                    </span>
                  )}
                </>
              ),
              minimum: `${amount(r.minimum, 2)} ${r.unit}`,
              basis: r.basis ? (
                <>
                  <Badge tone={r.basis === "MANUAL" ? "warning" : "info"}>
                    {MIN_STOCK_BASIS_LABELS[r.basis as MinStockBasis]}
                  </Badge>
                  {r.basisNote && (
                    <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{r.basisNote}</span>
                  )}
                </>
              ) : (
                <Badge tone="warning">Not recorded</Badge>
              ),
              perMonth: r.perMonth > 0 ? amount(r.perMonth, 2) : "—",
              suggestMin:
                sug?.suggested !== null && sug?.suggested !== undefined ? (
                  <>
                    {amount(sug.suggested, 2)}
                    <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                      {sug.leadTimeDays + sug.safetyDays}d cover
                    </span>
                  </>
                ) : (
                  <span className="text-2xs text-[var(--c-text-tertiary)]">{sug?.withheld ?? "—"}</span>
                ),
              order: <strong>{amount(r.suggestedOrderQty, 2)}</strong>,
            },
            values: {
              sku: r.sku,
              store: r.storeName,
              available: r.available,
              minimum: r.minimum,
              basis: r.basis ? MIN_STOCK_BASIS_LABELS[r.basis as MinStockBasis] : "Not recorded",
              perMonth: r.perMonth,
              suggestMin: sug?.suggested ?? -1,
              order: r.suggestedOrderQty,
            },
          };
        })}
        emptyState="Nothing is at or below its minimum. Items with no minimum set are not listed — a level nobody set cannot be reached."
      />

      {canSetMinimum && rows.length > 0 && (
        <SectionCard
          title="Record a minimum stock level"
          description="§3.3 allows two grounds. Consumption cites the ledger; POC advice must name who advised and what they said, or it is hearsay."
        >
          <MinStockForm
            items={rows.map((r) => ({
              id: r.itemId,
              label: `${r.sku} — ${r.name}`,
              current: r.minimum,
              suggested: suggestions.get(r.itemId)?.suggested ?? null,
              unit: r.unit,
            }))}
          />
        </SectionCard>
      )}

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        Availability is the balance less what is already reserved against an approved requisition. Counting reserved
        stock as cover is how a store reports itself healthy right up to the moment somebody collects. The order
        quantity brings the shelf back to its minimum plus a month of cover where the issue history says what a month
        is; without that history it is the shortfall alone, because padding it with a number nobody measured would be
        a guess wearing a recommendation&rsquo;s clothes.{" "}
        <Link className="link" href="/inventory">
          Inventory
        </Link>
      </p>
    </div>
  );
}
