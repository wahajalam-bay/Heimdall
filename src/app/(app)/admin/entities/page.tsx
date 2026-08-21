import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { CONFIG_KEYS, getConfigBool, getConfigNumber } from "@/lib/config";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  DefList,
  EmptyState,
  InlineAlert,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
} from "@/components/ui/primitives";
import { money } from "@/lib/format";
import { EntityForm } from "../AdminMasterForms";

export const metadata = { title: "Entities" };
export const dynamic = "force-dynamic";

export default async function AdminEntitiesPage() {
  const { authorized } = await pageContext(P.MASTER_DATA_MANAGE);
  if (!authorized) {
    return <AccessDenied title="Entities" message="You do not have permission to manage entities." />;
  }

  const entities = await prisma.entity.findMany({
    orderBy: { code: "asc" },
    include: {
      _count: {
        select: {
          departments: true,
          projects: true,
          sites: true,
          stores: true,
          requisitions: true,
          purchaseOrders: true,
          users: true,
        },
      },
      configs: { select: { key: true } },
    },
  });

  // Each entity's effective rules, so the difference between them is visible.
  const rules = await Promise.all(
    entities.map(async (e) => ({
      id: e.id,
      cpcEnabled: await getConfigBool(CONFIG_KEYS.CPC_ENABLED, e.id),
      cpcThreshold: await getConfigNumber(CONFIG_KEYS.CPC_THRESHOLD, e.id),
      pettyCashLimit: await getConfigNumber(CONFIG_KEYS.PETTY_CASH_LIMIT, e.id),
      minQuotes: await getConfigNumber(CONFIG_KEYS.MIN_QUOTATIONS, e.id),
    })),
  );
  const ruleById = new Map(rules.map((r) => [r.id, r]));

  const active = entities.filter((e) => e.active);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Administration", href: "/admin" }, { label: "Entities" }]} />

      <PageHeader
        eyebrow="Administration"
        title="Entities"
        subtitle="The legal companies this system runs for. Almost every record belongs to one, and business rules can differ between them."
        actions={<EntityForm />}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Entities" value={entities.length} />
        <StatTile label="Active" value={active.length} tone="success" />
        <StatTile
          label="Departments"
          value={entities.reduce((a, e) => a + e._count.departments, 0)}
        />
        <StatTile label="Stores" value={entities.reduce((a, e) => a + e._count.stores, 0)} />
      </div>

      <InlineAlert tone="info">
        Deactivating an entity does not delete its history. Existing records stay readable and auditable; new work simply
        cannot be raised against it.
      </InlineAlert>

      {entities.length === 0 ? (
        <EmptyState title="No entities" description="Add the first entity before anything else." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {entities.map((e) => {
            const r = ruleById.get(e.id);
            return (
              <SectionCard
                key={e.id}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <Mono>{e.code}</Mono>
                    {e.name}
                    {!e.active && <Badge tone="danger">Inactive</Badge>}
                  </span>
                }
                description={e.legalName ?? undefined}
                actions={
                  <EntityForm
                    initial={{
                      id: e.id,
                      code: e.code,
                      name: e.name,
                      legalName: e.legalName,
                      taxNumber: e.taxNumber,
                      logoText: e.logoText,
                      address: e.address,
                      city: e.city,
                      currency: e.currency,
                      active: e.active,
                    }}
                  />
                }
              >
                <DefList
                  columns={2}
                  items={[
                    { label: "Tax number", value: e.taxNumber ? <Mono>{e.taxNumber}</Mono> : "—" },
                    { label: "Short label", value: e.logoText ?? "—" },
                    { label: "Currency", value: e.currency },
                    { label: "City", value: e.city ?? "—" },
                    { label: "Address", value: e.address ?? "—", span: true },
                  ]}
                />

                <div className="mt-3 border-t border-[var(--c-border-subtle)] pt-3">
                  <span className="label mb-1.5 block">Rules in force</span>
                  {r ? (
                    <DefList
                      columns={2}
                      items={[
                        {
                          label: "CPC review",
                          value: r.cpcEnabled ? (
                            <span>
                              Above <span className="tnum font-500">{money(r.cpcThreshold)}</span>
                            </span>
                          ) : (
                            <Badge tone="neutral">Disabled</Badge>
                          ),
                        },
                        { label: "Petty cash ceiling", value: money(r.pettyCashLimit) },
                        { label: "Minimum quotations", value: r.minQuotes },
                        {
                          label: "Entity overrides",
                          value:
                            e.configs.length > 0 ? (
                              <RefLink href={`/admin/policies?entity=${e.id}`}>
                                {e.configs.length} override(s)
                              </RefLink>
                            ) : (
                              "Follows global"
                            ),
                        },
                      ]}
                    />
                  ) : null}
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[var(--c-border-subtle)] pt-3">
                  <Badge tone="neutral">{e._count.users} users</Badge>
                  <Badge tone="neutral">{e._count.departments} departments</Badge>
                  <Badge tone="neutral">{e._count.projects} projects</Badge>
                  <Badge tone="neutral">{e._count.sites} sites</Badge>
                  <Badge tone="neutral">{e._count.stores} stores</Badge>
                  <Badge tone="neutral">{e._count.requisitions} requisitions</Badge>
                  <Badge tone="neutral">{e._count.purchaseOrders} orders</Badge>
                </div>
              </SectionCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
