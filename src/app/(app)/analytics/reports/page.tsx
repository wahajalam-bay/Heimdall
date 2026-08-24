import Link from "next/link";
import { pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { REPORT_CATALOGUE, REPORT_GROUPS } from "@/lib/reports";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { Badge, InlineAlert, PageHeader, SectionCard, StatTile } from "@/components/ui/primitives";
import { first } from "@/lib/page";

export const metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

/**
 * Report catalogue. Each report exports as CSV through a single audited
 * endpoint, so a data pull is as traceable as any other action — and each is
 * gated on the same permission that gates the corresponding screen.
 */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, ctx, authorized } = await pageContext(P.ANALYTICS_VIEW, P.AUDIT_VIEW);
  if (!authorized) {
    return <AccessDenied title="Reports" message="You do not have permission to run reports." />;
  }

  const sp = await searchParams;
  const from = first(sp.from) ?? "";
  const to = first(sp.to) ?? "";
  const entity = first(sp.entity) ?? ctx.entityId ?? "";

  const query = (key: string, supportsDates: boolean) => {
    const params = new URLSearchParams();
    if (entity) params.set("entity", entity);
    if (supportsDates && from) params.set("from", from);
    if (supportsDates && to) params.set("to", to);
    const qs = params.toString();
    return `/api/export/${key}${qs ? `?${qs}` : ""}`;
  };

  const available = REPORT_CATALOGUE.filter((r) => userHasPermission(user, ...r.perms));
  const restricted = REPORT_CATALOGUE.filter((r) => !userHasPermission(user, ...r.perms));

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Analytics", href: "/analytics" }, { label: "Reports" }]} />

      <PageHeader
        eyebrow="Analytics"
        title="Reports"
        subtitle="Every report exports as CSV through one audited endpoint, scoped to the entities you can read and gated on the same permission as the corresponding screen."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Reports available to you" value={available.length} />
        <StatTile label="Restricted by permission" value={restricted.length} />
        <StatTile
          label="Entity scope"
          value={entity ? (ctx.entities.find((e) => e.id === entity)?.code ?? "Selected") : "All readable"}
        />
        <StatTile label="Date range" value={from || to ? `${from || "start"} → ${to || "now"}` : "All time"} />
      </div>

      <SectionCard
        title="Scope"
        description="Set the entity and date range once — every report below picks them up. Reports without a date dimension ignore the dates."
      >
        <form className="flex flex-wrap items-end gap-3" method="get">
          <label className="min-w-[12rem] flex-1">
            <span className="label mb-1 block">Entity</span>
            <select className="field" name="entity" defaultValue={entity}>
              <option value="">All entities I can read</option>
              {ctx.entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.code} — {e.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-[9rem]">
            <span className="label mb-1 block">From</span>
            <input className="field" type="date" name="from" defaultValue={from} />
          </label>
          <label className="min-w-[9rem]">
            <span className="label mb-1 block">To</span>
            <input className="field" type="date" name="to" defaultValue={to} />
          </label>
          <button type="submit" className="btn btn-primary btn-sm">
            Apply scope
          </button>
          {(entity || from || to) && (
            <Link href="/analytics/reports" className="btn btn-secondary btn-sm">
              Reset
            </Link>
          )}
        </form>
      </SectionCard>

      {REPORT_GROUPS.map((group) => {
        const inGroup = REPORT_CATALOGUE.filter((r) => r.group === group);
        if (inGroup.length === 0) return null;
        return (
          <SectionCard key={group} title={group}>
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {inGroup.map((r) => {
                const allowed = userHasPermission(user, ...r.perms);
                return (
                  <div
                    key={r.key}
                    className="flex flex-col justify-between gap-2.5 rounded-xl border border-border px-3.5 py-3"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-xs font-600">{r.label}</span>
                        {r.supportsDateRange ? (
                          <Badge tone="neutral">Date range</Badge>
                        ) : (
                          <Badge tone="neutral">Snapshot</Badge>
                        )}
                      </div>
                      <p className="mt-1 text-2xs leading-4 text-muted">{r.description}</p>
                    </div>
                    {allowed ? (
                      <a
                        className="btn btn-secondary btn-sm self-start"
                        href={query(r.key, r.supportsDateRange)}
                        download
                      >
                        Export CSV
                      </a>
                    ) : (
                      <span className="text-2xs text-[var(--c-text-tertiary)]">
                        Requires the {r.perms.join(", ")} permission.
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </SectionCard>
        );
      })}

      <InlineAlert tone="info">
        Exports are recorded in the audit trail with the row count and the scope applied. That is deliberate: knowing who
        pulled which data, and when, is part of the control environment.
      </InlineAlert>

      <SectionCard title="Screens with their own export" description="Every grid in the system exports its current view, filters and all.">
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { href: "/pr", label: "Requisitions" },
            { href: "/po", label: "Purchase orders" },
            { href: "/grn", label: "Goods receipts" },
            { href: "/invoices", label: "Invoices" },
            { href: "/inventory", label: "Inventory" },
            { href: "/vendors", label: "Vendors" },
            { href: "/analytics/exceptions", label: "Exceptions" },
            { href: "/analytics/audit", label: "Audit trail" },
          ].map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-xl border border-border px-3 py-2 text-xs transition-colors hover:bg-[var(--c-surface-hover)]"
            >
              {l.label}
            </Link>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
