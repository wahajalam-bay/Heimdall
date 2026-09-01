import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { Badge, InlineAlert, Mono, PageHeader, SectionCard, StatTile } from "@/components/ui/primitives";
import { fmtDate, percent } from "@/lib/format";
import { boxCheckCoverage, unclassifiedItems } from "@/server/stacking";

export const metadata = { title: "Stacking" };
export const dynamic = "force-dynamic";

/**
 * Annexure 5 — the stacking taxonomy, and the box check on bulk receipts.
 *
 * Two clauses that were absent and are related in practice: RC-016's ten
 * stacking categories decide where goods go, and RC-003's box-by-box check
 * decides whether what arrived is what the paperwork says before any of it is
 * put away.
 *
 * Neither is enforced. Annexure 5 describes warehouse practice rather than a
 * control on a transaction, and blocking a delivery because a pallet was
 * unavailable would be inventing a rule the SOP does not state. What the page
 * does is make the gaps visible to the people who supervise receiving.
 */
export default async function StackingPage() {
  const { ctx, authorized } = await pageContext(P.INVENTORY_VIEW);
  if (!authorized) return <AccessDenied title="Stacking" />;

  const entityIds = visibleEntityIds(ctx.user);
  const since = new Date(Date.now() - 90 * 86_400_000);

  const [categories, unclassified, boxRows] = await Promise.all([
    prisma.stackingCategory.findMany({
      where: { active: true },
      orderBy: { sequence: "asc" },
      include: { _count: { select: { items: true } } },
    }),
    unclassifiedItems(),
    boxCheckCoverage({ entityIds, since }),
  ]);

  const unchecked = boxRows.filter((r) => r.unchecked);
  const partial = boxRows.filter((r) => r.partial);
  const withDiscrepancy = boxRows.filter((r) => r.withDiscrepancy > 0);
  const classified = categories.reduce((a, c) => a + c._count.items, 0);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Inventory", href: "/inventory" }, { label: "Stacking" }]} />

      <PageHeader
        eyebrow="Inventory"
        title="Stacking & receiving checks"
        subtitle="Annexure 5's ten stacking categories, and the box-by-box check RC-003 asks for on bulk receipts. Both are guidance the SOP gives receiving rather than gates on a transaction, so what is shown here is where practice and the annexure have parted company."
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="Stacking categories" value={categories.length} hint="Table 1.1 names ten" />
        <StatTile
          label="Items classified"
          value={classified}
          hint={unclassified.total ? `${unclassified.total} unclassified` : "All classified"}
          tone={unclassified.total ? "warning" : "success"}
        />
        <StatTile
          label="Bulk lines never opened"
          value={unchecked.length}
          hint="Last 90 days"
          tone={unchecked.length ? "danger" : "success"}
        />
        <StatTile
          label="Partly checked"
          value={partial.length}
          hint={`${withDiscrepancy.length} with a discrepancy found`}
          tone={partial.length ? "warning" : undefined}
        />
      </div>

      {unchecked.length > 0 && (
        <InlineAlert tone="danger">
          {unchecked.length} bulk delivery line{unchecked.length === 1 ? "" : "s"} in the last 90 days had more than
          one package and no box opened at all. RC-003 asks for the packing method verified and{" "}
          <span className="italic">each box</span> checked against the delivery documents — a package count on its own
          says only how many arrived, not that anybody looked inside.
        </InlineAlert>
      )}

      <SectionCard
        title="Table 1.1 — main categories for stacking of goods"
        description="Four of Annexure 5's rules can be checked from what a stacking record says, so those are flags. The rest is the annexure's own guidance, shown to whoever is stacking."
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ minWidth: "12rem" }}>Category</th>
                <th style={{ minWidth: "22rem" }}>Annexure 5&rsquo;s guidance</th>
                <th style={{ minWidth: "13rem" }}>Checkable rules</th>
                <th style={{ width: "6rem" }} className="text-right">
                  Items
                </th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => {
                const flags = [
                  c.requiresSecureStorage ? "strong room" : null,
                  c.requiresPallet ? "wooden pallet" : null,
                  c.groundLevelOnly ? "ground level" : null,
                  c.keepFromElectrical ? "away from electrical" : null,
                ].filter(Boolean) as string[];
                return (
                  <tr key={c.id}>
                    <td className="text-xs font-500">
                      {c.name}
                      <Mono className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{c.code}</Mono>
                    </td>
                    <td className="text-2xs leading-4">{c.guidance}</td>
                    <td className="text-2xs">
                      {flags.length ? (
                        <span className="flex flex-wrap gap-1">
                          {flags.map((f) => (
                            <Badge key={f} tone="neutral">
                              {f}
                            </Badge>
                          ))}
                        </span>
                      ) : (
                        <span className="text-[var(--c-text-tertiary)]">guidance only</span>
                      )}
                    </td>
                    <td className="tnum text-right">{c._count.items || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {unclassified.total > 0 && (
        <SectionCard
          title={`${unclassified.total} items with no stacking category`}
          description="Left unclassified rather than forced into the nearest name — a wrong stacking category gives a storekeeper wrong guidance, which is worse than none."
          bodyClassName="px-0 py-0"
        >
          <ul className="row-list">
            {unclassified.groups.map((g) => (
              <li key={g.category} className="px-3.5 py-2.5">
                <p className="text-xs font-500">
                  {g.category}
                  <span className="ml-2 text-2xs text-[var(--c-text-tertiary)]">{g.items.length}</span>
                </p>
                <p className="mt-0.5 text-2xs leading-4 text-muted">
                  {g.items.slice(0, 8).map((i) => i.sku).join(", ")}
                  {g.items.length > 8 ? `, and ${g.items.length - 8} more` : ""}
                </p>
              </li>
            ))}
          </ul>
          <p className="px-3.5 py-2.5 text-2xs leading-4 text-[var(--c-text-tertiary)]">
            Table 1.1&rsquo;s ten categories are office and trading goods: electronics, hardware, grocery,
            housekeeping, stationery, giveaways, IT equipment, furniture, branding and printing. Construction, HVAC,
            machinery, vehicles, safety equipment and services are not among them — the same coverage gap BD-013
            records for the inspection chart. These items need either a stacking category the annexure does not name,
            or a decision that they are stored outside its scope.
          </p>
        </SectionCard>
      )}

      <SectionCard
        title="Bulk receipts — RC-003"
        description="Lines delivered in more than one package, in the last 90 days. Coverage is boxes opened against boxes received."
        bodyClassName="px-0 py-0"
      >
        {boxRows.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-xs text-muted">
            No multi-package delivery lines in the period.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: "9rem" }}>Delivery</th>
                  <th style={{ minWidth: "14rem" }}>Line</th>
                  <th style={{ minWidth: "11rem" }}>Vendor</th>
                  <th style={{ width: "5rem" }} className="text-right">
                    Boxes
                  </th>
                  <th style={{ width: "6rem" }} className="text-right">
                    Checked
                  </th>
                  <th style={{ width: "7rem" }} className="text-right">
                    Coverage
                  </th>
                  <th style={{ width: "8rem" }}>Packing</th>
                </tr>
              </thead>
              <tbody>
                {boxRows.slice(0, 60).map((r) => (
                  <tr key={r.id}>
                    <td className="text-2xs">
                      <Link className="link" href={`/receiving/${r.deliveryId}`}>
                        <Mono className="text-2xs">{r.deliveryNumber}</Mono>
                      </Link>
                      <span className="mt-0.5 block text-[var(--c-text-tertiary)]">
                        {fmtDate(r.deliveryDate)}
                      </span>
                    </td>
                    <td className="text-xs">
                      {r.description}
                      {r.notes && (
                        <span className="mt-0.5 block text-2xs leading-4 text-[var(--c-text-tertiary)]">
                          {r.notes}
                        </span>
                      )}
                    </td>
                    <td className="text-2xs">{r.vendorName ?? "—"}</td>
                    <td className="tnum text-right">{r.packages}</td>
                    <td className="tnum text-right">
                      {r.checked}
                      {r.withDiscrepancy > 0 && (
                        <span className="ml-1 text-2xs text-[var(--c-danger)]">
                          {r.withDiscrepancy} off
                        </span>
                      )}
                    </td>
                    <td className="tnum text-right">
                      {r.coverage == null ? (
                        "—"
                      ) : r.coverage === 100 ? (
                        <span className="text-[var(--c-success)]">100%</span>
                      ) : r.coverage === 0 ? (
                        <span className="text-[var(--c-danger)]">none</span>
                      ) : (
                        <span className="text-[var(--c-warning)]">{r.coverage}%</span>
                      )}
                    </td>
                    <td className="text-2xs">
                      {r.packingMethodVerified ? (
                        <Badge tone="success">verified</Badge>
                      ) : (
                        <Badge tone="warning">not verified</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
