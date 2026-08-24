import Link from "next/link";
import { listDocuments, formatBytes, type LinkedType } from "@/server/documents";
import type { SessionUser } from "@/lib/rbac";
import { userHasPermission } from "@/lib/rbac";
import { PERMISSIONS as P } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { Badge, EmptyState, SectionCard, UserChip } from "@/components/ui/primitives";
import { fmtDateTime } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { DocumentPreview } from "./DocumentPreview";
import { DocumentUpload } from "./DocumentUpload";

const CONFIDENTIALITY_TONE: Record<string, "neutral" | "info" | "warning" | "danger"> = {
  PUBLIC: "neutral",
  INTERNAL: "info",
  CONFIDENTIAL: "warning",
  RESTRICTED: "danger",
};

/**
 * Central document timeline for a business object or a whole procurement case.
 * Documents the caller may not open are still listed — with the reason — so the
 * record is never silently incomplete.
 */
export async function DocumentsPanel({
  user,
  linkedType,
  linkedId,
  caseKey,
  entityId,
  title = "Documents",
  description,
  allowUpload = true,
  defaultCategory,
  compact,
}: {
  user: SessionUser;
  linkedType: LinkedType;
  linkedId: string;
  /** When set, shows every document across the case rather than one object. */
  caseKey?: string | null;
  entityId?: string | null;
  title?: string;
  description?: string;
  allowUpload?: boolean;
  defaultCategory?: string;
  compact?: boolean;
}) {
  const [docs, docTypes] = await Promise.all([
    listDocuments(user, caseKey ? { caseKey, includeSuperseded: true } : { linkedType, linkedId, includeSuperseded: true }),
    prisma.documentType.findMany({
      where: { active: true },
      select: { code: true, name: true, category: true, allowedExtensions: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const canUpload = allowUpload && userHasPermission(user, P.DOCUMENT_UPLOAD);
  const grouped = new Map<string, typeof docs>();
  for (const d of docs) {
    const arr = grouped.get(d.category) ?? [];
    arr.push(d);
    grouped.set(d.category, arr);
  }

  return (
    <SectionCard
      title={title}
      description={
        description ??
        (caseKey
          ? "Every document attached anywhere in this procurement case, newest first."
          : "Documents attached to this record.")
      }
      actions={
        <span className="flex items-center gap-2">
          <Badge tone="neutral">{docs.length} file{docs.length === 1 ? "" : "s"}</Badge>
        </span>
      }
      bodyClassName="px-0 py-0"
    >
      {canUpload && (
        <div className="border-b border-separator px-4 py-3.5">
          <DocumentUpload
            linkedType={linkedType}
            linkedId={linkedId}
            caseKey={caseKey ?? null}
            entityId={entityId ?? null}
            documentTypes={docTypes}
            defaultCategory={defaultCategory}
          />
        </div>
      )}

      {docs.length === 0 ? (
        <EmptyState
          compact
          title="No documents attached"
          description={
            canUpload
              ? "Attach the BOQ, drawings, quotations, delivery notes, inspection forms and invoices as the case progresses."
              : "Documents will appear here as the case progresses."
          }
        />
      ) : (
        <div className={compact ? "" : "row-list"}>
          {[...grouped.entries()].map(([category, items]) => (
            <div key={category} className="px-4 py-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="label">{category}</span>
                <span className="text-2xs text-[var(--c-text-tertiary)]">{items.length}</span>
              </div>
              <ul className="space-y-1.5">
                {items.map((d) => (
                  <li
                    key={d.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-separator px-2.5 py-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        {d.viewable ? (
                          <a
                            href={`/api/documents/${d.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="truncate text-[0.8125rem] font-500 text-[var(--c-accent-text)] hover:underline"
                          >
                            {d.name}
                          </a>
                        ) : (
                          <span className="truncate text-[0.8125rem] text-[var(--c-text-tertiary)]" title="You are not authorised to open this document">
                            {d.name}
                          </span>
                        )}
                        {d.version > 1 && <Badge tone="neutral">v{d.version}</Badge>}
                        {!d.isCurrent && <Badge tone="neutral">superseded</Badge>}
                        <Badge tone={CONFIDENTIALITY_TONE[d.confidentiality] ?? "neutral"}>
                          {humanize(d.confidentiality)}
                        </Badge>
                        {!d.viewable && <Badge tone="warning">restricted</Badge>}
                      </span>
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        {d.originalFilename} · {formatBytes(d.sizeBytes)}
                        {d.documentTypeName ? ` · ${d.documentTypeName}` : ""}
                        {caseKey ? ` · on ${humanize(d.linkedType)}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <UserChip name={d.uploadedByName} size={18} />
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{fmtDateTime(d.uploadedAt)}</span>
                    </span>
                    {d.viewable && (
                      <span className="flex shrink-0 items-center gap-1">
                        <DocumentPreview
                          id={d.id}
                          name={d.name}
                          mimeType={d.mimeType}
                          filename={d.originalFilename}
                          confidentiality={d.confidentiality}
                        />
                        <a
                          href={`/api/documents/${d.id}?download=1`}
                          className="btn btn-ghost btn-xs"
                          title="Download — access is logged"
                        >
                          Download
                        </a>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {userHasPermission(user, P.AUDIT_VIEW) && docs.length > 0 && (
        <div className="border-t border-separator px-4 py-2">
          <Link href={`/analytics/audit?entityType=Document`} className="text-2xs text-[var(--c-accent-text)]">
            View document access history in the audit trail
          </Link>
        </div>
      )}
    </SectionCard>
  );
}
