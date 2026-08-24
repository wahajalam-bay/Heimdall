import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext, first, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { fmtDate } from "@/lib/format";
import { eligibleVendors } from "../actions";
import { RfqForm } from "../RfqForm";

export const metadata = { title: "New RFQ" };
export const dynamic = "force-dynamic";

export default async function NewRfqPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { authorized } = await pageContext(P.RFQ_ISSUE);
  if (!authorized) {
    return <AccessDenied title="New RFQ" message="You do not have permission to raise RFQs." />;
  }

  const prId = first((await searchParams).prId);
  if (!prId) {
    return (
      <div className="space-y-5">
        <PageHeader title="New RFQ" />
        <Card>
          <EmptyState
            title="Select a requisition first"
            description="An RFQ is always raised against an approved requisition that has entered sourcing, so the scope and specification carry through."
            action={
              <Link href="/pr" className="btn btn-primary btn-sm">
                Browse requisitions
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  const pr = await prisma.purchaseRequisition.findUnique({
    where: { id: prId },
    include: {
      entity: { select: { code: true } },
      items: { include: { category: { select: { name: true } } }, orderBy: { lineNo: "asc" } },
      rfqs: { select: { id: true, number: true, status: true } },
    },
  });
  if (!pr) notFound();

  const allowed = ["APPROVED", "PROCUREMENT_REVIEW", "SOURCING"];
  if (!allowed.includes(pr.status)) {
    return (
      <AccessDenied
        title="New RFQ"
        message={`${pr.number} is ${pr.status.replace(/_/g, " ").toLowerCase()}. An RFQ can only be raised once the requisition is approved and under procurement review or sourcing.`}
      />
    );
  }

  const [vendors, minQuotes, slaHours] = await Promise.all([
    eligibleVendors(pr.entityId),
    getConfigNumber(CONFIG_KEYS.MIN_QUOTATIONS, pr.entityId),
    getConfigNumber(CONFIG_KEYS.SLA_RFQ_RESPONSE_HOURS, pr.entityId),
  ]);

  const itemSummary = pr.items
    .slice(0, 3)
    .map((i) => `${i.description} (${i.quantity} ${i.unit})`)
    .join("; ") + (pr.items.length > 3 ? `; +${pr.items.length - 3} more line(s)` : "");

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Procurement", href: "/pr" },
          { label: pr.number, href: `/pr/${pr.id}` },
          { label: "New RFQ" },
        ]}
      />
      <PageHeader
        title="Raise a request for quotation"
        subtitle="Invite vendors to quote against this requisition. Only approved or conditionally approved vendors can be invited; blacklisted and suspended vendors are blocked."
      />
      {pr.rfqs.length > 0 && (
        <Card>
          <p className="text-xs text-muted">
            This requisition already has {pr.rfqs.length} RFQ(s):{" "}
            {pr.rfqs.map((r) => (
              <Link key={r.id} href={`/rfq/${r.id}`} className="mono mr-2 text-[var(--c-accent-text)]">
                {r.number}
              </Link>
            ))}
            Raising another creates a parallel sourcing event.
          </p>
        </Card>
      )}
      <RfqForm
        pr={{
          id: pr.id,
          number: pr.number,
          title: pr.title,
          estimatedValue: pr.estimatedValue,
          requiredDate: fmtDate(pr.requiredDate),
          entityCode: pr.entity.code,
          categoryNames: [...new Set(pr.items.map((i) => i.category.name))],
          itemSummary,
        }}
        vendors={vendors}
        minQuotes={minQuotes}
        defaultDeadlineDays={Math.max(1, Math.round(slaHours / 24))}
      />
    </div>
  );
}
