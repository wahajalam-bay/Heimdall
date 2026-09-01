import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { PageHeader } from "@/components/ui/primitives";
import { ContractForm } from "./ContractForm";

export const metadata = { title: "Raise a contract" };
export const dynamic = "force-dynamic";

export default async function NewContractPage() {
  const { ctx, authorized } = await pageContext(P.PO_CREATE, P.PO_ISSUE);
  if (!authorized) {
    return (
      <AccessDenied
        title="Raise a contract"
        message="ZAM/PUR/SOP-01 §4.6 gives the procurement department sole authority to issue a contract or agreement."
      />
    );
  }

  const entityIds = visibleEntityIds(ctx.user);
  const [entities, vendors] = await Promise.all([
    prisma.entity.findMany({
      where: entityIds ? { id: { in: entityIds } } : {},
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    prisma.vendor.findMany({
      where: { status: { in: ["ACTIVE", "APPROVED", "CONDITIONAL"] } },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
      take: 500,
    }),
  ]);

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Procurement" },
          { label: "Contracts", href: "/contracts" },
          { label: "New" },
        ]}
      />
      <PageHeader
        eyebrow="Contracts"
        title="Raise a contract"
        subtitle="§4.6 requires the payment terms, the delivery location and the other necessary details, under an authorised signature. Whether the committee has to approve it is decided from the value and then held."
      />
      <ContractForm
        entities={entities}
        vendors={vendors}
        defaultEntityId={ctx.entityId ?? entities[0]?.id ?? ""}
      />
    </div>
  );
}
