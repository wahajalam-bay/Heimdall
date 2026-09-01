/**
 * Return to vendor from a failed inspection — ZAM/PUR/SOP-01 Store Flow step 3.
 *
 *   npx tsx scripts/verify-rtv.ts
 */
import { prisma } from "../src/lib/db";
import { PERMISSIONS as P } from "../src/lib/permissions";
import { withPermissions, withoutPermissions, refused } from "./lib/actors";
import { returnFromInspection } from "../src/server/receiving-exceptions";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const inspector = await withPermissions([P.INSPECTION_PERFORM]);
  const outsider = await withoutPermissions(P.RETURN_CREATE, P.INSPECTION_PERFORM);

  // A real PO with lines, so the prices come from the order rather than a fixture.
  const po = await prisma.purchaseOrder.findFirst({
    where: { items: { some: { unitPrice: { gt: 0 } } } },
    include: { items: { take: 2 }, vendor: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  if (!po?.items.length) throw new Error("no purchase order with priced lines");

  const created: string[] = [];
  const mk = async (result: string, failedQty: number) => {
    const insp = await prisma.inspection.create({
      data: {
        number: `TEST-RTV-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        poId: po.id,
        inspectionType: "GENERAL",
        result,
        findings: result === "REJECTED" ? "Bars bent in transit." : null,
        items: {
          create: po.items.map((pi, idx) => ({
            poItemId: pi.id,
            itemId: pi.itemId,
            lineNo: idx + 1,
            description: pi.description,
            quantityInspected: 10,
            quantityPassed: 10 - failedQty,
            quantityFailed: failedQty,
            verdict: failedQty > 0 ? "FAIL" : "PASS",
          })),
        },
      },
    });
    created.push(insp.id);
    return insp;
  };

  const passed = await mk("APPROVED", 0);
  const notFailed = await refused(returnFromInspection(inspector, { inspectionId: passed.id }));
  check("a passed inspection cannot raise a return", !!notFailed, notFailed ?? "");

  const nothingFailed = await mk("REJECTED", 0);
  const empty = await refused(returnFromInspection(inspector, { inspectionId: nothingFailed.id }));
  check("a failed inspection with no failed quantity is refused", !!empty, empty ?? "");

  const rejected = await mk("REJECTED", 3);
  const noPerm = await refused(returnFromInspection(outsider, { inspectionId: rejected.id }));
  check("lodging a return needs returns or inspection authority", !!noPerm, noPerm ?? "");

  const ret = await returnFromInspection(inspector, { inspectionId: rejected.id });
  check("the inspector can lodge it, as the SOP says", !!ret.id, ret.number);
  check("it starts as a draft, not authorised", ret.status === "DRAFT");
  check("it points at the inspection", ret.inspectionId === rejected.id);
  check("it points at the order and the vendor", ret.poId === po.id && ret.vendorId === po.vendorId);
  check(
    "the reason carries the inspection's findings",
    ret.reason.includes(rejected.number) && ret.reason.includes("bent"),
    ret.reason,
  );

  const lines = await prisma.vendorReturnItem.findMany({
    where: { returnId: ret.id },
    orderBy: { lineNo: "asc" },
  });
  check("one line per failed line, not per inspected line", lines.length === po.items.length);
  check(
    "quantities are the failed quantities from the inspection",
    lines.every((l) => l.quantity === 3),
    lines.map((l) => l.quantity).join(", "),
  );
  check(
    "prices are the order's, not retyped",
    lines.every((l, i) => Math.abs(l.unitValue - po.items[i]!.unitPrice) < 0.01),
    lines.map((l) => l.unitValue).join(", "),
  );
  const expected = po.items.reduce((a, pi) => a + pi.unitPrice * 3, 0);
  check("the total reconciles to the order", Math.abs(ret.totalValue - expected) < 0.05, `${ret.totalValue} vs ${expected.toFixed(2)}`);
  check("a replacement is expected by default", ret.replacementRequired && ret.replacementStatus === "AWAITED");

  const twice = await refused(returnFromInspection(inspector, { inspectionId: rejected.id }));
  check("a second return against the same inspection is refused", !!twice, twice ?? "");

  const audited = await prisma.auditLog.findFirst({
    where: { entityType: "VendorReturn", entityId: ret.id, action: "RETURN_CREATED" },
  });
  check("the return is audited", !!audited);

  // Cleanup.
  await prisma.auditLog.deleteMany({ where: { entityType: "VendorReturn", entityId: ret.id } });
  await prisma.vendorReturnItem.deleteMany({ where: { returnId: ret.id } });
  await prisma.vendorReturn.delete({ where: { id: ret.id } });
  await prisma.inspectionItem.deleteMany({ where: { inspectionId: { in: created } } });
  await prisma.inspection.deleteMany({ where: { id: { in: created } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
