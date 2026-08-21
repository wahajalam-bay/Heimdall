import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { grnReadiness } from "@/server/grn";
import { documentTimeline } from "@/server/timeline";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  BlockedNotice,
  Card,
  DefList,
  InlineAlert,
  MetaItem,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { Timeline } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { ActionButton } from "@/components/ui/forms";
import { humanize } from "@/lib/domain";
import { amount, fmtDate, fmtDateTime, money, qty, round2 } from "@/lib/format";
import { raiseInspectionAction } from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await prisma.delivery.findUnique({ where: { id }, select: { number: true } });
  return { title: d ? `${d.number} — Receipt` : "Receipt" };
}

export default async function DeliveryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.RECEIVING_VIEW, P.RECEIVE_GOODS);
  if (!authorized) return <AccessDenied title="Receipt" />;

  const d = await prisma.delivery.findUnique({
    where: { id },
    include: {
      po: {
        select: {
          id: true,
          number: true,
          total: true,
          deliveryDate: true,
          entityId: true,
          entity: { select: { code: true, name: true } },
          pr: { select: { id: true, number: true, title: true } },
        },
      },
      vendor: { select: { id: true, name: true, status: true } },
      store: { select: { id: true, name: true, kind: true } },
      receivedBy: { select: { name: true, title: true } },
      gatePass: {
        select: { id: true, number: true, serial: true, vehicleNumber: true, driverName: true, arrivedAt: true },
      },
      items: { include: { poItem: { select: { unitPrice: true, requiresInspection: true } } }, orderBy: { lineNo: "asc" } },
      inspections: {
        orderBy: { createdAt: "desc" },
        include: { inspector: { select: { name: true } }, items: true },
      },
      grns: { select: { id: true, number: true, status: true, totalValue: true, postedAt: true } },
    },
  });
  if (!d) notFound();

  const [readiness, events] = await Promise.all([
    grnReadiness(d.id).catch(() => ({ ready: false, issues: ["Readiness could not be evaluated."], inspectionStatus: "PENDING" as const })),
    documentTimeline("Delivery", d.id),
  ]);

  const delivered = round2(d.items.reduce((a, i) => a + i.actualQty, 0));
  const accepted = round2(d.items.reduce((a, i) => a + i.acceptedQty, 0));
  const rejected = round2(d.items.reduce((a, i) => a + i.rejectedQty, 0));
  const acceptedValue = round2(d.items.reduce((a, i) => a + i.acceptedQty * i.poItem.unitPrice, 0));
  const discrepancies = d.items.filter((i) => i.discrepancyType !== "OK");
  const grn = d.grns[0];
  const pendingInspection = d.inspections.find((i) =>
    ["PENDING", "IN_PROGRESS", "RE_INSPECTION_REQUIRED"].includes(i.result),
  );
  const needsInspection = d.items.some((i) => i.poItem.requiresInspection && i.acceptedQty > 0);
  const lateDelivery = d.po.deliveryDate && d.deliveryDate > d.po.deliveryDate;

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Operations", href: "/receiving" },
          { label: "Receiving", href: "/receiving" },
          { label: d.number },
        ]}
      />

      <PageHeader
        eyebrow={`${d.po.entity.code} · ${d.store.name}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-[var(--c-text-secondary)]">{d.number}</span>
            <span>{d.vendor.name}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Verification">
              <StatusBadge status={d.status} />
            </MetaItem>
            <MetaItem label="Purchase order">
              <RefLink href={`/po/${d.po.id}`}>{d.po.number}</RefLink>
            </MetaItem>
            {d.po.pr && (
              <MetaItem label="Case">
                <RefLink href={`/pr/${d.po.pr.id}`}>{d.po.pr.number}</RefLink>
              </MetaItem>
            )}
            <MetaItem label="Received">{fmtDateTime(d.deliveryDate)}</MetaItem>
            <MetaItem label="Received by">{d.receivedBy.name}</MetaItem>
          </>
        }
        actions={
          <>
            {grn ? (
              <Link href={`/grn/${grn.id}`} className="btn btn-secondary btn-sm">
                {grn.number}
              </Link>
            ) : readiness.ready && userHasPermission(user, P.GRN_CREATE) ? (
              <Link href={`/grn/new?deliveryId=${d.id}`} className="btn btn-primary btn-sm">
                Raise GRN
              </Link>
            ) : null}
            {needsInspection && !d.inspections.length && userHasPermission(user, P.INSPECTION_PERFORM, P.RECEIVE_GOODS) && (
              <ActionButton
                action={raiseInspectionAction}
                payload={{ deliveryId: d.id }}
                label="Raise inspection"
                tone="secondary"
              />
            )}
            {pendingInspection && (
              <Link href={`/inspections/${pendingInspection.id}`} className="btn btn-primary btn-sm">
                Complete {pendingInspection.number}
              </Link>
            )}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Delivered" value={qty(delivered)} hint={`${d.items.length} line(s)`} />
        <StatTile label="Accepted" value={qty(accepted)} tone={accepted > 0 ? "success" : "default"} />
        <StatTile
          label="Rejected"
          value={rejected > 0 ? qty(rejected) : "—"}
          tone={rejected > 0 ? "danger" : "default"}
        />
        <StatTile label="Accepted value" value={money(acceptedValue)} />
        <StatTile
          label="GRN"
          value={grn ? humanize(grn.status) : readiness.ready ? "Ready" : "Blocked"}
          hint={grn ? grn.number : readiness.issues[0]}
          tone={grn?.status === "POSTED" ? "success" : readiness.ready ? "accent" : "warning"}
        />
      </div>

      {!grn && readiness.issues.length > 0 && (
        <BlockedNotice title="A GRN cannot be raised for this receipt yet" reasons={readiness.issues} />
      )}
      {lateDelivery && (
        <InlineAlert tone="warning">
          Delivered {fmtDate(d.deliveryDate)} against a promised date of {fmtDate(d.po.deliveryDate)} — a late-delivery
          exception has been recorded and counts against the vendor&apos;s on-time performance.
        </InlineAlert>
      )}
      {(d.damageObserved || d.leakageObserved) && (
        <BlockedNotice
          title="Condition issues recorded at receipt"
          reasons={[
            ...(d.damageObserved ? [`Damage observed${d.damageNotes ? `: ${d.damageNotes}` : ""}`] : []),
            ...(d.leakageObserved ? ["Leakage observed"] : []),
            ...(d.handlingNotes ? [`Handling: ${d.handlingNotes}`] : []),
          ]}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <SectionCard title="Verification record">
          <DefList
            columns={2}
            items={[
              { label: "Vendor", value: <RefLink href={`/vendors/${d.vendor.id}`}>{d.vendor.name}</RefLink> },
              { label: "Store", value: `${d.store.name} · ${humanize(d.store.kind)}` },
              { label: "Delivery note", value: d.deliveryNoteRef ?? "—" },
              {
                label: "Packages",
                value:
                  d.totalPackages !== null
                    ? `${d.packagesVerified ?? 0} verified of ${d.totalPackages} declared`
                    : "Not recorded",
              },
              { label: "Packaging condition", value: d.packagingCondition ?? "—" },
              { label: "Physical condition", value: d.physicalCondition ?? "—" },
              {
                label: "Weight recorded",
                value: d.weightRecorded !== null ? `${amount(d.weightRecorded, 3)} ${d.weightUnit ?? ""}` : "—",
              },
              { label: "Documentation", value: d.documentationComplete ? "Complete" : "Incomplete" },
              { label: "Receiver", value: `${d.receivedBy.name}${d.receivedBy.title ? ` — ${d.receivedBy.title}` : ""}` },
              { label: "Remarks", value: d.remarks ?? "—", span: true },
            ]}
          />
        </SectionCard>

        <div className="space-y-4">
          {d.gatePass && (
            <SectionCard title="Gate pass">
              <DefList
                columns={1}
                items={[
                  { label: "Gate pass", value: <RefLink href={`/gate-passes/${d.gatePass.id}`}>{d.gatePass.number}</RefLink> },
                  { label: "Serial", value: <Mono>{d.gatePass.serial}</Mono> },
                  { label: "Vehicle", value: d.gatePass.vehicleNumber ?? "—" },
                  { label: "Driver", value: d.gatePass.driverName ?? "—" },
                  { label: "Arrived", value: fmtDateTime(d.gatePass.arrivedAt) },
                ]}
              />
            </SectionCard>
          )}

          <SectionCard title="Inspection" description={needsInspection ? "Mandatory for one or more lines" : "Not required for these items"}>
            {d.inspections.length === 0 ? (
              <p className="py-2 text-xs text-[var(--c-text-secondary)]">
                {needsInspection
                  ? "Inspection is required but has not been raised."
                  : "No technical inspection is required for these items."}
              </p>
            ) : (
              <ul className="space-y-2">
                {d.inspections.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2">
                      <RefLink href={`/inspections/${i.id}`}>{i.number}</RefLink>
                      <Badge tone="neutral">{humanize(i.inspectionType)}</Badge>
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={i.result} />
                      {i.inspector && (
                        <span className="text-2xs text-[var(--c-text-tertiary)]">{i.inspector.name}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {grn && (
            <SectionCard title="Goods receipt note">
              <DefList
                columns={1}
                items={[
                  { label: "GRN", value: <RefLink href={`/grn/${grn.id}`}>{grn.number}</RefLink> },
                  { label: "Status", value: <StatusBadge status={grn.status} /> },
                  { label: "Value taken in", value: money(grn.totalValue) },
                  { label: "Posted", value: grn.postedAt ? fmtDateTime(grn.postedAt) : "Not posted" },
                ]}
              />
            </SectionCard>
          )}
        </div>
      </div>

      <SectionCard
        title="Line verification"
        description={
          discrepancies.length
            ? `${discrepancies.length} line(s) with a discrepancy — each has raised a tracked exception`
            : "All lines verified clean"
        }
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "2.5rem" }}>#</th>
                <th style={{ minWidth: "16rem" }}>Description</th>
                <th className="text-right">Ordered</th>
                <th className="text-right">Expected</th>
                <th className="text-right">Delivered</th>
                <th className="text-right">Accepted</th>
                <th className="text-right">Rejected</th>
                <th className="text-right">Packages</th>
                <th>Batch / serial / expiry</th>
                <th>Spec match</th>
                <th style={{ minWidth: "14rem" }}>Discrepancy</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((i) => (
                <tr key={i.id} className={i.discrepancyType !== "OK" ? "bg-[var(--c-warning-soft)]/30" : undefined}>
                  <td className="tnum align-top text-[var(--c-text-tertiary)]">{i.lineNo}</td>
                  <td className="align-top">
                    <div>{i.description}</div>
                    {i.conditionNotes && (
                      <div className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">{i.conditionNotes}</div>
                    )}
                    {i.poItem.requiresInspection && <Badge tone="warning">Inspection required</Badge>}
                  </td>
                  <td className="num align-top">{qty(i.orderedQty, i.unit)}</td>
                  <td className="num align-top">{qty(i.expectedQty)}</td>
                  <td className="num align-top font-500">{qty(i.actualQty)}</td>
                  <td className="num align-top">{qty(i.acceptedQty)}</td>
                  <td className="num align-top">
                    <span className={i.rejectedQty > 0 ? "text-[var(--c-danger)]" : undefined}>{qty(i.rejectedQty)}</span>
                  </td>
                  <td className="num align-top text-2xs">{i.packages ?? "—"}</td>
                  <td className="align-top text-2xs">
                    {i.batchNumber && <div>Batch {i.batchNumber}</div>}
                    {i.serialNumbers && (
                      <div className="max-w-[16rem] break-words">{i.serialNumbers}</div>
                    )}
                    {i.expiryDate && <div>Expires {fmtDate(i.expiryDate)}</div>}
                    {i.warrantyMonths && <div>{i.warrantyMonths}m warranty</div>}
                    {!i.batchNumber && !i.serialNumbers && !i.expiryDate && !i.warrantyMonths && "—"}
                  </td>
                  <td className="align-top">
                    <Badge tone={i.specificationMatch ? "success" : "danger"}>
                      {i.specificationMatch ? "Yes" : "No"}
                    </Badge>
                  </td>
                  <td className="align-top">
                    {i.discrepancyType === "OK" ? (
                      <Badge tone="success">No discrepancy</Badge>
                    ) : (
                      <span>
                        <StatusBadge status={i.discrepancyType} />
                        {i.discrepancyNotes && (
                          <span className="mt-1 block text-2xs leading-4 text-[var(--c-warning)]">
                            {i.discrepancyNotes}
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="text-right">Totals</td>
                <td className="num">{qty(delivered)}</td>
                <td className="num">{qty(accepted)}</td>
                <td className="num">{rejected > 0 ? qty(rejected) : "—"}</td>
                <td colSpan={4}>{money(acceptedValue)} accepted value</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <DocumentsPanel
          user={user}
          linkedType="DELIVERY"
          linkedId={d.id}
          entityId={d.po.entityId}
          title="Receipt documents"
          description="Delivery note, weighbridge slips, mill or test certificates and photographs."
          defaultCategory="Delivery"
        />
        <SectionCard title="Activity">
          <Timeline events={events} emptyLabel="No activity recorded yet." />
        </SectionCard>
      </div>
    </div>
  );
}
