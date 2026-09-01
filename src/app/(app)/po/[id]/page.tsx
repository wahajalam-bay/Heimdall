import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext, first, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { serviceOutstanding } from "@/server/service-acceptance";
import { RaiseServiceAcceptanceForm } from "../../service-acceptance/RaiseForm";
import { userHasPermission } from "@/lib/rbac";
import { CONFIG_KEYS, getConfigBool } from "@/lib/config";
import { canUserActOnApproval, getApprovalTrail } from "@/lib/approvals";
import { orderSources } from "@/server/allocations";
import { poBalance, PO_ACKNOWLEDGEMENT_LABELS } from "@/server/po";
import { documentTimeline } from "@/server/timeline";
import { parseAuditRow } from "@/lib/audit";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs, TabNav } from "@/components/ui/nav";
import {
  Badge,
  Card,
  DefList,
  EmptyState,
  InlineAlert,
  MetaItem,
  Meter,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { ApprovalTrailView, LifecycleRail, Timeline, buildRail } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { ExceptionsPanel } from "@/components/domain/ExceptionsPanel";
import { PO_RAIL, PO_RAIL_LABELS, poRailStage, humanize } from "@/lib/domain";
import { fmtDate, fmtDateTime, money, percent, qty, round2 } from "@/lib/format";
import { AuditPanel } from "../../pr/[id]/panels2";
import { PoActions, type PoCapabilities } from "./PoActions";
import { VendorAcknowledgement } from "./VendorAcknowledgement";
import { searchLink } from "@/lib/links";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    select: { number: true, vendor: { select: { name: true } } },
  });
  return { title: po ? `${po.number} — ${po.vendor.name}` : "Purchase order" };
}

