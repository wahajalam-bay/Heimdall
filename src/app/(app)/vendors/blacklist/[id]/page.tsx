import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { documentTimeline } from "@/server/timeline";
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
import { BLACKLIST_LIFECYCLE, SEVERITY_TONE, humanize } from "@/lib/domain";
import { ageDays, fmtDate, fmtDateTime, money } from "@/lib/format";
import { reinstateVendorAction } from "../../actions";
import { AdvanceCaseForm } from "../../VendorStageForms";

export const dynamic = "force-dynamic";

/** Mirrors the server-side transition map so only legal moves are offered. */
const NEXT_STAGES: Record<string, string[]> = {
  RAISED: ["EVIDENCE_COLLECTION", "CLOSED"],
  EVIDENCE_COLLECTION: ["INVESTIGATION", "CLOSED"],
  INVESTIGATION: ["VENDOR_RESPONSE_AWAITED", "PROCUREMENT_REVIEW", "CLOSED"],
  VENDOR_RESPONSE_AWAITED: ["PROCUREMENT_REVIEW", "CLOSED"],
  PROCUREMENT_REVIEW: ["AUDIT_REVIEW", "DECISION_PENDING", "CLOSED"],
  AUDIT_REVIEW: ["DECISION_PENDING", "CLOSED"],
  DECISION_PENDING: ["BLACKLISTED", "WARNING_ISSUED", "RETAINED", "CLOSED"],
  BLACKLISTED: ["CLOSED"],
  WARNING_ISSUED: ["CLOSED"],
  RETAINED: ["CLOSED"],
  CLOSED: [],
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await prisma.vendorBlacklistCase.findUnique({ where: { id }, select: { number: true } });
  return { title: c ? `${c.number} — Investigation` : "Investigation" };
}

