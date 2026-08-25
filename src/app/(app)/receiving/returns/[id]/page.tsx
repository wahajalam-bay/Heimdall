import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { ActionButton } from "@/components/ui/forms";
import {
  Badge,
  BlockedNotice,
  DefList,
  InlineAlert,
  MetaItem,
  PageHeader,
  RefLink,
  SectionCard,
  StatusBadge,
} from "@/components/ui/primitives";
import { buildRail } from "@/components/ui/workflow";
import { humanize } from "@/lib/domain";
import { fmtDate, fmtDateTime, money, qty, relativeTime } from "@/lib/format";
import { advanceReturnAction, authoriseReturnAction } from "../../actions";

export const dynamic = "force-dynamic";

const RETURN_LIFECYCLE = [
  "DRAFT",
  "AUTHORISED",
  "DISPATCHED",
  "ACKNOWLEDGED",
  "REPLACED",
  "CLOSED",
] as const;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await prisma.vendorReturn.findUnique({ where: { id }, select: { number: true } });
  return { title: r ? `Return ${r.number}` : "Vendor return" };
}

/**
 * One return, and what the vendor still owes.
 *
 * The states are deliberately narrow — a return cannot be acknowledged before it
 * was sent, and cannot close while a replacement is awaited — because a return
 * that quietly closes with nothing received is how a vendor keeps both the goods
 * and the money.
 */
