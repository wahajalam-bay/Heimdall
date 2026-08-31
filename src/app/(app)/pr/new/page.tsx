import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { PageHeader } from "@/components/ui/primitives";
import { getConfigBool, CONFIG_KEYS } from "@/lib/config";
import { toInputDate } from "@/lib/format";
import { prFormOptions, createPrAction } from "../actions";
import { PrForm } from "../PrForm";

export const metadata = { title: "New requisition" };
export const dynamic = "force-dynamic";

export default async function NewPrPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, ctx, authorized } = await pageContext(P.PR_CREATE);
  if (!authorized) {
    return <AccessDenied title="New requisition" message="You do not have permission to raise requisitions." />;
  }
  const sp = await searchParams;
  const type = typeof sp.type === "string" ? sp.type : "ON_DEMAND";

  const options = await prFormOptions(ctx.entityId);
  const requireSpec = await getConfigBool(CONFIG_KEYS.PR_REQUIRE_SPEC, ctx.entityId);

  const entityId = ctx.entityId ?? options.entities[0]?.id ?? "";
  const defaultDept =
    options.departments.find((d) => d.id === user.primaryDepartmentId && d.entityId === entityId)?.id ??
    options.departments.find((d) => d.entityId === entityId)?.id ??
    "";

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Procurement", href: "/pr" }, { label: "Requisitions", href: "/pr" }, { label: "New" }]} />
      <PageHeader
        title="New purchase requisition"
        subtitle="Capture what you need and why. Approval routing, committee review and sourcing rules are applied automatically from the configured thresholds for this entity."
      />
      <PrForm
        mode="create"
        action={createPrAction}
        options={options}
        requireSpecification={requireSpec}
        initial={{
          entityId,
          departmentId: defaultDept,
          procurementType: type,
          procurementKind: type === "SERVICE" ? "SERVICES" : "GOODS",
          title: "",
          justification: "",
          projectId: "",
          siteId: "",
          costCenter: "",
          deliveryStoreId: "",
          deliveryLocationNote: "",
          requiredDate: toInputDate(new Date(Date.now() + 14 * 86400000)),
          priority: "NORMAL",
          budgetAmount: "",
          budgetCode: "",
          pmOwnerId: user.id,
          boqReference: "",
          drawingReference: "",
          technicalNotes: "",
          lines: [],
        }}
      />
    </div>
  );
}
