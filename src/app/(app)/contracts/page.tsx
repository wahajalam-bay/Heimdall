import Link from "next/link";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { Badge, InlineAlert, Mono, PageHeader, StatTile, StatusBadge } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/DataTable";
import { money, fmtDate } from "@/lib/format";
import { listContracts, CONTRACT_TYPE_LABELS, type ContractType } from "@/server/contracts";

export const metadata = { title: "Contracts" };
export const dynamic = "force-dynamic";

const DAY = 86400000;

/**
 * Contracts and agreements.
 *
 * §4.6 gives procurement sole authority to issue them, and the CPC mandate names
 * the types. The column that earns its place is the one counting down to expiry:
 * a standing obligation with an end date nobody is watching is the thing that
 * keeps being paid for after it stops being needed.
 */
export default async function ContractsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { ctx, authorized } = await pageContext(P.PO_VIEW);
  if (!authorized) {
    return <AccessDenied title="Contracts" message="You do not have access to contracts." />;
  }

  const sp = await searchParams;
  const status = first(sp.status) ?? null;
  const canCreate = userHasPermission(ctx.user, P.PO_CREATE, P.PO_ISSUE);

  const rows = await listContracts({ entityIds: visibleEntityIds(ctx.user), status });

  const now = Date.now();
  const live = rows.filter((r) => ["ACTIVE", "EXPIRING"].includes(r.status));
  const expiring = rows.filter((r) => r.status === "EXPIRING");
  const expired = rows.filter((r) => r.status === "EXPIRED");
  const autoRenewingSoon = expiring.filter((r) => r.autoRenew);
  const committedTotal = live.reduce((a, r) => a + r.committedValue, 0);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Procurement" }, { label: "Contracts" }]} />

      <PageHeader
        eyebrow="Procurement"
        title="Contracts and agreements"
        subtitle="ZAM/PUR/SOP-01 §4.6 gives the procurement department sole authority to issue a contract or agreement under an authorised signature. The committee's mandate names SLAs, service contracts, AMCs, build-outs and one-time purchases."
        actions={
          canCreate ? (
            <Link className="btn btn-primary btn-sm" href="/contracts/new">
              Raise a contract
            </Link>
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="Live" value={live.length} hint={money(committedTotal) + " committed"} />
        <StatTile
          label="Inside the notice period"
          value={expiring.length}
          hint={expiring.length ? "A decision is due" : "None"}
          tone={expiring.length ? "warning" : undefined}
        />
        <StatTile
          label="Expired"
          value={expired.length}
          hint={expired.length ? "Ran out with no decision" : "None"}
          tone={expired.length ? "danger" : undefined}
        />
        <StatTile
          label="Auto-renewing soon"
          value={autoRenewingSoon.length}
          hint={autoRenewingSoon.length ? "Will roll on unless stopped" : "None"}
          tone={autoRenewingSoon.length ? "danger" : undefined}
        />
      </div>

      {autoRenewingSoon.length > 0 && (
        <InlineAlert tone="danger">
          {autoRenewingSoon.length} contract{autoRenewingSoon.length === 1 ? "" : "s"} inside the notice period{" "}
          {autoRenewingSoon.length === 1 ? "renews" : "renew"} automatically unless somebody stops{" "}
          {autoRenewingSoon.length === 1 ? "it" : "them"}:{" "}
          {autoRenewingSoon.map((c) => `${c.number} (${c.vendor.name})`).join(", ")}. The system does not renew
          anything by itself — the flag says what the paper says, and acting on it would create an obligation nobody
          chose.
        </InlineAlert>
      )}

      <DataTable
        id="contracts"
        columns={[
          { key: "number", header: "Number", sortable: true, width: "10rem" },
          { key: "title", header: "Contract", filterable: false },
          { key: "vendor", header: "Vendor", filterable: true, sortable: true, width: "13rem" },
          { key: "type", header: "Type", filterable: true, sortable: true, width: "12rem" },
          { key: "value", header: "Value", sortable: true, align: "right", width: "11rem" },
          { key: "committed", header: "Committed", sortable: true, align: "right", width: "11rem" },
          { key: "ends", header: "Ends", sortable: true, width: "10rem" },
          { key: "status", header: "Status", filterable: true, sortable: true, width: "10rem" },
        ]}
        rows={rows.map((r) => {
          const daysLeft = r.endDate ? Math.floor((r.endDate.getTime() - now) / DAY) : null;
          return {
            id: r.id,
            href: `/contracts/${r.id}`,
            search: `${r.number} ${r.title} ${r.vendor.name}`,
            flag:
              r.status === "EXPIRED"
                ? ("danger" as const)
                : r.status === "EXPIRING"
                  ? ("warning" as const)
                  : null,
            cells: {
              number: <Mono>{r.number}</Mono>,
              title: (
                <>
                  {r.title}
                  <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                    {r.entity.code}
                    {r.autoRenew ? " · auto-renews" : ""}
                    {r.committeeRequired ? " · committee approval required" : ""}
                  </span>
                </>
              ),
              vendor: r.vendor.name,
              type: CONTRACT_TYPE_LABELS[r.contractType as ContractType] ?? r.contractType,
              value:
                r.contractValue == null ? (
                  <span className="text-2xs text-[var(--c-text-tertiary)]">No committed value</span>
                ) : (
                  money(r.contractValue)
                ),
              committed: (
                <>
                  {money(r.committedValue)}
                  {r.contractValue != null && r.contractValue > 0 && (
                    <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                      {money(r.contractValue - r.committedValue)} left
                    </span>
                  )}
                </>
              ),
              ends: r.endDate ? (
                <>
                  {fmtDate(r.endDate)}
                  {daysLeft !== null && (
                    <span
                      className={
                        daysLeft < 0
                          ? "mt-0.5 block text-2xs text-[var(--c-danger)]"
                          : daysLeft <= r.noticeDays
                            ? "mt-0.5 block text-2xs text-[var(--c-warning)]"
                            : "mt-0.5 block text-2xs text-[var(--c-text-tertiary)]"
                      }
                    >
                      {daysLeft < 0 ? `${Math.abs(daysLeft)}d ago` : `${daysLeft}d`}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-2xs text-[var(--c-text-tertiary)]">No end date</span>
              ),
              status: <StatusBadge status={r.status} />,
            },
            values: {
              number: r.number,
              title: r.title,
              vendor: r.vendor.name,
              type: CONTRACT_TYPE_LABELS[r.contractType as ContractType] ?? r.contractType,
              value: r.contractValue ?? -1,
              committed: r.committedValue,
              ends: r.endDate ? r.endDate.toISOString().slice(0, 10) : "",
              status: r.status,
            },
          };
        })}
        emptyState="No contracts yet. A twelve-month AMC recorded as a purchase order closes when its first invoice is paid, taking the obligation with it."
      />

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        A contract is a standing obligation with an end date — that is the whole distinction from a purchase order,
        and it is what makes the expiry column matter. A contract with no committed value commits nothing, which is
        why the value can be blank rather than zero: a framework agreement on rates is not a zero-value contract.
      </p>
    </div>
  );
}
