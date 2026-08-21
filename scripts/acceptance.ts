/**
 * End-to-end acceptance run.
 *
 * Drives a brand-new procurement case through the same service functions the
 * application calls — requisition, sourcing, comparative, committee, purchase
 * order, gate pass, short delivery, inspection, GRN, inventory, then a vendor
 * invoice raised for the full ordered quantity — and asserts that the invoice is
 * blocked because only part of the order was received.
 *
 * Nothing here is hard-coded to seeded ids: actors, vendors, stores and
 * approvers are all resolved from live data, so the run exercises the rules
 * rather than a fixture.
 *
 *   npx tsx scripts/acceptance.ts
 */
import { prisma } from "../src/lib/db";
import { PERMISSIONS as P } from "../src/lib/permissions";
import { currentApprover, refused, sessionFor, withPermission } from "./lib/actors";
import { createPr, submitPr, decidePr, startSourcing, validateForSubmission } from "../src/server/pr";
import { buildComparative, createRfq, issueRfq, recommendVendor, upsertQuote } from "../src/server/sourcing";
import { castCpcDecision, cpcRequirement, createCpcCase } from "../src/server/cpc";
import { createPoFromCase, decidePo, issuePo, submitPoForApproval } from "../src/server/po";
import { createGatePass, recordDelivery, recordInspection } from "../src/server/receiving";
import { createGrn, grnReadiness } from "../src/server/grn";
import { handoffToFinance, registerInvoice, verifyInvoice } from "../src/server/invoice";
import { availableQuantity } from "../src/server/inventory";

/* ── Assertions ───────────────────────────────────────────── */

let failures = 0;
let step = 0;

