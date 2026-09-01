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
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { documentTimeline } from "@/server/timeline";
import { money, fmtDate, fmtDateTime, qty } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { lossReportDetail, LOSS_TYPE_LABELS, type LossType } from "@/server/loss-reports";
import { transitionLossAction, writeOffLossAction } from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await lossReportDetail(id);
  return { title: r ? `${r.number} — ${r.title}` : "Loss report" };
}

const RAIL = ["REPORTED", "UNDER_INVESTIGATION", "SUBSTANTIATED", "WRITTEN_OFF", "CLOSED"] as const;

export default async function LossReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, authorized } = await pageContext(P.INVENTORY_VIEW, P.AUDIT_VIEW);
  if (!authorized) return <AccessDenied title="Loss report" />;

  const { id } = await params;
  const r = await lossReportDetail(id);
  if (!r) notFound();

  const events = await documentTimeline("LossReport", r.id);

  const canInvestigate = userHasPermission(user, P.AUDIT_VIEW, P.EXCEPTION_MANAGE);
  const canAdjust = userHasPermission(user, P.INVENTORY_ADJUST);
  const isReporter = r.reportedById === user.id;
  const stillOnLedger = r.items.filter((i) => i.itemId && !i.adjustmentTxnId);

  const rail = buildRail(
    [...RAIL],
    ["UNSUBSTANTIATED", "RECOVERED"].includes(r.status)
      ? "SUBSTANTIATED"
      : r.status === "CANCELLED"
        ? "CLOSED"
        : r.status,
    {
      REPORTED: { at: r.reportedAt, owner: r.reportedBy.name },
      UNDER_INVESTIGATION: { at: r.investigationStartedAt, owner: r.investigator?.name ?? null },
      SUBSTANTIATED: { at: r.concludedAt, owner: r.concludedBy?.name ?? null },
      WRITTEN_OFF: { at: r.writtenOffAt, owner: null },
      CLOSED: { at: r.closedAt, owner: null },
    },
  );

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Stores", href: "/inventory" },
          { label: "Loss and theft", href: "/inventory/losses" },
          { label: r.number },
        ]}
      />

      <PageHeader
        eyebrow={`${r.entity.code}${r.store ? ` · ${r.store.name}` : ""}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <Mono className="text-[1rem] text-muted">{r.number}</Mono>
            <span>{r.title}</span>
          </span>
        }
        meta={
          <>
            <StatusBadge status={r.status} />
            <Badge tone={r.lossType === "THEFT" ? "danger" : "warning"}>
              {LOSS_TYPE_LABELS[r.lossType as LossType] ?? humanize(r.lossType)}
            </Badge>
            <span className="text-2xs">{money(r.estimatedValue)}</span>
          </>
        }
        actions={
          <>
            {r.status === "REPORTED" && canInvestigate && !isReporter && (
              <ActionButton
                action={transitionLossAction}
                payload={{ reportId: r.id, to: "UNDER_INVESTIGATION" }}
                label="Take the investigation"
                tone="primary"
              />
            )}
            {r.status === "UNDER_INVESTIGATION" && canInvestigate && (
              <>
                <ActionButton
                  action={transitionLossAction}
                  payload={{ reportId: r.id, to: "SUBSTANTIATED" }}
                  label="Substantiated"
                  tone="primary"
                  reasonLabel="What the investigation found"
                  reasonRequired
                />
                <ActionButton
                  action={transitionLossAction}
                  payload={{ reportId: r.id, to: "UNSUBSTANTIATED" }}
                  label="Not substantiated"
                  tone="secondary"
                  reasonLabel="What the investigation found"
                  reasonRequired
                />
                <ActionButton
                  action={transitionLossAction}
                  payload={{ reportId: r.id, to: "RECOVERED" }}
                  label="Recovered"
                  tone="success"
                  reasonLabel="How it was recovered"
                  reasonRequired
                />
              </>
            )}
            {r.status === "SUBSTANTIATED" && canAdjust && stillOnLedger.length > 0 && (
              <ActionButton
                action={writeOffLossAction}
                payload={{ reportId: r.id }}
                label={`Write off ${stillOnLedger.length} line${stillOnLedger.length === 1 ? "" : "s"}`}
                tone="danger-soft"
                confirm={`Take ${stillOnLedger.length} line(s) off the ledger against ${r.number}? Each posts as an inventory adjustment carrying this report as its reason.`}
              />
            )}
            {["SUBSTANTIATED", "UNSUBSTANTIATED", "WRITTEN_OFF", "RECOVERED"].includes(r.status) &&
              canInvestigate && (
                <ActionButton
                  action={transitionLossAction}
                  payload={{ reportId: r.id, to: "CLOSED" }}
                  label="Close"
                  tone="secondary"
                />
              )}
          </>
        }
      />

      {r.status === "REPORTED" && isReporter && canInvestigate && (
        <InlineAlert tone="info">
          You filed this report, so you cannot be its investigator. An investigation by the reporter adds nothing to
          what the report already says.
        </InlineAlert>
      )}

      {r.status === "SUBSTANTIATED" && stillOnLedger.length > 0 && (
        <BlockedNotice
          title="Still on the inventory ledger"
          reasons={[
            `${stillOnLedger.length} line(s) have been substantiated as lost but not yet taken off the ledger, so the stock figure still counts them as on hand.`,
            "The correction is a separate authorised adjustment — filing the report deliberately does not move stock.",
          ]}
        />
      )}

      {r.policeReported && (
        <InlineAlert tone="danger">
          Reported to the police{r.policeReference ? ` under ${r.policeReference}` : ""}.
        </InlineAlert>
      )}

      <LifecycleRail steps={rail} title="Case lifecycle" />

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <SectionCard title="What happened">
          <p className="whitespace-pre-wrap text-xs leading-6">{r.description}</p>
          {r.findings && (
            <>
              <p className="mt-4 text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
                Investigation findings
              </p>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-6">{r.findings}</p>
            </>
          )}
          {r.suspicionNote && (
            <>
              <p className="mt-4 text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
                Noted about who or how
              </p>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-6">{r.suspicionNote}</p>
            </>
          )}
        </SectionCard>

        <SectionCard title="Case record">
          <DefList
            columns={1}
            items={[
              {
                label: "Kind",
                value: LOSS_TYPE_LABELS[r.lossType as LossType] ?? humanize(r.lossType),
              },
              { label: "Store", value: r.store?.name ?? "None named" },
              { label: "Discovered", value: fmtDate(r.discoveredOn) },
              {
                label: "Happened",
                value: r.occurredOn ? fmtDate(r.occurredOn) : "Unknown",
              },
              { label: "How it came to light", value: r.discoveryRoute ?? "—" },
              { label: "Reported by", value: r.reportedBy.name },
              { label: "Investigator", value: r.investigator?.name ?? "Not yet assigned" },
              { label: "Concluded by", value: r.concludedBy?.name ?? "—" },
              { label: "Estimated value", value: money(r.estimatedValue) },
              ...(r.writtenOffValue != null
                ? [{ label: "Written off", value: money(r.writtenOffValue) }]
                : []),
              ...(r.recoveredValue > 0
                ? [{ label: "Recovered", value: money(r.recoveredValue) }]
                : []),
            ]}
          />
        </SectionCard>
      </div>

      <SectionCard title="What is missing" bodyClassName="px-0 py-0">
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "3rem" }}>#</th>
                <th style={{ minWidth: "14rem" }}>Description</th>
                <th style={{ width: "9rem" }}>Reference</th>
                <th style={{ width: "8rem" }} className="text-right">
                  Qty
                </th>
                <th style={{ width: "9rem" }} className="text-right">
                  Unit value
                </th>
                <th style={{ width: "10rem" }} className="text-right">
                  Value
                </th>
                <th style={{ width: "9rem" }}>Ledger</th>
              </tr>
            </thead>
            <tbody>
              {r.items.map((li) => (
                <tr key={li.id}>
                  <td className="tnum">{li.lineNo}</td>
                  <td>
                    {li.description}
                    {li.notes && (
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{li.notes}</span>
                    )}
                  </td>
                  <td className="text-2xs">
                    {li.item?.sku ?? li.asset?.tag ?? "—"}
                    {li.serialNumber && (
                      <span className="mt-0.5 block text-[var(--c-text-tertiary)]">{li.serialNumber}</span>
                    )}
                  </td>
                  <td className="tnum text-right">
                    {qty(li.quantity)} {li.unit}
                  </td>
                  <td className="tnum text-right">{money(li.unitValue)}</td>
                  <td className="tnum text-right font-semibold">{money(li.lineValue)}</td>
                  <td>
                    {li.adjustmentTxnId ? (
                      <Badge tone="success">Adjusted</Badge>
                    ) : li.assetId ? (
                      <span className="text-2xs text-[var(--c-text-tertiary)]">Asset</span>
                    ) : (
                      <span className="text-2xs text-[var(--c-warning)]">Still on hand</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Activity">
          <Timeline events={events} />
        </SectionCard>
        <DocumentsPanel user={user} linkedType="DISPOSAL" linkedId={r.id} title="Evidence" />
      </div>

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        A conclusion needs findings. &ldquo;Substantiated&rdquo; with nothing behind it is an opinion, and
        &ldquo;not substantiated&rdquo; with nothing behind it is worse — it closes a case without saying what was
        looked at. {r.investigator ? "" : "The investigator cannot be the person who filed the report."}
      </p>
    </div>
  );
}
