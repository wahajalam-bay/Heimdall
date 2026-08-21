import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { caseTimeline, documentTimeline } from "@/server/timeline";
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
import { Timeline } from "@/components/ui/workflow";
import { SEVERITY_TONE, humanize } from "@/lib/domain";
import { ageDays, fmtDate, fmtDateTime, money } from "@/lib/format";
import { ResolveExceptionForm } from "../ExceptionActions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const e = await prisma.exception.findUnique({ where: { id }, select: { number: true, title: true } });
  return { title: e ? `${e.number} — Exception` : "Exception" };
}

export default async function ExceptionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.EXCEPTION_VIEW);
  if (!authorized) return <AccessDenied title="Exception" />;

  const exception = await prisma.exception.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, name: true, title: true } },
      raisedBy: { select: { id: true, name: true, title: true } },
      pr: {
        select: {
          id: true,
          number: true,
          title: true,
          status: true,
          estimatedValue: true,
          department: { select: { name: true } },
        },
      },
      po: {
        select: {
          id: true,
          number: true,
          status: true,
          total: true,
          vendor: { select: { id: true, name: true } },
        },
      },
      invoice: {
        select: {
          id: true,
          number: true,
          vendorInvoiceNumber: true,
          status: true,
          total: true,
          matchStatus: true,
          vendor: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!exception) notFound();

  const [events, caseEvents, entity, resolver, related] = await Promise.all([
    documentTimeline("Exception", exception.id),
    exception.caseKey ? caseTimeline(exception.caseKey) : Promise.resolve([]),
    exception.entityId
      ? prisma.entity.findUnique({ where: { id: exception.entityId }, select: { code: true, name: true } })
      : Promise.resolve(null),
    exception.resolvedById
      ? prisma.user.findUnique({ where: { id: exception.resolvedById }, select: { name: true, title: true } })
      : Promise.resolve(null),
    exception.caseKey
      ? prisma.exception.findMany({
          where: { caseKey: exception.caseKey, id: { not: exception.id } },
          select: { id: true, number: true, type: true, severity: true, status: true, title: true, blocking: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve([]),
  ]);

  const canManage = userHasPermission(user, P.EXCEPTION_MANAGE);
  const canWaive = userHasPermission(user, P.INVOICE_EXCEPTION_APPROVE);
  const isOpen = ["OPEN", "IN_PROGRESS"].includes(exception.status);
  const age = ageDays(exception.createdAt) ?? 0;
  const overdue = exception.dueAt && exception.dueAt.getTime() < Date.now() && isOpen;

  const docHref = exception.invoice
    ? `/invoices/${exception.invoice.id}`
    : exception.po
      ? `/po/${exception.po.id}`
      : exception.pr
        ? `/pr/${exception.pr.id}`
        : null;

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Analytics", href: "/analytics" },
          { label: "Exceptions", href: "/analytics/exceptions" },
          { label: exception.number },
        ]}
      />

      <PageHeader
        eyebrow={`${entity?.code ?? "All entities"} · ${humanize(exception.type)}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-[var(--c-text-secondary)]">{exception.number}</span>
            <span>{exception.title}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={exception.status} />
            </MetaItem>
            <MetaItem label="Severity">
              <Badge tone={SEVERITY_TONE[exception.severity] ?? "neutral"}>{humanize(exception.severity)}</Badge>
            </MetaItem>
            <MetaItem label="Blocking">
              {exception.blocking ? <Badge tone="danger">Yes</Badge> : <Badge tone="neutral">No</Badge>}
            </MetaItem>
            <MetaItem label="Owner">{exception.owner?.name ?? "Unassigned"}</MetaItem>
            <MetaItem label="Raised">{fmtDate(exception.createdAt)}</MetaItem>
            {isOpen && <MetaItem label="Open for">{age} days</MetaItem>}
          </>
        }
        actions={
          <>
            {canManage && isOpen && (
              <ResolveExceptionForm
                exceptionId={exception.id}
                number={exception.number}
                title={exception.title}
                blocking={exception.blocking}
                status={exception.status}
                canWaive={canWaive}
              />
            )}
            {docHref && (
              <Link href={docHref} className="btn btn-secondary btn-sm">
                Open document
              </Link>
            )}
            <Link href="/analytics/exceptions" className="btn btn-secondary btn-sm">
              All exceptions
            </Link>
          </>
        }
      />

      {exception.blocking && isOpen && (
        <BlockedNotice
          tone="danger"
          title="This exception is blocking a transaction"
          reasons={[
            exception.description ?? exception.title,
            "The affected document cannot progress until this is resolved, or an authorised approver records a waiver.",
          ]}
        />
      )}

      {overdue && (
        <InlineAlert tone="warning">
          This exception was due on {exception.dueAt ? fmtDate(exception.dueAt) : "—"} and is{" "}
          {exception.dueAt ? (ageDays(exception.dueAt) ?? 0) : 0} days past it.
        </InlineAlert>
      )}

      {exception.status === "WAIVED" && (
        <InlineAlert tone="warning">
          This exception was waived{resolver ? ` by ${resolver.name}` : ""}
          {exception.resolvedAt ? ` on ${fmtDateTime(exception.resolvedAt)}` : ""}. A waiver means the control was
          overridden deliberately, not that the problem went away.
        </InlineAlert>
      )}
      {["RESOLVED", "ACCEPTED", "CLOSED"].includes(exception.status) && (
        <InlineAlert tone="success">
          {humanize(exception.status)}
          {resolver ? ` by ${resolver.name}` : ""}
          {exception.resolvedAt ? ` on ${fmtDateTime(exception.resolvedAt)}` : ""}.
        </InlineAlert>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-4">
          <SectionCard title="What happened">
            <p className="whitespace-pre-wrap text-[0.8125rem] leading-6">
              {exception.description ?? exception.title}
            </p>
            {exception.reason && (
              <div className="mt-3 border-t border-[var(--c-border-subtle)] pt-3">
                <span className="label mb-1 block">Recorded reason</span>
                <p className="whitespace-pre-wrap text-xs leading-5 text-[var(--c-text-secondary)]">
                  {exception.reason}
                </p>
              </div>
            )}
          </SectionCard>

          {exception.resolution && (
            <SectionCard title="Resolution on record">
              <p className="whitespace-pre-wrap text-[0.8125rem] leading-6">{exception.resolution}</p>
              <p className="mt-2 text-2xs text-[var(--c-text-tertiary)]">
                {resolver ? `${resolver.name}${resolver.title ? ` — ${resolver.title}` : ""}` : "Unknown"}
                {exception.resolvedAt ? ` · ${fmtDateTime(exception.resolvedAt)}` : ""}
              </p>
            </SectionCard>
          )}

          <SectionCard title="Affected document">
            {exception.invoice ? (
              <DefList
                columns={2}
                items={[
                  { label: "Invoice", value: <RefLink href={`/invoices/${exception.invoice.id}`}>{exception.invoice.number}</RefLink> },
                  { label: "Vendor reference", value: <Mono>{exception.invoice.vendorInvoiceNumber}</Mono> },
                  {
                    label: "Vendor",
                    value: <RefLink href={`/vendors/${exception.invoice.vendor.id}`}>{exception.invoice.vendor.name}</RefLink>,
                  },
                  { label: "Invoice total", value: money(exception.invoice.total) },
                  { label: "Invoice status", value: <StatusBadge status={exception.invoice.status} /> },
                  { label: "Match status", value: <StatusBadge status={exception.invoice.matchStatus} /> },
                ]}
              />
            ) : exception.po ? (
              <DefList
                columns={2}
                items={[
                  { label: "Purchase order", value: <RefLink href={`/po/${exception.po.id}`}>{exception.po.number}</RefLink> },
                  {
                    label: "Vendor",
                    value: <RefLink href={`/vendors/${exception.po.vendor.id}`}>{exception.po.vendor.name}</RefLink>,
                  },
                  { label: "Order value", value: money(exception.po.total) },
                  { label: "Order status", value: <StatusBadge status={exception.po.status} /> },
                ]}
              />
            ) : exception.pr ? (
              <DefList
                columns={2}
                items={[
                  { label: "Requisition", value: <RefLink href={`/pr/${exception.pr.id}`}>{exception.pr.number}</RefLink> },
                  { label: "Title", value: exception.pr.title },
                  { label: "Department", value: exception.pr.department.name },
                  { label: "Estimated value", value: money(exception.pr.estimatedValue) },
                  { label: "Status", value: <StatusBadge status={exception.pr.status} /> },
                ]}
              />
            ) : (
              <DefList
                columns={2}
                items={[
                  { label: "Document type", value: humanize(exception.documentType) },
                  { label: "Reference", value: <Mono>{exception.documentRef}</Mono> },
                ]}
              />
            )}
          </SectionCard>

          {related.length > 0 && (
            <SectionCard
              title="Other exceptions on this case"
              description="A case with several exceptions usually has one underlying cause."
              bodyClassName="px-0 py-0"
            >
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Exception</th>
                      <th>Type</th>
                      <th>Severity</th>
                      <th>Blocking</th>
                      <th>Status</th>
                      <th>Raised</th>
                    </tr>
                  </thead>
                  <tbody>
                    {related.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <RefLink href={`/analytics/exceptions/${r.id}`}>{r.number}</RefLink>
                          <span className="mt-0.5 block max-w-[22rem] truncate text-2xs text-[var(--c-text-tertiary)]">
                            {r.title}
                          </span>
                        </td>
                        <td className="text-2xs">{humanize(r.type)}</td>
                        <td>
                          <Badge tone={SEVERITY_TONE[r.severity] ?? "neutral"}>{humanize(r.severity)}</Badge>
                        </td>
                        <td>{r.blocking ? <Badge tone="danger">Yes</Badge> : "—"}</td>
                        <td>
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="text-xs">{fmtDate(r.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}

          {caseEvents.length > 0 && (
            <SectionCard
              title="Case timeline"
              description={`Everything that has happened on ${exception.caseKey} — the context this exception sits in.`}
            >
              <Timeline events={caseEvents} emptyLabel="No case activity." />
            </SectionCard>
          )}
        </div>

        <div className="space-y-4">
          <SectionCard title="Exception record">
            <DefList
              columns={1}
              items={[
                { label: "Number", value: <Mono>{exception.number}</Mono> },
                { label: "Type", value: humanize(exception.type) },
                {
                  label: "Severity",
                  value: <Badge tone={SEVERITY_TONE[exception.severity] ?? "neutral"}>{humanize(exception.severity)}</Badge>,
                },
                { label: "Status", value: <StatusBadge status={exception.status} /> },
                {
                  label: "Blocking",
                  value: exception.blocking ? (
                    <Badge tone="danger">Blocks the transaction</Badge>
                  ) : (
                    <Badge tone="neutral">Advisory</Badge>
                  ),
                },
                { label: "Entity", value: entity ? `${entity.code} — ${entity.name}` : "All entities" },
                { label: "Case", value: exception.caseKey ?? "—" },
                { label: "Document", value: <Mono>{exception.documentRef}</Mono> },
                { label: "Document type", value: humanize(exception.documentType) },
                {
                  label: "Owner",
                  value: exception.owner
                    ? `${exception.owner.name}${exception.owner.title ? ` — ${exception.owner.title}` : ""}`
                    : "Unassigned",
                },
                {
                  label: "Raised by",
                  value: exception.raisedBy
                    ? `${exception.raisedBy.name}${exception.raisedBy.title ? ` — ${exception.raisedBy.title}` : ""}`
                    : "System",
                },
                { label: "Raised at", value: fmtDateTime(exception.createdAt) },
                { label: "Due", value: exception.dueAt ? fmtDate(exception.dueAt) : "No deadline set" },
                { label: "Resolved at", value: exception.resolvedAt ? fmtDateTime(exception.resolvedAt) : "Open" },
              ]}
            />
          </SectionCard>

          <SectionCard title="Activity">
            <Timeline events={events} emptyLabel="No activity recorded yet." />
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
