import { prisma } from "@/lib/db";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs, TabNav } from "@/components/ui/nav";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, InlineAlert, Mono, PageHeader, StatTile } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { money, qty } from "@/lib/format";
import { CategoryForm, ItemForm } from "../AdminMasterForms";
import { tableLink } from "@/lib/links";

export const metadata = { title: "Catalogue" };
export const dynamic = "force-dynamic";

export default async function AdminCataloguePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { authorized } = await pageContext(P.MASTER_DATA_MANAGE);
  if (!authorized) {
    return <AccessDenied title="Catalogue" message="You do not have permission to manage the catalogue." />;
  }

  const tab = first((await searchParams).tab) === "categories" ? "categories" : "items";

  const [categories, items] = await Promise.all([
    prisma.category.findMany({
      orderBy: { name: "asc" },
      include: {
        parent: { select: { id: true, name: true } },
        _count: { select: { items: true, requisitionItems: true, assets: true, approvalRules: true } },
      },
    }),
    prisma.item.findMany({
      orderBy: { name: "asc" },
      include: {
        category: { select: { id: true, name: true, requiresInspection: true } },
        inventory: { select: { quantity: true, unitCost: true } },
        _count: { select: { requisitionItems: true, poItems: true, priceHistory: true } },
      },
    }),
  ]);

  const categoryOptions = categories.map((c) => ({ id: c.id, code: c.code, name: c.name }));
  const inspectionCategories = categories.filter((c) => c.requiresInspection);
  const trackedItems = items.filter((i) => i.trackSerial || i.trackBatch || i.trackExpiry);
  const withoutPrice = items.filter((i) => !i.standardPrice && i.active);

  const categoryColumns: TableColumn[] = [
    { key: "code", header: "Code", locked: true, sortable: true, width: "10rem" },
    { key: "name", header: "Category", sortable: true, minWidth: "18rem" },
    { key: "parent", header: "Parent", filterable: true, sortable: true, width: "14rem" },
    { key: "disposition", header: "Default disposition", filterable: true, sortable: true, width: "13rem" },
    { key: "inspection", header: "Inspection", filterable: true, sortable: true, width: "10rem" },
    { key: "template", header: "QC template", filterable: true, sortable: true, width: "13rem" },
    { key: "assetTag", header: "Asset tag", filterable: true, sortable: true, width: "9.5rem" },
    { key: "items", header: "Items", numeric: true, sortable: true, width: "7.5rem" },
    { key: "usage", header: "Requisition lines", numeric: true, sortable: true, width: "10rem" },
    { key: "rules", header: "Approval rules", numeric: true, sortable: true, width: "10rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "8rem" },
    { key: "actions", header: "", width: "6rem", noExport: true },
  ];

  const categoryRows: TableRow[] = categories.map((c) => ({
    id: c.id,
    flag: !c.active ? "danger" : null,
    search: `${c.code} ${c.name} ${c.parent?.name ?? ""}`,
    values: {
      code: c.code,
      name: c.name,
      parent: c.parent?.name ?? "",
      disposition: humanize(c.defaultDisposition),
      inspection: c.requiresInspection ? "Required" : "Not required",
      template: c.inspectionTemplate ? humanize(c.inspectionTemplate) : "",
      assetTag: c.assetTagRequired ? "Required" : "No",
      items: c._count.items,
      usage: c._count.requisitionItems,
      rules: c._count.approvalRules,
      status: c.active ? "Active" : "Inactive",
      actions: "",
    },
    cells: {
      code: <Mono>{c.code}</Mono>,
      name: c.name,
      parent: c.parent?.name ?? "—",
      disposition: <Badge tone="neutral">{humanize(c.defaultDisposition)}</Badge>,
      inspection: c.requiresInspection ? <Badge tone="info">Required</Badge> : "—",
      template: c.inspectionTemplate ? humanize(c.inspectionTemplate) : "—",
      assetTag: c.assetTagRequired ? <Badge tone="info">Required</Badge> : "—",
      items: c._count.items,
      usage: c._count.requisitionItems,
      rules: c._count.approvalRules,
      status: c.active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Inactive</Badge>,
      actions: (
        <CategoryForm
          categories={categoryOptions}
          initial={{
            id: c.id,
            code: c.code,
            name: c.name,
            parentId: c.parentId,
            requiresInspection: c.requiresInspection,
            inspectionTemplate: c.inspectionTemplate,
            defaultDisposition: c.defaultDisposition,
            assetTagRequired: c.assetTagRequired,
            active: c.active,
          }}
        />
      ),
    },
  }));

  const itemColumns: TableColumn[] = [
    { key: "sku", header: "SKU", locked: true, sortable: true, width: "11rem" },
    { key: "name", header: "Item", sortable: true, minWidth: "20rem" },
    { key: "category", header: "Category", filterable: true, sortable: true, width: "14rem" },
    { key: "unit", header: "Unit", filterable: true, sortable: true, width: "6.5rem" },
    { key: "brand", header: "Brand", filterable: true, sortable: true, width: "11rem", defaultHidden: true },
    { key: "standardPrice", header: "Standard price", numeric: true, sortable: true, width: "12rem" },
    // A missing standard price is a gap in the data rather than a value, so the
    // tile counting it points here.
    { key: "priceState", header: "Price set", filterable: true, sortable: true, width: "9rem", defaultHidden: true },
    { key: "onHand", header: "On hand", numeric: true, sortable: true, width: "9rem" },
    { key: "stockValue", header: "Stock value", numeric: true, sortable: true, width: "12rem" },
    { key: "reorder", header: "Reorder level", numeric: true, sortable: true, width: "10rem" },
    { key: "tracking", header: "Tracking", filterable: true, sortable: true, width: "13rem" },
    { key: "priceHistory", header: "Price points", numeric: true, sortable: true, width: "9.5rem" },
    { key: "usage", header: "Used on", numeric: true, sortable: true, width: "8.5rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "8rem" },
    { key: "actions", header: "", width: "6rem", noExport: true },
  ];

  const itemRows: TableRow[] = items.map((i) => {
    const onHand = i.inventory.reduce((a, x) => a + x.quantity, 0);
    const stockValue = i.inventory.reduce((a, x) => a + x.quantity * x.unitCost, 0);
    const tracking = [i.trackSerial && "Serial", i.trackBatch && "Batch", i.trackExpiry && "Expiry"]
      .filter(Boolean)
      .join(", ");
    return {
      id: i.id,
      flag: !i.active ? "danger" : !i.standardPrice ? "warning" : null,
      search: `${i.sku} ${i.name} ${i.brand ?? ""} ${i.model ?? ""} ${i.specification ?? ""}`,
      values: {
        sku: i.sku,
        name: i.name,
        category: i.category.name,
        unit: i.unit,
        brand: i.brand ?? "",
        standardPrice: i.standardPrice ?? 0,
        priceState: i.standardPrice ? "Set" : "Not set",
        onHand,
        stockValue,
        reorder: i.reorderLevel ?? 0,
        tracking: tracking || "None",
        priceHistory: i._count.priceHistory,
        usage: i._count.requisitionItems + i._count.poItems,
        status: i.active ? "Active" : "Inactive",
        actions: "",
      },
      cells: {
        sku: <Mono>{i.sku}</Mono>,
        name: (
          <span>
            <span className="block text-xs">{i.name}</span>
            {(i.brand || i.model) && (
              <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                {[i.brand, i.model].filter(Boolean).join(" · ")}
              </span>
            )}
          </span>
        ),
        category: (
          <span className="flex flex-wrap items-center gap-1.5">
            {i.category.name}
            {i.category.requiresInspection && <Badge tone="info">QC</Badge>}
          </span>
        ),
        unit: i.unit,
        brand: i.brand ?? "—",
        standardPrice: i.standardPrice ? <Mono>{money(i.standardPrice)}</Mono> : <Badge tone="warning">Not set</Badge>,
        priceState: i.standardPrice ? (
          <span className="text-[var(--c-text-tertiary)]">Set</span>
        ) : (
          <Badge tone="warning">Not set</Badge>
        ),
        onHand: onHand > 0 ? qty(onHand, i.unit) : "—",
        stockValue: stockValue > 0 ? <Mono>{money(stockValue)}</Mono> : "—",
        reorder: i.reorderLevel ?? "—",
        tracking: tracking ? <Badge tone="neutral">{tracking}</Badge> : "—",
        priceHistory: i._count.priceHistory,
        usage: i._count.requisitionItems + i._count.poItems,
        status: i.active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Inactive</Badge>,
        actions: (
          <ItemForm
            categories={categoryOptions}
            initial={{
              id: i.id,
              sku: i.sku,
              name: i.name,
              description: i.description,
              categoryId: i.categoryId,
              unit: i.unit,
              brand: i.brand,
              model: i.model,
              make: i.make,
              specification: i.specification,
              hsCode: i.hsCode,
              standardPrice: i.standardPrice,
              trackSerial: i.trackSerial,
              trackBatch: i.trackBatch,
              trackExpiry: i.trackExpiry,
              reorderLevel: i.reorderLevel,
              active: i.active,
            }}
          />
        ),
      },
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Administration", href: "/admin" }, { label: "Catalogue" }]} />

      <PageHeader
        eyebrow="Administration"
        title="Catalogue"
        subtitle="Categories drive inspection and asset-tagging rules; items give consistent descriptions, units and the price history that makes market comparison possible."
        actions={
          tab === "categories" ? (
            <CategoryForm categories={categoryOptions} />
          ) : (
            <ItemForm categories={categoryOptions} />
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Categories" value={categories.length} href="/admin/catalogue?tab=categories" />
        <StatTile label="Items" value={items.length} href="/admin/catalogue?tab=items" />
        <StatTile
          label="Inspection-required categories"
          value={inspectionCategories.length}
          hint="Goods cannot be received without QC"
          href={tableLink("/admin/catalogue", { inspection: "Required" }, { tab: "categories" })}
        />
        <StatTile
          label="Items without a standard price"
          value={withoutPrice.length}
          tone={withoutPrice.length ? "warning" : "success"}
          hint="No baseline for variance analysis"
          href={tableLink("/admin/catalogue", { priceState: "Not set" }, { tab: "items" })}
        />
      </div>

      {withoutPrice.length > 0 && (
        <InlineAlert tone="warning">
          {withoutPrice.length} active item{withoutPrice.length === 1 ? " has" : "s have"} no standard price. Price
          variance analysis and market comparison fall back to the last price paid, which is weaker evidence.
        </InlineAlert>
      )}

      <TabNav
        baseHref="/admin/catalogue"
        active={tab}
        tabs={[
          { key: "items", label: "Items", count: items.length },
          { key: "categories", label: "Categories", count: categories.length },
        ]}
      />

      {tab === "categories" ? (
        <DataTable
          id="admin-categories"
          columns={categoryColumns}
          rows={categoryRows}
          defaultSort={{ key: "name", dir: "asc" }}
          exportName="categories"
          emptyState={<EmptyState title="No categories" description="Create a category before adding items." />}
        />
      ) : (
        <DataTable
          id="admin-items"
          columns={itemColumns}
          rows={itemRows}
          defaultSort={{ key: "name", dir: "asc" }}
          exportName="items"
          emptyState={
            <EmptyState
              title="No catalogue items"
              description="Catalogued items keep descriptions and units consistent across requisitions, orders and stock."
            />
          }
        />
      )}

      {trackedItems.length > 0 && (
        <InlineAlert tone="info">
          {trackedItems.length} item{trackedItems.length === 1 ? " is" : "s are"} tracked by serial, batch or expiry.
          Receiving prompts for those details and inventory keeps them per bucket.
        </InlineAlert>
      )}
    </div>
  );
}
