/**
 * HTTP smoke test.
 *
 * Mints a real session directly in the database (same digest scheme as the auth
 * layer), then requests every route as that user and asserts each one renders
 * without a server error. Detail routes use ids discovered from live data.
 *
 *   npx tsx scripts/smoke.ts [baseUrl] [email]
 */
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const BASE = process.argv[2] ?? "http://localhost:3737";
const EMAIL = process.argv[3] ?? "system.admin@zameen.com";
const prisma = new PrismaClient();

// Next streams its own not-found boundary into every healthy page's flight
// payload, so only markers unique to a real failure are useful here.
const ERROR_MARKERS = [
  'id="__next_error__"',
  "Application error: a server-side exception",
  "Unhandled Runtime Error",
];

const STATIC_ROUTES = [
  "/", "/workspace", "/alerts", "/alerts?view=systemic", "/alerts?view=unread", "/settings",
  "/requirements", "/requirements/new",
  "/finance/vouchers", "/finance/budgets", "/finance/taxes",
  "/receiving/variances", "/receiving/returns",
  "/pr", "/pr/new",
  "/rfq", "/quotes", "/comparatives", "/po", "/petty-cash", "/petty-cash/new",
  "/receiving", "/receiving/new", "/gate-passes", "/gate-passes/new", "/inspections",
  "/grn", "/open-pos",
  "/stores", "/inventory", "/issuance", "/issuance/new", "/transfers", "/transfers/new",
  "/vendors", "/vendors/new", "/vendors/prequalification", "/vendors/evaluations",
  "/vendors/performance", "/vendors/issues", "/vendors/blacklist",
  "/cpc", "/cpc/cases", "/cpc/meetings", "/cpc/decisions",
  "/invoices", "/invoices/new", "/finance/handoffs", "/finance/pending",
  "/assets", "/disposal", "/disposal/new", "/disposal/scrap",
  "/analytics", "/analytics/savings", "/analytics/spend", "/analytics/vendors",
  "/analytics/performance", "/analytics/bottlenecks", "/analytics/exceptions",
  "/analytics/audit", "/analytics/reports",
  "/admin/users", "/admin/roles", "/admin/entities", "/admin/departments",
  "/admin/projects", "/admin/stores", "/admin/catalogue", "/admin/approval-rules",
  "/admin/policies", "/admin/evaluation-criteria", "/admin/document-types",
  "/admin/email",
];

const CASE_TABS = [
  "overview", "items", "approvals", "rfq", "quotes", "comparison", "negotiation", "cpc",
  "po", "delivery", "inspection", "grn", "invoice", "finance", "documents", "exceptions",
  "timeline", "audit",
];

