import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { InlineAlert, PageHeader } from "@/components/ui/primitives";
import { vendorFormOptions } from "../../actions";
import { VendorForm } from "../../VendorForm";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = await prisma.vendor.findUnique({ where: { id }, select: { name: true } });
  return { title: v ? `Edit ${v.name}` : "Edit vendor" };
}

export default async function EditVendorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.VENDOR_EDIT);
  if (!authorized) {
    return <AccessDenied title="Edit vendor" message="You do not have permission to edit vendor records." />;
  }

  const [vendor, { entities, categories }] = await Promise.all([
    prisma.vendor.findUnique({ where: { id }, include: { entityLinks: true } }),
    vendorFormOptions(),
  ]);
  if (!vendor) notFound();

  const canSeeFinancials = userHasPermission(user, P.VENDOR_FINANCIALS_VIEW);

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Vendors", href: "/vendors" },
          { label: vendor.name, href: `/vendors/${vendor.id}` },
          { label: "Edit" },
        ]}
      />
      <PageHeader title={`Edit ${vendor.name}`} subtitle="Every change is recorded field by field in the audit trail." />

      {vendor.status === "BLACKLISTED" && (
        <InlineAlert tone="danger">
          This vendor is blacklisted. Only a role holding the blacklist-decision permission may edit the record, and the
          change is logged.
        </InlineAlert>
      )}

      <VendorForm
        entities={entities}
        categories={categories}
        canSeeFinancials={canSeeFinancials}
        initial={{
          id: vendor.id,
          name: vendor.name,
          legalName: vendor.legalName,
          businessType: vendor.businessType,
          address: vendor.address,
          city: vendor.city,
          country: vendor.country,
          contactPerson: vendor.contactPerson,
          contactPhone: vendor.contactPhone,
          contactEmail: vendor.contactEmail,
          website: vendor.website,
          taxStatus: vendor.taxStatus,
          ntn: vendor.ntn,
          strn: vendor.strn,
          registrationNumber: vendor.registrationNumber,
          officeCount: vendor.officeCount,
          citiesCovered: vendor.citiesCovered,
          workforceCount: vendor.workforceCount,
          hasTransportation: vendor.hasTransportation,
          transportationNotes: vendor.transportationNotes,
          supportStaffCount: vendor.supportStaffCount,
          paymentTerms: vendor.paymentTerms,
          creditDays: vendor.creditDays,
          bankName: canSeeFinancials ? vendor.bankName : null,
          bankAccountTitle: canSeeFinancials ? vendor.bankAccountTitle : null,
          bankAccountNumber: canSeeFinancials ? vendor.bankAccountNumber : null,
          bankIban: canSeeFinancials ? vendor.bankIban : null,
          references: vendor.references,
          productsServices: vendor.productsServices,
          categories: vendor.categories,
          sourceChannel: vendor.sourceChannel,
          sourceNotes: vendor.sourceNotes,
          isTrader: vendor.isTrader,
          minimumOrderValue: vendor.minimumOrderValue,
          entityIds: vendor.entityLinks.map((l) => l.entityId),
        }}
      />
    </div>
  );
}
