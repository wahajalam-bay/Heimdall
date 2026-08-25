import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext, first, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs, TabNav } from "@/components/ui/nav";
import { Badge, Card, MetaItem, PageHeader, StatusBadge } from "@/components/ui/primitives";
import { LifecycleRail, buildRail } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { ExceptionsPanel } from "@/components/domain/ExceptionsPanel";
import { PR_LIFECYCLE, PR_RAIL_SEGMENTS, PRIORITY_TONE, humanize } from "@/lib/domain";
import { fmtDate, fmtDateTime, money } from "@/lib/format";
import { canUserActOnApproval, getApprovalTrail } from "@/lib/approvals";
import { NotFoundError } from "@/lib/errors";
import { assertCanViewPr } from "@/server/pr";
import { poReadiness } from "@/server/po";
import { requisitionCoverage } from "@/server/allocations";
import { cpcRequirement } from "@/server/cpc";
import { caseTimeline, loadProcurementCase } from "@/server/timeline";
import { parseAuditRow } from "@/lib/audit";
import { CaseActions, type CaseCapabilities } from "./CaseActions";
import {
  ApprovalsPanel,
  ComparisonPanel,
  ItemsPanel,
  NegotiationPanel,
  OverviewPanel,
  QuotesPanel,
  RfqPanel,
  TimelinePanel,
} from "./panels";
import {
  AuditPanel,
  CpcPanel,
  DeliveryPanel,
  FinancePanel,
  GrnPanel,
  InspectionPanel,
  InvoicePanel,
  PoPanel,
} from "./panels2";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pr = await prisma.purchaseRequisition.findUnique({ where: { id }, select: { number: true, title: true } });
  return { title: pr ? `${pr.number} — ${pr.title}` : "Procurement case" };
}

/**
 * The unified procurement case view — the complete story of one requisition
 * from raising through to closure, in one place.
 */
