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
  SectionCard,
  StatusBadge,
} from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/forms";
import { LifecycleRail, Timeline, buildRail } from "@/components/ui/workflow";
import { documentTimeline } from "@/server/timeline";
import { fmtDateTime, qty } from "@/lib/format";
import { humanize } from "@/lib/domain";
import {
  employeeReturnDetail,
  RETURN_REASON_LABELS,
  type ReturnReason,
} from "@/server/employee-returns";
import { InspectReturn } from "./InspectReturn";
import { closeReturnAction, stackReturnAction } from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await employeeReturnDetail(id);
  return { title: r ? `${r.number} — Employee return` : "Employee return" };
}

const RAIL = ["RECEIVED", "PENDING_INSPECTION", "ACCEPTED", "STACKED", "CLOSED"] as const;

export default async function EmployeeReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, authorized } = await pageContext(P.INVENTORY_VIEW);
  if (!authorized) return <AccessDenied title="Employee return" />;

  const { id } = await params;
  const r = await employeeReturnDetail(id);
  if (!r) notFound();

  const events = await documentTimeline("EmployeeReturn", r.id);

  const canInspect = userHasPermission(user, P.INSPECTION_PERFORM, P.RECEIVE_GOODS);
  const canHandle = userHasPermission(user, P.RECEIVE_GOODS, P.STORE_ISSUE, P.INVENTORY_ADJUST);

  const pending = r.items.filter((i) => i.inspectionVerdict === null);
  const failed = r.items.filter((i) => i.inspectionVerdict === "FAIL");
  const forRepair = r.items.filter((i) => i.disposition === "REPAIR");
  const toStack = r.items.filter((i) => i.disposition === "STACK" && !i.movementTxnId);
  const stacked = r.items.filter((i) => i.movementTxnId);

  // The Inspection step only appears on the rail where it applies. Showing it on
  // a return with no IT equipment would make a correctly-routed one look as
  // though it had skipped a gate.
  const rail = buildRail(
    RAIL.filter((s) => r.inspectionRequired || s !== "PENDING_INSPECTION"),
    ["INSPECTION_FAILED", "AT_REPAIR"].includes(r.status) ? "PENDING_INSPECTION" : r.status === "CANCELLED" ? "CLOSED" : r.status,
    {
      RECEIVED: { at: r.receivedAt, owner: r.receivedBy?.name ?? null },
      PENDING_INSPECTION: { at: r.inspectedAt, owner: r.inspectedBy?.name ?? null },
      STACKED: { at: r.stackedAt, owner: null },
      CLOSED: { at: r.closedAt, owner: null },
    },
  );

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Stores", href: "/inventory" },
          { label: "Employee returns", href: "/inventory/returns" },
          { label: r.number },
        ]}
      />

      <PageHeader
        eyebrow={`${r.store.name} · ${RETURN_REASON_LABELS[r.reason as ReturnReason] ?? humanize(r.reason)}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <Mono className="text-[1rem] text-muted">{r.number}</Mono>
            <span>{r.returnedByName}</span>
          </span>
        }
        meta={<StatusBadge status={r.status} />}
        actions={
          <>
            {toStack.length > 0 && canHandle && pending.length === 0 && (
              <ActionButton
                action={stackReturnAction}
                payload={{ returnId: r.id }}
                label={`Stack ${toStack.length} line${toStack.length === 1 ? "" : "s"}`}
                tone="primary"
                confirm={`Take ${toStack.length} line(s) back into stock at ${r.store.name}?`}
              />
            )}
            {["STACKED", "AT_REPAIR", "ACCEPTED"].includes(r.status) && canHandle && (
              <ActionButton
                action={closeReturnAction}
                payload={{ returnId: r.id }}
                label="Close"
                tone="secondary"
              />
            )}
            {!["CLOSED", "CANCELLED", "STACKED"].includes(r.status) && canHandle && (
              <ActionButton
                action={closeReturnAction}
                payload={{ returnId: r.id, cancel: "true" }}
                label="Cancel"
                tone="danger-soft"
                reasonLabel="Why the return is being cancelled"
                reasonRequired
              />
            )}
          </>
        }
      />

      {r.status === "INSPECTION_FAILED" && forRepair.length > 0 && !r.repairHandoffAt && (
        <BlockedNotice
          title={`${forRepair.length} unit${forRepair.length === 1 ? "" : "s"} failed inspection`}
          reasons={[
            "The SOP sends failed units to the Repair and Maintenance department, not back on the shelf. Record the hand-off below — until then nothing says where they are.",
          ]}
        />
      )}

      {r.inspectionRequired && pending.length > 0 && (
        <InlineAlert tone="warning">
          {pending.length} line{pending.length === 1 ? "" : "s"} of IT equipment awaiting inspection. Nothing is
          stacked until the inspection is done — the SOP inspects before stacking, not after.
        </InlineAlert>
      )}

      {!r.inspectionRequired && (
        <InlineAlert tone="info">
          No IT equipment on this note, so no inspection applies. ZAM/PUR/SOP-01 inspects IT equipment only.
        </InlineAlert>
      )}

      <LifecycleRail steps={rail} title="Return lifecycle" />

      <SectionCard title="Receiving note">
        <DefList
          columns={2}
          items={[
            { label: "SRN", value: r.srnNumber ?? r.number },
            { label: "Store", value: r.store.name },
            { label: "Returned by", value: r.returnedByName },
            { label: "Department", value: r.department ?? "—" },
            {
              label: "Reason",
              value: `${RETURN_REASON_LABELS[r.reason as ReturnReason] ?? humanize(r.reason)}${r.reasonNote ? ` — ${r.reasonNote}` : ""}`,
            },
            { label: "Received by", value: r.receivedBy?.name ?? "—" },
            { label: "Received", value: r.receivedAt ? fmtDateTime(r.receivedAt) : "—" },
            {
              label: "IT inspection",
              value: r.inspectionRequired
                ? `${r.inspectionResult ? humanize(r.inspectionResult) : "Pending"}${r.inspectedBy ? ` — ${r.inspectedBy.name}` : ""}`
                : "Not applicable",
            },
            ...(r.repairHandoffRef
              ? [
                  {
                    label: "Repair hand-off",
                    value: `${r.repairHandoffRef}${r.repairHandoffAt ? ` · ${fmtDateTime(r.repairHandoffAt)}` : ""}`,
                    span: true as const,
                  },
                ]
              : []),
            ...(r.receiptNotes ? [{ label: "Notes", value: r.receiptNotes, span: true as const }] : []),
          ]}
        />
      </SectionCard>

      <InspectReturn
        returnId={r.id}
        canInspect={canInspect && r.inspectionRequired && pending.length > 0}
        canHandOff={canHandle && failed.length > 0 && !r.repairHandoffAt}
        canDisposition={canHandle && !["CLOSED", "CANCELLED", "STACKED"].includes(r.status)}
        lines={r.items.map((i) => ({
          id: i.id,
          lineNo: i.lineNo,
          description: i.description,
          sku: i.item?.sku ?? null,
          tag: i.asset?.tag ?? null,
          quantity: i.quantity,
          unit: i.unit,
          serial: i.serialNumber,
          condition: i.condition,
          conditionNotes: i.conditionNotes,
          verdict: i.inspectionVerdict,
          disposition: i.disposition,
          dispositionNote: i.dispositionNote,
          stacked: Boolean(i.movementTxnId),
        }))}
      />

      {stacked.length > 0 && (
        <p className="text-2xs text-[var(--c-text-tertiary)]">
          {stacked.length} line{stacked.length === 1 ? "" : "s"} back in stock, each as a ledger movement carrying{" "}
          {r.number} as its reason. {qty(forRepair.length)} unit{forRepair.length === 1 ? "" : "s"} at Repair and
          Maintenance {forRepair.length === 1 ? "is" : "are"} deliberately not counted as usable stock.
        </p>
      )}

      <SectionCard title="Activity">
        <Timeline events={events} />
      </SectionCard>
    </div>
  );
}
