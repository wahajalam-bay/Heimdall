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
  Card,
  DefList,
  EmptyState,
  InlineAlert,
  MetaItem,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { Timeline } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { ActionButton } from "@/components/ui/forms";
import { STORE_ENTRY_DISPOSITIONS, humanize } from "@/lib/domain";
import { fmtDate, fmtDateTime, money, qty, round2 } from "@/lib/format";
import { cancelGrnAction, postGrnAction } from "@/app/(app)/receiving/actions";
import { StackingForm } from "./StackingForm";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await prisma.grn.findUnique({ where: { id }, select: { number: true } });
  return { title: g ? `${g.number} — GRN` : "GRN" };
}

export default async function GrnDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.GRN_VIEW);
  if (!authorized) return <AccessDenied title="GRN" />;

  const g = await prisma.grn.findUnique({
    where: { id },
    include: {
      po: {
        select: {
          id: true,
          number: true,
          total: true,
          entityId: true,
          entity: { select: { code: true, name: true } },
          pr: { select: { id: true, number: true, title: true, project: { select: { name: true } } } },
        },
      },
      vendor: { select: { id: true, name: true, status: true } },
      delivery: { select: { id: true, number: true, deliveryDate: true, status: true, deliveryNoteRef: true } },
      gatePass: { select: { id: true, number: true, serial: true } },
      inspection: { select: { id: true, number: true, result: true, signedByName: true } },
      store: {
        select: {
          id: true,
          name: true,
          kind: true,
          locations: { where: { active: true }, orderBy: { label: "asc" } },
        },
      },
      receivedBy: { select: { name: true, title: true } },
      items: {
        orderBy: { lineNo: "asc" },
        include: { item: { select: { id: true, sku: true, name: true } } },
      },
      transactions: {
        include: { item: { select: { sku: true, name: true } }, store: { select: { name: true } } },
        orderBy: { performedAt: "asc" },
      },
      invoiceMatches: { include: { invoice: { select: { id: true, number: true, status: true, matchStatus: true, total: true } } } },
      stacking: {
        include: { location: { select: { label: true, handling: true } }, stackedBy: { select: { name: true } } },
        orderBy: { stackedAt: "desc" },
      },
      assets: { select: { id: true, tag: true, name: true, status: true } },
    },
  });
  if (!g) notFound();

  const events = await documentTimeline("Grn", g.id);

  const accepted = round2(g.items.reduce((a, i) => a + i.acceptedQty, 0));
  const rejected = round2(g.items.reduce((a, i) => a + i.rejectedQty, 0));
  const stockLines = g.items.filter((i) => STORE_ENTRY_DISPOSITIONS.includes(i.disposition as never));
  const canPost = g.status === "DRAFT" && userHasPermission(user, P.GRN_POST);
  const canCancel = g.status !== "CANCELLED" && userHasPermission(user, P.GRN_CANCEL) && g.invoiceMatches.length === 0;
  const canStack = g.status === "POSTED" && userHasPermission(user, P.STACKING_RECORD);

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Operations", href: "/grn" },
          { label: "GRNs", href: "/grn" },
          { label: g.number },
        ]}
      />

      <PageHeader
        eyebrow={`${g.po.entity.code} · ${g.store.name}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-[var(--c-text-secondary)]">{g.number}</span>
            <span>{g.vendor.name}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={g.status} />
            </MetaItem>
            <MetaItem label="Value">{money(g.totalValue)}</MetaItem>
            <MetaItem label="PO">
              <RefLink href={`/po/${g.po.id}`}>{g.po.number}</RefLink>
            </MetaItem>
            {g.po.pr && (
              <MetaItem label="Case">
                <RefLink href={`/pr/${g.po.pr.id}`}>{g.po.pr.number}</RefLink>
              </MetaItem>
            )}
            <MetaItem label="Received">{fmtDateTime(g.receivedAt)}</MetaItem>
            <MetaItem label="By">{g.receivedBy.name}</MetaItem>
          </>
        }
        actions={
          <>
            {canPost && (
              <ActionButton
                action={postGrnAction}
                payload={{ grnId: g.id }}
                label="Post to inventory"
                tone="primary"
                confirm={`Post ${g.number}? This takes ${qty(accepted)} of goods into ${g.store.name}, updates the purchase order balance and tags any assets.`}
              />
            )}
            {canStack && g.stacking.length === 0 && (
              <StackingForm
                grnId={g.id}
                grnNumber={g.number}
                storeId={g.storeId}
                storeName={g.store.name}
                locations={g.store.locations.map((l) => ({
                  id: l.id,
                  label: l.label,
                  zone: l.zone,
                  rack: l.rack,
                  bin: l.bin,
                  handling: l.handling,
                }))}
                candidates={stockLines.map((i) => ({
                  itemId: i.itemId,
                  description: i.description,
                  quantity: i.acceptedQty,
                  unit: i.unit,
                  suggestedLocationId: i.storeLocationId,
                  suggestedClass: i.disposition === "PROJECT_MATERIAL" ? "PROJECT_MATERIAL" : "GENERAL",
                }))}
              />
            )}
            {canCancel && (
              <ActionButton
                action={cancelGrnAction}
                payload={{ grnId: g.id }}
                label="Cancel GRN"
                tone="danger-soft"
                reasonLabel="Why is this GRN being cancelled? Compensating inventory movements will be written and an exception raised."
                reasonRequired
              />
            )}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Accepted into inventory" value={qty(accepted)} hint={`${g.items.length} line(s)`} tone="success" />
        <StatTile label="Rejected" value={rejected > 0 ? qty(rejected) : "—"} tone={rejected > 0 ? "danger" : "default"} />
        <StatTile label="Value" value={money(g.totalValue)} />
        <StatTile
          label="Inspection"
          value={humanize(g.inspectionStatus)}
          hint={g.inspection ? g.inspection.number : "Not required for these items"}
          tone={g.inspectionStatus === "APPROVED" ? "success" : g.inspectionStatus === "NOT_REQUIRED" ? "default" : "warning"}
        />
        <StatTile
          label="Stock movements"
          value={g.transactions.length}
          hint={g.status === "POSTED" ? "Ledger entries written" : "Written on posting"}
          tone={g.transactions.length ? "success" : "default"}
        />
      </div>

      {g.status === "DRAFT" && (
        <InlineAlert tone="warning">
          This GRN is a <span className="font-600">draft</span>. Nothing has entered inventory and the purchase order
          balance is unchanged until it is posted.
        </InlineAlert>
      )}
      {g.status === "CANCELLED" && (
        <InlineAlert tone="danger">
          This GRN was cancelled. Compensating inventory movements were written — the original entries remain in the
          ledger, because inventory history is never deleted.
        </InlineAlert>
      )}
      {g.status === "POSTED" && g.stacking.length === 0 && (
        <InlineAlert tone="info">
          Goods are in inventory but no stacking has been recorded. Record where the material was put away so it can be
          found and handled correctly.
        </InlineAlert>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <SectionCard title="Receipt record">
          <DefList
            columns={2}
            items={[
              { label: "Vendor", value: <RefLink href={`/vendors/${g.vendor.id}`}>{g.vendor.name}</RefLink> },
              { label: "Store", value: `${g.store.name} · ${humanize(g.store.kind)}` },
              {
                label: "Physical receipt",
                value: g.delivery ? <RefLink href={`/receiving/${g.delivery.id}`}>{g.delivery.number}</RefLink> : "—",
              },
              { label: "Delivery note", value: g.delivery?.deliveryNoteRef ?? "—" },
              {
                label: "Gate pass",
                value: g.gatePass ? <RefLink href={`/gate-passes/${g.gatePass.id}`}>{g.gatePass.number}</RefLink> : "—",
              },
              {
                label: "Inspection",
                value: g.inspection ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <RefLink href={`/inspections/${g.inspection.id}`}>{g.inspection.number}</RefLink>
                    <StatusBadge status={g.inspection.result} />
                  </span>
                ) : (
                  humanize(g.inspectionStatus)
                ),
              },
              { label: "Inspection signed by", value: g.inspection?.signedByName ?? "—" },
              { label: "Project", value: g.po.pr?.project?.name ?? "—" },
              { label: "Received by", value: `${g.receivedBy.name}${g.receivedBy.title ? ` — ${g.receivedBy.title}` : ""}` },
              { label: "Posted", value: g.postedAt ? fmtDateTime(g.postedAt) : "Not posted" },
              { label: "Remarks", value: g.remarks ?? "—", span: true },
            ]}
          />
        </SectionCard>

        <div className="space-y-4">
          {g.invoiceMatches.length > 0 && (
            <SectionCard title="Invoices matched to this GRN">
              <ul className="space-y-2">
                {g.invoiceMatches.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-2">
                    <RefLink href={`/invoices/${m.invoice.id}`}>{m.invoice.number}</RefLink>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={m.invoice.status} />
                      <Badge
                        tone={
                          m.invoice.matchStatus === "PASSED"
                            ? "success"
                            : m.invoice.matchStatus === "FAILED"
                              ? "danger"
                              : "warning"
                        }
                      >
                        {humanize(m.invoice.matchStatus)}
                      </Badge>
                      <span className="tnum text-xs">{money(m.invoice.total)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}

          {g.assets.length > 0 && (
            <SectionCard
              title="Assets tagged on receipt"
              description={`${g.assets.length} asset(s) created from this GRN`}
              bodyClassName="px-0 py-0"
            >
              <div className="table-wrap max-h-[18rem] overflow-y-auto">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Tag</th>
                      <th>Asset</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.assets.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <RefLink href={`/assets/${a.id}`}>{a.tag}</RefLink>
                        </td>
                        <td className="text-xs">{a.name}</td>
                        <td>
                          <StatusBadge status={a.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}

          <SectionCard title="Dispositions" description="What each line became on receipt">
            <ul className="space-y-1.5">
              {Object.entries(
                g.items.reduce<Record<string, number>>((acc, i) => {
                  acc[i.disposition] = (acc[i.disposition] ?? 0) + 1;
                  return acc;
                }, {}),
              ).map(([d, n]) => (
                <li key={d} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="flex items-center gap-2">
                    <Badge tone="neutral">{humanize(d)}</Badge>
                    {STORE_ENTRY_DISPOSITIONS.includes(d as never) && (
                      <span className="text-2xs text-[var(--c-text-tertiary)]">creates stock</span>
                    )}
                  </span>
                  <span className="tnum font-500">
                    {n} line{n > 1 ? "s" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      </div>

      <SectionCard title="GRN lines" bodyClassName="px-0 py-0">
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "2.5rem" }}>#</th>
                <th style={{ minWidth: "16rem" }}>Description</th>
                <th className="text-right">Ordered</th>
                <th className="text-right">Received</th>
                <th className="text-right">Accepted</th>
                <th className="text-right">Rejected</th>
                <th className="text-right">Unit price</th>
                <th className="text-right">Line value</th>
                <th>Batch / serial / expiry</th>
                <th>Disposition</th>
                <th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {g.items.map((i) => (
                <tr key={i.id}>
                  <td className="tnum align-top text-[var(--c-text-tertiary)]">{i.lineNo}</td>
                  <td className="align-top">
                    <div>{i.description}</div>
                    {i.item && <div className="mono mt-0.5 text-2xs text-[var(--c-text-tertiary)]">{i.item.sku}</div>}
                  </td>
                  <td className="num align-top">{qty(i.orderedQty, i.unit)}</td>
                  <td className="num align-top">{qty(i.receivedQty)}</td>
                  <td className="num align-top font-500">{qty(i.acceptedQty)}</td>
                  <td className="num align-top">
                    {i.rejectedQty > 0 ? <span className="text-[var(--c-danger)]">{qty(i.rejectedQty)}</span> : "—"}
                  </td>
                  <td className="num align-top">{money(i.unitPrice)}</td>
                  <td className="num align-top font-500">{money(i.lineValue)}</td>
                  <td className="align-top text-2xs">
                    {i.batchNumber && <div>Batch {i.batchNumber}</div>}
                    {i.serialNumbers && <div className="max-w-[15rem] break-words">{i.serialNumbers}</div>}
                    {i.expiryDate && <div>Expires {fmtDate(i.expiryDate)}</div>}
                    {i.warrantyMonths && <div>{i.warrantyMonths}m warranty</div>}
                    {!i.batchNumber && !i.serialNumbers && !i.expiryDate && !i.warrantyMonths && "—"}
                  </td>
                  <td className="align-top">
                    <Badge tone="neutral">{humanize(i.disposition)}</Badge>
                  </td>
                  <td className="align-top text-2xs text-[var(--c-text-secondary)]">{i.remarks ?? "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="text-right">Totals</td>
                <td className="num">{qty(accepted)}</td>
                <td className="num">{rejected > 0 ? qty(rejected) : "—"}</td>
                <td />
                <td className="num">{money(g.totalValue)}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      </SectionCard>

      {g.transactions.length > 0 && (
        <SectionCard
          title="Inventory ledger entries"
          description="The immutable stock movements this GRN produced. Inventory can only move through entries like these."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Transaction</th>
                  <th>Type</th>
                  <th>Item</th>
                  <th>Store</th>
                  <th className="text-right">Quantity</th>
                  <th className="text-right">Unit cost</th>
                  <th className="text-right">Value</th>
                  <th className="text-right">Balance after</th>
                  <th>Batch / serial</th>
                  <th>Posted</th>
                </tr>
              </thead>
              <tbody>
                {g.transactions.map((t) => (
                  <tr key={t.id}>
                    <td className="mono text-2xs">{t.number}</td>
                    <td>
                      <Badge tone={t.quantity >= 0 ? "success" : "danger"}>{humanize(t.type)}</Badge>
                    </td>
                    <td className="text-xs">
                      {t.item.name}
                      <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{t.item.sku}</span>
                    </td>
                    <td className="text-xs">{t.store.name}</td>
                    <td className="num font-500">
                      <span className={t.quantity < 0 ? "text-[var(--c-danger)]" : "text-[var(--c-success)]"}>
                        {t.quantity > 0 ? "+" : ""}
                        {qty(t.quantity, t.unit)}
                      </span>
                    </td>
                    <td className="num">{money(t.unitCost)}</td>
                    <td className="num">{money(t.value)}</td>
                    <td className="num">{qty(t.balanceAfter)}</td>
                    <td className="text-2xs">
                      {t.batchNumber ?? ""}
                      {t.serialNumber ? ` / ${t.serialNumber}` : ""}
                      {!t.batchNumber && !t.serialNumber && "—"}
                    </td>
                    <td className="text-2xs">{fmtDateTime(t.performedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {g.stacking.length > 0 && (
        <SectionCard title="Goods stacking" description="Where the material was put away and how it must be handled" bodyClassName="px-0 py-0">
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Material</th>
                  <th className="text-right">Quantity</th>
                  <th>Bin location</th>
                  <th>Method</th>
                  <th>Goods class</th>
                  <th style={{ minWidth: "18rem" }}>Handling requirements</th>
                  <th>Stacked by</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {g.stacking.map((s) => (
                  <tr key={s.id}>
                    <td className="text-xs">{s.description}</td>
                    <td className="num text-xs">{qty(s.quantity, s.unit)}</td>
                    <td className="text-xs">
                      {s.location ? (
                        <span>
                          {s.location.label}
                          <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                            {humanize(s.location.handling)}
                          </span>
                        </span>
                      ) : (
                        "Unassigned"
                      )}
                    </td>
                    <td className="text-xs">{humanize(s.stackingMethod)}</td>
                    <td>
                      <Badge
                        tone={
                          s.goodsClass === "HIGH_VALUE"
                            ? "accent"
                            : s.goodsClass === "HAZARDOUS"
                              ? "danger"
                              : s.goodsClass === "SENSITIVE"
                                ? "warning"
                                : "neutral"
                        }
                      >
                        {humanize(s.goodsClass)}
                      </Badge>
                    </td>
                    <td className="text-2xs leading-4 text-[var(--c-text-secondary)]">
                      {s.handlingRequirements ?? "—"}
                    </td>
                    <td className="text-xs">{s.stackedBy.name}</td>
                    <td className="text-2xs">{fmtDateTime(s.stackedAt)}</td>
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
          linkedType="GRN"
          linkedId={g.id}
          entityId={g.po.entityId}
          title="GRN documents"
          description="The signed GRN, mill or test certificates and any supporting receipt evidence."
          defaultCategory="GRN"
        />
        <SectionCard title="Activity">
          <Timeline events={events} emptyLabel="No activity recorded yet." />
        </SectionCard>
      </div>
    </div>
  );
}