export default async function PoDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const tab = first((await searchParams).tab) ?? "overview";
  const { user, authorized } = await pageContext(P.PO_VIEW);
  if (!authorized) return <AccessDenied title="Purchase order" />;

  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: {
      entity: true,
      vendor: true,
      authorisedSignatory: { select: { name: true, title: true } },
      pr: {
        select: {
          id: true,
          number: true,
          title: true,
          procurementType: true,
          department: { select: { name: true } },
          project: { select: { name: true } },
          site: { select: { name: true } },
          requester: { select: { name: true } },
        },
      },
      rfq: { select: { id: true, number: true } },
      quote: { select: { id: true, number: true, total: true, negotiations: { orderBy: { round: "asc" } } } },
      deliveryStore: true,
      createdBy: { select: { name: true } },
      items: { orderBy: { lineNo: "asc" } },
      gatePasses: {
        orderBy: { arrivedAt: "desc" },
        include: { store: { select: { name: true } }, recordedBy: { select: { name: true } } },
      },
      deliveries: {
        orderBy: { deliveryDate: "desc" },
        include: {
          items: { orderBy: { lineNo: "asc" } },
          store: { select: { name: true } },
          receivedBy: { select: { name: true } },
          inspections: { select: { id: true, number: true, result: true, inspectionType: true } },
          grns: { select: { id: true, number: true, status: true } },
        },
      },
      grns: {
        orderBy: { receivedAt: "desc" },
        include: {
          items: { orderBy: { lineNo: "asc" } },
          store: { select: { name: true } },
          receivedBy: { select: { name: true } },
          inspection: { select: { number: true, result: true } },
        },
      },
      invoices: {
        orderBy: { receivedDate: "desc" },
        include: {
          items: { orderBy: { lineNo: "asc" } },
          handoffs: { include: { handedOffBy: { select: { name: true } } } },
        },
      },
      inspections: { select: { id: true, number: true, result: true, inspectionType: true } },
    },
  });
  if (!po) notFound();

  const [balance, trails, actability, events, auditRows, requireGrn, sources] = await Promise.all([
    poBalance(po.id),
    getApprovalTrail("PO", po.id),
    canUserActOnApproval(user, "PO", po.id),
    documentTimeline("PurchaseOrder", po.id),
    prisma.auditLog.findMany({
      where: { OR: [{ entityType: "PurchaseOrder", entityId: po.id }, { entityRef: po.number }] },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    getConfigBool(CONFIG_KEYS.REQUIRE_GRN_FOR_PAYMENT, po.entityId),
    // An order can carry lines from more than one requisition.
    orderSources(po.id),
  ]);

  const pending = balance.filter((b) => b.pendingQty > 0);
  const postedGrns = po.grns.filter((g) => g.status === "POSTED");
  const pendingInspections = po.deliveries.flatMap((d) =>
    d.inspections.filter((i) => ["PENDING", "IN_PROGRESS", "RE_INSPECTION_REQUIRED"].includes(i.result)),
  );
  const orderedQty = round2(po.items.reduce((a, i) => a + i.quantity, 0));
  const acceptedQty = round2(po.items.reduce((a, i) => a + i.acceptedQty, 0));
  const pendingValue = round2(balance.reduce((a, b) => a + b.pendingQty * b.unitPrice, 0));
  const invoicedValue = round2(po.invoices.reduce((a, i) => a + i.total, 0));
  const paidValue = round2(po.invoices.filter((i) => i.status === "PAID").reduce((a, i) => a + i.total, 0));
  const overdue = po.deliveryDate && po.deliveryDate < new Date() && pending.length > 0;

  const issueBlockers: string[] = [];
  if (po.status !== "APPROVED") issueBlockers.push(`The order is ${humanize(po.status).toLowerCase()} — it must be approved before issue.`);
  if (po.advanceRequired && po.advanceStatus === "PENDING" && !po.collateralRef) {
    issueBlockers.push("This order carries an advance but no collateral reference has been recorded.");
  }

  const cancelBlockers: string[] = [];
  if (postedGrns.length) {
    cancelBlockers.push(
      `${postedGrns.length} GRN(s) have been posted — goods are already in inventory. Close the order with a reason instead.`,
    );
  }

  // Not part of PoCapabilities: the acknowledgement panel is not one of the
  // lifecycle actions, and widening that type to carry it would blur what it is
  // for. The permission is still checked inside the mutation either way.
  const canRecordAck = userHasPermission(user, P.PO_ISSUE, P.PO_EDIT);

  const caps: PoCapabilities = {
    canSubmit: po.status === "DRAFT" && userHasPermission(user, P.PO_CREATE, P.PO_EDIT),
    canDecide: actability.can && userHasPermission(user, P.PO_APPROVE),
    decideReason: actability.reason ?? null,
    pendingStepName: actability.stepName,
    canIssue: po.status === "APPROVED" && userHasPermission(user, P.PO_ISSUE),
    issueBlockers,
    canClose:
      userHasPermission(user, P.PO_CLOSE) &&
      ["ISSUED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "ON_HOLD"].includes(po.status),
    hasPending: pending.length > 0,
    canCancel:
      userHasPermission(user, P.PO_CANCEL) &&
      !["CLOSED", "CANCELLED"].includes(po.status) &&
      cancelBlockers.length === 0,
    cancelBlockers: userHasPermission(user, P.PO_CANCEL) ? cancelBlockers : [],
    canHold: userHasPermission(user, P.PO_EDIT, P.PO_APPROVE),
    canRecordGatePass:
      userHasPermission(user, P.GATE_PASS_CREATE) && ["ISSUED", "PARTIALLY_RECEIVED"].includes(po.status),
    canReceive: userHasPermission(user, P.RECEIVE_GOODS) && ["ISSUED", "PARTIALLY_RECEIVED"].includes(po.status),
    canInvoice:
      userHasPermission(user, P.INVOICE_CREATE) &&
      !["DRAFT", "PENDING_APPROVAL", "CANCELLED"].includes(po.status),
    canManageAdvance: po.advanceRequired && userHasPermission(user, P.PAYMENT_RECORD, P.INVOICE_APPROVE),
    advanceStatus: po.advanceStatus,
    status: po.status,
  };

  // The order's lifecycle starts where the requisition's ends: at the approved
  // order. Awaiting delivery, inspection pending and GRN pending are read off the
  // deliveries, inspections and receipts rather than being statuses of their own.
  const grnsPending = po.deliveries.filter(
    (d) => d.status !== "REJECTED" && !po.grns.some((g) => g.deliveryId === d.id && g.status === "POSTED"),
  ).length;
  const fullyReceived =
    po.items.length > 0 && po.items.every((i) => i.acceptedQty + 1e-9 >= i.quantity);
  const stage = poRailStage({
    status: po.status,
    issuedAt: po.issuedAt,
    closedAt: po.closedAt,
    deliveries: po.deliveries.length,
    firstDeliveryAt: po.deliveries[0]?.deliveryDate ?? null,
    inspectionsPending: pending.length,
    grnsPending,
    postedGrns: postedGrns.length,
    firstGrnAt: postedGrns[0]?.postedAt ?? null,
    fullyReceived,
  });

  const reached: Record<string, { at?: Date | null; owner?: string | null }> = {
    ISSUED: { at: po.issuedAt, owner: po.createdBy.name },
    AWAITING_DELIVERY: { at: po.issuedAt },
    CLOSED: { at: po.closedAt },
  };
  if (po.deliveries[0]) {
    reached.PARTIALLY_RECEIVED = { at: po.deliveries[0].deliveryDate };
  }
  if (pending.length) reached.INSPECTION_PENDING = { at: po.deliveries[0]?.deliveryDate ?? null };
  if (grnsPending) reached.GRN_PENDING = { at: po.deliveries[0]?.deliveryDate ?? null };
  if (postedGrns[0]) {
    reached[fullyReceived ? "FULLY_RECEIVED" : "PARTIALLY_RECEIVED"] = {
      at: postedGrns[0].postedAt,
      owner: postedGrns[0].receivedBy.name,
    };
  }

  const rail = buildRail(PO_RAIL, stage, reached, {
    labels: PO_RAIL_LABELS,
    terminalBad: po.status === "CANCELLED",
    blockedNote:
      po.status === "ON_HOLD"
        ? "On hold"
        : overdue
          ? `Overdue — promised ${po.deliveryDate ? fmtDate(po.deliveryDate) : "earlier"}`
          : null,
  });

  const negotiated = po.quote?.negotiations.at(-1);

  const isService = po.procurementKind === "SERVICES";
  const serviceAcceptances = isService
    ? await prisma.serviceAcceptance.findMany({
        where: { poId: po.id },
        orderBy: { createdAt: "desc" },
        include: { pocUser: { select: { name: true } }, confirmedBy: { select: { name: true } } },
      })
    : [];
  const serviceLines = isService && caps.canRecordGatePass ? await serviceOutstanding(po.id) : [];

  const tabs = [
    { key: "overview", label: "Overview", count: null },
    { key: "items", label: "Lines", count: po.items.length },
    { key: "approvals", label: "Approvals", count: trails.reduce((a, t) => a + t.steps.length, 0) },
    {
      key: "receiving",
      label: isService ? "Service acceptance" : "Receiving",
      count: isService ? serviceAcceptances.length : po.deliveries.length + po.gatePasses.length,
    },
    // Goods are inspected and received. A service has nothing to inspect and
    // nothing to take into stock, so those tabs would be permanently empty.
    ...(isService
      ? []
      : [
          {
            key: "inspections",
            label: "Inspections",
            count: po.deliveries.reduce((a, d) => a + d.inspections.length, 0),
          },
          { key: "grn", label: "GRNs", count: po.grns.length },
        ]),
    { key: "invoices", label: "Invoices", count: po.invoices.length },
    { key: "documents", label: "Documents", count: null },
    { key: "exceptions", label: "Exceptions", count: null },
    { key: "timeline", label: "Timeline", count: events.length },
    ...(userHasPermission(user, P.AUDIT_VIEW) ? [{ key: "audit", label: "Audit", count: auditRows.length }] : []),
  ];

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Procurement", href: "/pr" },
          { label: "Purchase orders", href: "/po" },
          { label: po.number },
        ]}
      />

      <PageHeader
        eyebrow={`${po.entity.code} · ${po.pr?.department.name ?? "—"}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{po.number}</span>
            <span>{po.vendor.name}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={po.status} />
            </MetaItem>
            <MetaItem label="Value">{money(po.total)}</MetaItem>
            {po.pr && (
              <MetaItem label="Requisition">
                <RefLink href={`/pr/${po.pr.id}`}>{po.pr.number}</RefLink>
              </MetaItem>
            )}
            <MetaItem label="Delivery to">{po.deliveryStore?.name ?? po.deliveryAddress ?? "—"}</MetaItem>
            <MetaItem label="Promised">
              <span className={overdue ? "text-[var(--c-danger)]" : undefined}>
                {po.deliveryDate ? fmtDate(po.deliveryDate) : "—"}
              </span>
            </MetaItem>
            <MetaItem label="Raised by">{po.createdBy.name}</MetaItem>
          </>
        }
      />

      <Card>
        <PoActions poId={po.id} poNumber={po.number} caps={caps} />
      </Card>

      <LifecycleRail steps={rail} title="Order lifecycle" />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        <StatTile label="Order value" value={money(po.total)} hint={po.paymentTerms ?? "terms not stated"} />
        <StatTile
          label="Received"
          value={orderedQty > 0 ? percent((acceptedQty / orderedQty) * 100, 0) : "—"}
          hint={`${qty(acceptedQty)} of ${qty(orderedQty)} accepted`}
          tone={acceptedQty >= orderedQty && orderedQty > 0 ? "success" : acceptedQty > 0 ? "warning" : "default"}
          href={po.grns.length ? searchLink("/grn", po.number) : undefined}
        />
        <StatTile
          label="Pending value"
          value={pendingValue > 0 ? money(pendingValue) : "—"}
          hint={pending.length ? `${pending.length} line(s) outstanding` : "Fully received"}
          tone={pendingValue > 0 ? "warning" : "success"}
        />
        <StatTile
          label="Invoiced"
          value={invoicedValue > 0 ? money(invoicedValue) : "—"}
          hint={`${po.invoices.length} invoice(s)`}
          href={po.invoices.length ? searchLink("/invoices", po.number) : undefined}
        />
        <StatTile
          label="Paid"
          value={paidValue > 0 ? money(paidValue) : "—"}
          hint={requireGrn ? "Payment requires a posted GRN" : "GRN not mandatory for payment"}
          tone={paidValue > 0 ? "success" : "default"}
          href={searchLink("/finance/vouchers", po.number)}
        />
      </div>

      {overdue && (
        <InlineAlert tone="warning">
          Promised delivery was {fmtDate(po.deliveryDate)} and {pending.length} line(s) remain outstanding worth{" "}
          {money(pendingValue)}. This order appears in the Open PO control tower and the bottleneck board.
        </InlineAlert>
      )}
      {pendingInspections.length > 0 && (
        <InlineAlert tone="warning">
          {pendingInspections.length} technical inspection(s) are outstanding —{" "}
          {pendingInspections.map((i) => i.number).join(", ")}. A GRN cannot be posted until they are signed off.
        </InlineAlert>
      )}
      {po.closureReason && (
        <InlineAlert tone="info">
          <span className="font-600">Closure reason: </span>
          {po.closureReason}
        </InlineAlert>
      )}

      <div>
        <TabNav tabs={tabs} active={tab} baseHref={`/po/${po.id}`} />
        <div className="pt-4">
          {tab === "overview" && (
            <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
              {sources.length > 1 && (
                <div className="lg:col-span-2">
                  <SectionCard
                    title="Requisitions on this order"
                    description="This order consolidates demand from more than one requisition."
                    bodyClassName="px-0 pb-0"
                  >
                    <div className="table-wrap">
                      <table className="dt min-w-[36rem]">
                        <thead>
                          <tr>
                            <th>Requisition</th>
                            <th>Department</th>
                            <th>Title</th>
                            <th className="text-right">Lines</th>
                            <th className="text-right">Quantity on this order</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sources.map((src) => (
                            <tr key={src.prId} data-clickable="true">
                              <td>
                                <RefLink href={`/pr/${src.prId}`}>{src.number}</RefLink>
                              </td>
                              <td className="text-xs">{src.department}</td>
                              <td className="wrap text-xs">{src.title}</td>
                              <td className="num">{src.lines.length}</td>
                              <td className="num">
                                {src.lines.map((l) => `${l.quantity} ${l.unit}`).join(", ")}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </SectionCard>
                </div>
              )}
              <SectionCard title="Order detail">
                <DefList
                  columns={2}
                  items={[
                    { label: "Vendor", value: <RefLink href={`/vendors/${po.vendor.id}`}>{po.vendor.name}</RefLink> },
                    { label: "Vendor status", value: <StatusBadge status={po.vendor.status} /> },
                    { label: "Vendor address", value: po.vendorAddress ?? "—" },
                    { label: "Vendor contact", value: po.vendorContact ?? "—" },
                    { label: "Entity", value: `${po.entity.code} — ${po.entity.name}` },
                    { label: "Project", value: po.pr?.project?.name ?? "—" },
                    { label: "Site", value: po.pr?.site?.name ?? "—" },
                    { label: "Delivery location", value: po.deliveryStore?.name ?? po.deliveryAddress ?? "—" },
                    { label: "Payment terms", value: po.paymentTerms ?? "—" },
                    { label: "Credit days", value: po.creditDays !== null ? String(po.creditDays) : "—" },
                    { label: "Warranty", value: po.warrantyTerms ?? "—" },
                    { label: "Incoterms", value: po.incoterms ?? "—" },
                    {
                      label: "Sourced from",
                      value: (
                        <span className="flex flex-wrap items-center gap-2">
                          {po.rfq && <RefLink href={`/rfq/${po.rfq.id}`}>{po.rfq.number}</RefLink>}
                          {po.quote && <Mono>{po.quote.number}</Mono>}
                          {negotiated && (
                            <Badge tone="success">
                              negotiated from {money(po.quote?.total ?? 0)}
                            </Badge>
                          )}
                        </span>
                      ),
                      span: true,
                    },
                  ]}
                />
                {po.termsConditions && (
                  <div className="mt-4 border-t border-separator pt-3">
                    <div className="label mb-1.5">Terms & conditions</div>
                    <p className="whitespace-pre-line text-xs leading-5 text-muted">
                      {po.termsConditions}
                    </p>
                  </div>
                )}
              </SectionCard>

              <div className="space-y-4">
                <SectionCard title="Financial position">
                  <div className="space-y-1.5">
                    {[
                      ["Subtotal", money(po.subtotal)],
                      ["Tax", money(po.taxAmount)],
                      ["Delivery charges", money(po.deliveryCharges)],
                      ["Other charges", money(po.otherCharges)],
                      ["Discount", `- ${money(po.discount)}`],
                    ].map(([l, v]) => (
                      <div key={l} className="flex items-baseline justify-between gap-3 text-xs">
                        <span className="text-muted">{l}</span>
                        <span className="tnum">{v}</span>
                      </div>
                    ))}
                    <div className="flex items-baseline justify-between gap-3 border-t border-separator pt-1.5 text-[0.8125rem] font-600">
                      <span>Order total</span>
                      <span className="tnum">{money(po.total)}</span>
                    </div>
                  </div>
                </SectionCard>

                {po.advanceRequired && (
                  <SectionCard title="Advance payment">
                    <DefList
                      columns={1}
                      items={[
                        { label: "Advance amount", value: `${money(po.advanceAmount ?? 0)} (${po.advancePercent}%)` },
                        { label: "Status", value: <StatusBadge status={po.advanceStatus ?? "PENDING"} /> },
                        { label: "Collateral", value: po.collateralType ? humanize(po.collateralType) : "—" },
                        { label: "Reference", value: po.collateralRef ?? "—" },
                        { label: "Notes", value: po.collateralNotes ?? "—" },
                      ]}
                    />
                  </SectionCard>
                )}

                {["ISSUED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CLOSED", "ON_HOLD"].includes(
                  po.status,
                ) && (
                  <SectionCard
                    title="Issued to the vendor"
                    description="ZAM/PUR/SOP-01 §4.6: procurement issues the order to the vendor under an authorised signature."
                  >
                    <div className="space-y-3">
                      <DefList
                        columns={1}
                        items={[
                          {
                            label: "Authorised signatory",
                            value: po.authorisedSignatory
                              ? `${po.authorisedSignatory.name}${po.authorisedSignatory.title ? ` — ${po.authorisedSignatory.title}` : ""}`
                              : "Not recorded — issued before the signature was captured",
                          },
                          { label: "Signed", value: po.signedAt ? fmtDateTime(po.signedAt) : "—" },
                        ]}
                      />
                      <VendorAcknowledgement
                        poId={po.id}
                        vendorName={po.vendor.name}
                        canAct={canRecordAck}
                        distribution={{
                          channel: po.distributionChannel,
                          at: po.distributedAt ? po.distributedAt.toISOString() : null,
                          reference: po.distributionRef,
                        }}
                        acknowledgement={{
                          status: po.acknowledgementStatus,
                          label:
                            PO_ACKNOWLEDGEMENT_LABELS[
                              po.acknowledgementStatus as keyof typeof PO_ACKNOWLEDGEMENT_LABELS
                            ] ?? po.acknowledgementStatus,
                          at: po.acknowledgedAt ? po.acknowledgedAt.toISOString() : null,
                          byName: po.acknowledgedByName,
                          notes: po.acknowledgementNotes,
                          dueAt: po.acknowledgementDueAt ? po.acknowledgementDueAt.toISOString() : null,
                        }}
                      />
                    </div>
                  </SectionCard>
                )}

                <SectionCard title="Key dates">
                  <DefList
                    columns={1}
                    items={[
                      { label: "Created", value: fmtDateTime(po.createdAt) },
                      { label: "Approved", value: po.approvedAt ? fmtDateTime(po.approvedAt) : "—" },
                      { label: "Issued", value: po.issuedAt ? fmtDateTime(po.issuedAt) : "—" },
                      { label: "Promised delivery", value: po.deliveryDate ? fmtDate(po.deliveryDate) : "—" },
                      { label: "Closed", value: po.closedAt ? fmtDateTime(po.closedAt) : "—" },
                    ]}
                  />
                </SectionCard>
              </div>
            </div>
          )}

          {tab === "items" && (
            <SectionCard
              title="Order lines"
              description="Ordered against received, accepted, rejected, pending and invoiced quantities"
              bodyClassName="px-0 py-0"
            >
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th style={{ width: "2.5rem" }}>#</th>
                      <th style={{ minWidth: "18rem" }}>Description</th>
                      <th className="text-right">Ordered</th>
                      <th className="text-right">Unit price</th>
                      <th className="text-right">Tax</th>
                      <th className="text-right">Line total</th>
                      <th className="text-right">Received</th>
                      <th className="text-right">Accepted</th>
                      <th className="text-right">Rejected</th>
                      <th className="text-right">Pending</th>
                      <th className="text-right">Invoiced</th>
                      <th style={{ width: "8rem" }}>Progress</th>
                      <th style={{ width: "9rem" }}>Disposition</th>
                    </tr>
                  </thead>
                  <tbody>
                    {balance.map((i) => (
                      <tr key={i.id}>
                        <td className="tnum text-[var(--c-text-tertiary)]">{i.lineNo}</td>
                        <td>
                          <div>{i.description}</div>
                          {(i.brand || i.model) && (
                            <div className="mt-0.5 text-2xs text-muted">
                              {[i.brand, i.model].filter(Boolean).join(" · ")}
                            </div>
                          )}
                          {i.specification && (
                            <div className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">{i.specification}</div>
                          )}
                          {i.requiresInspection && <Badge tone="warning">Inspection required</Badge>}
                        </td>
                        <td className="num">{qty(i.quantity, i.unit)}</td>
                        <td className="num">{money(i.unitPrice)}</td>
                        <td className="num">{money(i.taxAmount)}</td>
                        <td className="num font-500">{money(i.lineTotal)}</td>
                        <td className="num">{qty(i.receivedQty)}</td>
                        <td className="num font-500">{qty(i.acceptedQty)}</td>
                        <td className="num">
                          <span className={i.rejectedQty > 0 ? "text-[var(--c-danger)]" : undefined}>
                            {qty(i.rejectedQty)}
                          </span>
                        </td>
                        <td className="num">
                          <span className={i.pendingQty > 0 ? "font-500 text-[var(--c-warning)]" : undefined}>
                            {qty(i.pendingQty)}
                          </span>
                        </td>
                        <td className="num">{qty(i.invoicedQty)}</td>
                        <td>
                          <Meter
                            value={i.acceptedQty}
                            max={i.quantity}
                            tone={i.fullyReceived ? "success" : i.acceptedQty > 0 ? "warning" : "danger"}
                          />
                        </td>
                        <td>
                          <Badge tone="neutral">{humanize(i.disposition)}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={5} className="text-right">Order total</td>
                      <td className="num">{money(po.total)}</td>
                      <td colSpan={4} />
                      <td className="num">{money(pendingValue)} pending</td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </SectionCard>
          )}

          {tab === "approvals" && (
            <SectionCard title="Approval chain" description="Configured by value band for this entity">
              <ApprovalTrailView trails={trails} />
            </SectionCard>
          )}

          {tab === "receiving" && isService && (
            <div className="space-y-4">
              {serviceAcceptances.length > 0 && (
                <SectionCard title="Acceptance records" bodyClassName="px-0 py-0">
                  <div className="table-wrap">
                    <table className="dt">
                      <thead>
                        <tr>
                          <th style={{ width: "9rem" }}>Number</th>
                          <th style={{ width: "11rem" }}>Status</th>
                          <th style={{ width: "12rem" }}>Point of contact</th>
                          <th style={{ width: "12rem" }}>Confirmed by</th>
                          <th style={{ width: "9rem" }}>Accepted</th>
                        </tr>
                      </thead>
                      <tbody>
                        {serviceAcceptances.map((sa) => (
                          <tr key={sa.id}>
                            <td>
                              <RefLink href={`/service-acceptance/${sa.id}`}>{sa.number}</RefLink>
                            </td>
                            <td>
                              <Badge
                                tone={
                                  sa.status === "ACCEPTED"
                                    ? "success"
                                    : sa.status === "PARTIALLY_ACCEPTED"
                                      ? "warning"
                                      : sa.status === "REJECTED"
                                        ? "danger"
                                        : "neutral"
                                }
                              >
                                {humanize(sa.status)}
                              </Badge>
                            </td>
                            <td>{sa.pocUser?.name ?? "—"}</td>
                            <td>{sa.confirmedBy?.name ?? "Awaiting confirmation"}</td>
                            <td className="tnum">{money(sa.acceptedValue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </SectionCard>
              )}

              {serviceLines.length > 0 && (
                <RaiseServiceAcceptanceForm
                  poId={po.id}
                  poNumber={po.number}
                  lines={serviceLines.map((l) => ({
                    id: l.id,
                    lineNo: l.lineNo,
                    description: l.description,
                    unit: l.unit,
                    quantity: l.quantity,
                    acceptedToDate: l.acceptedToDate,
                    outstanding: l.outstanding,
                  }))}
                  pocName={po.pr?.requester?.name ?? null}
                />
              )}

              {serviceAcceptances.length === 0 && serviceLines.length === 0 && (
                <Card>
                  <EmptyState
                    title="No service acceptance yet"
                    description="A service is not received into a store. Once the work is done, procurement records what was performed and the requesting department's point of contact confirms it — that confirmation is what makes the invoice payable."
                  />
                </Card>
              )}
            </div>
          )}

          {tab === "receiving" && !isService && (
            <div className="space-y-4">
              {po.gatePasses.length === 0 && po.deliveries.length === 0 ? (
                <Card>
                  <EmptyState
                    title="Nothing received yet"
                    description="When the vendor arrives, security records an inward gate pass and the store performs physical verification."
                    action={
                      caps.canRecordGatePass && (
                        <Link href={`/gate-passes/new?poId=${po.id}`} className="btn btn-primary btn-sm">
                          Record gate pass
                        </Link>
                      )
                    }
                  />
                </Card>
              ) : (
                <>
                  {po.gatePasses.length > 0 && (
                    <SectionCard title="Gate passes" bodyClassName="px-0 py-0">
                      <div className="table-wrap">
                        <table className="dt">
                          <thead>
                            <tr>
                              <th>Gate pass</th>
                              <th>Serial</th>
                              <th>Store</th>
                              <th>Vehicle</th>
                              <th>Driver</th>
                              <th className="text-right">Packages</th>
                              <th>Arrived</th>
                              <th>Status</th>
                              <th>Recorded by</th>
                            </tr>
                          </thead>
                          <tbody>
                            {po.gatePasses.map((g) => (
                              <tr key={g.id}>
                                <td>
                                  <RefLink href={`/gate-passes/${g.id}`}>{g.number}</RefLink>
                                </td>
                                <td>
                                  <Mono>{g.serial}</Mono>
                                </td>
                                <td className="text-xs">{g.store.name}</td>
                                <td className="text-xs">{g.vehicleNumber ?? "—"}</td>
                                <td className="text-xs">{g.driverName ?? "—"}</td>
                                <td className="num">{g.declaredPackages ?? "—"}</td>
                                <td className="text-xs">{fmtDateTime(g.arrivedAt)}</td>
                                <td>
                                  <StatusBadge status={g.status} />
                                </td>
                                <td className="text-xs">{g.recordedBy.name}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </SectionCard>
                  )}

                  {po.deliveries.map((d) => (
                    <SectionCard
                      key={d.id}
                      title={
                        <span className="flex flex-wrap items-center gap-2">
                          <RefLink href={`/receiving/${d.id}`}>{d.number}</RefLink>
                          <StatusBadge status={d.status} />
                        </span>
                      }
                      description={`${d.store.name} · received by ${d.receivedBy.name} on ${fmtDateTime(d.deliveryDate)}`}
                      actions={
                        d.grns.length === 0 && userHasPermission(user, P.GRN_CREATE) ? (
                          <Link href={`/grn/new?deliveryId=${d.id}`} className="btn btn-primary btn-xs">
                            Raise GRN
                          </Link>
                        ) : (
                          d.grns.map((g) => (
                            <Link key={g.id} href={`/grn/${g.id}`} className="badge badge-success">
                              {g.number}
                            </Link>
                          ))
                        )
                      }
                      bodyClassName="px-0 py-0"
                    >
                      <div className="table-wrap">
                        <table className="dt">
                          <thead>
                            <tr>
                              <th style={{ width: "2.5rem" }}>#</th>
                              <th style={{ minWidth: "15rem" }}>Description</th>
                              <th className="text-right">Expected</th>
                              <th className="text-right">Delivered</th>
                              <th className="text-right">Accepted</th>
                              <th className="text-right">Rejected</th>
                              <th>Batch / serial</th>
                              <th>Discrepancy</th>
                            </tr>
                          </thead>
                          <tbody>
                            {d.items.map((i) => (
                              <tr key={i.id}>
                                <td className="tnum text-[var(--c-text-tertiary)]">{i.lineNo}</td>
                                <td>{i.description}</td>
                                <td className="num">{qty(i.expectedQty, i.unit)}</td>
                                <td className="num font-500">{qty(i.actualQty)}</td>
                                <td className="num">{qty(i.acceptedQty)}</td>
                                <td className="num">
                                  <span className={i.rejectedQty > 0 ? "text-[var(--c-danger)]" : undefined}>
                                    {qty(i.rejectedQty)}
                                  </span>
                                </td>
                                <td className="text-2xs">
                                  {i.batchNumber ?? ""}
                                  {i.serialNumbers && (
                                    <span className="block max-w-[13rem] truncate" title={i.serialNumbers}>
                                      {i.serialNumbers}
                                    </span>
                                  )}
                                  {!i.batchNumber && !i.serialNumbers && "—"}
                                </td>
                                <td>
                                  {i.discrepancyType === "OK" ? (
                                    <Badge tone="success">OK</Badge>
                                  ) : (
                                    <span>
                                      <StatusBadge status={i.discrepancyType} />
                                      {i.discrepancyNotes && (
                                        <span className="mt-0.5 block max-w-[15rem] text-2xs leading-4 text-[var(--c-warning)]">
                                          {i.discrepancyNotes}
                                        </span>
                                      )}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {d.inspections.length > 0 && (
                        <div className="border-t border-separator px-4 py-2.5">
                          <span className="label mr-2">Inspections</span>
                          {d.inspections.map((i) => (
                            <Link key={i.id} href={`/inspections/${i.id}`} className="mr-2">
                              <Badge tone={i.result === "APPROVED" ? "success" : i.result === "REJECTED" ? "danger" : "warning"}>
                                {i.number} · {humanize(i.result)}
                              </Badge>
                            </Link>
                          ))}
                        </div>
                      )}
                    </SectionCard>
                  ))}
                </>
              )}
            </div>
          )}

          {tab === "inspections" && (
            <SectionCard title="Technical inspections" bodyClassName="px-0 py-0">
              {po.deliveries.flatMap((d) => d.inspections).length === 0 ? (
                <EmptyState
                  compact
                  title="No inspection required"
                  description="Inspection is raised automatically for categories configured to require it."
                />
              ) : (
                <div className="table-wrap">
                  <table className="dt">
                    <thead>
                      <tr>
                        <th>Inspection</th>
                        <th>Type</th>
                        <th>Result</th>
                        <th>Delivery</th>
                      </tr>
                    </thead>
                    <tbody>
                      {po.deliveries.flatMap((d) =>
                        d.inspections.map((i) => (
                          <tr key={i.id}>
                            <td>
                              <RefLink href={`/inspections/${i.id}`}>{i.number}</RefLink>
                            </td>
                            <td className="text-xs">{humanize(i.inspectionType)}</td>
                            <td>
                              <StatusBadge status={i.result} />
                            </td>
                            <td>
                              <RefLink href={`/receiving/${d.id}`}>{d.number}</RefLink>
                            </td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          )}

          {tab === "grn" && (
            <div className="space-y-4">
              {po.grns.length === 0 ? (
                <Card>
                  <EmptyState
                    title="No GRN posted"
                    description="Until a GRN is posted, nothing on this order counts as received into inventory — and no invoice can be paid."
                  />
                </Card>
              ) : (
                po.grns.map((g) => (
                  <SectionCard
                    key={g.id}
                    title={
                      <span className="flex flex-wrap items-center gap-2">
                        <RefLink href={`/grn/${g.id}`}>{g.number}</RefLink>
                        <StatusBadge status={g.status} />
                        <Badge
                          tone={
                            g.inspectionStatus === "APPROVED"
                              ? "success"
                              : g.inspectionStatus === "NOT_REQUIRED"
                                ? "neutral"
                                : "warning"
                          }
                        >
                          Inspection: {humanize(g.inspectionStatus)}
                        </Badge>
                      </span>
                    }
                    description={`${g.store.name} · ${g.receivedBy.name} · ${fmtDateTime(g.receivedAt)}`}
                    actions={<span className="tnum text-[0.9375rem] font-600">{money(g.totalValue)}</span>}
                    bodyClassName="px-0 py-0"
                  >
                    <div className="table-wrap">
                      <table className="dt">
                        <thead>
                          <tr>
                            <th style={{ width: "2.5rem" }}>#</th>
                            <th>Description</th>
                            <th className="text-right">Accepted</th>
                            <th className="text-right">Rejected</th>
                            <th className="text-right">Unit price</th>
                            <th className="text-right">Line value</th>
                            <th>Disposition</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.items.map((i) => (
                            <tr key={i.id}>
                              <td className="tnum text-[var(--c-text-tertiary)]">{i.lineNo}</td>
                              <td>{i.description}</td>
                              <td className="num font-500">{qty(i.acceptedQty, i.unit)}</td>
                              <td className="num">{qty(i.rejectedQty)}</td>
                              <td className="num">{money(i.unitPrice)}</td>
                              <td className="num font-500">{money(i.lineValue)}</td>
                              <td>
                                <Badge tone="neutral">{humanize(i.disposition)}</Badge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </SectionCard>
                ))
              )}
            </div>
          )}

          {tab === "invoices" && (
            <div className="space-y-4">
              {po.invoices.length === 0 ? (
                <Card>
                  <EmptyState
                    title="No invoice registered"
                    description="Register the vendor invoice to run the three-way match against this order and its GRNs."
                    action={
                      caps.canInvoice && (
                        <Link href={`/invoices/new?poId=${po.id}`} className="btn btn-primary btn-sm">
                          Register invoice
                        </Link>
                      )
                    }
                  />
                </Card>
              ) : (
                po.invoices.map((inv) => (
                  <SectionCard
                    key={inv.id}
                    title={
                      <span className="flex flex-wrap items-center gap-2">
                        <RefLink href={`/invoices/${inv.id}`}>{inv.number}</RefLink>
                        <StatusBadge status={inv.status} />
                        <Badge
                          tone={
                            inv.matchStatus === "PASSED"
                              ? "success"
                              : inv.matchStatus === "FAILED"
                                ? "danger"
                                : inv.matchStatus === "OVERRIDDEN"
                                  ? "warning"
                                  : "neutral"
                          }
                        >
                          Match: {humanize(inv.matchStatus)}
                        </Badge>
                      </span>
                    }
                    description={`Vendor ref ${inv.vendorInvoiceNumber} dated ${fmtDate(inv.invoiceDate)}`}
                    actions={
                      <span className="text-right">
                        <span className="tnum block text-[0.9375rem] font-600">{money(inv.total)}</span>
                        <span className="block text-2xs text-[var(--c-text-tertiary)]">
                          net {money(inv.netPayable)}
                        </span>
                      </span>
                    }
                    bodyClassName="px-0 py-0"
                  >
                    <div className="table-wrap">
                      <table className="dt">
                        <thead>
                          <tr>
                            <th style={{ width: "2.5rem" }}>#</th>
                            <th>Description</th>
                            <th className="text-right">Invoiced</th>
                            <th className="text-right">GRN accepted</th>
                            <th className="text-right">Unit price</th>
                            <th className="text-right">PO price</th>
                            <th>Match</th>
                          </tr>
                        </thead>
                        <tbody>
                          {inv.items.map((i) => (
                            <tr key={i.id}>
                              <td className="tnum text-[var(--c-text-tertiary)]">{i.lineNo}</td>
                              <td>
                                {i.description}
                                {i.matchNotes && (
                                  <span className="mt-0.5 block text-2xs text-[var(--c-danger)]">{i.matchNotes}</span>
                                )}
                              </td>
                              <td className="num font-500">{qty(i.quantity, i.unit)}</td>
                              <td className="num">{i.grnAcceptedQty !== null ? qty(i.grnAcceptedQty) : "—"}</td>
                              <td className="num">{money(i.unitPrice)}</td>
                              <td className="num">{i.poUnitPrice !== null ? money(i.poUnitPrice) : "—"}</td>
                              <td>
                                <Badge tone={i.matchFlag === "OK" ? "success" : "danger"}>{humanize(i.matchFlag)}</Badge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {inv.handoffs.length > 0 && (
                      <div className="border-t border-separator px-4 py-2.5 text-xs">
                        <span className="label mr-2">Finance</span>
                        {inv.handoffs.map((h) => (
                          <span key={h.id} className="mr-3">
                            <RefLink href={`/finance/handoffs/${h.id}`}>{h.number}</RefLink>{" "}
                            <StatusBadge status={h.status} /> {money(h.amount)}
                          </span>
                        ))}
                      </div>
                    )}
                  </SectionCard>
                ))
              )}
            </div>
          )}

          {tab === "documents" && (
            <DocumentsPanel
              user={user}
              linkedType="PO"
              linkedId={po.id}
              entityId={po.entityId}
              title="Purchase order documents"
              defaultCategory="PO"
            />
          )}

          {tab === "exceptions" && (
            <ExceptionsPanel
              where={{ poId: po.id }}
              title="Exceptions on this order"
              emptyLabel="No exceptions have been raised against this purchase order."
            />
          )}

          {tab === "timeline" && (
            <SectionCard title="Order history" description="Generated from the audit trail">
              <Timeline events={events} emptyLabel="No activity recorded yet." />
            </SectionCard>
          )}

          {tab === "audit" && userHasPermission(user, P.AUDIT_VIEW) && (
            <AuditPanel rows={auditRows.map(parseAuditRow)} />
          )}
        </div>
      </div>
    </div>
  );
}
