import { pageContext, first, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { EmptyState, PageHeader } from "@/components/ui/primitives";
import { stockForStore, storeOptions } from "@/app/(app)/stores/actions";
import { TransferForm } from "../TransferForm";

export const metadata = { title: "Raise store transfer" };
export const dynamic = "force-dynamic";

export default async function NewTransferPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { authorized } = await pageContext(P.STORE_TRANSFER);
  if (!authorized) {
    return <AccessDenied title="Raise store transfer" message="You do not have permission to transfer stock." />;
  }

  const requestedFrom = first((await searchParams).fromStoreId);
  // Transfers can cross entities, so the picker spans every store the user can read.
  const { stores } = await storeOptions(null);

  const initialFromStoreId = stores.some((s) => s.id === requestedFrom) ? requestedFrom! : (stores[0]?.id ?? "");
  const initialStock = initialFromStoreId ? await stockForStore(initialFromStoreId) : [];

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[{ label: "Stores", href: "/stores" }, { label: "Transfers", href: "/transfers" }, { label: "New" }]}
      />
      <PageHeader
        title="Raise a store transfer"
        subtitle="Moves stock from one store to another. Availability at the source is checked here and again on dispatch."
      />
      {stores.length < 2 ? (
        <EmptyState
          title="At least two stores are needed"
          description="A transfer needs a source and a destination store. Ask an administrator to set up the second store first."
        />
      ) : (
        <TransferForm stores={stores} initialFromStoreId={initialFromStoreId} initialStock={initialStock} />
      )}
    </div>
  );
}
