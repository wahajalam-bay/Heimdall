import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import { Badge, EmptyState, InlineAlert, Mono, PageHeader, StatTile } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { DocumentTypeForm } from "../AdminMasterForms";

export const metadata = { title: "Document types" };
export const dynamic = "force-dynamic";

/** appliesTo is stored as a JSON array; be forgiving about legacy plain strings. */
function parseApplies(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (typeof parsed === "string") return [parsed];
  } catch {
    if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export default async function AdminDocumentTypesPage() {
  const { authorized } = await pageContext(P.MASTER_DATA_MANAGE);
  if (!authorized) {
    return <AccessDenied title="Document types" message="You do not have permission to manage document types." />;
  }

  const types = await prisma.documentType.findMany({
    orderBy: [{ category: "asc" }, { name: "asc" }],
    include: { _count: { select: { documents: true } } },
  });

  const categories = [...new Set(types.map((t) => t.category))];
  const mandatory = types.filter((t) => t.required);
  const restricted = types.filter((t) => t.viewPermission);
  const unused = types.filter((t) => t._count.documents === 0 && t.active);

  const columns: TableColumn[] = [
    { key: "code", header: "Code", locked: true, sortable: true, width: "13rem" },
    { key: "name", header: "Document type", sortable: true, minWidth: "18rem" },
    { key: "category", header: "Category", filterable: true, sortable: true, width: "12rem" },
    { key: "appliesTo", header: "Attaches to", sortable: true, minWidth: "18rem" },
    { key: "required", header: "Mandatory", filterable: true, sortable: true, width: "9.5rem" },
    { key: "restricted", header: "Restricted", filterable: true, sortable: true, width: "9.5rem" },
    { key: "permission", header: "View permission", sortable: true, width: "15rem", defaultHidden: true },
    { key: "maxSize", header: "Max size (MB)", numeric: true, sortable: true, width: "10rem" },
    { key: "extensions", header: "Allowed types", sortable: true, minWidth: "16rem", defaultHidden: true },
    { key: "retention", header: "Retention", numeric: true, sortable: true, width: "9.5rem" },
    { key: "uploads", header: "Files on file", numeric: true, sortable: true, width: "10rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "8rem" },
    { key: "actions", header: "", width: "6rem", noExport: true },
  ];

  const rows: TableRow[] = types.map((t) => {
    const applies = parseApplies(t.appliesTo);
    return {
      id: t.id,
      flag: !t.active ? "danger" : t.required && t._count.documents === 0 ? "warning" : null,
      search: `${t.code} ${t.name} ${t.category} ${applies.join(" ")} ${t.viewPermission ?? ""}`,
      values: {
        code: t.code,
        name: t.name,
        category: t.category,
        appliesTo: applies.map(humanize).join(", "),
        required: t.required ? "Mandatory" : "Optional",
        restricted: t.viewPermission ? "Restricted" : "Open",
        permission: t.viewPermission ?? "",
        maxSize: t.maxSizeMb,
        extensions: t.allowedExtensions,
        retention: t.retentionMonths ?? 0,
        uploads: t._count.documents,
        status: t.active ? "Active" : "Inactive",
        actions: "",
      },
      cells: {
        code: <Mono>{t.code}</Mono>,
        name: t.name,
        category: <Badge tone="neutral">{t.category}</Badge>,
        appliesTo:
          applies.length === 0 ? (
            <Badge tone="warning">Nothing</Badge>
          ) : (
            <span className="flex flex-wrap gap-1">
              {applies.slice(0, 4).map((a) => (
                <Badge key={a} tone="neutral">
                  {humanize(a)}
                </Badge>
              ))}
              {applies.length > 4 && <Badge tone="neutral">+{applies.length - 4}</Badge>}
            </span>
          ),
        required: t.required ? <Badge tone="info">Mandatory</Badge> : "—",
        restricted: t.viewPermission ? <Badge tone="warning">Restricted</Badge> : "—",
        permission: t.viewPermission ? <Mono>{t.viewPermission}</Mono> : "—",
        maxSize: t.maxSizeMb,
        extensions: (
          <span className="mono block max-w-[18rem] truncate text-2xs" title={t.allowedExtensions}>
            {t.allowedExtensions}
          </span>
        ),
        retention: t.retentionMonths ? `${t.retentionMonths} mo` : "—",
        uploads: t._count.documents,
        status: t.active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Inactive</Badge>,
        actions: (
          <DocumentTypeForm
            categories={categories}
            initial={{
              id: t.id,
              code: t.code,
              name: t.name,
              category: t.category,
              appliesTo: applies,
              required: t.required,
              maxSizeMb: t.maxSizeMb,
              allowedExtensions: t.allowedExtensions,
              retentionMonths: t.retentionMonths,
              viewPermission: t.viewPermission,
              active: t.active,
            }}
          />
        ),
      },
    };
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Administration", href: "/admin" }, { label: "Document types" }]} />

      <PageHeader
        eyebrow="Administration"
        title="Document types"
        subtitle="What must be attached where, what file types are accepted, and which attachments are restricted. Access is enforced when the file is served, not by hiding it from a list."
        actions={<DocumentTypeForm categories={categories.length ? categories : ["General"]} />}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Document types" value={types.length} />
        <StatTile label="Mandatory" value={mandatory.length} hint="Block a stage until attached" />
        <StatTile
          label="Permission restricted"
          value={restricted.length}
          hint="Only visible to holders of a named permission"
        />
        <StatTile label="Files on record" value={types.reduce((a, t) => a + t._count.documents, 0)} />
      </div>

      {mandatory.length > 0 && (
        <InlineAlert tone="info">
          {mandatory.length} type{mandatory.length === 1 ? " is" : "s are"} mandatory:{" "}
          {mandatory.map((t) => t.name).join(", ")}. Stages that expect them will refuse to complete until the file is
          attached.
        </InlineAlert>
      )}

      {unused.length > 0 && (
        <InlineAlert tone="warning">
          {unused.length} active type{unused.length === 1 ? " has" : "s have"} never been used. Either they are genuinely
          rare, or people are attaching files under the wrong type.
        </InlineAlert>
      )}

      <DataTable
        id="admin-document-types"
        columns={columns}
        rows={rows}
        defaultSort={{ key: "category", dir: "asc" }}
        exportName="document-types"
        emptyState={
          <EmptyState
            title="No document types"
            description="Define the document types the business actually files so attachments are consistent and access is controlled."
          />
        }
      />
    </div>
  );
}
