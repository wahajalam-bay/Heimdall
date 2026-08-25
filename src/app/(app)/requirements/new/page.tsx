import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { EmptyState, InlineAlert, PageHeader } from "@/components/ui/primitives";
import { requirementOptions } from "../actions";
import { RequirementForm } from "../RequirementForm";

export const metadata = { title: "Raise a requirement" };
export const dynamic = "force-dynamic";

export default async function NewRequirementPage() {
  const { user, ctx, authorized } = await pageContext(P.REQUIREMENT_CREATE);
  if (!authorized) {
    return <AccessDenied title="Raise a requirement" message="You do not have permission to raise requirements." />;
  }

  const { entities, departments, stores, sites, projects, items, categories } = await requirementOptions(null);
  const defaultEntityId = ctx.entityId && entities.some((e) => e.id === ctx.entityId) ? ctx.entityId : (entities[0]?.id ?? "");
  const defaultDepartmentId =
    user.primaryDepartmentId && departments.some((d) => d.id === user.primaryDepartmentId)
      ? user.primaryDepartmentId
      : "";

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Demand", href: "/requirements" },
          { label: "Requirements", href: "/requirements" },
          { label: "New" },
        ]}
      />
      <PageHeader
        title="Raise a requirement"
        subtitle="State what the department needs. The stores are checked before any of it becomes a purchase."
      />

      <InlineAlert tone="info">
        This is not a purchase requisition. Once submitted, the available stock is read for every line; only the
        quantity no store can supply goes to procurement.
      </InlineAlert>

      {entities.length === 0 ? (
        <EmptyState
          title="No entity available"
          description="You are not assigned to an entity that can raise requirements."
        />
      ) : (
        <RequirementForm
          entities={entities}
          departments={departments}
          stores={stores}
          sites={sites}
          projects={projects}
          items={items}
          categories={categories}
          defaultEntityId={defaultEntityId}
          defaultDepartmentId={defaultDepartmentId}
        />
      )}
    </div>
  );
}
