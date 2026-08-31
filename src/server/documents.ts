import { createHash, randomUUID } from "node:crypto";
import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import type { Confidentiality } from "@/lib/domain";
import { getObject, putObject } from "@/lib/storage";

const ALLOWED_EXT = new Set([
  "pdf", "png", "jpg", "jpeg", "webp", "gif",
  "xlsx", "xls", "csv", "docx", "doc", "txt",
  "dwg", "dxf", "zip", "msg", "eml",
]);

const ALLOWED_MIME_PREFIXES = [
  "application/pdf",
  "image/",
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.ms-excel",
  "application/msword",
  "text/plain",
  "text/csv",
  "application/zip",
  "application/octet-stream", // DWG and similar CAD payloads
  "application/x-zip-compressed",
  "image/vnd.dwg",
];

const MAX_BYTES = 25 * 1024 * 1024;

/** Business objects a document may be linked to. */
export const LINKED_TYPES = [
  "PR", "RFQ", "QUOTE", "COMPARATIVE", "PO", "GATE_PASS", "DELIVERY",
  "INSPECTION", "GRN", "INVOICE", "VENDOR", "PETTY_CASH", "DISPOSAL",
  "ASSET", "CPC", "STORE_TRANSFER", "STORE_ISSUE",
] as const;
export type LinkedType = (typeof LINKED_TYPES)[number];

export type UploadInput = {
  file: File;
  linkedType: LinkedType;
  linkedId: string;
  caseKey?: string | null;
  category?: string;
  documentTypeCode?: string | null;
  description?: string | null;
  confidentiality?: Confidentiality;
  entityId?: string | null;
  tags?: string | null;
  /** Supersedes an existing document, creating version n+1. */
  replacesDocumentId?: string | null;
};

function extOf(name: string) {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

/** Strips directory traversal and unsafe characters from a filename. */
function safeName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/[^\w.\- ()]/g, "_").slice(0, 180);
}

export async function uploadDocument(user: SessionUser, input: UploadInput, db: DbClient = prisma) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.DOCUMENT_UPLOAD)) {
      throw new ForbiddenError("You do not have permission to upload documents.");
    }
    if (!LINKED_TYPES.includes(input.linkedType)) {
      throw new ValidationError("Documents must be linked to a valid business object.");
    }
    if (!input.linkedId) {
      throw new ValidationError("Documents must be linked to a specific record — unlinked uploads are not permitted.");
    }

    const file = input.file;
    if (!file || typeof file === "string" || file.size === 0) {
      throw new ValidationError("Select a file to upload.");
    }
    if (file.size > MAX_BYTES) {
      throw new ValidationError(`File exceeds the ${Math.round(MAX_BYTES / 1024 / 1024)}MB limit.`);
    }
    const ext = extOf(file.name);
    if (!ALLOWED_EXT.has(ext)) {
      throw new ValidationError(
        `File type ".${ext}" is not permitted. Allowed: ${[...ALLOWED_EXT].join(", ")}.`,
      );
    }
    const mime = file.type || "application/octet-stream";
    if (!ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p))) {
      throw new ValidationError(`Content type "${mime}" is not permitted.`);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    // Reject payloads whose magic bytes contradict a declared image/pdf type.
    if (mime === "application/pdf" && buf.subarray(0, 4).toString("latin1") !== "%PDF") {
      throw new ValidationError("This file is declared as a PDF but its contents are not a PDF.");
    }
    const checksum = createHash("sha256").update(buf).digest("hex");

    const now = new Date();
    // The key is stable and relative, so the same document row works whether the
    // bytes sit on a local disk or in a bucket.
    const rel = [
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      input.linkedType,
      `${randomUUID()}.${ext}`,
    ].join("/");
    await putObject(rel, buf, mime);

    let version = 1;
    let parentDocumentId: string | null = null;
    if (input.replacesDocumentId) {
      const prev = await tx.document.findUnique({ where: { id: input.replacesDocumentId } });
      if (prev) {
        version = prev.version + 1;
        parentDocumentId = prev.parentDocumentId ?? prev.id;
        await tx.document.updateMany({
          where: { OR: [{ id: prev.id }, { parentDocumentId }] },
          data: { isCurrent: false },
        });
      }
    }

    const docType = input.documentTypeCode
      ? await tx.documentType.findUnique({ where: { code: input.documentTypeCode } })
      : null;

    const doc = await tx.document.create({
      data: {
        name: input.description?.trim() || safeName(file.name),
        originalFilename: safeName(file.name),
        storagePath: rel,
        mimeType: mime,
        sizeBytes: buf.byteLength,
        checksum,
        version,
        parentDocumentId,
        documentTypeId: docType?.id ?? null,
        linkedType: input.linkedType,
        linkedId: input.linkedId,
        caseKey: input.caseKey ?? null,
        category: input.category ?? docType?.category ?? "General",
        description: input.description ?? null,
        tags: input.tags ?? null,
        confidentiality: input.confidentiality ?? docType?.viewPermission ? "CONFIDENTIAL" : (input.confidentiality ?? "INTERNAL"),
        entityId: input.entityId ?? null,
        uploadedById: user.id,
        isCurrent: true,
      },
    });

    await writeAudit(
      {
        entityType: "Document",
        entityId: doc.id,
        entityRef: doc.name,
        action: version > 1 ? "DOCUMENT_VERSIONED" : "DOCUMENT_UPLOADED",
        newValue: {
          linkedType: doc.linkedType,
          linkedId: doc.linkedId,
          version,
          sizeBytes: doc.sizeBytes,
          checksum,
          confidentiality: doc.confidentiality,
        },
        caseKey: input.caseKey ?? null,
        actor: user,
      },
      tx,
    );

    return doc;
  });
}

