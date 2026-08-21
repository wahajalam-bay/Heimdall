import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { canViewDocument, readDocument } from "@/server/documents";
import { expectRejection, userWithPermission, userWithoutPermission, without } from "./helpers";

/**
 * Document access control. The rule that matters is that a restricted file is
 * refused when it is opened, not merely hidden from a list — and that the
 * refusal is itself recorded.
 */
describe("document access control", () => {
  it("refuses a confidential document to a user without the confidentiality grant", async () => {
    const doc = await prisma.document.findFirst({
      where: { confidentiality: { in: ["CONFIDENTIAL", "RESTRICTED"] }, archived: false },
      select: { id: true, name: true, confidentiality: true, uploadedById: true, entityId: true },
    });
    if (!doc) return;

    const outsider = await userWithoutPermission(P.DOCUMENT_VIEW_CONFIDENTIAL, P.DOCUMENT_VIEW_RESTRICTED);
    // Never test against the uploader — ownership legitimately grants access.
    if (outsider.id === doc.uploadedById) return;

    expect(canViewDocument(outsider, doc)).toBe(false);
  });

  it("allows a confidential document to a user who holds the grant", async () => {
    const doc = await prisma.document.findFirst({
      where: { confidentiality: "CONFIDENTIAL", archived: false },
      select: { id: true, confidentiality: true, uploadedById: true, entityId: true },
    });
    if (!doc) return;

    const insider = await userWithPermission(P.DOCUMENT_VIEW_CONFIDENTIAL);
    if (!insider.entityIds.includes(doc.entityId ?? "") && doc.entityId) {
      // Entity scoping applies first; a cross-entity confidential file stays closed.
      expect(canViewDocument(insider, doc)).toBe(userHasPermission(insider, P.ANALYTICS_VIEW_ALL_ENTITIES));
      return;
    }
    expect(canViewDocument(insider, doc)).toBe(true);
  });

  it("refuses every document to a user with no document permission at all", async () => {
    const doc = await prisma.document.findFirst({
      where: { archived: false },
      select: { id: true, confidentiality: true, uploadedById: true, entityId: true },
    });
    if (!doc) return;

    const viewer = await userWithPermission(P.DOCUMENT_VIEW);
    const stripped = without(viewer, P.DOCUMENT_VIEW, P.DOCUMENT_VIEW_CONFIDENTIAL, P.DOCUMENT_VIEW_RESTRICTED);
    expect(canViewDocument(stripped, doc)).toBe(false);
  });

  it("refuses a cross-entity document to a user scoped to one entity", async () => {
    const entities = await prisma.entity.findMany({ select: { id: true } });
    if (entities.length < 2) return;

    const doc = await prisma.document.findFirst({
      where: { archived: false, NOT: { entityId: null } },
      select: { id: true, confidentiality: true, uploadedById: true, entityId: true },
    });
    if (!doc?.entityId) return;

    const users = await prisma.user.findMany({ where: { active: true }, include: { entityAccess: true } });
    const scoped = users.find(
      (u) =>
        u.primaryEntityId &&
        u.primaryEntityId !== doc.entityId &&
        !u.entityAccess.some((a) => a.entityId === doc.entityId) &&
        u.id !== doc.uploadedById,
    );
    if (!scoped) return;

    const { sessionFor } = await import("./helpers");
    const session = await sessionFor(scoped.email);
    if (userHasPermission(session, P.ANALYTICS_VIEW_ALL_ENTITIES)) return;
    expect(canViewDocument(session, doc)).toBe(false);
  });

  it("records a refusal in the access log when a document is opened without authority", async () => {
    const doc = await prisma.document.findFirst({
      where: { confidentiality: { in: ["CONFIDENTIAL", "RESTRICTED"] }, archived: false },
      select: { id: true, uploadedById: true },
    });
    if (!doc) return;

    const outsider = await userWithoutPermission(P.DOCUMENT_VIEW_CONFIDENTIAL, P.DOCUMENT_VIEW_RESTRICTED);
    if (outsider.id === doc.uploadedById) return;

    const before = await prisma.documentAccessLog.count({ where: { documentId: doc.id, action: "DENIED" } });
    const error = await expectRejection(readDocument(outsider, doc.id, "VIEW", "127.0.0.1"));
    expect(error.message).toMatch(/authorised|permission/i);

    const after = await prisma.documentAccessLog.count({ where: { documentId: doc.id, action: "DENIED" } });
    expect(after).toBe(before + 1);
  });

  it("keeps every document attached to a real record with an uploader", async () => {
    const documents = await prisma.document.findMany({
      select: { id: true, name: true, linkedType: true, linkedId: true, uploadedById: true },
      take: 500,
    });
    expect(documents.length).toBeGreaterThan(0);
    for (const d of documents) {
      expect(d.linkedType).toBeTruthy();
      expect(d.linkedId).toBeTruthy();
      expect(d.uploadedById).toBeTruthy();
    }
  });

  it("stamps a case key on documents that belong to a procurement case", async () => {
    const caseDocs = await prisma.document.findMany({
      where: { linkedType: { in: ["PR", "PO", "GRN", "INVOICE"] } },
      select: { name: true, caseKey: true, linkedType: true },
      take: 200,
    });
    // The case key is what makes the whole-case document view possible in one query.
    const withKey = caseDocs.filter((d) => d.caseKey);
    if (caseDocs.length > 0) expect(withKey.length).toBeGreaterThan(0);
  });
});

