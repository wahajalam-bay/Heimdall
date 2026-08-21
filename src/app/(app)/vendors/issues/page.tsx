import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import {
  Badge,
  EmptyState,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { RankedBars } from "@/components/ui/charts";
import { SEVERITY_TONE, humanize } from "@/lib/domain";
import { ageDays, fmtDate } from "@/lib/format";

export const metadata = { title: "Vendor issues" };
export const dynamic = "force-dynamic";

export default async function VendorIssuesPage() {
  const { user, authorized } = await pageContext(P.VENDOR_VIEW);
  if (!authorized) {
    return <AccessDenied title="Vendor issues" message="You do not have permission to view vendor issues." />;
  }

  const [issues, savedViews] = await Promise.all([
    prisma.vendorIssue.findMany({
      orderBy: { raisedAt: "desc" },
      take: 500,
      include: {
        vendor: { select: { id: true, code: true, name: true, status: true } },
        raisedBy: { select: { name: true } },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "vendor-issues", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const open = issues.filter((i) => !["RESOLVED", "CLOSED"].includes(i.status));
  const critical = issues.filter((i) => i.severity === "CRITICAL");
  const escalated = issues.filter((i) => i.status === "ESCALATED");

  const byType = new Map<string, number>();
  for (const i of issues) byType.set(humanize(i.issueType), (byType.get(humanize(i.issueType)) ?? 0) + 1);
  const byVendor = new Map<string, { count: number; id: string }>();
  for (const i of open) {
    const cur = byVendor.get(i.vendor.name) ?? { count: 0, id: i.vendor.id };
    cur.count += 1;
    byVendor.set(i.vendor.name, cur);
  }

  const columns: TableColumn[] = [
    { key: "number", header: "Issue", locked: true, sortable: true, width: "10rem" },
    { key: "vendor", header: "Vendor", sortable: true, minWidth: "15rem" },
    { key: "type", header: "Type", filterable: true, sortable: true, width: "12rem" },
    { key: "severity", header: "Severity", filterable: true, sortable: true, width: "8.5rem" },
    { key: "title", header: "Issue", sortable: true, minWidth: "22rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "11rem" },
    { key: "vendorStatus", header: "Vendor status", filterable: true, sortable: true, width: "10rem", defaultHidden: true },
    { key: "raisedBy", header: "Raised by", sortable: true, width: "12rem" },
    { key: "raised", header: "Raised", sortable: true, width: "9rem" },
    { key: "age", header: "Age (days)", numeric: true, sortable: true, width: "8rem" },
    { key: "resolved", header: "Resolved", sortable: true, width: "9rem", defaultHidden: true },
    { key: "responded", header: "Vendor responded", filterable: true, sortable: true, width: "10rem" },
  ];

  const rows: TableRow[] = issues.map((i) => {
    const isOpen = !["RESOLVED", "CLOSED"].includes(i.status);
    const age = ageDays(i.raisedAt) ?? 0;
    return {
      id: i.id,
      href: `/vendors/issues/${i.id}`,
      flag:
        i.severity === "CRITICAL" && isOpen
          ? "danger"
          : isOpen && age > 14
            ? "warning"
            : !isOpen
              ? "success"
              : null,
      search: `${i.number} ${i.vendor.name} ${i.title} ${i.description}`,
      values: {
        number: i.number,
        vendor: i.vendor.name,
        type: humanize(i.issueType),
        severity: humanize(i.severity),
        title: i.title,
        status: humanize(i.status),
        vendorStatus: humanize(i.vendor.status),
        raisedBy: i.raisedBy.name,
        raised: i.raisedAt.toISOString(),
        age,
        resolved: i.resolvedAt ? i.resolvedAt.toISOString() : "",
        responded: i.vendorResponse ? "Yes" : "No",
      },
      cells: {
        number: <RefLink href={`/vendors/issues/${i.id}`}>{i.number}</RefLink>,
        vendor: (
          <span>
            <RefLink href={`/vendors/${i.vendor.id}`}>{i.vendor.name}</RefLink>
            <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{i.vendor.code}</span>
          </span>
        ),
        type: humanize(i.issueType),
        severity: <Badge tone={SEVERITY_TONE[i.severity] ?? "neutral"}>{humanize(i.severity)}</Badge>,
        title: (
          <span className="block max-w-[28rem] truncate" title={i.title}>
            {i.title}
          </span>
        ),
        status: <StatusBadge status={i.status} />,
        vendorStatus: <Badge tone="neutral">{humanize(i.vendor.status)}</Badge>,
        raisedBy: i.raisedBy.name,
        raised: fmtDate(i.raisedAt),
        age: isOpen ? age : "—",
        resolved: i.resolvedAt ? fmtDate(i.resolvedAt) : "—",
        responded: i.vendorResponse ? <Badge tone="info">Yes</Badge> : <Badge tone="neutral">No</Badge>,
      },
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Vendors", href: "/vendors" }, { label: "Issues" }]} />

      <PageHeader
        eyebrow="Vendors"
        title="Vendor issues"
        subtitle="Every recorded failure — late delivery, quality, short quantity, document tampering. These feed the performance score and form the evidence base for investigations."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Issues recorded" value={issues.length} />
        <StatTile label="Open" value={open.length} tone={open.length ? "warning" : "success"} />
        <StatTile label="Critical" value={critical.length} tone={critical.length ? "danger" : "default"} />
        <StatTile label="Escalated" value={escalated.length} tone={escalated.length ? "danger" : "default"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Issues by type" description="What actually goes wrong, in order of frequency.">
          <RankedBars
            data={[...byType.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)}
            format="number"
            maxRows={8}
          />
        </SectionCard>
        <SectionCard title="Vendors with most open issues">
          <RankedBars
            data={[...byVendor.entries()]
              .map(([label, v]) => ({ label, value: v.count, href: `/vendors/${v.id}` }))
              .sort((a, b) => b.value - a.value)}
            format="number"
            colorIndex={3}
            maxRows={8}
          />
        </SectionCard>
      </div>

      <DataTable
        id="vendor-issues"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "raised", dir: "desc" }}
        exportName="vendor-issues"
        emptyState={
          <EmptyState
            title="No vendor issues recorded"
            description="Raise an issue from a vendor record, a GRN or an invoice when something goes wrong. It is the only way performance reflects reality."
          />
        }
      />
    </div>
  );
}
