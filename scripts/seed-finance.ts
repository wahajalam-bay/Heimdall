/**
 * Seeds the finance and receiving-exception layers by driving the real services.
 *
 * Tax rates, budget allocations, units of measure, an item-code rule and a
 * department contact are master data, so they are inserted. Everything
 * transactional — the voucher, its signatures, the variance, the return — goes
 * through the same functions the screens call, so a green run is evidence the
 * rules hold rather than evidence the fixture was written carefully.
 *
 *   npx tsx scripts/seed-finance.ts
 */
import { prisma } from "../src/lib/db";
import { sessionFor } from "./lib/actors";
import { generateVoucher, signVoucher, voucherReadiness } from "../src/server/vouchers";
import { createVendorReturn, authoriseReturn, recordRejection } from "../src/server/receiving-exceptions";
import { upsertBudget } from "../src/server/budget";
import { upsertItemCodeRule, upsertUom, setDepartmentPoc, upsertAssetInsurance } from "../src/server/masters";
import { round2 } from "../src/lib/format";

const ADMIN = process.env.SEED_ACTOR ?? "system.admin@zameen.com";

async function main() {
  const admin = await sessionFor(ADMIN);
  const entityId = admin.primaryEntityId!;
  const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { code: true } });
  const year = String(new Date().getFullYear());

  /* ── Tax rates ── */
  const rates = [
    { code: "GST-18", name: "General sales tax at 18%", type: "SALES", rate: 18, withheld: false },
    { code: "GST-17", name: "General sales tax at 17%", type: "SALES", rate: 17, withheld: false },
    { code: "WHT-4.5", name: "Withholding on services at 4.5%", type: "WITHHOLDING", rate: 4.5, withheld: true },
    { code: "WHT-5.5", name: "Withholding on goods at 5.5%", type: "WITHHOLDING", rate: 5.5, withheld: true },
    { code: "FED-16", name: "Federal excise at 16%", type: "FED", rate: 16, withheld: false },
  ];
  for (const r of rates) {
    await prisma.tax.upsert({ where: { code: r.code }, create: r, update: { rate: r.rate, name: r.name } });
  }
  console.log(`${rates.length} tax rate(s) on file.`);

  /* ── Units of measure ── */
  const units = [
    { code: "EA", name: "Each", dimension: "COUNT" },
    { code: "BOX", name: "Box", dimension: "COUNT", baseCode: "EA", factor: 12 },
    { code: "REAM", name: "Ream", dimension: "COUNT", baseCode: "EA", factor: 500 },
    { code: "KG", name: "Kilogram", dimension: "WEIGHT" },
    { code: "TON", name: "Metric tonne", dimension: "WEIGHT", baseCode: "KG", factor: 1000 },
    { code: "LTR", name: "Litre", dimension: "VOLUME" },
    { code: "M", name: "Metre", dimension: "LENGTH" },
    { code: "SQFT", name: "Square foot", dimension: "AREA" },
  ];
  for (const u of units) {
    const existing = await prisma.uom.findUnique({ where: { code: u.code } });
    await upsertUom(admin, { id: existing?.id ?? null, ...u });
  }
  console.log(`${units.length} unit(s) of measure defined.`);

  /* ── Budget allocations ── */
  const departments = await prisma.department.findMany({
    where: { entityId, active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 4,
  });
  // Sized against what each department has actually committed, so the demo shows
  // a mix of comfortable, tight and breached lines rather than all-green.
  let budgets = 0;
  for (const [i, d] of departments.entries()) {
    const committed = await prisma.purchaseOrder.aggregate({
      where: {
        entityId,
        status: { in: ["APPROVED", "ISSUED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED"] },
        pr: { departmentId: d.id },
      },
      _sum: { total: true },
    });
    const spent = round2(committed._sum.total ?? 0);
    // One generous, one tight, one deliberately breached, then generous again.
    const factor = [2.5, 1.05, 0.8, 3][i % 4];
    const allocated = round2(Math.max(250000, spent * factor));
    const existing = await prisma.budget.findFirst({
      where: { entityId, year, departmentId: d.id, costCenterId: null, categoryId: null, expenditureType: "BOTH" },
    });
    await upsertBudget(admin, {
      id: existing?.id ?? null,
      entityId,
      year,
      departmentId: d.id,
      expenditureType: "BOTH",
      allocated,
      hardLimit: false,
      notes: `Seeded allocation for ${d.name}, ${year}.`,
    });
    budgets += 1;
  }
  console.log(`${budgets} budget line(s) allocated for ${year}.`);

  /* ── Item code rule ── */
  const existingRule = await prisma.itemCodeRule.findFirst({ where: { entityId: null, categoryId: null } });
  await upsertItemCodeRule(admin, {
    id: existingRule?.id ?? null,
    pattern: "CATEGORY,SUBCATEGORY,SEQUENCE",
    separator: "-",
    sequenceWidth: 4,
    notes: "Category, sub-category then a four-digit serial, matching the codes already in the catalogue.",
  });
  console.log("Item code rule defined: CATEGORY-SUBCATEGORY-0000.");

  /* ── Department contact ── */
  if (departments[0]) {
    const member = await prisma.user.findFirst({
      where: { active: true, primaryDepartmentId: departments[0].id },
      select: { id: true, name: true },
    });
    if (member) {
      await setDepartmentPoc(admin, {
        departmentId: departments[0].id,
        userId: member.id,
        responsibility: "PROCUREMENT",
        primary: true,
      });
      console.log(`${member.name} set as the procurement contact for ${departments[0].name}.`);
    }
  }

  /* ── Asset insurance ── */
  const asset = await prisma.asset.findFirst({
    where: { entityId, status: { notIn: ["DISPOSED", "SCRAPPED"] }, cost: { gt: 0 } },
    orderBy: { cost: "desc" },
    select: { id: true, tag: true, name: true, cost: true },
  });
  if (asset) {
    const existing = await prisma.assetInsurance.findFirst({ where: { assetId: asset.id } });
    await upsertAssetInsurance(admin, {
      id: existing?.id ?? null,
      assetId: asset.id,
      policyNumber: `POL-${year}-0001`,
      insurer: "Jubilee General Insurance",
      coverType: "COMPREHENSIVE",
      sumInsured: round2(asset.cost),
      premium: round2(asset.cost * 0.012),
      startDate: new Date(Date.now() - 200 * 86400000),
      // Deliberately inside the thirty-day horizon, so the exposure report has
      // something real to show.
      endDate: new Date(Date.now() + 21 * 86400000),
      notes: "Seeded policy, expiring shortly so the renewal warning is visible.",
    });
    console.log(`Insurance recorded against ${asset.tag} (${asset.name}), expiring in 21 days.`);
  }

  /* ── A voucher, driven through its signatures ── */
  const candidate = await prisma.invoice.findFirst({
    where: { status: { in: ["APPROVED", "MATCHED", "SENT_TO_FINANCE"] }, matchStatus: "PASSED", vouchers: { none: {} } },
    include: { po: { select: { entityId: true } }, items: true },
    orderBy: { receivedDate: "desc" },
  });
  if (!candidate) {
    console.log("\nNo approved, matched invoice without a voucher — skipping the voucher walk-through.");
  } else {
    // Tax must be recorded and verified before a voucher may exist, so the
    // demo invoice gets the lines it should have had.
    const gst = await prisma.tax.findUniqueOrThrow({ where: { code: "GST-18" } });
    const wht = await prisma.tax.findUniqueOrThrow({ where: { code: "WHT-5.5" } });
    const existingLines = await prisma.invoiceTaxLine.count({ where: { invoiceId: candidate.id } });
    if (!existingLines) {
      await prisma.invoiceTaxLine.createMany({
        data: [
          {
            invoiceId: candidate.id,
            taxId: gst.id,
            label: gst.code,
            rate: gst.rate,
            base: round2(candidate.subtotal),
            amount: round2(candidate.taxAmount),
            withheld: false,
            status: "VERIFIED",
            verifiedById: admin.id,
            verifiedAt: new Date(),
          },
          {
            invoiceId: candidate.id,
            taxId: wht.id,
            label: wht.code,
            rate: wht.rate,
            base: round2(candidate.subtotal),
            amount: round2(candidate.withholdingTax),
            withheld: true,
            status: "VERIFIED",
            verifiedById: admin.id,
            verifiedAt: new Date(),
          },
        ],
      });
    }

    const readiness = await voucherReadiness(candidate.id);
    if (!readiness.ready) {
      console.log(`\nVoucher not raised for ${candidate.number}: ${readiness.blockers.join(" · ")}`);
    } else {
      const voucher = await generateVoucher(admin, { invoiceId: candidate.id });
      console.log(`\n${voucher.number} raised for ${voucher.netAmount} with ${voucher.signatures.length} signature(s).`);

      // Walk the ladder with somebody who actually holds each rung.
      for (const step of voucher.signatures) {
        const signer = await prisma.user.findFirst({
          where: { active: true, roles: { some: { role: { code: step.roleCode } } } },
          select: { email: true, name: true },
        });
        if (!signer) {
          console.log(`  no user holds ${step.roleCode}; leaving the voucher awaiting signature.`);
          break;
        }
        const session = await sessionFor(signer.email);
        const after = await signVoucher(session, { voucherId: voucher.id, approve: true, comment: "Seeded signature." });
        console.log(`  signed by ${signer.name} (${step.roleCode}) — now ${after.status}`);
        if (after.status !== "PENDING_SIGNATORIES") break;
      }
    }
  }

  /* ── A rejection and the return it causes ── */
  const posted = await prisma.grn.findMany({
    where: { status: "POSTED" },
    include: {
      po: { select: { id: true, vendorId: true } },
      items: { include: { item: { select: { id: true, name: true, unit: true } } } },
      store: { select: { id: true, code: true } },
    },
    orderBy: { receivedAt: "desc" },
    take: 10,
  });

  // Only a line whose stock is still on the shelf can be adjusted out; the
  // service refuses anything else, so the fixture has to find a real one.
  let found: { grn: (typeof posted)[number]; line: (typeof posted)[number]["items"][number] } | null = null;
  for (const g of posted) {
    if (!g.po) continue;
    for (const li of g.items) {
      if (!li.item) continue;
      const rows = await prisma.inventoryItem.findMany({
        where: { itemId: li.item.id, storeId: g.storeId },
        select: { quantity: true, reservedQty: true },
      });
      const free = rows.reduce((a, r) => a + (r.quantity - r.reservedQty), 0);
      if (free >= 2) {
        found = { grn: g, line: li };
        break;
      }
    }
    if (found) break;
  }

  if (!found) {
    console.log("\nNo receipt line still has stock on the shelf — skipping the rejection walk-through.");
  } else {
    const grn = found.grn;
    const line = found.line;
    const rejection = await recordRejection(admin, {
      grnId: grn.id,
      itemId: line.item!.id,
      storeId: grn.storeId,
      description: `${line.item!.name} — two units found damaged after receipt`,
      quantity: Math.min(2, Math.max(1, Math.floor(line.acceptedQty))),
      unit: line.unit,
      reasonCode: "DAMAGED",
      reason: "Casing cracked in transit; found during stacking.",
      disposition: "ADJUSTED_OUT",
    });
    console.log(`\n${rejection.number} recorded and stock adjusted out.`);

    const ret = await createVendorReturn(admin, {
      vendorId: grn.po.vendorId,
      poId: grn.po.id,
      grnId: grn.id,
      reason: "Damaged on arrival; replacement requested under warranty.",
      replacementRequired: true,
      items: [
        {
          itemId: line.item!.id,
          description: line.item!.name,
          quantity: Math.min(2, Math.max(1, Math.floor(line.acceptedQty))),
          unit: line.unit,
          unitValue: line.unitPrice,
          reasonCode: "DAMAGED",
        },
      ],
      rejectionIds: [rejection.id],
    });
    await authoriseReturn(admin, ret.id);
    console.log(`${ret.number} raised and authorised, replacement awaited.`);
  }

  /* ── Position ── */
  const [vouchers, variances, returns, taxLines] = await Promise.all([
    prisma.voucher.count(),
    prisma.poVariance.count(),
    prisma.vendorReturn.count(),
    prisma.invoiceTaxLine.count(),
  ]);
  console.log(
    `\nOn file: ${vouchers} voucher(s), ${variances} variance(s), ${returns} return(s), ${taxLines} tax line(s) in ${entity.code}.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