export default async function BlacklistCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.VENDOR_VIEW);
  if (!authorized) return <AccessDenied title="Investigation" />;

  const kase = await prisma.vendorBlacklistCase.findUnique({
    where: { id },
    include: {
      vendor: {
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
          statusReason: true,
          totalOrders: true,
          totalSpend: true,
          performanceScore: true,
          entityLinks: { select: { entityId: true } },
        },
      },
    },
  });
  if (!kase) notFound();

  const [events, raisedBy, decidedBy, issues, openPos] = await Promise.all([
    documentTimeline("VendorBlacklistCase", kase.id),
    prisma.user.findUnique({ where: { id: kase.raisedById }, select: { name: true, title: true } }),
    kase.decisionBy
      ? prisma.user.findUnique({ where: { id: kase.decisionBy }, select: { name: true, title: true } })
      : Promise.resolve(null),
    prisma.vendorIssue.findMany({
      where: { vendorId: kase.vendorId },
      orderBy: { raisedAt: "desc" },
      include: { raisedBy: { select: { name: true } } },
    }),
    prisma.purchaseOrder.findMany({
      where: {
        vendorId: kase.vendorId,
        status: { in: ["ISSUED", "ACKNOWLEDGED", "PARTIALLY_RECEIVED", "IN_PROGRESS"] },
      },
      select: { id: true, number: true, total: true, status: true, deliveryDate: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const canAdvance = userHasPermission(user, P.VENDOR_ISSUE_RAISE, P.VENDOR_BLACKLIST, P.VENDOR_AUDIT_REVIEW);
  const canBlacklist = userHasPermission(user, P.VENDOR_BLACKLIST);
  const allowed = NEXT_STAGES[kase.stage] ?? [];

  const blockers: string[] = [];
  if (kase.auditRequired && !kase.auditReview?.trim() && kase.stage !== "AUDIT_REVIEW") {
    blockers.push("Audit review is required on this case and has not been recorded — the decision stage is blocked.");
  }
  if (kase.stage === "PROCUREMENT_REVIEW" && !kase.investigationNotes?.trim()) {
    blockers.push("Investigation findings have not been recorded, so the case cannot move to decision.");
  }

  const rail = buildRail(
    BLACKLIST_LIFECYCLE,
    ["BLACKLISTED", "WARNING_ISSUED", "RETAINED"].includes(kase.stage) ? "DECISION_PENDING" : kase.stage,
    {
      RAISED: { at: kase.raisedAt, owner: raisedBy?.name ?? null },
      VENDOR_RESPONSE_AWAITED: { at: kase.vendorRespondedAt, owner: kase.vendor.name },
      DECISION_PENDING: { at: kase.decisionAt, owner: decidedBy?.name ?? null },
      CLOSED: { at: kase.closedAt, owner: null },
    },
    {
      skipped: kase.auditRequired ? [] : ["AUDIT_REVIEW"],
      blockedNote: blockers[0] ?? null,
      terminalBad: kase.decision === "BLACKLIST",
    },
  );

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Vendors", href: "/vendors" },
          { label: "Investigations", href: "/vendors/blacklist" },
          { label: kase.number },
        ]}
      />

      <PageHeader
        eyebrow={`${kase.vendor.code} · ${kase.vendor.name}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{kase.number}</span>
            <span>{humanize(kase.reasonCode)}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Stage">
              <StatusBadge status={kase.stage} />
            </MetaItem>
            <MetaItem label="Decision">
              {kase.decision ? (
                <Badge tone={kase.decision === "BLACKLIST" ? "danger" : kase.decision === "RETAIN" ? "success" : "warning"}>
                  {humanize(kase.decision)}
                </Badge>
              ) : (
                "Pending"
              )}
            </MetaItem>
            <MetaItem label="Audit review">
              {kase.auditRequired ? (
                kase.auditReview ? (
                  <Badge tone="success">Recorded</Badge>
                ) : (
                  <Badge tone="warning">Required</Badge>
                )
              ) : (
                <Badge tone="neutral">Not required</Badge>
              )}
            </MetaItem>
            <MetaItem label="Raised">{fmtDate(kase.raisedAt)}</MetaItem>
            <MetaItem label="Raised by">{raisedBy?.name ?? "—"}</MetaItem>
            {kase.stage !== "CLOSED" && <MetaItem label="Open for">{ageDays(kase.raisedAt) ?? 0} days</MetaItem>}
          </>
        }
        actions={
          <>
            {canAdvance && allowed.length > 0 && (
              <AdvanceCaseForm
                caseId={kase.id}
                number={kase.number}
                stage={kase.stage}
                allowedStages={allowed}
                auditRequired={kase.auditRequired}
              />
            )}
            {canBlacklist && ["BLACKLISTED", "SUSPENDED"].includes(kase.vendor.status) && (
              <ActionButton
                action={reinstateVendorAction}
                payload={{ vendorId: kase.vendor.id }}
                label="Reinstate vendor"
                tone="secondary"
                reasonLabel="On what basis is this vendor being reinstated? A substantive reason is required."
                reasonRequired
              />
            )}
            <Link href={`/vendors/${kase.vendor.id}`} className="btn btn-secondary btn-sm">
              Vendor record
            </Link>
          </>
        }
      />

      {kase.decision === "BLACKLIST" && (
        <BlockedNotice
          tone="danger"
          title={`${kase.vendor.name} was blacklisted by this case`}
          reasons={[
            kase.decisionNotes ?? kase.reason,
            kase.decisionAt ? `Decided ${fmtDateTime(kase.decisionAt)} by ${decidedBy?.name ?? "an authorised approver"}.` : "",
          ].filter(Boolean)}
        />
      )}

      {blockers.length > 0 && <BlockedNotice title="The case cannot progress yet" reasons={blockers} />}

      {openPos.length > 0 && kase.stage !== "CLOSED" && (
        <InlineAlert tone="warning">
          {openPos.length} purchase order{openPos.length === 1 ? "" : "s"} with this vendor{" "}
          {openPos.length === 1 ? "is" : "are"} still open, worth{" "}
          {money(openPos.reduce((a, p) => a + p.total, 0))}. Blacklisting does not cancel them — they must be closed or
          cancelled deliberately.
        </InlineAlert>
      )}

      <LifecycleRail steps={rail} title="Investigation stages" />

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-4">
          <SectionCard title="Grounds for the investigation">
            <DefList
              columns={1}
              items={[
                { label: "Reason code", value: humanize(kase.reasonCode) },
                { label: "Reason", value: <span className="whitespace-pre-wrap">{kase.reason}</span> },
                {
                  label: "Evidence held",
                  value: kase.evidence ? <span className="whitespace-pre-wrap">{kase.evidence}</span> : "None recorded",
                },
              ]}
            />
          </SectionCard>

          <SectionCard
            title="Case record"
            description="Each stage leaves its own written record. Nothing is overwritten."
          >
            <div className="space-y-3.5">
              <div>
                <span className="label mb-1 block">Investigation findings</span>
                <p className="whitespace-pre-wrap text-xs leading-5 text-muted">
                  {kase.investigationNotes ?? "Not yet recorded."}
                </p>
              </div>
              <div className="border-t border-separator pt-3">
                <span className="label mb-1 block">
                  Vendor response
                  {kase.vendorRespondedAt && (
                    <span className="ml-2 font-400 normal-case text-[var(--c-text-tertiary)]">
                      {fmtDateTime(kase.vendorRespondedAt)}
                    </span>
                  )}
                </span>
                <p className="whitespace-pre-wrap text-xs leading-5 text-muted">
                  {kase.vendorResponse ?? "The vendor has not replied."}
                </p>
              </div>
              <div className="border-t border-separator pt-3">
                <span className="label mb-1 block">Procurement review</span>
                <p className="whitespace-pre-wrap text-xs leading-5 text-muted">
                  {kase.procurementReview ?? "Not yet recorded."}
                </p>
              </div>
              <div className="border-t border-separator pt-3">
                <span className="label mb-1 block">Audit review</span>
                <p className="whitespace-pre-wrap text-xs leading-5 text-muted">
                  {kase.auditReview ??
                    (kase.auditRequired ? "Required but not yet recorded." : "Not required on this case.")}
                </p>
              </div>
              <div className="border-t border-separator pt-3">
                <span className="label mb-1 block">Decision</span>
                {kase.decision ? (
                  <>
                    <Badge tone={kase.decision === "BLACKLIST" ? "danger" : kase.decision === "RETAIN" ? "success" : "warning"}>
                      {humanize(kase.decision)}
                    </Badge>
                    <p className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-muted">
                      {kase.decisionNotes ?? "No notes recorded."}
                    </p>
                    <p className="mt-1 text-2xs text-[var(--c-text-tertiary)]">
                      {decidedBy?.name ?? "Unknown"}
                      {decidedBy?.title ? ` — ${decidedBy.title}` : ""}
                      {kase.decisionAt ? ` · ${fmtDateTime(kase.decisionAt)}` : ""}
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted">No decision has been taken.</p>
                )}
              </div>
            </div>
          </SectionCard>

          <SectionCard
            title="Issue history relied on"
            description="The recorded failures that form the evidence base."
            bodyClassName="px-0 py-0"
          >
            {issues.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-muted">
                No issues are on record for this vendor.
              </p>
            ) : (
              <div className="table-wrap max-h-[24rem] overflow-y-auto">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Issue</th>
                      <th>Type</th>
                      <th>Severity</th>
                      <th>Title</th>
                      <th>Status</th>
                      <th>Raised by</th>
                      <th>Raised</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issues.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <RefLink href={`/vendors/issues/${i.id}`}>{i.number}</RefLink>
                        </td>
                        <td className="text-2xs">{humanize(i.issueType)}</td>
                        <td>
                          <Badge tone={SEVERITY_TONE[i.severity] ?? "neutral"}>{humanize(i.severity)}</Badge>
                        </td>
                        <td className="max-w-[20rem] truncate text-xs" title={i.title}>
                          {i.title}
                        </td>
                        <td>
                          <StatusBadge status={i.status} />
                        </td>
                        <td className="text-xs">{i.raisedBy.name}</td>
                        <td className="text-xs">{fmtDate(i.raisedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>

        <div className="space-y-4">
          <SectionCard title="Case detail">
            <DefList
              columns={1}
              items={[
                { label: "Case number", value: <Mono>{kase.number}</Mono> },
                {
                  label: "Vendor",
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      <RefLink href={`/vendors/${kase.vendor.id}`}>{kase.vendor.name}</RefLink>
                      <StatusBadge status={kase.vendor.status} />
                    </span>
                  ),
                },
                { label: "Vendor status reason", value: kase.vendor.statusReason ?? "—" },
                { label: "Orders placed", value: kase.vendor.totalOrders },
                { label: "Historic spend", value: money(kase.vendor.totalSpend) },
                {
                  label: "Performance score",
                  value:
                    kase.vendor.performanceScore !== null ? kase.vendor.performanceScore.toFixed(1) : "Not computed",
                },
                {
                  label: "Raised by",
                  value: `${raisedBy?.name ?? "—"}${raisedBy?.title ? ` — ${raisedBy.title}` : ""}`,
                },
                { label: "Raised at", value: fmtDateTime(kase.raisedAt) },
                { label: "Audit required", value: kase.auditRequired ? "Yes" : "No" },
                { label: "Closed at", value: kase.closedAt ? fmtDateTime(kase.closedAt) : "Open" },
              ]}
            />
          </SectionCard>

          {openPos.length > 0 && (
            <SectionCard title="Open orders with this vendor" bodyClassName="px-0 py-0">
              <div className="table-wrap max-h-[16rem] overflow-y-auto">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Status</th>
                      <th className="text-right">Value</th>
                      <th>Expected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openPos.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <RefLink href={`/po/${p.id}`}>{p.number}</RefLink>
                        </td>
                        <td>
                          <StatusBadge status={p.status} />
                        </td>
                        <td className="num text-xs">{money(p.total)}</td>
                        <td className="text-xs">
                          {p.deliveryDate ? fmtDate(p.deliveryDate) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}

          <SectionCard title="Activity">
            <Timeline events={events} emptyLabel="No activity recorded yet." />
          </SectionCard>
        </div>
      </div>

      <DocumentsPanel
        user={user}
        linkedType="VENDOR"
        linkedId={kase.vendor.id}
        entityId={kase.vendor.entityLinks[0]?.entityId ?? null}
        title="Case evidence"
        description="Forged documents, correspondence, inspection reports, audit memos. This is the file an auditor will ask for."
        defaultCategory="Vendor"
      />
    </div>
  );
}
