import Link from "next/link";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { storeSummaries } from "@/server/stores";
import { AccessDenied } from "@/components/ui/guard";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { ChartFrame, ChartTable, RankedBars } from "@/components/ui/charts";
import { humanize } from "@/lib/domain";
import { amount, money, round2 } from "@/lib/format";

export const metadata = { title: "Stores" };
export const dynamic = "force-dynamic";

const KIND_ORDER = ["CENTRAL_WAREHOUSE", "SITE_STORE", "PROJECT_STORE", "OFFICE_STORE", "OTHER"];

export default async function StoresPage() {
  const { user, ctx, authorized } = await pageContext(P.INVENTORY_VIEW);
  if (!authorized) {
    return <AccessDenied title="Stores" message="You do not have permission to view stores." />;
  }

  const scoped = visibleEntityIds(user);
  const stores = await storeSummaries(ctx.entityId ? [ctx.entityId] : scoped);

  const totals = {
    stores: stores.length,
    value: round2(stores.reduce((a, s) => a + s.totalValue, 0)),
    skus: stores.reduce((a, s) => a + s.skuCount, 0),
    openIssues: stores.reduce((a, s) => a + s.openIssues, 0),
    inbound: stores.reduce((a, s) => a + s.inboundTransfers, 0),
  };

  const grouped = KIND_ORDER.map((kind) => ({
    kind,
    stores: stores.filter((s) => s.kind === kind),
  })).filter((g) => g.stores.length > 0);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Operations"
        title="Stores & warehouses"
        subtitle="Central warehouse, site stores, project stores and office stores — with the stock value and open movements held at each."
        actions={
          <>
            <Link href="/inventory" className="btn btn-secondary btn-sm">
              Inventory
            </Link>
            {userHasPermission(user, P.MASTER_DATA_MANAGE) && (
              <Link href="/admin/stores" className="btn btn-secondary btn-sm">
                Manage stores
              </Link>
            )}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Stores" value={totals.stores} tone="accent" />
        <StatTile label="Inventory value" value={money(totals.value, "PKR", { compact: true })} />
        <StatTile label="Stock lines" value={totals.skus} hint="Item / batch / serial buckets" />
        <StatTile
          label="Open issues"
          value={totals.openIssues}
          hint="Awaiting approval or release"
          tone={totals.openIssues ? "warning" : "default"}
        />
        <StatTile
          label="Inbound transfers"
          value={totals.inbound}
          hint="Dispatched, awaiting receipt"
          tone={totals.inbound ? "warning" : "default"}
        />
      </div>

      {stores.length === 0 ? (
        <Card>
          <EmptyState
            title="No stores configured"
            description="Stores are where goods are received and held. Configure at least one before receiving."
            action={
              userHasPermission(user, P.MASTER_DATA_MANAGE) && (
                <Link href="/admin/stores" className="btn btn-primary btn-sm">
                  Configure stores
                </Link>
              )
            }
          />
        </Card>
      ) : (
        <>
          <ChartFrame
            title="Inventory value by store"
            subtitle="Where stock is held"
            tableView={
              <ChartTable
                columns={["Store", "Value", "Stock lines"]}
                rows={stores.map((s) => [s.name, money(s.totalValue), s.skuCount])}
              />
            }
          >
            <RankedBars
              data={stores
                .filter((s) => s.totalValue > 0)
                .map((s) => ({ label: s.name, value: s.totalValue, sub: `${s.skuCount} lines` }))}
              format="moneyCompact"
              maxRows={10}
              colorIndex={1}
            />
          </ChartFrame>

          {grouped.map((g) => (
            <SectionCard
              key={g.kind}
              title={humanize(g.kind)}
              description={`${g.stores.length} store(s)`}
              bodyClassName="px-0 py-0"
            >
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th style={{ width: "8rem" }}>Code</th>
                      <th style={{ minWidth: "16rem" }}>Store</th>
                      <th style={{ width: "5rem" }}>Entity</th>
                      <th style={{ width: "9rem" }}>City</th>
                      <th style={{ minWidth: "13rem" }}>Site / project</th>
                      <th style={{ width: "12rem" }}>Manager</th>
                      <th className="text-right" style={{ width: "7rem" }}>Bins</th>
                      <th className="text-right" style={{ width: "7rem" }}>Lines</th>
                      <th className="text-right" style={{ width: "9rem" }}>Quantity</th>
                      <th className="text-right" style={{ width: "11rem" }}>Value</th>
                      <th className="text-right" style={{ width: "6rem" }}>GRNs</th>
                      <th style={{ width: "10rem" }}>Movements</th>
                      <th style={{ width: "6rem" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.stores.map((s) => (
                      <tr key={s.id} data-clickable="true">
                        <td>
                          <RefLink href={`/stores/${s.id}`}>{s.code}</RefLink>
                        </td>
                        <td className="font-500">{s.name}</td>
                        <td>
                          <Badge tone="neutral">{s.entityCode}</Badge>
                        </td>
                        <td className="text-xs">{s.city ?? "—"}</td>
                        <td className="text-xs">{s.siteName ?? s.projectName ?? "—"}</td>
                        <td className="text-xs">{s.managerName ?? "Unassigned"}</td>
                        <td className="num text-xs">{s.locationCount}</td>
                        <td className="num text-xs">{s.skuCount}</td>
                        <td className="num text-xs">{amount(s.totalQuantity, 2)}</td>
                        <td className="num font-500">{money(s.totalValue)}</td>
                        <td className="num text-xs">{s.grnCount}</td>
                        <td>
                          <span className="flex flex-wrap gap-1">
                            {s.openIssues > 0 && <Badge tone="warning">{s.openIssues} issue</Badge>}
                            {s.inboundTransfers > 0 && <Badge tone="info">{s.inboundTransfers} inbound</Badge>}
                            {s.openIssues === 0 && s.inboundTransfers === 0 && (
                              <span className="text-2xs text-[var(--c-text-tertiary)]">Quiet</span>
                            )}
                          </span>
                        </td>
                        <td>
                          <StatusBadge status={s.active ? "ACTIVE" : "INACTIVE"} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          ))}
        </>
      )}
    </div>
  );
}
