import { prisma } from "@/lib/db";
import { pageContext, first, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { PageHeader } from "@/components/ui/primitives";
import { receivingOptions } from "@/app/(app)/receiving/actions";
import { GatePassForm } from "../GatePassForm";

export const metadata = { title: "Record gate pass" };
export const dynamic = "force-dynamic";

export default async function NewGatePassPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { ctx, authorized } = await pageContext(P.GATE_PASS_CREATE);
  if (!authorized) {
    return <AccessDenied title="Record gate pass" message="You do not have permission to record gate passes." />;
  }
  const poId = first((await searchParams).poId);

  const [{ stores, openPos }, vendors] = await Promise.all([
    receivingOptions(ctx.entityId),
    prisma.vendor.findMany({
      where: { status: { in: ["APPROVED", "CONDITIONAL"] } },
      select: { id: true, name: true, status: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Operations", href: "/gate-passes" }, { label: "Gate passes", href: "/gate-passes" }, { label: "New" }]} />
      <PageHeader
        title="Record an inward gate pass"
        subtitle="Captured at the gate when a vendor vehicle arrives. A unique serial is generated and the receiving store is notified immediately."
      />
      <GatePassForm
        stores={stores}
        vendors={vendors}
        defaultPoId={poId}
        openPos={openPos.map((p) => ({
          id: p.id,
          number: p.number,
          total: p.total,
          vendorId: p.vendor.id,
          vendorName: p.vendor.name,
          storeId: p.deliveryStore?.id ?? null,
          storeName: p.deliveryStore?.name ?? null,
        }))}
      />
    </div>
  );
}
