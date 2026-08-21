import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { EmptyState, PageHeader } from "@/components/ui/primitives";
import { invoiceablePos } from "../actions";
import { InvoiceForm } from "../InvoiceForm";

export const metadata = { title: "Register invoice" };
export const dynamic = "force-dynamic";

export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { ctx, authorized } = await pageContext(P.INVOICE_CREATE);
  if (!authorized) {
    return <AccessDenied title="Register invoice" message="You do not have permission to register vendor invoices." />;
  }

  const poId = first((await searchParams).poId);
  const pos = await invoiceablePos(ctx.entityId);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Finance", href: "/invoices" }, { label: "Invoices", href: "/invoices" }, { label: "New" }]} />
      <PageHeader
        title="Register a vendor invoice"
        subtitle="The three-way match runs the moment it is registered. Enter what the vendor actually invoiced, not what would make the numbers agree."
      />
      {pos.length === 0 ? (
        <EmptyState
          title="No issued purchase orders"
          description="An invoice can only be registered against an order that has been issued to a vendor."
        />
      ) : (
        <InvoiceForm
          defaultPoId={poId}
          pos={pos.map((p) => ({
            id: p.id,
            number: p.number,
            total: p.total,
            currency: p.currency,
            vendorId: p.vendor.id,
            vendorName: p.vendor.name,
            items: p.items.map((it) => ({
              id: it.id,
              lineNo: it.lineNo,
              description: it.description,
              quantity: it.quantity,
              unit: it.unit,
              unitPrice: it.unitPrice,
              taxRate: it.taxRate,
              acceptedQty: it.acceptedQty,
              invoicedQty: it.invoicedQty,
            })),
            grns: p.grns.map((g) => ({
              id: g.id,
              number: g.number,
              receivedAt: g.receivedAt.toISOString(),
              totalValue: g.totalValue,
            })),
            invoices: p.invoices,
          }))}
        />
      )}
    </div>
  );
}
