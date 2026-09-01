import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { PageHeader } from "@/components/ui/primitives";
import { WorkOrderForm } from "./WorkOrderForm";

export const metadata = { title: "Raise a work order" };
export const dynamic = "force-dynamic";

export default async function NewWorkOrderPage() {
  const { ctx, authorized } = await pageContext(P.WORK_ORDER_CREATE);
  if (!authorized) {
    return (
      <AccessDenied
        title="Raise a work order"
        message="ZAM/PUR/SOP-01 §4.6 puts the raising of a work order with the Admin department."
      />
    );
  }

  const entityIds = visibleEntityIds(ctx.user);
  const [entities, vendors, comparatives] = await Promise.all([
    prisma.entity.findMany({
      where: entityIds ? { id: { in: entityIds } } : {},
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    prisma.vendor.findMany({
      where: { status: { in: ["ACTIVE", "APPROVED"] } },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
      take: 500,
    }),
    prisma.comparative.findMany({
      where: { status: { in: ["RECOMMENDED", "APPROVED"] } },
      select: { id: true, number: true, pr: { select: { id: true, title: true } } },
      orderBy: { preparedAt: "desc" },
      take: 100,
    }),
  ]);

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Procurement" },
          { label: "Work orders", href: "/work-orders" },
          { label: "New" },
        ]}
      />
      <PageHeader
        eyebrow="Work orders"
        title="Raise a work order"
        subtitle="§4.6: issued by Admin on the basis of rates negotiated by Procurement. Where the value falls outside the committee's domain, Internal Audit reviews it before it is finalised."
      />
      <WorkOrderForm
        entities={entities}
        vendors={vendors}
        comparatives={comparatives.map((c) => ({
          id: c.id,
          label: `${c.number}${c.pr?.title ? ` — ${c.pr.title}` : ""}`,
          prId: c.pr?.id ?? null,
        }))}
        defaultEntityId={ctx.entityId ?? entities[0]?.id ?? ""}
      />
    </div>
  );
}