export default async function ReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.RETURN_VIEW);
  if (!authorized) {
    return <AccessDenied title="Vendor return" message="You do not have permission to view vendor returns." />;
  }

  const ret = await prisma.vendorReturn.findUnique({
    where: { id },
    include: {
      vendor: { select: { id: true, name: true, status: true } },
      po: { select: { id: true, number: true, entity: { select: { code: true, name: true } } } },
      grn: { select: { id: true, number: true } },
      raisedBy: { select: { name: true } },
      items: { orderBy: { lineNo: "asc" }, include: { item: { select: { sku: true } } } },
      rejections: { orderBy: { raisedAt: "asc" }, include: { raisedBy: { select: { name: true } } } },
    },
  });
  if (!ret) notFound();

  const canAuthorise = userHasPermission(user, P.RETURN_AUTHORISE);
  const canProgress = userHasPermission(user, P.RETURN_CREATE, P.RETURN_AUTHORISE);
  const late =
    ret.replacementStatus === "AWAITED" && ret.replacementDueDate && ret.replacementDueDate < new Date();

  const rail = buildRail(
    RETURN_LIFECYCLE,
    ret.status === "CREDITED" ? "REPLACED" : ret.status,
    {
      DRAFT: { at: ret.createdAt, owner: ret.raisedBy.name },
      AUTHORISED: { at: ret.status === "DRAFT" ? null : ret.createdAt },
      DISPATCHED: { at: ret.dispatchedAt },
      ACKNOWLEDGED: { at: ret.acknowledgedAt },
      CLOSED: { at: ret.closedAt },
    },
    { terminalBad: ret.status === "CANCELLED" },
  );

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Receiving", href: "/receiving" },
          { label: "Returns", href: "/receiving/returns" },
          { label: ret.number },
        ]}
      />

      <PageHeader
        eyebrow={`${ret.po?.entity.code ?? "Return"} · ${ret.vendor.name}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{ret.number}</span>
            <span>{money(ret.totalValue, ret.currency)} going back</span>
          </span>
        }
        subtitle={ret.reason}
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={ret.status} />
            </MetaItem>
            <MetaItem label="Lines">{ret.items.length}</MetaItem>
            <MetaItem label="Replacement">{humanize(ret.replacementStatus)}</MetaItem>
            <MetaItem label="Raised">{relativeTime(ret.createdAt)}</MetaItem>
          </>
        }
        actions={
          <>
            {ret.status === "DRAFT" && canAuthorise && (
              <ActionButton
                action={authoriseReturnAction}
                payload={{ returnId: ret.id }}
                label="Authorise"
                tone="primary"
                confirm={`Authorise ${ret.number}? This allows ${money(ret.totalValue, ret.currency)} of goods off site.`}
              />
            )}
            {ret.status === "AUTHORISED" && canProgress && (
              <ActionButton
                action={advanceReturnAction}
                payload={{ returnId: ret.id, to: "DISPATCHED" }}
                label="Mark dispatched"
                tone="primary"
              />
            )}
            {ret.status === "DISPATCHED" && canProgress && (
              <ActionButton
                action={advanceReturnAction}
                payload={{ returnId: ret.id, to: "ACKNOWLEDGED" }}
                label="Vendor acknowledged"
                tone="secondary"
              />
            )}
            {ret.status === "ACKNOWLEDGED" && canProgress && (
              <>
                <ActionButton
                  action={advanceReturnAction}
                  payload={{ returnId: ret.id, to: "REPLACED" }}
                  label="Replacement received"
                  tone="success"
                />
                <ActionButton
                  action={advanceReturnAction}
                  payload={{ returnId: ret.id, to: "CREDITED" }}
                  label="Credit note received"
                  tone="secondary"
                  reasonLabel="Credit note reference"
                  reasonRequired
                />
              </>
            )}
            {["ACKNOWLEDGED", "REPLACED", "CREDITED"].includes(ret.status) && canProgress && (
              <ActionButton
                action={advanceReturnAction}
                payload={{ returnId: ret.id, to: "CLOSED" }}
                label="Close"
                tone="secondary"
              />
            )}
          </>
        }
      />

      {ret.status === "CANCELLED" && <BlockedNotice title="This return was cancelled" reasons={[ret.reason]} />}

      {late && (
        <InlineAlert tone="danger">
          The replacement was due {fmtDate(ret.replacementDueDate!)} and has not arrived. This belongs in the vendor&rsquo;s
          performance record.
        </InlineAlert>
      )}

      <div className="rail">
        {rail.map((step) => (
          <div key={step.key} className="rail-step" data-state={step.state}>
            <div className="label">{humanize(step.key)}</div>
            {step.at && <div className="text-2xs text-muted">{fmtDate(step.at)}</div>}
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <div className="space-y-4">
          <SectionCard title="Lines going back" bodyClassName="px-0 pb-0">
            <div className="table-wrap">
              <table className="dt min-w-[34rem]">
                <thead>
                  <tr>
                    <th style={{ width: "3rem" }}>#</th>
                    <th>Item</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">Unit value</th>
                    <th className="text-right">Line value</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {ret.items.map((l) => (
                    <tr key={l.id}>
                      <td className="tnum">{l.lineNo}</td>
                      <td>
                        <div className="text-xs font-500">{l.description}</div>
                        {l.item && <div className="mono text-2xs text-[var(--c-text-tertiary)]">{l.item.sku}</div>}
                      </td>
                      <td className="num">{qty(l.quantity, l.unit)}</td>
                      <td className="num">{l.unitValue ? money(l.unitValue, ret.currency) : "—"}</td>
                      <td className="num">{money(l.lineValue, ret.currency)}</td>
                      <td className="text-xs">{l.reasonCode ? humanize(l.reasonCode) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} className="text-right">
                      Total
                    </td>
                    <td className="num font-600">{money(ret.totalValue, ret.currency)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </SectionCard>

          {ret.rejections.length > 0 && (
            <SectionCard
              title="Findings behind this return"
              description="The rejections that led to the goods going back."
              bodyClassName="px-0 pb-0"
            >
              <div className="row-list">
                {ret.rejections.map((rj) => (
                  <div key={rj.id} className="row-static">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mono text-2xs text-[var(--c-accent-text)]">{rj.number}</span>
                      <Badge tone="danger">{humanize(rj.reasonCode)}</Badge>
                      <Badge tone={rj.disposition === "ADJUSTED_OUT" ? "warning" : "neutral"}>
                        {rj.disposition === "ADJUSTED_OUT" ? "Adjusted out of stock" : "Never entered stock"}
                      </Badge>
                      <span className="tnum ml-auto text-2xs text-muted">{qty(rj.quantity, rj.unit)}</span>
                    </div>
                    <p className="mt-0.5 text-xs">{rj.description}</p>
                    {rj.reason && <p className="mt-0.5 text-2xs text-muted">{rj.reason}</p>}
                    <p className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">
                      {rj.raisedBy.name} · {fmtDateTime(rj.raisedAt)}
                    </p>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}
        </div>

        <div className="space-y-4">
          <SectionCard title="Details">
            <DefList
              columns={1}
              items={[
                {
                  label: "Vendor",
                  value: <RefLink href={`/vendors/${ret.vendor.id}`}>{ret.vendor.name}</RefLink>,
                },
                { label: "Vendor status", value: <StatusBadge status={ret.vendor.status} /> },
                {
                  label: "Order",
                  value: ret.po ? <RefLink href={`/po/${ret.po.id}`}>{ret.po.number}</RefLink> : "—",
                },
                {
                  label: "Receipt",
                  value: ret.grn ? <RefLink href={`/grn/${ret.grn.id}`}>{ret.grn.number}</RefLink> : "—",
                },
                { label: "Gate pass", value: ret.gatePassRef ?? "—" },
                { label: "Raised by", value: ret.raisedBy.name },
                { label: "Replacement required", value: ret.replacementRequired ? "Yes" : "No" },
                {
                  label: "Replacement due",
                  value: ret.replacementDueDate ? fmtDate(ret.replacementDueDate) : "—",
                },
                { label: "Credit note", value: ret.creditNoteRef ?? "—" },
                {
                  label: "Credit amount",
                  value: ret.creditNoteAmount ? money(ret.creditNoteAmount, ret.currency) : "—",
                },
                { label: "Dispatched", value: ret.dispatchedAt ? fmtDateTime(ret.dispatchedAt) : "—" },
                { label: "Acknowledged", value: ret.acknowledgedAt ? fmtDateTime(ret.acknowledgedAt) : "—" },
                { label: "Closed", value: ret.closedAt ? fmtDateTime(ret.closedAt) : "—" },
              ]}
            />
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
