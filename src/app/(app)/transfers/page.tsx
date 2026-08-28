import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
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
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, qty, round2 } from "@/lib/format";
import { statusLink, tableLink } from "@/lib/links";

export const metadata = { title: "Store Transfers" };
export const dynamic = "force-dynamic";

export default async function TransfersPage() {
  const { user, ctx, authorized } = await pageContext(P.INVENTORY_VIEW, P.STORE_TRANSFER);
  if (!authorized) {
    return <AccessDenied title="Store transfers" message="You do not have permission to view store transfers." />;
  }

  const [transfers, savedViews] = await Promise.all([
    prisma.storeTransfer.findMany({
      where: {
        OR: [{ fromStore: ctx.entityFilter }, { toStore: ctx.entityFilter }],
      },
      orderBy: { requestedAt: "desc" },
      take: 400,
      include: {
        fromStore: { select: { id: true, name: true, kind: true, entityId: true, entity: { select: { code: true } } } },
        toStore: { select: { id: true, name: true, kind: true, entityId: true, entity: { select: { code: true } } } },
        requestedBy: { select: { name: true } },
        items: {
          select: {
            requestedQty: true,
            dispatchedQty: true,
            receivedQty: true,
            unit: true,
            unitCost: true,
            item: { select: { name: true } },
          },
        },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "transfers", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const canApprove = userHasPermission(user, P.STORE_TRANSFER_APPROVE);
  const canMove = userHasPermission(user, P.STORE_TRANSFER);

  const inTransit = transfers.filter((t) => t.status === "DISPATCHED");
  const stats = {
    open: transfers.filter((t) => ["DRAFT", "PENDING_APPROVAL", "APPROVED", "DISPATCHED"].includes(t.status)).length,
    awaitingApproval: transfers.filter((t) => t.status === "PENDING_APPROVAL").length,
    inTransit: inTransit.length,
    stale: inTransit.filter((t) => (ageDays(t.dispatchedAt) ?? 0) > 3).length,
  };

  const columns: TableColumn[] = [
    { key: "number", header: "Transfer", locked: true, sortable: true, width: "9.5rem" },
    { key: "from", header: "From", filterable: true, sortable: true, width: "13rem" },
    { key: "to", header: "To", filterable: true, sortable: true, width: "13rem" },
    { key: "route", header: "Route", filterable: true, sortable: true, width: "8rem" },
    { key: "reason", header: "Reason", sortable: true, minWidth: "18rem" },
    { key: "lines", header: "Lines", numeric: true, sortable: true, width: "5.5rem" },
    { key: "requestedQty", header: "Requested", numeric: true, sortable: true, width: "8.5rem" },
    { key: "dispatchedQty", header: "Dispatched", numeric: true, sortable: true, width: "8.5rem" },
    { key: "receivedQty", header: "Received", numeric: true, sortable: true, width: "8.5rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "10rem" },
    { key: "vehicle", header: "Vehicle", sortable: true, width: "9rem", defaultHidden: true },
    { key: "requestedBy", header: "Requested by", sortable: true, width: "11rem" },
    { key: "requested", header: "Raised", sortable: true, width: "8.5rem" },
    { key: "dispatched", header: "Dispatched", sortable: true, width: "8.5rem", defaultHidden: true },
    { key: "received", header: "Received", sortable: true, width: "8.5rem", defaultHidden: true },
    { key: "transitDays", header: "Days in transit", numeric: true, sortable: true, width: "9rem" },
    // Time in transit is a clock, not a status: the tile counting stale legs needs
    // a control of its own, and it is worth having as a filter besides.
    { key: "transit", header: "Transit", filterable: true, sortable: true, width: "10rem", defaultHidden: true },
    { key: "action", header: "", width: "7.5rem", noExport: true },
  ];

  const rows: TableRow[] = transfers.map((t) => {
    const requested = round2(t.items.reduce((a, li) => a + li.requestedQty, 0));
    const dispatched = round2(t.items.reduce((a, li) => a + li.dispatchedQty, 0));
    const received = round2(t.items.reduce((a, li) => a + li.receivedQty, 0));
    const crossEntity = t.fromStore.entityId !== t.toStore.entityId;
    const transitDays = t.status === "DISPATCHED" ? (ageDays(t.dispatchedAt) ?? 0) : 0;
    const shortReceipt = t.status === "RECEIVED" && received + 1e-9 < dispatched;
    return {
      id: t.id,
      href: `/transfers/${t.id}`,
      flag:
        t.status === "REJECTED" || shortReceipt
          ? "danger"
          : transitDays > 3
            ? "warning"
            : t.status === "RECEIVED"
              ? "success"
              : null,
      search: `${t.number} ${t.fromStore.name} ${t.toStore.name} ${t.reason ?? ""} ${t.items.map((li) => li.item.name).join(" ")}`,
      values: {
        transit: t.status !== "DISPATCHED" ? "Not in transit" : transitDays > 3 ? "Over 3 days" : "Within 3 days",
        number: t.number,
        from: t.fromStore.name,
        to: t.toStore.name,
        route: crossEntity ? "Inter-entity" : "Intra-entity",
        reason: t.reason ?? "",
        lines: t.items.length,
        requestedQty: requested,
        dispatchedQty: dispatched,
        receivedQty: received,
        status: humanize(t.status),
        vehicle: t.vehicleNumber ?? "",
        requestedBy: t.requestedBy.name,
        requested: t.requestedAt.toISOString(),
        dispatched: t.dispatchedAt ? t.dispatchedAt.toISOString() : "",
        received: t.receivedAt ? t.receivedAt.toISOString() : "",
        transitDays,
        action: "",
      },
      cells: {
        transit:
          t.status !== "DISPATCHED" ? (
            <span className="text-[var(--c-text-tertiary)]">Not in transit</span>
          ) : transitDays > 3 ? (
            <Badge tone="danger">Over 3 days</Badge>
          ) : (
            <span className="text-[var(--c-text-tertiary)]">Within 3 days</span>
          ),
        number: <RefLink href={`/transfers/${t.id}`}>{t.number}</RefLink>,
        from: (
          <span>
            <RefLink href={`/stores/${t.fromStore.id}`}>{t.fromStore.name}</RefLink>
            <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{t.fromStore.entity.code}</span>
          </span>
        ),
        to: (
          <span>
            <RefLink href={`/stores/${t.toStore.id}`}>{t.toStore.name}</RefLink>
            <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{t.toStore.entity.code}</span>
          </span>
        ),
        route: <Badge tone={crossEntity ? "warning" : "neutral"}>{crossEntity ? "Inter-entity" : "Internal"}</Badge>,
        reason: (
          <span className="block max-w-[26rem] truncate" title={t.reason ?? ""}>
            {t.reason ?? "—"}
          </span>
        ),
        lines: t.items.length,
        requestedQty: <Mono>{qty(requested)}</Mono>,
        dispatchedQty: dispatched > 0 ? <Mono>{qty(dispatched)}</Mono> : "—",
        receivedQty:
          received > 0 ? (
            <span className={shortReceipt ? "text-[var(--c-danger)]" : undefined}>
              <Mono>{qty(received)}</Mono>
            </span>
          ) : (
            "—"
          ),
        status: <StatusBadge status={t.status} />,
        vehicle: t.vehicleNumber ?? "—",
        requestedBy: t.requestedBy.name,
        requested: fmtDate(t.requestedAt),
        dispatched: t.dispatchedAt ? fmtDate(t.dispatchedAt) : "—",
        received: t.receivedAt ? fmtDate(t.receivedAt) : "—",
        transitDays: transitDays > 0 ? transitDays : "—",
        action:
          t.status === "PENDING_APPROVAL" && canApprove ? (
            <Link href={`/transfers/${t.id}`} className="btn btn-primary btn-xs">
              Approve
            </Link>
          ) : t.status === "APPROVED" && canMove ? (
            <Link href={`/transfers/${t.id}`} className="btn btn-primary btn-xs">
              Dispatch
            </Link>
          ) : t.status === "DISPATCHED" && canMove ? (
            <Link href={`/transfers/${t.id}`} className="btn btn-primary btn-xs">
              Receive
            </Link>
          ) : (
            <span className="text-2xs text-[var(--c-text-tertiary)]">—</span>
          ),
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Stores"
        title="Store transfers"
        subtitle="Moving stock between warehouses, site stores and project stores — approved before dispatch, and reconciled on receipt."
        actions={
          canMove && (
            <Link href="/transfers/new" className="btn btn-primary btn-sm">
              Raise transfer
            </Link>
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Open transfers"
          value={stats.open}
          hint="Not yet received"
          href={statusLink("/transfers", "status", ["DRAFT", "PENDING_APPROVAL", "APPROVED", "DISPATCHED"])}
        />
        <StatTile
          label="Awaiting approval"
          value={stats.awaitingApproval}
          tone={stats.awaitingApproval ? "warning" : "default"}
          href={statusLink("/transfers", "status", ["PENDING_APPROVAL"])}
        />
        <StatTile
          label="In transit"
          value={stats.inTransit}
          tone="accent"
          hint="Dispatched, not yet received"
          href={statusLink("/transfers", "status", ["DISPATCHED"])}
        />
        <StatTile
          label="In transit over 3 days"
          value={stats.stale}
          tone={stats.stale ? "danger" : "default"}
          hint="Stock unaccounted for in either store"
          href={tableLink("/transfers", { transit: "Over 3 days" })}
        />
      </div>

      {inTransit.length > 0 && (
        <SectionCard
          title="Stock in transit"
          description="Dispatched from the source store but not yet received. This stock sits in neither store balance, so it needs closing out."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Transfer</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Vehicle</th>
                  <th className="text-right">Quantity</th>
                  <th className="text-right">Value</th>
                  <th className="text-right">Days out</th>
                  <th>Dispatched</th>
                </tr>
              </thead>
              <tbody>
                {inTransit.map((t) => {
                  const dispatched = round2(t.items.reduce((a, li) => a + li.dispatchedQty, 0));
                  const value = round2(t.items.reduce((a, li) => a + li.dispatchedQty * li.unitCost, 0));
                  const days = ageDays(t.dispatchedAt) ?? 0;
                  return (
                    <tr key={t.id}>
                      <td>
                        <RefLink href={`/transfers/${t.id}`}>{t.number}</RefLink>
                      </td>
                      <td className="text-xs">{t.fromStore.name}</td>
                      <td className="text-xs">{t.toStore.name}</td>
                      <td className="text-xs">{t.vehicleNumber ?? "—"}</td>
                      <td className="num text-xs">{qty(dispatched)}</td>
                      <td className="num text-xs">{value > 0 ? value.toLocaleString("en-PK") : "—"}</td>
                      <td className="num text-xs">
                        <span className={days > 3 ? "text-[var(--c-danger)] font-600" : undefined}>{days}</span>
                      </td>
                      <td className="text-xs">{fmtDate(t.dispatchedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <DataTable
        id="transfers"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "requested", dir: "desc" }}
        exportName="store-transfers"
        emptyState={
          <EmptyState
            title="No store transfers"
            description="Raise a transfer to move stock between stores. Dispatch and receipt are separate recorded steps, so nothing goes missing in between."
            action={
              canMove && (
                <Link href="/transfers/new" className="btn btn-primary btn-sm">
                  Raise transfer
                </Link>
              )
            }
          />
        }
      />
    </div>
  );
}