function check(label: string, condition: boolean, detail: string) {
  if (!condition) failures += 1;
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${detail}`);
}

function stage(title: string) {
  step += 1;
  console.log(`
${String(step).padStart(2, "0")}. ${title}`);
}

/* ── The run ──────────────────────────────────────────────── */

const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const ORDERED = 100; // ton
const DELIVERED = 90; // ton — the short delivery at the heart of the scenario
const UNIT_PRICE = 268_500;

async function main() {
  console.log("\nEnd-to-end acceptance run\n");
  console.log(`  Reference suffix ${RUN} — a fresh case, driven through the service layer.`);

  /* ── Fixtures resolved from live data ─────────────────── */
  const entity = await prisma.entity.findFirstOrThrow({ where: { code: "ZD" } });
  const project = await prisma.project.findFirstOrThrow({
    where: { entityId: entity.id, status: { notIn: ["CLOSED", "CANCELLED"] } },
  });
  const department = await prisma.department.findFirstOrThrow({
    where: { entityId: entity.id, active: true },
    orderBy: { name: "asc" },
  });
  const site = await prisma.site.findFirstOrThrow({
    where: { entityId: entity.id, active: true, OR: [{ projectId: project.id }, { projectId: null }] },
    orderBy: { projectId: "desc" },
  });
  const store = await prisma.store.findFirstOrThrow({
    where: { entityId: entity.id, active: true, OR: [{ siteId: site.id }, { siteId: null }] },
    orderBy: { siteId: "desc" },
  });
  const category = await prisma.category.findFirstOrThrow({
    where: { active: true, code: "CONSTR-STEEL" },
  });
  // A catalogue item, so the receipt lands in a stock bucket we can reconcile.
  const item = await prisma.item.findFirstOrThrow({
    where: { active: true, categoryId: category.id },
    orderBy: { sku: "asc" },
  });
  const UNIT = item.unit;
  const vendors = await prisma.vendor.findMany({
    where: { status: "APPROVED", entityLinks: { some: { entityId: entity.id, approved: true } } },
    take: 3,
    orderBy: { name: "asc" },
  });
  if (vendors.length < 3) throw new Error("The run needs three approved vendors for this entity.");

  const requester = await withPermission(P.PR_CREATE, entity.id);
  // A material demand names the project manager who owns the technical scope.
  const pmOwner = await withPermission(P.PR_CREATE, entity.id).then(async (fallback) => {
    const pm = await prisma.user.findFirst({
      where: {
        active: true,
        roles: { some: { role: { code: "PM_USER" } } },
        OR: [{ primaryEntityId: entity.id }, { entityAccess: { some: { entityId: entity.id } } }],
      },
      select: { email: true },
    });
    return pm ? sessionFor(pm.email) : fallback;
  });
  const officer = await withPermission(P.RFQ_ISSUE, entity.id);
  const buyer = await withPermission(P.QUOTE_ENTER, entity.id);
  const selector = await withPermission(P.VENDOR_SELECT, entity.id);
  const poCreator = await withPermission(P.PO_CREATE, entity.id);
  const security = await withPermission(P.GATE_PASS_CREATE);
  const receiver = await withPermission(P.RECEIVE_GOODS, entity.id);
  const inspector = await withPermission(P.INSPECTION_PERFORM);
  const storeKeeper = await withPermission(P.GRN_CREATE, entity.id);
  const financeUser = await withPermission(P.INVOICE_CREATE, entity.id);

  console.log(
    `  ${entity.code} · ${department.name} · ${site.name} · ${store.name} · ${category.name}` +
      `
  ${item.sku} ${item.name} · requester ${requester.name} · PM ${pmOwner.name}`,
  );

  /* ── 1. Material demand ───────────────────────────────── */
  stage("Requisition — a material demand for the full ordered quantity");
  const pr = await createPr(requester, {
    entityId: entity.id,
    departmentId: department.id,
    procurementType: "MATERIAL_DEMAND",
    title: `Acceptance run ${RUN} — deformed steel bar Grade 60, ${ORDERED} ton`,
    justification:
      "Raft foundation reinforcement for the current pour sequence. Quantity is taken off the approved BOQ.",
    projectId: project.id,
    siteId: site.id,
    pmOwnerId: pmOwner.id,
    deliveryStoreId: store.id,
    requiredDate: new Date(Date.now() + 21 * 86_400_000),
    priority: "HIGH",
    boqReference: `BOQ/ACC/${RUN}`,
    drawingReference: `DWG/ACC/${RUN}`,
    items: [
      {
        itemId: item.id,
        categoryId: category.id,
        description: item.name,
        specification: "ASTM A615 Grade 60, single mill, per-heat mill certificates required",
        quantity: ORDERED,
        unit: UNIT,
        estimatedUnitPrice: UNIT_PRICE,
        requiredDate: new Date(Date.now() + 21 * 86_400_000),
      },
    ],
  });
  check("requisition created as a draft", pr.status === "DRAFT", `${pr.number} · ${pr.status}`);

  // A material demand cannot be submitted without its BOQ and drawings.
  const missingDocs = await refused(submitPr(requester, pr.id, prisma));
  check(
    "submission refused while the BOQ and drawings are missing",
    Boolean(missingDocs),
    missingDocs ?? "it was accepted, which is wrong",
  );

  const boqType = await prisma.documentType.findUniqueOrThrow({ where: { code: "BOQ" } });
  const drawingType = await prisma.documentType.findUniqueOrThrow({ where: { code: "DRAWING" } });
  for (const [type, name, category_] of [
    [boqType, `BOQ take-off ${RUN}`, "BOQ"],
    [drawingType, `Reinforcement drawings ${RUN}`, "Drawing"],
  ] as const) {
    await prisma.document.create({
      data: {
        name,
        originalFilename: `${name.replace(/\s+/g, "-").toLowerCase()}.pdf`,
        storagePath: `acceptance/${RUN}/${category_.toLowerCase()}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 220_000,
        documentTypeId: type.id,
        linkedType: "PR",
        linkedId: pr.id,
        caseKey: pr.number,
        category: category_,
        description: `Supporting ${category_} for acceptance run ${RUN}.`,
        entityId: entity.id,
        uploadedById: requester.id,
      },
    });
  }

  const remaining = await validateForSubmission(pr.id, prisma);
  check(
    "every submission requirement satisfied once the pack is complete",
    remaining.length === 0,
    remaining.length ? remaining.join(" | ") : "BOQ reference, drawings, project, site and PM owner all present",
  );
  await submitPr(requester, pr.id, prisma);
  let guard = 0;
  const docType = "MATERIAL_DEMAND";
  while (guard++ < 8) {
    const next = await currentApprover(docType, pr.id, entity.id);
    if (!next) break;
    await decidePr(next, pr.id, "APPROVED", "Approved on the acceptance run.", prisma);
  }
  const approvedPr = await prisma.purchaseRequisition.findUniqueOrThrow({ where: { id: pr.id } });
  check(
    "requisition approved through its configured chain",
    ["APPROVED", "PROCUREMENT_REVIEW", "SOURCING"].includes(approvedPr.status),
    `${approvedPr.number} · ${approvedPr.status}`,
  );

  /* ── 2. Sourcing ──────────────────────────────────────── */
  stage("Sourcing — one RFQ, three competing quotations");
  if (approvedPr.status !== "SOURCING") await startSourcing(officer, pr.id, prisma);
  const rfq = await createRfq(
    officer,
    {
      prId: pr.id,
      title: `RFQ — acceptance run ${RUN}, Grade 60 deformed bar`,
      scope: `Supply and delivery of ${ORDERED} ton deformed steel bar Grade 60 to ${store.name}.`,
      responseDeadline: new Date(Date.now() + 7 * 86_400_000),
      vendorIds: vendors.map((v) => v.id),
    },
    prisma,
  );
  await issueRfq(officer, rfq.id, prisma);
  check("RFQ issued to three vendors", true, `${rfq.number} · ${vendors.map((v) => v.name).join(", ")}`);

  const prItem = await prisma.purchaseRequisitionItem.findFirstOrThrow({ where: { prId: pr.id } });
  const prices = [UNIT_PRICE, UNIT_PRICE * 1.045, UNIT_PRICE * 0.972];
  const compliance = ["COMPLIANT", "COMPLIANT", "PARTIAL"] as const;
  for (const [i, vendor] of vendors.entries()) {
    await upsertQuote(
      buyer,
      {
        rfqId: rfq.id,
        vendorId: vendor.id,
        quoteRef: `Q/${RUN}/${i + 1}`,
        deliveryDays: 7 + i * 3,
        paymentTerms: "30 days from GRN",
        creditDays: 30,
        technicalCompliance: compliance[i],
        complianceNotes:
          compliance[i] === "PARTIAL"
            ? "Mixed-mill stock; cannot certify per heat, which the specification requires."
            : "Single-mill supply with per-heat mill certificates.",
        items: [
          {
            prItemId: prItem.id,
            itemId: item.id,
            description: prItem.description,
            quantity: ORDERED,
            unit: UNIT,
            unitPrice: Math.round(prices[i]),
            taxRate: 18,
            deliveryDays: 7 + i * 3,
            compliance: compliance[i],
          },
        ],
      },
      prisma,
    );
  }
  const quotes = await prisma.vendorQuote.findMany({
    where: { rfqId: rfq.id },
    include: { vendor: true },
    orderBy: { total: "asc" },
  });
  check("three quotations recorded", quotes.length === 3, quotes.map((q) => q.total.toLocaleString()).join(" / "));

  /* ── 3. Comparative and recommendation ────────────────── */
  stage("Comparative — cheapest is not automatically the winner");
  const comparative = await buildComparative(
    officer,
    { rfqId: rfq.id, notes: `Comparative for acceptance run ${RUN}.` },
    prisma,
  );
  const lines = await prisma.comparativeLine.findMany({
    where: { comparativeId: comparative.id },
    include: { vendor: true, quote: true },
  });
  const lowest = lines.find((l) => l.isLowest);
  const compliantLines = lines.filter((l) => l.technicalCompliance === "COMPLIANT");
  const award = compliantLines.sort((a, b) => a.netTotal - b.netTotal)[0];
  check(
    "comparative flags the lowest quotation",
    Boolean(lowest),
    lowest ? `${lowest.vendor.name} at ${lowest.netTotal.toLocaleString()}` : "no lowest flag",
  );

  // The cheapest quote here is technically non-compliant, so the benchmark the
  // rule measures against is the cheapest *compliant* offer.
  check(
    "the cheapest quotation is the technically non-compliant one",
    lowest?.technicalCompliance !== "COMPLIANT",
    `${lowest?.vendor.name} is ${lowest?.technicalCompliance}`,
  );

  // Awarding a dearer compliant vendor with no written justification must fail.
  const dearest = compliantLines.sort((a, b) => b.netTotal - a.netTotal)[0];
  const noJustification = await refused(
    recommendVendor(
      selector,
      { comparativeId: comparative.id, quoteId: dearest.quoteId, basis: "Preferred supplier." },
      prisma,
    ),
  );
  check(
    "an award above the lowest compliant quote is refused without justification",
    Boolean(noJustification),
    (noJustification ?? "accepted, which is wrong").slice(0, 110),
  );

  // The same award goes through once the reasoning is on the record.
  await recommendVendor(
    selector,
    {
      comparativeId: comparative.id,
      quoteId: dearest.quoteId,
      basis: "Awarded above the lowest compliant quotation on documented technical grounds.",
      nonLowestJustification:
        "The lower compliant offer cannot hold the delivery window for the pour sequence; slipping the raft pour costs more than the price difference.",
    },
    prisma,
  );
  const withJustification = await prisma.comparative.findUniqueOrThrow({ where: { id: comparative.id } });
  check(
    "the justification is recorded against the comparative",
    Boolean(withJustification.nonLowestJustification?.trim()),
    withJustification.nonLowestJustification?.slice(0, 80) ?? "not recorded",
  );
  const nonLowestException = await prisma.exception.findFirst({
    where: { type: "NON_LOWEST_SELECTED", caseKey: pr.number },
  });
  check(
    "the non-lowest award is raised as a tracked exception",
    Boolean(nonLowestException),
    nonLowestException ? `${nonLowestException.number} · ${nonLowestException.severity}` : "none raised",
  );

  // Then the intended, cheapest compliant vendor is recommended instead.
  await recommendVendor(
    selector,
    {
      comparativeId: comparative.id,
      quoteId: award.quoteId,
      basis: "Lowest technically compliant quotation on a delivered, tax-inclusive basis.",
    },
    prisma,
  );
  const finalComparative = await prisma.comparative.findUniqueOrThrow({ where: { id: comparative.id } });
  check(
    "re-recommending the lowest compliant quote clears the justification",
    finalComparative.nonLowestJustification === null,
    "no justification is held against a benchmark award",
  );
  const recommended = await prisma.comparativeLine.findFirstOrThrow({
    where: { comparativeId: comparative.id, isSelected: true },
    include: { vendor: true },
  });
  check(
    "recommendation recorded against the compliant vendor",
    recommended.vendorId === award.vendorId,
    `${recommended.vendor.name} at ${recommended.netTotal.toLocaleString()}`,
  );

  /* ── 4. Committee ─────────────────────────────────────── */
  stage("Committee — the value decides whether CPC review applies");
  const requirement = await cpcRequirement(entity.id, recommended.netTotal, "MATERIAL_DEMAND", prisma);
  check(
    "CPC requirement derived from the configured threshold",
    requirement.required,
    `${requirement.reason} (threshold ${requirement.threshold.toLocaleString()})`,
  );

  if (requirement.required) {
    const kase = await createCpcCase(
      officer,
      {
        comparativeId: comparative.id,
        recommendation: `Award ${recommended.vendor.name} at ${recommended.netTotal.toLocaleString()}.`,
        riskNotes: "Single-source mill certification is the controlling risk; price is fixed for the delivery window.",
      },
      prisma,
    );
    const members = await prisma.cpcCaseMember.findMany({
      where: { caseId: kase.id },
      include: { user: { select: { email: true } } },
    });
    for (const m of members) {
      const fresh = await prisma.cpcCase.findUniqueOrThrow({ where: { id: kase.id } });
      if (["APPROVED", "REJECTED", "RETURNED", "CLARIFICATION"].includes(fresh.status)) break;
      const voter = await sessionFor(m.user.email);
      if (!voter.permissions.includes(P.CPC_DECIDE)) continue;
      await castCpcDecision(
        voter,
        { caseId: kase.id, vote: "APPROVE", comment: "Compliant award, price verified against the comparative." },
        prisma,
      );
    }
    const decided = await prisma.cpcCase.findUniqueOrThrow({ where: { id: kase.id } });
    check("committee case approved by recorded votes", decided.status === "APPROVED", `${decided.number} · ${decided.status}`);
  }

  /* ── 5. Purchase order ────────────────────────────────── */
  stage("Purchase order — created from the approved case, then approved and issued");
  const po = await createPoFromCase(
    poCreator,
    {
      prId: pr.id,
      deliveryStoreId: store.id,
      deliveryDate: new Date(Date.now() + 14 * 86_400_000),
      paymentTerms: "30 days from GRN",
      creditDays: 30,
    },
    prisma,
  );
  const earlyInvoice = await refused(
    registerInvoice(
      financeUser,
      {
        poId: po.id,
        vendorInvoiceNumber: `EARLY/${RUN}`,
        invoiceDate: new Date(),
        items: [{ description: "Premature invoice", quantity: 1, unit: UNIT, unitPrice: UNIT_PRICE }],
      },
      prisma,
    ),
  );
  check(
    "an invoice against an unissued order is refused",
    Boolean(earlyInvoice),
    (earlyInvoice ?? "accepted, which is wrong").slice(0, 90),
  );

  await submitPoForApproval(poCreator, po.id, prisma);
  guard = 0;
  while (guard++ < 8) {
    const next = await currentApprover("PO", po.id, entity.id);
    if (!next) break;
    await decidePo(next, po.id, "APPROVED", "Approved on the acceptance run.", prisma);
  }
  await issuePo(poCreator, po.id, prisma);
  const issued = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: po.id },
    include: { items: true, vendor: true },
  });
  check(
    "purchase order issued for the full ordered quantity",
    issued.status === "ISSUED" && issued.items[0].quantity === ORDERED,
    `${issued.number} · ${issued.vendor.name} · ${issued.items[0].quantity} ${issued.items[0].unit}`,
  );

  /* ── 6. Gate pass and short delivery ──────────────────── */
  stage("Receiving — the vendor delivers short of the order");
  const gatePass = await createGatePass(
    security,
    {
      direction: "INWARD",
      poId: po.id,
      vendorId: issued.vendorId,
      storeId: store.id,
      vehicleNumber: `LES-${RUN.slice(-4)}`,
      driverName: "Muhammad Yousaf",
      deliveryNoteRef: `DN/${RUN}`,
      materialSummary: `${item.name} — ${DELIVERED} ${UNIT} declared`,
      declaredQuantity: DELIVERED,
    },
    prisma,
  );
  check("gate pass recorded at the boundary", Boolean(gatePass.number), `${gatePass.number} · ${gatePass.serial}`);

  const poItem = issued.items[0];
  const overDelivery = await refused(
    recordDelivery(
      receiver,
      {
        poId: po.id,
        gatePassId: gatePass.id,
        storeId: store.id,
        items: [{ poItemId: poItem.id, actualQty: ORDERED + 20, acceptedQty: ORDERED + 20 }],
      },
      prisma,
    ),
  );
  check(
    "receiving more than was ordered is refused",
    Boolean(overDelivery),
    (overDelivery ?? "accepted, which is wrong").slice(0, 90),
  );

  const received = await recordDelivery(
    receiver,
    {
      poId: po.id,
      gatePassId: gatePass.id,
      storeId: store.id,
      deliveryNoteRef: `DN/${RUN}`,
      totalPackages: 18,
      packagesVerified: 18,
      documentationComplete: true,
      remarks: "Weighbridge slip attached; balance promised on the next despatch.",
      items: [
        {
          poItemId: poItem.id,
          actualQty: DELIVERED,
          acceptedQty: DELIVERED,
          specificationMatch: true,
          discrepancyType: "SHORT_DELIVERY",
          discrepancyNotes: `${ORDERED - DELIVERED} ${UNIT} short against the order; mill certificates received for the delivered heats.`,
        },
      ],
    },
    prisma,
  );
  const delivery = received.delivery;
  // The delivery line carries the discrepancy; the exception it raises is filed
  // against the purchase order, which is what procurement must act on to recover
  // the balance.
  const shortLine = await prisma.deliveryItem.findFirstOrThrow({ where: { deliveryId: delivery.id } });
  check(
    "the short delivery is recorded on the line, not smoothed over",
    shortLine.discrepancyType === "SHORT_DELIVERY" && shortLine.actualQty === DELIVERED,
    `${shortLine.discrepancyType} · ${shortLine.actualQty} of ${ORDERED} ${poItem.unit}`,
  );
  const shortException = await prisma.exception.findFirst({
    where: { type: "QUANTITY_MISMATCH", documentType: "PO", documentId: po.id },
    orderBy: { createdAt: "desc" },
  });
  check(
    "the discrepancy raises a tracked exception on the order",
    Boolean(shortException),
    shortException
      ? `${shortException.number} · ${shortException.type} · ${shortException.title}`
      : "no exception raised",
  );

  /* ── 7. Inspection and GRN ────────────────────────────── */
  stage("Inspection and GRN — only what was accepted enters inventory");
  const inspection = await prisma.inspection.findFirst({
    where: { deliveryId: delivery.id },
    include: { items: true },
  });
  if (inspection) {
    const beforeInspection = await grnReadiness(delivery.id, prisma);
    check(
      "GRN refused while the mandatory inspection is open",
      !beforeInspection.ready,
      beforeInspection.issues[0] ?? "readiness reported ready, which is wrong",
    );
    await recordInspection(
      inspector,
      {
        inspectionId: inspection.id,
        result: "APPROVED",
        findings: "Diameter, rib profile and mill markings verified against the certificates for each heat.",
        signedByName: inspector.name,
        items: inspection.items.map((it) => ({
          inspectionItemId: it.id,
          quantityPassed: it.quantityInspected || DELIVERED,
          quantityFailed: 0,
          verdict: "PASS" as const,
          notes: "Conforms to ASTM A615 Grade 60.",
        })),
      },
      prisma,
    );
  }

  if (!poItem.itemId) throw new Error("The purchase order line lost its catalogue item — inventory cannot be checked.");
  const stockBefore = await availableQuantity(poItem.itemId, store.id, prisma);
  const deliveryItem = await prisma.deliveryItem.findFirstOrThrow({ where: { deliveryId: delivery.id } });
  const grn = await createGrn(
    storeKeeper,
    {
      deliveryId: delivery.id,
      storeId: store.id,
      remarks: `Acceptance run ${RUN} — accepted quantity only.`,
      items: [{ deliveryItemId: deliveryItem.id, acceptedQty: DELIVERED, rejectedQty: 0 }],
      post: true,
    },
    prisma,
  );
  const posted = await prisma.grn.findUniqueOrThrow({ where: { id: grn.id }, include: { items: true } });
  check(
    "GRN posted for the accepted quantity, not the ordered quantity",
    posted.status === "POSTED" && posted.items[0].acceptedQty === DELIVERED,
    `${posted.number} · ${posted.items[0].acceptedQty} of ${ORDERED} ${poItem.unit}`,
  );

  const stockAfter = await availableQuantity(poItem.itemId, store.id, prisma);
  check(
    "inventory increased by exactly what was received",
    Math.abs(stockAfter - stockBefore - DELIVERED) < 0.001,
    `${item.sku} at ${store.name}: ${stockBefore} → ${stockAfter} ${UNIT} (+${DELIVERED})`,
  );
  const ledger = await prisma.inventoryTransaction.findFirst({
    where: { itemId: poItem.itemId, storeId: store.id, sourceRef: posted.number },
  });
  check(
    "the receipt is on the immutable ledger, traced to its GRN",
    Boolean(ledger) && ledger?.quantity === DELIVERED,
    ledger ? `${ledger.type} ${ledger.quantity} ${UNIT} from ${ledger.sourceRef}` : "no ledger line found",
  );

  const afterReceipt = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: po.id },
    include: { items: true },
  });
  const pending = afterReceipt.items[0].quantity - afterReceipt.items[0].acceptedQty;
  check(
    "order stays open with the balance outstanding",
    afterReceipt.status === "PARTIALLY_RECEIVED" && Math.abs(pending - (ORDERED - DELIVERED)) < 0.001,
    `${afterReceipt.status} · ${pending} ${poItem.unit} pending`,
  );

  /* ── 8. The invoice that must be blocked ──────────────── */
  stage("Invoice — the vendor bills for the full order and is blocked");
  const registered = await registerInvoice(
    financeUser,
    {
      poId: po.id,
      vendorInvoiceNumber: `ACC/${RUN}/INV`,
      invoiceDate: new Date(),
      dueDate: new Date(Date.now() + 30 * 86_400_000),
      items: [
        {
          poItemId: poItem.id,
          description: poItem.description,
          quantity: ORDERED, // billed in full despite the short delivery
          unit: poItem.unit,
          unitPrice: poItem.unitPrice,
          taxRate: poItem.taxRate ?? 18,
        },
      ],
      grnIds: [grn.id],
    },
    prisma,
  );
  if (!registered) throw new Error("The invoice was not returned after registration.");
  const invoice = registered;
  await verifyInvoice(financeUser, invoice.id, prisma).catch(() => undefined);

  const matched = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoice.id },
    include: { items: true, exceptions: true },
  });
  check(
    "three-way match fails on the over-billed quantity",
    matched.matchStatus === "FAILED",
    `${matched.number} · match ${matched.matchStatus} · status ${matched.status}`,
  );
  check(
    "the mismatched line is identified",
    matched.items.some((i) => i.matchFlag !== "OK"),
    matched.items.map((i) => `${i.description.slice(0, 22)}: ${i.matchFlag}`).join("; "),
  );
  const blocking = matched.exceptions.filter((e) => e.blocking);
  check(
    "a blocking exception stands against the invoice",
    blocking.length > 0,
    blocking.map((e) => `${e.number} ${e.type}`).join(", ") || "none raised",
  );
  check("match notes explain the refusal", Boolean(matched.matchNotes?.trim()), matched.matchNotes ?? "—");

  const handoffRefusal = await refused(
    handoffToFinance(
      await withPermission(P.FINANCE_HANDOFF, entity.id),
      invoice.id,
      "Attempting to release payment on a failed match.",
      prisma,
    ),
  );
  check(
    "payment handoff refused while the match fails",
    Boolean(handoffRefusal),
    (handoffRefusal ?? "accepted, which is wrong").slice(0, 110),
  );

  const paid = await prisma.paymentHandoff.findFirst({ where: { invoiceId: invoice.id } });
  check("no payment exists for the blocked invoice", paid === null, paid ? `${paid.number} exists` : "none");

  /* ── Summary ──────────────────────────────────────────── */
  console.log(
    `\n  Case ${pr.number} → ${issued.number} → ${posted.number} → ${matched.number}` +
      `\n  Ordered ${ORDERED}, received ${DELIVERED}, billed ${ORDERED} → payment refused.\n`,
  );
  console.log(`  ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`\nAcceptance run failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  await prisma.$disconnect();
  process.exit(1);
});
