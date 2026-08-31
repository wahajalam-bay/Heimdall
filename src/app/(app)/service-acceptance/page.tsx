import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { Badge, InlineAlert, Mono, PageHeader, StatTile } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/DataTable";
import { money, fmtDate } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { statusLink } from "@/lib/links";

export const metadata = { title: "Service acceptance" };
export const dynamic = "force-dynamic";

/**
 * Services accepted, and services still waiting on somebody.
 *
 * The queue that matters here is the second one: an acceptance nobody has
 * confirmed is a vendor who has done the work and cannot be paid.
 */
export default async function ServiceAcceptanceListPage() {
  const { ctx, authorized } = await pageContext(P.RECEIVING_VIEW, P.PO_VIEW);
  if (!authorized) {
    return <AccessDenied title="Service acceptance" message="You do not have access to receiving records." />;
  }

  const rows = await prisma.serviceAcceptance.findMany({
    where: ctx.entityFilter,
    orderBy: { createdAt: "desc" },
    take: 300,
    include: {
      po: { select: { number: true, vendor: { select: { name: true } } } },
      pocUser: { select: { id: true, name: true } },
      entity: { select: { code: true } },
    },
  });

  const pending = rows.filter((r) => r.status === "DRAFT" || r.status === "SUBMITTED");
  const mine = pending.filter((r) => r.pocUserId === ctx.user.id);
  const accepted = rows.filter((r) => r.status === "ACCEPTED" || r.status === "PARTIALLY_ACCEPTED");

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Receiving", href: "/receiving" }, { label: "Service acceptance" }]} />

      <PageHeader
        eyebrow="Receiving"
        title="Service acceptance"
        subtitle="A service has nothing to receive into a store, so its evidence is the confirmation of whoever asked for it. That confirmation is what makes the invoice payable."
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Waiting on you"
          value={mine.length}
          hint="Assigned to you as point of contact"
          tone={mine.length ? "warning" : undefined}
          href={statusLink("/service-acceptance", "status", ["DRAFT", "SUBMITTED"])}
        />
        <StatTile
          label="Awaiting confirmation"
          value={pending.length}
          href={statusLink("/service-acceptance", "status", ["DRAFT", "SUBMITTED"])}
        />
        <StatTile
          label="Confirmed"
          value={accepted.length}
          href={statusLink("/service-acceptance", "status", ["ACCEPTED", "PARTIALLY_ACCEPTED"])}
        />
        <StatTile
          label="Value accepted"
          value={money(accepted.reduce((a, r) => a + r.acceptedValue, 0))}
        />
      </div>

      {mine.length > 0 && (
        <InlineAlert tone="warning">
          {mine.length} service{mine.length === 1 ? "" : "s"} {mine.length === 1 ? "is" : "are"} waiting on your
          confirmation. Until you confirm, the vendor has done the work and cannot be paid for it.
        </InlineAlert>
      )}

      <DataTable
        id="service-acceptance"
        columns={[
          { key: "number", header: "Number", sortable: true, width: "9rem" },
          { key: "status", header: "Status", filterable: true, sortable: true, width: "11rem" },
          { key: "vendor", header: "Vendor", filterable: true, sortable: true },
          { key: "po", header: "Order", sortable: true, width: "9rem" },
          { key: "poc", header: "Point of contact", filterable: true, sortable: true, width: "12rem" },
          { key: "ordered", header: "Ordered", sortable: true, align: "right", width: "9rem" },
          { key: "accepted", header: "Accepted", sortable: true, align: "right", width: "9rem" },
          { key: "raised", header: "Raised", sortable: true, width: "8rem" },
        ]}
        rows={rows.map((r) => {
          const waiting = r.status === "DRAFT" || r.status === "SUBMITTED";
          const short =
            r.status === "PARTIALLY_ACCEPTED" || (r.acceptedValue > 0 && r.acceptedValue < r.orderedValue);
          return {
            id: r.id,
            href: `/service-acceptance/${r.id}`,
            search: `${r.number} ${r.po.number} ${r.po.vendor.name} ${r.pocUser?.name ?? ""}`,
            // The rows that need somebody are the ones nobody has confirmed.
            flag: waiting
              ? r.pocUserId === ctx.user.id
                ? ("warning" as const)
                : null
              : r.status === "REJECTED"
                ? ("danger" as const)
                : null,
            cells: {
              number: <Mono>{r.number}</Mono>,
              status: (
                <Badge
                  tone={
                    r.status === "ACCEPTED"
                      ? "success"
                      : r.status === "PARTIALLY_ACCEPTED"
                        ? "warning"
                        : r.status === "REJECTED"
                          ? "danger"
                          : "neutral"
                  }
                >
                  {humanize(r.status)}
                </Badge>
              ),
              vendor: r.po.vendor.name,
              po: <Mono>{r.po.number}</Mono>,
              poc: r.pocUser?.name ?? "—",
              ordered: money(r.orderedValue),
              accepted: (
                <span className={short ? "text-[var(--c-warn-text)]" : undefined}>
                  {money(r.acceptedValue)}
                </span>
              ),
              raised: fmtDate(r.createdAt),
            },
            values: {
              number: r.number,
              status: humanize(r.status),
              vendor: r.po.vendor.name,
              po: r.po.number,
              poc: r.pocUser?.name ?? "—",
              ordered: r.orderedValue,
              accepted: r.acceptedValue,
              raised: r.createdAt.toISOString().slice(0, 10),
            },
          };
        })}
        emptyState="No service acceptance records yet. They are raised against a service purchase order once the work is done."
      />
    </div>
  );
}
