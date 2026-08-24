import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { documentTimeline } from "@/server/timeline";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  DefList,
  InlineAlert,
  MetaItem,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatusBadge,
} from "@/components/ui/primitives";
import { Timeline } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { humanize } from "@/lib/domain";
import { fmtDateTime, money, qty, relativeTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await prisma.gatePass.findUnique({ where: { id }, select: { number: true } });
  return { title: g ? `${g.number} — Gate pass` : "Gate pass" };
}

export default async function GatePassDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.GATE_PASS_VIEW);
  if (!authorized) return <AccessDenied title="Gate pass" />;

  const g = await prisma.gatePass.findUnique({
    where: { id },
    include: {
      po: {
        select: {
          id: true,
          number: true,
          total: true,
          entityId: true,
          vendor: { select: { name: true } },
          pr: { select: { id: true, number: true, title: true } },
          items: { select: { description: true, quantity: true, unit: true, acceptedQty: true } },
        },
      },
      vendor: { select: { id: true, name: true, status: true, contactPhone: true } },
      store: { select: { id: true, name: true, kind: true, address: true, entity: { select: { code: true, name: true } } } },
      recordedBy: { select: { name: true, title: true } },
      deliveries: {
        include: { receivedBy: { select: { name: true } }, items: { select: { id: true } } },
        orderBy: { deliveryDate: "desc" },
      },
      grns: { select: { id: true, number: true, status: true, totalValue: true } },
    },
  });
  if (!g) notFound();

  const events = await documentTimeline("GatePass", g.id);
  const delivery = g.deliveries[0];
  const canReceive = userHasPermission(user, P.RECEIVE_GOODS);

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Operations", href: "/gate-passes" },
          { label: "Gate passes", href: "/gate-passes" },
          { label: g.number },
        ]}
      />

      <PageHeader
        eyebrow={`${g.store.entity.code} · ${g.store.name}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{g.number}</span>
            <span>{g.vendor?.name ?? g.materialSummary ?? "Inward delivery"}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Serial">
              <Mono>{g.serial}</Mono>
            </MetaItem>
            <MetaItem label="Status">
              <StatusBadge status={g.status} />
            </MetaItem>
            <MetaItem label="Direction">
              <Badge tone={g.direction === "INWARD" ? "info" : "neutral"}>{humanize(g.direction)}</Badge>
            </MetaItem>
            <MetaItem label="Arrived">{fmtDateTime(g.arrivedAt)}</MetaItem>
            <MetaItem label="Recorded by">{g.recordedBy.name}</MetaItem>
          </>
        }
        actions={
          delivery ? (
            <Link href={`/receiving/${delivery.id}`} className="btn btn-secondary btn-sm">
              {delivery.number}
            </Link>
          ) : canReceive && g.poId ? (
            <Link href={`/receiving/new?poId=${g.poId}`} className="btn btn-primary btn-sm">
              Verify and receive
            </Link>
          ) : null
        }
      />

      {!delivery && g.status !== "REJECTED" && (
        <InlineAlert tone="warning">
          Goods have been at the gate for {relativeTime(g.arrivedAt).replace(" ago", "")} but no physical verification has
          been recorded. Nothing is in inventory until the store verifies and a GRN is posted.
        </InlineAlert>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <SectionCard title="Gate record">
          <DefList
            columns={2}
            items={[
              { label: "Gate pass number", value: <Mono>{g.number}</Mono> },
              { label: "Unique serial", value: <Mono>{g.serial}</Mono> },
              {
                label: "Purchase order",
                value: g.po ? <RefLink href={`/po/${g.po.id}`}>{g.po.number}</RefLink> : "Non-PO delivery",
              },
              {
                label: "Case",
                value: g.po?.pr ? <RefLink href={`/pr/${g.po.pr.id}`}>{g.po.pr.number}</RefLink> : "—",
              },
              {
                label: "Vendor",
                value: g.vendor ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <RefLink href={`/vendors/${g.vendor.id}`}>{g.vendor.name}</RefLink>
                    <StatusBadge status={g.vendor.status} />
                  </span>
                ) : (
                  "—"
                ),
              },
              { label: "Vendor contact", value: g.vendor?.contactPhone ?? "—" },
              { label: "Receiving store", value: <RefLink href={`/stores/${g.store.id}`}>{g.store.name}</RefLink> },
              { label: "Store address", value: g.store.address ?? "—" },
              { label: "Vehicle", value: g.vehicleNumber ?? "—" },
              { label: "Vehicle type", value: g.vehicleType ?? "—" },
              { label: "Driver", value: g.driverName ?? "—" },
              { label: "Driver CNIC", value: g.driverCnic ?? "—" },
              { label: "Driver phone", value: g.driverPhone ?? "—" },
              { label: "Delivery note", value: g.deliveryNoteRef ?? "—" },
              { label: "Vendor invoice reference", value: g.invoiceRef ?? "—" },
              { label: "Released", value: g.releasedAt ? fmtDateTime(g.releasedAt) : "Not released" },
              { label: "Material declared", value: g.materialSummary ?? "—", span: true },
              { label: "Security remarks", value: g.securityRemarks ?? "—", span: true },
            ]}
          />
        </SectionCard>

        <div className="space-y-4">
          <SectionCard title="Declared vs verified">
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-muted">Declared packages</span>
                <span className="tnum font-500">{g.declaredPackages ?? "—"}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-muted">Declared quantity</span>
                <span className="tnum font-500">
                  {g.declaredQuantity !== null ? qty(g.declaredQuantity) : "—"}
                </span>
              </div>
              {delivery ? (
                <>
                  <div className="flex items-baseline justify-between gap-3 border-t border-separator pt-2 text-xs">
                    <span className="text-muted">Packages verified</span>
                    <span className="tnum font-500">
                      {delivery.packagesVerified ?? "—"} of {delivery.totalPackages ?? "—"}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-muted">Verification outcome</span>
                    <StatusBadge status={delivery.status} />
                  </div>
                </>
              ) : (
                <p className="border-t border-separator pt-2 text-2xs text-[var(--c-text-tertiary)]">
                  Declared figures are the vendor&apos;s. They are not accepted until the store physically verifies them.
                </p>
              )}
            </div>
          </SectionCard>

          {g.po && (
            <SectionCard title="Expected on this order" bodyClassName="px-0 py-0">
              <div className="table-wrap max-h-[16rem] overflow-y-auto">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Line</th>
                      <th className="text-right">Ordered</th>
                      <th className="text-right">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.po.items.map((i, idx) => (
                      <tr key={idx}>
                        <td className="text-xs">{i.description}</td>
                        <td className="num text-xs">{qty(i.quantity, i.unit)}</td>
                        <td className="num text-xs">{qty(Math.max(0, i.quantity - i.acceptedQty))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}

          {g.grns.length > 0 && (
            <SectionCard title="Goods receipt notes">
              <ul className="space-y-2">
                {g.grns.map((x) => (
                  <li key={x.id} className="flex items-center justify-between gap-3">
                    <RefLink href={`/grn/${x.id}`}>{x.number}</RefLink>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={x.status} />
                      <span className="tnum text-xs">{money(x.totalValue)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}
        </div>
      </div>

      {g.deliveries.length > 0 && (
        <SectionCard title="Receipts against this gate pass" bodyClassName="px-0 py-0">
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Receipt</th>
                  <th>Status</th>
                  <th className="text-right">Lines</th>
                  <th>Received by</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {g.deliveries.map((dv) => (
                  <tr key={dv.id}>
                    <td>
                      <RefLink href={`/receiving/${dv.id}`}>{dv.number}</RefLink>
                    </td>
                    <td>
                      <StatusBadge status={dv.status} />
                    </td>
                    <td className="num">{dv.items.length}</td>
                    <td className="text-xs">{dv.receivedBy.name}</td>
                    <td className="text-xs">{fmtDateTime(dv.deliveryDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <DocumentsPanel
          user={user}
          linkedType="GATE_PASS"
          linkedId={g.id}
          entityId={g.po?.entityId ?? null}
          title="Gate pass documents"
          description="Challan, weighbridge slip, vehicle and seal photographs."
          defaultCategory="Gate Pass"
        />
        <SectionCard title="Activity">
          <Timeline events={events} emptyLabel="No activity recorded yet." />
        </SectionCard>
      </div>
    </div>
  );
}
