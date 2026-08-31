import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  InlineAlert,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  UserChip,
} from "@/components/ui/primitives";
import { fmtDateTime, money } from "@/lib/format";
import { humanize, type BadgeTone } from "@/lib/domain";
import { ConfirmServiceForm } from "../forms";

export const dynamic = "force-dynamic";

const TONE: Record<string, BadgeTone> = {
  ACCEPTED: "success",
  PARTIALLY_ACCEPTED: "warning",
  REJECTED: "danger",
  DRAFT: "neutral",
  SUBMITTED: "progress",
  CANCELLED: "neutral",
};

export default async function ServiceAcceptancePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { ctx, authorized } = await pageContext(P.RECEIVING_VIEW, P.PO_VIEW);
  if (!authorized) {
    return <AccessDenied title="Service acceptance" message="You do not have access to receiving records." />;
  }

  const sa = await prisma.serviceAcceptance.findUnique({
    where: { id },
    include: {
      items: { orderBy: { lineNo: "asc" } },
      po: { include: { vendor: true, pr: true } },
      pocUser: { select: { id: true, name: true, title: true } },
      confirmedBy: { select: { name: true } },
      createdBy: { select: { name: true } },
      entity: { select: { code: true, name: true } },
    },
  });
  if (!sa) notFound();

  const pending = sa.status === "DRAFT" || sa.status === "SUBMITTED";
  // The right to confirm belongs to the named point of contact. Anyone else needs
  // authority to act for that department — the page mirrors the domain rule, it
  // does not decide it.
  const isPoc = sa.pocUserId === ctx.user.id;
  const canConfirm =
    pending && (isPoc || userHasPermission(ctx.user, P.SERVICE_ACCEPT_ANY, P.INVOICE_VERIFY));

  const shortfall = sa.items.some((i) => i.acceptedQty + 1e-9 < i.orderedQty);

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Receiving", href: "/receiving" },
          { label: "Service acceptance", href: "/service-acceptance" },
          { label: sa.number },
        ]}
      />

      <PageHeader
        eyebrow={`${sa.entity.code} · service acceptance`}
        title={sa.number}
        subtitle={`${sa.po.vendor.name} · ${sa.po.number}${sa.serviceFrom ? ` · ${sa.serviceFrom.toISOString().slice(0, 10)} to ${sa.serviceTo?.toISOString().slice(0, 10) ?? "open"}` : ""}`}
        actions={<Badge tone={TONE[sa.status] ?? "neutral"}>{humanize(sa.status)}</Badge>}
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Ordered" value={money(sa.orderedValue)} />
        <StatTile
          label="Accepted"
          value={money(sa.acceptedValue)}
          tone={sa.status === "REJECTED" ? "danger" : shortfall ? "warning" : "success"}
        />
        <StatTile label="Order" value={sa.po.number} href={`/po/${sa.poId}`} />
        <StatTile
          label="Requisition"
          value={sa.po.pr?.number ?? "—"}
          href={sa.po.prId ? `/pr/${sa.po.prId}` : undefined}
        />
      </div>

      {pending && (
        <InlineAlert tone="warning">
          This is not evidence yet. A service is accepted by the point of contact who asked for it —{" "}
          {sa.pocUser ? <strong>{sa.pocUser.name}</strong> : "nobody is assigned"} — and the vendor&rsquo;s invoice
          stays unmatched until they confirm the work was performed.
        </InlineAlert>
      )}

      {sa.status === "REJECTED" && sa.rejectionReason && (
        <InlineAlert tone="danger">
          <strong>Refused.</strong> {sa.rejectionReason}
        </InlineAlert>
      )}

      <SectionCard
        title="What was accepted"
        description="Accepted quantity is what the invoice may bill for. A shortfall stays visible rather than being written off."
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "3rem" }}>#</th>
                <th style={{ minWidth: "16rem" }}>Service</th>
                <th style={{ width: "7rem" }}>Ordered</th>
                <th style={{ width: "7rem" }}>Accepted</th>
                <th style={{ width: "7rem" }}>Not accepted</th>
                <th style={{ width: "9rem" }}>Value accepted</th>
                <th style={{ minWidth: "12rem" }}>Evidence &amp; remarks</th>
              </tr>
            </thead>
            <tbody>
              {sa.items.map((i) => {
                const short = i.acceptedQty + 1e-9 < i.orderedQty;
                return (
                  <tr key={i.id}>
                    <td className="tnum">{i.lineNo}</td>
                    <td>{i.description}</td>
                    <td className="tnum">
                      {i.orderedQty} {i.unit}
                    </td>
                    <td className={short ? "tnum text-[var(--c-warn-text)]" : "tnum"}>
                      {i.acceptedQty} {i.unit}
                    </td>
                    <td className="tnum">
                      {i.rejectedQty ? `${i.rejectedQty} ${i.unit}` : "—"}
                    </td>
                    <td className="tnum">{money(i.acceptedValue)}</td>
                    <td className="text-xs leading-5">
                      {i.evidenceRef ? <Mono className="block text-2xs">{i.evidenceRef}</Mono> : null}
                      {i.remarks ?? (i.evidenceRef ? "" : "—")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {canConfirm && <ConfirmServiceForm id={sa.id} number={sa.number} shortfall={shortfall} />}

      {!canConfirm && pending && (
        <InlineAlert tone="info">
          Only {sa.pocUser?.name ?? "the assigned point of contact"} can confirm this, or somebody authorised to act
          for their department. That separation is the point: the team that asked for the work says whether it was
          done, not the team that bought it.
        </InlineAlert>
      )}

      <SectionCard title="Record" description="Who raised it, who confirmed it, and when.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <span className="label mb-1 block">Raised by</span>
            <UserChip name={sa.createdBy.name} />
            <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
              {fmtDateTime(sa.createdAt)}
            </span>
          </div>
          <div>
            <span className="label mb-1 block">Point of contact</span>
            {sa.pocUser ? (
              <>
                <UserChip name={sa.pocUser.name} />
                {sa.pocUser.title && (
                  <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{sa.pocUser.title}</span>
                )}
              </>
            ) : (
              <span className="text-xs text-[var(--c-text-tertiary)]">Not assigned</span>
            )}
          </div>
          <div>
            <span className="label mb-1 block">Confirmed by</span>
            {sa.confirmedBy ? (
              <>
                <UserChip name={sa.confirmedBy.name} />
                <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                  {sa.confirmedAt ? fmtDateTime(sa.confirmedAt) : ""}
                </span>
              </>
            ) : (
              <span className="text-xs text-[var(--c-text-tertiary)]">Awaiting confirmation</span>
            )}
          </div>
          <div>
            <span className="label mb-1 block">Remarks</span>
            <span className="text-xs leading-5">{sa.remarks ?? "—"}</span>
          </div>
        </div>
      </SectionCard>

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        Goods are received against a GRN after inspection. Services are accepted here instead — there is nothing to
        put on a shelf, so the evidence is somebody accountable saying the work was performed.{" "}
        <RefLink href={`/po/${sa.poId}`}>{sa.po.number}</RefLink>
      </p>
    </div>
  );
}
