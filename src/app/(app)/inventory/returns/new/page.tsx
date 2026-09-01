import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { PageHeader } from "@/components/ui/primitives";
import { ReceiveReturnForm } from "./ReceiveReturnForm";

export const metadata = { title: "Receive an employee return" };
export const dynamic = "force-dynamic";

export default async function NewEmployeeReturnPage() {
  const { authorized } = await pageContext(P.RECEIVE_GOODS, P.STORE_ISSUE, P.INVENTORY_ADJUST);
  if (!authorized) {
    return <AccessDenied title="Receive an employee return" />;
  }

  const [stores, people, items, assets] = await Promise.all([
    prisma.store.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.user.findMany({
      select: { id: true, name: true, title: true, active: true },
      orderBy: { name: "asc" },
      take: 600,
    }),
    prisma.item.findMany({
      where: { active: true },
      select: { id: true, sku: true, name: true, unit: true, category: { select: { code: true } } },
      orderBy: { sku: "asc" },
      take: 800,
    }),
    prisma.asset.findMany({
      where: { status: { in: ["ISSUED", "ACTIVE", "TRANSFERRED"] } },
      select: {
        id: true,
        tag: true,
        name: true,
        itemId: true,
        custodian: { select: { name: true } },
      },
      orderBy: { tag: "asc" },
      take: 600,
    }),
  ]);

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Stores", href: "/inventory" },
          { label: "Employee returns", href: "/inventory/returns" },
          { label: "Receive" },
        ]}
      />
      <PageHeader
        eyebrow="Employee returns"
        title="Receive an employee return"
        subtitle="This is the Store Receiving Note. Whether an IT inspection applies is decided from the items, not from a choice made here."
      />
      <ReceiveReturnForm
        stores={stores}
        people={people.map((p) => ({
          id: p.id,
          label: `${p.name}${p.title ? ` — ${p.title}` : ""}${p.active ? "" : " (inactive)"}`,
          name: p.name,
        }))}
        items={items.map((i) => ({
          id: i.id,
          label: `${i.sku} — ${i.name}`,
          unit: i.unit,
          isIt: i.category?.code === "IT-EQUIP" || i.category?.code === "IT-PERIPH",
        }))}
        assets={assets.map((a) => ({
          id: a.id,
          label: `${a.tag} — ${a.name}${a.custodian ? ` (${a.custodian.name})` : ""}`,
        }))}
      />
    </div>
  );
}
