import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { PERMISSIONS as P } from "@/lib/permissions";
import { toCsv, round2 } from "@/lib/format";
import { writeAudit } from "@/lib/audit";
import { bottlenecks, savingsRows, spendByDimension, vendorAnalytics } from "@/server/analytics";

/**
 * CSV export endpoint. Each report declares the permission it needs and is
 * scoped to the caller's readable entities; the export itself is audited so a
 * data pull is as traceable as any other action.
 */

type Row = Record<string, unknown>;

const REPORTS: Record<
  string,
  {
    label: string;
    perms: string[];
    build: (args: { entityIds: string[] | null; from: Date | null; to: Date | null }) => Promise<Row[]>;
  }
> = {
  spend: {
    label: "Spend by category",
    perms: [P.ANALYTICS_VIEW],
    build: async ({ entityIds, from, to }) => {
      const slices = await spendByDimension("category", { entityIds, from, to });
      const total = slices.reduce((a, s) => a + s.value, 0);
      return slices.map((s) => ({
        category: s.label,
        spend: s.value,
        sharePercent: total > 0 ? round2((s.value / total) * 100) : 0,
        orderLines: s.count,
      }));
    },
  },
  "spend-vendor": {
    label: "Spend by vendor",
    perms: [P.ANALYTICS_VIEW],
    build: async ({ entityIds, from, to }) => {
      const slices = await spendByDimension("vendor", { entityIds, from, to });
      const total = slices.reduce((a, s) => a + s.value, 0);
      return slices.map((s) => ({
        vendor: s.label,
        spend: s.value,
        sharePercent: total > 0 ? round2((s.value / total) * 100) : 0,
        orders: s.count,
      }));
    },
  },
  savings: {
    label: "Savings register",
    perms: [P.ANALYTICS_VIEW],
    build: async ({ entityIds, from, to }) => {
      const rows = await savingsRows({ entityIds, from, to });
      return rows.map((r) => ({
        recordedAt: r.recordedAt.toISOString().slice(0, 10),
        entity: r.entityCode ?? "",
        po: r.poNumber ?? "",
        vendor: r.vendorName ?? "",
        category: r.categoryName ?? "",
        item: r.itemDescription,
        quantity: r.quantity,
        marketPrice: r.marketPrice ?? "",
        previousPrice: r.previousPrice ?? "",
        initialQuote: r.initialQuote ?? "",
        negotiatedPrice: r.negotiatedPrice ?? "",
        finalPrice: r.finalPrice,
        savingsPerUnit: r.savingsPerUnit,
        totalSavings: r.totalSavings,
        savingsPercent: r.savingsPercent,
        savingsType: r.savingsType,
        notes: r.notes ?? "",
      }));
    },
  },
  vendors: {
    label: "Vendor analytics",
    perms: [P.VENDOR_VIEW],
    build: async ({ entityIds }) => {
      const rows = await vendorAnalytics({ entityIds });
      return rows.map((v) => ({
        code: v.code,
        vendor: v.name,
        status: v.status,
        businessType: v.businessType,
        city: v.city ?? "",
        orders: v.orders,
        spend: v.spend,
        concentrationPercent: v.concentrationPercent,
        qualificationPercent: v.qualificationPercent ?? "",
        performanceScore: v.score ?? "",
        onTimePercent: v.onTimePercent ?? "",
        qualityPercent: v.qualityPercent ?? "",
        rejectionPercent: v.rejectionPercent ?? "",
        openIssues: v.openIssues,
        invoiceIssues: v.invoiceIssues,
        lastOrderAt: v.lastOrderAt ? v.lastOrderAt.toISOString().slice(0, 10) : "",
      }));
    },
  },
  bottlenecks: {
    label: "Bottlenecks",
    perms: [P.ANALYTICS_VIEW],
    build: async ({ entityIds }) => {
      const rows = await bottlenecks({ entityIds });
      return rows.map((b) => ({
        stage: b.stage,
        documentType: b.documentType,
        reference: b.documentRef,
        title: b.title,
        owner: b.owner,
        entity: b.entityCode ?? "",
        ageHours: b.ageHours,
        slaHours: b.slaHours ?? "",
        overdue: b.overdue ? "YES" : "NO",
        severity: b.severity,
        value: b.value ?? "",
        reason: b.reason,
        nextAction: b.nextAction,
      }));
    },
  },
  pr: {
    label: "Purchase requisitions",
    perms: [P.PR_VIEW],
    build: async ({ entityIds, from, to }) => {
      const prs = await prisma.purchaseRequisition.findMany({
        where: {
          ...(entityIds ? { entityId: { in: entityIds } } : {}),
          ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        },
        include: {
          entity: { select: { code: true } },
          department: { select: { name: true } },
          project: { select: { code: true } },
          requester: { select: { name: true } },
          items: { select: { id: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      return prs.map((p) => ({
        number: p.number,
        entity: p.entity.code,
        title: p.title,
        status: p.status,
        procurementType: p.procurementType,
        priority: p.priority,
        department: p.department.name,
        project: p.project?.code ?? "",
        requester: p.requester.name,
        estimatedValue: p.estimatedValue,
        lines: p.items.length,
        raisedAt: p.createdAt.toISOString().slice(0, 10),
        requiredBy: p.requiredDate ? p.requiredDate.toISOString().slice(0, 10) : "",
      }));
    },
  },
  po: {
    label: "Purchase orders",
    perms: [P.PO_VIEW],
    build: async ({ entityIds, from, to }) => {
      const pos = await prisma.purchaseOrder.findMany({
        where: {
          ...(entityIds ? { entityId: { in: entityIds } } : {}),
          ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        },
        include: {
          entity: { select: { code: true } },
          vendor: { select: { name: true } },
          pr: { select: { number: true } },
          items: { select: { quantity: true, acceptedQty: true, invoicedQty: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      return pos.map((p) => ({
        number: p.number,
        entity: p.entity.code,
        requisition: p.pr?.number ?? "",
        vendor: p.vendor.name,
        status: p.status,
        subtotal: p.subtotal,
        tax: p.taxAmount,
        total: p.total,
        orderedQty: round2(p.items.reduce((a, i) => a + i.quantity, 0)),
        acceptedQty: round2(p.items.reduce((a, i) => a + i.acceptedQty, 0)),
        invoicedQty: round2(p.items.reduce((a, i) => a + i.invoicedQty, 0)),
        issuedAt: p.issuedAt ? p.issuedAt.toISOString().slice(0, 10) : "",
        deliveryDate: p.deliveryDate ? p.deliveryDate.toISOString().slice(0, 10) : "",
        closedAt: p.closedAt ? p.closedAt.toISOString().slice(0, 10) : "",
      }));
    },
  },
  invoices: {
    label: "Invoices and match status",
    perms: [P.INVOICE_VIEW],
    build: async ({ entityIds, from, to }) => {
      const invoices = await prisma.invoice.findMany({
        where: {
          ...(entityIds ? { po: { entityId: { in: entityIds } } } : {}),
          ...(from || to ? { invoiceDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        },
        include: {
          vendor: { select: { name: true } },
          po: { select: { number: true, entity: { select: { code: true } } } },
          items: { select: { matchFlag: true } },
          grnLinks: { select: { grnId: true } },
          handoffs: { select: { status: true, paidDate: true, paymentReference: true } },
        },
        orderBy: { invoiceDate: "desc" },
      });
      return invoices.map((i) => {
        const handoff = i.handoffs[i.handoffs.length - 1];
        return {
          number: i.number,
          entity: i.po.entity.code,
          vendorInvoiceNumber: i.vendorInvoiceNumber,
          vendor: i.vendor.name,
          po: i.po.number,
          invoiceDate: i.invoiceDate.toISOString().slice(0, 10),
          dueDate: i.dueDate ? i.dueDate.toISOString().slice(0, 10) : "",
          subtotal: i.subtotal,
          tax: i.taxAmount,
          total: i.total,
          netPayable: i.netPayable,
          status: i.status,
          matchStatus: i.matchStatus,
          mismatchedLines: i.items.filter((x) => x.matchFlag !== "OK").length,
          grnsLinked: i.grnLinks.length,
          handoffStatus: handoff?.status ?? "",
          paymentReference: handoff?.paymentReference ?? "",
          paidDate: handoff?.paidDate ? handoff.paidDate.toISOString().slice(0, 10) : "",
        };
      });
    },
  },
  grn: {
    label: "Goods receipts",
    perms: [P.GRN_VIEW],
    build: async ({ entityIds, from, to }) => {
      const grns = await prisma.grn.findMany({
        where: {
          ...(entityIds ? { store: { entityId: { in: entityIds } } } : {}),
          ...(from || to ? { receivedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        },
        include: {
          vendor: { select: { name: true } },
          po: { select: { number: true } },
          store: { select: { name: true, entity: { select: { code: true } } } },
          items: { select: { acceptedQty: true, rejectedQty: true, receivedQty: true } },
        },
        orderBy: { receivedAt: "desc" },
      });
      return grns.map((g) => ({
        number: g.number,
        entity: g.store.entity.code,
        po: g.po?.number ?? "",
        vendor: g.vendor?.name ?? "",
        store: g.store.name,
        status: g.status,
        receivedQty: round2(g.items.reduce((a, i) => a + i.receivedQty, 0)),
        acceptedQty: round2(g.items.reduce((a, i) => a + i.acceptedQty, 0)),
        rejectedQty: round2(g.items.reduce((a, i) => a + i.rejectedQty, 0)),
        totalValue: g.totalValue,
        receivedAt: g.receivedAt.toISOString().slice(0, 10),
      }));
    },
  },
  inventory: {
    label: "Inventory valuation",
    perms: [P.INVENTORY_VIEW],
    build: async ({ entityIds }) => {
      const rows = await prisma.inventoryItem.findMany({
        where: { ...(entityIds ? { store: { entityId: { in: entityIds } } } : {}) },
        include: {
          item: { select: { sku: true, name: true, unit: true, category: { select: { name: true } } } },
          store: { select: { name: true, entity: { select: { code: true } } } },
        },
        orderBy: [{ store: { name: "asc" } }, { item: { name: "asc" } }],
      });
      return rows.map((r) => ({
        entity: r.store.entity.code,
        store: r.store.name,
        sku: r.item.sku,
        item: r.item.name,
        category: r.item.category.name,
        batch: r.batchNumber ?? "",
        quantity: r.quantity,
        reserved: r.reservedQty,
        available: round2(r.quantity - r.reservedQty),
        unit: r.unit || r.item.unit,
        unitCost: r.unitCost,
        value: round2(r.quantity * r.unitCost),
        expiryDate: r.expiryDate ? r.expiryDate.toISOString().slice(0, 10) : "",
      }));
    },
  },
  exceptions: {
    label: "Exceptions",
    perms: [P.EXCEPTION_VIEW],
    build: async ({ entityIds, from, to }) => {
      const rows = await prisma.exception.findMany({
        where: {
          ...(entityIds ? { entityId: { in: entityIds } } : {}),
          ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        },
        include: { raisedBy: { select: { name: true } }, owner: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      });
      return rows.map((e) => ({
        number: e.number,
        type: e.type,
        severity: e.severity,
        status: e.status,
        blocking: e.blocking ? "YES" : "NO",
        title: e.title,
        documentType: e.documentType,
        documentRef: e.documentRef,
        caseKey: e.caseKey ?? "",
        owner: e.owner?.name ?? "",
        raisedBy: e.raisedBy?.name ?? "System",
        raisedAt: e.createdAt.toISOString().slice(0, 10),
        dueAt: e.dueAt ? e.dueAt.toISOString().slice(0, 10) : "",
        resolvedAt: e.resolvedAt ? e.resolvedAt.toISOString().slice(0, 10) : "",
        resolution: e.resolution ?? "",
      }));
    },
  },
  "petty-cash": {
    label: "Petty cash",
    perms: [P.PETTY_CASH_VIEW],
    build: async ({ entityIds, from, to }) => {
      const rows = await prisma.pettyCashRequest.findMany({
        where: {
          ...(entityIds ? { entityId: { in: entityIds } } : {}),
          ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        },
        include: {
          entity: { select: { code: true } },
          department: { select: { name: true } },
          requester: { select: { name: true } },
          items: { select: { disposition: true, storeEntered: true } },
          quotes: { select: { id: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      return rows.map((r) => ({
        number: r.number,
        entity: r.entity.code,
        department: r.department.name,
        requester: r.requester.name,
        purpose: r.purpose,
        status: r.status,
        estimatedAmount: r.estimatedAmount,
        approvedAmount: r.approvedAmount ?? "",
        actualAmount: r.actualAmount ?? "",
        quotes: r.quotes.length,
        storeRequired: r.storeRequired ? "YES" : "NO",
        storeLinesPending: r.items.filter(
          (i) => ["INVENTORY", "ASSET", "PROJECT_MATERIAL"].includes(i.disposition) && !i.storeEntered,
        ).length,
        purchasedFrom: r.purchasedFromVendor ?? "",
        raisedAt: r.createdAt.toISOString().slice(0, 10),
        closedAt: r.closedAt ? r.closedAt.toISOString().slice(0, 10) : "",
      }));
    },
  },
  audit: {
    label: "Audit trail",
    perms: [P.AUDIT_VIEW],
    build: async ({ entityIds, from, to }) => {
      // AuditLog.entityId is the audited record's id, not an org entity, so the
      // entity filter does not apply here — the date range does.
      const rows = await prisma.auditLog.findMany({
        where: {
          ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 20000,
      });
      return rows.map((a) => ({
        at: a.createdAt.toISOString(),
        actor: a.actorName ?? "System",
        actorRoles: a.actorRoles ?? "",
        action: a.action,
        entityType: a.entityType,
        entityRef: a.entityRef ?? "",
        caseKey: a.caseKey ?? "",
        reason: a.reason ?? "",
        changes: a.changes ?? "",
        ip: a.ip ?? "",
      }));
    },
  },
  assets: {
    label: "Asset register",
    perms: [P.ASSET_VIEW],
    build: async ({ entityIds }) => {
      const rows = await prisma.asset.findMany({
        where: { ...(entityIds ? { entityId: { in: entityIds } } : {}) },
        include: {
          entity: { select: { code: true } },
          category: { select: { name: true } },
          custodian: { select: { name: true } },
          department: { select: { name: true } },
        },
        orderBy: { tag: "asc" },
      });
      return rows.map((a) => ({
        tag: a.tag,
        assetId: a.assetId,
        name: a.name,
        entity: a.entity.code,
        category: a.category?.name ?? "",
        status: a.status,
        custodian: a.custodian?.name ?? "",
        department: a.department?.name ?? "",
        location: a.location ?? a.office ?? "",
        serialNumber: a.serialNumber ?? "",
        cost: a.cost,
        currentValue: a.currentValue ?? "",
        purchaseDate: a.purchaseDate ? a.purchaseDate.toISOString().slice(0, 10) : "",
        warrantyUntil: a.warrantyUntil ? a.warrantyUntil.toISOString().slice(0, 10) : "",
      }));
    },
  },
  disposal: {
    label: "Disposal cases",
    perms: [P.DISPOSAL_VIEW],
    build: async ({ entityIds, from, to }) => {
      const rows = await prisma.disposalCase.findMany({
        where: {
          ...(entityIds ? { entityId: { in: entityIds } } : {}),
          ...(from || to ? { raisedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        },
        include: {
          entity: { select: { code: true } },
          raisedBy: { select: { name: true } },
          items: { select: { bookValue: true, estimatedValue: true, realisedValue: true } },
          bids: { select: { amount: true } },
        },
        orderBy: { raisedAt: "desc" },
      });
      return rows.map((c) => ({
        number: c.number,
        entity: c.entity.code,
        title: c.title,
        category: c.disposalCategory,
        stage: c.stage,
        recommendedAction: c.recommendedAction ?? "",
        finalAction: c.finalAction ?? "",
        items: c.items.length,
        bookValue: round2(c.items.reduce((a, i) => a + (i.bookValue ?? 0), 0)),
        estimatedValue: c.estimatedValue ?? "",
        highestBid: c.bids.length ? Math.max(...c.bids.map((b) => b.amount)) : "",
        realisedValue: c.realisedValue ?? "",
        biddingRequired: c.biddingRequired ? "YES" : "NO",
        raisedBy: c.raisedBy.name,
        raisedAt: c.raisedAt.toISOString().slice(0, 10),
        completedAt: c.completedAt ? c.completedAt.toISOString().slice(0, 10) : "",
      }));
    },
  },
};

export async function GET(request: Request, { params }: { params: Promise<{ report: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { report } = await params;
  const def = REPORTS[report];
  if (!def) {
    return NextResponse.json(
      { error: `Unknown report "${report}".`, available: Object.keys(REPORTS) },
      { status: 404 },
    );
  }
  if (!userHasPermission(user, ...def.perms)) {
    return NextResponse.json({ error: `You do not have permission to export ${def.label}.` }, { status: 403 });
  }

  const url = new URL(request.url);
  const requestedEntity = url.searchParams.get("entity");
  const scoped = visibleEntityIds(user);
  let entityIds = scoped;
  if (requestedEntity && (!scoped || scoped.includes(requestedEntity))) entityIds = [requestedEntity];

  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const from = fromRaw ? new Date(fromRaw) : null;
  const to = toRaw ? new Date(toRaw) : null;

  const rows = await def.build({
    entityIds,
    from: from && !Number.isNaN(from.getTime()) ? from : null,
    to: to && !Number.isNaN(to.getTime()) ? to : null,
  });

  await writeAudit({
    entityType: "Report",
    entityId: report,
    entityRef: def.label,
    action: "REPORT_EXPORTED",
    newValue: { rows: rows.length, entityIds, from: fromRaw, to: toRaw },
    actor: user,
  });

  const csv = rows.length ? toCsv(rows) : "no data\n";
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${report}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
