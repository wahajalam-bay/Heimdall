import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
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
  StatusBadge,
} from "@/components/ui/primitives";
import { BLACKLIST_LIFECYCLE, humanize } from "@/lib/domain";
import { ageDays, fmtDate } from "@/lib/format";

export const metadata = { title: "Vendor investigations" };
export const dynamic = "force-dynamic";

export default async function BlacklistPage() {
  const { user, authorized } = await pageContext(P.VENDOR_VIEW);
  if (!authorized) {
    return (
      <AccessDenied title="Vendor investigations" message="You do not have permission to view vendor investigations." />
    );
  }

  const [cases, savedViews, blacklisted, raisers] = await Promise.all([
    prisma.vendorBlacklistCase.findMany({
      orderBy: { raisedAt: "desc" },
      take: 400,
      include: { vendor: { select: { id: true, code: true, name: true, status: true, totalSpend: true } } },
    }),
    prisma.savedView.findMany({
      where: { resource: "vendor-blacklist", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
    prisma.vendor.findMany({
      where: { status: "BLACKLISTED" },
      select: { id: true, code: true, name: true, statusReason: true, blacklistedAt: true, totalSpend: true },
      orderBy: { blacklistedAt: "desc" },
    }),
    prisma.user.findMany({ select: { id: true, name: true } }),
  ]);
  const raiserName = new Map(raisers.map((r) => [r.id, r.name]));

  const openCases = cases.filter((c) => c.stage !== "CLOSED");
  const awaitingAudit = cases.filter((c) => c.stage === "AUDIT_REVIEW");
  const awaitingVendor = cases.filter((c) => c.stage === "VENDOR_RESPONSE_AWAITED");

  const stageCounts = BLACKLIST_LIFECYCLE.map((s) => ({
    stage: s,
    count: cases.filter((c) => c.stage === s).length,
  }));

  const columns: TableColumn[] = [
    { key: "number", header: "Case", locked: true, sortable: true, width: "10rem" },
    { key: "vendor", header: "Vendor", sortable: true, minWidth: "15rem" },
    { key: "reasonCode", header: "Reason", filterable: true, sortable: true, width: "13rem" },
    { key: "stage", header: "Stage", filterable: true, sortable: true, width: "13rem" },
    { key: "decision", header: "Decision", filterable: true, sortable: true, width: "10rem" },
    { key: "auditRequired", header: "Audit required", filterable: true, sortable: true, width: "9.5rem" },
    { key: "vendorResponded", header: "Vendor replied", filterable: true, sortable: true, width: "9.5rem" },
    { key: "vendorStatus", header: "Vendor status", filterable: true, sortable: true, width: "10rem" },
    { key: "spendAtRisk", header: "Historic spend", numeric: true, sortable: true, width: "11rem" },
    { key: "raisedBy", header: "Raised by", sortable: true, width: "12rem" },
    { key: "raised", header: "Raised", sortable: true, width: "9rem" },
    { key: "age", header: "Age (days)", numeric: true, sortable: true, width: "8rem" },
    { key: "closed", header: "Closed", sortable: true, width: "9rem", defaultHidden: true },
  ];

  const rows: TableRow[] = cases.map((c) => {
    const isOpen = c.stage !== "CLOSED";
    const age = ageDays(c.raisedAt) ?? 0;
    return {
      id: c.id,
      href: `/vendors/blacklist/${c.id}`,
      flag:
        c.decision === "BLACKLIST"
          ? "danger"
          : isOpen && age > 30
            ? "warning"
            : c.stage === "CLOSED"
              ? "success"
              : null,
      search: `${c.number} ${c.vendor.name} ${c.reason} ${c.reasonCode}`,
      values: {
        number: c.number,
        vendor: c.vendor.name,
        reasonCode: humanize(c.reasonCode),
        stage: humanize(c.stage),
        decision: c.decision ? humanize(c.decision) : "",
        auditRequired: c.auditRequired ? "Yes" : "No",
        vendorResponded: c.vendorRespondedAt ? "Yes" : "No",
        vendorStatus: humanize(c.vendor.status),
        spendAtRisk: c.vendor.totalSpend,
        raisedBy: raiserName.get(c.raisedById) ?? "—",
        raised: c.raisedAt.toISOString(),
        age,
        closed: c.closedAt ? c.closedAt.toISOString() : "",
      },
      cells: {
        number: <RefLink href={`/vendors/blacklist/${c.id}`}>{c.number}</RefLink>,
        vendor: (
          <span>
            <RefLink href={`/vendors/${c.vendor.id}`}>{c.vendor.name}</RefLink>
            <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{c.vendor.code}</span>
          </span>
        ),
        reasonCode: humanize(c.reasonCode),
        stage: <StatusBadge status={c.stage} />,
        decision: c.decision ? (
          <Badge tone={c.decision === "BLACKLIST" ? "danger" : c.decision === "RETAIN" ? "success" : "warning"}>
            {humanize(c.decision)}
          </Badge>
        ) : (
          <span className="text-2xs text-[var(--c-text-tertiary)]">Pending</span>
        ),
        auditRequired: c.auditRequired ? <Badge tone="info">Required</Badge> : <Badge tone="neutral">No</Badge>,
        vendorResponded: c.vendorRespondedAt ? (
          <Badge tone="success">{fmtDate(c.vendorRespondedAt)}</Badge>
        ) : (
          <Badge tone="warning">Awaited</Badge>
        ),
        vendorStatus: <StatusBadge status={c.vendor.status} />,
        spendAtRisk: <Mono>{c.vendor.totalSpend.toLocaleString("en-PK")}</Mono>,
        raisedBy: raiserName.get(c.raisedById) ?? "—",
        raised: fmtDate(c.raisedAt),
        age: isOpen ? age : "—",
        closed: c.closedAt ? fmtDate(c.closedAt) : "—",
      },
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Vendors", href: "/vendors" }, { label: "Investigations" }]} />

      <PageHeader
        eyebrow="Vendors"
        title="Investigations and blacklisting"
        subtitle="Blacklisting is the outcome of a case, never a switch someone flips. Evidence is collected, the vendor replies, procurement reviews and audit signs off before any decision."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Open investigations" value={openCases.length} tone={openCases.length ? "warning" : "default"} />
        <StatTile label="Awaiting vendor reply" value={awaitingVendor.length} />
        <StatTile label="Awaiting audit review" value={awaitingAudit.length} tone={awaitingAudit.length ? "accent" : "default"} />
        <StatTile
          label="Currently blacklisted"
          value={blacklisted.length}
          tone={blacklisted.length ? "danger" : "success"}
        />
      </div>

      <InlineAlert tone="info">
        A vendor cannot be blacklisted without an investigation reaching the decision stage, and where audit review is
        marked required the decision stage itself is blocked until that review is recorded. This is enforced on the
        server.
      </InlineAlert>

      {openCases.length > 0 && (
        <SectionCard title="Where open cases sit" description="Stage distribution across live investigations.">
          <div className="flex flex-wrap gap-2">
            {stageCounts
              .filter((s) => s.count > 0)
              .map((s) => (
                <span
                  key={s.stage}
                  className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--c-border)] px-2.5 py-1.5 text-xs"
                >
                  <StatusBadge status={s.stage} />
                  <span className="tnum font-600">{s.count}</span>
                </span>
              ))}
          </div>
        </SectionCard>
      )}

      {blacklisted.length > 0 && (
        <SectionCard
          title="Blacklisted vendors"
          description="Sourcing is refused for these vendors. Reinstatement needs an explicit, reasoned decision."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Reason on record</th>
                  <th className="text-right">Historic spend</th>
                  <th>Blacklisted</th>
                </tr>
              </thead>
              <tbody>
                {blacklisted.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <RefLink href={`/vendors/${v.id}`}>{v.name}</RefLink>
                      <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{v.code}</span>
                    </td>
                    <td className="max-w-[30rem] text-xs text-[var(--c-text-secondary)]">{v.statusReason ?? "—"}</td>
                    <td className="num text-xs">{v.totalSpend.toLocaleString("en-PK")}</td>
                    <td className="text-xs">{v.blacklistedAt ? fmtDate(v.blacklistedAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <DataTable
        id="vendor-blacklist"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "raised", dir: "desc" }}
        exportName="vendor-investigations"
        emptyState={
          <EmptyState
            title="No investigations opened"
            description="Open an investigation from a vendor record when the evidence warrants it. It is the only route to blacklisting."
          />
        }
      />
    </div>
  );
}
