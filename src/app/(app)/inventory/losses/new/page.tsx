import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { PageHeader } from "@/components/ui/primitives";
import { LossReportForm } from "./LossReportForm";

export const metadata = { title: "File a loss report" };
export const dynamic = "force-dynamic";

export default async function NewLossReportPage() {
  const { ctx, authorized } = await pageContext(
    P.INVENTORY_ADJUST,
    P.STORE_ISSUE,
    P.RECEIVE_GOODS,
    P.AUDIT_VIEW,
  );
  if (!authorized) return <AccessDenied title="File a loss report" />;

  const [stores, items, assets] = await Promise.all([
    prisma.store.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.item.findMany({
      where: { active: true },
      select: { id: true, sku: true, name: true, unit: true },
      orderBy: { sku: "asc" },
      take: 800,
    }),
    prisma.asset.findMany({
      where: { status: { notIn: ["DISPOSED", "SCRAPPED", "LOST"] } },
      select: { id: true, tag: true, name: true },
      orderBy: { tag: "asc" },
      take: 600,
    }),
  ]);

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Stores", href: "/inventory" },
          { label: "Loss and theft", href: "/inventory/losses" },
          { label: "File" },
        ]}
      />
      <PageHeader
        eyebrow="Loss and theft"
        title="File a loss report"
        subtitle="Filing this does not move stock. The ledger correction is a separate authorised adjustment, taken once the case has been substantiated."
      />
      <LossReportForm
        entityId={ctx.entityId ?? ""}
        stores={stores}
        items={items.map((i) => ({
          id: i.id,
          label: `${i.sku} — ${i.name}`,
          unit: i.unit,
        }))}
        assets={assets.map((a) => ({ id: a.id, label: `${a.tag} — ${a.name}` }))}
      />
    </div>
  );
}
