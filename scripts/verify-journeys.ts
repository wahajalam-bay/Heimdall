/**
 * Functional journey verification.
 *
 * Drives the running application over HTTP as real users: exports every report,
 * exercises the bulk endpoints, and — the part that matters — checks that a
 * low-privilege session is refused where it should be. Read-mostly: the only
 * writes are a match re-run and an approval reminder, both of which are
 * idempotent.
 *
 *   npx tsx scripts/verify-journeys.ts [baseUrl]
 */
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { REPORT_CATALOGUE } from "../src/lib/reports";

const BASE = process.argv[2] ?? "http://localhost:3737";
const prisma = new PrismaClient();

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
}

async function mintSession(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const token = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: {
      token: createHash("sha256").update(token).digest("hex"),
      userId: user.id,
      ip: "127.0.0.1",
      userAgent: "journey-verification",
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return { cookie: `procurementos_session=${token}`, user };
}

async function get(path: string, cookie: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  const text = await res.text();
  return { status: res.status, text, contentType: res.headers.get("content-type") ?? "" };
}

async function post(path: string, cookie: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

async function main() {
  const admin = await mintSession("system.admin@zameen.com");

  /* ── Reports export ────────────────────────────────────── */
  for (const report of REPORT_CATALOGUE) {
    const res = await get(`/api/export/${report.key}`, admin.cookie);
    const isCsv = res.contentType.includes("text/csv");
    const lines = res.text.trim().split("\n").length;
    record(
      `export ${report.key}`,
      res.status === 200 && isCsv,
      res.status === 200 ? `${lines} line(s) of CSV` : `HTTP ${res.status}`,
    );
  }

  const unknown = await get("/api/export/not-a-report", admin.cookie);
  record("unknown report refused", unknown.status === 404, `HTTP ${unknown.status}`);

  /* ── Search and context ────────────────────────────────── */
  const search = await get("/api/search?q=steel", admin.cookie);
  record("global search responds", search.status === 200, `HTTP ${search.status}`);

  /* ── Bulk: invoice re-match ────────────────────────────── */
  const failing = await prisma.invoice.findFirst({ where: { matchStatus: "FAILED" }, select: { id: true, number: true } });
  if (failing) {
    const res = await post("/api/bulk/invoice", admin.cookie, { ids: [failing.id] });
    record(
      "bulk invoice re-match",
      res.status === 200 && res.json.ok === true,
      String(res.json.message ?? res.json.error ?? `HTTP ${res.status}`),
    );

    // The match must still fail — re-running is not a way to clear a real mismatch.
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: failing.id }, select: { matchStatus: true } });
    record(
      "re-match does not clear a genuine failure",
      after.matchStatus === "FAILED",
      `${failing.number} is ${after.matchStatus}`,
    );
  }

  /* ── Bulk: purchase order short-close guard ────────────── */
  const openPo = await prisma.purchaseOrder.findFirst({
    where: { status: { in: ["ISSUED", "ACKNOWLEDGED", "PARTIALLY_RECEIVED"] } },
    select: { id: true, number: true },
  });
  if (openPo) {
    const noReason = await post("/api/bulk/po", admin.cookie, { ids: [openPo.id] });
    record(
      "short-close refused without a reason",
      noReason.status === 400,
      String(noReason.json.error ?? `HTTP ${noReason.status}`),
    );
  }

  /* ── Bulk: approval reminder ───────────────────────────── */
  const pendingPr = await prisma.purchaseRequisition.findFirst({
    where: { status: { in: ["SUBMITTED", "UNDER_DEPARTMENT_APPROVAL", "PROCUREMENT_REVIEW"] } },
    select: { id: true, number: true },
  });
  if (pendingPr) {
    const res = await post("/api/bulk/pr", admin.cookie, {
      ids: [pendingPr.id],
      reason: "Verification run — please action when convenient.",
    });
    record(
      "bulk approval reminder",
      res.status === 200,
      String(res.json.message ?? res.json.error ?? `HTTP ${res.status}`),
    );
  }

  /* ── Authorisation over HTTP ───────────────────────────── */
  // A requester holds none of the administrative permissions.
  const requester = await prisma.user.findFirst({
    where: {
      active: true,
      roles: {
        every: {
          role: {
            permissions: { none: { permission: { code: { in: ["admin.users", "admin.roles", "po.close"] } } } },
          },
        },
      },
    },
    select: { email: true, name: true },
  });

  if (requester) {
    const limited = await mintSession(requester.email);

    const adminPage = await get("/admin/users", limited.cookie);
    const refusedInUi =
      adminPage.status === 200 &&
      /do not have permission|not authorised|access denied/i.test(adminPage.text);
    record(
      "administration screen refuses a requester",
      refusedInUi,
      refusedInUi ? `${requester.name} sees an access-denied state` : `HTTP ${adminPage.status}`,
    );

    if (openPo) {
      const bulk = await post("/api/bulk/po", limited.cookie, {
        ids: [openPo.id],
        reason: "Attempting a short close without authority.",
      });
      record(
        "short-close endpoint refuses a requester",
        bulk.status === 403,
        `HTTP ${bulk.status} ${String(bulk.json.error ?? "")}`.trim(),
      );
    }

  }

  // The audit export needs its own subject: several operational roles hold
  // audit.view legitimately, so the check must use somebody who does not.
  const noAudit = await prisma.user.findFirst({
    where: {
      active: true,
      roles: {
        every: { role: { permissions: { none: { permission: { code: "audit.view" } } } } },
      },
    },
    select: { email: true, name: true },
  });
  if (noAudit) {
    const session = await mintSession(noAudit.email);
    const auditExport = await get("/api/export/audit", session.cookie);
    record(
      "audit export refuses a user without audit access",
      auditExport.status === 403,
      `${noAudit.name}: HTTP ${auditExport.status}`,
    );

    const auditPage = await get("/analytics/audit", session.cookie);
    const refused = auditPage.status === 200 && /do not have permission|access denied/i.test(auditPage.text);
    record(
      "audit screen refuses a user without audit access",
      refused,
      refused ? `${noAudit.name} sees an access-denied state` : `HTTP ${auditPage.status}`,
    );
  }

  /* ── Anonymous access ──────────────────────────────────── */
  const anonymous = await fetch(`${BASE}/pr`, { redirect: "manual" });
  record(
    "anonymous request is redirected to sign-in",
    anonymous.status === 307 || anonymous.status === 302,
    `HTTP ${anonymous.status} → ${anonymous.headers.get("location") ?? "?"}`,
  );

  const anonymousApi = await fetch(`${BASE}/api/export/spend`, { redirect: "manual" });
  record(
    "anonymous export refused",
    anonymousApi.status === 401 || anonymousApi.status === 307,
    `HTTP ${anonymousApi.status}`,
  );

  /* ── Report ────────────────────────────────────────────── */
  const width = Math.max(...checks.map((c) => c.name.length));
  console.log("\nFunctional journey verification\n");
  for (const c of checks) {
    console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(width)}  ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed\n`);

  await prisma.session.deleteMany({ where: { userAgent: "journey-verification" } });
  await prisma.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