export default async function ProcurementCasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const tab = first(sp.tab) ?? "overview";

  const { user, authorized } = await pageContext(P.PR_VIEW, P.PR_VIEW_ALL);
  if (!authorized) return <AccessDenied title="Procurement case" />;

  try {
    await assertCanViewPr(user, id);
  } catch (e) {
    // A requisition that does not exist is not a permission problem, and saying
    // it belongs to another department would be telling the user something untrue.
    if (e instanceof NotFoundError) notFound();
    return (
      <AccessDenied
        title="Procurement case"
        message="This requisition belongs to another department. Ask your procurement administrator if you need visibility across departments."
      />
    );
  }

  const pr = await loadProcurementCase(id);
  if (!pr) notFound();

  const docType = pr.procurementType === "MATERIAL_DEMAND" ? "MATERIAL_DEMAND" : "PR";
  const [trails, actability, readiness, cpcInfo, events, auditRows, coverage] = await Promise.all([
    getApprovalTrail(docType, pr.id),
    canUserActOnApproval(user, docType, pr.id),
    poReadiness(pr.id).catch(() => ({ ready: false, issues: [] as string[], cpcRequired: false, cpcCleared: true })),
    cpcRequirement(pr.entityId, pr.estimatedValue, pr.procurementType),
    caseTimeline(pr.number),
    prisma.auditLog.findMany({ where: { caseKey: pr.number }, orderBy: { createdAt: "desc" } }),
    // What has actually been ordered against each line, across every order.
    requisitionCoverage(pr.id),
  ]);

  const isOwner = pr.requesterId === user.id;
  const openStatuses = ["SOURCING", "CPC_REVIEW", "PO_PREPARATION"];
  const latestComparative = pr.comparatives[0];
  const hasAward = Boolean(latestComparative?.lines.some((l) => l.isSelected));

  const caps: CaseCapabilities = {
    canEdit: ["DRAFT", "RETURNED"].includes(pr.status) && (isOwner || userHasPermission(user, P.PR_EDIT)),
    canSubmit: ["DRAFT", "RETURNED"].includes(pr.status) && (isOwner || userHasPermission(user, P.PR_SUBMIT)),
    canDecide: actability.can && userHasPermission(user, P.PR_APPROVE),
    decideReason: actability.reason ?? null,
    pendingStepName: actability.stepName,
    canStartSourcing:
      ["APPROVED", "PROCUREMENT_REVIEW"].includes(pr.status) && userHasPermission(user, P.RFQ_ISSUE),
    canRaiseRfq: pr.status === "SOURCING" && userHasPermission(user, P.RFQ_ISSUE),
    canHold:
      userHasPermission(user, P.PR_HOLD) &&
      !["CLOSED", "REJECTED", "CANCELLED", "DRAFT"].includes(pr.status),
    canCancel:
      (userHasPermission(user, P.PR_CANCEL) || (isOwner && pr.status === "DRAFT")) &&
      !["CLOSED", "REJECTED", "CANCELLED"].includes(pr.status),
    canCreatePo:
      readiness.ready &&
      userHasPermission(user, P.PO_CREATE) &&
      openStatuses.includes(pr.status) &&
      hasAward,
    poReadinessIssues:
      openStatuses.includes(pr.status) && hasAward && !readiness.ready ? readiness.issues : [],
    cpcRequired: readiness.cpcRequired,
    cpcCleared: readiness.cpcCleared,
    onHold: pr.status === "ON_HOLD",
    holdReason: pr.holdReason,
    status: pr.status,
  };

  // Lifecycle rail with real timestamps against each reached stage.
  const reached: Record<string, { at?: Date | null; owner?: string | null }> = {
    DRAFT: { at: pr.createdAt, owner: pr.requester.name },
    SUBMITTED: { at: pr.submittedAt, owner: pr.requester.name },
    APPROVED: { at: pr.approvedAt },
    CLOSED: { at: pr.closedAt },
  };
  const po = pr.purchaseOrders[0];
  if (po) {
    reached.PO_APPROVED = { at: po.approvedAt, owner: po.createdBy.name };
    reached.PO_ISSUED = { at: po.issuedAt };
  }
  const grn = pr.purchaseOrders.flatMap((p) => p.grns).find((g) => g.status === "POSTED");
  if (grn) reached.GRN_COMPLETED = { at: grn.postedAt, owner: grn.receivedBy.name };
  const cpc = pr.cpcCases[0];
  if (cpc) reached.CPC_REVIEW = { at: cpc.createdAt, owner: cpc.status === "APPROVED" ? "Committee approved" : "Committee" };

  const terminalBad = ["REJECTED", "CANCELLED"].includes(pr.status);
  const skipped = cpcInfo.required ? [] : ["CPC_REVIEW"];
  const rail = buildRail(PR_LIFECYCLE, pr.status, reached, {
    skipped,
    terminalBad,
    blockedNote: pr.status === "ON_HOLD" ? "On hold" : actability.reason && !actability.can ? actability.reason : null,
  });

  const quoteCount = pr.rfqs.reduce((a, r) => a + r.quotes.length, 0);
  const negotiationCount = pr.rfqs.reduce((a, r) => a + r.quotes.reduce((s, q) => s + q.negotiations.length, 0), 0);
  const deliveryCount = pr.purchaseOrders.reduce((a, p) => a + p.deliveries.length, 0);
  const inspectionCount = pr.purchaseOrders.reduce(
    (a, p) => a + p.deliveries.reduce((s, d) => s + d.inspections.length, 0),
    0,
  );
  const grnCount = pr.purchaseOrders.reduce((a, p) => a + p.grns.length, 0);
  const invoiceCount = pr.purchaseOrders.reduce((a, p) => a + p.invoices.length, 0);
  const handoffCount = pr.purchaseOrders.reduce(
    (a, p) => a + p.invoices.reduce((s, i) => s + i.handoffs.length, 0),
    0,
  );
  const openExceptions = pr.exceptions.filter((e) => ["OPEN", "IN_PROGRESS"].includes(e.status)).length;

  const tabs = [
    { key: "overview", label: "Overview", count: null },
    { key: "items", label: "Items", count: pr.items.length },
    { key: "approvals", label: "Approvals", count: trails.reduce((a, t) => a + t.steps.length, 0) },
    { key: "rfq", label: "RFQs", count: pr.rfqs.length },
    { key: "quotes", label: "Quotes", count: quoteCount },
    { key: "comparison", label: "Comparison", count: pr.comparatives.length },
    { key: "negotiation", label: "Negotiation", count: negotiationCount },
    { key: "cpc", label: "CPC", count: pr.cpcCases.length },
    { key: "po", label: "PO", count: pr.purchaseOrders.length },
    { key: "delivery", label: "Delivery", count: deliveryCount },
    { key: "inspection", label: "Inspection", count: inspectionCount },
    { key: "grn", label: "GRN", count: grnCount },
    { key: "invoice", label: "Invoice", count: invoiceCount },
    { key: "finance", label: "Finance", count: handoffCount },
    { key: "documents", label: "Documents", count: null },
    { key: "exceptions", label: "Exceptions", count: openExceptions },
    { key: "timeline", label: "Timeline", count: events.length },
    ...(userHasPermission(user, P.AUDIT_VIEW) ? [{ key: "audit", label: "Audit", count: auditRows.length }] : []),
  ];

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Procurement", href: "/pr" },
          { label: "Requisitions", href: "/pr" },
          { label: pr.number },
        ]}
      />

      <PageHeader
        eyebrow={`${pr.entity.code} · ${pr.department.name}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{pr.number}</span>
            <span>{pr.title}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={pr.status} />
            </MetaItem>
            <MetaItem label="Value">{money(pr.estimatedValue)}</MetaItem>
            <MetaItem label="Requester">{pr.requester.name}</MetaItem>
            <MetaItem label="Priority">
              <Badge tone={PRIORITY_TONE[pr.priority] ?? "neutral"}>{humanize(pr.priority)}</Badge>
            </MetaItem>
            <MetaItem label="Required by">{fmtDate(pr.requiredDate)}</MetaItem>
            {pr.project && <MetaItem label="Project">{pr.project.name}</MetaItem>}
            {pr.site && <MetaItem label="Site">{pr.site.name}</MetaItem>}
            <MetaItem label="Raised">{fmtDateTime(pr.createdAt)}</MetaItem>
          </>
        }
      />

      <Card>
        <CaseActions prId={pr.id} prNumber={pr.number} caps={caps} />
      </Card>

      <LifecycleRail steps={rail} title="Lifecycle" segments={PR_RAIL_SEGMENTS} />

      <div>
        <TabNav tabs={tabs} active={tab} baseHref={`/pr/${pr.id}`} />
        <div className="pt-4">
          {tab === "overview" && <OverviewPanel pr={pr} cpcInfo={cpcInfo} />}
          {tab === "items" && <ItemsPanel pr={pr} coverage={coverage} />}
          {tab === "approvals" && <ApprovalsPanel trails={trails} />}
          {tab === "rfq" && <RfqPanel pr={pr} />}
          {tab === "quotes" && <QuotesPanel pr={pr} />}
          {tab === "comparison" && <ComparisonPanel pr={pr} />}
          {tab === "negotiation" && <NegotiationPanel pr={pr} />}
          {tab === "cpc" && <CpcPanel pr={pr} />}
          {tab === "po" && <PoPanel pr={pr} />}
          {tab === "delivery" && <DeliveryPanel pr={pr} />}
          {tab === "inspection" && <InspectionPanel pr={pr} />}
          {tab === "grn" && <GrnPanel pr={pr} />}
          {tab === "invoice" && <InvoicePanel pr={pr} />}
          {tab === "finance" && <FinancePanel pr={pr} />}
          {tab === "documents" && (
            <DocumentsPanel
              user={user}
              linkedType="PR"
              linkedId={pr.id}
              caseKey={pr.number}
              entityId={pr.entityId}
              title="Case documents"
              description="Every document attached anywhere in this case — requisition, BOQ, drawings, quotations, comparative, committee decision, purchase order, gate pass, inspection, GRN and invoice."
              defaultCategory={pr.procurementType === "MATERIAL_DEMAND" ? "BOQ" : "Specification"}
            />
          )}
          {tab === "exceptions" && (
            <ExceptionsPanel
              where={{ caseKey: pr.number }}
              title="Case exceptions"
              emptyLabel="No exceptions have been raised on this case."
            />
          )}
          {tab === "timeline" && <TimelinePanel events={events} />}
          {tab === "audit" && userHasPermission(user, P.AUDIT_VIEW) && (
            <AuditPanel rows={auditRows.map(parseAuditRow)} />
          )}
        </div>
      </div>
    </div>
  );
}