describe("mandatory references on material demands", () => {
  it("keeps a BOQ, drawing or technical note on every submitted material demand", async () => {
    const mds = await prisma.purchaseRequisition.findMany({
      where: { procurementType: "MATERIAL_DEMAND", status: { notIn: ["DRAFT", "REJECTED", "CANCELLED"] } },
      select: { number: true, boqReference: true, drawingReference: true, technicalNotes: true },
    });
    for (const md of mds) {
      expect(!!(md.boqReference || md.drawingReference || md.technicalNotes)).toBe(true);
    }
  });

  it("attaches supporting documents to a submitted material demand", async () => {
    const md = await prisma.purchaseRequisition.findFirst({
      where: { procurementType: "MATERIAL_DEMAND", status: { notIn: ["DRAFT"] } },
      select: { id: true, number: true },
      orderBy: { createdAt: "asc" },
    });
    if (!md) return;
    const docs = await prisma.document.count({ where: { linkedType: "PR", linkedId: md.id, archived: false } });
    expect(docs).toBeGreaterThan(0);
  });
});

describe("audit trail", () => {
  it("records an actor and an action on every entry", async () => {
    const logs = await prisma.auditLog.findMany({
      select: { id: true, action: true, actorName: true, entityType: true },
      take: 3000,
    });
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) {
      expect(l.action).toBeTruthy();
      expect(l.entityType).toBeTruthy();
      expect(l.actorName ?? "").not.toBe("");
    }
  });

  it("records a written reason on every waiver, cancellation and reinstatement", async () => {
    const sensitive = await prisma.auditLog.findMany({
      where: {
        OR: [
          { action: { contains: "WAIVED" } },
          { action: { contains: "CANCELLED" } },
          { action: { contains: "OVERRIDE" } },
          { action: { contains: "REINSTATED" } },
        ],
      },
      select: { action: true, entityRef: true, reason: true },
    });
    const missing = sensitive.filter((s) => !s.reason?.trim());
    expect(missing.map((m) => `${m.action} ${m.entityRef ?? ""}`)).toEqual([]);
  });

  it("groups a case's events under a single case key", async () => {
    const pr = await prisma.purchaseRequisition.findFirst({
      select: { number: true },
      orderBy: { createdAt: "asc" },
    });
    if (!pr) return;
    const events = await prisma.auditLog.count({ where: { caseKey: pr.number } });
    expect(events).toBeGreaterThan(0);
  });

  it("keeps more audit entries than the documents they describe", async () => {
    const [logs, prs, pos, grns, invoices] = await Promise.all([
      prisma.auditLog.count(),
      prisma.purchaseRequisition.count(),
      prisma.purchaseOrder.count(),
      prisma.grn.count(),
      prisma.invoice.count(),
    ]);
    expect(logs).toBeGreaterThan(prs + pos + grns + invoices);
  });
});
