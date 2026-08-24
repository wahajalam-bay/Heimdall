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
  DefList,
  InlineAlert,
  MetaItem,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatusBadge,
} from "@/components/ui/primitives";
import { Timeline } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { SEVERITY_TONE, humanize } from "@/lib/domain";
import { ageDays, fmtDate, fmtDateTime, money } from "@/lib/format";
import { OpenInvestigationForm, UpdateIssueForm } from "../../VendorStageForms";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const i = await prisma.vendorIssue.findUnique({ where: { id }, select: { number: true } });
  return { title: i ? `${i.number} — Vendor issue` : "Vendor issue" };
}

export default async function VendorIssueDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.VENDOR_VIEW);
  if (!authorized) return <AccessDenied title="Vendor issue" />;

  const issue = await prisma.vendorIssue.findUnique({
    where: { id },
    include: {
      vendor: {
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
          performanceScore: true,
          entityLinks: { select: { entityId: true } },
        },
      },
      raisedBy: { select: { name: true, title: true } },
    },
  });
  if (!issue) notFound();

  const [events, po, grn, invoice, otherIssues, openCase] = await Promise.all([
    documentTimeline("VendorIssue", issue.id),
    issue.relatedPoId
      ? prisma.purchaseOrder.findUnique({
          where: { id: issue.relatedPoId },
          select: { id: true, number: true, total: true, status: true },
        })
      : Promise.resolve(null),
    issue.relatedGrnId
      ? prisma.grn.findUnique({
          where: { id: issue.relatedGrnId },
          select: { id: true, number: true, totalValue: true, status: true },
        })
      : Promise.resolve(null),
    issue.relatedInvoiceId
      ? prisma.invoice.findUnique({
          where: { id: issue.relatedInvoiceId },
          select: { id: true, number: true, vendorInvoiceNumber: true, total: true, matchStatus: true },
        })
      : Promise.resolve(null),
    prisma.vendorIssue.findMany({
      where: { vendorId: issue.vendorId, id: { not: issue.id } },
      orderBy: { raisedAt: "desc" },
      take: 10,
      select: { id: true, number: true, issueType: true, severity: true, status: true, raisedAt: true, title: true },
    }),
    prisma.vendorBlacklistCase.findFirst({
      where: { vendorId: issue.vendorId, stage: { not: "CLOSED" } },
      select: { id: true, number: true, stage: true },
    }),
  ]);

  const canUpdate = userHasPermission(user, P.VENDOR_ISSUE_RAISE, P.VENDOR_BLACKLIST);
  const isOpen = !["RESOLVED", "CLOSED"].includes(issue.status);
  const age = ageDays(issue.raisedAt) ?? 0;

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Vendors", href: "/vendors" },
          { label: "Issues", href: "/vendors/issues" },
          { label: issue.number },
        ]}
      />

      <PageHeader
        eyebrow={`${issue.vendor.code} · ${issue.vendor.name}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{issue.number}</span>
            <span>{issue.title}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={issue.status} />
            </MetaItem>
            <MetaItem label="Severity">
              <Badge tone={SEVERITY_TONE[issue.severity] ?? "neutral"}>{humanize(issue.severity)}</Badge>
            </MetaItem>
            <MetaItem label="Type">{humanize(issue.issueType)}</MetaItem>
            <MetaItem label="Raised">{fmtDate(issue.raisedAt)}</MetaItem>
            <MetaItem label="Raised by">{issue.raisedBy.name}</MetaItem>
            {isOpen && <MetaItem label="Open for">{age} days</MetaItem>}
          </>
        }
        actions={
          <>
            {canUpdate && issue.status !== "CLOSED" && (
              <UpdateIssueForm issueId={issue.id} number={issue.number} currentStatus={issue.status} />
            )}
            {canUpdate && !openCase && ["HIGH", "CRITICAL"].includes(issue.severity) && (
              <OpenInvestigationForm
                vendorId={issue.vendor.id}
                vendorName={issue.vendor.name}
                openIssues={otherIssues.filter((i) => !["RESOLVED", "CLOSED"].includes(i.status)).length + 1}
              />
            )}
            <Link href={`/vendors/${issue.vendor.id}?tab=issues`} className="btn btn-secondary btn-sm">
              Vendor record
            </Link>
          </>
        }
      />

      {openCase && (
        <InlineAlert tone="warning">
          Investigation {openCase.number} is open against this vendor at the {humanize(openCase.stage).toLowerCase()}{" "}
          stage.{" "}
          <Link href={`/vendors/blacklist/${openCase.id}`} className="underline">
            Open the case
          </Link>
          .
        </InlineAlert>
      )}

      {isOpen && age > 14 && (
        <InlineAlert tone="warning">
          This issue has been open for {age} days without resolution. Unresolved issues keep dragging the vendor&apos;s
          performance score down and are exactly what an investigation would rely on.
        </InlineAlert>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-4">
          <SectionCard title="What happened">
            <p className="whitespace-pre-wrap text-[0.8125rem] leading-6">{issue.description}</p>
          </SectionCard>

          {issue.vendorResponse && (
            <SectionCard title="Vendor response" description="Recorded as given by the vendor.">
              <p className="whitespace-pre-wrap text-[0.8125rem] leading-6">{issue.vendorResponse}</p>
            </SectionCard>
          )}

          {issue.resolution && (
            <SectionCard title="Resolution">
              <p className="whitespace-pre-wrap text-[0.8125rem] leading-6">{issue.resolution}</p>
              {issue.resolvedAt && (
                <p className="mt-2 text-2xs text-[var(--c-text-tertiary)]">Resolved {fmtDateTime(issue.resolvedAt)}</p>
              )}
            </SectionCard>
          )}

          {otherIssues.length > 0 && (
            <SectionCard
              title="Other issues against this vendor"
              description="A pattern matters more than a single incident."
              bodyClassName="px-0 py-0"
            >
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Issue</th>
                      <th>Type</th>
                      <th>Severity</th>
                      <th>Title</th>
                      <th>Status</th>
                      <th>Raised</th>
                    </tr>
                  </thead>
                  <tbody>
                    {otherIssues.map((i) => (
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
                        <td className="text-xs">{fmtDate(i.raisedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}
        </div>

        <div className="space-y-4">
          <SectionCard title="Issue record">
            <DefList
              columns={1}
              items={[
                { label: "Issue number", value: <Mono>{issue.number}</Mono> },
                {
                  label: "Vendor",
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      <RefLink href={`/vendors/${issue.vendor.id}`}>{issue.vendor.name}</RefLink>
                      <StatusBadge status={issue.vendor.status} />
                    </span>
                  ),
                },
                {
                  label: "Vendor performance score",
                  value: issue.vendor.performanceScore !== null ? issue.vendor.performanceScore.toFixed(1) : "Not computed",
                },
                { label: "Type", value: humanize(issue.issueType) },
                {
                  label: "Severity",
                  value: <Badge tone={SEVERITY_TONE[issue.severity] ?? "neutral"}>{humanize(issue.severity)}</Badge>,
                },
                {
                  label: "Raised by",
                  value: `${issue.raisedBy.name}${issue.raisedBy.title ? ` — ${issue.raisedBy.title}` : ""}`,
                },
                { label: "Raised at", value: fmtDateTime(issue.raisedAt) },
                { label: "Resolved at", value: issue.resolvedAt ? fmtDateTime(issue.resolvedAt) : "Not resolved" },
              ]}
            />
          </SectionCard>

          <SectionCard title="Linked documents" description="What this issue arose from.">
            {!po && !grn && !invoice ? (
              <p className="text-xs text-muted">
                Not linked to a specific document. General conduct issues are recorded this way.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {po && (
                  <li className="flex items-center justify-between gap-3 text-xs">
                    <span>
                      <span className="label block">Purchase order</span>
                      <RefLink href={`/po/${po.id}`}>{po.number}</RefLink>
                    </span>
                    <span className="text-right">
                      <StatusBadge status={po.status} />
                      <span className="tnum mt-0.5 block text-2xs">{money(po.total)}</span>
                    </span>
                  </li>
                )}
                {grn && (
                  <li className="flex items-center justify-between gap-3 text-xs">
                    <span>
                      <span className="label block">Goods receipt</span>
                      <RefLink href={`/grn/${grn.id}`}>{grn.number}</RefLink>
                    </span>
                    <span className="text-right">
                      <StatusBadge status={grn.status} />
                      <span className="tnum mt-0.5 block text-2xs">{money(grn.totalValue)}</span>
                    </span>
                  </li>
                )}
                {invoice && (
                  <li className="flex items-center justify-between gap-3 text-xs">
                    <span>
                      <span className="label block">Invoice</span>
                      <RefLink href={`/invoices/${invoice.id}`}>{invoice.number}</RefLink>
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        Vendor ref {invoice.vendorInvoiceNumber}
                      </span>
                    </span>
                    <span className="text-right">
                      <StatusBadge status={invoice.matchStatus} />
                      <span className="tnum mt-0.5 block text-2xs">{money(invoice.total)}</span>
                    </span>
                  </li>
                )}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Activity">
            <Timeline events={events} emptyLabel="No activity recorded yet." />
          </SectionCard>
        </div>
      </div>

      <DocumentsPanel
        user={user}
        linkedType="VENDOR"
        linkedId={issue.vendor.id}
        entityId={issue.vendor.entityLinks[0]?.entityId ?? null}
        title="Evidence"
        description="Photographs, correspondence, test reports and anything else that substantiates the issue."
        defaultCategory="Vendor"
      />
    </div>
  );
}
