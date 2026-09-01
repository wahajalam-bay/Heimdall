import { notFound } from "next/navigation";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  DefList,
  InlineAlert,
  Mono,
  PageHeader,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/forms";
import { LifecycleRail, Timeline, buildRail } from "@/components/ui/workflow";
import { documentTimeline } from "@/server/timeline";
import { money, fmtDateTime, qty } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { stockCountDetail } from "@/server/stock-count";
import { CountSheet } from "./CountSheet";
import {
  adjustFromCountAction,
  closeStockCountAction,
  reviewStockCountAction,
  submitStockCountAction,
} from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await stockCountDetail(id);
  return { title: c ? `${c.number} — Stock count` : "Stock count" };
}

const RAIL = ["COUNTING", "REVIEW", "APPROVED", "ADJUSTED", "CLOSED"] as const;

export default async function StockCountPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, authorized } = await pageContext(P.INVENTORY_VIEW);
  if (!authorized) return <AccessDenied title="Stock count" />;

  const { id } = await params;
  const c = await stockCountDetail(id);
  if (!c) notFound();

  const events = await documentTimeline("StockCount", c.id);

  const canCount = userHasPermission(user, P.INVENTORY_ADJUST, P.AUDIT_VIEW, P.STORE_ISSUE);
  const canReview = userHasPermission(user, P.AUDIT_VIEW, P.INVENTORY_ADJUST);
  const canAdjust = userHasPermission(user, P.INVENTORY_ADJUST);
  const isCounter = c.countedById === user.id;

  const uncounted = c.lines.filter((l) => l.countedQty === null);
  const variances = c.lines.filter((l) => Math.abs(l.varianceQty ?? 0) > 1e-9);
  const unadjusted = variances.filter((l) => !l.adjustmentTxnId);
  const netValue = variances.reduce((a, l) => a + (l.varianceValue ?? 0), 0);
  const open = ["COUNTING", "DRAFT"].includes(c.status);

  const rail = buildRail([...RAIL], c.status === "CANCELLED" ? "CLOSED" : c.status, {
    REVIEW: { at: c.countedAt, owner: c.countedBy?.name ?? null },
    APPROVED: { at: c.reviewedAt, owner: c.reviewedBy?.name ?? null },
    ADJUSTED: { at: c.adjustedAt, owner: null },
    CLOSED: { at: c.closedAt, owner: null },
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Stores", href: "/inventory" },
          { label: "Counts", href: "/inventory/counts" },
          { label: c.number },
        ]}
      />

      <PageHeader
        eyebrow={`${c.store.name} · ${humanize(c.countType)} count`}
        title={<Mono className="text-[1rem]">{c.number}</Mono>}
        meta={<StatusBadge status={c.status} />}
        actions={
          <>
            {c.status === "COUNTING" && canCount && (
              <ActionButton
                action={submitStockCountAction}
                payload={{ countId: c.id }}
                label="Submit for review"
                tone="primary"
                disabled={uncounted.length > 0}
                disabledReason={
                  uncounted.length > 0
                    ? `${uncounted.length} line(s) still uncounted. Record zero where the shelf is empty.`
                    : undefined
                }
              />
            )}
            {c.status === "REVIEW" && canReview && !isCounter && (
              <ActionButton
                action={reviewStockCountAction}
                payload={{ countId: c.id }}
                label="Review and approve"
                tone="primary"
                reasonLabel="Review note (optional)"
              />
            )}
            {["APPROVED"].includes(c.status) && canAdjust && unadjusted.length > 0 && (
              <ActionButton
                action={adjustFromCountAction}
                payload={{ countId: c.id }}
                label={`Post ${unadjusted.length} adjustment${unadjusted.length === 1 ? "" : "s"}`}
                tone="primary"
                confirm={`Correct the ledger for ${unadjusted.length} line(s)? Each posts as an inventory adjustment carrying ${c.number} as its reason.`}
              />
            )}
            {["APPROVED", "ADJUSTED"].includes(c.status) && canAdjust && (
              <ActionButton
                action={closeStockCountAction}
                payload={{ countId: c.id }}
                label="Close"
                tone="secondary"
              />
            )}
            {open && canCount && (
              <ActionButton
                action={closeStockCountAction}
                payload={{ countId: c.id, cancel: "true" }}
                label="Cancel"
                tone="danger-soft"
                reasonLabel="Why the count is being cancelled"
                reasonRequired
              />
            )}
          </>
        }
      />

      {c.status === "REVIEW" && isCounter && canReview && (
        <InlineAlert tone="info">
          You counted this sheet, so you cannot review it. ZAM/PUR/SOP-01 puts the monthly store audit with Internal
          Audit so the count and its review are two people.
        </InlineAlert>
      )}

      {uncounted.length > 0 && open && (
        <InlineAlert tone="warning">
          {uncounted.length} line{uncounted.length === 1 ? "" : "s"} not yet counted. A blank line and an empty shelf
          are not the same thing — record zero where the shelf is empty.
        </InlineAlert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="Lines" value={c.lines.length} hint={`${c.lines.length - uncounted.length} counted`} />
        <StatTile
          label="Variances"
          value={variances.length}
          tone={variances.length ? "warning" : undefined}
        />
        <StatTile
          label="Net variance value"
          value={money(netValue)}
          hint={netValue < 0 ? "Ledger over-stated" : netValue > 0 ? "Ledger under-stated" : "Balanced"}
          tone={Math.abs(netValue) > 1 ? "warning" : undefined}
        />
        <StatTile
          label="Still to correct"
          value={unadjusted.length}
          hint={unadjusted.length ? "Awaiting adjustment" : "None outstanding"}
        />
      </div>

      <LifecycleRail steps={rail} title="Count lifecycle" />

      <SectionCard title="Sheet detail">
        <DefList
          columns={2}
          items={[
            { label: "Store", value: c.store.name },
            { label: "Type", value: humanize(c.countType) },
            {
              label: "Ledger frozen at",
              value: c.snapshotAt ? fmtDateTime(c.snapshotAt) : "—",
            },
            { label: "Opened by", value: c.createdBy.name },
            { label: "Counted by", value: c.countedBy?.name ?? "—" },
            { label: "Counted", value: c.countedAt ? fmtDateTime(c.countedAt) : "—" },
            { label: "Reviewed by", value: c.reviewedBy?.name ?? "—" },
            { label: "Reviewed", value: c.reviewedAt ? fmtDateTime(c.reviewedAt) : "—" },
            ...(c.scopeNote ? [{ label: "Scope", value: c.scopeNote, span: true as const }] : []),
            ...(c.reviewNotes ? [{ label: "Review note", value: c.reviewNotes, span: true as const }] : []),
          ]}
        />
      </SectionCard>

      <CountSheet
        countId={c.id}
        editable={open && canCount}
        lines={c.lines.map((l) => ({
          id: l.id,
          lineNo: l.lineNo,
          sku: l.item.sku,
          name: l.item.name,
          batch: l.serialNumber ?? l.batchNumber ?? null,
          unit: l.unit,
          expectedQty: l.expectedQty,
          countedQty: l.countedQty,
          varianceQty: l.varianceQty,
          varianceValue: l.varianceValue,
          reason: l.varianceReason,
          adjusted: Boolean(l.adjustmentTxnId),
        }))}
      />

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        Expected quantities are as at {c.snapshotAt ? fmtDateTime(c.snapshotAt) : "the snapshot"} — the moment the
        sheet was cut, not now. Anything received or issued since then is a movement on the ledger, not a
        discrepancy on this sheet.
      </p>

      <SectionCard title="Activity">
        <Timeline events={events} />
      </SectionCard>
    </div>
  );
}
