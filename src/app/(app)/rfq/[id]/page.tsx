import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
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
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { Timeline } from "@/components/ui/workflow";
import { documentTimeline } from "@/server/timeline";
import { DEFAULT_COMPARATIVE_CRITERIA } from "@/server/sourcing";
import { humanize, toneFor } from "@/lib/domain";
import { fmtDate, fmtDateTime, money, percent, qty, round2, toInputDate } from "@/lib/format";
import { QuoteEntry } from "./QuoteEntry";
import {
  AddVendorButton,
  CloseRfqButton,
  ComparativeBuilder,
  DeclineVendorButton,
  IssueRfqButton,
  NegotiationButton,
} from "./SourcingActions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rfq = await prisma.rfq.findUnique({ where: { id }, select: { number: true, title: true } });
  return { title: rfq ? `${rfq.number} — ${rfq.title}` : "RFQ" };
}

export default async function RfqDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.RFQ_VIEW);
  if (!authorized) return <AccessDenied title="RFQ" />;

  const rfq = await prisma.rfq.findUnique({
    where: { id },
    include: {
      pr: {
        include: {
          entity: { select: { code: true, name: true } },
          department: { select: { name: true } },
          requester: { select: { name: true } },
          project: { select: { name: true } },
          site: { select: { name: true } },
          items: { orderBy: { lineNo: "asc" } },
        },
      },
      createdBy: { select: { name: true } },
      vendors: {
        include: {
          vendor: {
            select: {
              id: true,
              code: true,
              name: true,
              status: true,
              city: true,
              paymentTerms: true,
              creditDays: true,
              performanceScore: true,
              onTimePercent: true,
              qualityPercent: true,
              statusReason: true,
            },
          },
        },
        orderBy: { invitedAt: "asc" },
      },
      quotes: {
        include: {
          vendor: { select: { id: true, name: true, code: true, paymentTerms: true, creditDays: true } },
          items: { orderBy: { lineNo: "asc" } },
          negotiations: { orderBy: { round: "asc" }, include: { negotiatedBy: { select: { name: true } } } },
        },
      },
      comparatives: { orderBy: { preparedAt: "desc" }, select: { id: true, number: true, status: true, savingsAmount: true } },
    },
  });
  if (!rfq) notFound();

  const [minQuotes, defaultTax, events, allVendors] = await Promise.all([
    getConfigNumber(CONFIG_KEYS.MIN_QUOTATIONS, rfq.pr.entityId),
    getConfigNumber(CONFIG_KEYS.DEFAULT_TAX_RATE, rfq.pr.entityId),
    documentTimeline("Rfq", rfq.id),
    prisma.vendor.findMany({
      where: { entityLinks: { some: { entityId: rfq.pr.entityId } } },
      select: { id: true, name: true, code: true, status: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const canEnterQuotes = userHasPermission(user, P.QUOTE_ENTER);
  const canIssue = userHasPermission(user, P.RFQ_ISSUE);
  const canCompare = userHasPermission(user, P.COMPARATIVE_CREATE);
  const canNegotiate = userHasPermission(user, P.NEGOTIATE);

  const outstanding = rfq.vendors.filter((v) => v.status === "INVITED");
  const quoted = rfq.quotes.length;
  const overdue = ["ISSUED", "RESPONSES_IN"].includes(rfq.status) && rfq.responseDeadline < new Date();
  const lowest = quoted ? Math.min(...rfq.quotes.map((q) => q.total)) : null;
  const compliantQuotes = rfq.quotes.filter((q) => q.technicalCompliance === "COMPLIANT");
  const comparative = rfq.comparatives[0];

  // A market-price hint derived from the requisition's own estimate.
  const suggestedMarket = rfq.pr.estimatedValue > 0 ? round2(rfq.pr.estimatedValue * 1.18) : null;

  const invitedWithoutQuote = rfq.vendors.filter((v) => !rfq.quotes.some((q) => q.vendorId === v.vendorId));
  const notYetInvited = allVendors.filter((v) => !rfq.vendors.some((rv) => rv.vendorId === v.id));

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Procurement", href: "/pr" },
          { label: "RFQs", href: "/rfq" },
          { label: rfq.number },
        ]}
      />

      <PageHeader
        eyebrow={`${rfq.pr.entity.code} · ${rfq.pr.department.name}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{rfq.number}</span>
            <span>{rfq.title}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={rfq.status} />
            </MetaItem>
            <MetaItem label="Requisition">
              <RefLink href={`/pr/${rfq.pr.id}`}>{rfq.pr.number}</RefLink>
            </MetaItem>
            <MetaItem label="Deadline">
              <span className={overdue ? "text-[var(--c-danger)]" : undefined}>{fmtDate(rfq.responseDeadline)}</span>
            </MetaItem>
            <MetaItem label="Raised by">{rfq.createdBy.name}</MetaItem>
            <MetaItem label="Issued">{rfq.issuedAt ? fmtDateTime(rfq.issuedAt) : "Not yet issued"}</MetaItem>
          </>
        }
        actions={
          <>
            {canIssue && rfq.status === "DRAFT" && (
              <IssueRfqButton rfqId={rfq.id} vendorCount={rfq.vendors.length} />
            )}
            {canIssue && ["ISSUED", "RESPONSES_IN"].includes(rfq.status) && (
              <>
                <AddVendorButton rfqId={rfq.id} vendors={notYetInvited} />
                <CloseRfqButton rfqId={rfq.id} outstanding={outstanding.length} />
              </>
            )}
            {canCompare && quoted > 0 && (
              <ComparativeBuilder
                rfqId={rfq.id}
                quoteCount={quoted}
                minQuotes={minQuotes}
                suggestedMarketPrice={suggestedMarket}
                criteria={DEFAULT_COMPARATIVE_CRITERIA}
              />
            )}
            {comparative && (
              <Link href={`/comparatives/${comparative.id}`} className="btn btn-secondary btn-sm">
                Open {comparative.number}
              </Link>
            )}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Vendors invited" value={rfq.vendors.length} />
        <StatTile
          label="Quotations received"
          value={quoted}
          hint={`Policy minimum ${minQuotes}`}
          tone={quoted < minQuotes ? "danger" : "success"}
        />
        <StatTile
          label="Technically compliant"
          value={compliantQuotes.length}
          hint={quoted ? `of ${quoted} received` : "None received"}
          tone={compliantQuotes.length === 0 && quoted > 0 ? "warning" : "default"}
        />
        <StatTile label="Lowest quotation" value={lowest !== null ? money(lowest) : "—"} />
        <StatTile
          label="Outstanding responses"
          value={outstanding.length}
          tone={overdue && outstanding.length ? "danger" : outstanding.length ? "warning" : "default"}
          hint={overdue ? "Deadline has passed" : undefined}
        />
      </div>

      {quoted < minQuotes && ["RESPONSES_IN", "CLOSED"].includes(rfq.status) && (
        <InlineAlert tone="warning">
          Only {quoted} of the {minQuotes} quotations required by procurement policy have been recorded. Building a
          comparative at this level raises a tracked insufficient-quotations exception unless the case value is below the
          configured waiver.
        </InlineAlert>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <SectionCard title="Requirement" description={rfq.pr.title}>
          <DefList
            columns={2}
            items={[
              { label: "Requisition", value: <RefLink href={`/pr/${rfq.pr.id}`}>{rfq.pr.number}</RefLink> },
              { label: "Requester", value: rfq.pr.requester.name },
              { label: "Estimated value", value: money(rfq.pr.estimatedValue) },
              { label: "Required by", value: fmtDate(rfq.pr.requiredDate) },
              { label: "Project", value: rfq.pr.project?.name ?? "—" },
              { label: "Site", value: rfq.pr.site?.name ?? "—" },
              { label: "Scope", value: rfq.scope ?? "—", span: true },
              { label: "Delivery requirement", value: rfq.deliveryRequirement ?? "—", span: true },
              { label: "Commercial terms", value: rfq.terms ?? "—", span: true },
            ]}
          />
        </SectionCard>

        <SectionCard title="Lines requested" bodyClassName="px-0 py-0">
          <div className="table-wrap max-h-[18rem] overflow-y-auto">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: "2.5rem" }}>#</th>
                  <th>Item</th>
                  <th className="text-right">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {rfq.pr.items.map((i) => (
                  <tr key={i.id}>
                    <td className="tnum text-[var(--c-text-tertiary)]">{i.lineNo}</td>
                    <td>
                      <div className="text-xs">{i.description}</div>
                      {i.specification && (
                        <div className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">{i.specification}</div>
                      )}
                    </td>
                    <td className="num text-xs">{qty(i.quantity, i.unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Invited vendors"
        description="Response status, channel and the performance record behind each vendor"
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ minWidth: "14rem" }}>Vendor</th>
                <th style={{ width: "8rem" }}>Response</th>
                <th style={{ width: "7rem" }}>Channel</th>
                <th style={{ width: "9rem" }}>Invited</th>
                <th className="text-right" style={{ width: "7rem" }}>Score</th>
                <th className="text-right" style={{ width: "7rem" }}>On-time</th>
                <th className="text-right" style={{ width: "10rem" }}>Quoted total</th>
                <th style={{ width: "9rem" }}>Compliance</th>
                <th style={{ minWidth: "13rem" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rfq.vendors.map((rv) => {
                const quote = rfq.quotes.find((q) => q.vendorId === rv.vendorId);
                const neg = quote?.negotiations.at(-1);
                const net = quote ? (neg ? (neg.finalTotal ?? neg.negotiatedTotal) : quote.total) : null;
                return (
                  <tr key={rv.id}>
                    <td>
                      <Link href={`/vendors/${rv.vendor.id}`} className="font-500 hover:text-[var(--c-accent-text)]">
                        {rv.vendor.name}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <Mono>{rv.vendor.code}</Mono>
                        <Badge tone={toneFor(rv.vendor.status)}>{humanize(rv.vendor.status)}</Badge>
                        {rv.vendor.city && (
                          <span className="text-2xs text-[var(--c-text-tertiary)]">{rv.vendor.city}</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={rv.status} />
                    </td>
                    <td className="text-2xs">{humanize(rv.channel)}</td>
                    <td className="text-2xs">{fmtDate(rv.invitedAt)}</td>
                    <td className="num text-2xs">
                      {rv.vendor.performanceScore !== null ? percent(rv.vendor.performanceScore, 0) : "—"}
                    </td>
                    <td className="num text-2xs">
                      {rv.vendor.onTimePercent !== null ? percent(rv.vendor.onTimePercent, 0) : "—"}
                    </td>
                    <td className="num">
                      {net !== null ? (
                        <span className="font-500">
                          {money(net)}
                          {neg && (
                            <span className="block text-2xs text-[var(--c-success)]">
                              from {money(quote!.total)}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-2xs text-[var(--c-text-tertiary)]">Not quoted</span>
                      )}
                    </td>
                    <td>
                      {quote ? (
                        <Badge
                          tone={
                            quote.technicalCompliance === "COMPLIANT"
                              ? "success"
                              : quote.technicalCompliance === "PARTIAL"
                                ? "warning"
                                : quote.technicalCompliance === "NON_COMPLIANT"
                                  ? "danger"
                                  : "neutral"
                          }
                        >
                          {humanize(quote.technicalCompliance)}
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {canEnterQuotes && !["CANCELLED", "AWARDED"].includes(rfq.status) && (
                          <QuoteEntry
                            rfqId={rfq.id}
                            vendor={{
                              id: rv.vendor.id,
                              name: rv.vendor.name,
                              code: rv.vendor.code,
                              paymentTerms: rv.vendor.paymentTerms,
                              creditDays: rv.vendor.creditDays,
                            }}
                            prLines={rfq.pr.items.map((i) => ({
                              id: i.id,
                              itemId: i.itemId,
                              lineNo: i.lineNo,
                              description: i.description,
                              brand: i.brand,
                              model: i.model,
                              specification: i.specification,
                              quantity: i.quantity,
                              unit: i.unit,
                              estimatedUnitPrice: i.estimatedUnitPrice,
                            }))}
                            defaultTaxRate={defaultTax}
                            triggerLabel={quote ? "Edit quote" : "Enter quote"}
                            triggerTone={quote ? "secondary" : "primary"}
                            existing={
                              quote
                                ? {
                                    quoteRef: quote.quoteRef,
                                    quoteDate: toInputDate(quote.quoteDate),
                                    validUntil: toInputDate(quote.validUntil),
                                    deliveryCharges: quote.deliveryCharges,
                                    otherCharges: quote.otherCharges,
                                    discount: quote.discount,
                                    taxRegistered: quote.taxRegistered,
                                    deliveryDays: quote.deliveryDays,
                                    paymentTerms: quote.paymentTerms,
                                    creditDays: quote.creditDays,
                                    warrantyMonths: quote.warrantyMonths,
                                    warrantyTerms: quote.warrantyTerms,
                                    technicalCompliance: quote.technicalCompliance,
                                    complianceNotes: quote.complianceNotes,
                                    exceptions: quote.exceptions,
                                    notes: quote.notes,
                                    channel: quote.channel,
                                    lines: quote.items.map((li) => ({
                                      key: li.id,
                                      prItemId: li.prItemId,
                                      itemId: li.itemId,
                                      description: li.description,
                                      brand: li.brand ?? "",
                                      model: li.model ?? "",
                                      specification: li.specification ?? "",
                                      quantity: String(li.quantity),
                                      unit: li.unit,
                                      unitPrice: String(li.unitPrice),
                                      taxRate: String(li.taxRate),
                                      deliveryDays: li.deliveryDays ? String(li.deliveryDays) : "",
                                      compliance: li.compliance,
                                      notes: li.notes ?? "",
                                    })),
                                  }
                                : undefined
                            }
                          />
                        )}
                        {canNegotiate && quote && (
                          <NegotiationButton
                            quoteId={quote.id}
                            vendorName={rv.vendor.name}
                            currentTotal={net ?? quote.total}
                            round={(quote.negotiations.at(-1)?.round ?? 0) + 1}
                          />
                        )}
                        {canEnterQuotes && !quote && rv.status === "INVITED" && (
                          <DeclineVendorButton rfqId={rfq.id} vendorId={rv.vendor.id} vendorName={rv.vendor.name} />
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {invitedWithoutQuote.length > 0 && (
          <div className="border-t border-separator px-4 py-2.5">
            <Meter
              value={quoted}
              max={rfq.vendors.length}
              label={`${quoted} of ${rfq.vendors.length} invited vendors have quoted`}
              tone={quoted >= minQuotes ? "success" : "warning"}
            />
          </div>
        )}
      </SectionCard>

      {rfq.quotes.some((q) => q.negotiations.length > 0) && (
        <SectionCard title="Negotiation record" bodyClassName="px-0 py-0">
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th className="text-right">Round</th>
                  <th className="text-right">Opening</th>
                  <th className="text-right">Negotiated</th>
                  <th className="text-right">Conceded</th>
                  <th className="text-right">%</th>
                  <th>Channel</th>
                  <th>Outcome</th>
                  <th>By</th>
                  <th style={{ minWidth: "18rem" }}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {rfq.quotes.flatMap((q) =>
                  q.negotiations.map((n) => (
                    <tr key={n.id}>
                      <td className="text-xs">{q.vendor.name}</td>
                      <td className="num">{n.round}</td>
                      <td className="num">{money(n.originalTotal)}</td>
                      <td className="num font-500">{money(n.negotiatedTotal)}</td>
                      <td className="num font-500 text-[var(--c-success)]">{money(n.savings)}</td>
                      <td className="num">{percent(n.savingsPercent)}</td>
                      <td className="text-2xs">{humanize(n.channel)}</td>
                      <td>
                        <StatusBadge status={n.outcome} />
                      </td>
                      <td className="text-2xs">{n.negotiatedBy.name}</td>
                      <td className="text-2xs leading-4 text-muted">{n.notes ?? "—"}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {rfq.comparatives.length > 0 && (
        <SectionCard title="Comparatives" bodyClassName="px-0 py-0">
          <ul className="divide-y divide-[var(--c-border-subtle)]">
            {rfq.comparatives.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="flex items-center gap-2">
                  <RefLink href={`/comparatives/${c.id}`}>{c.number}</RefLink>
                  <StatusBadge status={c.status} />
                </span>
                {c.savingsAmount > 0 && (
                  <span className="tnum text-xs font-500 text-[var(--c-success)]">{money(c.savingsAmount)} saving</span>
                )}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <DocumentsPanel
          user={user}
          linkedType="RFQ"
          linkedId={rfq.id}
          entityId={rfq.pr.entityId}
          title="RFQ documents"
          description="The RFQ pack sent to vendors and the quotations received."
          defaultCategory="RFQ"
        />
        <SectionCard title="Activity" description="Audit-derived history for this RFQ">
          <Timeline events={events} emptyLabel="No activity recorded yet." />
        </SectionCard>
      </div>

      {rfq.quotes.length === 0 && (
        <Card>
          <EmptyState
            title="No quotations yet"
            description={
              canEnterQuotes
                ? "Record each quotation as it arrives — by email, WhatsApp, physically or in person. The channel is captured so the sourcing record is complete."
                : "Quotations will appear here as procurement records them."
            }
          />
        </Card>
      )}
    </div>
  );
}
