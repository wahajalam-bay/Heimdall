import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { scoreBand, vendorsDueForReevaluation } from "@/server/vendors";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import {
  Badge,
  EmptyState,
  Meter,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { TabNav } from "@/components/ui/nav";
import { humanize } from "@/lib/domain";
import { first, type SearchParams } from "@/lib/page";
import { fmtDate, money, percent, round2 } from "@/lib/format";

export const metadata = { title: "Vendors" };
export const dynamic = "force-dynamic";

export default async function VendorsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, authorized } = await pageContext(P.VENDOR_VIEW);
  if (!authorized) {
    return <AccessDenied title="Vendors" message="You do not have permission to view the vendor register." />;
  }

  const sp = await searchParams;
  const tab = first(sp.tab) ?? "all";
  const scoped = visibleEntityIds(user);

  const [vendors, savedViews, passMark, maxScore, dueForReeval] = await Promise.all([
    prisma.vendor.findMany({
      orderBy: { name: "asc" },
      where: scoped ? { OR: [{ entityLinks: { some: { entityId: { in: scoped } } } }, { entityLinks: { none: {} } }] } : {},
      include: {
        entityLinks: { include: { entity: { select: { code: true } } } },
        evaluations: { orderBy: { evaluatedAt: "desc" }, take: 1, select: { evaluatedAt: true, percentage: true } },
        issues: { where: { status: { notIn: ["RESOLVED", "CLOSED"] } }, select: { id: true, severity: true } },
        blacklistCases: { where: { stage: { notIn: ["CLOSED"] } }, select: { id: true, number: true, stage: true } },
        _count: { select: { purchaseOrders: true, quotes: true } },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "vendors", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
    getConfigNumber(CONFIG_KEYS.VENDOR_MIN_SCORE, null),
    getConfigNumber(CONFIG_KEYS.VENDOR_MAX_SCORE, null),
    vendorsDueForReevaluation(),
  ]);

  const canCreate = userHasPermission(user, P.VENDOR_CREATE);

  const filtered = vendors.filter((v) => {
    if (tab === "approved") return ["APPROVED", "CONDITIONAL"].includes(v.status);
    if (tab === "pipeline") return ["PROSPECT", "UNDER_EVALUATION", "PENDING_APPROVAL"].includes(v.status);
    if (tab === "restricted") return ["SUSPENDED", "BLACKLISTED", "INACTIVE"].includes(v.status);
    if (tab === "traders") return v.isTrader;
    return true;
  });

  const stats = {
    approved: vendors.filter((v) => ["APPROVED", "CONDITIONAL"].includes(v.status)).length,
    pipeline: vendors.filter((v) => ["PROSPECT", "UNDER_EVALUATION", "PENDING_APPROVAL"].includes(v.status)).length,
    restricted: vendors.filter((v) => ["SUSPENDED", "BLACKLISTED"].includes(v.status)).length,
    dueReeval: dueForReeval.length,
  };

  const columns: TableColumn[] = [
    { key: "code", header: "Code", locked: true, sortable: true, width: "8rem" },
    { key: "name", header: "Vendor", sortable: true, minWidth: "16rem" },
    { key: "type", header: "Type", filterable: true, sortable: true, width: "10rem" },
    { key: "city", header: "City", filterable: true, sortable: true, width: "9rem" },
    { key: "categories", header: "Supplies", sortable: true, minWidth: "16rem" },
    { key: "entities", header: "Entities", filterable: true, sortable: true, width: "8rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "10rem" },
    { key: "score", header: "Pre-qual", numeric: true, sortable: true, width: "9rem" },
    { key: "performance", header: "Performance", numeric: true, sortable: true, width: "10rem" },
    { key: "onTime", header: "On time", numeric: true, sortable: true, width: "8rem" },
    { key: "quality", header: "Quality", numeric: true, sortable: true, width: "8rem" },
    { key: "orders", header: "Orders", numeric: true, sortable: true, width: "7rem" },
    { key: "spend", header: "Spend", numeric: true, sortable: true, width: "11rem" },
    { key: "issues", header: "Open issues", numeric: true, sortable: true, width: "8.5rem" },
    { key: "investigation", header: "Investigation", sortable: true, width: "11rem" },
    { key: "taxStatus", header: "Tax", filterable: true, sortable: true, width: "8rem", defaultHidden: true },
    { key: "evaluated", header: "Last evaluated", sortable: true, width: "10rem" },
    { key: "lastOrder", header: "Last order", sortable: true, width: "9.5rem", defaultHidden: true },
  ];

  const rows: TableRow[] = filtered.map((v) => {
    const band = scoreBand(v.scorePercent);
    const openCase = v.blacklistCases[0];
    const critical = v.issues.filter((i) => ["HIGH", "CRITICAL"].includes(i.severity)).length;
    return {
      id: v.id,
      href: `/vendors/${v.id}`,
      flag:
        v.status === "BLACKLISTED"
          ? "danger"
          : openCase
            ? "warning"
            : v.status === "APPROVED" && (v.performanceScore ?? 0) >= 80
              ? "success"
              : null,
      search: `${v.code} ${v.name} ${v.legalName ?? ""} ${v.categories ?? ""} ${v.city ?? ""} ${v.ntn ?? ""}`,
      values: {
        code: v.code,
        name: v.name,
        type: humanize(v.businessType),
        city: v.city ?? "",
        categories: v.categories ?? "",
        entities: v.entityLinks.map((l) => l.entity.code).join(", "),
        status: humanize(v.status),
        score: v.scorePercent ?? 0,
        performance: v.performanceScore ?? 0,
        onTime: v.onTimePercent ?? 0,
        quality: v.qualityPercent ?? 0,
        orders: v.totalOrders,
        spend: v.totalSpend,
        issues: v.issues.length,
        investigation: openCase ? humanize(openCase.stage) : "",
        taxStatus: humanize(v.taxStatus),
        evaluated: v.evaluations[0]?.evaluatedAt ? v.evaluations[0].evaluatedAt.toISOString() : "",
        lastOrder: v.lastOrderAt ? v.lastOrderAt.toISOString() : "",
      },
      cells: {
        code: <Mono>{v.code}</Mono>,
        name: (
          <span>
            <RefLink href={`/vendors/${v.id}`}>{v.name}</RefLink>
            {v.isTrader && <Badge tone="neutral">Trader</Badge>}
            {v.legalName && v.legalName !== v.name && (
              <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{v.legalName}</span>
            )}
          </span>
        ),
        type: humanize(v.businessType),
        city: v.city ?? "—",
        categories: (
          <span className="block max-w-[22rem] truncate" title={v.categories ?? ""}>
            {v.categories ?? "—"}
          </span>
        ),
        entities: v.entityLinks.length ? (
          <span className="flex flex-wrap gap-1">
            {v.entityLinks.map((l) => (
              <Badge key={l.entityId} tone={l.approved ? "info" : "neutral"}>
                {l.entity.code}
              </Badge>
            ))}
          </span>
        ) : (
          "—"
        ),
        status: <StatusBadge status={v.status} />,
        score:
          v.scorePercent === null ? (
            <span className="text-2xs text-[var(--c-text-tertiary)]">Not scored</span>
          ) : (
            <span className="flex items-center justify-end gap-2">
              <Badge tone={band.tone}>{percent(v.scorePercent, 0)}</Badge>
            </span>
          ),
        performance:
          v.performanceScore === null ? (
            "—"
          ) : (
            <Meter value={v.performanceScore} max={100} tone={v.performanceScore >= 70 ? "success" : v.performanceScore >= 50 ? "warning" : "danger"} showValue />
          ),
        onTime: v.onTimePercent === null ? "—" : percent(v.onTimePercent, 0),
        quality: v.qualityPercent === null ? "—" : percent(v.qualityPercent, 0),
        orders: v.totalOrders,
        spend: v.totalSpend > 0 ? <Mono>{money(v.totalSpend)}</Mono> : "—",
        issues:
          v.issues.length === 0 ? (
            "—"
          ) : (
            <Badge tone={critical > 0 ? "danger" : "warning"}>{v.issues.length}</Badge>
          ),
        investigation: openCase ? (
          <RefLink href={`/vendors/blacklist/${openCase.id}`}>{humanize(openCase.stage)}</RefLink>
        ) : (
          <span className="text-2xs text-[var(--c-text-tertiary)]">—</span>
        ),
        taxStatus: humanize(v.taxStatus),
        evaluated: v.evaluations[0]?.evaluatedAt ? fmtDate(v.evaluations[0].evaluatedAt) : "Never",
        lastOrder: v.lastOrderAt ? fmtDate(v.lastOrderAt) : "—",
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Vendors"
        title="Vendor register"
        subtitle={`Pre-qualification, performance and conduct in one record. The pass mark is ${passMark} of ${maxScore} — both configurable.`}
        actions={
          <>
            <Link href="/vendors/prequalification" className="btn btn-secondary btn-sm">
              Pre-qualification queue
            </Link>
            {canCreate && (
              <Link href="/vendors/new" className="btn btn-primary btn-sm">
                Register vendor
              </Link>
            )}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Usable vendors"
          value={stats.approved}
          tone="success"
          hint="Approved or conditional"
          href="/vendors?tab=approved"
        />
        <StatTile
          label="In the pipeline"
          value={stats.pipeline}
          hint="Prospect, under evaluation or pending approval"
          href="/vendors?tab=pipeline"
        />
        <StatTile
          label="Suspended or blacklisted"
          value={stats.restricted}
          tone={stats.restricted ? "danger" : "default"}
          href="/vendors?tab=restricted"
        />
        <StatTile
          label="Due re-evaluation"
          value={stats.dueReeval}
          tone={stats.dueReeval ? "warning" : "default"}
          hint="Past the configured re-evaluation interval"
          href="/vendors/evaluations"
        />
      </div>

      {dueForReeval.length > 0 && (
        <SectionCard
          title="Due for re-evaluation"
          description="These vendors are past the configured re-evaluation interval. Approved status persists, but the scoring on file is stale."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap max-h-[18rem] overflow-y-auto">
            <table className="dt">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Status</th>
                  <th className="text-right">Score on file</th>
                  <th>Last evaluated</th>
                </tr>
              </thead>
              <tbody>
                {dueForReeval.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <RefLink href={`/vendors/${v.id}`}>{v.name}</RefLink>
                      <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{v.code}</span>
                    </td>
                    <td>
                      <StatusBadge status={v.status} />
                    </td>
                    <td className="num text-xs">
                      {v.currentScore !== null && v.maxScore
                        ? `${round2(v.currentScore)} / ${round2(v.maxScore)}`
                        : "—"}
                    </td>
                    <td className="text-xs">{fmtDate(v.lastEvaluatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <TabNav
        baseHref="/vendors"
        tabs={[
          { key: "all", label: "All", count: vendors.length },
          { key: "approved", label: "Usable", count: stats.approved },
          { key: "pipeline", label: "Pipeline", count: stats.pipeline },
          { key: "restricted", label: "Restricted", count: stats.restricted },
          { key: "traders", label: "Traders", count: vendors.filter((v) => v.isTrader).length },
        ]}
        active={tab}
      />

      <DataTable
        id={`vendors-${tab}`}
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "name", dir: "asc" }}
        exportName="vendors"
        emptyState={
          <EmptyState
            title="No vendors in this view"
            description="A vendor becomes usable only after pre-qualification scoring and an explicit approval decision."
            action={
              canCreate && (
                <Link href="/vendors/new" className="btn btn-primary btn-sm">
                  Register vendor
                </Link>
              )
            }
          />
        }
      />
    </div>
  );
}
