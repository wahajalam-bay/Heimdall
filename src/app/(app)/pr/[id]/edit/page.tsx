import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { PageHeader, StatusBadge } from "@/components/ui/primitives";
import { getConfigBool, CONFIG_KEYS } from "@/lib/config";
import { toInputDate } from "@/lib/format";
import { prFormOptions, updatePrAction } from "../../actions";
import { PrForm } from "../../PrForm";

export const metadata = { title: "Edit requisition" };
export const dynamic = "force-dynamic";

export default async function EditPrPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.PR_VIEW, P.PR_VIEW_ALL);
  if (!authorized) return <AccessDenied title="Edit requisition" />;

  const pr = await prisma.purchaseRequisition.findUnique({
    where: { id },
    include: { items: { orderBy: { lineNo: "asc" } }, entity: true },
  });
  if (!pr) notFound();

  const isOwner = pr.requesterId === user.id;
  if (!isOwner && !userHasPermission(user, P.PR_EDIT)) {
    return (
      <AccessDenied
        title={`Edit ${pr.number}`}
        message="Only the requester or a procurement officer may edit this requisition."
      />
    );
  }
  if (!["DRAFT", "RETURNED"].includes(pr.status)) {
    return (
      <AccessDenied
        title={`Edit ${pr.number}`}
        message={`This requisition is ${pr.status.replace(/_/g, " ").toLowerCase()} and can no longer be edited. Requisitions are only editable while a draft or after being returned.`}
      />
    );
  }

  const options = await prFormOptions(pr.entityId);
  const requireSpec = await getConfigBool(CONFIG_KEYS.PR_REQUIRE_SPEC, pr.entityId);

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Requisitions", href: "/pr" },
          { label: pr.number, href: `/pr/${pr.id}` },
          { label: "Edit" },
        ]}
      />
      <PageHeader
        title={`Edit ${pr.number}`}
        subtitle={pr.title}
        actions={<StatusBadge status={pr.status} />}
      />
      <PrForm
        mode="edit"
        action={updatePrAction}
        options={options}
        requireSpecification={requireSpec}
        returnReason={pr.returnReason}
        initial={{
          id: pr.id,
          number: pr.number,
          entityId: pr.entityId,
          departmentId: pr.departmentId,
          procurementType: pr.procurementType,
          title: pr.title,
          justification: pr.justification ?? "",
          projectId: pr.projectId ?? "",
          siteId: pr.siteId ?? "",
          costCenter: pr.costCenter ?? "",
          deliveryStoreId: pr.deliveryStoreId ?? "",
          deliveryLocationNote: pr.deliveryLocationNote ?? "",
          requiredDate: toInputDate(pr.requiredDate),
          priority: pr.priority,
          budgetAmount: pr.budgetAmount ? String(pr.budgetAmount) : "",
          budgetCode: pr.budgetCode ?? "",
          pmOwnerId: pr.pmOwnerId ?? "",
          boqReference: pr.boqReference ?? "",
          drawingReference: pr.drawingReference ?? "",
          technicalNotes: pr.technicalNotes ?? "",
          lines: pr.items.map((i, idx) => ({
            key: `existing-${idx}`,
            itemId: i.itemId,
            categoryId: i.categoryId,
            description: i.description,
            brand: i.brand ?? "",
            model: i.model ?? "",
            make: i.make ?? "",
            specification: i.specification ?? "",
            quantity: String(i.quantity),
            unit: i.unit,
            estimatedUnitPrice: i.estimatedUnitPrice ? String(i.estimatedUnitPrice) : "",
            disposition: i.disposition,
            notes: i.notes ?? "",
          })),
        }}
      />
    </div>
  );
}
