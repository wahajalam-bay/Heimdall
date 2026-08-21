import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { documentTimeline } from "@/server/timeline";
import { availableQuantity } from "@/server/inventory";
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
import { humanize } from "@/lib/domain";
import { fmtDate, fmtDateTime, money, qty, round2 } from "@/lib/format";
import { decideIssueAction, issueStockAction } from "@/app/(app)/stores/actions";

export const dynamic = "force-dynamic";

const ISSUE_LIFECYCLE = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "PARTIALLY_ISSUED", "ISSUED"] as const;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const i = await prisma.storeIssue.findUnique({ where: { id }, select: { number: true } });
  return { title: i ? `${i.number} — Stock issue` : "Stock issue" };
}

export default async function IssueDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.INVENTORY_VIEW, P.STORE_ISSUE);
  if (!authorized) return <AccessDenied title="Stock issue" />;

  const issue = await prisma.storeIssue.findUnique({
    where: { id },
    include: {
      store: {
        select: {
          id: true,
          name: true,
          kind: true,
          entityId: true,
          managerId: true,
          entity: { select: { code: true, name: true } },
        },
      },
      requestedBy: { select: { name: true, title: true } },
      items: {
        orderBy: { lineNo: "asc" },
        include: { item: { select: { id: true, sku: true, name: true, unit: true, trackSerial: true } } },
      },
      transactions: {
        orderBy: { performedAt: "desc" },
        include: { item: { select: { sku: true, name: true } } },
      },
    },
  });
  if (!issue) notFound();

  const [events, department, project, recipientUser, assets, storeManager] = await Promise.all([
    documentTimeline("StoreIssue", issue.id),
    issue.departmentId
      ? prisma.department.findUnique({ where: { id: issue.departmentId }, select: { name: true, code: true } })
      : Promise.resolve(null),
    issue.projectId
      ? prisma.project.findUnique({ where: { id: issue.projectId }, select: { id: true, code: true, name: true } })
      : Promise.resolve(null),
    issue.recipientUserId
      ? prisma.user.findUnique({ where: { id: issue.recipientUserId }, select: { id: true, name: true, title: true } })
      : Promise.resolve(null),
    prisma.asset.findMany({
      where: { id: { in: issue.items.map((li) => li.assetId).filter((x): x is string => !!x) } },
      select: { id: true, tag: true, name: true, status: true },
    }),
    issue.store.managerId
      ? prisma.user.findUnique({ where: { id: issue.store.managerId }, select: { name: true } })
      : Promise.resolve(null),
  ]);
  const assetById = new Map(assets.map((a) => [a.id, a]));

  // Live availability, so an approver sees whether the store can actually deliver.
  const availability = new Map<string, number>();
  for (const li of issue.items) {
    if (!availability.has(li.itemId)) {
      availability.set(li.itemId, await availableQuantity(li.itemId, issue.storeId));
    }
  }

  const canApprove = userHasPermission(user, P.STORE_ISSUE_APPROVE);
  const canIssue = userHasPermission(user, P.STORE_ISSUE);

  const requestedTotal = round2(issue.items.reduce((a, li) => a + li.requestedQty, 0));
  const approvedTotal = round2(issue.items.reduce((a, li) => a + (li.approvedQty ?? 0), 0));
  const issuedTotal = round2(issue.items.reduce((a, li) => a + li.issuedQty, 0));
  const outstanding = round2(
    issue.items.reduce((a, li) => a + Math.max(0, (li.approvedQty ?? li.requestedQty) - li.issuedQty), 0),
  );
  const ledgerValue = round2(issue.transactions.reduce((a, t) => a + Math.abs(t.value), 0));

  const shortLines = issue.items.filter(
    (li) => (availability.get(li.itemId) ?? 0) + 1e-9 < (li.approvedQty ?? li.requestedQty) - li.issuedQty,
  );

  const rail = buildRail(
    ISSUE_LIFECYCLE,
    issue.status === "PARTIALLY_ISSUED" ? "PARTIALLY_ISSUED" : issue.status,
    {
      DRAFT: { at: issue.requestedAt, owner: issue.requestedBy.name },
      PENDING_APPROVAL: { at: issue.requestedAt, owner: issue.requestedBy.name },
      APPROVED: { at: issue.approvedAt, owner: storeManager?.name ?? null },
      ISSUED: { at: issue.issuedAt, owner: null },
    },
    { terminalBad: issue.status === "REJECTED" || issue.status === "CANCELLED" },
  );

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Stores", href: "/stores" },
          { label: "Issuance", href: "/issuance" },
          { label: issue.number },
        ]}
      />

      <PageHeader
        eyebrow={`${issue.store.entity.code} · ${issue.store.name}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-[var(--c-text-secondary)]">{issue.number}</span>
            <span>Issued to {issue.recipientName}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={issue.status} />
            </MetaItem>
            <MetaItem label="Requested">{fmtDate(issue.requestedAt)}</MetaItem>
            <MetaItem label="Requested by">{issue.requestedBy.name}</MetaItem>
            <MetaItem label="Lines">{issue.items.length}</MetaItem>
            <MetaItem label="Charged to">
              {project ? (
                <RefLink href={`/analytics/spend?project=${project.id}`}>{project.code}</RefLink>
              ) : (
                (department?.name ?? "Unassigned")
              )}
            </MetaItem>
          </>
        }
        actions={
          <>
            {issue.status === "PENDING_APPROVAL" && canApprove && (
              <>
                <ActionButton
                  action={decideIssueAction}
                  payload={{ issueId: issue.id, approve: "true" }}
                  label="Approve issue"
                  tone="primary"
                  confirm={`Approve ${issue.number}? The store will be authorised to release ${qty(requestedTotal)} across ${issue.items.length} line(s).`}
                />
                <ActionButton
                  action={decideIssueAction}
                  payload={{ issueId: issue.id, approve: "false" }}
                  label="Reject"
                  tone="danger-soft"
                  reasonLabel="Why is this issue being rejected?"
                  reasonRequired
                />
              </>
            )}
            {["APPROVED", "PARTIALLY_ISSUED"].includes(issue.status) && canIssue && (
              <ActionButton
                action={issueStockAction}
                payload={{ issueId: issue.id }}
                label="Release stock"
                tone="primary"
                disabled={shortLines.length > 0}
                disabledReason={
                  shortLines.length > 0
                    ? "One or more lines exceed the stock currently free in this store."
                    : undefined
                }
                confirm={`Release ${qty(outstanding)} from ${issue.store.name}? Inventory will be reduced immediately and any asset custody transferred.`}
              />
            )}
          </>
        }
      />

      {issue.status === "REJECTED" && (
        <BlockedNotice
          title="This issue was rejected"
          reasons={[issue.remarks ?? "No reason recorded."]}
        />
      )}

      {shortLines.length > 0 && ["PENDING_APPROVAL", "APPROVED", "PARTIALLY_ISSUED"].includes(issue.status) && (
        <BlockedNotice
          title="Stock is not available for every line"
          reasons={shortLines.map(
            (li) =>
              `${li.item.name}: ${qty(Math.max(0, (li.approvedQty ?? li.requestedQty) - li.issuedQty), li.unit)} still to release but only ${qty(availability.get(li.itemId) ?? 0, li.unit)} free at ${issue.store.name}.`,
          )}
        />
      )}

      <LifecycleRail steps={rail} title="Issue lifecycle" />

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <SectionCard title="Requested lines" bodyClassName="px-0 py-0">
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: "3rem" }}>#</th>
                  <th style={{ minWidth: "16rem" }}>Item</th>
                  <th className="text-right">Requested</th>
                  <th className="text-right">Approved</th>
                  <th className="text-right">Issued</th>
                  <th className="text-right">Available now</th>
                  <th>Batch / serial</th>
                  <th>Custody</th>
                </tr>
              </thead>
              <tbody>
                {issue.items.map((li) => {
                  const free = availability.get(li.itemId) ?? 0;
                  const target = li.approvedQty ?? li.requestedQty;
                  const short = free + 1e-9 < target - li.issuedQty;
                  const asset = li.assetId ? assetById.get(li.assetId) : null;
                  return (
                    <tr key={li.id}>
                      <td className="num text-xs text-[var(--c-text-tertiary)]">{li.lineNo}</td>
                      <td>
                        <span className="block text-xs font-500">{li.item.name}</span>
                        <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                          <Mono>{li.item.sku}</Mono>
                          {li.item.trackSerial && <span className="ml-2">Serialised</span>}
                        </span>
                        {li.notes && (
                          <span className="mt-0.5 block text-2xs text-[var(--c-text-secondary)]">{li.notes}</span>
                        )}
                      </td>
                      <td className="num text-xs">{qty(li.requestedQty, li.unit)}</td>
                      <td className="num text-xs">
                        {li.approvedQty === null ? (
                          <span className="text-[var(--c-text-tertiary)]">—</span>
                        ) : (
                          qty(li.approvedQty, li.unit)
                        )}
                      </td>
                      <td className="num text-xs">
                        {li.issuedQty > 0 ? qty(li.issuedQty, li.unit) : <span className="text-[var(--c-text-tertiary)]">—</span>}
                      </td>
                      <td className="num text-xs">
                        <span className={short ? "text-[var(--c-danger)]" : undefined}>{qty(free, li.unit)}</span>
                      </td>
                      <td className="text-2xs text-[var(--c-text-secondary)]">
                        {li.batchNumber || li.serialNumber ? (
                          <>
                            {li.batchNumber && <span className="block">Batch {li.batchNumber}</span>}
                            {li.serialNumber && <span className="block">S/N {li.serialNumber}</span>}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="text-2xs">
                        {asset ? (
                          <RefLink href={`/assets/${asset.id}`}>{asset.tag}</RefLink>
                        ) : li.assetTag ? (
                          <Mono>{li.assetTag}</Mono>
                        ) : (
                          <span className="text-[var(--c-text-tertiary)]">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2} className="text-xs font-600">
                    Total
                  </td>
                  <td className="num text-xs font-600">{qty(requestedTotal)}</td>
                  <td className="num text-xs font-600">{approvedTotal > 0 ? qty(approvedTotal) : "—"}</td>
                  <td className="num text-xs font-600">{issuedTotal > 0 ? qty(issuedTotal) : "—"}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        </SectionCard>

        <div className="space-y-4">
          <SectionCard title="Issue detail">
            <DefList
              items={[
                { label: "Issue number", value: <Mono>{issue.number}</Mono> },
                { label: "Store", value: <RefLink href={`/stores/${issue.store.id}`}>{issue.store.name}</RefLink> },
                { label: "Store type", value: humanize(issue.store.kind) },
                { label: "Entity", value: issue.store.entity.name },
                { label: "Issued to", value: issue.recipientName },
                {
                  label: "Internal recipient",
                  value: recipientUser ? `${recipientUser.name}${recipientUser.title ? ` — ${recipientUser.title}` : ""}` : "External / not linked",
                },
                { label: "Department", value: department?.name ?? "—" },
                {
                  label: "Project",
                  value: project ? `${project.code} — ${project.name}` : "—",
                },
                { label: "Requested by", value: `${issue.requestedBy.name}${issue.requestedBy.title ? ` — ${issue.requestedBy.title}` : ""}` },
                { label: "Requested at", value: fmtDateTime(issue.requestedAt) },
                { label: "Approved at", value: issue.approvedAt ? fmtDateTime(issue.approvedAt) : "Not approved" },
                { label: "Released at", value: issue.issuedAt ? fmtDateTime(issue.issuedAt) : "Not released" },
                { label: "Purpose", value: issue.purpose ?? "—", span: true },
                { label: "Remarks", value: issue.remarks ?? "—", span: true },
              ]}
            />
          </SectionCard>

          <SectionCard title="Ledger impact">
            <div className="space-y-2 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[var(--c-text-secondary)]">Outstanding to release</span>
                <span className="tnum font-500">{qty(outstanding)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[var(--c-text-secondary)]">Movements posted</span>
                <span className="tnum font-500">{issue.transactions.length}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-[var(--c-border-subtle)] pt-2">
                <span className="text-[var(--c-text-secondary)]">Value consumed</span>
                <span className="tnum font-600">{money(ledgerValue)}</span>
              </div>
              {issue.transactions.length === 0 && (
                <p className="pt-1 text-2xs text-[var(--c-text-tertiary)]">
                  No inventory has moved yet. Stock only leaves the ledger when the issue is released.
                </p>
              )}
            </div>
          </SectionCard>

          {issue.status === "PENDING_APPROVAL" && canApprove && (
            <InlineAlert tone="info">
              Approving confirms the quantity is justified and available. The store still has to physically release the
              stock as a separate, recorded step.
            </InlineAlert>
          )}
        </div>
      </div>

      {issue.transactions.length > 0 && (
        <SectionCard
          title="Inventory movements"
          description="Immutable ledger entries written when this issue was released."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Movement</th>
                  <th>Item</th>
                  <th className="text-right">Quantity</th>
                  <th className="text-right">Unit cost</th>
                  <th className="text-right">Value</th>
                  <th className="text-right">Balance after</th>
                  <th>Source</th>
                  <th>Posted at</th>
                </tr>
              </thead>
              <tbody>
                {issue.transactions.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Mono>{t.number}</Mono>
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        <Badge tone={t.quantity < 0 ? "danger" : "success"}>{humanize(t.type)}</Badge>
                      </span>
                    </td>
                    <td className="text-xs">{t.item.name}</td>
                    <td className="num text-xs">{qty(t.quantity, t.unit)}</td>
                    <td className="num text-xs">{money(t.unitCost)}</td>
                    <td className="num text-xs">{money(Math.abs(t.value))}</td>
                    <td className="num text-xs">{qty(t.balanceAfter)}</td>
                    <td className="text-2xs">
                      {humanize(t.sourceType)}
                      {t.sourceRef && <span className="mono block">{t.sourceRef}</span>}
                    </td>
                    <td className="text-xs">{fmtDateTime(t.performedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <DocumentsPanel
          user={user}
          linkedType="STORE_ISSUE"
          linkedId={issue.id}
          entityId={issue.store.entityId}
          title="Issue documents"
          description="Signed issue slip, requisition note and any acknowledgement of receipt."
          defaultCategory="Store"
        />
        <SectionCard title="Activity">
          <Timeline events={events} emptyLabel="No activity recorded yet." />
        </SectionCard>
      </div>
    </div>
  );
}
