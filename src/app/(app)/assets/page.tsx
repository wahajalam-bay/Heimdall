import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
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
import { DonutChart, RankedBars } from "@/components/ui/charts";
import { ASSET_STATUSES, humanize } from "@/lib/domain";
import { ageDays, fmtDate, money, round2 } from "@/lib/format";

export const metadata = { title: "Assets" };
export const dynamic = "force-dynamic";

export default async function AssetsPage() {
  const { user, ctx, authorized } = await pageContext(P.ASSET_VIEW);
  if (!authorized) {
    return <AccessDenied title="Assets" message="You do not have permission to view the asset register." />;
  }

  const [assets, savedViews] = await Promise.all([
    prisma.asset.findMany({
      where: ctx.entityFilter,
      orderBy: { createdAt: "desc" },
      take: 800,
      include: {
        entity: { select: { code: true } },
        department: { select: { name: true } },
        category: { select: { name: true } },
        custodian: { select: { id: true, name: true } },
        vendor: { select: { id: true, name: true } },
        item: { select: { sku: true, name: true } },
        grn: { select: { id: true, number: true } },
        disposalItems: { select: { caseId: true, case: { select: { number: true, stage: true } } } },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "assets", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const canManage = userHasPermission(user, P.ASSET_MANAGE);

  const active = assets.filter((a) => ["ACTIVE", "ISSUED"].includes(a.status));
  const idle = assets.filter((a) => ["IDLE", "IN_STORAGE"].includes(a.status));
  const disposed = assets.filter((a) => ["DISPOSED", "SCRAPPED"].includes(a.status));
  const bookValue = round2(assets.filter((a) => !["DISPOSED", "SCRAPPED"].includes(a.status)).reduce((s, a) => s + (a.currentValue ?? a.cost), 0));

  const statusMix = ASSET_STATUSES.map((s, idx) => ({
    label: humanize(s),
    value: assets.filter((a) => a.status === s).length,
    colorIndex: idx % 8,
  })).filter((d) => d.value > 0);

  const byCategory = new Map<string, number>();
  for (const a of assets) {
    if (["DISPOSED", "SCRAPPED"].includes(a.status)) continue;
    const key = a.category?.name ?? "Uncategorised";
    byCategory.set(key, round2((byCategory.get(key) ?? 0) + (a.currentValue ?? a.cost)));
  }

  const warrantyExpiring = assets.filter(
    (a) =>
      a.warrantyUntil &&
      !["DISPOSED", "SCRAPPED"].includes(a.status) &&
      a.warrantyUntil.getTime() < Date.now() + 60 * 86400000,
  );

  const columns: TableColumn[] = [
    { key: "tag", header: "Tag", locked: true, sortable: true, width: "10rem" },
    { key: "name", header: "Asset", sortable: true, minWidth: "16rem" },
    { key: "assetId", header: "Asset id", sortable: true, width: "10rem", defaultHidden: true },
    { key: "category", header: "Category", filterable: true, sortable: true, width: "13rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "10rem" },
    { key: "custodian", header: "Custodian", sortable: true, width: "13rem" },
    { key: "department", header: "Department", filterable: true, sortable: true, width: "13rem" },
    { key: "location", header: "Location", filterable: true, sortable: true, width: "13rem" },
    { key: "serial", header: "Serial", sortable: true, width: "12rem", defaultHidden: true },
    { key: "cost", header: "Cost", numeric: true, sortable: true, width: "11rem" },
    { key: "currentValue", header: "Current value", numeric: true, sortable: true, width: "11rem" },
    { key: "vendor", header: "Supplied by", sortable: true, width: "13rem", defaultHidden: true },
    { key: "grn", header: "Received on", sortable: true, width: "10rem", defaultHidden: true },
    { key: "purchased", header: "Purchased", sortable: true, width: "9.5rem" },
    { key: "warranty", header: "Warranty until", sortable: true, width: "10rem" },
    { key: "disposal", header: "Disposal case", sortable: true, width: "11rem" },
    { key: "age", header: "Age (days)", numeric: true, sortable: true, width: "8rem", defaultHidden: true },
  ];

  const rows: TableRow[] = assets.map((a) => {
    const disposal = a.disposalItems[0];
    const warrantyGone = a.warrantyUntil && a.warrantyUntil.getTime() < Date.now();
    return {
      id: a.id,
      href: `/assets/${a.id}`,
      flag:
        ["DISPOSED", "SCRAPPED", "LOST"].includes(a.status)
          ? "danger"
          : ["IDLE", "OBSOLETE"].includes(a.status)
            ? "warning"
            : null,
      search: `${a.tag} ${a.assetId} ${a.name} ${a.serialNumber ?? ""} ${a.custodian?.name ?? ""} ${a.location ?? ""}`,
      values: {
        tag: a.tag,
        name: a.name,
        assetId: a.assetId,
        category: a.category?.name ?? "",
        entity: a.entity.code,
        status: humanize(a.status),
        custodian: a.custodian?.name ?? "",
        department: a.department?.name ?? "",
        location: a.location ?? a.office ?? "",
        serial: a.serialNumber ?? "",
        cost: a.cost,
        currentValue: a.currentValue ?? a.cost,
        vendor: a.vendor?.name ?? "",
        grn: a.grn?.number ?? "",
        purchased: a.purchaseDate ? a.purchaseDate.toISOString() : "",
        warranty: a.warrantyUntil ? a.warrantyUntil.toISOString() : "",
        disposal: disposal?.case.number ?? "",
        age: ageDays(a.createdAt) ?? 0,
      },
      cells: {
        tag: <Mono>{a.tag}</Mono>,
        name: (
          <span>
            <RefLink href={`/assets/${a.id}`}>{a.name}</RefLink>
            {a.item && (
              <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{a.item.sku}</span>
            )}
          </span>
        ),
        assetId: <Mono>{a.assetId}</Mono>,
        category: a.category?.name ?? "—",
        entity: <Badge tone="neutral">{a.entity.code}</Badge>,
        status: <StatusBadge status={a.status} />,
        custodian: a.custodian?.name ?? <span className="text-2xs text-[var(--c-text-tertiary)]">Unassigned</span>,
        department: a.department?.name ?? "—",
        location: a.location ?? a.office ?? "—",
        serial: a.serialNumber ?? "—",
        cost: <Mono>{money(a.cost)}</Mono>,
        currentValue: <Mono>{money(a.currentValue ?? a.cost)}</Mono>,
        vendor: a.vendor ? <RefLink href={`/vendors/${a.vendor.id}`}>{a.vendor.name}</RefLink> : "—",
        grn: a.grn ? <RefLink href={`/grn/${a.grn.id}`}>{a.grn.number}</RefLink> : "—",
        purchased: a.purchaseDate ? fmtDate(a.purchaseDate) : "—",
        warranty: a.warrantyUntil ? (
          <span className={warrantyGone ? "text-[var(--c-text-tertiary)]" : "text-[var(--c-success)]"}>
            {fmtDate(a.warrantyUntil)}
          </span>
        ) : (
          "—"
        ),
        disposal: disposal ? (
          <RefLink href={`/disposal/${disposal.caseId}`}>{disposal.case.number}</RefLink>
        ) : (
          "—"
        ),
        age: ageDays(a.createdAt) ?? 0,
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Assets"
        title="Asset register"
        subtitle="Every asset tagged from a goods receipt, with its custodian, location and condition. Disposal runs as a separate governed case."
        actions={
          <>
            <Link href="/disposal" className="btn btn-secondary btn-sm">
              Disposal cases
            </Link>
            {userHasPermission(user, P.DISPOSAL_CREATE) && (
              <Link href="/disposal/new" className="btn btn-primary btn-sm">
                Raise disposal
              </Link>
            )}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Assets on register" value={assets.length} />
        <StatTile label="In use" value={active.length} tone="success" />
        <StatTile label="Idle or in storage" value={idle.length} tone={idle.length ? "warning" : "default"} />
        <StatTile label="Book value held" value={money(bookValue)} hint={`${disposed.length} disposed to date`} />
      </div>

      {idle.length > 0 && (
        <InlineAlert tone="warning">
          {idle.length} asset{idle.length === 1 ? " is" : "s are"} idle or sitting in storage, worth{" "}
          {money(round2(idle.reduce((s, a) => s + (a.currentValue ?? a.cost), 0)))}. Idle assets are either redeployed or
          put through disposal — leaving them untouched is the expensive option.
        </InlineAlert>
      )}

      {warrantyExpiring.length > 0 && (
        <SectionCard
          title="Warranties expiring or expired"
          description="Claim while the warranty still stands — after expiry, repairs become our cost."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap max-h-[18rem] overflow-y-auto">
            <table className="dt">
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Asset</th>
                  <th>Custodian</th>
                  <th>Status</th>
                  <th>Warranty until</th>
                  <th className="text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {warrantyExpiring.map((a) => {
                  const gone = a.warrantyUntil && a.warrantyUntil.getTime() < Date.now();
                  return (
                    <tr key={a.id}>
                      <td>
                        <RefLink href={`/assets/${a.id}`}>{a.tag}</RefLink>
                      </td>
                      <td className="text-xs">{a.name}</td>
                      <td className="text-xs">{a.custodian?.name ?? "—"}</td>
                      <td>
                        <StatusBadge status={a.status} />
                      </td>
                      <td className="text-xs">
                        <span className={gone ? "text-[var(--c-danger)] font-600" : "text-[var(--c-warning)]"}>
                          {a.warrantyUntil ? fmtDate(a.warrantyUntil) : "—"}
                          {gone ? " (expired)" : ""}
                        </span>
                      </td>
                      <td className="num text-xs">{money(a.currentValue ?? a.cost)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Register by status" description="Where the asset base actually sits.">
          <DonutChart data={statusMix} centerLabel="Assets" centerValue={String(assets.length)} format="number" />
        </SectionCard>
        <SectionCard title="Value by category" description="Current value of assets still on the register.">
          <RankedBars
            data={[...byCategory.entries()]
              .map(([label, value]) => ({ label, value }))
              .sort((a, b) => b.value - a.value)}
            format="moneyCompact"
            maxRows={8}
          />
        </SectionCard>
      </div>

      <DataTable
        id="assets"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "tag", dir: "asc" }}
        exportName="assets"
        emptyState={
          <EmptyState
            title="No assets tagged"
            description="Assets are created automatically when a goods receipt containing asset-tracked items is posted."
            action={
              canManage ? (
                <Link href="/grn" className="btn btn-secondary btn-sm">
                  Go to goods receipts
                </Link>
              ) : undefined
            }
          />
        }
      />
    </div>
  );
}
