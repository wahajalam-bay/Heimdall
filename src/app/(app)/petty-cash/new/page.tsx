import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { EmptyState, PageHeader } from "@/components/ui/primitives";
import { pettyCashOptions } from "../actions";
import { PettyCashForm } from "../PettyCashForm";

export const metadata = { title: "Raise petty cash request" };
export const dynamic = "force-dynamic";

export default async function NewPettyCashPage() {
  const { ctx, authorized } = await pageContext(P.PETTY_CASH_CREATE);
  if (!authorized) {
    return (
      <AccessDenied
        title="Raise petty cash request"
        message="You do not have permission to raise petty cash requests."
      />
    );
  }

  const { entities, departments, stores, items } = await pettyCashOptions(null);

  // Limits and the quote rule are configuration, resolved per entity.
  const limitPairs = await Promise.all(
    entities.map(async (e) => [e.id, await getConfigNumber(CONFIG_KEYS.PETTY_CASH_LIMIT, e.id)] as const),
  );
  const limits = Object.fromEntries(limitPairs);
  const defaultEntityId = ctx.entityId && limits[ctx.entityId] !== undefined ? ctx.entityId : (entities[0]?.id ?? "");
  const minQuotes = await getConfigNumber(CONFIG_KEYS.PETTY_CASH_MIN_QUOTES, defaultEntityId || null);

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Procurement", href: "/petty-cash" },
          { label: "Petty cash", href: "/petty-cash" },
          { label: "New" },
        ]}
      />
      <PageHeader
        title="Raise a petty cash request"
        subtitle="For small, urgent purchases. The ceiling, the number of market quotes and the store-entry rule all come from configuration."
      />
      {entities.length === 0 ? (
        <EmptyState title="No entity available" description="You are not assigned to an entity that can raise petty cash." />
      ) : (
        <PettyCashForm
          entities={entities}
          departments={departments}
          stores={stores}
          items={items}
          limits={limits}
          defaultEntityId={defaultEntityId}
          minQuotes={minQuotes}
        />
      )}
    </div>
  );
}
