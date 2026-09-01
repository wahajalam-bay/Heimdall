import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { PageHeader } from "@/components/ui/primitives";
import { NewRncCaseForm } from "./NewRncCaseForm";

export const metadata = { title: "Raise a rental case" };
export const dynamic = "force-dynamic";

export default async function NewRncCasePage() {
  const { ctx, authorized } = await pageContext(P.RNC_CASE_RAISE, P.RNC_MANAGE);
  if (!authorized) {
    return (
      <AccessDenied
        title="Raise a rental case"
        message="RN-003 puts the arranging of an RNC with the HOD Sales or Admin."
      />
    );
  }

  const entityIds = visibleEntityIds(ctx.user);
  const [entities, buildOuts] = await Promise.all([
    prisma.entity.findMany({
      where: entityIds ? { id: { in: entityIds } } : {},
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    prisma.buildOut.findMany({
      where: {
        ...(entityIds ? { entityId: { in: entityIds } } : {}),
        status: { notIn: ["CLOSED", "CANCELLED"] },
      },
      select: { id: true, number: true, name: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Rental committee", href: "/rnc" }, { label: "New" }]} />
      <PageHeader
        eyebrow="RNC"
        title="Raise a rental case"
        subtitle="The committee needs a need assessment and a comparative of landlords before it can sit — RN-006 and RN-007. Both can be added after this, and convening is refused until they exist."
      />
      <NewRncCaseForm
        entities={entities}
        buildOuts={buildOuts}
        defaultEntityId={ctx.entityId ?? entities[0]?.id ?? ""}
      />
    </div>
  );
}
