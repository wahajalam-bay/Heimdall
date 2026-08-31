import { prisma } from "@/lib/db";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  InlineAlert,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
} from "@/components/ui/primitives";
import { money, amount, fmtDate } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { capitalisationPolicy } from "@/lib/treatment";
import { expenseBook, type ExpenseBookRow } from "@/server/expense-book";

export const metadata = { title: "Expense book" };
export const dynamic = "force-dynamic";

/** One dimension's table. Same shape six times, so it is written once. */
function Dimension({
  title,
  description,
  rows,
  labelHeader,
}: {
  title: string;
  description: string;
  rows: ExpenseBookRow[];
  labelHeader: string;
}) {
  if (!rows.length) return null;
  return (
    <SectionCard title={title} description={description} bodyClassName="px-0 py-0">
      <div className="table-wrap">
        <table className="dt">
          <thead>
            <tr>
              <th style={{ minWidth: "14rem" }}>{labelHeader}</th>
              <th style={{ width: "6rem" }} className="text-right">
                Asset qty
              </th>
              <th style={{ width: "9rem" }} className="text-right">
                Asset value
              </th>
              <th style={{ width: "8rem" }} className="text-right">
                Consumable qty
              </th>
              <th style={{ width: "9rem" }} className="text-right">
                Consumable value
              </th>
              <th style={{ width: "8rem" }} className="text-right">
                Into stock
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 40).map((r) => (
              <tr key={r.key}>
                <td>
                  {r.label}
                  {r.sublabel && (
                    <Mono className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{r.sublabel}</Mono>
                  )}
                </td>
                <td className="tnum text-right">{r.totals.assetQty || "—"}</td>
                <td className="tnum text-right">{r.totals.assetValue ? money(r.totals.assetValue) : "—"}</td>
                <td className="tnum text-right">{r.totals.consumableQty || "—"}</td>
                <td className="tnum text-right">
                  {r.totals.consumableValue ? money(r.totals.consumableValue) : "—"}
                </td>
                <td className="tnum text-right">
                  {r.totals.inventoryValue ? money(r.totals.inventoryValue) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

/**
 * The Expense Book.
 *
 * Of the ten air conditioners bought this year, how many became office assets
 * and how many became project cost? An Item Master flag cannot answer that,
 * because the answer differs per receipt — so the evidence is the receipt line,
 * and every figure here walks back to a GRN, an order and a requisition.
 */
export default async function ExpenseBookPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { ctx, authorized } = await pageContext(P.ANALYTICS_VIEW, P.INVENTORY_VIEW);
  if (!authorized) {
    return <AccessDenied title="Expense book" message="You do not have access to procurement analytics." />;
  }

  const sp = await searchParams;
  const months = Number(first(sp.months) ?? 12) || 12;
  const from = new Date(Date.now() - months * 30 * 86400000);
  const categoryId = first(sp.category) ?? null;
  const projectId = first(sp.project) ?? null;

  const [book, policy, categories, projects] = await Promise.all([
    expenseBook({
      entityIds: visibleEntityIds(ctx.user),
      from,
      categoryId,
      projectId: projectId === "__office" ? null : projectId,
    }),
    capitalisationPolicy(ctx.entityId),
    prisma.category.findMany({ select: { id: true, name: true, code: true }, orderBy: { name: "asc" } }),
    prisma.project.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" }, take: 100 }),
  ]);

  const t = book.overall;
  const totalValue = t.assetValue + t.consumableValue + t.inventoryValue;
  const unreasoned = book.overrides.filter((o) => !o.reason);
  const unapprovedBelow = book.overrides.filter((o) => o.belowThreshold && !o.approvedBy);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Analytics", href: "/analytics" }, { label: "Expense book" }]} />

      <PageHeader
        eyebrow="Analytics"
        title="Expense book"
        subtitle="What was capitalised and what was consumed, by item, category, department, project and vendor. The treatment is decided on the receipt, so that is what this counts."
      />

      <div className="card flex flex-row flex-wrap items-end gap-3 px-3.5 py-3">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="min-w-[9rem]">
            <span className="label mb-1 block">Period</span>
            <select className="field" name="months" defaultValue={String(months)}>
              <option value="3">Last 3 months</option>
              <option value="6">Last 6 months</option>
              <option value="12">Last 12 months</option>
              <option value="24">Last 24 months</option>
            </select>
          </label>
          <label className="min-w-[13rem]">
            <span className="label mb-1 block">Category</span>
            <select className="field" name="category" defaultValue={categoryId ?? ""}>
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-[13rem]">
            <span className="label mb-1 block">Project</span>
            <select className="field" name="project" defaultValue={projectId ?? ""}>
              <option value="">All</option>
              <option value="__office">Office / non-project only</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-primary btn-sm">
            Show
          </button>
        </form>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Capitalised"
          value={money(t.assetValue)}
          hint={`${amount(t.assetQty, 0)} units on the asset register`}
        />
        <StatTile
          label="Consumed"
          value={money(t.consumableValue)}
          hint={`${amount(t.consumableQty, 0)} units expensed or used on projects`}
        />
        <StatTile
          label="Into stock"
          value={money(t.inventoryValue)}
          hint={`${amount(t.inventoryQty, 0)} units still inventory`}
        />
        <StatTile
          label="Receipt lines"
          value={t.lines}
          hint={totalValue ? `${money(totalValue)} in total` : undefined}
        />
      </div>

      {t.lines === 0 && (
        <InlineAlert tone="info">
          No posted receipts in this period. The expense book reads treatment from receipt lines, so it fills up as
          goods are received.
        </InlineAlert>
      )}

      {book.splitTreatment.length > 0 && (
        <SectionCard
          title="Items treated both ways"
          description="Not an error — this is the whole point. The same item is a fixed asset in an office and a project cost on a build-out, and here is where that shows."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ minWidth: "14rem" }}>Item</th>
                  <th style={{ width: "7rem" }} className="text-right">
                    As asset
                  </th>
                  <th style={{ width: "9rem" }} className="text-right">
                    Asset value
                  </th>
                  <th style={{ width: "8rem" }} className="text-right">
                    As consumable
                  </th>
                  <th style={{ width: "9rem" }} className="text-right">
                    Consumable value
                  </th>
                </tr>
              </thead>
              <tbody>
                {book.splitTreatment.map((r) => (
                  <tr key={r.itemId}>
                    <td>
                      {r.name}
                      <Mono className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{r.sku}</Mono>
                    </td>
                    <td className="tnum text-right">{r.assetQty}</td>
                    <td className="tnum text-right">{money(r.assetValue)}</td>
                    <td className="tnum text-right">{r.consumableQty}</td>
                    <td className="tnum text-right">{money(r.consumableValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {(unreasoned.length > 0 || unapprovedBelow.length > 0) && (
        <InlineAlert tone="warning">
          {unreasoned.length > 0 && (
            <>
              {unreasoned.length} line{unreasoned.length === 1 ? "" : "s"} departed from the item&rsquo;s default
              treatment with no reason recorded.{" "}
            </>
          )}
          {unapprovedBelow.length > 0 && (
            <>
              {unapprovedBelow.length} line{unapprovedBelow.length === 1 ? "" : "s"} capitalised below the PKR{" "}
              {policy.threshold.toLocaleString("en-PK")} threshold without a recorded approval.
            </>
          )}{" "}
          These predate the control rather than bypassing it — a reason and an approval are now required at the point
          of receipt.
        </InlineAlert>
      )}

      {book.overrides.length > 0 && (
        <SectionCard
          title="Treatment overrides"
          description={`Lines recorded as something other than the item's default, and lines capitalised below the PKR ${policy.threshold.toLocaleString("en-PK")} threshold. Mode: ${humanize(policy.mode)}.`}
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: "9rem" }}>Receipt</th>
                  <th style={{ minWidth: "12rem" }}>Line</th>
                  <th style={{ width: "13rem" }}>Treatment</th>
                  <th style={{ width: "9rem" }} className="text-right">
                    Value
                  </th>
                  <th style={{ minWidth: "14rem" }}>Reason</th>
                  <th style={{ width: "10rem" }}>Approved by</th>
                </tr>
              </thead>
              <tbody>
                {book.overrides.slice(0, 80).map((o, i) => (
                  <tr key={`${o.grnId}-${o.lineNo}-${i}`}>
                    <td>
                      <RefLink href={`/grn/${o.grnId}`}>{o.grnNumber}</RefLink>
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        {o.postedAt ? fmtDate(o.postedAt) : ""}
                      </span>
                    </td>
                    <td>
                      {o.description}
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        {o.poNumber}
                        {o.prNumber ? ` · ${o.prNumber}` : ""}
                      </span>
                    </td>
                    <td className="text-xs">
                      {o.from !== "—" && o.from !== o.to ? (
                        <>
                          {humanize(o.from)} → <strong>{humanize(o.to)}</strong>
                        </>
                      ) : (
                        humanize(o.to)
                      )}
                      {o.belowThreshold && (
                        <Badge tone="warning" className="ml-1">
                          below threshold
                        </Badge>
                      )}
                    </td>
                    <td className="tnum text-right">{money(o.value)}</td>
                    <td className="text-xs leading-5">
                      {o.reason ?? <span className="text-[var(--c-warn-text)]">Not recorded</span>}
                    </td>
                    <td className="text-xs">
                      {o.approvedBy ?? (
                        <span className={o.belowThreshold ? "text-[var(--c-warn-text)]" : undefined}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <Dimension
        title="By item"
        description="Where the split shows most clearly. An item appearing in both columns was treated differently on different receipts."
        rows={book.byItem}
        labelHeader="Item"
      />
      <Dimension
        title="By category"
        description="Useful for spotting a category whose default treatment no longer matches how it is actually being used."
        rows={book.byCategory}
        labelHeader="Category"
      />
      <Dimension
        title="By project and office"
        description="Project spend against office spend — the contrast the treatment rule exists to express."
        rows={book.byProject}
        labelHeader="Project"
      />
      <Dimension
        title="By department"
        description="Who is capitalising and who is consuming."
        rows={book.byDepartment}
        labelHeader="Department"
      />
      <Dimension
        title="By vendor"
        description="What each vendor supplied, split by how it was treated."
        rows={book.byVendor}
        labelHeader="Vendor"
      />

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        Treatment is read from posted receipt lines, because that is where it is decided. The capitalisation threshold
        and its mode are configuration — see Business rules, group &ldquo;Accounting treatment&rdquo;.
      </p>
    </div>
  );
}
