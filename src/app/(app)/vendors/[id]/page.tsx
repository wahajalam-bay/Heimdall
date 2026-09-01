import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { scoreBand, vendorHistory } from "@/server/vendors";
import { documentTimeline } from "@/server/timeline";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs, TabNav } from "@/components/ui/nav";
import {
  Badge,
  BlockedNotice,
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
import { ActionButton } from "@/components/ui/forms";
import { Timeline } from "@/components/ui/workflow";
import { RankedBars, TrendChart } from "@/components/ui/charts";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { humanize } from "@/lib/domain";
import { fmtDate, fmtDateTime, money, percent, round2 } from "@/lib/format";
import { recomputePerformanceAction, reinstateVendorAction, vendorIssueTargets } from "../actions";
import {
  EvaluateVendorForm,
  OpenInvestigationForm,
  RaiseIssueForm,
  UpdateIssueForm,
  VendorDecisionForm,
} from "../VendorStageForms";
import { searchLink, tableLink } from "@/lib/links";

export const dynamic = "force-dynamic";

const TABS = ["overview", "history", "performance", "evaluations", "documents", "issues"] as const;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = await prisma.vendor.findUnique({ where: { id }, select: { name: true, code: true } });
  return { title: v ? `${v.name} — Vendor` : "Vendor" };
}

