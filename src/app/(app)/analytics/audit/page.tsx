import Link from "next/link";
import { prisma } from "@/lib/db";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
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
} from "@/components/ui/primitives";
import { RankedBars } from "@/components/ui/charts";
import { humanize } from "@/lib/domain";
import { fmtDateTime, relativeTime } from "@/lib/format";
import { AnalyticsFilters } from "../AnalyticsFilters";
import { buildFilter, filterOptions, periodLabel } from "../filters";
import { tableLink } from "@/lib/links";

export const metadata = { title: "Audit trail" };
export const dynamic = "force-dynamic";

/** Actions that change authority, money or a control — worth calling out. */
const SENSITIVE = [
  "MISMATCH_WAIVED",
  "EXCEPTION_WAIVED",
  "PAYMENT_RECORDED",
  "VENDOR_BLACKLISTED",
  "VENDOR_REINSTATED",
  "CONFIG_UPDATED",
  "ROLE_ASSIGNED",
  "GRN_CANCELLED",
  "PO_CANCELLED",
  "ADJUSTMENT",
];

const isSensitive = (action: string) => SENSITIVE.some((s) => action.includes(s));

/** Links a log row back to the record it describes, where we can. */
function linkFor(entityType: string, entityId: string): string | null {
  const map: Record<string, string> = {
    PurchaseRequisition: "/pr",
    PurchaseOrder: "/po",
    Rfq: "/rfq",
    Comparative: "/comparatives",
    CpcCase: "/cpc/cases",
    CpcMeeting: "/cpc/meetings",
    Grn: "/grn",
    Delivery: "/receiving",
    GatePass: "/gate-passes",
    Inspection: "/inspections",
    Invoice: "/invoices",
    PaymentHandoff: "/finance/handoffs",
    PettyCashRequest: "/petty-cash",
    Vendor: "/vendors",
    VendorIssue: "/vendors/issues",
    VendorBlacklistCase: "/vendors/blacklist",
    Asset: "/assets",
    DisposalCase: "/disposal",
    StoreIssue: "/issuance",
    StoreTransfer: "/transfers",
    Exception: "/analytics/exceptions",
  };
  const base = map[entityType];
  return base ? `${base}/${entityId}` : null;
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, ctx, authorized } = await pageContext(P.AUDIT_VIEW);
  if (!authorized) {
    return <AccessDenied title="Audit trail" message="You do not have permission to view the audit trail." />;
  }

  const sp = await searchParams;
  const filter = buildFilter(user, sp, ctx.entityId);
  const caseKey = first(sp.case) ?? null;
  const actorQuery = first(sp.actor) ?? null;

  const [logs, options, totalCount] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        ...(filter.from || filter.to
          ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
          : {}),
        ...(caseKey ? { caseKey } : {}),
        ...(actorQuery ? { actorId: actorQuery } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 1000,
      include: { actor: { select: { id: true, name: true, title: true } } },
    }),
    filterOptions(user),
    prisma.auditLog.count(),
  ]);

  const sensitive = logs.filter((l) => isSensitive(l.action));
  const withReason = logs.filter((l) => l.reason);
  const distinctActors = new Set(logs.map((l) => l.actorName ?? "System")).size;

  const byAction = new Map<string, number>();
  const byActor = new Map<string, { count: number; id: string | null }>();
  for (const l of logs) {
    byAction.set(humanize(l.action), (byAction.get(humanize(l.action)) ?? 0) + 1);
    const name = l.actorName ?? "System";
    const cur = byActor.get(name) ?? { count: 0, id: l.actorId };
    cur.count += 1;
    byActor.set(name, cur);
  }

  const columns: TableColumn[] = [
    { key: "at", header: "When", locked: true, sortable: true, width: "13rem" },
    { key: "actor", header: "Actor", filterable: true, sortable: true, width: "14rem" },
    { key: "roles", header: "Acting as", filterable: true, sortable: true, width: "14rem", defaultHidden: true },
    { key: "action", header: "Action", filterable: true, sortable: true, width: "18rem" },
    { key: "entityType", header: "Record type", filterable: true, sortable: true, width: "13rem" },
    { key: "entityRef", header: "Record", sortable: true, width: "12rem" },
    { key: "sensitivity", header: "Sensitivity", filterable: true, sortable: true, width: "11rem", defaultHidden: true },
    { key: "reasonGiven", header: "Reason given", filterable: true, sortable: true, width: "11rem", defaultHidden: true },
    { key: "case", header: "Case", filterable: true, sortable: true, width: "11rem" },
    { key: "reason", header: "Reason given", sortable: true, minWidth: "24rem" },
    { key: "changes", header: "Field changes", numeric: true, sortable: true, width: "11rem" },
    { key: "ip", header: "IP", sortable: true, width: "10rem", defaultHidden: true },
  ];

  const rows: TableRow[] = logs.map((l) => {
    const href = linkFor(l.entityType, l.entityId);
    const changeCount = (() => {
      if (!l.changes) return 0;
      try {
        const parsed = JSON.parse(l.changes) as Record<string, { from: unknown; to: unknown }>;
        return Object.entries(parsed).filter(([, v]) => JSON.stringify(v.from) !== JSON.stringify(v.to)).length;
      } catch {
        return 0;
      }
    })();
    return {
      id: l.id,
      href: `/analytics/audit/${l.id}`,
      flag: isSensitive(l.action) ? "warning" : null,
      search: `${l.action} ${l.actorName ?? ""} ${l.entityRef ?? ""} ${l.caseKey ?? ""} ${l.reason ?? ""} ${l.changes ?? ""}`,
      values: {
        at: l.createdAt.toISOString(),
        actor: l.actorName ?? "System",
        roles: l.actorRoles ?? "",
        action: humanize(l.action),
        entityType: l.entityType,
        entityRef: l.entityRef ?? "",
        case: l.caseKey ?? "",
        reason: l.reason ?? "",
        sensitivity: isSensitive(l.action) ? "Sensitive" : "Routine",
        reasonGiven: l.reason ? "Stated" : "None",
        changes: changeCount,
        ip: l.ip ?? "",
      },
      cells: {
        sensitivity: isSensitive(l.action) ? (
          <Badge tone="warning">Sensitive</Badge>
        ) : (
          <span className="text-[var(--c-text-tertiary)]">Routine</span>
        ),
        reasonGiven: l.reason ? (
          <span className="text-[var(--c-text-tertiary)]">Stated</span>
        ) : (
          <span className="text-[var(--c-text-tertiary)]">None</span>
        ),
        at: (
          <span>
            <span className="block text-xs">{fmtDateTime(l.createdAt)}</span>
            <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{relativeTime(l.createdAt)}</span>
          </span>
        ),
        actor: (
          <span>
            <span className="block text-xs">{l.actorName ?? "System"}</span>
            {l.actor?.title && (
              <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{l.actor.title}</span>
            )}
          </span>
        ),
        roles: l.actorRoles ?? "—",
        action: (
          <Badge tone={isSensitive(l.action) ? "warning" : "neutral"}>{humanize(l.action)}</Badge>
        ),
        entityType: l.entityType,
        entityRef: l.entityRef ? (
          href ? (
            <RefLink href={href}>{l.entityRef}</RefLink>
          ) : (
            <Mono>{l.entityRef}</Mono>
          )
        ) : (
          "—"
        ),
        case: l.caseKey ? <RefLink href={`/analytics/audit?case=${encodeURIComponent(l.caseKey)}`}>{l.caseKey}</RefLink> : "—",
        reason: (
          <span className="block max-w-[28rem] truncate" title={l.reason ?? ""}>
            {l.reason ?? "—"}
          </span>
        ),
        changes: changeCount ? (
          <RefLink href={`/analytics/audit/${l.id}`}>
            {changeCount} field{changeCount === 1 ? "" : "s"} changed
          </RefLink>
        ) : (
          <span className="text-2xs text-[var(--c-text-tertiary)]">—</span>
        ),
        ip: l.ip ?? "—",
      },
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Analytics", href: "/analytics" }, { label: "Audit trail" }]} />

      <PageHeader
        eyebrow="Governance"
        title="Audit trail"
        subtitle={`Every action, the person who took it, and the reason they gave — ${periodLabel(filter)}. Append-only: nothing here is edited or deleted.`}
        actions={
          <Link href="/api/export/audit" className="btn btn-secondary btn-sm" prefetch={false}>
            Export CSV
          </Link>
        }
      />

      <AnalyticsFilters entities={options.entities} show={["from", "to"]} />

      {caseKey && (
        <InlineAlert tone="info">
          Filtered to case <Mono>{caseKey}</Mono>.{" "}
          <Link href="/analytics/audit" className="underline">
            Show everything
          </Link>
        </InlineAlert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Entries shown" value={logs.length} hint={`${totalCount} in the full trail`} href="/analytics/audit" />
        <StatTile
          label="Distinct actors"
          value={distinctActors}
          href={tableLink("/analytics/audit", undefined, { sort: "actor:asc" })}
        />
        <StatTile
          label="Sensitive actions"
          value={sensitive.length}
          tone={sensitive.length ? "warning" : "default"}
          hint="Waivers, cancellations, payments, permission and configuration changes"
          href={tableLink("/analytics/audit", { sensitivity: "Sensitive" })}
        />
        <StatTile
          label="Entries with a stated reason"
          value={withReason.length}
          href={tableLink("/analytics/audit", { reasonGiven: "Stated" })}
        />
      </div>

      {sensitive.length > 0 && (
        <SectionCard
          title="Sensitive actions"
          description="Overrides, cancellations, payments and changes to authority or configuration. These are the entries an auditor reads first."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap max-h-[24rem] overflow-y-auto">
            <table className="dt">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Record</th>
                  <th>Reason given</th>
                </tr>
              </thead>
              <tbody>
                {sensitive.map((l) => {
                  const href = linkFor(l.entityType, l.entityId);
                  return (
                    <tr key={l.id}>
                      <td className="text-xs">{fmtDateTime(l.createdAt)}</td>
                      <td className="text-xs">
                        {l.actorName ?? "System"}
                        {l.actorRoles && (
                          <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{l.actorRoles}</span>
                        )}
                      </td>
                      <td>
                        <Badge tone="warning">{humanize(l.action)}</Badge>
                      </td>
                      <td className="text-xs">
                        {href && l.entityRef ? <RefLink href={href}>{l.entityRef}</RefLink> : (l.entityRef ?? l.entityType)}
                      </td>
                      <td className="max-w-[32rem] text-2xs text-muted">
                        {l.reason ?? <span className="text-[var(--c-danger)]">No reason recorded</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Most frequent actions">
          <RankedBars
            data={[...byAction.entries()]
              .map(([label, value]) => ({
                label,
                value,
                href: tableLink("/analytics/audit", { action: label }),
              }))
              .sort((a, b) => b.value - a.value)}
            format="number"
            maxRows={10}
          />
        </SectionCard>
        <SectionCard title="Most active actors" description="Volume alone is not a problem — it is context for the rest.">
          <RankedBars
            data={[...byActor.entries()]
              .map(([label, v]) => ({
                label,
                value: v.count,
                href: v.id ? `/analytics/audit?actor=${v.id}` : undefined,
              }))
              .sort((a, b) => b.value - a.value)}
            format="number"
            colorIndex={1}
            maxRows={10}
          />
        </SectionCard>
      </div>

      <DataTable
        id="audit"
        columns={columns}
        rows={rows}
        defaultSort={{ key: "at", dir: "desc" }}
        exportName="audit-trail"
        defaultPageSize={50}
        emptyState={
          <EmptyState
            title="No audit entries in this range"
            description="Widen the date range. The audit trail is append-only, so entries are never missing for any other reason."
          />
        }
      />
    </div>
  );
}
