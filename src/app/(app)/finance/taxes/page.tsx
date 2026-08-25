import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Badge, EmptyState, InlineAlert, PageHeader, SectionCard, StatTile } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { money, percent } from "@/lib/format";
import { TaxForm } from "./TaxForm";

export const metadata = { title: "Tax Rates" };
export const dynamic = "force-dynamic";

/**
 * Tax rates as data.
 *
 * A rate compiled into the application is a rate nobody can change on the day a
 * budget speech changes it. Withholding is flagged separately because it behaves
 * in the opposite direction: it is deducted from what the vendor receives rather
 * than added to what the organisation owes.
 */
export default async function TaxesPage() {
  const { user, authorized } = await pageContext(P.TAX_VIEW);
  if (!authorized) {
    return <AccessDenied title="Tax rates" message="You do not have permission to view tax rates." />;
  }

  const canManage = userHasPermission(user, P.TAX_MANAGE);
  const [taxes, entities, applied] = await Promise.all([
    prisma.tax.findMany({
      orderBy: [{ active: "desc" }, { code: "asc" }],
      include: { entity: { select: { code: true } }, _count: { select: { invoiceLines: true } } },
    }),
    prisma.entity.findMany({
      where: { active: true, id: { in: user.entityIds } },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    prisma.invoiceTaxLine.aggregate({ _sum: { amount: true }, _count: { _all: true } }),
  ]);

  const withheld = taxes.filter((t) => t.withheld);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Finance"
        title="Tax rates"
        subtitle="The rates the system applies, held as data so finance can change them without a release."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Rates on file" value={taxes.filter((t) => t.active).length} hint={`${taxes.length} including retired`} />
        <StatTile label="Withholding rates" value={withheld.length} hint="Deducted from vendor payment" />
        <StatTile label="Tax lines recorded" value={applied._count._all} hint="Across every invoice" />
        <StatTile
          label="Tax value recorded"
          value={money(applied._sum.amount ?? 0, "PKR", { compact: true })}
          hint="Sum of every tax line"
        />
      </div>

      <InlineAlert tone="info">
        The detailed tax and tax-parking process is marked open in the requirements. What is built here is the rate
        master and per-line application; the parking treatment awaits finance&rsquo;s confirmation.
      </InlineAlert>

      <SectionCard title="Rates" bodyClassName="px-0 pb-0">
        {taxes.length === 0 ? (
          <EmptyState
            title="No tax rates defined"
            description="Until a rate exists, invoices carry whatever tax was typed on them and nothing can be reconciled to a rate."
          />
        ) : (
          <div className="table-wrap">
            <table className="dt min-w-[42rem]">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th className="text-right">Rate</th>
                  <th>Direction</th>
                  <th>Entity</th>
                  <th>Ledger account</th>
                  <th className="text-right">Used on</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {taxes.map((t) => (
                  <tr key={t.id}>
                    <td className="mono text-xs">{t.code}</td>
                    <td className="text-xs font-500">{t.name}</td>
                    <td className="text-xs">{humanize(t.type)}</td>
                    <td className="num">{percent(t.rate, 2)}</td>
                    <td>
                      <Badge tone={t.withheld ? "warning" : "neutral"}>
                        {t.withheld ? "Withheld" : "Added"}
                      </Badge>
                    </td>
                    <td className="text-xs">{t.entity?.code ?? "All entities"}</td>
                    <td className="mono text-2xs">{t.glAccount ?? "—"}</td>
                    <td className="num">{t._count.invoiceLines}</td>
                    <td>
                      <Badge tone={t.active ? "success" : "neutral"}>{t.active ? "Active" : "Retired"}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {canManage && <TaxForm entities={entities} />}
    </div>
  );
}
