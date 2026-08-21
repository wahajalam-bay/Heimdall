import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, Mono, PageHeader, RefLink, StatTile, StatusBadge } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { ageHours, fmtDateTime, qty } from "@/lib/format";

export const metadata = { title: "Gate Passes" };
export const dynamic = "force-dynamic";

export default async function GatePassesPage() {
  const { user, ctx, authorized } = await pageContext(P.GATE_PASS_VIEW);
  if (!authorized) {
    return <AccessDenied title="Gate Passes" message="You do not have permission to view gate passes." />;
  }

  const [passes, savedViews] = await Promise.all([
    prisma.gatePass.findMany({
      where: { store: ctx.entityFilter },
      orderBy: { arrivedAt: "desc" },
      take: 400,
      include: {
        po: { select: { id: true, number: true } },
        vendor: { select: { id: true, name: true } },
        store: { select: { id: true, name: true, kind: true, entity: { select: { code: true } } } },
        recordedBy: { select: { name: true } },
        deliveries: { select: { id: true, number: true, status: true } },
        grns: { select: { id: true, number: true } },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "gate-passes", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const stats = {
    total: passes.length,
    awaitingReceipt: passes.filter((g) => g.deliveries.length === 0 && g.status !== "REJECTED").length,
    today: passes.filter((g) => (ageHours(g.arrivedAt) ?? 999) < 24).length,
    received: passes.filter((g) => g.status === "RECEIVED").length,
  };

  const columns: TableColumn[] = [
    { key: "number", header: "Gate pass", locked: true, sortable: true, width: "9.5rem" },
    { key: "serial", header: "Serial", sortable: true, width: "8.5rem" },
    { key: "direction", header: "Direction", filterable: true, sortable: true, width: "7rem" },
    { key: "po", header: "PO", sortable: true, width: "9.5rem" },
    { key: "vendor", header: "Vendor", sortable: true, minWidth: "13rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "store", header: "Receiving store", filterable: true, sortable: true, width: "14rem" },
    { key: "vehicle", header: "Vehicle", sortable: true, width: "9rem" },
    { key: "driver", header: "Driver", sortable: true, width: "11rem" },
    { key: "material", header: "Material", sortable: true, minWidth: "16rem" },
    { key: "packages", header: "Packages", numeric: true, sortable: true, width: "7rem" },
    { key: "declaredQty", header: "Declared qty", numeric: true, sortable: true, width: "8.5rem", defaultHidden: true },
    { key: "challan", header: "Delivery note", sortable: true, width: "10rem", defaultHidden: true },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "10rem" },
    { key: "receipt", header: "Receipt", sortable: true, width: "11rem" },
    { key: "arrived", header: "Arrived", sortable: true, width: "12rem" },
    { key: "recordedBy", header: "Recorded by", sortable: true, width: "11rem", defaultHidden: true },
  ];

  const rows: TableRow[] = passes.map((g) => {
    const delivery = g.deliveries[0];
    const awaiting = !delivery && g.status !== "REJECTED";
    return {
      id: g.id,
      href: `/gate-passes/${g.id}`,
      flag: awaiting && (ageHours(g.arrivedAt) ?? 0) > 8 ? "warning" : delivery ? "success" : null,
      search: `${g.number} ${g.serial} ${g.vendor?.name ?? ""} ${g.vehicleNumber ?? ""} ${g.driverName ?? ""} ${g.materialSummary ?? ""}`,
      values: {
        number: g.number,
        serial: g.serial,
        direction: humanize(g.direction),
        po: g.po?.number ?? "",
        vendor: g.vendor?.name ?? "",
        entity: g.store.entity.code,
        store: g.store.name,
        vehicle: g.vehicleNumber ?? "",
        driver: g.driverName ?? "",
        material: g.materialSummary ?? "",
        packages: g.declaredPackages ?? 0,
        declaredQty: g.declaredQuantity ?? 0,
        challan: g.deliveryNoteRef ?? "",
        status: humanize(g.status),
        receipt: delivery?.number ?? "",
        arrived: g.arrivedAt.toISOString(),
        recordedBy: g.recordedBy.name,
      },
      cells: {
        number: <RefLink href={`/gate-passes/${g.id}`}>{g.number}</RefLink>,
        serial: <Mono>{g.serial}</Mono>,
        direction: <Badge tone={g.direction === "INWARD" ? "info" : "neutral"}>{humanize(g.direction)}</Badge>,
        po: g.po ? <RefLink href={`/po/${g.po.id}`}>{g.po.number}</RefLink> : "—",
        vendor: g.vendor ? <RefLink href={`/vendors/${g.vendor.id}`}>{g.vendor.name}</RefLink> : "—",
        entity: <Badge tone="neutral">{g.store.entity.code}</Badge>,
        store: <RefLink href={`/stores/${g.store.id}`}>{g.store.name}</RefLink>,
        vehicle: g.vehicleNumber ?? "—",
        driver: (
          <span>
            {g.driverName ?? "—"}
            {g.driverPhone && (
              <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{g.driverPhone}</span>
            )}
          </span>
        ),
        material: (
          <span className="block max-w-[22rem] truncate" title={g.materialSummary ?? ""}>
            {g.materialSummary ?? "—"}
          </span>
        ),
        packages: g.declaredPackages ?? "—",
        declaredQty: g.declaredQuantity !== null ? qty(g.declaredQuantity) : "—",
        challan: g.deliveryNoteRef ?? "—",
        status: <StatusBadge status={g.status} />,
        receipt: delivery ? (
          <Link href={`/receiving/${delivery.id}`} className="badge badge-success">
            {delivery.number}
          </Link>
        ) : userHasPermission(user, P.RECEIVE_GOODS) && g.poId ? (
          <Link href={`/receiving/new?poId=${g.poId}`} className="btn btn-primary btn-xs">
            Verify
          </Link>
        ) : (
          <Badge tone="warning">Awaiting</Badge>
        ),
        arrived: fmtDateTime(g.arrivedAt),
        recordedBy: g.recordedBy.name,
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Operations"
        title="Inward gate passes"
        subtitle="Every vehicle arrival, its serial, driver and declared material — recorded at the gate and routed to the receiving store."
        actions={
          userHasPermission(user, P.GATE_PASS_CREATE) && (
            <Link href="/gate-passes/new" className="btn btn-primary btn-sm">
              Record gate pass
            </Link>
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Gate passes" value={stats.total} />
        <StatTile
          label="Awaiting verification"
          value={stats.awaitingReceipt}
          hint="Vehicle in, goods not yet verified"
          tone={stats.awaitingReceipt ? "warning" : "default"}
        />
        <StatTile label="Arrived in last 24h" value={stats.today} tone="accent" />
        <StatTile label="Fully received" value={stats.received} tone="success" />
      </div>

      <DataTable
        id="gate-passes"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "arrived", dir: "desc" }}
        exportName="gate-passes"
        emptyState={
          <EmptyState
            title="No gate passes recorded"
            description="Security or the store records an inward gate pass when a vendor vehicle arrives. It carries a unique serial and links the delivery to its purchase order."
            action={
              userHasPermission(user, P.GATE_PASS_CREATE) && (
                <Link href="/gate-passes/new" className="btn btn-primary btn-sm">
                  Record gate pass
                </Link>
              )
            }
          />
        }
      />
    </div>
  );
}
