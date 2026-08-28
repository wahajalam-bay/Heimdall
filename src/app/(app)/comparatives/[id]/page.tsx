import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { CONFIG_KEYS, getConfigBool, getConfigNumber } from "@/lib/config";
import { cpcRequirement } from "@/server/cpc";
import { comparativeReadiness } from "@/server/sourcing";
import { poReadiness } from "@/server/po";
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
import { ChartFrame, ChartTable, RankedBars } from "@/components/ui/charts";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { humanize } from "@/lib/domain";
import { fmtDate, fmtDateTime, money, percent, round2, variancePercent } from "@/lib/format";
import { RaiseCpcButton, RecommendForm } from "./RecommendForm";
import { tableLink } from "@/lib/links";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await prisma.comparative.findUnique({ where: { id }, select: { number: true } });
  return { title: c ? `${c.number} — Comparative` : "Comparative" };
}

export default async function ComparativeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.COMPARATIVE_VIEW);
  if (!authorized) return <AccessDenied title="Comparative" />;

  const c = await prisma.comparative.findUnique({
    where: { id },
    include: {
      pr: {
        include: {
          entity: { select: { code: true, name: true } },
          department: { select: { name: true } },
          requester: { select: { name: true } },
          items: { orderBy: { lineNo: "asc" } },
          cpcCases: { orderBy: { createdAt: "desc" } },
          purchaseOrders: { select: { id: true, number: true, status: true } },
        },
      },
      rfq: { select: { id: true, number: true, status: true, quotes: { select: { id: true } } } },
      lines: {
        orderBy: { netTotal: "asc" },
        include: {
          vendor: {
            select: {
              id: true,
              name: true,
              code: true,
              status: true,
              businessType: true,
              taxStatus: true,
              totalOrders: true,
              totalSpend: true,
              rejectionPercent: true,
            },
          },
          quote: {
            select: {
              id: true,
              number: true,
              quoteRef: true,
              channel: true,
              validUntil: true,
              complianceNotes: true,
              exceptions: true,
              negotiations: { orderBy: { round: "asc" } },
            },
          },
        },
      },
    },
  });
  if (!c) notFound();

  const [readiness, cpcInfo, requireJustification, poReady] = await Promise.all([
    comparativeReadiness(c.id),
    cpcRequirement(c.pr.entityId, c.selectedTotal ?? c.lowestTotal ?? c.pr.estimatedValue, c.pr.procurementType),
    getConfigBool(CONFIG_KEYS.NON_LOWEST_REQUIRES_JUSTIFICATION, c.pr.entityId),
    poReadiness(c.prId).catch(() => ({ ready: false, issues: [] as string[], cpcRequired: false, cpcCleared: true })),
  ]);

  const canRecommend = userHasPermission(user, P.VENDOR_SELECT);
  const canCreatePo = userHasPermission(user, P.PO_CREATE);
  const selected = c.lines.find((l) => l.isSelected);
  const lowest = c.lines.find((l) => l.isLowest);
  const lowestCompliant = c.lines.find((l) => l.isLowestCompliant);
  const openCpc = c.pr.cpcCases.find((k) =>
    ["PENDING", "SCHEDULED", "UNDER_REVIEW", "CLARIFICATION", "DEFERRED"].includes(k.status),
  );
  const approvedCpc = c.pr.cpcCases.find((k) => k.status === "APPROVED");
  const po = c.pr.purchaseOrders[0];

  const criteria = (() => {
    try {
      return JSON.parse(c.evaluationCriteria) as Array<{ key: string; label: string; weight: number }>;
    } catch {
      return [] as Array<{ key: string; label: string; weight: number }>;
    }
  })();

  const taxVsNonTax = {
    taxed: c.lines.filter((l) => l.taxAmount > 0),
    untaxed: c.lines.filter((l) => l.taxAmount === 0),
  };

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Procurement", href: "/pr" },
          { label: "Comparatives", href: "/comparatives" },
          { label: c.number },
        ]}
      />

      <PageHeader
        eyebrow={`${c.pr.entity.code} · ${c.pr.department.name}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{c.number}</span>
            <span>{c.pr.title}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={c.status} />
            </MetaItem>
            <MetaItem label="Requisition">
              <RefLink href={`/pr/${c.pr.id}`}>{c.pr.number}</RefLink>
            </MetaItem>
            <MetaItem label="RFQ">
              <RefLink href={`/rfq/${c.rfq.id}`}>{c.rfq.number}</RefLink>
            </MetaItem>
            <MetaItem label="Prepared">{fmtDateTime(c.preparedAt)}</MetaItem>
            <MetaItem label="Vendors compared">{c.lines.length}</MetaItem>
          </>
        }
        actions={
          <>
            <Link href={`/comparatives/${c.id}/cost-analysis`} className="btn btn-secondary btn-sm">
              Cost Analysis Form
            </Link>
            {canRecommend && !["APPROVED", "SUPERSEDED", "REJECTED"].includes(c.status) && (
              <RecommendForm
                comparativeId={c.id}
                requireJustification={requireJustification}
                lines={c.lines.map((l) => ({
                  quoteId: l.quoteId,
                  vendorId: l.vendorId,
                  vendorName: l.vendor.name,
                  netTotal: l.netTotal,
                  technicalCompliance: l.technicalCompliance,
                  deliveryDays: l.deliveryDays,
                  warrantyMonths: l.warrantyMonths,
                  paymentTerms: l.paymentTerms,
                  vendorScore: l.vendorScore,
                  onTimePercent: l.vendorOnTimePercent,
                  scoreTotal: l.scoreTotal,
                  isLowest: l.isLowest,
                  isLowestCompliant: l.isLowestCompliant,
                  isSelected: l.isSelected,
                }))}
              />
            )}
            {selected && cpcInfo.required && !openCpc && !approvedCpc && userHasPermission(user, P.CPC_VIEW) && (
              <RaiseCpcButton
                comparativeId={c.id}
                amount={selected.netTotal}
                threshold={cpcInfo.threshold}
                suggestedRecommendation={`Award to ${selected.vendor.name} at ${money(selected.netTotal)}. ${c.recommendationBasis ?? ""}`.trim()}
                suggestedRisk={c.nonLowestJustification ?? ""}
              />
            )}
            {openCpc && (
              <Link href={`/cpc/cases/${openCpc.id}`} className="btn btn-secondary btn-sm">
                CPC {openCpc.number}
              </Link>
            )}
            {selected && poReady.ready && canCreatePo && !po && (
              <Link href={`/po/new?prId=${c.prId}`} className="btn btn-primary btn-sm">
                Create purchase order
              </Link>
            )}
            {po && (
              <Link href={`/po/${po.id}`} className="btn btn-secondary btn-sm">
                {po.number}
              </Link>
            )}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="Previous purchase price"
          value={c.previousPrice ? money(c.previousPrice, "PKR", { compact: true }) : "No history"}
          hint="Most recent actual paid price for this basket"
        />
        <StatTile
          label="Market price"
          value={c.marketPrice ? money(c.marketPrice, "PKR", { compact: true }) : "Not captured"}
          hint="Prevailing rate at the time of sourcing"
        />
        <StatTile
          label="Lowest quotation"
          value={lowest ? money(lowest.netTotal, "PKR", { compact: true }) : "—"}
          hint={lowest ? lowest.vendor.name : undefined}
        />
        <StatTile
          label="Lowest compliant"
          value={lowestCompliant ? money(lowestCompliant.netTotal, "PKR", { compact: true }) : "None compliant"}
          hint={lowestCompliant ? lowestCompliant.vendor.name : "No fully compliant quotation"}
          tone={lowestCompliant ? "success" : "warning"}
        />
        <StatTile
          label="Savings identified"
          value={c.savingsAmount > 0 ? money(c.savingsAmount, "PKR", { compact: true }) : "—"}
          hint={c.savingsAmount > 0 ? `${percent(c.savingsPercent)} against baseline` : "Recorded on award"}
          tone={c.savingsAmount > 0 ? "success" : "default"}
        />
      </div>

      {readiness.issues.length > 0 && (
        <BlockedNotice title="This comparative is not ready to advance" reasons={readiness.issues} />
      )}

      {c.nonLowestJustification && (
        <InlineAlert tone="warning">
          <span className="font-600">Awarded above the lowest compliant quotation. </span>
          {c.nonLowestJustification}
        </InlineAlert>
      )}

      {cpcInfo.required && !approvedCpc && (
        <InlineAlert tone="info">
          <span className="font-600">Committee review applies. </span>
          {cpcInfo.reason} A purchase order cannot be raised until the Central Procurement Committee approves the case.
        </InlineAlert>
      )}

      {/* The comparative table itself */}
      <SectionCard
        title="Cost comparative"
        description="Every quotation side by side, with negotiated outcomes, baselines, variance, vendor performance and the weighted evaluation score."
        actions={
          criteria.length > 0 && (
            <span className="text-2xs text-[var(--c-text-tertiary)]">
              Weighting: {criteria.map((cr) => `${cr.label} ${cr.weight}%`).join(" · ")}
            </span>
          )
        }
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ minWidth: "14rem" }}>Vendor</th>
                <th className="text-right">Avg unit price</th>
                <th className="text-right">Subtotal</th>
                <th className="text-right">Tax</th>
                <th className="text-right">Delivery</th>
                <th className="text-right">Quoted total</th>
                <th className="text-right">Negotiated</th>
                <th className="text-right">Net total</th>
                <th className="text-right">vs previous</th>
                <th className="text-right">vs market</th>
                <th className="text-right">Lead</th>
                <th>Payment terms</th>
                <th className="text-right">Warranty</th>
                <th>Compliance</th>
                <th className="text-right">Vendor score</th>
                <th className="text-right">On-time</th>
                <th className="text-right">Rejections</th>
                <th className="text-right">Weighted score</th>
                <th className="text-right">Rank</th>
                <th style={{ minWidth: "12rem" }}>Flags</th>
              </tr>
            </thead>
            <tbody>
              {c.lines.map((l) => {
                const vsPrev = variancePercent(l.netTotal, c.previousPrice);
                const vsMarket = variancePercent(l.netTotal, c.marketPrice);
                const neg = l.quote.negotiations.at(-1);
                return (
                  <tr
                    key={l.id}
                    style={
                      l.isSelected
                        ? { background: "var(--c-accent-soft)", boxShadow: "inset 3px 0 0 0 var(--c-accent)" }
                        : undefined
                    }
                  >
                    <td>
                      <Link href={`/vendors/${l.vendor.id}`} className="font-500 hover:text-[var(--c-accent-text)]">
                        {l.vendor.name}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <Mono>{l.quote.number}</Mono>
                        <Badge tone="neutral">{humanize(l.vendor.businessType)}</Badge>
                        {l.vendor.taxStatus === "NON_FILER" && <Badge tone="warning">Non-filer</Badge>}
                      </div>
                      <div className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">
                        via {humanize(l.quote.channel)}
                        {l.quote.validUntil ? ` · valid to ${fmtDate(l.quote.validUntil)}` : ""}
                      </div>
                    </td>
                    <td className="num">{money(l.unitPriceAvg)}</td>
                    <td className="num">{money(l.subtotal)}</td>
                    <td className="num">
                      {l.taxAmount > 0 ? money(l.taxAmount) : <span className="text-[var(--c-warning)]">No tax</span>}
                    </td>
                    <td className="num">{money(l.deliveryCharges)}</td>
                    <td className="num">{money(l.total)}</td>
                    <td className="num">
                      {neg ? (
                        <span className="text-[var(--c-success)]">
                          {money(neg.finalTotal ?? neg.negotiatedTotal)}
                          <span className="block text-2xs">R{neg.round}</span>
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="num text-[0.875rem] font-600">{money(l.netTotal)}</td>
                    <td className="num">
                      {vsPrev !== null ? (
                        <span className={vsPrev > 0 ? "text-[var(--c-danger)]" : "text-[var(--c-success)]"}>
                          {vsPrev > 0 ? "+" : ""}
                          {percent(vsPrev)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="num">
                      {vsMarket !== null ? (
                        <span className={vsMarket > 0 ? "text-[var(--c-danger)]" : "text-[var(--c-success)]"}>
                          {vsMarket > 0 ? "+" : ""}
                          {percent(vsMarket)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="num">{l.deliveryDays ? `${l.deliveryDays}d` : "—"}</td>
                    <td className="text-2xs">{l.paymentTerms ?? "—"}</td>
                    <td className="num">{l.warrantyMonths ? `${l.warrantyMonths}m` : "—"}</td>
                    <td>
                      <Badge
                        tone={
                          l.technicalCompliance === "COMPLIANT"
                            ? "success"
                            : l.technicalCompliance === "PARTIAL"
                              ? "warning"
                              : l.technicalCompliance === "NON_COMPLIANT"
                                ? "danger"
                                : "neutral"
                        }
                      >
                        {humanize(l.technicalCompliance)}
                      </Badge>
                    </td>
                    <td className="num text-2xs">{l.vendorScore !== null ? percent(l.vendorScore, 0) : "—"}</td>
                    <td className="num text-2xs">
                      {l.vendorOnTimePercent !== null ? percent(l.vendorOnTimePercent, 0) : "—"}
                    </td>
                    <td className="num text-2xs">
                      {l.vendor.rejectionPercent !== null ? percent(l.vendor.rejectionPercent, 0) : "—"}
                    </td>
                    <td className="num font-500">{l.scoreTotal !== null ? l.scoreTotal.toFixed(1) : "—"}</td>
                    <td className="num">{l.rank ?? "—"}</td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        {l.isSelected && <Badge tone="accent">Awarded</Badge>}
                        {l.isLowest && <Badge tone="info">Lowest</Badge>}
                        {l.isLowestCompliant && <Badge tone="success">Lowest compliant</Badge>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <ChartFrame
          title="Net total by vendor"
          subtitle="After negotiation, lowest first"
          tableView={
            <ChartTable
              columns={["Vendor", "Net total", "Compliance"]}
              rows={c.lines.map((l) => [l.vendor.name, money(l.netTotal), humanize(l.technicalCompliance)])}
            />
          }
          footnote="The lowest bar is not necessarily the award — compliance, delivery and vendor performance are weighed alongside price."
        >
          <RankedBars
            data={c.lines.map((l) => ({
              href: `/vendors/${l.vendor.id}`,
              label: `${l.vendor.name}${l.isSelected ? " (awarded)" : ""}`,
              value: l.netTotal,
              sub: humanize(l.technicalCompliance).slice(0, 9),
            }))}
            format="moneyCompact"
            maxRows={10}
          />
        </ChartFrame>

        <div className="space-y-4">
          <SectionCard title="Award decision">
            {selected ? (
              <DefList
                columns={1}
                items={[
                  {
                    label: "Awarded vendor",
                    value: (
                      <span className="flex flex-wrap items-center gap-2">
                        <RefLink href={`/vendors/${selected.vendor.id}`}>{selected.vendor.name}</RefLink>
                        <StatusBadge status={selected.vendor.status} />
                      </span>
                    ),
                  },
                  { label: "Awarded value", value: <span className="font-600">{money(selected.netTotal)}</span> },
                  {
                    label: "Position",
                    value: selected.isLowestCompliant
                      ? "Lowest compliant quotation"
                      : selected.isLowest
                        ? "Lowest quotation"
                        : `${money(round2(selected.netTotal - (lowestCompliant?.netTotal ?? selected.netTotal)))} above the lowest compliant`,
                  },
                  { label: "Basis", value: c.recommendationBasis ?? "—", span: true },
                  ...(c.nonLowestJustification
                    ? [{ label: "Non-lowest justification", value: c.nonLowestJustification, span: true }]
                    : []),
                ]}
              />
            ) : (
              <p className="py-3 text-xs text-muted">
                No vendor has been recommended yet. Selection is deliberate — the system never auto-awards to the lowest
                price.
              </p>
            )}
          </SectionCard>

          <SectionCard title="Tax treatment" description="Comparing tax-registered against non-tax offers on a like-for-like basis">
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-muted">Tax-registered quotations</span>
                <span className="tnum font-500">{taxVsNonTax.taxed.length}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-muted">Non-tax quotations</span>
                <span className="tnum font-500">{taxVsNonTax.untaxed.length}</span>
              </div>
              {taxVsNonTax.untaxed.length > 0 && (
                <p className="mt-1 rounded-2xl alert-warning px-2.5 py-1.5 text-2xs leading-4 text-[var(--c-warning)]">
                  {taxVsNonTax.untaxed.map((l) => l.vendor.name).join(", ")} quoted without sales tax. A non-tax
                  quotation is not directly comparable — input tax cannot be claimed and no tax invoice will be issued for
                  reconciliation.
                </p>
              )}
            </div>
          </SectionCard>

          {c.notes && (
            <SectionCard title="Preparer's notes">
              <p className="text-xs leading-5 text-muted">{c.notes}</p>
            </SectionCard>
          )}
        </div>
      </div>

      {c.lines.some((l) => l.quote.complianceNotes || l.quote.exceptions) && (
        <SectionCard title="Stated deviations and exceptions" bodyClassName="px-0 py-0">
          <ul className="row-list">
            {c.lines
              .filter((l) => l.quote.complianceNotes || l.quote.exceptions)
              .map((l) => (
                <li key={l.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[0.8125rem] font-500">{l.vendor.name}</span>
                    <Badge
                      tone={
                        l.technicalCompliance === "COMPLIANT"
                          ? "success"
                          : l.technicalCompliance === "PARTIAL"
                            ? "warning"
                            : "danger"
                      }
                    >
                      {humanize(l.technicalCompliance)}
                    </Badge>
                  </div>
                  {l.quote.complianceNotes && (
                    <p className="mt-1 text-xs leading-5 text-muted">{l.quote.complianceNotes}</p>
                  )}
                  {l.quote.exceptions && (
                    <p className="mt-1 text-xs leading-5 text-[var(--c-warning)]">{l.quote.exceptions}</p>
                  )}
                </li>
              ))}
          </ul>
        </SectionCard>
      )}

      <DocumentsPanel
        user={user}
        linkedType="COMPARATIVE"
        linkedId={c.id}
        entityId={c.pr.entityId}
        title="Comparative documents"
        description="The comparative statement, negotiation records and any supporting analysis."
        defaultCategory="Comparative"
      />
    </div>
  );
}