export default async function VendorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.VENDOR_VIEW);
  if (!authorized) return <AccessDenied title="Vendor" />;

  const requested = first((await searchParams).tab) ?? "overview";
  const tab = (TABS as readonly string[]).includes(requested) ? requested : "overview";

  const vendor = await prisma.vendor.findUnique({
    where: { id },
    include: {
      entityLinks: { include: { entity: { select: { id: true, code: true, name: true } } } },
      contacts: { orderBy: { isPrimary: "desc" } },
      documents: { orderBy: { createdAt: "desc" } },
      evaluations: {
        orderBy: { evaluatedAt: "desc" },
        include: {
          evaluator: { select: { name: true } },
          scores: { include: { criterion: { select: { name: true, group: true, maxScore: true } } } },
        },
      },
      performance: { orderBy: { periodEnd: "desc" }, take: 12 },
      issues: { orderBy: { raisedAt: "desc" }, include: { raisedBy: { select: { name: true } } } },
      blacklistCases: { orderBy: { raisedAt: "desc" } },
    },
  });
  if (!vendor) notFound();

  const [history, events, passMark, configuredMax, criteria, targets] = await Promise.all([
    vendorHistory(vendor.id),
    documentTimeline("Vendor", vendor.id),
    getConfigNumber(CONFIG_KEYS.VENDOR_MIN_SCORE, null),
    getConfigNumber(CONFIG_KEYS.VENDOR_MAX_SCORE, null),
    prisma.evaluationCriterion.findMany({
      where: { active: true },
      orderBy: [{ group: "asc" }, { sequence: "asc" }],
    }),
    vendorIssueTargets(vendor.id),
  ]);

  const canEdit = userHasPermission(user, P.VENDOR_EDIT);
  const canEvaluate = userHasPermission(user, P.VENDOR_EVALUATE);
  const canApprove = userHasPermission(user, P.VENDOR_APPROVE);
  const canRaiseIssue = userHasPermission(user, P.VENDOR_ISSUE_RAISE);
  const canBlacklist = userHasPermission(user, P.VENDOR_BLACKLIST);
  const canSeeFinancials = userHasPermission(user, P.VENDOR_FINANCIALS_VIEW);

  const latestEval = vendor.evaluations[0];
  const band = scoreBand(vendor.scorePercent);
  const openCase = vendor.blacklistCases.find((c) => c.stage !== "CLOSED");
  const openIssues = vendor.issues.filter((i) => !["RESOLVED", "CLOSED"].includes(i.status));
  const expiringDocs = vendor.documents.filter(
    (d) => d.expiryDate && d.expiryDate.getTime() < Date.now() + 60 * 86400000,
  );

  const perfSeries = [...vendor.performance]
    .reverse()
    .map((p) => ({
      label: fmtDate(p.periodEnd),
      values: [round2(p.score), round2(p.onTimePercent), round2(p.qualityPercent)],
    }));

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Vendors", href: "/vendors" }, { label: vendor.name }]} />

      <PageHeader
        eyebrow={`${vendor.code} · ${humanize(vendor.businessType)}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span>{vendor.name}</span>
            {vendor.isTrader && <Badge tone="neutral">Trader</Badge>}
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={vendor.status} />
            </MetaItem>
            <MetaItem label="Pre-qualification">
              {vendor.currentScore !== null ? (
                <span className="flex items-center gap-1.5">
                  <span className="tnum">
                    {round2(vendor.currentScore)} / {round2(vendor.maxScore ?? configuredMax)}
                  </span>
                  <Badge tone={band.tone}>{band.label}</Badge>
                </span>
              ) : (
                "Not scored"
              )}
            </MetaItem>
            <MetaItem label="Orders">{vendor.totalOrders}</MetaItem>
            <MetaItem label="Spend">{money(vendor.totalSpend)}</MetaItem>
            <MetaItem label="Open issues">{openIssues.length}</MetaItem>
            <MetaItem label="City">{vendor.city ?? "—"}</MetaItem>
          </>
        }
        actions={
          <>
            <Link className="btn btn-secondary btn-sm" href={`/vendors/${vendor.id}/annexure-6`}>
              Annexure 6 form
            </Link>
            {canEvaluate && (
              <EvaluateVendorForm
                vendorId={vendor.id}
                vendorName={vendor.name}
                criteria={criteria}
                passMark={passMark}
                configuredMax={configuredMax}
                label={latestEval ? "Re-evaluate" : "Score pre-qualification"}
                evaluationType={latestEval ? "RE_EVALUATION" : "PRE_QUALIFICATION"}
              />
            )}
            {canApprove && !["BLACKLISTED"].includes(vendor.status) && (
              <VendorDecisionForm
                vendorId={vendor.id}
                vendorName={vendor.name}
                entities={vendor.entityLinks.map((l) => l.entity)}
                currentEntityIds={vendor.entityLinks.map((l) => l.entityId)}
                hasEvaluation={!!latestEval}
                latestPassed={!!latestEval?.passed}
              />
            )}
            {canRaiseIssue && <RaiseIssueForm vendorId={vendor.id} vendorName={vendor.name} targets={targets} />}
            {canRaiseIssue && !openCase && !["BLACKLISTED"].includes(vendor.status) && (
              <OpenInvestigationForm
                vendorId={vendor.id}
                vendorName={vendor.name}
                openIssues={openIssues.length}
              />
            )}
            {canBlacklist && ["BLACKLISTED", "SUSPENDED", "INACTIVE"].includes(vendor.status) && (
              <ActionButton
                action={reinstateVendorAction}
                payload={{ vendorId: vendor.id }}
                label="Reinstate"
                tone="secondary"
                reasonLabel="On what basis is this vendor being reinstated? A substantive reason is required."
                reasonRequired
              />
            )}
            {canEdit && (
              <Link href={`/vendors/${vendor.id}/edit`} className="btn btn-secondary btn-sm">
                Edit
              </Link>
            )}
          </>
        }
      />

      {vendor.status === "BLACKLISTED" && (
        <BlockedNotice
          tone="danger"
          title="This vendor is blacklisted"
          reasons={[
            vendor.statusReason ?? "No reason recorded.",
            vendor.blacklistedAt ? `Blacklisted on ${fmtDate(vendor.blacklistedAt)}.` : "",
            "RFQ invitations and purchase orders are refused by the server for this vendor.",
          ].filter(Boolean)}
        />
      )}

      {vendor.status === "SUSPENDED" && (
        <BlockedNotice
          title="This vendor is suspended"
          reasons={[vendor.statusReason ?? "Suspended pending investigation.", "New sourcing is blocked while suspended."]}
        />
      )}

      {openCase && (
        <div className="rounded-2xl alert-warning px-3.5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <span className="text-[0.8125rem] font-600 text-[var(--c-warning)]">
                Investigation {openCase.number} is open
              </span>
              <p className="mt-0.5 text-xs text-muted">
                Stage: {humanize(openCase.stage)} · {humanize(openCase.reasonCode)} · raised {fmtDate(openCase.raisedAt)}
              </p>
            </div>
            <Link href={`/vendors/blacklist/${openCase.id}`} className="btn btn-secondary btn-sm">
              Open case
            </Link>
          </div>
        </div>
      )}

      {expiringDocs.length > 0 && (
        <InlineAlert tone="warning">
          {expiringDocs.length} vendor document{expiringDocs.length === 1 ? "" : "s"} expired or expiring within 60 days:{" "}
          {expiringDocs.map((d) => `${humanize(d.docType)} (${d.expiryDate ? fmtDate(d.expiryDate) : "no date"})`).join(", ")}.
        </InlineAlert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Performance score"
          value={vendor.performanceScore !== null ? round2(vendor.performanceScore) : "—"}
          hint="Weighted delivery, quality and conduct"
          tone={
            vendor.performanceScore === null
              ? "default"
              : vendor.performanceScore >= 70
                ? "success"
                : vendor.performanceScore >= 50
                  ? "warning"
                  : "danger"
          }
          href="/vendors/performance"
        />
        <StatTile
          label="On-time delivery"
          value={vendor.onTimePercent !== null ? percent(vendor.onTimePercent, 0) : "—"}
          href="/vendors/performance"
        />
        <StatTile
          label="Quality acceptance"
          value={vendor.qualityPercent !== null ? percent(vendor.qualityPercent, 0) : "—"}
          href="/vendors/performance"
        />
        <StatTile
          label="Negotiation savings realised"
          value={money(history.totals.negotiationSavings)}
          hint="Across orders placed with this vendor"
          href="/analytics/savings"
        />
      </div>

      <TabNav
        baseHref={`/vendors/${vendor.id}`}
        active={tab}
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "history", label: "Transaction history", count: history.recentPos.length },
          { key: "performance", label: "Performance", count: vendor.performance.length },
          { key: "evaluations", label: "Evaluations", count: vendor.evaluations.length },
          { key: "documents", label: "Documents", count: vendor.documents.length },
          { key: "issues", label: "Issues", count: vendor.issues.length },
        ]}
      />

      {tab === "overview" && (
        <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
          <div className="space-y-4">
            <SectionCard title="Profile">
              <DefList
                columns={2}
                items={[
                  { label: "Code", value: <Mono>{vendor.code}</Mono> },
                  { label: "Trading name", value: vendor.name },
                  { label: "Legal name", value: vendor.legalName ?? "—" },
                  { label: "Business type", value: humanize(vendor.businessType) },
                  { label: "Tax status", value: humanize(vendor.taxStatus) },
                  { label: "NTN", value: vendor.ntn ? <Mono>{vendor.ntn}</Mono> : "—" },
                  { label: "STRN", value: vendor.strn ? <Mono>{vendor.strn}</Mono> : "—" },
                  { label: "Registration number", value: vendor.registrationNumber ?? "—" },
                  { label: "Contact person", value: vendor.contactPerson ?? "—" },
                  { label: "Phone", value: vendor.contactPhone ?? "—" },
                  { label: "Email", value: vendor.contactEmail ?? "—" },
                  { label: "Website", value: vendor.website ?? "—" },
                  { label: "City", value: vendor.city ?? "—" },
                  { label: "Country", value: vendor.country },
                  { label: "Address", value: vendor.address ?? "—", span: true },
                  { label: "Supplies", value: vendor.categories ?? "—", span: true },
                  { label: "Products and services", value: vendor.productsServices ?? "—", span: true },
                  { label: "References", value: vendor.references ?? "—", span: true },
                ]}
              />
            </SectionCard>

            <SectionCard title="Capacity and terms">
              <DefList
                columns={3}
                items={[
                  { label: "Offices", value: vendor.officeCount ?? "—" },
                  { label: "Cities covered", value: vendor.citiesCovered ?? "—" },
                  { label: "Workforce", value: vendor.workforceCount ?? "—" },
                  { label: "Support staff", value: vendor.supportStaffCount ?? "—" },
                  {
                    label: "Own transport",
                    value: vendor.hasTransportation ? (
                      <Badge tone="success">Yes</Badge>
                    ) : (
                      <Badge tone="neutral">No</Badge>
                    ),
                  },
                  { label: "Transport notes", value: vendor.transportationNotes ?? "—" },
                  { label: "Payment terms", value: vendor.paymentTerms ?? "—" },
                  { label: "Credit days", value: vendor.creditDays ?? "—" },
                  {
                    label: "Minimum order value",
                    value: vendor.minimumOrderValue ? money(vendor.minimumOrderValue) : "—",
                  },
                  { label: "Source channel", value: humanize(vendor.sourceChannel) },
                  { label: "Source notes", value: vendor.sourceNotes ?? "—", span: true },
                ]}
              />
            </SectionCard>

            {canSeeFinancials ? (
              <SectionCard
                title="Banking"
                description="Restricted to roles holding the vendor financials permission. Payments are released against these details."
              >
                <DefList
                  columns={2}
                  items={[
                    { label: "Bank", value: vendor.bankName ?? "—" },
                    { label: "Account title", value: vendor.bankAccountTitle ?? "—" },
                    {
                      label: "Account number",
                      value: vendor.bankAccountNumber ? <Mono>{vendor.bankAccountNumber}</Mono> : "—",
                    },
                    { label: "IBAN", value: vendor.bankIban ? <Mono>{vendor.bankIban}</Mono> : "—" },
                  ]}
                />
              </SectionCard>
            ) : (
              <SectionCard title="Banking">
                <p className="text-xs text-muted">
                  Banking details are withheld. They are visible only to roles holding the vendor financials permission —
                  this is enforced on the server, not by hiding the section.
                </p>
              </SectionCard>
            )}
          </div>

          <div className="space-y-4">
            <SectionCard title="Standing">
              <div className="space-y-3">
                <div>
                  <span className="label mb-1 block">Pre-qualification</span>
                  {vendor.scorePercent !== null ? (
                    <Meter
                      value={vendor.scorePercent}
                      max={100}
                      tone={band.tone === "neutral" ? "info" : band.tone}
                      label={`${round2(vendor.currentScore ?? 0)} of ${round2(vendor.maxScore ?? configuredMax)} · pass mark ${passMark}`}
                    />
                  ) : (
                    <p className="text-xs text-muted">No evaluation on file.</p>
                  )}
                </div>
                {vendor.performanceScore !== null && (
                  <div>
                    <span className="label mb-1 block">Performance</span>
                    <Meter
                      value={vendor.performanceScore}
                      max={100}
                      tone={vendor.performanceScore >= 70 ? "success" : vendor.performanceScore >= 50 ? "warning" : "danger"}
                      label="Latest computed period"
                    />
                  </div>
                )}
                <DefList
                  columns={1}
                  items={[
                    { label: "Status reason", value: vendor.statusReason ?? "—" },
                    { label: "Approved at", value: vendor.approvedAt ? fmtDateTime(vendor.approvedAt) : "—" },
                    { label: "Last evaluated", value: latestEval ? fmtDate(latestEval.evaluatedAt) : "Never" },
                    { label: "Last order", value: vendor.lastOrderAt ? fmtDate(vendor.lastOrderAt) : "—" },
                    { label: "Registered", value: fmtDate(vendor.createdAt) },
                  ]}
                />
              </div>
            </SectionCard>

            <SectionCard title="Entity access">
              {vendor.entityLinks.length === 0 ? (
                <p className="text-xs text-muted">Not linked to any entity yet.</p>
              ) : (
                <ul className="space-y-2">
                  {vendor.entityLinks.map((l) => (
                    <li key={l.entityId} className="flex items-center justify-between gap-3 text-xs">
                      <span>{l.entity.name}</span>
                      <Badge tone={l.approved ? "success" : "warning"}>
                        {l.approved ? "Approved" : "Not approved"}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            {vendor.contacts.length > 0 && (
              <SectionCard title="Contacts">
                <ul className="space-y-2.5">
                  {vendor.contacts.map((c) => (
                    <li key={c.id} className="text-xs">
                      <span className="flex items-center gap-2 font-500">
                        {c.name}
                        {c.isPrimary && <Badge tone="info">Primary</Badge>}
                      </span>
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        {[c.role, c.phone, c.email].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}

            <SectionCard title="Activity">
              <Timeline events={events} emptyLabel="No activity recorded yet." />
            </SectionCard>
          </div>
        </div>
      )}

      {tab === "history" && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
            <StatTile label="Purchase orders" value={history.totals.orders} href={searchLink("/po", vendor.name)} />
            <StatTile
              label="Total spend"
              value={money(history.totals.spend)}
              href={tableLink("/po", undefined, { q: vendor.name, sort: "total:desc" })}
            />
            <StatTile label="Goods receipts" value={history.totals.grns} href={searchLink("/grn", vendor.name)} />
            <StatTile
              label="Invoice issues"
              value={history.totals.invoiceIssues}
              tone={history.totals.invoiceIssues ? "warning" : "default"}
              href={tableLink("/invoices", { matchStatus: humanize("FAILED") }, { q: vendor.name })}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Spend by category" description="Where this vendor's value actually sits.">
              <RankedBars
                data={history.categorySpend.map((c) => ({
                  label: c.category,
                  value: c.spend,
                  href: tableLink("/analytics/savings", { vendor: vendor.name, category: c.category }),
                }))}
                format="moneyCompact"
                maxRows={8}
              />
            </SectionCard>
            <SectionCard title="Spend by project">
              <RankedBars
                data={history.projectSpend.map((p) => ({
                  label: p.project,
                  value: p.spend,
                  href: tableLink("/pr", { project: p.project }),
                }))}
                format="moneyCompact"
                colorIndex={1}
                maxRows={8}
              />
            </SectionCard>
          </div>

          <SectionCard title="Purchase orders" bodyClassName="px-0 py-0">
            {history.recentPos.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-muted">
                No purchase orders placed with this vendor.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Entity</th>
                      <th>Status</th>
                      <th className="text-right">Value</th>
                      <th>Issued</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.recentPos.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <RefLink href={`/po/${p.id}`}>{p.number}</RefLink>
                        </td>
                        <td>
                          <Badge tone="neutral">{p.entityCode}</Badge>
                        </td>
                        <td>
                          <StatusBadge status={p.status} />
                        </td>
                        <td className="num text-xs">{money(p.total)}</td>
                        <td className="text-xs">{p.issuedAt ? fmtDate(p.issuedAt) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Quotations" bodyClassName="px-0 py-0">
              {history.recentQuotes.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-muted">No quotations on file.</p>
              ) : (
                <div className="table-wrap max-h-[20rem] overflow-y-auto">
                  <table className="dt">
                    <thead>
                      <tr>
                        <th>Quote</th>
                        <th>RFQ</th>
                        <th>Status</th>
                        <th className="text-right">Total</th>
                        <th>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.recentQuotes.map((q) => (
                        <tr key={q.id}>
                          <td>
                            <Mono>{q.number}</Mono>
                          </td>
                          <td className="text-xs">{q.rfqNumber}</td>
                          <td>
                            <StatusBadge status={q.status} />
                          </td>
                          <td className="num text-xs">{money(q.total)}</td>
                          <td className="text-xs">{fmtDate(q.quoteDate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>

            <SectionCard title="Goods receipts" bodyClassName="px-0 py-0">
              {history.recentGrns.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-muted">No goods received.</p>
              ) : (
                <div className="table-wrap max-h-[20rem] overflow-y-auto">
                  <table className="dt">
                    <thead>
                      <tr>
                        <th>GRN</th>
                        <th>Store</th>
                        <th className="text-right">Value</th>
                        <th>Received</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.recentGrns.map((g) => (
                        <tr key={g.id}>
                          <td>
                            <RefLink href={`/grn/${g.id}`}>{g.number}</RefLink>
                          </td>
                          <td className="text-xs">{g.storeName}</td>
                          <td className="num text-xs">{money(g.totalValue)}</td>
                          <td className="text-xs">{fmtDate(g.receivedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          </div>
        </div>
      )}

      {tab === "performance" && (
        <div className="space-y-4">
          <SectionCard
            title="Performance over time"
            description="Computed from delivery dates, inspection outcomes, invoice matching and recorded issues — not entered by hand."
            actions={
              userHasPermission(user, P.VENDOR_EVALUATE, P.VENDOR_APPROVE, P.ANALYTICS_VIEW) && (
                <ActionButton
                  action={recomputePerformanceAction}
                  payload={{ vendorId: vendor.id, months: 12 }}
                  label="Recompute"
                  tone="secondary"
                  size="xs"
                />
              )
            }
          >
            {perfSeries.length === 0 ? (
              <EmptyState
                title="No performance periods computed"
                description="Performance is computed from completed transactions. Recompute once this vendor has delivered against an order."
              />
            ) : (
              <TrendChart
                data={perfSeries}
                series={[
                  { key: "score", label: "Overall score", colorIndex: 0 },
                  { key: "onTime", label: "On-time %", colorIndex: 1 },
                  { key: "quality", label: "Quality %", colorIndex: 2 },
                ]}
                format="number"
                height={240}
              />
            )}
          </SectionCard>

          {vendor.performance.length > 0 && (
            <SectionCard title="Period detail" bodyClassName="px-0 py-0">
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th className="text-right">Orders</th>
                      <th className="text-right">Spend</th>
                      <th className="text-right">On time</th>
                      <th className="text-right">Late</th>
                      <th className="text-right">Partial</th>
                      <th className="text-right">Rejected lines</th>
                      <th className="text-right">Quality issues</th>
                      <th className="text-right">Invoice issues</th>
                      <th className="text-right">On-time %</th>
                      <th className="text-right">Quality %</th>
                      <th className="text-right">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendor.performance.map((p) => (
                      <tr key={p.id}>
                        <td className="text-xs">
                          {fmtDate(p.periodStart)} — {fmtDate(p.periodEnd)}
                        </td>
                        <td className="num text-xs">{p.ordersCount}</td>
                        <td className="num text-xs">{money(p.totalSpend)}</td>
                        <td className="num text-xs">{p.onTimeDeliveries}</td>
                        <td className="num text-xs">{p.lateDeliveries}</td>
                        <td className="num text-xs">{p.partialDeliveries}</td>
                        <td className="num text-xs">{p.rejectedLines}</td>
                        <td className="num text-xs">{p.qualityIssues}</td>
                        <td className="num text-xs">{p.invoiceIssues}</td>
                        <td className="num text-xs">{percent(p.onTimePercent, 0)}</td>
                        <td className="num text-xs">{percent(p.qualityPercent, 0)}</td>
                        <td className="num text-xs font-600">{round2(p.score)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}
        </div>
      )}

      {tab === "evaluations" && (
        <div className="space-y-4">
          {vendor.evaluations.length === 0 ? (
            <EmptyState
              title="No evaluations recorded"
              description={`Pre-qualification is scored against ${criteria.length} weighted criteria and scaled to ${configuredMax}, with a pass mark of ${passMark}.`}
              action={
                canEvaluate && (
                  <EvaluateVendorForm
                    vendorId={vendor.id}
                    vendorName={vendor.name}
                    criteria={criteria}
                    passMark={passMark}
                    configuredMax={configuredMax}
                  />
                )
              }
            />
          ) : (
            vendor.evaluations.map((ev) => (
              <SectionCard
                key={ev.id}
                title={`${ev.number} · ${humanize(ev.evaluationType)}`}
                description={`Scored by ${ev.evaluator.name} on ${fmtDateTime(ev.evaluatedAt)}`}
                bodyClassName="px-0 py-0"
              >
                <div className="flex flex-wrap items-center gap-4 border-b border-separator px-4 py-3">
                  <div>
                    <span className="label block">Score</span>
                    <span className="tnum text-[1rem] font-600">
                      {round2(ev.totalScore)} / {round2(ev.maxScore)}
                    </span>
                  </div>
                  <div>
                    <span className="label block">Percentage</span>
                    <span className="tnum text-[1rem] font-600">{percent(ev.percentage, 1)}</span>
                  </div>
                  <div>
                    <span className="label block">Pass mark</span>
                    <span className="tnum text-[1rem]">{round2(ev.passingScore)}</span>
                  </div>
                  <div>
                    <span className="label block">Outcome</span>
                    <Badge tone={ev.passed ? "success" : "danger"}>{ev.passed ? "Passed" : "Failed"}</Badge>
                  </div>
                  <div>
                    <span className="label block">Status</span>
                    <StatusBadge status={ev.status} />
                  </div>
                </div>
                <div className="table-wrap">
                  <table className="dt">
                    <thead>
                      <tr>
                        <th>Group</th>
                        <th>Criterion</th>
                        <th className="text-right">Score</th>
                        <th className="text-right">Max</th>
                        <th className="text-right">Weight</th>
                        <th className="text-right">Weighted</th>
                        <th>Comment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ev.scores.map((s) => (
                        <tr key={s.id}>
                          <td className="text-2xs text-[var(--c-text-tertiary)]">{s.criterion.group}</td>
                          <td className="text-xs">{s.criterion.name}</td>
                          <td className="num text-xs">{round2(s.score)}</td>
                          <td className="num text-xs">{round2(s.maxScore)}</td>
                          <td className="num text-xs">{s.weight}</td>
                          <td className="num text-xs">{round2(s.weightedScore)}</td>
                          <td className="max-w-[20rem] truncate text-2xs text-muted" title={s.comment ?? ""}>
                            {s.comment ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {(ev.recommendation || ev.notes) && (
                  <div className="border-t border-separator px-4 py-3">
                    <DefList
                      columns={1}
                      items={[
                        { label: "Recommendation", value: ev.recommendation ?? "—" },
                        { label: "Notes", value: ev.notes ?? "—" },
                      ]}
                    />
                  </div>
                )}
              </SectionCard>
            ))
          )}
        </div>
      )}

      {tab === "documents" && (
        <div className="space-y-4">
          <SectionCard
            title="Registration documents"
            description="NTN, STRN, incorporation, bank letter and references. Expiry dates are tracked so a lapsed certificate is visible before it matters."
            bodyClassName="px-0 py-0"
          >
            {vendor.documents.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-muted">
                No vendor documents recorded.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Name</th>
                      <th>Verified</th>
                      <th>Expiry</th>
                      <th>Notes</th>
                      <th>Added</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendor.documents.map((d) => {
                      const expired = d.expiryDate && d.expiryDate.getTime() < Date.now();
                      return (
                        <tr key={d.id}>
                          <td className="text-xs">{humanize(d.docType)}</td>
                          <td className="text-xs">{d.name}</td>
                          <td>
                            <Badge tone={d.verified ? "success" : "warning"}>
                              {d.verified ? "Verified" : "Unverified"}
                            </Badge>
                          </td>
                          <td className="text-xs">
                            {d.expiryDate ? (
                              <span className={expired ? "text-[var(--c-danger)] font-600" : undefined}>
                                {fmtDate(d.expiryDate)}
                                {expired ? " (expired)" : ""}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="max-w-[18rem] truncate text-2xs text-muted">
                            {d.notes ?? "—"}
                          </td>
                          <td className="text-xs">{fmtDate(d.createdAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <DocumentsPanel
            user={user}
            linkedType="VENDOR"
            linkedId={vendor.id}
            entityId={vendor.entityLinks[0]?.entityId ?? null}
            title="Uploaded files"
            description="Scanned certificates, profiles and correspondence. Access follows the document's confidentiality setting."
            defaultCategory="Vendor"
          />
        </div>
      )}

      {tab === "issues" && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
            <StatTile label="Total issues" value={vendor.issues.length} />
            <StatTile label="Open" value={openIssues.length} tone={openIssues.length ? "warning" : "success"} />
            <StatTile
              label="High or critical"
              value={vendor.issues.filter((i) => ["HIGH", "CRITICAL"].includes(i.severity)).length}
              tone={vendor.issues.some((i) => i.severity === "CRITICAL") ? "danger" : "default"}
            />
            <StatTile label="Investigations" value={vendor.blacklistCases.length} />
          </div>

          <SectionCard title="Issues raised" bodyClassName="px-0 py-0">
            {vendor.issues.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-muted">
                No issues have been raised against this vendor.
              </p>
            ) : (
              <div className="table-wrap">
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
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {vendor.issues.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <RefLink href={`/vendors/issues/${i.id}`}>{i.number}</RefLink>
                        </td>
                        <td className="text-2xs">{humanize(i.issueType)}</td>
                        <td>
                          <Badge
                            tone={
                              i.severity === "CRITICAL"
                                ? "danger"
                                : i.severity === "HIGH"
                                  ? "warning"
                                  : i.severity === "MEDIUM"
                                    ? "info"
                                    : "neutral"
                            }
                          >
                            {humanize(i.severity)}
                          </Badge>
                        </td>
                        <td className="max-w-[22rem] truncate text-xs" title={i.title}>
                          {i.title}
                        </td>
                        <td>
                          <StatusBadge status={i.status} />
                        </td>
                        <td className="text-xs">{i.raisedBy.name}</td>
                        <td className="text-xs">{fmtDate(i.raisedAt)}</td>
                        <td>
                          {canRaiseIssue && !["CLOSED"].includes(i.status) && (
                            <UpdateIssueForm issueId={i.id} number={i.number} currentStatus={i.status} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Investigations"
            description="Blacklisting is the outcome of an investigation, never a direct action. Each case carries the evidence, the vendor's reply and the audit review."
            bodyClassName="px-0 py-0"
          >
            {vendor.blacklistCases.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-muted">
                No investigations have been opened.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Case</th>
                      <th>Reason</th>
                      <th>Stage</th>
                      <th>Decision</th>
                      <th>Audit required</th>
                      <th>Raised</th>
                      <th>Closed</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {vendor.blacklistCases.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <RefLink href={`/vendors/blacklist/${c.id}`}>{c.number}</RefLink>
                        </td>
                        <td className="text-2xs">{humanize(c.reasonCode)}</td>
                        <td>
                          <StatusBadge status={c.stage} />
                        </td>
                        <td>{c.decision ? <Badge tone={c.decision === "BLACKLIST" ? "danger" : "info"}>{humanize(c.decision)}</Badge> : "—"}</td>
                        <td className="text-2xs">{c.auditRequired ? "Yes" : "No"}</td>
                        <td className="text-xs">{fmtDate(c.raisedAt)}</td>
                        <td className="text-xs">{c.closedAt ? fmtDate(c.closedAt) : "—"}</td>
                        <td>
                          {c.stage !== "CLOSED" && canRaiseIssue && (
                            <Link href={`/vendors/blacklist/${c.id}`} className="btn btn-secondary btn-xs">
                              Open
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>
      )}
    </div>
  );
}
