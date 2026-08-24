import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { documentTimeline } from "@/server/timeline";
import { availableQuantity } from "@/server/inventory";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  BlockedNotice,
  DefList,
  InlineAlert,
  MetaItem,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatusBadge,
} from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/forms";
import { LifecycleRail, Timeline, buildRail } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { humanize } from "@/lib/domain";
import { fmtDate, fmtDateTime, money, qty, round2 } from "@/lib/format";
import { decideTransferAction } from "@/app/(app)/stores/actions";
import { DispatchTransferForm, ReceiveTransferForm } from "../TransferMovementForms";

export const dynamic = "force-dynamic";

const TRANSFER_LIFECYCLE = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "DISPATCHED", "RECEIVED"] as const;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await prisma.storeTransfer.findUnique({ where: { id }, select: { number: true } });
  return { title: t ? `${t.number} — Store transfer` : "Store transfer" };
}

export default async function TransferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.INVENTORY_VIEW, P.STORE_TRANSFER);
  if (!authorized) return <AccessDenied title="Store transfer" />;

  const t = await prisma.storeTransfer.findUnique({
    where: { id },
    include: {
      fromStore: {
        select: { id: true, name: true, kind: true, entityId: true, city: true, entity: { select: { code: true, name: true } } },
      },
      toStore: {
        select: { id: true, name: true, kind: true, entityId: true, city: true, entity: { select: { code: true, name: true } } },
      },
      requestedBy: { select: { name: true, title: true } },
      items: {
        orderBy: { lineNo: "asc" },
        include: { item: { select: { id: true, sku: true, name: true, unit: true } } },
      },
      transactions: {
        orderBy: { performedAt: "asc" },
        include: { item: { select: { sku: true, name: true } }, store: { select: { name: true } } },
      },
    },
  });
  if (!t) notFound();

  const [events, dispatcher, receiver] = await Promise.all([
    documentTimeline("StoreTransfer", t.id),
    t.dispatchedById
      ? prisma.user.findUnique({ where: { id: t.dispatchedById }, select: { name: true } })
      : Promise.resolve(null),
    t.receivedById
      ? prisma.user.findUnique({ where: { id: t.receivedById }, select: { name: true } })
      : Promise.resolve(null),
  ]);

  // Availability at the source, so an approver knows the transfer can actually be dispatched.
  const availability = new Map<string, number>();
  for (const li of t.items) {
    if (!availability.has(li.itemId)) {
      availability.set(li.itemId, await availableQuantity(li.itemId, t.fromStoreId));
    }
  }

  const canApprove = userHasPermission(user, P.STORE_TRANSFER_APPROVE);
  const canMove = userHasPermission(user, P.STORE_TRANSFER);
  const canReceive = userHasPermission(user, P.STORE_TRANSFER) || userHasPermission(user, P.RECEIVE_GOODS);

  const requestedTotal = round2(t.items.reduce((a, li) => a + li.requestedQty, 0));
  const dispatchedTotal = round2(t.items.reduce((a, li) => a + li.dispatchedQty, 0));
  const receivedTotal = round2(t.items.reduce((a, li) => a + li.receivedQty, 0));
  const dispatchedValue = round2(t.items.reduce((a, li) => a + li.dispatchedQty * li.unitCost, 0));
  const inTransitQty = round2(Math.max(0, dispatchedTotal - receivedTotal));
  const crossEntity = t.fromStore.entityId !== t.toStore.entityId;

  const shortLines = t.items.filter(
    (li) => ["PENDING_APPROVAL", "APPROVED"].includes(t.status) && (availability.get(li.itemId) ?? 0) + 1e-9 < li.requestedQty,
  );
  const shortfallLines = t.items.filter((li) => t.status === "RECEIVED" && li.receivedQty + 1e-9 < li.dispatchedQty);

  const rail = buildRail(
    TRANSFER_LIFECYCLE,
    t.status,
    {
      DRAFT: { at: t.requestedAt, owner: t.requestedBy.name },
      PENDING_APPROVAL: { at: t.requestedAt, owner: t.requestedBy.name },
      APPROVED: { at: t.approvedAt, owner: null },
      DISPATCHED: { at: t.dispatchedAt, owner: dispatcher?.name ?? null },
      RECEIVED: { at: t.receivedAt, owner: receiver?.name ?? null },
    },
    { terminalBad: t.status === "REJECTED" || t.status === "CANCELLED" },
  );

  const summary = `${qty(t.status === "APPROVED" ? requestedTotal : dispatchedTotal)} across ${t.items.length} line(s)`;

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Stores", href: "/stores" },
          { label: "Transfers", href: "/transfers" },
          { label: t.number },
        ]}
      />

      <PageHeader
        eyebrow={crossEntity ? `${t.fromStore.entity.code} → ${t.toStore.entity.code}` : t.fromStore.entity.code}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{t.number}</span>
            <span>
              {t.fromStore.name} → {t.toStore.name}
            </span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={t.status} />
            </MetaItem>
            <MetaItem label="Raised">{fmtDate(t.requestedAt)}</MetaItem>
            <MetaItem label="Raised by">{t.requestedBy.name}</MetaItem>
            <MetaItem label="Lines">{t.items.length}</MetaItem>
            <MetaItem label="Route">
              <Badge tone={crossEntity ? "warning" : "neutral"}>{crossEntity ? "Inter-entity" : "Internal"}</Badge>
            </MetaItem>
          </>
        }
        actions={
          <>
            {t.status === "PENDING_APPROVAL" && canApprove && (
              <>
                <ActionButton
                  action={decideTransferAction}
                  payload={{ transferId: t.id, approve: "true" }}
                  label="Approve transfer"
                  tone="primary"
                  confirm={`Approve ${t.number}? ${t.fromStore.name} will be cleared to dispatch ${qty(requestedTotal)}.`}
                />
                <ActionButton
                  action={decideTransferAction}
                  payload={{ transferId: t.id, approve: "false" }}
                  label="Reject"
                  tone="danger-soft"
                  reasonLabel="Why is this transfer being rejected?"
                  reasonRequired
                />
              </>
            )}
            {t.status === "APPROVED" && canMove && (
              <DispatchTransferForm
                transferId={t.id}
                number={t.number}
                fromStore={t.fromStore.name}
                toStore={t.toStore.name}
                summary={summary}
              />
            )}
            {t.status === "DISPATCHED" && canReceive && (
              <ReceiveTransferForm
                transferId={t.id}
                number={t.number}
                toStore={t.toStore.name}
                summary={summary}
              />
            )}
          </>
        }
      />

      {t.status === "REJECTED" && (
        <BlockedNotice title="This transfer was rejected" reasons={[t.remarks ?? "No reason recorded."]} />
      )}

      {shortLines.length > 0 && (
        <BlockedNotice
          title="The source store cannot currently cover every line"
          reasons={shortLines.map(
            (li) =>
              `${li.item.name}: ${qty(li.requestedQty, li.unit)} requested but only ${qty(availability.get(li.itemId) ?? 0, li.unit)} free at ${t.fromStore.name}.`,
          )}
        />
      )}

      {shortfallLines.length > 0 && (
        <BlockedNotice
          tone="danger"
          title="Less arrived than was dispatched"
          reasons={shortfallLines.map(
            (li) =>
              `${li.item.name}: ${qty(li.dispatchedQty, li.unit)} dispatched but only ${qty(li.receivedQty, li.unit)} received — a shortfall of ${qty(round2(li.dispatchedQty - li.receivedQty), li.unit)}.`,
          )}
        />
      )}

      {t.status === "DISPATCHED" && (
        <InlineAlert tone="warning">
          {qty(inTransitQty)} worth {money(dispatchedValue)} is in transit and appears in neither store balance. It stays
          that way until {t.toStore.name} confirms receipt.
        </InlineAlert>
      )}

      <LifecycleRail steps={rail} title="Transfer lifecycle" />

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <SectionCard title="Transfer lines" bodyClassName="px-0 py-0">
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: "3rem" }}>#</th>
                  <th style={{ minWidth: "16rem" }}>Item</th>
                  <th className="text-right">Requested</th>
                  <th className="text-right">Dispatched</th>
                  <th className="text-right">Received</th>
                  <th className="text-right">Variance</th>
                  <th className="text-right">Unit cost</th>
                  <th className="text-right">Available at source</th>
                  <th>Batch / serial</th>
                </tr>
              </thead>
              <tbody>
                {t.items.map((li) => {
                  const variance = round2(li.receivedQty - li.dispatchedQty);
                  const free = availability.get(li.itemId) ?? 0;
                  const short = ["PENDING_APPROVAL", "APPROVED"].includes(t.status) && free + 1e-9 < li.requestedQty;
                  return (
                    <tr key={li.id}>
                      <td className="num text-xs text-[var(--c-text-tertiary)]">{li.lineNo}</td>
                      <td>
                        <span className="block text-xs font-500">{li.item.name}</span>
                        <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                          <Mono>{li.item.sku}</Mono>
                        </span>
                        {li.notes && (
                          <span className="mt-0.5 block text-2xs text-muted">{li.notes}</span>
                        )}
                      </td>
                      <td className="num text-xs">{qty(li.requestedQty, li.unit)}</td>
                      <td className="num text-xs">
                        {li.dispatchedQty > 0 ? qty(li.dispatchedQty, li.unit) : <span className="text-[var(--c-text-tertiary)]">—</span>}
                      </td>
                      <td className="num text-xs">
                        {li.receivedQty > 0 ? qty(li.receivedQty, li.unit) : <span className="text-[var(--c-text-tertiary)]">—</span>}
                      </td>
                      <td className="num text-xs">
                        {li.dispatchedQty > 0 && variance !== 0 ? (
                          <span className="text-[var(--c-danger)] font-600">{qty(variance, li.unit)}</span>
                        ) : li.dispatchedQty > 0 ? (
                          <Badge tone="success">Matched</Badge>
                        ) : (
                          <span className="text-[var(--c-text-tertiary)]">—</span>
                        )}
                      </td>
                      <td className="num text-xs">{li.unitCost > 0 ? money(li.unitCost) : "—"}</td>
                      <td className="num text-xs">
                        <span className={short ? "text-[var(--c-danger)]" : undefined}>{qty(free, li.unit)}</span>
                      </td>
                      <td className="text-2xs text-muted">
                        {li.batchNumber || li.serialNumber ? (
                          <>
                            {li.batchNumber && <span className="block">Batch {li.batchNumber}</span>}
                            {li.serialNumber && <span className="block">S/N {li.serialNumber}</span>}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2} className="text-xs font-600">
                    Total
                  </td>
                  <td className="num text-xs font-600">{qty(requestedTotal)}</td>
                  <td className="num text-xs font-600">{dispatchedTotal > 0 ? qty(dispatchedTotal) : "—"}</td>
                  <td className="num text-xs font-600">{receivedTotal > 0 ? qty(receivedTotal) : "—"}</td>
                  <td colSpan={4} />
                </tr>
              </tfoot>
            </table>
          </div>
        </SectionCard>

        <div className="space-y-4">
          <SectionCard title="Route and authority">
            <DefList
              items={[
                { label: "Transfer number", value: <Mono>{t.number}</Mono> },
                {
                  label: "From",
                  value: (
                    <span>
                      <RefLink href={`/stores/${t.fromStore.id}`}>{t.fromStore.name}</RefLink>
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        {humanize(t.fromStore.kind)}
                        {t.fromStore.city ? ` · ${t.fromStore.city}` : ""} · {t.fromStore.entity.code}
                      </span>
                    </span>
                  ),
                },
                {
                  label: "To",
                  value: (
                    <span>
                      <RefLink href={`/stores/${t.toStore.id}`}>{t.toStore.name}</RefLink>
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        {humanize(t.toStore.kind)}
                        {t.toStore.city ? ` · ${t.toStore.city}` : ""} · {t.toStore.entity.code}
                      </span>
                    </span>
                  ),
                },
                { label: "Raised by", value: `${t.requestedBy.name}${t.requestedBy.title ? ` — ${t.requestedBy.title}` : ""}` },
                { label: "Raised at", value: fmtDateTime(t.requestedAt) },
                { label: "Approved at", value: t.approvedAt ? fmtDateTime(t.approvedAt) : "Not approved" },
                { label: "Dispatched at", value: t.dispatchedAt ? fmtDateTime(t.dispatchedAt) : "Not dispatched" },
                { label: "Dispatched by", value: dispatcher?.name ?? "—" },
                { label: "Received at", value: t.receivedAt ? fmtDateTime(t.receivedAt) : "Not received" },
                { label: "Received by", value: receiver?.name ?? "—" },
                { label: "Vehicle", value: t.vehicleNumber ?? "—" },
                { label: "Gate pass reference", value: t.gatePassRef ? <Mono>{t.gatePassRef}</Mono> : "—" },
                { label: "Reason", value: t.reason ?? "—", span: true },
                { label: "Remarks", value: t.remarks ?? "—", span: true },
              ]}
            />
          </SectionCard>

          <SectionCard title="Movement summary">
            <div className="space-y-2 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">Requested</span>
                <span className="tnum font-500">{qty(requestedTotal)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">Dispatched</span>
                <span className="tnum font-500">{dispatchedTotal > 0 ? qty(dispatchedTotal) : "—"}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">Received</span>
                <span className="tnum font-500">{receivedTotal > 0 ? qty(receivedTotal) : "—"}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">In transit</span>
                <span className={`tnum font-600 ${inTransitQty > 0 ? "text-[var(--c-warning)]" : ""}`}>
                  {inTransitQty > 0 ? qty(inTransitQty) : "None"}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-separator pt-2">
                <span className="text-muted">Value moved</span>
                <span className="tnum font-600">{money(dispatchedValue)}</span>
              </div>
            </div>
          </SectionCard>

          {crossEntity && (
            <InlineAlert tone="warning">
              This transfer crosses from {t.fromStore.entity.name} to {t.toStore.entity.name}. Finance must record the
              inter-company charge — the inventory value leaves one entity&apos;s books and enters the other&apos;s.
            </InlineAlert>
          )}
        </div>
      </div>

      {t.transactions.length > 0 && (
        <SectionCard
          title="Inventory movements"
          description="Ledger entries written on dispatch and on receipt. Both halves are permanent."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Movement</th>
                  <th>Store</th>
                  <th>Item</th>
                  <th className="text-right">Quantity</th>
                  <th className="text-right">Unit cost</th>
                  <th className="text-right">Value</th>
                  <th className="text-right">Balance after</th>
                  <th>Posted at</th>
                </tr>
              </thead>
              <tbody>
                {t.transactions.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <Mono>{x.number}</Mono>
                      <span className="mt-0.5 block text-2xs">
                        <Badge tone={x.quantity < 0 ? "danger" : "success"}>{humanize(x.type)}</Badge>
                      </span>
                    </td>
                    <td className="text-xs">{x.store.name}</td>
                    <td className="text-xs">{x.item.name}</td>
                    <td className="num text-xs">
                      <span className={x.quantity < 0 ? "text-[var(--c-danger)]" : "text-[var(--c-success)]"}>
                        {x.quantity > 0 ? "+" : ""}
                        {qty(x.quantity, x.unit)}
                      </span>
                    </td>
                    <td className="num text-xs">{money(x.unitCost)}</td>
                    <td className="num text-xs">{money(Math.abs(x.value))}</td>
                    <td className="num text-xs">{qty(x.balanceAfter)}</td>
                    <td className="text-xs">{fmtDateTime(x.performedAt)}</td>
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
          linkedType="STORE_TRANSFER"
          linkedId={t.id}
          entityId={t.fromStore.entityId}
          title="Transfer documents"
          description="Outward gate pass, transfer challan and the signed acknowledgement from the receiving store."
          defaultCategory="Store"
        />
        <SectionCard title="Activity">
          <Timeline events={events} emptyLabel="No activity recorded yet." />
        </SectionCard>
      </div>
    </div>
  );
}
