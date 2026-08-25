import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { CONFIG_KEYS, getConfigBool } from "@/lib/config";
import { checkAvailability, requirementVisibilityFilter } from "@/server/requirements";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { ActionButton } from "@/components/ui/forms";
import {
  Badge,
  DefList,
  EmptyState,
  InlineAlert,
  MetaItem,
  PageHeader,
  RefLink,
  SectionCard,
  StatusBadge,
} from "@/components/ui/primitives";
import { Timeline } from "@/components/ui/workflow";
import { humanize } from "@/lib/domain";
import { fmtDate, fmtDateTime, money, relativeTime } from "@/lib/format";
import { FulfilmentDecision, type DecisionLine } from "./FulfilmentDecision";
import { cancelRequirementAction, checkStockAction, submitRequirementAction } from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await prisma.requirement.findUnique({ where: { id }, select: { number: true } });
  return { title: r ? `Requirement ${r.number}` : "Requirement" };
}

/**
 * One requirement, and the decision that routes it.
 *
 * The availability figures shown while a decision is outstanding are read live,
 * because a stale number is what causes a promise the store cannot keep. Once
 * decided, the snapshot taken at that moment is shown instead — that is the
 * record of why the decision was the right one.
 */
export default async function RequirementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.REQUIREMENT_VIEW, P.REQUIREMENT_VIEW_ALL);
  if (!authorized) {
    return <AccessDenied title="Requirement" message="You do not have permission to view requirements." />;
  }

  const requirement = await prisma.requirement.findFirst({
    where: { id, ...requirementVisibilityFilter(user) },
    include: {
      entity: { select: { code: true, name: true } },
      department: { select: { name: true } },
      requester: { select: { name: true } },
      decidedBy: { select: { name: true } },
      site: { select: { name: true } },
      project: { select: { code: true, name: true } },
      store: { select: { code: true, name: true } },
      items: {
        orderBy: { lineNo: "asc" },
        include: {
          item: { select: { sku: true, name: true } },
          category: { select: { code: true, name: true } },
          sourceStore: { select: { code: true, name: true } },
          reservations: {
            where: { status: "ACTIVE" },
            select: { id: true, quantity: true, unit: true, store: { select: { code: true } } },
          },
        },
      },
      storeIssues: {
        select: { id: true, number: true, status: true, store: { select: { code: true } }, issuedAt: true },
      },
      requisitions: { select: { id: true, number: true, status: true, estimatedValue: true } },
    },
  });
  if (!requirement) notFound();

  const canDecide = userHasPermission(user, P.REQUIREMENT_DECIDE);
  const canCheck = userHasPermission(user, P.REQUIREMENT_CHECK_STOCK, P.REQUIREMENT_DECIDE);
  const canSubmit = userHasPermission(user, P.REQUIREMENT_SUBMIT) && requirement.requesterId === user.id;
  const canCancel = userHasPermission(user, P.REQUIREMENT_CANCEL);

  const awaitingDecision = ["SUBMITTED", "CHECKING_STOCK"].includes(requirement.status);
  const requireCheck = await getConfigBool(CONFIG_KEYS.REQUIRE_INVENTORY_CHECK, requirement.entityId);

  // Live availability only matters while a decision is still open.
  const live = awaitingDecision && canDecide ? await checkAvailability(requirement.id) : null;

  const showDecision = awaitingDecision && canDecide && (live?.lines.length ?? 0) > 0;

  const decisionLines: DecisionLine[] = (live?.lines ?? []).map((l) => ({
    requirementItemId: l.requirementItemId,
    lineNo: l.lineNo,
    sku: l.sku,
    description: l.description,
    unit: l.unit,
    quantity: l.quantity,
    primaryAvailable: l.primaryAvailable,
    elsewhereAvailable: l.elsewhereAvailable,
    suggestedFromStock: l.fromStockQty,
    suggestedProcure: l.procureQty,
    suggestedSourceStoreId: l.sourceStoreId,
    stores: l.stores.map((s) => ({
      storeId: s.storeId,
      storeCode: s.storeCode,
      storeName: s.storeName,
      available: s.available,
      isPrimary: s.isPrimary,
    })),
  }));

  const timeline = [
    { label: "Raised", at: requirement.createdAt, by: requirement.requester.name },
    requirement.submittedAt ? { label: "Submitted", at: requirement.submittedAt } : null,
    requirement.checkedAt ? { label: "Stock checked", at: requirement.checkedAt } : null,
    requirement.decidedAt
      ? {
          label: `Routed — ${humanize(requirement.status)}`,
          at: requirement.decidedAt,
          by: requirement.decidedBy?.name,
        }
      : null,
    requirement.cancelledAt ? { label: "Cancelled", at: requirement.cancelledAt } : null,
  ].filter(Boolean) as Array<{ label: string; at: Date; by?: string }>;

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Demand", href: "/requirements" },
          { label: "Requirements", href: "/requirements" },
          { label: requirement.number },
        ]}
      />

      <PageHeader
        eyebrow="Requirement"
        title={requirement.title}
        subtitle={requirement.purpose ?? undefined}
        meta={
          <>
            <MetaItem label="Reference">
              <span className="mono">{requirement.number}</span>
            </MetaItem>
            <MetaItem label="Status">
              <StatusBadge status={requirement.status} />
            </MetaItem>
            <MetaItem label="Department">{requirement.department.name}</MetaItem>
            <MetaItem label="Needed by">{fmtDate(requirement.requiredDate)}</MetaItem>
            <MetaItem label="Raised">{relativeTime(requirement.createdAt)}</MetaItem>
          </>
        }
        actions={
          <>
            {requirement.status === "DRAFT" && canSubmit && (
              <ActionButton
                action={submitRequirementAction}
                payload={{ id: requirement.id }}
                label="Submit"
                tone="primary"
              />
            )}
            {awaitingDecision && canCheck && (
              <ActionButton
                action={checkStockAction}
                payload={{ id: requirement.id }}
                label={requirement.checkedAt ? "Re-check stock" : "Check stock"}
                tone="secondary"
              />
            )}
            {!["CLOSED", "CANCELLED"].includes(requirement.status) && canCancel && (
              <ActionButton
                action={cancelRequirementAction}
                payload={{ id: requirement.id }}
                label="Cancel"
                tone="danger"
                reasonLabel="Why is this requirement being cancelled?"
                reasonRequired
                confirm="Cancel this requirement and release any stock held for it?"
              />
            )}
          </>
        }
      />

      {requirement.status === "SUBMITTED" && requireCheck && !requirement.checkedAt && (
        <InlineAlert tone="warning">
          Stock has not been checked yet. Nothing can be issued or bought until it has been — that is the rule this
          screen exists to enforce.
        </InlineAlert>
      )}

      {requirement.decisionNote && (
        <InlineAlert tone={requirement.status === "CANCELLED" ? "danger" : "info"}>
          <span className="font-500">Decision note:</span> {requirement.decisionNote}
        </InlineAlert>
      )}

      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          {showDecision && (
            <SectionCard
              title="How will this be met?"
              description="Stock first. Only the quantity no store can supply becomes a purchase."
            >
              <FulfilmentDecision
                requirementId={requirement.id}
                lines={decisionLines}
                mode={live?.mode ?? "SPLIT"}
                crossStoreEnabled={live?.crossStoreEnabled ?? false}
              />
            </SectionCard>
          )}

          {/* While the decision is open, the table above says everything this one
              would and more — so it only appears once there is a snapshot to
              show. */}
          {!showDecision && (
          <SectionCard
            title="Lines"
            description={
              requirement.decidedAt
                ? "The availability recorded when this was routed, and how the quantity was split."
                : "What has been asked for."
            }
            bodyClassName="px-0 pb-0"
          >
            <div className="table-wrap">
              <table className="dt min-w-[46rem]">
                <thead>
                  <tr>
                    <th style={{ width: "3rem" }}>#</th>
                    <th>Item</th>
                    <th className="text-right">Needed</th>
                    {requirement.decidedAt && <th className="text-right">Available then</th>}
                    {requirement.decidedAt && <th className="text-right">From stock</th>}
                    {requirement.decidedAt && <th className="text-right">Bought</th>}
                    {requirement.decidedAt && <th>Issued from</th>}
                    <th className="text-right">Est. unit</th>
                  </tr>
                </thead>
                <tbody>
                  {requirement.items.map((line) => (
                    <tr key={line.id}>
                      <td className="tnum">{line.lineNo}</td>
                      <td>
                        <div className="text-xs font-500">{line.description}</div>
                        <div className="mono text-2xs text-[var(--c-text-tertiary)]">
                          {line.item?.sku ?? line.category?.code ?? "Free text"}
                        </div>
                        {line.specification && (
                          <div className="mt-0.5 text-2xs text-muted">{line.specification}</div>
                        )}
                        {line.reservations.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {line.reservations.map((r) => (
                              <Badge key={r.id} tone="warning">
                                {r.quantity} {r.unit} held at {r.store.code}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="num">
                        {line.quantity} {line.unit}
                      </td>
                      {requirement.decidedAt && <td className="num">{line.availableQty}</td>}
                      {requirement.decidedAt && (
                        <td className="num">
                          {line.fromStockQty > 0 ? (
                            <span className="text-success-soft-foreground">{line.fromStockQty}</span>
                          ) : (
                            <span className="text-[var(--c-text-tertiary)]">—</span>
                          )}
                        </td>
                      )}
                      {requirement.decidedAt && (
                        <td className="num">
                          {line.procureQty > 0 ? line.procureQty : <span className="text-[var(--c-text-tertiary)]">—</span>}
                        </td>
                      )}
                      {requirement.decidedAt && (
                        <td className="text-xs">{line.sourceStore ? line.sourceStore.code : "—"}</td>
                      )}
                      <td className="num">
                        {line.estimatedUnitCost ? money(line.estimatedUnitCost, "PKR", { compact: true }) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
          )}

          <SectionCard title="What this became" description="The documents this requirement produced.">
            {requirement.storeIssues.length === 0 && requirement.requisitions.length === 0 ? (
              <EmptyState
                compact
                title="Not routed yet"
                description="Once a decision is taken, the store requisition and purchase requisition it creates appear here."
              />
            ) : (
              <div className="space-y-3">
                {requirement.storeIssues.map((s) => (
                  <div key={s.id} className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge tone="success">Store requisition</Badge>
                    <RefLink href={`/issuance/${s.id}`}>{s.number}</RefLink>
                    <StatusBadge status={s.status} />
                    <span className="text-muted">{s.store.code}</span>
                    {s.issuedAt && <span className="text-muted">issued {relativeTime(s.issuedAt)}</span>}
                  </div>
                ))}
                {requirement.requisitions.map((s) => (
                  <div key={s.id} className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge tone="accent">Purchase requisition</Badge>
                    <RefLink href={`/pr/${s.id}`}>{s.number}</RefLink>
                    <StatusBadge status={s.status} />
                    <span className="tnum text-muted">{money(s.estimatedValue, "PKR", { compact: true })}</span>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        <div className="space-y-4">
          <SectionCard title="Details">
            <DefList
              columns={1}
              items={[
                { label: "Entity", value: `${requirement.entity.code} — ${requirement.entity.name}` },
                { label: "Department", value: requirement.department.name },
                { label: "Raised by", value: requirement.requester.name },
                { label: "Priority", value: humanize(requirement.priority) },
                { label: "Expenditure", value: requirement.expenditureType === "CAPEX" ? "Capital" : "Operating" },
                { label: "Site", value: requirement.site?.name ?? "—" },
                { label: "Serving store", value: requirement.store ? `${requirement.store.code} — ${requirement.store.name}` : "Decided automatically" },
                { label: "Project", value: requirement.project ? `${requirement.project.code} — ${requirement.project.name}` : "—" },
                { label: "Cost centre", value: requirement.costCenter ?? "—" },
                { label: "Estimated value", value: money(requirement.estimatedValue, "PKR", { compact: true }) },
                {
                  label: "Justification",
                  value: requirement.justification ?? "—",
                  span: true,
                },
              ]}
            />
          </SectionCard>

          <SectionCard title="History">
            <Timeline
              events={timeline.map((t, i) => ({
                id: `rq-tl-${i}`,
                title: t.label,
                at: t.at,
                actor: t.by ?? null,
              }))}
            />
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
