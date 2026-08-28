import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { documentTimeline } from "@/server/timeline";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  DefList,
  InlineAlert,
  MetaItem,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
  UserChip,
} from "@/components/ui/primitives";
import { Timeline } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, fmtDateTime, money, percent, round2 } from "@/lib/format";
import { assetOptions } from "../actions";
import { AssetUpdateForm } from "./AssetUpdateForm";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await prisma.asset.findUnique({ where: { id }, select: { tag: true, name: true } });
  return { title: a ? `${a.tag} — ${a.name}` : "Asset" };
}

export default async function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.ASSET_VIEW);
  if (!authorized) return <AccessDenied title="Asset" />;

  const asset = await prisma.asset.findUnique({
    where: { id },
    include: {
      entity: { select: { id: true, code: true, name: true } },
      department: { select: { id: true, name: true } },
      category: { select: { name: true } },
      custodian: { select: { id: true, name: true, title: true, email: true } },
      vendor: { select: { id: true, name: true, status: true } },
      item: { select: { id: true, sku: true, name: true } },
      grn: { select: { id: true, number: true, receivedAt: true, po: { select: { id: true, number: true } } } },
      transactions: { orderBy: { performedAt: "desc" } },
      disposalItems: {
        include: {
          case: {
            select: { id: true, number: true, stage: true, finalAction: true, realisedValue: true, raisedAt: true },
          },
        },
      },
    },
  });
  if (!asset) notFound();

  const [events, options, actorNames, custodianNames] = await Promise.all([
    documentTimeline("Asset", asset.id),
    assetOptions(asset.entityId),
    prisma.user.findMany({
      where: { id: { in: [...new Set(asset.transactions.map((t) => t.performedById))] } },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: {
        id: {
          in: [
            ...new Set(
              asset.transactions
                .flatMap((t) => [t.fromCustodianId, t.toCustodianId])
                .filter((x): x is string => !!x),
            ),
          ],
        },
      },
      select: { id: true, name: true },
    }),
  ]);
  const actorName = new Map(actorNames.map((u) => [u.id, u.name]));
  const custodianName = new Map(custodianNames.map((u) => [u.id, u.name]));

  const canManage = userHasPermission(user, P.ASSET_MANAGE);
  const canDispose = userHasPermission(user, P.DISPOSAL_CREATE);
  const disposal = asset.disposalItems[0];
  const terminal = ["DISPOSED", "SCRAPPED"].includes(asset.status);
  const depreciated = asset.cost > 0 && asset.currentValue !== null
    ? round2(((asset.cost - asset.currentValue) / asset.cost) * 100)
    : null;
  const warrantyGone = asset.warrantyUntil && asset.warrantyUntil.getTime() < Date.now();

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Assets", href: "/assets" }, { label: asset.tag }]} />

      <PageHeader
        eyebrow={`${asset.entity.code} · ${asset.category?.name ?? "Uncategorised"}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{asset.tag}</span>
            <span>{asset.name}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={asset.status} />
            </MetaItem>
            <MetaItem label="Custodian">{asset.custodian?.name ?? "Unassigned"}</MetaItem>
            <MetaItem label="Location">{asset.location ?? asset.office ?? "—"}</MetaItem>
            <MetaItem label="Cost">{money(asset.cost)}</MetaItem>
            <MetaItem label="Current value">{money(asset.currentValue ?? asset.cost)}</MetaItem>
            <MetaItem label="Asset id">
              <Mono>{asset.assetId}</Mono>
            </MetaItem>
          </>
        }
        actions={
          <>
            {canManage && !terminal && (
              <AssetUpdateForm
                assetId={asset.id}
                tag={asset.tag}
                current={{
                  status: asset.status,
                  custodianId: asset.custodianId,
                  location: asset.location,
                  office: asset.office,
                  departmentId: asset.departmentId,
                  conditionNotes: asset.conditionNotes,
                  currentValue: asset.currentValue,
                }}
                users={options.users}
                departments={options.departments}
              />
            )}
            {canDispose && !terminal && !disposal && (
              <Link href={`/disposal/new?assetId=${asset.id}`} className="btn btn-secondary btn-sm">
                Raise disposal
              </Link>
            )}
            {disposal && (
              <Link href={`/disposal/${disposal.case.id}`} className="btn btn-secondary btn-sm">
                {disposal.case.number}
              </Link>
            )}
            {asset.grn && (
              <Link href={`/grn/${asset.grn.id}`} className="btn btn-secondary btn-sm">
                {asset.grn.number}
              </Link>
            )}
          </>
        }
      />

      {terminal && (
        <InlineAlert tone="info">
          This asset is {humanize(asset.status).toLowerCase()}
          {disposal ? ` under disposal case ${disposal.case.number}` : ""}. The record is kept for audit but can no longer
          be modified.
        </InlineAlert>
      )}

      {!terminal && ["IDLE", "OBSOLETE"].includes(asset.status) && (
        <InlineAlert tone="warning">
          This asset has been {humanize(asset.status).toLowerCase()} for {ageDays(asset.updatedAt) ?? 0} days. Either
          redeploy it to someone who needs it, or put it through a disposal case.
        </InlineAlert>
      )}

      {!asset.custodian && !terminal && (
        <InlineAlert tone="warning">
          No custodian is assigned. An asset without a named custodian is nobody&apos;s responsibility — assign one.
        </InlineAlert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Purchase cost" value={money(asset.cost)} />
        <StatTile
          label="Current value"
          value={money(asset.currentValue ?? asset.cost)}
          hint={depreciated !== null ? `${percent(depreciated, 0)} written down` : undefined}
        />
        <StatTile
          label="Warranty"
          value={asset.warrantyUntil ? fmtDate(asset.warrantyUntil) : "None recorded"}
          tone={asset.warrantyUntil ? (warrantyGone ? "danger" : "success") : "default"}
        />
        <StatTile label="Movements recorded" value={asset.transactions.length} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-4">
          <SectionCard title="Asset record">
            <DefList
              columns={2}
              items={[
                { label: "Tag", value: <Mono>{asset.tag}</Mono> },
                { label: "Asset id", value: <Mono>{asset.assetId}</Mono> },
                { label: "Name", value: asset.name },
                { label: "Category", value: asset.category?.name ?? "—" },
                {
                  label: "Catalogue item",
                  value: asset.item ? `${asset.item.sku} — ${asset.item.name}` : "Not catalogued",
                },
                { label: "Serial number", value: asset.serialNumber ? <Mono>{asset.serialNumber}</Mono> : "—" },
                { label: "Brand", value: asset.brand ?? "—" },
                { label: "Model", value: asset.model ?? "—" },
                { label: "Entity", value: asset.entity.name },
                { label: "Department", value: asset.department?.name ?? "—" },
                { label: "Office", value: asset.office ?? "—" },
                { label: "Location", value: asset.location ?? "—" },
                { label: "Purchase date", value: asset.purchaseDate ? fmtDate(asset.purchaseDate) : "—" },
                {
                  label: "Supplied by",
                  value: asset.vendor ? <RefLink href={`/vendors/${asset.vendor.id}`}>{asset.vendor.name}</RefLink> : "—",
                },
                {
                  label: "Received on",
                  value: asset.grn ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <RefLink href={`/grn/${asset.grn.id}`}>{asset.grn.number}</RefLink>
                      <span className="text-2xs text-[var(--c-text-tertiary)]">{fmtDate(asset.grn.receivedAt)}</span>
                    </span>
                  ) : (
                    "—"
                  ),
                },
                {
                  label: "Purchase order",
                  value: asset.grn?.po ? <RefLink href={`/po/${asset.grn.po.id}`}>{asset.grn.po.number}</RefLink> : "—",
                },
                { label: "Depreciation rate", value: asset.depreciationRate ? `${asset.depreciationRate}% per year` : "—" },
                { label: "Warranty until", value: asset.warrantyUntil ? fmtDate(asset.warrantyUntil) : "—" },
                { label: "Description", value: asset.description ?? "—", span: true },
                { label: "Condition notes", value: asset.conditionNotes ?? "—", span: true },
              ]}
            />
          </SectionCard>

          <SectionCard
            title="Custody and movement history"
            description="Every status change, custody transfer and revaluation, in order."
            bodyClassName="px-0 py-0"
          >
            {asset.transactions.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-muted">
                No movements recorded beyond initial tagging.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Movement</th>
                      <th>Status change</th>
                      <th>Custody change</th>
                      <th>Location change</th>
                      <th>Reference</th>
                      <th>Notes</th>
                      <th>By</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {asset.transactions.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <Badge tone={["DISPOSED", "SCRAPPED", "LOST"].includes(t.type) ? "danger" : "neutral"}>
                            {humanize(t.type)}
                          </Badge>
                        </td>
                        <td className="text-2xs">
                          {t.fromStatus || t.toStatus ? (
                            <>
                              {t.fromStatus ? humanize(t.fromStatus) : "—"} → {t.toStatus ? humanize(t.toStatus) : "—"}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="text-2xs">
                          {t.fromCustodianId || t.toCustodianId ? (
                            <>
                              {t.fromCustodianId ? (custodianName.get(t.fromCustodianId) ?? "—") : "None"} →{" "}
                              {t.toCustodianId ? (custodianName.get(t.toCustodianId) ?? "—") : "None"}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="text-2xs">
                          {t.fromLocation || t.toLocation ? (
                            <>
                              {t.fromLocation ?? "—"} → {t.toLocation ?? "—"}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="text-2xs">{t.reference ?? "—"}</td>
                        <td className="max-w-[20rem] text-2xs text-muted">{t.notes ?? "—"}</td>
                        <td className="text-2xs">{actorName.get(t.performedById) ?? "System"}</td>
                        <td className="text-2xs">{fmtDateTime(t.performedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>

        <div className="space-y-4">
          <SectionCard title="Custodian">
            {asset.custodian ? (
              <div className="space-y-2">
                <UserChip name={asset.custodian.name} sub={asset.custodian.title} size={28} />
                <DefList
                  columns={1}
                  items={[
                    { label: "Email", value: asset.custodian.email },
                    { label: "Department", value: asset.department?.name ?? "—" },
                    { label: "Location", value: asset.location ?? asset.office ?? "—" },
                  ]}
                />
              </div>
            ) : (
              <p className="text-xs text-muted">
                No custodian assigned. Assign one so the asset has a named owner.
              </p>
            )}
          </SectionCard>

          {asset.disposalItems.length > 0 && (
            <SectionCard title="Disposal">
              <ul className="space-y-3">
                {asset.disposalItems.map((d) => (
                  <li key={d.id} className="rounded-xl border border-border px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <RefLink href={`/disposal/${d.case.id}`}>{d.case.number}</RefLink>
                      <StatusBadge status={d.case.stage} />
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-2xs">
                      <div>
                        <dt className="text-[var(--c-text-tertiary)]">Condition</dt>
                        <dd>{humanize(d.condition)}</dd>
                      </div>
                      <div>
                        <dt className="text-[var(--c-text-tertiary)]">Final action</dt>
                        <dd>{d.case.finalAction ? humanize(d.case.finalAction) : "Not decided"}</dd>
                      </div>
                      <div>
                        <dt className="text-[var(--c-text-tertiary)]">Book value</dt>
                        <dd className="tnum">{d.bookValue !== null ? money(d.bookValue) : "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-[var(--c-text-tertiary)]">Realised</dt>
                        <dd className="tnum">{d.realisedValue !== null ? money(d.realisedValue) : "—"}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}

          <SectionCard title="Activity">
            <Timeline events={events} emptyLabel="No activity recorded yet." />
          </SectionCard>
        </div>
      </div>

      <DocumentsPanel
        user={user}
        linkedType="ASSET"
        linkedId={asset.id}
        entityId={asset.entityId}
        title="Asset documents"
        description="Invoice, warranty card, handover acknowledgement and condition photographs."
        defaultCategory="Asset"
      />
    </div>
  );
}