async function mintSession(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const token = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: {
      token: createHash("sha256").update(token).digest("hex"),
      userId: user.id,
      ip: "127.0.0.1",
      userAgent: "smoke-test",
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return { token, user };
}

async function discoverRoutes(): Promise<string[]> {
  const routes: string[] = [];
  const add = (base: string, id?: string | null, tabs: string[] = []) => {
    if (!id) return;
    routes.push(`${base}/${id}`);
    for (const t of tabs) routes.push(`${base}/${id}?tab=${t}`);
  };

  const closedPr = await prisma.purchaseRequisition.findFirst({ where: { status: "CLOSED" } });
  const mismatchPr = await prisma.purchaseRequisition.findFirst({ where: { status: "INVOICE_VERIFICATION" } });
  const draftOrReturned = await prisma.purchaseRequisition.findFirst({
    where: { status: { in: ["DRAFT", "RETURNED"] } },
  });
  const sourcingPr = await prisma.purchaseRequisition.findFirst({ where: { status: "SOURCING" } });
  const awardedPr = await prisma.purchaseRequisition.findFirst({
    where: {
      comparatives: { some: { status: { in: ["RECOMMENDED", "APPROVED"] } } },
      status: { in: ["SOURCING", "CPC_REVIEW", "PO_PREPARATION"] },
    },
  });

  add("/pr", closedPr?.id, CASE_TABS);
  add("/pr", mismatchPr?.id, ["overview", "invoice", "grn", "delivery", "exceptions"]);
  if (draftOrReturned) routes.push(`/pr/${draftOrReturned.id}/edit`);
  if (sourcingPr) routes.push(`/rfq/new?prId=${sourcingPr.id}`);
  if (awardedPr) routes.push(`/po/new?prId=${awardedPr.id}`);

  // One requirement of each outcome, so the detail screen is exercised in the
  // states that render differently: awaiting a decision, and already routed.
  add("/finance/vouchers", (await prisma.voucher.findFirst({ orderBy: { preparedAt: "desc" } }))?.id);
  add("/receiving/variances", (await prisma.poVariance.findFirst({ where: { status: "OPEN" } }))?.id);
  add("/receiving/returns", (await prisma.vendorReturn.findFirst({ orderBy: { createdAt: "desc" } }))?.id);
  add("/requirements", (await prisma.requirement.findFirst({ where: { status: "SPLIT" } }))?.id);
  add("/requirements", (await prisma.requirement.findFirst({ where: { status: "FULFILLED_FROM_STOCK" } }))?.id);
  add("/requirements", (await prisma.requirement.findFirst({ where: { decidedAt: null } }))?.id);
  add("/rfq", (await prisma.rfq.findFirst({ orderBy: { createdAt: "desc" } }))?.id);
  add("/comparatives", (await prisma.comparative.findFirst({ orderBy: { preparedAt: "desc" } }))?.id);
  add("/po", (await prisma.purchaseOrder.findFirst({ where: { status: "PARTIALLY_RECEIVED" } }))?.id, [
    "overview", "items", "receiving", "inspections", "grn", "invoices", "documents", "timeline", "audit",
  ]);
  add("/po", (await prisma.purchaseOrder.findFirst({ where: { status: "CLOSED" } }))?.id);
  add("/petty-cash", (await prisma.pettyCashRequest.findFirst({ where: { status: "STORE_ENTRY_PENDING" } }))?.id);
  add("/petty-cash", (await prisma.pettyCashRequest.findFirst({ where: { status: "CLOSED" } }))?.id);
  add("/receiving", (await prisma.delivery.findFirst({ orderBy: { createdAt: "desc" } }))?.id);
  add("/gate-passes", (await prisma.gatePass.findFirst({ orderBy: { createdAt: "desc" } }))?.id);
  add("/inspections", (await prisma.inspection.findFirst({ orderBy: { createdAt: "desc" } }))?.id);
  add("/grn", (await prisma.grn.findFirst({ where: { status: "POSTED" } }))?.id);
  add("/stores", (await prisma.store.findFirst({ where: { kind: "CENTRAL_WAREHOUSE" } }))?.id);
  add("/stores", (await prisma.store.findFirst({ where: { kind: "SITE_STORE" } }))?.id);
  add("/issuance", (await prisma.storeIssue.findFirst({ orderBy: { requestedAt: "desc" } }))?.id);
  add("/transfers", (await prisma.storeTransfer.findFirst({ orderBy: { requestedAt: "desc" } }))?.id);
  add("/vendors", (await prisma.vendor.findFirst({ where: { status: "APPROVED", totalOrders: { gt: 0 } } }))?.id, [
    "overview", "history", "performance", "evaluations", "documents", "issues",
  ]);
  add("/vendors", (await prisma.vendor.findFirst({ where: { status: "BLACKLISTED" } }))?.id);
  add("/vendors/issues", (await prisma.vendorIssue.findFirst({ orderBy: { raisedAt: "desc" } }))?.id);
  add("/vendors/blacklist", (await prisma.vendorBlacklistCase.findFirst({ orderBy: { raisedAt: "desc" } }))?.id);
  add("/cpc/cases", (await prisma.cpcCase.findFirst({ where: { status: "APPROVED" } }))?.id);
  add(
    "/cpc/cases",
    (await prisma.cpcCase.findFirst({ where: { status: { in: ["PENDING", "SCHEDULED", "UNDER_REVIEW"] } } }))?.id,
  );
  add("/cpc/meetings", (await prisma.cpcMeeting.findFirst({ orderBy: { scheduledAt: "desc" } }))?.id);
  add("/invoices", (await prisma.invoice.findFirst({ where: { matchStatus: "FAILED" } }))?.id);
  add("/invoices", (await prisma.invoice.findFirst({ where: { status: "PAID" } }))?.id);
  add("/finance/handoffs", (await prisma.paymentHandoff.findFirst({ orderBy: { handedOffAt: "desc" } }))?.id);
  add("/assets", (await prisma.asset.findFirst({ where: { status: "ISSUED" } }))?.id);
  add("/disposal", (await prisma.disposalCase.findFirst({ where: { stage: "COMPLETED" } }))?.id);
  add("/disposal", (await prisma.disposalCase.findFirst({ where: { stage: "BIDDING" } }))?.id);
  add("/analytics/exceptions", (await prisma.exception.findFirst({ where: { blocking: true } }))?.id);

  const readyDelivery = await prisma.delivery.findFirst({
    where: { grns: { none: {} }, status: { not: "REJECTED" } },
  });
  if (readyDelivery) routes.push(`/grn/new?deliveryId=${readyDelivery.id}`);
  const openPo = await prisma.purchaseOrder.findFirst({
    where: { status: { in: ["ISSUED", "PARTIALLY_RECEIVED"] } },
  });
  if (openPo) {
    routes.push(`/gate-passes/new?poId=${openPo.id}`);
    routes.push(`/receiving/new?poId=${openPo.id}`);
    routes.push(`/invoices/new?poId=${openPo.id}`);
  }

  return routes;
}

async function main() {
  const { token, user } = await mintSession(EMAIL);
  const cookie = `procurementos_session=${token}`;
  const routes = [...STATIC_ROUTES, ...(await discoverRoutes())];

  const failures: string[] = [];
  let ok = 0;

  for (const path of routes) {
    try {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        failures.push(`${path} -> ${res.status} redirect to ${res.headers.get("location") ?? "?"}`);
        continue;
      }
      const html = await res.text();
      if (res.status !== 200) {
        failures.push(`${path} -> ${res.status} :: ${html.replace(/\s+/g, " ").slice(0, 320)}`);
        continue;
      }
      const marker = ERROR_MARKERS.find((m) => html.includes(m));
      if (marker) {
        const at = html.indexOf(marker);
        failures.push(`${path} -> 200 with "${marker}" :: ${html.slice(at, at + 420).replace(/\s+/g, " ")}`);
        continue;
      }
      ok += 1;
    } catch (e) {
      failures.push(`${path} -> ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await prisma.session.deleteMany({
    where: { token: createHash("sha256").update(token).digest("hex") },
  });
  await prisma.$disconnect();

  process.stdout.write(`\nSmoke test as ${user.name} <${EMAIL}>: ${ok}/${routes.length} routes clean\n\n`);
  if (failures.length) {
    for (const f of failures) process.stdout.write(`  FAIL ${f}\n\n`);
    process.exit(1);
  }
  process.stdout.write("  All routes rendered without error.\n\n");
}

main().catch(async (e) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  await prisma.$disconnect();
  process.exit(1);
});
