import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { PageHeader } from "@/components/ui/primitives";
import { vendorFormOptions } from "../actions";
import { VendorForm } from "../VendorForm";

export const metadata = { title: "Register vendor" };
export const dynamic = "force-dynamic";

export default async function NewVendorPage() {
  const { user, authorized } = await pageContext(P.VENDOR_CREATE);
  if (!authorized) {
    return <AccessDenied title="Register vendor" message="You do not have permission to register vendors." />;
  }
  const { entities, categories } = await vendorFormOptions();

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Vendors", href: "/vendors" }, { label: "Register" }]} />
      <PageHeader
        title="Register a vendor"
        subtitle="Capture the profile the pre-qualification criteria will be scored against. The vendor stays unusable until it is scored and approved."
      />
      <VendorForm
        entities={entities}
        categories={categories}
        canSeeFinancials={userHasPermission(user, P.VENDOR_FINANCIALS_VIEW)}
      />
    </div>
  );
}