/** Confidentiality gate: RESTRICTED and CONFIDENTIAL need explicit grants. */
export function canViewDocument(
  user: SessionUser,
  doc: { confidentiality: string; uploadedById: string; entityId: string | null },
): boolean {
  if (!userHasPermission(user, P.DOCUMENT_VIEW)) return false;
  if (doc.uploadedById === user.id) return true;
  if (doc.entityId && !user.permissions.includes(P.ANALYTICS_VIEW_ALL_ENTITIES)) {
    if (!user.entityIds.includes(doc.entityId)) return false;
  }
  if (doc.confidentiality === "RESTRICTED") {
    return userHasPermission(user, P.DOCUMENT_VIEW_RESTRICTED);
  }
  if (doc.confidentiality === "CONFIDENTIAL") {
    return userHasPermission(user, P.DOCUMENT_VIEW_CONFIDENTIAL, P.DOCUMENT_VIEW_RESTRICTED);
  }
  return true;
}

export type DocumentSummary = {
  id: string;
  name: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  version: number;
  category: string;
  confidentiality: string;
  linkedType: string;
  linkedId: string;
  uploadedAt: Date;
  uploadedByName: string;
  documentTypeName: string | null;
  isCurrent: boolean;
  /** False when the caller may see that it exists but not open it. */
  viewable: boolean;
  /**
   * True when the descriptive fields above have been withheld because the
   * caller is not authorised to open the document.
   *
   * A filename is not neutral. "Vendor bank mandate — Al-Karam.pdf" on a live
   * tender tells a competitor's contact who is bidding and what stage they have
   * reached, and it does so without anybody opening anything. So the row still
   * appears — a case that hides the existence of its own attachments is worse —
   * but it carries no name, no filename, no size and no uploader.
   */
  redacted: boolean;
};

/** Strips everything descriptive, keeping only what makes the row legible. */
function redact(d: DocumentSummary): DocumentSummary {
  return {
    ...d,
    name: "Restricted document",
    originalFilename: "",
    mimeType: "application/octet-stream",
    sizeBytes: 0,
    // The id survives so that an attempt to fetch it is refused *and logged* by
    // `readDocument` rather than 404-ing anonymously.
    documentTypeName: null,
    uploadedByName: "—",
    redacted: true,
  };
}

/** Documents for a business object, or for a whole procurement case. */
export async function listDocuments(
  user: SessionUser,
  where: { linkedType?: LinkedType; linkedId?: string; caseKey?: string; includeSuperseded?: boolean },
  db: DbClient = prisma,
): Promise<DocumentSummary[]> {
  const docs = await db.document.findMany({
    where: {
      archived: false,
      ...(where.includeSuperseded ? {} : { isCurrent: true }),
      ...(where.caseKey
        ? { caseKey: where.caseKey }
        : { linkedType: where.linkedType, linkedId: where.linkedId }),
    },
    orderBy: [{ uploadedAt: "desc" }],
    include: { uploadedBy: { select: { name: true } }, documentType: { select: { name: true } } },
  });
  return docs.map((d) => {
    const summary: DocumentSummary = {
      id: d.id,
      name: d.name,
      originalFilename: d.originalFilename,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
      version: d.version,
      category: d.category,
      confidentiality: d.confidentiality,
      linkedType: d.linkedType,
      linkedId: d.linkedId,
      uploadedAt: d.uploadedAt,
      uploadedByName: d.uploadedBy.name,
      documentTypeName: d.documentType?.name ?? null,
      isCurrent: d.isCurrent,
      viewable: canViewDocument(user, d),
      redacted: false,
    };
    return summary.viewable ? summary : redact(summary);
  });
}

/** Streams a document after re-checking access and logging the attempt. */
export async function readDocument(user: SessionUser, id: string, action: "VIEW" | "DOWNLOAD", ip?: string | null) {
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc || doc.archived) throw new NotFoundError("Document");

  if (!canViewDocument(user, doc)) {
    await prisma.documentAccessLog.create({ data: { documentId: doc.id, userId: user.id, action: "DENIED", ip } });
    await writeAudit({
      entityType: "Document",
      entityId: doc.id,
      entityRef: doc.name,
      action: "DOCUMENT_ACCESS_DENIED",
      actor: user,
      ip,
    });
    throw new ForbiddenError("You are not authorised to open this document.");
  }

  let buf: Buffer;
  try {
    buf = await getObject(doc.storagePath);
  } catch {
    throw new NotFoundError("Stored file");
  }

  await prisma.documentAccessLog.create({ data: { documentId: doc.id, userId: user.id, action, ip } });
  return { doc, buf };
}

export async function archiveDocument(user: SessionUser, id: string, reason: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.DOCUMENT_DELETE)) {
    throw new ForbiddenError("You do not have permission to archive documents.");
  }
  const doc = await db.document.findUnique({ where: { id } });
  if (!doc) throw new NotFoundError("Document");
  await db.document.update({ where: { id }, data: { archived: true, isCurrent: false } });
  await writeAudit(
    {
      entityType: "Document",
      entityId: id,
      entityRef: doc.name,
      action: "DOCUMENT_ARCHIVED",
      reason,
      caseKey: doc.caseKey,
      actor: user,
    },
    db,
  );
  return doc;
}

/** Counts documents present per category, for requirement checks. */
export async function documentCategoryCounts(
  linkedType: LinkedType,
  linkedId: string,
  db: DbClient = prisma,
): Promise<Record<string, number>> {
  const rows = await db.document.groupBy({
    by: ["category"],
    where: { linkedType, linkedId, archived: false, isCurrent: true },
    _count: { _all: true },
  });
  const out: Record<string, number> = {};
  for (const r of rows) out[r.category] = r._count._all;
  return out;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
