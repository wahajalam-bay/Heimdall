import { notFound } from "next/navigation";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  BlockedNotice,
  DefList,
  InlineAlert,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatusBadge,
} from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/forms";
import { LifecycleRail, Timeline, buildRail } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { documentTimeline } from "@/server/timeline";
import { money, fmtDate, fmtDateTime, qty } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { workOrderDetail } from "@/server/work-orders";
import {
  approveWorkOrderAction,
  closeWorkOrderAction,
  internalAuditReviewAction,
  issueWorkOrderAction,
  submitWorkOrderAction,
} from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wo = await workOrderDetail(id);
  return { title: wo ? `${wo.number} — ${wo.title}` : "Work order" };
}

const RAIL = [
  "DRAFT",
  "PENDING_INTERNAL_AUDIT",
  "PENDING_APPROVAL",
  "APPROVED",
  "ISSUED",
  "IN_PROGRESS",
  "COMPLETED",
  "CLOSED",
] as const;

export default async function WorkOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, authorized } = await pageContext(P.WORK_ORDER_VIEW);
  if (!authorized) return <AccessDenied title="Work order" />;

  const { id } = await params;
  const wo = await workOrderDetail(id);
  if (!wo) notFound();

  const events = await documentTimeline("WorkOrder", wo.id);

  const canEdit = userHasPermission(user, P.WORK_ORDER_CREATE, P.WORK_ORDER_EDIT);
  const canReview = userHasPermission(user, P.WORK_ORDER_AUDIT_REVIEW);
  const canApprove = userHasPermission(user, P.WORK_ORDER_APPROVE);
  const canIssue = userHasPermission(user, P.WORK_ORDER_ISSUE);
  const canClose = userHasPermission(user, P.WORK_ORDER_CLOSE);

  // The SOP puts the review with Internal Audit precisely so the department that
  // raised the order is not the one clearing it. The button is hidden for the
  // raiser, and the mutation refuses them regardless.
  const isRaiser = wo.createdById === user.id;

  // Steps the order genuinely passes through. An order inside the committee's
  // domain never sees the Internal Audit step, so showing it would make a
  // correctly-routed order look as though it had skipped a gate.
  const rail = buildRail(
    RAIL.filter((s) => wo.internalAuditRequired || s !== "PENDING_INTERNAL_AUDIT"),
    wo.status,
    {
      APPROVED: { at: null, owner: null },
      ISSUED: { at: wo.issuedAt, owner: wo.issuedBy?.name ?? null },
      PENDING_INTERNAL_AUDIT: { at: wo.internalAuditAt, owner: wo.internalAuditBy?.name ?? null },
      COMPLETED: { at: wo.completedAt, owner: null },
      CLOSED: { at: wo.closedAt, owner: null },
    },
  );

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Procurement" },
          { label: "Work orders", href: "/work-orders" },
          { label: wo.number },
        ]}
      />

      <PageHeader
        eyebrow={`${wo.entity.code} · ${wo.vendor.name}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <Mono className="text-[1rem] text-muted">{wo.number}</Mono>
            <span>{wo.title}</span>
          </span>
        }
        meta={
          <>
            <StatusBadge status={wo.status} />
            <span className="text-2xs">{money(wo.total)}</span>
          </>
        }
        actions={
          <>
            {wo.status === "DRAFT" && canEdit && (
              <ActionButton
                action={submitWorkOrderAction}
                payload={{ workOrderId: wo.id }}
                label={wo.internalAuditRequired ? "Send to Internal Audit" : "Send for approval"}
                tone="primary"
              />
            )}
            {wo.status === "PENDING_INTERNAL_AUDIT" && canReview && !isRaiser && (
              <>
                <ActionButton
                  action={internalAuditReviewAction}
                  payload={{ workOrderId: wo.id, decision: "APPROVED" }}
                  label="Clear for finalisation"
                  tone="success"
                  reasonLabel="Review note (optional)"
                />
                <ActionButton
                  action={internalAuditReviewAction}
                  payload={{ workOrderId: wo.id, decision: "REJECTED" }}
                  label="Return"
                  tone="danger-soft"
                  reasonLabel="Why Internal Audit is not clearing this"
                  reasonRequired
                />
              </>
            )}
            {wo.status === "PENDING_APPROVAL" && canApprove && (
              <ActionButton
                action={approveWorkOrderAction}
                payload={{ workOrderId: wo.id }}
                label="Approve"
                tone="primary"
                reasonLabel="Approval note (optional)"
              />
            )}
            {wo.status === "APPROVED" && canIssue && (
              <ActionButton
                action={issueWorkOrderAction}
                payload={{ workOrderId: wo.id }}
                label="Issue to vendor"
                tone="primary"
                confirm={`Issue ${wo.number} to ${wo.vendor.name} for ${money(wo.total)}?`}
              />
            )}
            {["ISSUED", "IN_PROGRESS"].includes(wo.status) && canClose && (
              <ActionButton
                action={closeWorkOrderAction}
                payload={{ workOrderId: wo.id, to: "COMPLETED" }}
                label="Mark complete"
                tone="secondary"
              />
            )}
            {wo.status === "COMPLETED" && canClose && (
              <ActionButton
                action={closeWorkOrderAction}
                payload={{ workOrderId: wo.id, to: "CLOSED" }}
                label="Close"
                tone="secondary"
              />
            )}
          </>
        }
      />

      {wo.status === "PENDING_INTERNAL_AUDIT" && (
        <InlineAlert tone={canReview && !isRaiser ? "warning" : "info"}>
          {isRaiser && canReview
            ? "You raised this order, so you cannot be the Internal Audit review of it. The SOP names Internal Audit precisely so the raising department is not the one clearing it."
            : "The CPC Terms of Reference require Internal Audit to review and approve this work order before it is finalised, because it falls outside the committee's domain."}
        </InlineAlert>
      )}

      {wo.internalAuditStatus === "REJECTED" && (
        <BlockedNotice
          title="Returned by Internal Audit"
          reasons={[wo.internalAuditNotes ?? "No reason recorded."]}
        />
      )}

      <LifecycleRail steps={rail} title="Work order lifecycle" />

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <SectionCard title="Scope of work">
          <p className="whitespace-pre-wrap text-xs leading-6">{wo.scopeOfWork}</p>
        </SectionCard>

        <SectionCard
          title="Internal Audit"
          description="CPC Terms of Reference — Services Acquisition for Admin."
        >
          {wo.internalAuditRequired ? (
            <DefList
              columns={1}
              items={[
                {
                  label: "Status",
                  value: (
                    <Badge
                      tone={
                        wo.internalAuditStatus === "APPROVED"
                          ? "success"
                          : wo.internalAuditStatus === "REJECTED"
                            ? "danger"
                            : "warning"
                      }
                    >
                      {humanize(wo.internalAuditStatus)}
                    </Badge>
                  ),
                },
                {
                  label: "Reviewed by",
                  value: wo.internalAuditBy
                    ? `${wo.internalAuditBy.name}${wo.internalAuditBy.title ? ` — ${wo.internalAuditBy.title}` : ""}`
                    : "—",
                },
                { label: "Reviewed", value: wo.internalAuditAt ? fmtDateTime(wo.internalAuditAt) : "—" },
                ...(wo.internalAuditNotes ? [{ label: "Note", value: wo.internalAuditNotes }] : []),
              ]}
            />
          ) : (
            <p className="text-xs leading-5 text-muted">
              This order falls within the committee&rsquo;s domain, where the CPC case is the review. The Terms of
              Reference put the Internal Audit gate on acquisitions <em>outside</em> that domain, so applying it here
              as well would be a second review the SOP does not ask for.
            </p>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Lines"
        description="§4.6: rates negotiated by Procurement. Each line names where its rate came from."
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "3rem" }}>#</th>
                <th style={{ minWidth: "16rem" }}>Description</th>
                <th style={{ width: "7rem" }} className="text-right">
                  Qty
                </th>
                <th style={{ width: "6rem" }}>Unit</th>
                <th style={{ width: "9rem" }} className="text-right">
                  Rate
                </th>
                <th style={{ width: "10rem" }} className="text-right">
                  Amount
                </th>
                <th style={{ minWidth: "10rem" }}>Rate source</th>
              </tr>
            </thead>
            <tbody>
              {wo.items.map((li) => (
                <tr key={li.id}>
                  <td className="tnum">{li.lineNo}</td>
                  <td>{li.description}</td>
                  <td className="tnum text-right">{qty(li.quantity)}</td>
                  <td className="text-2xs">{li.unit}</td>
                  <td className="tnum text-right">{money(li.rate)}</td>
                  <td className="tnum text-right font-semibold">{money(li.amount)}</td>
                  <td className="text-2xs text-muted">
                    {li.sourceRef ?? (
                      <span className="text-[var(--c-text-tertiary)]">Not traced to a negotiation</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} className="text-right text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
                  Subtotal
                </td>
                <td className="tnum text-right">{money(wo.subtotal)}</td>
                <td />
              </tr>
              <tr>
                <td colSpan={5} className="text-right text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
                  Tax
                </td>
                <td className="tnum text-right">{money(wo.taxAmount)}</td>
                <td />
              </tr>
              <tr>
                <td colSpan={5} className="text-right text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
                  Total
                </td>
                <td className="tnum text-right font-semibold">{money(wo.total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Order detail">
          <DefList
            columns={2}
            items={[
              { label: "Vendor", value: <RefLink href={`/vendors/${wo.vendor.id}`}>{wo.vendor.name}</RefLink> },
              { label: "Company", value: wo.entity.name },
              {
                label: "Raised by",
                value: `${wo.createdBy.name}${wo.createdBy.title ? ` — ${wo.createdBy.title}` : ""}`,
              },
              { label: "Raised", value: fmtDateTime(wo.createdAt) },
              {
                label: "Issued by",
                value: wo.issuedBy
                  ? `${wo.issuedBy.name}${wo.issuedBy.title ? ` — ${wo.issuedBy.title}` : ""}`
                  : "—",
              },
              { label: "Issued", value: wo.issuedAt ? fmtDateTime(wo.issuedAt) : "—" },
              { label: "Start", value: wo.startDate ? fmtDate(wo.startDate) : "—" },
              { label: "End", value: wo.endDate ? fmtDate(wo.endDate) : "—" },
              {
                label: "Requisition",
                value: wo.pr ? <RefLink href={`/pr/${wo.pr.id}`}>{wo.pr.number}</RefLink> : "—",
              },
              {
                label: "Comparative",
                value: wo.comparative ? (
                  <RefLink href={`/comparatives/${wo.comparative.id}`}>{wo.comparative.number}</RefLink>
                ) : (
                  "—"
                ),
              },
            ]}
          />
        </SectionCard>

        <DocumentsPanel user={user} linkedType="WORK_ORDER" linkedId={wo.id} title="Documents" />
      </div>

      <SectionCard title="Activity">
        <Timeline events={events} />
      </SectionCard>
    </div>
  );
}
