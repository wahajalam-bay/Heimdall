import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { disposableAssets } from "@/server/assets";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
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
import { RankedBars } from "@/components/ui/charts";
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, money, percent, round2 } from "@/lib/format";

export const metadata = { title: "Scrap and waste" };
export const dynamic = "force-dynamic";

const SCRAP_CATEGORIES = ["CONSTRUCTION_SCRAP", "COMPLETE_WASTE", "MARKETING_MATERIAL"];

/**
 * Construction scrap, complete waste and dead marketing material: the disposal
 * traffic that is high volume and low value per item, where the risk is leakage
 * rather than valuation. Kept as its own view because the operational questions
 * are different — what is accumulating, and how much of it left without a case.
 */
export default async function ScrapPage() {
  const { user, ctx, authorized } = await pageContext(P.DISPOSAL_VIEW);
  if (!authorized) {
    return <AccessDenied title="Scrap and waste" message="You do not have permission to view disposal cases." />;
  }

  const scoped = visibleEntityIds(user);
  const [scrapCases, candidates, slowStock] = await Promise.all([
    prisma.disposalCase.findMany({
      where: { disposalCategory: { in: SCRAP_CATEGORIES }, ...ctx.entityFilter },
      orderBy: { raisedAt: "desc" },
      take: 200,
      include: {
        entity: { select: { code: true } },
        raisedBy: { select: { name: true } },
        items: { select: { id: true, description: true, quantity: true, unit: true, condition: true, estimatedValue: true, realisedValue: true } },
        bids: { select: { id: true, amount: true } },
      },
    }),
    disposableAssets(scoped),
    prisma.inventoryItem.findMany({
      where: {
        quantity: { gt: 0 },
        store: ctx.entityFilter,
        OR: [{ expiryDate: { lt: new Date() } }, { unitCost: 0 }],
      },
      include: {
        item: { select: { sku: true, name: true, unit: true } },
        store: { select: { id: true, name: true } },
      },
      orderBy: { quantity: "desc" },
      take: 100,
    }),
  ]);

  const canCreate = userHasPermission(user, P.DISPOSAL_CREATE);
  const open = scrapCases.filter((c) => !["COMPLETED", "REJECTED", "CANCELLED"].includes(c.stage));
  const completed = scrapCases.filter((c) => c.stage === "COMPLETED");
  const realised = round2(completed.reduce((a, c) => a + (c.realisedValue ?? 0), 0));
  const estimatedOpen = round2(
    open.reduce((a, c) => a + (c.estimatedValue ?? c.items.reduce((s, i) => s + (i.estimatedValue ?? 0), 0)), 0),
  );

  const byCategory = SCRAP_CATEGORIES.map((cat) => ({
    label: humanize(cat),
    value: scrapCases.filter((c) => c.disposalCategory === cat).length,
  })).filter((d) => d.value > 0);

  const scrapConditionItems = scrapCases.flatMap((c) => c.items);
  const byCondition = new Map<string, number>();
  for (const i of scrapConditionItems) {
    byCondition.set(humanize(i.condition), (byCondition.get(humanize(i.condition)) ?? 0) + 1);
  }

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Assets", href: "/assets" }, { label: "Disposal", href: "/disposal" }, { label: "Scrap and waste" }]} />

      <PageHeader
        eyebrow="Assets"
        title="Scrap and waste"
        subtitle="Construction scrap, complete waste and dead marketing material. High volume, low unit value — the risk here is leakage, not valuation."
        actions={
          canCreate && (
            <Link href="/disposal/new" className="btn btn-primary btn-sm">
              Raise scrap case
            </Link>
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Scrap cases" value={scrapCases.length} />
        <StatTile label="Open" value={open.length} tone={open.length ? "warning" : "default"} />
        <StatTile label="Estimated value pending" value={money(estimatedOpen)} />
        <StatTile label="Realised to date" value={money(realised)} tone="success" />
      </div>

      <InlineAlert tone="info">
        Scrap still goes through the same case route: nothing leaves site without an approved case, and where the value
        clears the bidding threshold, bids are mandatory. That is what stops scrap quietly walking off a site.
      </InlineAlert>

      <SectionCard title="Scrap and waste cases" bodyClassName="px-0 py-0">
        {scrapCases.length === 0 ? (
          <EmptyState
            title="No scrap cases raised"
            description="Raise a case for construction scrap, waste or dead marketing material so its removal is authorised and recorded."
            action={
              canCreate && (
                <Link href="/disposal/new" className="btn btn-primary btn-sm">
                  Raise scrap case
                </Link>
              )
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Entity</th>
                  <th>Title</th>
                  <th>Category</th>
                  <th>Stage</th>
                  <th className="text-right">Lines</th>
                  <th className="text-right">Estimated</th>
                  <th className="text-right">Bids</th>
                  <th className="text-right">Realised</th>
                  <th>Raised by</th>
                  <th>Raised</th>
                  <th className="text-right">Age</th>
                </tr>
              </thead>
              <tbody>
                {scrapCases.map((c) => {
                  const est =
                    c.estimatedValue ?? round2(c.items.reduce((s, i) => s + (i.estimatedValue ?? 0), 0));
                  const isOpen = !["COMPLETED", "REJECTED", "CANCELLED"].includes(c.stage);
                  const age = ageDays(c.raisedAt) ?? 0;
                  return (
                    <tr key={c.id}>
                      <td>
                        <RefLink href={`/disposal/${c.id}`}>{c.number}</RefLink>
                      </td>
                      <td>
                        <Badge tone="neutral">{c.entity.code}</Badge>
                      </td>
                      <td className="max-w-[22rem] truncate text-xs" title={c.title}>
                        {c.title}
                      </td>
                      <td className="text-2xs">{humanize(c.disposalCategory)}</td>
                      <td>
                        <StatusBadge status={c.stage} />
                      </td>
                      <td className="num text-xs">{c.items.length}</td>
                      <td className="num text-xs">{est > 0 ? money(est) : "—"}</td>
                      <td className="num text-xs">{c.bids.length || "—"}</td>
                      <td className="num text-xs">{c.realisedValue ? money(c.realisedValue) : "—"}</td>
                      <td className="text-xs">{c.raisedBy.name}</td>
                      <td className="text-xs">{fmtDate(c.raisedAt)}</td>
                      <td className="num text-xs">
                        {isOpen ? (
                          <span className={age > 30 ? "text-[var(--c-danger)] font-600" : undefined}>{age} d</span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        {byCategory.length > 0 && (
          <SectionCard title="Cases by category">
            <RankedBars data={byCategory} format="number" maxRows={5} />
          </SectionCard>
        )}
        {byCondition.size > 0 && (
          <SectionCard title="Lines by recorded condition">
            <RankedBars
              data={[...byCondition.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)}
              format="number"
              colorIndex={3}
              maxRows={6}
            />
          </SectionCard>
        )}
      </div>

      {slowStock.length > 0 && (
        <SectionCard
          title="Stock that looks like waste"
          description="Expired batches and zero-valued stock still sitting in a store. Either revalue it or put it through a disposal case — leaving it on the books overstates inventory."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap max-h-[22rem] overflow-y-auto">
            <table className="dt">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Store</th>
                  <th>Batch</th>
                  <th className="text-right">Quantity</th>
                  <th className="text-right">Unit cost</th>
                  <th>Expiry</th>
                  <th>Why flagged</th>
                </tr>
              </thead>
              <tbody>
                {slowStock.map((s) => {
                  const expired = s.expiryDate && s.expiryDate.getTime() < Date.now();
                  return (
                    <tr key={s.id}>
                      <td>
                        <span className="block text-xs">{s.item.name}</span>
                        <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{s.item.sku}</span>
                      </td>
                      <td className="text-xs">
                        <RefLink href={`/stores/${s.store.id}`}>{s.store.name}</RefLink>
                      </td>
                      <td className="text-2xs">{s.batchNumber ?? "—"}</td>
                      <td className="num text-xs">
                        {s.quantity} {s.unit || s.item.unit}
                      </td>
                      <td className="num text-xs">{money(s.unitCost)}</td>
                      <td className="text-xs">
                        {s.expiryDate ? (
                          <span className={expired ? "text-[var(--c-danger)] font-600" : undefined}>
                            {fmtDate(s.expiryDate)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="text-2xs">
                        {expired ? <Badge tone="danger">Expired</Badge> : <Badge tone="warning">Zero valued</Badge>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {candidates.length > 0 && (
        <SectionCard
          title="Assets eligible for disposal"
          description="Idle, obsolete, in storage or awaiting repair. Each is either redeployed or disposed of — sitting still is the one option that costs money."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap max-h-[24rem] overflow-y-auto">
            <table className="dt">
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Asset</th>
                  <th>Category</th>
                  <th>Entity</th>
                  <th>Status</th>
                  <th className="text-right">Cost</th>
                  <th className="text-right">Current value</th>
                  <th className="text-right">Written down</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {candidates.map((a) => {
                  const down =
                    a.cost > 0 && a.currentValue !== null ? round2(((a.cost - a.currentValue) / a.cost) * 100) : null;
                  return (
                    <tr key={a.id}>
                      <td>
                        <RefLink href={`/assets/${a.id}`}>{a.tag}</RefLink>
                      </td>
                      <td className="text-xs">{a.name}</td>
                      <td className="text-2xs">{a.category?.name ?? "—"}</td>
                      <td>
                        <Badge tone="neutral">{a.entity.code}</Badge>
                      </td>
                      <td>
                        <StatusBadge status={a.status} />
                      </td>
                      <td className="num text-xs">{money(a.cost)}</td>
                      <td className="num text-xs">{money(a.currentValue ?? a.cost)}</td>
                      <td className="num text-2xs">{down !== null ? percent(down, 0) : "—"}</td>
                      <td>
                        {canCreate && (
                          <Link href={`/disposal/new?assetId=${a.id}`} className="btn btn-secondary btn-xs">
                            Dispose
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </div>
  );
}
