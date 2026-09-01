import Link from "next/link";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { Badge, InlineAlert, Mono, PageHeader, StatTile, StatusBadge } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/DataTable";
import { money, fmtDate } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { listWorkOrders } from "@/server/work-orders";

export const metadata = { title: "Work orders" };
export const dynamic = "force-dynamic";

/**
 * Work orders.
 *
 * §4.6 puts these with Admin, on rates procurement negotiated. The column that
 * matters most is the Internal Audit one: the CPC Terms of Reference require
 * that review on every order outside the committee's domain, before the order is
 * finalised, and nothing else in the system carries that gate.
 */
export default async function WorkOrdersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { ctx, authorized } = await pageContext(P.WORK_ORDER_VIEW);
  if (!authorized) {
    return <AccessDenied title="Work orders" message="You do not have access to work orders." />;
  }

  const sp = await searchParams;
  const status = first(sp.status) ?? null;
  const canCreate = userHasPermission(ctx.user, P.WORK_ORDER_CREATE);
  const canReview = userHasPermission(ctx.user, P.WORK_ORDER_AUDIT_REVIEW);

  const rows = await listWorkOrders({ entityIds: visibleEntityIds(ctx.user), status });

  const awaitingAudit = rows.filter((r) => r.status === "PENDING_INTERNAL_AUDIT");
  const open = rows.filter((r) => !["CLOSED", "CANCELLED"].includes(r.status));
  const openValue = open.reduce((a, r) => a + r.total, 0);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Procurement" }, { label: "Work orders" }]} />

      <PageHeader
        eyebrow="Procurement"
        title="Work orders"
        subtitle="ZAM/PUR/SOP-01 §4.6: issued by the Admin department on the basis of rates negotiated by Procurement. Orders outside the committee's domain are reviewed by Internal Audit before they are finalised."
        actions={
          canCreate ? (
            <Link className="btn btn-primary btn-sm" href="/work-orders/new">
              Raise a work order
            </Link>
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="Open orders" value={open.length} hint={money(openValue)} />
        <StatTile
          label="Awaiting Internal Audit"
          value={awaitingAudit.length}
          hint={awaitingAudit.length ? money(awaitingAudit.reduce((a, r) => a + r.total, 0)) : "None"}
          tone={awaitingAudit.length ? "warning" : undefined}
        />
        <StatTile
          label="Issued"
          value={rows.filter((r) => ["ISSUED", "IN_PROGRESS"].includes(r.status)).length}
          hint="With the vendor"
        />
        <StatTile
          label="Completed"
          value={rows.filter((r) => ["COMPLETED", "CLOSED"].includes(r.status)).length}
        />
      </div>

      {canReview && awaitingAudit.length > 0 && (
        <InlineAlert tone="warning">
          {awaitingAudit.length} work order{awaitingAudit.length === 1 ? "" : "s"} awaiting your review. The CPC Terms
          of Reference require Internal Audit to review and approve these before the order is finalised.
        </InlineAlert>
      )}

      <DataTable
        id="work-orders"
        columns={[
          { key: "number", header: "Number", sortable: true },
          { key: "title", header: "Work", filterable: false },
          { key: "vendor", header: "Vendor", filterable: true, sortable: true, width: "13rem" },
          { key: "value", header: "Value", sortable: true, align: "right", width: "10rem" },
          { key: "audit", header: "Internal Audit", filterable: true, sortable: true, width: "11rem" },
          { key: "status", header: "Status", filterable: true, sortable: true, width: "11rem" },
          { key: "raised", header: "Raised", sortable: true, width: "9rem" },
        ]}
        rows={rows.map((r) => ({
          id: r.id,
          href: `/work-orders/${r.id}`,
          search: `${r.number} ${r.title} ${r.vendor.name}`,
          flag: r.status === "PENDING_INTERNAL_AUDIT" ? ("warning" as const) : null,
          cells: {
            number: <Mono>{r.number}</Mono>,
            title: (
              <>
                {r.title}
                <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                  {r._count.items} line{r._count.items === 1 ? "" : "s"} · {r.entity.code}
                </span>
              </>
            ),
            vendor: r.vendor.name,
            value: money(r.total),
            audit: r.internalAuditRequired ? (
              <>
                <Badge
                  tone={
                    r.internalAuditStatus === "APPROVED"
                      ? "success"
                      : r.internalAuditStatus === "REJECTED"
                        ? "danger"
                        : "warning"
                  }
                >
                  {humanize(r.internalAuditStatus)}
                </Badge>
                {r.internalAuditBy && (
                  <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                    {r.internalAuditBy.name}
                  </span>
                )}
              </>
            ) : (
              <span className="text-2xs text-[var(--c-text-tertiary)]">Within CPC&rsquo;s domain</span>
            ),
            status: <StatusBadge status={r.status} />,
            raised: (
              <>
                {fmtDate(r.createdAt)}
                <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{r.createdBy.name}</span>
              </>
            ),
          },
          values: {
            number: r.number,
            title: r.title,
            vendor: r.vendor.name,
            value: r.total,
            audit: r.internalAuditRequired ? humanize(r.internalAuditStatus) : "Within CPC's domain",
            status: r.status,
            raised: r.createdAt.toISOString().slice(0, 10),
          },
        }))}
        emptyState="No work orders yet."
      />

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        The Internal Audit gate applies to orders that fall <em>outside</em> the committee&rsquo;s domain, which is
        what the Terms of Reference say. Above the threshold the CPC case is the review, and stacking a second one
        would be a control the SOP does not ask for.
      </p>
    </div>
  );
}
