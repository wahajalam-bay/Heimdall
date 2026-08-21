import { pageContext, first, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { EmptyState, PageHeader } from "@/components/ui/primitives";
import { stockForStore, storeOptions } from "@/app/(app)/stores/actions";
import { IssueForm } from "../IssueForm";

export const metadata = { title: "Raise stock issue" };
export const dynamic = "force-dynamic";

export default async function NewIssuePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { ctx, authorized } = await pageContext(P.STORE_ISSUE);
  if (!authorized) {
    return <AccessDenied title="Raise stock issue" message="You do not have permission to issue stock." />;
  }

  const requestedStore = first((await searchParams).storeId);
  const { stores, departments, projects, users } = await storeOptions(ctx.entityId);

  const initialStoreId = stores.some((s) => s.id === requestedStore) ? requestedStore! : (stores[0]?.id ?? "");
  const initialStock = initialStoreId ? await stockForStore(initialStoreId) : [];

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[{ label: "Stores", href: "/stores" }, { label: "Issuance", href: "/issuance" }, { label: "New" }]}
      />
      <PageHeader
        title="Raise a stock issue"
        subtitle="Requests stock out of a store for internal consumption. Availability is checked as you type and re-checked by the server before anything is released."
      />
      {stores.length === 0 ? (
        <EmptyState
          title="No stores available"
          description="You do not have a store in the selected entity. Switch entity, or ask an administrator to create one."
        />
      ) : (
        <IssueForm
          stores={stores}
          departments={departments}
          projects={projects}
          users={users}
          initialStoreId={initialStoreId}
          initialStock={initialStock}
        />
      )}
    </div>
  );
}
