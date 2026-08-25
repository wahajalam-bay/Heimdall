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
  DefList,
  InlineAlert,
  MetaItem,
  PageHeader,
  RefLink,
  SectionCard,
  StatusBadge,
} from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { fmtDateTime, money, qty, relativeTime } from "@/lib/format";
import { resolveVarianceAction } from "../../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = await prisma.poVariance.findUnique({ where: { id }, select: { number: true } });
  return { title: v ? `Variance ${v.number}` : "Variance" };
}

/**
 * One difference, and what was decided about it.
 *
 * The four resolutions are deliberately distinct. Recovered means the vendor made
 * it good; accepted means the organisation took the difference knowingly; written
 * off means it was absorbed; disputed means the argument is still live. Collapsing
 * them into "closed" is what makes a variance report useless a year later.
 */
export default async function VariancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.VARIANCE_VIEW);
  if (!authorized) {
    return <AccessDenied title="Variance" message="You do not have permission to view receipt variances." />;
  }

  const variance = await prisma.poVariance.findUnique({
    where: { id },
    include: {
      po: {
        select: {
          id: true,
          number: true,
          total: true,
          entity: { select: { code: true, name: true } },
          vendor: { select: { id: true, name: true } },
          pr: { select: { id: true, number: true } },
        },
      },
      grn: { select: { id: true, number: true, totalValue: true, receivedAt: true } },
      resolvedBy: { select: { name: true } },
    },
  });
  if (!variance) notFound();

  const canResolve = userHasPermission(user, P.VARIANCE_RESOLVE) && variance.status === "OPEN";
  const valueEffect = (variance.grnValue ?? 0) - (variance.poValue ?? 0);
  const short = variance.variance < 0;

  const resolutions: Array<{ status: string; label: string; help: string; tone: "primary" | "secondary" | "danger-soft" }> = [
    {
      status: "RECOVERED",
      label: "Recovered from the vendor",
      help: "The vendor supplied the balance, replaced the goods or issued a credit.",
      tone: "primary",
    },
    {
      status: "ACCEPTED",
      label: "Accepted",
      help: "The difference is taken knowingly and the order squares off here.",
      tone: "secondary",
    },
    {
      status: "WRITTEN_OFF",
      label: "Written off",
      help: "Absorbed as a loss with no recovery expected.",
      tone: "danger-soft",
    },
    {
      status: "DISPUTED",
      label: "Disputed",
      help: "The vendor disagrees; the argument stays open against their record.",
      tone: "secondary",
    },
  ];

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Receiving", href: "/receiving" },
          { label: "Variances", href: "/receiving/variances" },
          { label: variance.number },
        ]}
      />

      <PageHeader
        eyebrow={`${variance.po.entity.code} · ${humanize(variance.type)} variance`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{variance.number}</span>
            <span>
              {variance.variance > 0 ? "+" : ""}
              {qty(variance.variance)} against {qty(variance.poQuantity ?? 0)} ordered
            </span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={variance.status} />
            </MetaItem>
            <MetaItem label="Order">
              <RefLink href={`/po/${variance.po.id}`}>{variance.po.number}</RefLink>
            </MetaItem>
            <MetaItem label="Vendor">{variance.po.vendor.name}</MetaItem>
            <MetaItem label="Raised">{relativeTime(variance.createdAt)}</MetaItem>
          </>
        }
      />

      <InlineAlert tone={short ? "danger" : "warning"}>
        {short
          ? `The receipt fell short by ${qty(Math.abs(variance.variance))}. The order has squared off so it can close; this record is what remains answerable.`
          : `The receipt exceeded the order by ${qty(variance.variance)}. Somebody has to decide whether that quantity is kept and paid for.`}
      </InlineAlert>

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          {canResolve && (
            <SectionCard
              title="How was this resolved?"
              description="Each answer means something different a year from now, so pick the one that is true."
            >
              <div className="space-y-3">
                {resolutions.map((r) => (
                  <div key={r.status} className="flex flex-wrap items-center justify-between gap-3 border-b border-separator pb-3 last:border-b-0 last:pb-0">
                    <div className="min-w-0">
                      <div className="text-xs font-500">{r.label}</div>
                      <p className="mt-0.5 text-2xs text-muted">{r.help}</p>
                    </div>
                    <ActionButton
                      action={resolveVarianceAction}
                      payload={{ varianceId: variance.id, status: r.status }}
                      label={r.label}
                      tone={r.tone}
                      size="xs"
                      reasonLabel="What happened? This is the audit answer."
                      reasonRequired
                    />
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

          {variance.status !== "OPEN" && (
            <SectionCard title="Resolution">
              <DefList
                columns={1}
                items={[
                  { label: "Outcome", value: <StatusBadge status={variance.status} /> },
                  { label: "Recorded by", value: variance.resolvedBy?.name ?? "—" },
                  { label: "When", value: variance.resolvedAt ? fmtDateTime(variance.resolvedAt) : "—" },
                  { label: "What happened", value: variance.resolution ?? "—", span: true },
                ]}
              />
            </SectionCard>
          )}

          <SectionCard title="The difference">
            <DefList
              columns={2}
              items={[
                { label: "Type", value: humanize(variance.type) },
                { label: "Reason recorded", value: humanize(variance.reasonCode) },
                { label: "Ordered", value: qty(variance.poQuantity ?? 0) },
                { label: "Received", value: qty(variance.grnQuantity ?? 0) },
                {
                  label: "Difference",
                  value: `${variance.variance > 0 ? "+" : ""}${qty(variance.variance)}${
                    variance.variancePct !== null ? ` (${variance.variancePct}%)` : ""
                  }`,
                },
                { label: "Value effect", value: money(valueEffect, "PKR") },
                { label: "Order value at that line", value: money(variance.poValue ?? 0, "PKR") },
                { label: "Received value", value: money(variance.grnValue ?? 0, "PKR") },
                { label: "Note", value: variance.reason ?? "—", span: true },
              ]}
            />
          </SectionCard>
        </div>

        <div className="space-y-4">
          <SectionCard title="Documents">
            <DefList
              columns={1}
              items={[
                {
                  label: "Order",
                  value: <RefLink href={`/po/${variance.po.id}`}>{variance.po.number}</RefLink>,
                },
                {
                  label: "Requisition",
                  value: variance.po.pr ? (
                    <RefLink href={`/pr/${variance.po.pr.id}`}>{variance.po.pr.number}</RefLink>
                  ) : (
                    "—"
                  ),
                },
                {
                  label: "Receipt",
                  value: variance.grn ? <RefLink href={`/grn/${variance.grn.id}`}>{variance.grn.number}</RefLink> : "—",
                },
                { label: "Received", value: variance.grn?.receivedAt ? fmtDateTime(variance.grn.receivedAt) : "—" },
                {
                  label: "Vendor",
                  value: (
                    <RefLink href={`/vendors/${variance.po.vendor.id}`}>{variance.po.vendor.name}</RefLink>
                  ),
                },
                { label: "Entity", value: `${variance.po.entity.code} — ${variance.po.entity.name}` },
              ]}
            />
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
