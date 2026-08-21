import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext, first, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { CONFIG_KEYS, getConfigBool, getConfigNumber } from "@/lib/config";
import { poReadiness } from "@/server/po";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { BlockedNotice, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { toInputDate } from "@/lib/format";
import { poFormOptions } from "../actions";
import { PoForm } from "../PoForm";

export const metadata = { title: "New purchase order" };
export const dynamic = "force-dynamic";

export default async function NewPoPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { authorized } = await pageContext(P.PO_CREATE);
  if (!authorized) {
    return <AccessDenied title="New purchase order" message="You do not have permission to create purchase orders." />;
  }

  const prId = first((await searchParams).prId);
  if (!prId) {
    return (
      <div className="space-y-5">
        <PageHeader title="New purchase order" />
        <Card>
          <EmptyState
            title="Select a procurement case first"
            description="A purchase order is generated from an approved case — its awarded vendor, negotiated prices and lines carry through automatically."
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
      entity: { select: { code: true, name: true } },
      deliveryStore: { select: { id: true, name: true, address: true } },
      site: { select: { name: true } },
      comparatives: {
        where: { status: { in: ["RECOMMENDED", "APPROVED"] } },
        orderBy: { preparedAt: "desc" },
        take: 1,
        include: {
          lines: {
            where: { isSelected: true },
            include: {
              vendor: true,
              quote: { include: { items: { orderBy: { lineNo: "asc" } }, negotiations: { orderBy: { round: "asc" } } } },
            },
          },
        },
      },
    },
  });
  if (!pr) notFound();

  const readiness = await poReadiness(pr.id);
  const comparative = pr.comparatives[0];
  const selected = comparative?.lines[0];

  if (!readiness.ready || !selected) {
    return (
      <div className="space-y-5">
        <Breadcrumbs
          items={[
            { label: "Requisitions", href: "/pr" },
            { label: pr.number, href: `/pr/${pr.id}` },
            { label: "New purchase order" },
          ]}
        />
        <PageHeader title="New purchase order" subtitle={`${pr.number} — ${pr.title}`} />
        <BlockedNotice
          title="This case cannot generate a purchase order yet"
          reasons={
            readiness.issues.length
              ? readiness.issues
              : ["No vendor has been recommended on the comparative."]
          }
          tone="warning"
        />
        <Card>
          <Link href={`/pr/${pr.id}`} className="btn btn-secondary btn-sm">
            Back to the case
          </Link>
        </Card>
      </div>
    );
  }

  const [{ stores }, advanceAllowed, advanceMax, advanceNeedsCollateral, defaultTax] = await Promise.all([
    poFormOptions(pr.entityId),
    getConfigBool(CONFIG_KEYS.ADVANCE_PAYMENT_ALLOWED, pr.entityId),
    getConfigNumber(CONFIG_KEYS.ADVANCE_MAX_PERCENT, pr.entityId),
    getConfigBool(CONFIG_KEYS.ADVANCE_REQUIRES_COLLATERAL, pr.entityId),
    getConfigNumber(CONFIG_KEYS.DEFAULT_TAX_RATE, pr.entityId),
  ]);

  const negotiated = selected.quote.negotiations.at(-1);
  const netTotal = negotiated ? (negotiated.finalTotal ?? negotiated.negotiatedTotal) : selected.quote.total;
  const factor = selected.quote.total > 0 ? netTotal / selected.quote.total : 1;

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Requisitions", href: "/pr" },
          { label: pr.number, href: `/pr/${pr.id}` },
          { label: "New purchase order" },
        ]}
      />
      <PageHeader
        title="Generate purchase order"
        subtitle="Lines, quantities and prices come from the awarded quotation with the negotiated outcome applied. Confirm the delivery and commercial terms below."
      />
      <PoForm
        pr={{
          id: pr.id,
          number: pr.number,
          title: pr.title,
          entityCode: pr.entity.code,
          requiredDate: toInputDate(pr.requiredDate),
          deliveryStoreId: pr.deliveryStoreId,
          siteName: pr.site?.name ?? null,
          procurementType: pr.procurementType,
        }}
        award={{
          comparativeNumber: comparative.number,
          vendorId: selected.vendor.id,
          vendorName: selected.vendor.name,
          vendorAddress: selected.vendor.address,
          vendorPaymentTerms: selected.vendor.paymentTerms,
          vendorCreditDays: selected.vendor.creditDays,
          quoteNumber: selected.quote.number,
          quotedTotal: selected.quote.total,
          netTotal,
          negotiatedRounds: selected.quote.negotiations.length,
          deliveryDays: selected.quote.deliveryDays,
          warrantyTerms: selected.quote.warrantyTerms,
          lines: selected.quote.items.map((i) => ({
            id: i.id,
            description: i.description,
            quantity: i.quantity,
            unit: i.unit,
            quotedUnitPrice: i.unitPrice,
            appliedUnitPrice: Math.round(i.unitPrice * factor * 100) / 100,
            taxRate: i.taxRate,
          })),
        }}
        stores={stores}
        advance={{ allowed: advanceAllowed, maxPercent: advanceMax, requiresCollateral: advanceNeedsCollateral }}
        defaultTaxRate={defaultTax}
      />
    </div>
  );
}
