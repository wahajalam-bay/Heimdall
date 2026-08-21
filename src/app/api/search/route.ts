import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser, visibleEntityIds, userHasPermission } from "@/lib/auth";
import { PERMISSIONS as P } from "@/lib/permissions";
import { humanize } from "@/lib/domain";

/**
 * Global search across every business object, filtered by the caller's
 * permissions and entity access. Matching is on reference numbers and natural
 * terms (titles, vendor names, item descriptions).
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ hits: [] });

  const scoped = visibleEntityIds(user);
  const entityWhere = scoped ? { entityId: { in: scoped } } : {};
  const can = (...codes: string[]) => userHasPermission(user, ...codes);
  const take = 6;

  type Hit = {
    id: string;
    type: string;
    ref: string;
    title: string;
    sub?: string | null;
    href: string;
    status?: string | null;
  };
  const hits: Hit[] = [];

  const tasks: Array<Promise<void>> = [];

  if (can(P.PR_VIEW, P.PR_VIEW_ALL)) {
    tasks.push(
      prisma.purchaseRequisition
        .findMany({
          where: {
            ...entityWhere,
            OR: [
              { number: { contains: q, mode: "insensitive" } },
              { title: { contains: q, mode: "insensitive" } },
              { items: { some: { description: { contains: q, mode: "insensitive" } } } },
            ],
            ...(can(P.PR_VIEW_ALL) ? {} : { requesterId: user.id }),
          },
          take,
          orderBy: { createdAt: "desc" },
          select: { id: true, number: true, title: true, status: true, entity: { select: { code: true } } },
        })
        .then((rows) => {
          for (const r of rows)
            hits.push({
              id: r.id,
              type: "PR",
              ref: r.number,
              title: r.title,
              sub: r.entity.code,
              href: `/pr/${r.id}`,
              status: humanize(r.status),
            });
        }),
    );
  }

  if (can(P.PO_VIEW)) {
    tasks.push(
      prisma.purchaseOrder
        .findMany({
          where: {
            ...entityWhere,
            OR: [
              { number: { contains: q, mode: "insensitive" } },
              { vendor: { name: { contains: q, mode: "insensitive" } } },
              { items: { some: { description: { contains: q, mode: "insensitive" } } } },
            ],
          },
          take,
          orderBy: { createdAt: "desc" },
          select: { id: true, number: true, status: true, total: true, vendor: { select: { name: true } } },
        })
        .then((rows) => {
          for (const r of rows)
            hits.push({
              id: r.id,
              type: "PO",
              ref: r.number,
              title: r.vendor.name,
              sub: `PKR ${r.total.toLocaleString("en-PK")}`,
              href: `/po/${r.id}`,
              status: humanize(r.status),
            });
        }),
    );
  }

  if (can(P.RFQ_VIEW)) {
    tasks.push(
      prisma.rfq
        .findMany({
          where: { OR: [{ number: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] },
          take,
          orderBy: { createdAt: "desc" },
          select: { id: true, number: true, title: true, status: true },
        })
        .then((rows) => {
          for (const r of rows)
            hits.push({
              id: r.id,
              type: "RFQ",
              ref: r.number,
              title: r.title,
              href: `/rfq/${r.id}`,
              status: humanize(r.status),
            });
        }),
    );
  }

  if (can(P.GRN_VIEW)) {
    tasks.push(
      prisma.grn
        .findMany({
          where: { OR: [{ number: { contains: q, mode: "insensitive" } }, { vendor: { name: { contains: q, mode: "insensitive" } } }] },
          take,
          orderBy: { createdAt: "desc" },
          select: { id: true, number: true, status: true, vendor: { select: { name: true } }, store: { select: { name: true } } },
        })
        .then((rows) => {
          for (const r of rows)
            hits.push({
              id: r.id,
              type: "GRN",
              ref: r.number,
              title: r.vendor.name,
              sub: r.store.name,
              href: `/grn/${r.id}`,
              status: humanize(r.status),
            });
        }),
    );
  }

  if (can(P.INVOICE_VIEW)) {
    tasks.push(
      prisma.invoice
        .findMany({
          where: {
            OR: [
              { number: { contains: q, mode: "insensitive" } },
              { vendorInvoiceNumber: { contains: q, mode: "insensitive" } },
              { vendor: { name: { contains: q, mode: "insensitive" } } },
            ],
          },
          take,
          orderBy: { createdAt: "desc" },
          select: { id: true, number: true, vendorInvoiceNumber: true, status: true, vendor: { select: { name: true } } },
        })
        .then((rows) => {
          for (const r of rows)
            hits.push({
              id: r.id,
              type: "Invoice",
              ref: r.number,
              title: r.vendor.name,
              sub: `Vendor ref ${r.vendorInvoiceNumber}`,
              href: `/invoices/${r.id}`,
              status: humanize(r.status),
            });
        }),
    );
  }

  if (can(P.VENDOR_VIEW)) {
    tasks.push(
      prisma.vendor
        .findMany({
          where: {
            OR: [
              { code: { contains: q, mode: "insensitive" } },
              { name: { contains: q, mode: "insensitive" } },
              { ntn: { contains: q, mode: "insensitive" } },
              { productsServices: { contains: q, mode: "insensitive" } },
            ],
          },
          take,
          orderBy: { name: "asc" },
          select: { id: true, code: true, name: true, city: true, status: true },
        })
        .then((rows) => {
          for (const r of rows)
            hits.push({
              id: r.id,
              type: "Vendor",
              ref: r.code,
              title: r.name,
              sub: r.city,
              href: `/vendors/${r.id}`,
              status: humanize(r.status),
            });
        }),
    );
  }

  if (can(P.ASSET_VIEW)) {
    tasks.push(
      prisma.asset
        .findMany({
          where: {
            ...entityWhere,
            OR: [
              { assetId: { contains: q, mode: "insensitive" } },
              { tag: { contains: q, mode: "insensitive" } },
              { name: { contains: q, mode: "insensitive" } },
              { serialNumber: { contains: q, mode: "insensitive" } },
            ],
          },
          take,
          orderBy: { createdAt: "desc" },
          select: { id: true, assetId: true, tag: true, name: true, status: true, location: true },
        })
        .then((rows) => {
          for (const r of rows)
            hits.push({
              id: r.id,
              type: "Asset",
              ref: r.tag,
              title: r.name,
              sub: r.location,
              href: `/assets/${r.id}`,
              status: humanize(r.status),
            });
        }),
    );
  }

  if (can(P.CPC_VIEW)) {
    tasks.push(
      prisma.cpcCase
        .findMany({
          where: { OR: [{ number: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] },
          take,
          orderBy: { createdAt: "desc" },
          select: { id: true, number: true, title: true, status: true, amount: true },
        })
        .then((rows) => {
          for (const r of rows)
            hits.push({
              id: r.id,
              type: "CPC",
              ref: r.number,
              title: r.title,
              sub: `PKR ${r.amount.toLocaleString("en-PK")}`,
              href: `/cpc/cases/${r.id}`,
              status: humanize(r.status),
            });
        }),
    );
  }

  if (can(P.DISPOSAL_VIEW)) {
    tasks.push(
      prisma.disposalCase
        .findMany({
          where: { ...entityWhere, OR: [{ number: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] },
          take,
          orderBy: { raisedAt: "desc" },
          select: { id: true, number: true, title: true, stage: true },
        })
        .then((rows) => {
          for (const r of rows)
            hits.push({
              id: r.id,
              type: "Disposal",
              ref: r.number,
              title: r.title,
              href: `/disposal/${r.id}`,
              status: humanize(r.stage),
            });
        }),
    );
  }

  if (can(P.INVENTORY_VIEW)) {
    tasks.push(
      prisma.item
        .findMany({
          where: { OR: [{ sku: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] },
          take,
          orderBy: { name: "asc" },
          select: { id: true, sku: true, name: true, category: { select: { name: true } } },
        })
        .then((rows) => {
          for (const r of rows)
            hits.push({
              id: r.id,
              type: "Item",
              ref: r.sku,
              title: r.name,
              sub: r.category.name,
              href: `/inventory?item=${r.id}`,
            });
        }),
    );
    tasks.push(
      prisma.store
        .findMany({
          where: { ...entityWhere, OR: [{ code: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] },
          take: 4,
          select: { id: true, code: true, name: true, kind: true, city: true },
        })
        .then((rows) => {
          for (const r of rows)
            hits.push({
              id: r.id,
              type: "Store",
              ref: r.code,
              title: r.name,
              sub: r.city,
              href: `/stores/${r.id}`,
              status: humanize(r.kind),
            });
        }),
    );
  }

  if (can(P.PETTY_CASH_VIEW)) {
    tasks.push(
      prisma.pettyCashRequest
        .findMany({
          where: {
            ...entityWhere,
            OR: [{ number: { contains: q, mode: "insensitive" } }, { purpose: { contains: q, mode: "insensitive" } }],
            ...(can(P.PETTY_CASH_EVALUATE, P.PETTY_CASH_APPROVE, P.PETTY_CASH_RECONCILE)
              ? {}
              : { requesterId: user.id }),
          },
          take: 4,
          orderBy: { createdAt: "desc" },
          select: { id: true, number: true, purpose: true, status: true },
        })
        .then((rows) => {
          for (const r of rows)
            hits.push({
              id: r.id,
              type: "Petty Cash",
              ref: r.number,
              title: r.purpose,
              href: `/petty-cash/${r.id}`,
              status: humanize(r.status),
            });
        }),
    );
  }

  if (can(P.MASTER_DATA_MANAGE, P.PR_VIEW_ALL, P.ANALYTICS_VIEW)) {
    tasks.push(
      prisma.project
        .findMany({
          where: { ...entityWhere, OR: [{ code: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] },
          take: 4,
          select: { id: true, code: true, name: true, city: true, status: true },
        })
        .then((rows) => {
          for (const r of rows)
            hits.push({
              id: r.id,
              type: "Project",
              ref: r.code,
              title: r.name,
              sub: r.city,
              href: `/admin/projects?project=${r.id}`,
              status: r.status,
            });
        }),
    );
    tasks.push(
      prisma.site
        .findMany({
          where: { ...entityWhere, OR: [{ code: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] },
          take: 4,
          select: { id: true, code: true, name: true, city: true },
        })
        .then((rows) => {
          for (const r of rows)
            hits.push({
              id: r.id,
              type: "Site",
              ref: r.code,
              title: r.name,
              sub: r.city,
              href: `/admin/projects?site=${r.id}`,
            });
        }),
    );
  }

  await Promise.all(tasks);

  // Exact reference matches float to the top.
  const term = q.toLowerCase();
  hits.sort((a, b) => {
    const ax = a.ref.toLowerCase().includes(term) ? 0 : 1;
    const bx = b.ref.toLowerCase().includes(term) ? 0 : 1;
    return ax - bx;
  });

  return NextResponse.json({ hits: hits.slice(0, 24) });
}
