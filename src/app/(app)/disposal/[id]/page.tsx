import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
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
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { LifecycleRail, Timeline, buildRail } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { DISPOSAL_LIFECYCLE, humanize } from "@/lib/domain";
import { ageDays, fmtDate, fmtDateTime, money, percent, qty, round2 } from "@/lib/format";
import { AddBidForm, AdvanceDisposalForm } from "../DisposalForms";

export const dynamic = "force-dynamic";

/** Mirrors the server-side transition map so only legal moves are offered. */
const NEXT_STAGES: Record<string, string[]> = {
  FLAGGED: ["ASSESSMENT", "CANCELLED"],
  ASSESSMENT: ["AUDIT_REVIEW", "PENDING_APPROVAL", "REJECTED", "CANCELLED"],
  AUDIT_REVIEW: ["PENDING_APPROVAL", "REJECTED", "CANCELLED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["BIDDING", "MANAGEMENT_APPROVAL", "PAYMENT_PENDING", "COMPLETED", "CANCELLED"],
  BIDDING: ["BID_EVALUATION", "CANCELLED"],
  BID_EVALUATION: ["MANAGEMENT_APPROVAL", "BIDDING", "CANCELLED"],
  MANAGEMENT_APPROVAL: ["PAYMENT_PENDING", "COMPLETED", "REJECTED", "CANCELLED"],
  PAYMENT_PENDING: ["PAYMENT_RECEIVED", "CANCELLED"],
  PAYMENT_RECEIVED: ["COMPLETED"],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await prisma.disposalCase.findUnique({ where: { id }, select: { number: true, title: true } });
  return { title: c ? `${c.number} — ${c.title}` : "Disposal case" };
}

export default async function DisposalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.DISPOSAL_VIEW);
  if (!authorized) return <AccessDenied title="Disposal case" />;

  const kase = await prisma.disposalCase.findUnique({
    where: { id },
    include: {
      entity: { select: { id: true, code: true, name: true } },
      raisedBy: { select: { name: true, title: true } },
      items: {
        orderBy: { lineNo: "asc" },
        include: {
          asset: { select: { id: true, tag: true, name: true, status: true, cost: true, currentValue: true } },
          item: { select: { id: true, sku: true, name: true } },
        },
      },
      bids: { orderBy: { amount: "desc" }, include: { vendor: { select: { id: true, name: true } } } },
      transactions: {
        orderBy: { performedAt: "asc" },
        include: { item: { select: { sku: true, name: true } }, store: { select: { id: true, name: true } } },
      },
    },
  });
  if (!kase) notFound();

  const [events, threshold, approver, auditor, mgmtApprover, vendors] = await Promise.all([
    documentTimeline("DisposalCase", kase.id),
    getConfigNumber(CONFIG_KEYS.DISPOSAL_BIDDING_THRESHOLD, kase.entityId),
    kase.approvedById
      ? prisma.user.findUnique({ where: { id: kase.approvedById }, select: { name: true, title: true } })
      : Promise.resolve(null),
    kase.auditReviewById
      ? prisma.user.findUnique({ where: { id: kase.auditReviewById }, select: { name: true, title: true } })
      : Promise.resolve(null),
    kase.managementApprovedById
      ? prisma.user.findUnique({ where: { id: kase.managementApprovedById }, select: { name: true, title: true } })
      : Promise.resolve(null),
    prisma.vendor.findMany({
      where: { status: { in: ["APPROVED", "CONDITIONAL"] } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const canCreate = userHasPermission(user, P.DISPOSAL_CREATE);
  const canApprove = userHasPermission(user, P.DISPOSAL_APPROVE);
  const canAudit = userHasPermission(user, P.DISPOSAL_AUDIT_REVIEW);
  const canManagement = userHasPermission(user, P.DISPOSAL_MANAGEMENT_APPROVE);
  const canAdvance = canCreate || canApprove || canAudit || canManagement;

  const allowed = NEXT_STAGES[kase.stage] ?? [];
  const bookValue = round2(kase.items.reduce((a, i) => a + (i.bookValue ?? 0), 0));
  const estimated = kase.estimatedValue ?? round2(kase.items.reduce((a, i) => a + (i.estimatedValue ?? 0), 0));
  const highestBid = kase.bids.length ? Math.max(...kase.bids.map((b) => b.amount)) : 0;
  const winning = kase.bids.find((b) => b.id === kase.winningBidId) ?? null;
  const recovery = bookValue > 0 && kase.realisedValue ? round2((kase.realisedValue / bookValue) * 100) : null;
  const terminal = ["COMPLETED", "REJECTED", "CANCELLED"].includes(kase.stage);

  const blockers: string[] = [];
  if (kase.biddingRequired && kase.bids.length === 0 && ["APPROVED", "BIDDING", "BID_EVALUATION"].includes(kase.stage)) {
    blockers.push(
      `Competitive bidding is required above ${money(threshold)} and no bids have been recorded — management approval is blocked.`,
    );
  }
  if (kase.stage === "MANAGEMENT_APPROVAL" && kase.biddingRequired && !kase.winningBidId) {
    blockers.push("No winning bid has been selected, so the sale cannot be approved.");
  }
  if (kase.stage === "PAYMENT_PENDING" && !kase.paymentReference) {
    blockers.push("Payment has not been received — the case cannot complete until the funds are recorded.");
  }

  const rail = buildRail(
    DISPOSAL_LIFECYCLE,
    ["REJECTED", "CANCELLED"].includes(kase.stage) ? "PENDING_APPROVAL" : kase.stage,
    {
      FLAGGED: { at: kase.raisedAt, owner: kase.raisedBy.name },
      AUDIT_REVIEW: { at: kase.auditReviewAt, owner: auditor?.name ?? null },
      APPROVED: { at: kase.approvedAt, owner: approver?.name ?? null },
      MANAGEMENT_APPROVAL: { at: kase.managementApprovedAt, owner: mgmtApprover?.name ?? null },
      PAYMENT_RECEIVED: { at: kase.paymentReceivedAt, owner: null },
      COMPLETED: { at: kase.completedAt, owner: null },
    },
    {
      skipped: kase.biddingRequired ? [] : ["BIDDING", "BID_EVALUATION"],
      blockedNote: blockers[0] ?? null,
      terminalBad: ["REJECTED", "CANCELLED"].includes(kase.stage),
    },
  );

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Assets", href: "/assets" },
          { label: "Disposal", href: "/disposal" },
          { label: kase.number },
        ]}
      />

      <PageHeader
        eyebrow={`${kase.entity.code} · ${humanize(kase.disposalCategory)}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-[var(--c-text-secondary)]">{kase.number}</span>
            <span>{kase.title}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Stage">
              <StatusBadge status={kase.stage} />
            </MetaItem>
            <MetaItem label="Items">{kase.items.length}</MetaItem>
            <MetaItem label="Book value">{money(bookValue)}</MetaItem>
            <MetaItem label="Estimated">{money(estimated)}</MetaItem>
            <MetaItem label="Bidding">
              {kase.biddingRequired ? <Badge tone="info">Required</Badge> : <Badge tone="neutral">Not required</Badge>}
            </MetaItem>
            <MetaItem label="Raised">{fmtDate(kase.raisedAt)}</MetaItem>
          </>
        }
        actions={
          <>
            {canAdvance && allowed.length > 0 && (
              <AdvanceDisposalForm
                caseId={kase.id}
                number={kase.number}
                stage={kase.stage}
                allowedStages={allowed}
                estimatedValue={estimated || null}
                bids={kase.bids.map((b) => ({
                  id: b.id,
                  bidderName: b.bidderName,
                  amount: b.amount,
                  status: b.status,
                }))}
              />
            )}
            {(canCreate || canApprove) && ["APPROVED", "BIDDING", "BID_EVALUATION"].includes(kase.stage) && (
              <AddBidForm
                caseId={kase.id}
                number={kase.number}
                vendors={vendors}
                bidCount={kase.bids.length}
                estimatedValue={estimated || null}
              />
            )}
            <Link href="/disposal" className="btn btn-secondary btn-sm">
              All cases
            </Link>
          </>
        }
      />

      {["REJECTED", "CANCELLED"].includes(kase.stage) && (
        <BlockedNotice
          tone={kase.stage === "REJECTED" ? "danger" : "warning"}
          title={`This case was ${kase.stage.toLowerCase()}`}
          reasons={[kase.assessmentNotes ?? "See the activity trail for the recorded reason."]}
        />
      )}

      {blockers.length > 0 && <BlockedNotice title="The case cannot progress yet" reasons={blockers} />}

      {kase.stage === "COMPLETED" && (
        <InlineAlert tone="success">
          Completed{kase.completedAt ? ` on ${fmtDate(kase.completedAt)}` : ""}
          {kase.finalAction ? ` · ${humanize(kase.finalAction).toLowerCase()}` : ""}
          {kase.realisedValue ? ` · ${money(kase.realisedValue)} realised` : ""}. Assets have been written off the register
          and any stock removed through the inventory ledger.
        </InlineAlert>
      )}

      {!terminal && (ageDays(kase.raisedAt) ?? 0) > 30 && (
        <InlineAlert tone="warning">
          This case has been open for {ageDays(kase.raisedAt) ?? 0} days. Items awaiting disposal continue to occupy space
          and hold book value.
        </InlineAlert>
      )}

      <LifecycleRail steps={rail} title="Disposal lifecycle" />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Book value" value={money(bookValue)} />
        <StatTile label="Estimated realisation" value={money(estimated)} />
        <StatTile
          label="Highest bid"
          value={highestBid > 0 ? money(highestBid) : "—"}
          hint={`${kase.bids.length} bid${kase.bids.length === 1 ? "" : "s"} recorded`}
        />
        <StatTile
          label="Realised"
          value={kase.realisedValue ? money(kase.realisedValue) : "—"}
          hint={recovery !== null ? `${percent(recovery, 0)} of book value` : undefined}
          tone={recovery !== null ? (recovery >= 50 ? "success" : recovery >= 20 ? "warning" : "danger") : "default"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <div className="space-y-4">
          <SectionCard title="Items in this case" bodyClassName="px-0 py-0">
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: "3rem" }}>#</th>
                    <th style={{ minWidth: "16rem" }}>Item</th>
                    <th className="text-right">Quantity</th>
                    <th>Condition</th>
                    <th className="text-right">Book value</th>
                    <th className="text-right">Estimated</th>
                    <th className="text-right">Realised</th>
                    <th>Disposition</th>
                  </tr>
                </thead>
                <tbody>
                  {kase.items.map((i) => (
                    <tr key={i.id}>
                      <td className="num text-xs text-[var(--c-text-tertiary)]">{i.lineNo}</td>
                      <td>
                        <span className="block text-xs font-500">{i.description}</span>
                        <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                          {i.asset ? (
                            <>
                              <RefLink href={`/assets/${i.asset.id}`}>{i.asset.tag}</RefLink>
                              <span className="ml-2">{humanize(i.asset.status)}</span>
                            </>
                          ) : i.item ? (
                            <Mono>{i.item.sku}</Mono>
                          ) : (
                            "Free-text item"
                          )}
                        </span>
                        {i.notes && (
                          <span className="mt-0.5 block text-2xs text-[var(--c-text-secondary)]">{i.notes}</span>
                        )}
                      </td>
                      <td className="num text-xs">{qty(i.quantity, i.unit)}</td>
                      <td>
                        <Badge
                          tone={
                            ["UNREPAIRABLE", "SCRAP", "EXPIRED"].includes(i.condition)
                              ? "danger"
                              : i.condition === "DAMAGED"
                                ? "warning"
                                : "neutral"
                          }
                        >
                          {humanize(i.condition)}
                        </Badge>
                      </td>
                      <td className="num text-xs">{i.bookValue !== null ? money(i.bookValue) : "—"}</td>
                      <td className="num text-xs">{i.estimatedValue !== null ? money(i.estimatedValue) : "—"}</td>
                      <td className="num text-xs">{i.realisedValue !== null ? money(i.realisedValue) : "—"}</td>
                      <td className="text-2xs">{i.disposition ? humanize(i.disposition) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} className="text-xs font-600">
                      Total
                    </td>
                    <td className="num text-xs font-600">{money(bookValue)}</td>
                    <td className="num text-xs font-600">{money(estimated)}</td>
                    <td className="num text-xs font-600">
                      {kase.realisedValue ? money(kase.realisedValue) : "—"}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </SectionCard>

          <SectionCard
            title="Bids"
            description={
              kase.biddingRequired
                ? `Competitive bidding is mandatory above ${money(threshold)} for this entity.`
                : "Bidding is not required at this value, but recorded bids still form part of the file."
            }
            bodyClassName="px-0 py-0"
          >
            {kase.bids.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-[var(--c-text-secondary)]">
                No bids recorded{kase.biddingRequired ? " — required before management approval." : "."}
              </p>
            ) : (
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Bidder</th>
                      <th>Contact</th>
                      <th className="text-right">Amount</th>
                      <th className="text-right">Against estimate</th>
                      <th>Status</th>
                      <th>Received</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kase.bids.map((b) => {
                      const vsEstimate = estimated > 0 ? round2(((b.amount - estimated) / estimated) * 100) : null;
                      return (
                        <tr key={b.id} className={b.id === kase.winningBidId ? "bg-[var(--c-success-soft)]/40" : undefined}>
                          <td>
                            {b.vendor ? (
                              <RefLink href={`/vendors/${b.vendor.id}`}>{b.bidderName}</RefLink>
                            ) : (
                              <span className="text-xs">{b.bidderName}</span>
                            )}
                            {b.id === kase.winningBidId && <Badge tone="success">Winning</Badge>}
                          </td>
                          <td className="text-2xs">{b.contactPhone ?? "—"}</td>
                          <td className="num text-xs font-500">{money(b.amount)}</td>
                          <td className="num text-2xs">
                            {vsEstimate === null ? (
                              "—"
                            ) : (
                              <span className={vsEstimate >= 0 ? "text-[var(--c-success)]" : "text-[var(--c-warning)]"}>
                                {vsEstimate >= 0 ? "+" : ""}
                                {percent(vsEstimate, 0)}
                              </span>
                            )}
                          </td>
                          <td>
                            <StatusBadge status={b.status} />
                          </td>
                          <td className="text-xs">{fmtDate(b.bidDate)}</td>
                          <td className="max-w-[18rem] truncate text-2xs text-[var(--c-text-secondary)]" title={b.notes ?? ""}>
                            {b.notes ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          {kase.transactions.length > 0 && (
            <SectionCard
              title="Inventory movements"
              description="Stock written out of a store as part of this disposal. Permanent ledger entries."
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
                      <th className="text-right">Value</th>
                      <th className="text-right">Balance after</th>
                      <th>Posted at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kase.transactions.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <Mono>{t.number}</Mono>
                          <span className="mt-0.5 block text-2xs">
                            <Badge tone="danger">{humanize(t.type)}</Badge>
                          </span>
                        </td>
                        <td className="text-xs">
                          <RefLink href={`/stores/${t.store.id}`}>{t.store.name}</RefLink>
                        </td>
                        <td className="text-xs">{t.item.name}</td>
                        <td className="num text-xs text-[var(--c-danger)]">{qty(t.quantity, t.unit)}</td>
                        <td className="num text-xs">{money(Math.abs(t.value))}</td>
                        <td className="num text-xs">{qty(t.balanceAfter)}</td>
                        <td className="text-xs">{fmtDateTime(t.performedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}
        </div>

        <div className="space-y-4">
          <SectionCard title="Case record">
            <DefList
              columns={1}
              items={[
                { label: "Case number", value: <Mono>{kase.number}</Mono> },
                { label: "Entity", value: kase.entity.name },
                { label: "Category", value: humanize(kase.disposalCategory) },
                {
                  label: "Recommended action",
                  value: kase.recommendedAction ? humanize(kase.recommendedAction) : "—",
                },
                { label: "Final action", value: kase.finalAction ? humanize(kase.finalAction) : "Not decided" },
                {
                  label: "Raised by",
                  value: `${kase.raisedBy.name}${kase.raisedBy.title ? ` — ${kase.raisedBy.title}` : ""}`,
                },
                { label: "Raised at", value: fmtDateTime(kase.raisedAt) },
                { label: "Bidding required", value: kase.biddingRequired ? "Yes" : "No" },
                { label: "Bid deadline", value: kase.bidDeadline ? fmtDate(kase.bidDeadline) : "—" },
                {
                  label: "Audit review",
                  value: auditor
                    ? `${auditor.name}${kase.auditReviewAt ? ` · ${fmtDate(kase.auditReviewAt)}` : ""}`
                    : "Not reviewed",
                },
                {
                  label: "Approved by",
                  value: approver
                    ? `${approver.name}${kase.approvedAt ? ` · ${fmtDate(kase.approvedAt)}` : ""}`
                    : "Not approved",
                },
                {
                  label: "Management approval",
                  value: mgmtApprover
                    ? `${mgmtApprover.name}${kase.managementApprovedAt ? ` · ${fmtDate(kase.managementApprovedAt)}` : ""}`
                    : "Not given",
                },
                {
                  label: "Winning bid",
                  value: winning ? `${winning.bidderName} — ${money(winning.amount)}` : "Not selected",
                },
                { label: "Payment reference", value: kase.paymentReference ? <Mono>{kase.paymentReference}</Mono> : "—" },
                {
                  label: "Payment received",
                  value: kase.paymentReceivedAt ? fmtDateTime(kase.paymentReceivedAt) : "—",
                },
                { label: "Completed", value: kase.completedAt ? fmtDateTime(kase.completedAt) : "—" },
                {
                  label: "Assessment notes",
                  value: kase.assessmentNotes ? <span className="whitespace-pre-wrap">{kase.assessmentNotes}</span> : "—",
                  span: true,
                },
                {
                  label: "Audit notes",
                  value: kase.auditNotes ? <span className="whitespace-pre-wrap">{kase.auditNotes}</span> : "—",
                  span: true,
                },
              ]}
            />
          </SectionCard>

          <SectionCard title="Value recovery">
            <div className="space-y-2 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[var(--c-text-secondary)]">Book value</span>
                <span className="tnum">{money(bookValue)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[var(--c-text-secondary)]">Estimated realisation</span>
                <span className="tnum">{money(estimated)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[var(--c-text-secondary)]">Highest bid</span>
                <span className="tnum">{highestBid > 0 ? money(highestBid) : "—"}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-[var(--c-border-subtle)] pt-2">
                <span className="text-[var(--c-text-secondary)]">Actually realised</span>
                <span className="tnum font-600">{kase.realisedValue ? money(kase.realisedValue) : "—"}</span>
              </div>
              {recovery !== null && (
                <p className="pt-1 text-2xs text-[var(--c-text-tertiary)]">
                  {percent(recovery, 0)} of book value recovered. Anything under 20% invites the question of whether the
                  items were held too long.
                </p>
              )}
            </div>
          </SectionCard>

          <SectionCard title="Activity">
            <Timeline events={events} emptyLabel="No activity recorded yet." />
          </SectionCard>
        </div>
      </div>

      <DocumentsPanel
        user={user}
        linkedType="DISPOSAL"
        linkedId={kase.id}
        entityId={kase.entityId}
        title="Case documents"
        description="Condition photographs, valuation basis, bid sheets, audit memo and the payment receipt."
        defaultCategory="Disposal"
      />
    </div>
  );
}
