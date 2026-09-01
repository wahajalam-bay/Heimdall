import Link from "next/link";
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
  StatusBadge,
} from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/DataTable";
import { money, fmtDate } from "@/lib/format";
import { humanize } from "@/lib/domain";
import {
  listLossReports,
  lossSummary,
  LOSS_TYPE_LABELS,
  type LossType,
} from "@/server/loss-reports";

export const metadata = { title: "Loss and theft" };
export const dynamic = "force-dynamic";

const TYPE_TONE: Record<string, "danger" | "warning" | "info"> = {
  THEFT: "danger",
  LOSS: "warning",
  DAMAGE: "warning",
  SHORTAGE_UNEXPLAINED: "warning",
  MISPLACED: "info",
};

/**
 * Loss, theft and unexplained shortage.
 *
 * The system's only route for stock that is not there was a manual adjustment
 * with a reason, which makes a shortage look like a correction and buries a
 * theft in the same list as a mis-keyed count. The summary by store is the
 * reason this exists separately: one shortage is an incident, four in one store
 * in a quarter is a finding, and the adjustment ledger cannot show that.
 */
export default async function LossReportsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { ctx, authorized } = await pageContext(P.INVENTORY_VIEW, P.AUDIT_VIEW);
  if (!authorized) {
    return <AccessDenied title="Loss and theft" />;
  }

  const sp = await searchParams;
  const status = first(sp.status) ?? null;
  const canReport = userHasPermission(
    ctx.user,
    P.INVENTORY_ADJUST,
    P.STORE_ISSUE,
    P.RECEIVE_GOODS,
    P.AUDIT_VIEW,
  );
  const entityIds = visibleEntityIds(ctx.user);

  const [rows, summary] = await Promise.all([
    listLossReports({ entityIds, status }),
    lossSummary({ entityIds }),
  ]);

  const open = rows.filter(
    (r) => !["CLOSED", "CANCELLED", "WRITTEN_OFF", "RECOVERED"].includes(r.status),
  );
  const thefts = rows.filter((r) => r.lossType === "THEFT");
  const awaitingWriteOff = rows.filter((r) => r.status === "SUBSTANTIATED");
  const repeatStores = summary.byStore.filter((s) => s.count >= 3);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Stores", href: "/inventory" }, { label: "Loss and theft" }]} />

      <PageHeader
        eyebrow="Stores"
        title="Loss and theft"
        subtitle="A shortage recorded as an adjustment looks like a correction. This keeps them apart: a theft needs an investigation, a loss has a value somebody is accountable for, and a pattern in one store is a finding."
        actions={
          canReport ? (
            <Link className="btn btn-primary btn-sm" href="/inventory/losses/new">
              File a report
            </Link>
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="Open cases" value={open.length} hint={money(summary.totalValue) + " reported"} />
        <StatTile
          label="Thefts"
          value={thefts.length}
          hint={thefts.length ? "Reported in the last year" : "None"}
          tone={thefts.length ? "danger" : undefined}
        />
        <StatTile
          label="Awaiting write-off"
          value={awaitingWriteOff.length}
          hint={awaitingWriteOff.length ? "Substantiated, still on the ledger" : "None"}
          tone={awaitingWriteOff.length ? "warning" : undefined}
        />
        <StatTile
          label="Written off"
          value={money(summary.writtenOff)}
          hint={summary.recovered ? `${money(summary.recovered)} recovered` : "Nothing recovered"}
        />
      </div>

      {repeatStores.length > 0 && (
        <InlineAlert tone="danger">
          {repeatStores.length} store{repeatStores.length === 1 ? "" : "s"} {repeatStores.length === 1 ? "has" : "have"}{" "}
          three or more loss reports in the last year:{" "}
          {repeatStores.map((s) => `${s.store} (${s.count}, ${money(s.value)})`).join(", ")}. One shortage is an
          incident; a pattern is a finding.
        </InlineAlert>
      )}

      {summary.byType.length > 0 && (
        <SectionCard
          title="By kind and by store"
          description="The pattern the adjustment ledger cannot show."
          bodyClassName="px-0 py-0"
        >
          <div className="grid gap-0 md:grid-cols-2">
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ minWidth: "12rem" }}>Kind</th>
                    <th style={{ width: "6rem" }} className="text-right">
                      Cases
                    </th>
                    <th style={{ width: "10rem" }} className="text-right">
                      Value
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byType.map((t) => (
                    <tr key={t.type}>
                      <td>
                        <Badge tone={TYPE_TONE[t.type] ?? "info"}>
                          {LOSS_TYPE_LABELS[t.type as LossType] ?? humanize(t.type)}
                        </Badge>
                      </td>
                      <td className="tnum text-right">{t.count}</td>
                      <td className="tnum text-right">{money(t.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-wrap border-l border-[var(--c-border)]">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ minWidth: "12rem" }}>Store</th>
                    <th style={{ width: "6rem" }} className="text-right">
                      Cases
                    </th>
                    <th style={{ width: "10rem" }} className="text-right">
                      Value
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byStore.map((st) => (
                    <tr key={st.store}>
                      <td className={st.count >= 3 ? "font-600 text-[var(--c-danger)]" : undefined}>
                        {st.store}
                      </td>
                      <td className="tnum text-right">{st.count}</td>
                      <td className="tnum text-right">{money(st.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </SectionCard>
      )}

      <DataTable
        id="loss-reports"
        columns={[
          { key: "number", header: "Number", sortable: true, width: "10rem" },
          { key: "title", header: "What happened", filterable: false },
          { key: "type", header: "Kind", filterable: true, sortable: true, width: "12rem" },
          { key: "store", header: "Store", filterable: true, sortable: true, width: "12rem" },
          { key: "value", header: "Value", sortable: true, align: "right", width: "10rem" },
          { key: "discovered", header: "Discovered", sortable: true, width: "9rem" },
          { key: "status", header: "Status", filterable: true, sortable: true, width: "12rem" },
          { key: "police", header: "Police", filterable: true, sortable: true, width: "8rem" },
        ]}
        rows={rows.map((r) => ({
          id: r.id,
          href: `/inventory/losses/${r.id}`,
          search: `${r.number} ${r.title} ${r.store?.name ?? ""}`,
          flag:
            r.lossType === "THEFT"
              ? ("danger" as const)
              : r.status === "SUBSTANTIATED"
                ? ("warning" as const)
                : null,
          cells: {
            number: <Mono>{r.number}</Mono>,
            title: (
              <>
                {r.title}
                <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                  {r._count.items} line{r._count.items === 1 ? "" : "s"} · reported by {r.reportedBy.name}
                  {r.investigator ? ` · investigated by ${r.investigator.name}` : ""}
                </span>
              </>
            ),
            type: (
              <Badge tone={TYPE_TONE[r.lossType] ?? "info"}>
                {LOSS_TYPE_LABELS[r.lossType as LossType] ?? humanize(r.lossType)}
              </Badge>
            ),
            store: r.store?.name ?? <span className="text-2xs text-[var(--c-text-tertiary)]">None named</span>,
            value: money(r.estimatedValue),
            discovered: fmtDate(r.discoveredOn),
            status: <StatusBadge status={r.status} />,
            police: r.policeReported ? (
              <>
                <Badge tone="danger">Reported</Badge>
                {r.policeReference && (
                  <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                    {r.policeReference}
                  </span>
                )}
              </>
            ) : (
              <span className="text-2xs text-[var(--c-text-tertiary)]">No</span>
            ),
          },
          values: {
            number: r.number,
            title: r.title,
            type: LOSS_TYPE_LABELS[r.lossType as LossType] ?? r.lossType,
            store: r.store?.name ?? "None named",
            value: r.estimatedValue,
            discovered: r.discoveredOn.toISOString().slice(0, 10),
            status: r.status,
            police: r.policeReported ? "Reported" : "No",
          },
        }))}
        emptyState="No loss reports. Stock that is not there has only ever been recorded as an adjustment, which does not distinguish a theft from a mis-keyed count."
      />

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        Filing a report does not move stock. The ledger correction is a separate authorised adjustment taken once the
        case is substantiated — a report that wrote off the stock as it was filed would let anybody make an
        inconvenient quantity disappear by submitting a form.
      </p>
    </div>
  );
}
