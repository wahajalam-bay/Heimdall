import { prisma } from "@/lib/db";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  InlineAlert,
  Mono,
  PageHeader,
  SectionCard,
  StatTile,
} from "@/components/ui/primitives";
import { money, amount } from "@/lib/format";
import { monthlyProposal } from "@/server/monthly-repeat";
import { ProposalPicker } from "./ProposalPicker";

export const metadata = { title: "Monthly repeat orders" };
export const dynamic = "force-dynamic";

/**
 * The §4.1 monthly repeat order proposal.
 *
 * The clause asks for "projected requirements for the whole next month" for a
 * named set of categories, compiled by a named owner. This is that projection,
 * with the arithmetic on every line — and it stops at a draft, because §4.1 has
 * the team generate the requisition and a requisition nobody chose to raise is a
 * commitment nobody owns.
 */
export default async function MonthlyRepeatPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { ctx, authorized } = await pageContext(P.REQUIREMENT_VIEW, P.REQUIREMENT_CREATE);
  if (!authorized) {
    return <AccessDenied title="Monthly repeat orders" />;
  }

  const sp = await searchParams;
  const storeId = first(sp.store) ?? null;
  const ownerRole = first(sp.owner) ?? null;
  const canDraft = userHasPermission(ctx.user, P.REQUIREMENT_CREATE);

  const [proposal, stores, departments] = await Promise.all([
    monthlyProposal({ entityId: ctx.entityId, storeId, ownerRole }),
    prisma.store.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.department.findMany({
      where: { active: true, ...(ctx.entityId ? { entityId: ctx.entityId } : {}) },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Requirements", href: "/requirements" },
          { label: "Monthly repeat" },
        ]}
      />

      <PageHeader
        eyebrow="Requirements"
        title={`Monthly repeat order — ${proposal.periodLabel}`}
        subtitle="ZAM/PUR/SOP-01 §4.1: projected requirements for the whole next month, compiled by procurement for IT equipment and by logistics for grocery and housekeeping. Projected from the issue ledger, less stock on hand and quantities already on order."
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="Lines projected" value={proposal.lines.length} hint={money(proposal.totalValue)} />
        <StatTile
          label="No pattern to project from"
          value={proposal.withheld.length}
          hint={proposal.withheld.length ? "Listed below with the reason" : "None"}
        />
        <StatTile
          label="Category has no owner"
          value={proposal.unassigned.length}
          hint={proposal.unassigned.length ? "§4.1 names none" : "All assigned"}
          tone={proposal.unassigned.length ? "warning" : undefined}
        />
        <StatTile
          label="Projection window"
          value={`${proposal.windowDays}d`}
          hint={`plus ${proposal.coverDays}d cover`}
        />
      </div>

      <div className="card flex flex-row flex-wrap items-end gap-3 px-3.5 py-3">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="min-w-[14rem]">
            <span className="label mb-1 block">Store</span>
            <select className="field" name="store" defaultValue={storeId ?? ""}>
              <option value="">All stores</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-[16rem]">
            <span className="label mb-1 block">Compiling team</span>
            <select className="field" name="owner" defaultValue={ownerRole ?? ""}>
              <option value="">Both teams</option>
              <option value="PROCUREMENT_OFFICER">Procurement — IT equipment</option>
              <option value="WAREHOUSE_MANAGER">Logistics — grocery and housekeeping</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary btn-sm">
            Recalculate
          </button>
        </form>
      </div>

      {proposal.unmatchedCategories.length > 0 && (
        <InlineAlert tone="warning">
          §4.1 names {proposal.unmatchedCategories.length} categor
          {proposal.unmatchedCategories.length === 1 ? "y" : "ies"} that no catalogue category answers to:{" "}
          {proposal.unmatchedCategories.map((c) => c.name).join(", ")}. The nearest catalogue names are different
          words, and guessing which policy word means which category would put a mapping nobody chose behind every
          monthly order. Rename the policy entry or the category so they meet.
        </InlineAlert>
      )}

      {proposal.categories.length > 0 && (
        <SectionCard
          title="Categories in scope"
          description="§4.1's own list, with the team the clause assigns to each."
          bodyClassName="px-3.5 py-3"
        >
          <div className="flex flex-wrap gap-2">
            {proposal.categories.map((c) => (
              <span key={c.name} className="inline-flex items-center gap-1.5 text-xs">
                <Badge tone={c.ownerRole ? "info" : "warning"}>{c.name}</Badge>
                <span className="text-2xs text-[var(--c-text-tertiary)]">
                  {c.ownerRole ? c.ownerRole.replace(/_/g, " ").toLowerCase() : "no owner named in §4.1"}
                </span>
              </span>
            ))}
          </div>
        </SectionCard>
      )}

      {proposal.unassigned.length > 0 && (
        <InlineAlert tone="warning">
          {proposal.unassigned.length} line{proposal.unassigned.length === 1 ? "" : "s"} fall in a category §4.1
          lists among the monthly supplies without naming a team to compile it — stationery is the clause&rsquo;s own
          example. Those lines are shown but unassigned rather than being quietly given to procurement or logistics.
          See PC-026.
        </InlineAlert>
      )}

      {proposal.lines.length === 0 ? (
        <InlineAlert tone="info">
          Nothing to propose for {proposal.periodLabel}. Either the categories in scope hold no stock with enough
          issue history to project from, or what they need is already on hand or on order.
        </InlineAlert>
      ) : (
        <ProposalPicker
          entityId={ctx.entityId ?? ""}
          storeId={storeId}
          ownerRole={ownerRole}
          period={proposal.periodLabel}
          canDraft={canDraft}
          departments={departments.map((d) => ({ id: d.id, label: `${d.code} — ${d.name}` }))}
          lines={proposal.lines.map((l) => ({
            itemId: l.itemId,
            sku: l.sku,
            name: l.name,
            categoryName: l.categoryName,
            ownerRole: l.ownerRole,
            unit: l.unit,
            perMonth: l.perMonth,
            movements: l.movements,
            onHand: l.onHand,
            reserved: l.reserved,
            onOrder: l.onOrder,
            suggestedQty: l.suggestedQty,
            estimatedValue: l.estimatedValue,
          }))}
        />
      )}

      {proposal.withheld.length > 0 && (
        <SectionCard
          title="No pattern to project from"
          description="Items in scope the ledger cannot forecast. Listed rather than omitted, so somebody who knows something the ledger does not can add them by hand."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: "10rem" }}>Item</th>
                  <th style={{ minWidth: "14rem" }}>Name</th>
                  <th style={{ width: "8rem" }} className="text-right">
                    On hand
                  </th>
                  <th style={{ minWidth: "16rem" }}>Why no figure</th>
                </tr>
              </thead>
              <tbody>
                {proposal.withheld.map((w) => (
                  <tr key={w.itemId}>
                    <td>
                      <Mono className="text-2xs">{w.sku}</Mono>
                    </td>
                    <td className="text-xs">{w.name}</td>
                    <td className="tnum text-right">
                      {amount(w.onHand, 2)} {w.unit}
                    </td>
                    <td className="text-2xs leading-4 text-muted">{w.withheld}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        Each figure is a month of average consumption plus {proposal.coverDays} days of cover, less what is available
        and less what is already on order. The last of those is what stops the proposal buying again what somebody
        ordered last week. The draft is recomputed when it is created, so anything received since this page loaded is
        already taken into account.
      </p>
    </div>
  );
}
