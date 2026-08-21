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
  StatusBadge,
} from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/forms";
import { LifecycleRail, Timeline, buildRail } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { ExceptionsPanel } from "@/components/domain/ExceptionsPanel";
import { PETTY_CASH_LIFECYCLE, STORE_ENTRY_DISPOSITIONS, humanize } from "@/lib/domain";
import { fmtDate, fmtDateTime, money, qty, round2 } from "@/lib/format";
import {
  beginQuotesAction,
  closePettyCashAction,
  decidePettyCashAction,
  generateVoucherAction,
  reconcileAction,
  signVoucherAction,
  submitPettyCashAction,
} from "../actions";
import { AddQuoteForm, RecordPurchaseForm, SelectQuoteForm, StoreEntryForm } from "../StageForms";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pc = await prisma.pettyCashRequest.findUnique({ where: { id }, select: { number: true } });
  return { title: pc ? `${pc.number} — Petty cash` : "Petty cash" };
}

export default async function PettyCashDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.PETTY_CASH_VIEW);
  if (!authorized) return <AccessDenied title="Petty cash request" />;

  const pc = await prisma.pettyCashRequest.findUnique({
    where: { id },
    include: {
      entity: { select: { id: true, code: true, name: true } },
      department: { select: { name: true, code: true } },
      requester: { select: { id: true, name: true, title: true } },
      items: {
        orderBy: { lineNo: "asc" },
        include: { item: { select: { id: true, sku: true, name: true, unit: true } } },
      },
      quotes: { orderBy: { amount: "asc" }, include: { vendor: { select: { id: true, name: true } } } },
      vouchers: { orderBy: { preparedAt: "asc" } },
      transactions: {
        orderBy: { performedAt: "asc" },
        include: { item: { select: { sku: true, name: true } }, store: { select: { id: true, name: true } } },
      },
    },
  });
  if (!pc) notFound();

  const [events, limit, minQuotes, stores, catalogue, vendors, approver] = await Promise.all([
    documentTimeline("PettyCashRequest", pc.id),
    getConfigNumber(CONFIG_KEYS.PETTY_CASH_LIMIT, pc.entityId),
    getConfigNumber(CONFIG_KEYS.PETTY_CASH_MIN_QUOTES, pc.entityId),
    prisma.store.findMany({
      where: { active: true, entityId: pc.entityId },
      select: { id: true, code: true, name: true, kind: true },
      orderBy: { name: "asc" },
    }),
    prisma.item.findMany({
      where: { active: true },
      select: { id: true, sku: true, name: true, unit: true },
      orderBy: { name: "asc" },
    }),
    prisma.vendor.findMany({
      where: { status: { in: ["APPROVED", "CONDITIONAL"] } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    pc.approvedById
      ? prisma.user.findUnique({ where: { id: pc.approvedById }, select: { name: true } })
      : Promise.resolve(null),
  ]);

  const canCreate = userHasPermission(user, P.PETTY_CASH_CREATE);
  const canEvaluate = userHasPermission(user, P.PETTY_CASH_EVALUATE);
  const canApprove = userHasPermission(user, P.PETTY_CASH_APPROVE);
  const canReconcile = userHasPermission(user, P.PETTY_CASH_RECONCILE);
  const canStore = userHasPermission(user, P.INVENTORY_ADJUST, P.STORE_ISSUE, P.GRN_POST);
  const isRequester = pc.requesterId === user.id;

  const selected = pc.quotes.find((q) => q.isSelected);
  const lowest = pc.quotes.length ? Math.min(...pc.quotes.map((q) => q.amount)) : 0;
  const voucher = pc.vouchers[pc.vouchers.length - 1];
  const storeLines = pc.items.filter((i) => STORE_ENTRY_DISPOSITIONS.includes(i.disposition as never));
  const unbooked = storeLines.filter((i) => !i.storeEntered);
  const lineTotal = round2(pc.items.reduce((a, i) => a + i.lineTotal, 0));
  const amount = pc.actualAmount ?? pc.approvedAmount ?? pc.estimatedAmount;
  const savedAgainstEstimate =
    pc.actualAmount !== null ? round2(pc.estimatedAmount - pc.actualAmount) : null;

  const receiptOnFile = await prisma.document.count({
    where: { linkedType: "PETTY_CASH", linkedId: pc.id, archived: false, category: { in: ["Receipt", "Invoice"] } },
  });

  const blockers: string[] = [];
  if (pc.quotes.length < minQuotes && !["CLOSED", "RECONCILED", "REJECTED", "CANCELLED"].includes(pc.status)) {
    blockers.push(
      `${pc.quotes.length} of ${minQuotes} required market quotation${minQuotes === 1 ? "" : "s"} recorded.`,
    );
  }
  if (unbooked.length > 0) {
    blockers.push(
      `${unbooked.length} purchased line${unbooked.length === 1 ? "" : "s"} with a store-bound disposition have not been entered into a store. Reconciliation and closure are blocked.`,
    );
  }
  if (pc.estimatedAmount > limit) {
    blockers.push(`Estimated ${money(pc.estimatedAmount)} is above the ${money(limit)} petty cash ceiling.`);
  }
  if (["PURCHASED", "RECEIPT_UPLOADED"].includes(pc.status) && receiptOnFile === 0 && !pc.receiptRef) {
    blockers.push("No purchase receipt is on file — the voucher cannot be generated until one is attached.");
  }

  const rail = buildRail(
    PETTY_CASH_LIFECYCLE,
    pc.status,
    {
      DRAFT: { at: pc.createdAt, owner: pc.requester.name },
      APPROVED: { at: pc.approvedAt, owner: approver?.name ?? null },
      PURCHASED: { at: pc.purchasedAt, owner: pc.requester.name },
      VOUCHER_GENERATED: { at: voucher?.preparedAt ?? null, owner: null },
      VOUCHER_APPROVED: { at: voucher?.signedAt ?? null, owner: null },
      STORE_ENTRY_DONE: { at: pc.storeEntryDoneAt, owner: null },
      RECONCILED: { at: pc.reconciledAt, owner: null },
      CLOSED: { at: pc.closedAt, owner: null },
    },
    {
      terminalBad: ["REJECTED", "CANCELLED"].includes(pc.status),
      skipped: pc.storeRequired ? [] : ["STORE_ENTRY_PENDING", "STORE_ENTRY_DONE"],
      blockedNote: blockers[0] ?? null,
    },
  );

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Procurement", href: "/petty-cash" },
          { label: "Petty cash", href: "/petty-cash" },
          { label: pc.number },
        ]}
      />

      <PageHeader
        eyebrow={`${pc.entity.code} · ${pc.department.name}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-[var(--c-text-secondary)]">{pc.number}</span>
            <span>{pc.purpose}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={pc.status} />
            </MetaItem>
            <MetaItem label="Amount">{money(amount)}</MetaItem>
            <MetaItem label="Ceiling">{money(limit)}</MetaItem>
            <MetaItem label="Raised">{fmtDate(pc.createdAt)}</MetaItem>
            <MetaItem label="Requested by">{pc.requester.name}</MetaItem>
            <MetaItem label="Store entry">
              {!pc.storeRequired ? (
                <Badge tone="neutral">Not required</Badge>
              ) : unbooked.length === 0 ? (
                <Badge tone="success">Complete</Badge>
              ) : (
                <Badge tone="danger">{unbooked.length} pending</Badge>
              )}
            </MetaItem>
          </>
        }
        actions={
          <>
            {pc.status === "DRAFT" && (isRequester || canEvaluate) && (
              <ActionButton
                action={submitPettyCashAction}
                payload={{ requestId: pc.id }}
                label="Submit for evaluation"
                tone="primary"
              />
            )}
            {["SUBMITTED", "UNDER_EVALUATION"].includes(pc.status) && canEvaluate && (
              <ActionButton
                action={beginQuotesAction}
                payload={{ requestId: pc.id }}
                label="Start quote collection"
                tone="secondary"
              />
            )}
            {["SUBMITTED", "UNDER_EVALUATION", "QUOTES_PENDING", "QUOTES_COMPARED"].includes(pc.status) && canEvaluate && (
              <AddQuoteForm
                requestId={pc.id}
                vendors={vendors}
                quotesSoFar={pc.quotes.length}
                minQuotes={minQuotes}
              />
            )}
            {["QUOTES_PENDING", "QUOTES_COMPARED"].includes(pc.status) &&
              canEvaluate &&
              pc.quotes.length >= minQuotes && (
                <SelectQuoteForm
                  requestId={pc.id}
                  quotes={pc.quotes.map((q) => ({
                    id: q.id,
                    vendorName: q.vendorName,
                    amount: q.amount,
                    channel: q.channel,
                    deliveryDays: q.deliveryDays,
                  }))}
                />
              )}
            {pc.status === "PENDING_APPROVAL" && canApprove && (
              <>
                <ActionButton
                  action={decidePettyCashAction}
                  payload={{ requestId: pc.id, approve: "true", approvedAmount: selected?.amount ?? pc.estimatedAmount }}
                  label="Approve cash purchase"
                  tone="primary"
                  confirm={`Approve ${money(selected?.amount ?? pc.estimatedAmount)} for ${selected?.vendorName ?? "this purchase"}?`}
                />
                <ActionButton
                  action={decidePettyCashAction}
                  payload={{ requestId: pc.id, approve: "false" }}
                  label="Reject"
                  tone="danger-soft"
                  reasonLabel="Why is this cash purchase being rejected?"
                  reasonRequired
                />
              </>
            )}
            {pc.status === "APPROVED" && (isRequester || canEvaluate) && (
              <RecordPurchaseForm
                requestId={pc.id}
                approvedAmount={pc.approvedAmount ?? pc.estimatedAmount}
                defaultVendor={selected?.vendorName ?? ""}
                items={pc.items.map((i) => ({
                  id: i.id,
                  description: i.description,
                  quantity: i.quantity,
                  unit: i.unit,
                  estimatedUnitPrice: i.estimatedUnitPrice,
                }))}
              />
            )}
            {["PURCHASED", "RECEIPT_UPLOADED"].includes(pc.status) && (canEvaluate || canApprove) && (
              <ActionButton
                action={generateVoucherAction}
                payload={{ requestId: pc.id }}
                label="Generate voucher"
                tone="primary"
                disabled={receiptOnFile === 0 && !pc.receiptRef}
                disabledReason="Attach the purchase receipt first."
              />
            )}
            {voucher?.status === "PENDING_SIGNATORY" && canApprove && (
              <>
                <ActionButton
                  action={signVoucherAction}
                  payload={{ voucherId: voucher.id, requestId: pc.id, approve: "true" }}
                  label={`Sign ${voucher.number}`}
                  tone="primary"
                  confirm={`Sign voucher ${voucher.number} for ${money(voucher.amount)}?`}
                />
                <ActionButton
                  action={signVoucherAction}
                  payload={{ voucherId: voucher.id, requestId: pc.id, approve: "false" }}
                  label="Reject voucher"
                  tone="danger-soft"
                  reasonLabel="Why is the voucher being rejected?"
                  reasonRequired
                />
              </>
            )}
            {["VOUCHER_APPROVED", "STORE_ENTRY_PENDING"].includes(pc.status) && unbooked.length > 0 && canStore && (
              <StoreEntryForm
                requestId={pc.id}
                stores={stores}
                defaultStoreId={pc.storeId}
                catalogue={catalogue}
                items={pc.items
                  .filter((i) => STORE_ENTRY_DISPOSITIONS.includes(i.disposition as never))
                  .map((i) => ({
                    id: i.id,
                    description: i.description,
                    quantity: i.quantity,
                    unit: i.unit,
                    disposition: i.disposition,
                    itemId: i.itemId,
                    actualUnitPrice: i.actualUnitPrice,
                    estimatedUnitPrice: i.estimatedUnitPrice,
                    storeEntered: i.storeEntered,
                  }))}
              />
            )}
            {["VOUCHER_APPROVED", "STORE_ENTRY_DONE"].includes(pc.status) && canReconcile && (
              <ActionButton
                action={reconcileAction}
                payload={{ requestId: pc.id }}
                label="Reconcile"
                tone="primary"
                disabled={unbooked.length > 0}
                disabledReason={
                  unbooked.length > 0 ? "Every stored line must be entered into a store first." : undefined
                }
                reasonLabel="Reconciliation notes (optional)"
              />
            )}
            {pc.status === "RECONCILED" && (canReconcile || canApprove) && (
              <ActionButton
                action={closePettyCashAction}
                payload={{ requestId: pc.id }}
                label="Close request"
                tone="success"
                confirm={`Close ${pc.number}? No further changes will be possible.`}
              />
            )}
          </>
        }
      />

      {pc.status === "REJECTED" && (
        <BlockedNotice tone="danger" title="This request was rejected" reasons={["See the activity trail for the recorded reason."]} />
      )}

      {blockers.length > 0 && <BlockedNotice title="Outstanding controls" reasons={blockers} />}

      {unbooked.length > 0 && (
        <InlineAlert tone="danger">
          This is the gap the system is built to close: cash was spent on goods that belong in a store, and until the
          store entry is posted the request cannot be reconciled or closed — no matter who approves it.
        </InlineAlert>
      )}

      <LifecycleRail steps={rail} title="Petty cash lifecycle" />

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <div className="space-y-4">
          <SectionCard title="Items" bodyClassName="px-0 py-0">
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: "3rem" }}>#</th>
                    <th style={{ minWidth: "16rem" }}>Description</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">Est. unit</th>
                    <th className="text-right">Actual unit</th>
                    <th className="text-right">Line total</th>
                    <th>Disposition</th>
                    <th>Store entry</th>
                  </tr>
                </thead>
                <tbody>
                  {pc.items.map((i) => {
                    const needsStore = STORE_ENTRY_DISPOSITIONS.includes(i.disposition as never);
                    return (
                      <tr key={i.id}>
                        <td className="num text-xs text-[var(--c-text-tertiary)]">{i.lineNo}</td>
                        <td>
                          <span className="block text-xs font-500">{i.description}</span>
                          {i.item && (
                            <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                              <Mono>{i.item.sku}</Mono> {i.item.name}
                            </span>
                          )}
                        </td>
                        <td className="num text-xs">{qty(i.quantity, i.unit)}</td>
                        <td className="num text-xs">{i.estimatedUnitPrice ? money(i.estimatedUnitPrice) : "—"}</td>
                        <td className="num text-xs">{i.actualUnitPrice ? money(i.actualUnitPrice) : "—"}</td>
                        <td className="num text-xs">{i.lineTotal ? money(i.lineTotal) : "—"}</td>
                        <td className="text-2xs">
                          <Badge tone={needsStore ? "info" : "neutral"}>{humanize(i.disposition)}</Badge>
                        </td>
                        <td className="text-2xs">
                          {!needsStore ? (
                            <span className="text-[var(--c-text-tertiary)]">Not required</span>
                          ) : i.storeEntered ? (
                            <Badge tone="success">Entered</Badge>
                          ) : (
                            <Badge tone="danger">Pending</Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5} className="text-xs font-600">
                      Total
                    </td>
                    <td className="num text-xs font-600">{lineTotal > 0 ? money(lineTotal) : money(pc.estimatedAmount)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </SectionCard>

          <SectionCard
            title="Market quotes"
            description={`Policy requires at least ${minQuotes} written quotation${minQuotes === 1 ? "" : "s"}. Quotes taken by phone or WhatsApp count, provided the channel and contact are recorded.`}
            bodyClassName="px-0 py-0"
          >
            {pc.quotes.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-[var(--c-text-secondary)]">
                No market quotes recorded yet.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Vendor / shop</th>
                      <th>Channel</th>
                      <th>Contact</th>
                      <th className="text-right">Amount</th>
                      <th>Tax</th>
                      <th className="text-right">Delivery</th>
                      <th>Recorded</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pc.quotes.map((q) => (
                      <tr key={q.id}>
                        <td>
                          {q.vendor ? (
                            <RefLink href={`/vendors/${q.vendor.id}`}>{q.vendorName}</RefLink>
                          ) : (
                            <span className="text-xs">{q.vendorName}</span>
                          )}
                        </td>
                        <td className="text-2xs">{humanize(q.channel)}</td>
                        <td className="text-2xs text-[var(--c-text-secondary)]">{q.contactRef ?? "—"}</td>
                        <td className="num text-xs font-500">{money(q.amount)}</td>
                        <td className="text-2xs">{q.taxIncluded ? "Inclusive" : "Exclusive"}</td>
                        <td className="num text-2xs">{q.deliveryDays !== null ? `${q.deliveryDays} d` : "—"}</td>
                        <td className="text-2xs">{fmtDate(q.quotedAt)}</td>
                        <td>
                          {q.isSelected ? (
                            <Badge tone="success">Selected</Badge>
                          ) : q.amount <= lowest + 0.01 ? (
                            <Badge tone="info">Lowest</Badge>
                          ) : (
                            <span className="text-2xs text-[var(--c-text-tertiary)]">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          {pc.transactions.length > 0 && (
            <SectionCard
              title="Store entry — inventory movements"
              description="Proof the purchased goods reached a store. These are ordinary ledger receipts, identical in weight to a GRN posting."
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
                      <th className="text-right">Unit cost</th>
                      <th className="text-right">Value</th>
                      <th className="text-right">Balance after</th>
                      <th>Posted at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pc.transactions.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <Mono>{t.number}</Mono>
                        </td>
                        <td className="text-xs">
                          <RefLink href={`/stores/${t.store.id}`}>{t.store.name}</RefLink>
                        </td>
                        <td className="text-xs">{t.item.name}</td>
                        <td className="num text-xs text-[var(--c-success)]">+{qty(t.quantity, t.unit)}</td>
                        <td className="num text-xs">{money(t.unitCost)}</td>
                        <td className="num text-xs">{money(t.value)}</td>
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
          <SectionCard title="Request">
            <DefList
              items={[
                { label: "Request number", value: <Mono>{pc.number}</Mono> },
                { label: "Entity", value: pc.entity.name },
                { label: "Department", value: pc.department.name },
                {
                  label: "Requested by",
                  value: `${pc.requester.name}${pc.requester.title ? ` — ${pc.requester.title}` : ""}`,
                },
                { label: "Raised at", value: fmtDateTime(pc.createdAt) },
                { label: "Required by", value: pc.requiredDate ? fmtDate(pc.requiredDate) : "—" },
                { label: "Estimated", value: money(pc.estimatedAmount) },
                { label: "Approved", value: pc.approvedAmount ? money(pc.approvedAmount) : "Not approved" },
                { label: "Actual spend", value: pc.actualAmount ? money(pc.actualAmount) : "Not purchased" },
                {
                  label: "Variance to estimate",
                  value:
                    savedAgainstEstimate === null ? (
                      "—"
                    ) : (
                      <span className={savedAgainstEstimate < 0 ? "text-[var(--c-danger)]" : "text-[var(--c-success)]"}>
                        {savedAgainstEstimate < 0 ? "+" : "−"}
                        {money(Math.abs(savedAgainstEstimate))}
                      </span>
                    ),
                },
                { label: "Approved by", value: approver?.name ?? "—" },
                { label: "Approved at", value: pc.approvedAt ? fmtDateTime(pc.approvedAt) : "—" },
                { label: "Purchased from", value: pc.purchasedFromVendor ?? "—" },
                { label: "Purchased at", value: pc.purchasedAt ? fmtDateTime(pc.purchasedAt) : "—" },
                { label: "Receipt reference", value: pc.receiptRef ? <Mono>{pc.receiptRef}</Mono> : "—" },
                {
                  label: "Receiving store",
                  value: pc.storeId
                    ? ((stores.find((s) => s.id === pc.storeId)?.name ?? "Selected store"))
                    : pc.storeRequired
                      ? "Not yet chosen"
                      : "Not stored",
                },
                { label: "Store entry completed", value: pc.storeEntryDoneAt ? fmtDateTime(pc.storeEntryDoneAt) : "—" },
                { label: "Reconciled at", value: pc.reconciledAt ? fmtDateTime(pc.reconciledAt) : "—" },
                { label: "Closed at", value: pc.closedAt ? fmtDateTime(pc.closedAt) : "—" },
                { label: "Purpose", value: pc.purpose, span: true },
                { label: "Justification", value: pc.justification ?? "—", span: true },
              ]}
            />
          </SectionCard>

          <SectionCard title="Vouchers">
            {pc.vouchers.length === 0 ? (
              <p className="text-xs text-[var(--c-text-secondary)]">
                No voucher generated yet. A voucher is produced once the purchase and its receipt are recorded.
              </p>
            ) : (
              <ul className="space-y-3">
                {pc.vouchers.map((v) => (
                  <li key={v.id} className="rounded-[var(--radius-md)] border border-[var(--c-border)] px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <Mono>{v.number}</Mono>
                      <StatusBadge status={v.status} />
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-2xs">
                      <div>
                        <dt className="text-[var(--c-text-tertiary)]">Amount</dt>
                        <dd className="tnum font-500">{money(v.amount)}</dd>
                      </div>
                      <div>
                        <dt className="text-[var(--c-text-tertiary)]">Payee</dt>
                        <dd>{v.payeeName}</dd>
                      </div>
                      <div>
                        <dt className="text-[var(--c-text-tertiary)]">Prepared</dt>
                        <dd>{fmtDateTime(v.preparedAt)}</dd>
                      </div>
                      <div>
                        <dt className="text-[var(--c-text-tertiary)]">Signed</dt>
                        <dd>{v.signedAt ? fmtDateTime(v.signedAt) : "Awaiting signatory"}</dd>
                      </div>
                    </dl>
                    {v.notes && <p className="mt-1.5 text-2xs text-[var(--c-text-secondary)]">{v.notes}</p>}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <ExceptionsPanel where={{ caseKey: pc.number }} title="Exceptions on this request" />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <DocumentsPanel
          user={user}
          linkedType="PETTY_CASH"
          linkedId={pc.id}
          entityId={pc.entityId}
          title="Receipts and documents"
          description="The purchase receipt is mandatory before a voucher can be generated. Attach the signed voucher too."
          defaultCategory="Receipt"
        />
        <SectionCard title="Activity">
          <Timeline events={events} emptyLabel="No activity recorded yet." />
        </SectionCard>
      </div>

      {!canCreate && !canEvaluate && !canApprove && (
        <InlineAlert tone="info">
          You have read-only access to petty cash. Actions are limited to the roles that hold the corresponding
          permission.
        </InlineAlert>
      )}
    </div>
  );
}
