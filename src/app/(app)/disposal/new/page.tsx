import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { EmptyState, PageHeader } from "@/components/ui/primitives";
import { round2 } from "@/lib/format";
import { disposalCandidates } from "@/app/(app)/assets/actions";
import { DisposalForm, type Candidate } from "../DisposalForms";

export const metadata = { title: "Raise disposal case" };
export const dynamic = "force-dynamic";

export default async function NewDisposalPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { ctx, authorized } = await pageContext(P.DISPOSAL_CREATE);
  if (!authorized) {
    return <AccessDenied title="Raise disposal case" message="You do not have permission to raise disposal cases." />;
  }

  const assetId = first((await searchParams).assetId);
  const { assets, stock, entities } = await disposalCandidates(null);

  const thresholdPairs = await Promise.all(
    entities.map(async (e) => [e.id, await getConfigNumber(CONFIG_KEYS.DISPOSAL_BIDDING_THRESHOLD, e.id)] as const),
  );
  const biddingThresholds = Object.fromEntries(thresholdPairs);

  const candidates: Candidate[] = [
    ...assets.map((a) => ({
      kind: "asset" as const,
      key: `asset:${a.id}`,
      assetId: a.id,
      itemId: null,
      storeId: null,
      label: `${a.tag} — ${a.name}`,
      sub: `${a.category?.name ?? "Uncategorised"} · ${a.status.replace(/_/g, " ").toLowerCase()}`,
      entityId: a.entityId,
      quantity: 1,
      unit: "EA",
      bookValue: round2(a.currentValue ?? a.cost),
    })),
    ...stock.map((s) => ({
      kind: "stock" as const,
      key: `stock:${s.id}`,
      assetId: null,
      itemId: s.itemId,
      storeId: s.storeId,
      label: `${s.item.sku} — ${s.item.name}`,
      sub: `${s.store.name} · ${s.quantity} ${s.unit || s.item.unit} on hand`,
      entityId: s.store.entityId,
      quantity: s.quantity,
      unit: s.unit || s.item.unit,
      bookValue: round2(s.quantity * s.unitCost),
    })),
  ];

  const defaultEntityId =
    ctx.entityId && entities.some((e) => e.id === ctx.entityId) ? ctx.entityId : (entities[0]?.id ?? "");

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Assets", href: "/assets" }, { label: "Disposal", href: "/disposal" }, { label: "New" }]} />
      <PageHeader
        title="Raise a disposal case"
        subtitle="For idle or obsolete assets, damaged stock, construction scrap and waste. Assessment and audit review come before any approval."
      />
      {entities.length === 0 ? (
        <EmptyState title="No entity available" description="You are not assigned to an entity that can raise disposals." />
      ) : (
        <DisposalForm
          entities={entities}
          candidates={candidates}
          defaultEntityId={defaultEntityId}
          preselectAssetId={assetId}
          biddingThresholds={biddingThresholds}
        />
      )}
    </div>
  );
}
