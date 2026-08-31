/**
 * Transactional seed flows.
 *
 * Every case below runs through the same service functions the application
 * calls, so approvals, inventory, exceptions, tasks and the audit trail are all
 * genuine rather than fabricated rows.
 */
import {
  prisma,
  users,
  entityId,
  departmentId,
  projectId,
  siteId,
  storeId,
  locationId,
  categoryId,
  itemId,
  vendorId,
  D,
  FUTURE,
  backdateCase,
  log,
} from "./seed";
import type { SessionUser } from "../src/lib/rbac";
import { getPendingApproval } from "../src/lib/approvals";
import { createPr, submitPr, decidePr, startSourcing, transitionPr } from "../src/server/pr";
import {
  buildComparative,
  createRfq,
  issueRfq,
  recommendVendor,
  recordNegotiation,
  upsertQuote,
  markVendorDeclined,
  closeRfq,
} from "../src/server/sourcing";
import { castCpcDecision, createCpcCase, ensureUpcomingMeeting, recordMinutes, scheduleMeeting } from "../src/server/cpc";
import { createPoFromCase, submitPoForApproval, decidePo, issuePo, closePo } from "../src/server/po";
import { createGatePass, recordDelivery, recordInspection, INSPECTION_TEMPLATES } from "../src/server/receiving";
import { createGrn, recordStacking } from "../src/server/grn";
import {
  registerInvoice,
  verifyInvoice,
  submitInvoiceForApproval,
  decideInvoice,
  handoffToFinance,
  acknowledgeHandoff,
  recordPayment,
} from "../src/server/invoice";
import {
  createPettyCash,
  submitPettyCash,
  addPettyCashQuote,
  selectPettyCashQuote,
  approvePettyCash,
  recordPurchase,
  generateVoucher,
  signVoucher,
  completeStoreEntry,
  reconcilePettyCash,
  closePettyCash,
} from "../src/server/pettycash";
import {
  createStoreIssue,
  decideStoreIssue,
  issueStock,
  createTransfer,
  decideTransfer,
  dispatchTransfer,
  receiveTransfer,
  adjustStock,
} from "../src/server/stores";
import { createDisposalCase, advanceDisposal, addDisposalBid, updateAsset } from "../src/server/assets";
import { recordSavingsForPo } from "../src/server/analytics";
import { recordTraderCase } from "../src/server/vendors";
import { systemActor } from "@/lib/actor";

const U = (email: string) => users[email];

/** Picks a user able to action the current approval step. */
async function approverFor(
  docType: string,
  docId: string,
  ctx: { departmentKey?: string; entity?: "ZM" | "ZD" },
): Promise<{ user: SessionUser; step: string } | null> {
  const instance = await getPendingApproval(docType, docId, prisma);
  if (!instance) return null;
  const current = instance.actions.find((a) => a.sequence === instance.currentSequence && a.action === "PENDING");
  if (!current) return null;

  const role = current.assignedRoleCode;
  const byRole: Record<string, string> = {
    PROCUREMENT_SENIOR_MANAGER: ctx.entity === "ZD" ? "farhan.siddiqui@zameen.com" : "asim.javed@zameen.com",
    PROCUREMENT_DIRECTOR: "kamran.rasheed@zameen.com",
    FINANCE_APPROVER: "nadia.saleem@zameen.com",
    AUDIT_USER: "faryal.qureshi@zameen.com",
    MANAGEMENT_COMMITTEE: "shahid.mahmood@zameen.com",
    WAREHOUSE_MANAGER: "iftikhar.hussain@zameen.com",
    PROCUREMENT_OFFICER: ctx.entity === "ZD" ? "danish.raza@zameen.com" : "hira.aslam@zameen.com",
  };

  if (role === "HOD") {
    // Department-head steps resolve to the actual head of the requesting department.
    const dept = ctx.departmentKey ? await prisma.department.findUnique({ where: { id: departmentId[ctx.departmentKey] } }) : null;
    if (dept?.headId) {
      const u = await prisma.user.findUnique({ where: { id: dept.headId } });
      if (u && users[u.email]) return { user: users[u.email], step: current.stepName };
    }
    return { user: U("haroon.rashid@zameen.com"), step: current.stepName };
  }
  const email = role ? byRole[role] : null;
  if (email && users[email]) return { user: users[email], step: current.stepName };
  return { user: U("kamran.rasheed@zameen.com"), step: current.stepName };
}

/** Walks a PR approval chain to completion. */
async function approvePrChain(prId: string, ctx: { departmentKey: string; entity: "ZM" | "ZD" }, comments?: string[]) {
  const docType = (await prisma.purchaseRequisition.findUniqueOrThrow({ where: { id: prId } })).procurementType ===
  "MATERIAL_DEMAND"
    ? "MATERIAL_DEMAND"
    : "PR";
  let guard = 0;
  let i = 0;
  while (guard++ < 8) {
    const next = await approverFor(docType, prId, ctx);
    if (!next) break;
    await decidePr(next.user, prId, "APPROVED", comments?.[i] ?? null, prisma);
    i += 1;
  }
}

async function approvePoChain(poId: string, entity: "ZM" | "ZD", comments?: string[]) {
  let guard = 0;
  let i = 0;
  while (guard++ < 8) {
    const next = await approverFor("PO", poId, { entity });
    if (!next) break;
    await decidePo(next.user, poId, "APPROVED", comments?.[i] ?? null, prisma);
    i += 1;
  }
}

async function approveInvoiceChain(invoiceId: string, entity: "ZM" | "ZD", comments?: string[]) {
  let guard = 0;
  let i = 0;
  while (guard++ < 8) {
    const next = await approverFor("INVOICE", invoiceId, { entity });
    if (!next) break;
    await decideInvoice(next.user, invoiceId, "APPROVED", comments?.[i] ?? null, prisma);
    i += 1;
  }
}

/** Records every committee member's vote so the case resolves. */
async function voteCpc(caseId: string, decision: "APPROVE" | "REJECT" | "RETURN", comment: string) {
  const kase = await prisma.cpcCase.findUniqueOrThrow({
    where: { id: caseId },
    include: { members: { include: { user: true } } },
  });
  for (const m of kase.members) {
    const session = users[m.user.email];
    if (!session || !session.permissions.includes("cpc.decide")) continue;
    const fresh = await prisma.cpcCase.findUniqueOrThrow({ where: { id: caseId } });
    if (["APPROVED", "REJECTED", "RETURNED", "CLARIFICATION"].includes(fresh.status)) break;
    await castCpcDecision(session, { caseId, vote: decision, comment }, prisma);
  }
}


/** Attaches the BOQ and drawing pack a Material Demand cannot be submitted without. */
async function attachMdDocuments(args: {
  prId: string;
  prNumber: string;
  entity: "ZM" | "ZD";
  uploaderId: string;
  designerId?: string;
  boqName: string;
  boqFile: string;
  drawingName: string;
  drawingFile: string;
}) {
  const boqType = await prisma.documentType.findUniqueOrThrow({ where: { code: "BOQ" } });
  const drawingType = await prisma.documentType.findUniqueOrThrow({ where: { code: "DRAWING" } });
  await prisma.document.create({
    data: {
      name: args.boqName,
      originalFilename: args.boqFile,
      storagePath: `seed/${args.boqFile}`,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: 152_064,
      documentTypeId: boqType.id,
      linkedType: "PR",
      linkedId: args.prId,
      caseKey: args.prNumber,
      category: "BOQ",
      description: "Bill of quantities take-off supporting this material demand.",
      entityId: entityId[args.entity],
      uploadedById: args.uploaderId,
    },
  });
  await prisma.document.create({
    data: {
      name: args.drawingName,
      originalFilename: args.drawingFile,
      storagePath: `seed/${args.drawingFile}`,
      mimeType: "application/pdf",
      sizeBytes: 1_842_176,
      documentTypeId: drawingType.id,
      linkedType: "PR",
      linkedId: args.prId,
      caseKey: args.prNumber,
      category: "Drawing",
      description: "Approved drawings and schedules for this material demand.",
      entityId: entityId[args.entity],
      uploadedById: args.designerId ?? args.uploaderId,
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Flow A — ZM laptop fleet: on-demand, above CPC threshold, closed
// ─────────────────────────────────────────────────────────────
async function flowLaptops() {
  const requester = U("sana.iqbal@zameen.com");
  const officer = U("hira.aslam@zameen.com");
  const security = U("gate.security@zameen.com");
  const receiver = U("waqas.ali@zameen.com");
  const storeMgr = U("shakeel.ahmad@zameen.com");
  const inspector = U("sana.iqbal@zameen.com");
  const director = U("kamran.rasheed@zameen.com");
  const finance = U("imran.shafiq@zameen.com");

  const pr = await createPr(
    requester,
    {
      entityId: entityId.ZM,
      departmentId: departmentId["ZM:IT"],
      procurementType: "ON_DEMAND",
      title: "Laptop refresh — Sales & Marketing (12 units)",
      justification:
        "Existing 2019 units are out of warranty, failing thermally and cannot run the current CRM client. Replacement is required to avoid productivity loss and unsupported endpoints on the network.",
      costCenter: "ZM-CC-110",
      deliveryStoreId: storeId["ST-ZM-IT"],
      requiredDate: FUTURE(21),
      priority: "HIGH",
      budgetAmount: 4_800_000,
      budgetCode: "ZM-CAPEX-IT-2026",
      items: [
        {
          itemId: itemId["IT-LAP-0001"],
          categoryId: categoryId["IT-EQUIP"],
          description: "Business Laptop — 14\" i7 (Dell Latitude 5450 or equivalent)",
          brand: "Dell",
          model: "Latitude 5450",
          make: "Dell Technologies",
          specification:
            "Intel Core i7-1355U or better, 16GB DDR5, 512GB NVMe SSD, 14\" FHD IPS anti-glare, Windows 11 Pro, TPM 2.0, backlit keyboard, 3-year onsite warranty, carry case and charger included",
          quantity: 12,
          unit: "EA",
          estimatedUnitPrice: 385000,
          disposition: "ASSET",
        },
      ],
    },
    prisma,
  );
  await submitPr(requester, pr.id, prisma);
  await approvePrChain(pr.id, { departmentKey: "ZM:IT", entity: "ZM" }, [
    "Approved. The 2019 fleet is beyond economic repair and out of support.",
    "Specification is standard and the value is within the IT capex envelope. Proceed to sourcing.",
    "Approved for sourcing. Ensure at least three quotations and a like-for-like specification comparison.",
  ]);
  await startSourcing(officer, pr.id, prisma);

  const rfq = await createRfq(
    officer,
    {
      prId: pr.id,
      title: "RFQ — Business laptops (12 units)",
      scope:
        "Supply of 12 business-class laptops to the specification attached. Quotation must be like-for-like; equivalents must be stated with full configuration.",
      terms:
        "Prices inclusive of all taxes and delivery to Zameen Tower IT Asset Store. Warranty to be onsite and vendor-registered. Payment 30 days from invoice.",
      deliveryRequirement: "Delivery to IT Asset Store, Zameen Tower, within 14 days of purchase order.",
      responseDeadline: FUTURE(3),
      vendorIds: [
        vendorId["Techno Solutions"],
        vendorId["Digital World Computers"],
        vendorId["Corporate IT Traders"],
      ],
      channels: {
        [vendorId["Techno Solutions"]]: "EMAIL",
        [vendorId["Digital World Computers"]]: "EMAIL",
        [vendorId["Corporate IT Traders"]]: "WHATSAPP",
      },
    },
    prisma,
  );
  await issueRfq(officer, rfq.id, prisma);

  const prItem = (await prisma.purchaseRequisitionItem.findFirstOrThrow({ where: { prId: pr.id } })).id;

  await upsertQuote(
    officer,
    {
      rfqId: rfq.id,
      vendorId: vendorId["Techno Solutions"],
      quoteRef: "TS/QT/2026/0418",
      validUntil: FUTURE(25),
      deliveryCharges: 0,
      taxRegistered: true,
      deliveryDays: 10,
      paymentTerms: "30 days from invoice",
      creditDays: 30,
      warrantyMonths: 36,
      warrantyTerms: "3-year Dell ProSupport onsite, vendor-registered",
      technicalCompliance: "COMPLIANT",
      complianceNotes: "Exact model quoted. Configuration matches specification line for line.",
      channel: "EMAIL",
      items: [
        {
          prItemId: prItem,
          itemId: itemId["IT-LAP-0001"],
          description: "Dell Latitude 5450, i7-1355U, 16GB, 512GB NVMe, 14\" FHD, Win 11 Pro",
          brand: "Dell",
          model: "Latitude 5450",
          specification: "i7-1355U / 16GB DDR5 / 512GB NVMe / 14\" FHD / Win 11 Pro / 3yr onsite",
          quantity: 12,
          unit: "EA",
          unitPrice: 368000,
          taxRate: 18,
          deliveryDays: 10,
          compliance: "COMPLIANT",
        },
      ],
    },
    prisma,
  );

  await upsertQuote(
    officer,
    {
      rfqId: rfq.id,
      vendorId: vendorId["Digital World Computers"],
      quoteRef: "DWC-2026-1180",
      validUntil: FUTURE(15),
      deliveryCharges: 12000,
      taxRegistered: true,
      deliveryDays: 7,
      paymentTerms: "15 days from invoice",
      creditDays: 15,
      warrantyMonths: 12,
      warrantyTerms: "1-year carry-in warranty through local service centre",
      technicalCompliance: "PARTIAL",
      complianceNotes:
        "Offered Latitude 5440 (previous generation) with 8GB RAM upgradeable. Warranty is carry-in, not onsite.",
      channel: "EMAIL",
      items: [
        {
          prItemId: prItem,
          itemId: itemId["IT-LAP-0001"],
          description: "Dell Latitude 5440, i7-1355U, 8GB (upgradeable), 512GB NVMe, 14\" FHD",
          brand: "Dell",
          model: "Latitude 5440",
          specification: "i7-1355U / 8GB / 512GB NVMe / 14\" FHD / Win 11 Pro / 1yr carry-in",
          quantity: 12,
          unit: "EA",
          unitPrice: 341000,
          taxRate: 18,
          deliveryDays: 7,
          compliance: "PARTIAL",
          notes: "RAM below specification; warranty terms below requirement.",
        },
      ],
    },
    prisma,
  );

  await upsertQuote(
    officer,
    {
      rfqId: rfq.id,
      vendorId: vendorId["Metro Office Systems"],
      quoteRef: "MOS/Q/26/0331",
      validUntil: FUTURE(20),
      deliveryCharges: 18000,
      taxRegistered: true,
      deliveryDays: 16,
      paymentTerms: "30 days from invoice",
      creditDays: 30,
      warrantyMonths: 36,
      warrantyTerms: "3-year onsite via principal",
      technicalCompliance: "COMPLIANT",
      channel: "EMAIL",
      items: [
        {
          prItemId: prItem,
          itemId: itemId["IT-LAP-0001"],
          description: "HP ProBook 450 G11, Core Ultra 7, 16GB, 512GB NVMe, 15.6\" FHD",
          brand: "HP",
          model: "ProBook 450 G11",
          specification: "Core Ultra 7 / 16GB / 512GB NVMe / 15.6\" FHD / Win 11 Pro / 3yr onsite",
          quantity: 12,
          unit: "EA",
          unitPrice: 379500,
          taxRate: 18,
          deliveryDays: 16,
          compliance: "COMPLIANT",
        },
      ],
    },
    prisma,
  );

  // Negotiation with the compliant front-runner.
  const technoQuote = await prisma.vendorQuote.findFirstOrThrow({
    where: { rfqId: rfq.id, vendorId: vendorId["Techno Solutions"] },
  });
  await recordNegotiation(
    officer,
    {
      quoteId: technoQuote.id,
      negotiatedTotal: Math.round(technoQuote.total * 0.955),
      channel: "MEETING",
      notes:
        "Met vendor with the previous purchase price of PKR 372,000 per unit and the competing HP offer. Vendor agreed to hold the unit rate and absorb delivery and extended-warranty registration, netting 4.5%.",
      outcome: "ACCEPTED",
    },
    prisma,
  );
  await recordNegotiation(
    officer,
    {
      quoteId: technoQuote.id,
      negotiatedTotal: Math.round(technoQuote.total * 0.938),
      channel: "CALL",
      notes:
        "Second round on the back of a 12-unit single-drop order. Vendor conceded a further 1.7% and included 12 carry cases at no charge.",
      outcome: "ACCEPTED",
    },
    prisma,
  );

  const comparative = await buildComparative(
    officer,
    {
      rfqId: rfq.id,
      marketPrice: 12 * 392000 * 1.18,
      notes:
        "Three quotations received. Digital World is lowest on price but non-compliant on memory and warranty. Corporate IT Traders is compliant on specification but is a cash-terms trader with the longest lead time and the highest net cost. Techno Solutions is compliant, negotiated twice and holds the strongest service record.",
    },
    prisma,
  );

  await recommendVendor(
    officer,
    {
      comparativeId: comparative.id,
      quoteId: technoQuote.id,
      basis:
        "Lowest compliant quotation after negotiation. Full specification match, 3-year onsite warranty, 10-day delivery and the best on-time record of the three vendors.",
    },
    prisma,
  );

  const kase = await createCpcCase(
    officer,
    {
      comparativeId: comparative.id,
      recommendation:
        "Award 12 laptops to Techno Solutions at the negotiated net total. Compliant specification, 3-year onsite warranty, 6.2% below the initial quotation and below the prevailing market rate.",
      riskNotes:
        "Single-vendor concentration in IT hardware is moderate. Warranty registration to be verified at inspection before the GRN is posted.",
    },
    prisma,
  );
  await voteCpc(
    kase.id,
    "APPROVE",
    "Approved. Comparative is complete, the recommendation is the lowest compliant offer and the negotiation is documented.",
  );

  const po = await createPoFromCase(
    officer,
    {
      prId: pr.id,
      deliveryStoreId: storeId["ST-ZM-IT"],
      deliveryDate: FUTURE(10),
      paymentTerms: "30 days from invoice",
      creditDays: 30,
      warrantyTerms: "3-year Dell ProSupport onsite, registered to Zameen Media",
      termsConditions:
        "1. Delivery to IT Asset Store, Zameen Tower. 2. Serial numbers to be listed on the delivery challan. 3. Warranty to be registered against the buyer before invoice submission. 4. Goods subject to technical inspection; rejected units to be replaced within 7 days at no cost.",
    },
    prisma,
  );
  await submitPoForApproval(officer, po.id, prisma);
  await approvePoChain(po.id, "ZM", [
    "Approved — matches the CPC-approved comparative.",
    "Approved for issue.",
    "Funding confirmed against ZM-CAPEX-IT-2026.",
  ]);
  await issuePo(director, po.id, prisma);
  await recordSavingsForPo(systemActor("SEED"), po.id, prisma);

  // Delivery
  const gp = await createGatePass(
    security,
    {
      poId: po.id,
      storeId: storeId["ST-ZM-IT"],
      vehicleNumber: "LEA-4471",
      vehicleType: "Suzuki Bolan",
      driverName: "Ghulam Abbas",
      driverCnic: "35202-1122334-5",
      driverPhone: "+92 321 4455661",
      deliveryNoteRef: "TS/DC/2026/0771",
      invoiceRef: "TS/INV/2026/0669",
      materialSummary: "12 laptop cartons, 12 carry cases",
      declaredQuantity: 12,
      declaredPackages: 24,
      securityRemarks: "Cartons sealed and intact. Vehicle and driver documents verified at gate.",
    },
    prisma,
  );

  const poItems = await prisma.purchaseOrderItem.findMany({ where: { poId: po.id } });
  const serials = Array.from({ length: 12 }, (_, i) => `DL5450-26-${String(4180 + i)}`).join(", ");
  const { delivery, inspection } = await recordDelivery(
    receiver,
    {
      poId: po.id,
      gatePassId: gp.id,
      storeId: storeId["ST-ZM-IT"],
      deliveryNoteRef: "TS/DC/2026/0771",
      totalPackages: 24,
      packagesVerified: 24,
      packagingCondition: "Original sealed cartons, no tampering",
      physicalCondition: "New, no cosmetic damage",
      documentationComplete: true,
      remarks: "All 12 units received with chargers and carry cases. Serial numbers recorded from carton labels.",
      items: [
        {
          poItemId: poItems[0].id,
          actualQty: 12,
          acceptedQty: 12,
          packages: 24,
          serialNumbers: serials,
          warrantyMonths: 36,
          specificationMatch: true,
          conditionNotes: "All cartons sealed; contents verified against packing list.",
          discrepancyType: "OK",
        },
      ],
    },
    prisma,
  );

  if (inspection) {
    const template = INSPECTION_TEMPLATES[0];
    const items = await prisma.inspectionItem.findMany({ where: { inspectionId: inspection.id } });
    await recordInspection(
      inspector,
      {
        inspectionId: inspection.id,
        result: "APPROVED",
        findings:
          "All 12 units powered on and booted to Windows 11 Pro. Configuration verified as i7-1355U / 16GB / 512GB on every unit. Warranty registered against Zameen Media on the Dell portal. Accessories complete.",
        signedByName: "Sana Iqbal — IT Infrastructure Engineer",
        items: items.map((it) => ({
          inspectionItemId: it.id,
          quantityPassed: 12,
          quantityFailed: 0,
          serialNumber: serials,
          modelVerified: "Dell Latitude 5450",
          specVerified: "i7-1355U / 16GB DDR5 / 512GB NVMe / 14\" FHD",
          configuration: "Windows 11 Pro 23H2, TPM 2.0 enabled, BitLocker ready",
          condition: "New",
          performanceNotes: "Boot and stress test passed on all units. No thermal throttling observed.",
          accessoriesComplete: true,
          verdict: "PASS" as const,
          criteriaResults: template.criteria.map((c) => ({
            key: c.key,
            label: c.label,
            value:
              c.kind === "boolean"
                ? true
                : c.key === "model"
                  ? "Dell Latitude 5450"
                  : c.key === "serial"
                    ? serials
                    : c.key === "processor"
                      ? "Intel Core i7-1355U"
                      : c.key === "memory"
                        ? "16GB DDR5"
                        : c.key === "storage"
                          ? "512GB NVMe"
                          : c.key === "display"
                            ? "14\" FHD IPS"
                            : c.key === "os"
                              ? "Windows 11 Pro (OEM licence)"
                              : c.key === "performance"
                                ? "Pass"
                                : c.key === "physical"
                                  ? "New"
                                  : "Verified",
          })),
        })),
      },
      prisma,
    );
  }

  const deliveryItems = await prisma.deliveryItem.findMany({ where: { deliveryId: delivery.id } });
  const grn = await createGrn(
    storeMgr,
    {
      deliveryId: delivery.id,
      remarks: "Inspection cleared. Units taken into the IT asset store and tagged.",
      items: [
        {
          deliveryItemId: deliveryItems[0].id,
          acceptedQty: 12,
          serialNumbers: serials,
          warrantyMonths: 36,
          storeLocationId: locationId["ST-ZM-IT:IT-SEC-01"],
          disposition: "ASSET",
        },
      ],
      post: true,
    },
    prisma,
  );

  await recordStacking(
    storeMgr,
    {
      grnId: grn.id,
      storeId: storeId["ST-ZM-IT"],
      entries: [
        {
          itemId: itemId["IT-LAP-0001"],
          description: "Dell Latitude 5450 — sealed cartons",
          quantity: 12,
          unit: "EA",
          locationId: locationId["ST-ZM-IT:IT-SEC-01"],
          stackingMethod: "SHELF",
          goodsClass: "HIGH_VALUE",
          handlingRequirements: "Secure cage, access log maintained. Do not stack more than 4 cartons high.",
          notes: "Serial-to-asset-tag mapping recorded in the asset register.",
        },
      ],
    },
    prisma,
  );

  const invoice = await registerInvoice(
    officer,
    {
      poId: po.id,
      vendorInvoiceNumber: "TS/INV/2026/0669",
      invoiceDate: D(2),
      deliveryCharges: 0,
      items: [
        {
          poItemId: poItems[0].id,
          description: "Dell Latitude 5450 — 12 units",
          quantity: 12,
          unit: "EA",
          unitPrice: poItems[0].unitPrice,
          taxRate: 18,
        },
      ],
    },
    prisma,
  );
  if (invoice) {
    await verifyInvoice(officer, invoice.id, prisma);
    await submitInvoiceForApproval(officer, invoice.id, prisma);
    await approveInvoiceChain(invoice.id, "ZM", [
      "Three-way match passed. Approved.",
      "Approved for payment.",
      "Payment released against confirmed GRN.",
    ]);
    const handoff = await handoffToFinance(
      director,
      invoice.id,
      "Match passed, GRN posted and inspection cleared. Released for payment on 30-day terms.",
      prisma,
    );
    await acknowledgeHandoff(
      finance,
      handoff.id,
      { paymentMethod: "BANK_TRANSFER", bankAccount: "HBL 01234567890123", scheduledDate: D(1), notes: "Scheduled in the weekly payment run." },
      prisma,
    );
    await recordPayment(
      finance,
      handoff.id,
      { paymentReference: "HBL-FT-2026-884210", paidDate: D(1), paymentMethod: "BANK_TRANSFER" },
      prisma,
    );
  }

  const finalPo = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
  if (finalPo.status !== "CLOSED") {
    await closePo(U("asim.javed@zameen.com"), po.id, "All 12 units received, inspected, tagged and the invoice paid.", prisma);
  }

  await backdateCase(pr.number, 38);
  log("Flow A", `${pr.number} laptops — CPC approved, delivered, inspected, GRN posted, invoice paid, case closed`);
  return { prNumber: pr.number, poId: po.id };
}

// ─────────────────────────────────────────────────────────────
// Flow B — ZD steel Material Demand: the short-delivery + invoice
//          mismatch acceptance scenario
// ─────────────────────────────────────────────────────────────
async function flowSteelMd() {
  const pm = U("aliya.zafar@zameen.com");
  const officer = U("danish.raza@zameen.com");
  const security = U("gate.security@zameen.com");
  const siteStore = U("naveed.anjum@zameen.com");
  const qc = U("zeeshan.qadir@zameen.com");
  const director = U("kamran.rasheed@zameen.com");

  const pr = await createPr(
    pm,
    {
      entityId: entityId.ZD,
      departmentId: departmentId["ZD:PROJ"],
      procurementType: "MATERIAL_DEMAND",
      title: "MD — Deformed steel bar Grade 60 for Opal Mall raft foundation (100 ton)",
      justification:
        "Raft foundation reinforcement for Opal Mall basement. Quantity taken off BOQ item 03.02.01 against structural drawings S-201 to S-208. Required on site before the scheduled pour window.",
      projectId: projectId["ZD-OPL"],
      siteId: siteId["SITE-OPL"],
      costCenter: "ZD-CC-200",
      deliveryStoreId: storeId["ST-OPL"],
      requiredDate: FUTURE(14),
      priority: "URGENT",
      budgetAmount: 32_000_000,
      budgetCode: "ZD-OPL-STRUCT-2026",
      pmOwnerId: pm.id,
      boqReference: "BOQ-OPL-03.02.01 (Rev C)",
      drawingReference: "S-201 to S-208 (Rev D), Raft reinforcement schedule RS-04",
      technicalNotes:
        "ASTM A615 Grade 60 deformed bars. Mill test certificate mandatory per consignment. Bars to be free of excessive rust, pitting and mill scale. Weight to be verified against challan at the site weighbridge.",
      items: [
        {
          itemId: itemId["CST-STL-0001"],
          categoryId: categoryId["CONSTR-STEEL"],
          description: "Deformed steel bar Grade 60 — 16mm dia",
          brand: "Amreli / Mughal (approved mills)",
          specification:
            "ASTM A615 Grade 60, 16mm nominal diameter, 40ft standard length, mill test certificate per heat, yield ≥ 60 ksi",
          quantity: 60,
          unit: "TON",
          estimatedUnitPrice: 268000,
          disposition: "PROJECT_MATERIAL",
        },
        {
          itemId: itemId["CST-STL-0002"],
          categoryId: categoryId["CONSTR-STEEL"],
          description: "Deformed steel bar Grade 60 — 12mm dia",
          brand: "Amreli / Mughal (approved mills)",
          specification:
            "ASTM A615 Grade 60, 12mm nominal diameter, 40ft standard length, mill test certificate per heat",
          quantity: 40,
          unit: "TON",
          estimatedUnitPrice: 265000,
          disposition: "PROJECT_MATERIAL",
        },
      ],
    },
    prisma,
  );

  await prisma.document.create({
    data: {
      name: "BOQ-OPL-03.02.01 Rev C — Raft reinforcement take-off",
      originalFilename: "BOQ-OPL-03.02.01-RevC.xlsx",
      storagePath: "seed/boq-opl-030201-revc.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: 184320,
      documentTypeId: (await prisma.documentType.findUniqueOrThrow({ where: { code: "BOQ" } })).id,
      linkedType: "PR",
      linkedId: pr.id,
      caseKey: pr.number,
      category: "BOQ",
      description: "Bill of quantities take-off supporting the steel demand.",
      entityId: entityId.ZD,
      uploadedById: pm.id,
    },
  });
  await prisma.document.create({
    data: {
      name: "S-201 to S-208 Rev D — Raft reinforcement drawings",
      originalFilename: "S-201-S-208-RevD.pdf",
      storagePath: "seed/s201-s208-revd.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2_458_112,
      documentTypeId: (await prisma.documentType.findUniqueOrThrow({ where: { code: "DRAWING" } })).id,
      linkedType: "PR",
      linkedId: pr.id,
      caseKey: pr.number,
      category: "Drawing",
      description: "Structural drawings and reinforcement schedule.",
      entityId: entityId.ZD,
      uploadedById: U("sadia.rehman@zameen.com").id,
    },
  });

  await submitPr(pm, pr.id, prisma);
  await approvePrChain(pr.id, { departmentKey: "ZD:PROJ", entity: "ZD" }, [
    "Quantities verified against BOQ Rev C and drawings Rev D. Technically validated.",
    "Supply chain reviewed. Two approved mills plus one trader to be invited. Mill certificates mandatory.",
    "Approved. Value exceeds the ZD committee threshold — route through CPC after the comparative.",
  ]);
  await startSourcing(officer, pr.id, prisma);

  const rfq = await createRfq(
    officer,
    {
      prId: pr.id,
      title: "RFQ — Grade 60 deformed steel bar, 100 ton (Opal Mall raft)",
      scope:
        "Supply and delivery of 60 ton 16mm and 40 ton 12mm ASTM A615 Grade 60 deformed bar to Opal Mall site store. Mill test certificate required per heat.",
      terms:
        "Rate per ton inclusive of sales tax and delivery to site. Weight verified at site weighbridge; short weight to be adjusted on the invoice. Payment 30 days from invoice.",
      deliveryRequirement: "Phased delivery to Opal Mall Site Store within 10 days of purchase order.",
      responseDeadline: FUTURE(2),
      vendorIds: [
        vendorId["Amreli Steels Distributor — Steel Line"],
        vendorId["Mughal Steel Direct"],
        vendorId["Ittehad Steel Traders"],
      ],
    },
    prisma,
  );
  await issueRfq(officer, rfq.id, prisma);

  const prItems = await prisma.purchaseRequisitionItem.findMany({ where: { prId: pr.id }, orderBy: { lineNo: "asc" } });

  await upsertQuote(
    officer,
    {
      rfqId: rfq.id,
      vendorId: vendorId["Amreli Steels Distributor — Steel Line"],
      quoteRef: "SL/QT/26/1142",
      validUntil: FUTURE(7),
      deliveryCharges: 0,
      deliveryDays: 8,
      paymentTerms: "30 days, 2% discount on settlement within 10 days",
      creditDays: 30,
      warrantyMonths: 0,
      technicalCompliance: "COMPLIANT",
      complianceNotes: "Amreli Grade 60. Mill test certificate per heat confirmed. Delivery to site included.",
      channel: "EMAIL",
      items: [
        { prItemId: prItems[0].id, itemId: itemId["CST-STL-0001"], description: "Grade 60 deformed bar 16mm", quantity: 60, unit: "TON", unitPrice: 264500, taxRate: 18, deliveryDays: 8, compliance: "COMPLIANT" },
        { prItemId: prItems[1].id, itemId: itemId["CST-STL-0002"], description: "Grade 60 deformed bar 12mm", quantity: 40, unit: "TON", unitPrice: 262000, taxRate: 18, deliveryDays: 8, compliance: "COMPLIANT" },
      ],
    },
    prisma,
  );
  await upsertQuote(
    officer,
    {
      rfqId: rfq.id,
      vendorId: vendorId["Mughal Steel Direct"],
      quoteRef: "MISIL/DS/26/8871",
      validUntil: FUTURE(5),
      deliveryCharges: 145000,
      deliveryDays: 6,
      paymentTerms: "Advance against proforma, or 15 days against security cheque",
      creditDays: 15,
      technicalCompliance: "COMPLIANT",
      complianceNotes: "Ex-mill rate; delivery charged separately. Mill certificate per heat.",
      channel: "EMAIL",
      items: [
        { prItemId: prItems[0].id, itemId: itemId["CST-STL-0001"], description: "Grade 60 deformed bar 16mm (ex-mill)", quantity: 60, unit: "TON", unitPrice: 262800, taxRate: 18, deliveryDays: 6, compliance: "COMPLIANT" },
        { prItemId: prItems[1].id, itemId: itemId["CST-STL-0002"], description: "Grade 60 deformed bar 12mm (ex-mill)", quantity: 40, unit: "TON", unitPrice: 261500, taxRate: 18, deliveryDays: 6, compliance: "COMPLIANT" },
      ],
    },
    prisma,
  );
  await upsertQuote(
    officer,
    {
      rfqId: rfq.id,
      vendorId: vendorId["Ittehad Steel Traders"],
      quoteRef: "IST-VERBAL-0416",
      validUntil: FUTURE(3),
      deliveryCharges: 60000,
      deliveryDays: 4,
      paymentTerms: "Cash on delivery",
      creditDays: 0,
      technicalCompliance: "PARTIAL",
      complianceNotes:
        "Trader stock. Cannot guarantee a single mill or provide certificates per heat for the full quantity. Suitable only for small top-up lots.",
      channel: "WHATSAPP",
      items: [
        { prItemId: prItems[0].id, itemId: itemId["CST-STL-0001"], description: "Grade 60 deformed bar 16mm (mixed mill)", quantity: 60, unit: "TON", unitPrice: 259000, taxRate: 0, deliveryDays: 4, compliance: "PARTIAL", notes: "Non-tax invoice; mixed mill stock." },
        { prItemId: prItems[1].id, itemId: itemId["CST-STL-0002"], description: "Grade 60 deformed bar 12mm (mixed mill)", quantity: 40, unit: "TON", unitPrice: 257500, taxRate: 0, deliveryDays: 4, compliance: "PARTIAL" },
      ],
    },
    prisma,
  );

  const steelLineQuote = await prisma.vendorQuote.findFirstOrThrow({
    where: { rfqId: rfq.id, vendorId: vendorId["Amreli Steels Distributor — Steel Line"] },
  });
  await recordNegotiation(
    officer,
    {
      quoteId: steelLineQuote.id,
      negotiatedTotal: Math.round(steelLineQuote.total * 0.972),
      channel: "MEETING",
      notes:
        "Negotiated against the ex-mill benchmark and the current market rate of PKR 271,000/ton. Vendor reduced both rates by PKR 2,000/ton and absorbed the second-trip delivery cost. Achieved 2.8% on the gross.",
      outcome: "ACCEPTED",
    },
    prisma,
  );

  const comparative = await buildComparative(
    officer,
    {
      rfqId: rfq.id,
      marketPrice: 60 * 271000 * 1.18 + 40 * 268000 * 1.18,
      notes:
        "Ittehad is nominally cheapest but is a non-tax trader with mixed-mill stock and cannot certify per heat — unacceptable for raft reinforcement. Mughal is ex-mill with separate freight and requires a security cheque. Steel Line is compliant, delivered, tax-registered and negotiated down.",
    },
    prisma,
  );
  await recommendVendor(
    officer,
    {
      comparativeId: comparative.id,
      quoteId: steelLineQuote.id,
      basis:
        "Lowest compliant delivered cost after negotiation, with mill test certificates per heat, tax-registered invoicing and 30-day credit. Ittehad's lower headline rate cannot be accepted for structural reinforcement.",
      nonLowestJustification:
        "Ittehad Steel Traders quoted a lower gross but as a non-filer trader supplying mixed-mill stock without per-heat mill certificates. Structural reinforcement for a raft foundation requires certified single-mill supply; the trader offer is technically non-compliant for this application. Steel Line is the lowest compliant quotation on a delivered, tax-inclusive basis.",
    },
    prisma,
  );

  const kase = await createCpcCase(
    officer,
    {
      comparativeId: comparative.id,
      recommendation:
        "Award 100 ton Grade 60 deformed bar to Steel Line Trading at the negotiated delivered rate. Certified single-mill supply with per-heat MTCs and 30-day credit.",
      riskNotes:
        "Steel prices are volatile; the quotation is valid for 7 days. Delivery is phased and must be weighbridge-verified on site. Trader alternative rejected on technical compliance grounds — justification recorded.",
    },
    prisma,
  );
  await voteCpc(
    kase.id,
    "APPROVE",
    "Approved. The technical rejection of the trader offer is sound and the negotiation is documented against the market rate.",
  );

  const po = await createPoFromCase(
    officer,
    {
      prId: pr.id,
      deliveryStoreId: storeId["ST-OPL"],
      deliveryDate: FUTURE(-3),
      paymentTerms: "30 days from invoice",
      creditDays: 30,
      advanceRequired: true,
      advancePercent: 25,
      collateralType: "SECURITY_CHEQUE",
      collateralRef: "UBL CHQ 4471209 dated for the advance amount",
      collateralNotes: "Security cheque held by ZD Finance against the advance until full delivery is settled.",
      termsConditions:
        "1. Phased delivery to Opal Mall Site Store. 2. Mill test certificate required with each consignment. 3. Weight verified at the site weighbridge; short weight adjusted on invoice. 4. Material subject to QC inspection before GRN. 5. Advance of 25% released against a security cheque of equal value.",
    },
    prisma,
  );
  await submitPoForApproval(officer, po.id, prisma);
  await approvePoChain(po.id, "ZD", [
    "Approved — CPC cleared and the advance is covered by a security cheque.",
    "Approved for issue.",
    "Advance and collateral arrangement confirmed by finance.",
  ]);
  await issuePo(director, po.id, prisma);
  await recordSavingsForPo(systemActor("SEED"), po.id, prisma);
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { advanceStatus: "PAID" } });

  // ── Short delivery: 90 of 100 ton ──
  const poItems = await prisma.purchaseOrderItem.findMany({ where: { poId: po.id }, orderBy: { lineNo: "asc" } });
  const gp = await createGatePass(
    security,
    {
      poId: po.id,
      storeId: storeId["ST-OPL"],
      vehicleNumber: "TLB-9931 / TLC-2210 (2 trailers)",
      vehicleType: "22-wheeler trailer",
      driverName: "Muhammad Sadiq",
      driverCnic: "35201-9988776-1",
      driverPhone: "+92 333 7712004",
      deliveryNoteRef: "SL/DC/26/3390",
      materialSummary: "Grade 60 deformed bar — 16mm and 12mm bundles",
      declaredQuantity: 90,
      declaredPackages: 180,
      securityRemarks: "Two trailers weighed in at the site weighbridge. Weighbridge slips attached to the challan.",
    },
    prisma,
  );

  const { delivery } = await recordDelivery(
    siteStore,
    {
      poId: po.id,
      gatePassId: gp.id,
      storeId: storeId["ST-OPL"],
      deliveryNoteRef: "SL/DC/26/3390",
      totalPackages: 180,
      packagesVerified: 180,
      packagingCondition: "Bundled with mill tags intact",
      physicalCondition: "Light surface rust consistent with transit; within acceptable limits",
      weightRecorded: 90,
      weightUnit: "TON",
      documentationComplete: true,
      remarks:
        "Weighbridge confirms 90 ton against 100 ton ordered. Vendor advised the balance 10 ton of 12mm will follow within 5 days from the next rolling. Mill test certificates received for both heats delivered.",
      items: [
        {
          poItemId: poItems[0].id,
          actualQty: 60,
          acceptedQty: 60,
          packages: 120,
          batchNumber: "HEAT-A615-26-3341",
          specificationMatch: true,
          conditionNotes: "16mm — full quantity received, mill tags and MTC verified.",
          discrepancyType: "OK",
        },
        {
          poItemId: poItems[1].id,
          actualQty: 30,
          acceptedQty: 30,
          packages: 60,
          batchNumber: "HEAT-A615-26-3358",
          specificationMatch: true,
          conditionNotes: "12mm — 30 ton received against 40 ton ordered.",
          discrepancyType: "SHORT_DELIVERY",
          discrepancyNotes:
            "10 ton of 12mm short. Vendor commits to the balance within 5 days from the next rolling. Purchase order to remain partially open.",
        },
      ],
    },
    prisma,
  );

  const inspection = await prisma.inspection.findFirst({
    where: { deliveryId: delivery.id },
    orderBy: { createdAt: "desc" },
  });
  if (inspection) {
    const iItems = await prisma.inspectionItem.findMany({ where: { inspectionId: inspection.id }, orderBy: { lineNo: "asc" } });
    const template = INSPECTION_TEMPLATES[1];
    await recordInspection(
      qc,
      {
        inspectionId: inspection.id,
        result: "APPROVED",
        findings:
          "Both heats verified against mill test certificates. Rib pattern, diameter and unit weight within tolerance. Surface rust superficial and acceptable per specification. Weighbridge slips reconcile with the delivered quantity of 90 ton.",
        signedByName: "Zeeshan Qadir — Civil QC Engineer",
        items: iItems.map((it, idx) => ({
          inspectionItemId: it.id,
          quantityPassed: it.quantityInspected,
          quantityFailed: 0,
          specVerified: idx === 0 ? "16mm, Grade 60, ASTM A615" : "12mm, Grade 60, ASTM A615",
          condition: "Acceptable",
          performanceNotes: "Diameter and unit weight verified on three random samples per bundle group.",
          verdict: "PASS" as const,
          criteriaResults: template.criteria.map((c) => ({
            key: c.key,
            label: c.label,
            value:
              c.kind === "boolean"
                ? true
                : c.key === "grade"
                  ? "ASTM A615 Grade 60"
                  : c.key === "diameter"
                    ? idx === 0
                      ? "16mm verified"
                      : "12mm verified"
                    : c.key === "surface"
                      ? "Acceptable"
                      : c.key === "batch"
                        ? idx === 0
                          ? "HEAT-A615-26-3341"
                          : "HEAT-A615-26-3358"
                        : "Verified",
          })),
        })),
      },
      prisma,
    );
  }

  const dItems = await prisma.deliveryItem.findMany({ where: { deliveryId: delivery.id }, orderBy: { lineNo: "asc" } });
  const grn = await createGrn(
    siteStore,
    {
      deliveryId: delivery.id,
      remarks:
        "GRN raised for the 90 ton actually received and QC-cleared. 10 ton of 12mm remains outstanding on the purchase order.",
      items: [
        {
          deliveryItemId: dItems[0].id,
          acceptedQty: 60,
          batchNumber: "HEAT-A615-26-3341",
          storeLocationId: locationId["ST-OPL:YARD-A"],
          disposition: "PROJECT_MATERIAL",
        },
        {
          deliveryItemId: dItems[1].id,
          acceptedQty: 30,
          batchNumber: "HEAT-A615-26-3358",
          storeLocationId: locationId["ST-OPL:YARD-B"],
          disposition: "PROJECT_MATERIAL",
          remarks: "Short by 10 ton against the ordered quantity.",
        },
      ],
      post: true,
    },
    prisma,
  );

  await recordStacking(
    siteStore,
    {
      grnId: grn.id,
      storeId: storeId["ST-OPL"],
      entries: [
        {
          itemId: itemId["CST-STL-0001"],
          description: "Grade 60 deformed bar 16mm — heat 3341",
          quantity: 60,
          unit: "TON",
          locationId: locationId["ST-OPL:YARD-A"],
          stackingMethod: "BULK",
          goodsClass: "PROJECT_MATERIAL",
          handlingRequirements: "Stacked on timber dunnage clear of standing water. Mill tags to remain attached until cutting.",
        },
        {
          itemId: itemId["CST-STL-0002"],
          description: "Grade 60 deformed bar 12mm — heat 3358",
          quantity: 30,
          unit: "TON",
          locationId: locationId["ST-OPL:YARD-B"],
          stackingMethod: "BULK",
          goodsClass: "PROJECT_MATERIAL",
          handlingRequirements: "Segregated by diameter and heat number for traceability.",
        },
      ],
    },
    prisma,
  );

  // ── Invoice billed for the full 100 ton against 90 accepted ──
  const invoice = await registerInvoice(
    officer,
    {
      poId: po.id,
      vendorInvoiceNumber: "SL/INV/26/5580",
      invoiceDate: D(1),
      items: [
        {
          poItemId: poItems[0].id,
          description: "Grade 60 deformed bar 16mm — 60 ton",
          quantity: 60,
          unit: "TON",
          unitPrice: poItems[0].unitPrice,
          taxRate: 18,
        },
        {
          poItemId: poItems[1].id,
          description: "Grade 60 deformed bar 12mm — 40 ton",
          quantity: 40,
          unit: "TON",
          unitPrice: poItems[1].unitPrice,
          taxRate: 18,
        },
      ],
    },
    prisma,
  );
  if (invoice) await verifyInvoice(officer, invoice.id, prisma);

  await backdateCase(pr.number, 12);
  log(
    "Flow B",
    `${pr.number} steel MD — 90 of 100 ton received, discrepancy raised, PO partially open, invoice for 100 ton flagged as mismatch`,
  );
  return { prNumber: pr.number, poId: po.id, invoiceId: invoice?.id ?? null };
}

// ─────────────────────────────────────────────────────────────
// Flow C — ZM monthly office supplies: routine, no CPC, paid
// ─────────────────────────────────────────────────────────────
async function flowOfficeSupplies() {
  const requester = U("rabia.noor@zameen.com");
  const officer = U("usman.tariq@zameen.com");
  const receiver = U("waqas.ali@zameen.com");
  const storeMgr = U("shakeel.ahmad@zameen.com");
  const security = U("gate.security@zameen.com");
  const director = U("kamran.rasheed@zameen.com");
  const finance = U("imran.shafiq@zameen.com");

  const pr = await createPr(
    requester,
    {
      entityId: entityId.ZM,
      departmentId: departmentId["ZM:ADMIN"],
      procurementType: "MONTHLY_RECURRING",
      title: "Monthly office supplies & pantry replenishment — Zameen Tower",
      justification: "Routine monthly replenishment against consumption and reorder levels.",
      costCenter: "ZM-CC-100",
      deliveryStoreId: storeId["ST-ZM-HO"],
      requiredDate: FUTURE(7),
      priority: "NORMAL",
      budgetAmount: 500_000,
      budgetCode: "ZM-OPEX-ADM-2026",
      items: [
        { itemId: itemId["OFF-PAP-0001"], categoryId: categoryId["OFF-SUPPLY"], description: "A4 copier paper 80gsm", specification: "A4, 80gsm, 500 sheets per ream, Double A or equivalent", quantity: 150, unit: "REAM", estimatedUnitPrice: 1320, disposition: "INVENTORY" },
        { itemId: itemId["OFF-PEN-0001"], categoryId: categoryId["OFF-SUPPLY"], description: "Ball point pen — blue", specification: "Box of 50, blue ink, 0.7mm, Piano or equivalent", quantity: 40, unit: "BOX", estimatedUnitPrice: 850, disposition: "INVENTORY" },
        { itemId: itemId["OFF-FIL-0001"], categoryId: categoryId["OFF-SUPPLY"], description: "Box file — foolscap", specification: "Board box file with lever arch mechanism, foolscap size", quantity: 80, unit: "EA", estimatedUnitPrice: 420, disposition: "INVENTORY" },
        { itemId: itemId["PAN-TEA-0001"], categoryId: categoryId["PANTRY"], description: "Tea bags — 100s", specification: "Lipton yellow label, 100 bags per box", quantity: 50, unit: "BOX", estimatedUnitPrice: 1150, disposition: "CONSUMABLE" },
      ],
    },
    prisma,
  );
  await submitPr(requester, pr.id, prisma);
  await approvePrChain(pr.id, { departmentKey: "ZM:ADMIN", entity: "ZM" }, [
    "Approved — routine monthly replenishment within the operating budget.",
  ]);
  await startSourcing(officer, pr.id, prisma);

  const rfq = await createRfq(
    officer,
    {
      prId: pr.id,
      title: "RFQ — Monthly office supplies & pantry (Zameen Tower)",
      scope: "Supply of stationery and pantry items per the attached schedule, delivered to the head office store.",
      terms: "Rates inclusive of tax and delivery. Payment on 30-day terms. Rates to hold for the calendar quarter.",
      responseDeadline: FUTURE(1),
      vendorIds: [vendorId["Al-Noor Stationers"], vendorId["Paper Plus Supplies"]],
    },
    prisma,
  );
  await issueRfq(officer, rfq.id, prisma);

  const prItems = await prisma.purchaseRequisitionItem.findMany({ where: { prId: pr.id }, orderBy: { lineNo: "asc" } });

  await upsertQuote(
    officer,
    {
      rfqId: rfq.id,
      vendorId: vendorId["Al-Noor Stationers"],
      quoteRef: "ANS/26/0902",
      validUntil: FUTURE(60),
      deliveryDays: 3,
      paymentTerms: "30 days",
      creditDays: 30,
      technicalCompliance: "COMPLIANT",
      channel: "EMAIL",
      items: [
        { prItemId: prItems[0].id, itemId: itemId["OFF-PAP-0001"], description: "A4 copier paper 80gsm", quantity: 150, unit: "REAM", unitPrice: 1295, taxRate: 18, compliance: "COMPLIANT" },
        { prItemId: prItems[1].id, itemId: itemId["OFF-PEN-0001"], description: "Ball point pen blue (box of 50)", quantity: 40, unit: "BOX", unitPrice: 810, taxRate: 18, compliance: "COMPLIANT" },
        { prItemId: prItems[2].id, itemId: itemId["OFF-FIL-0001"], description: "Box file foolscap", quantity: 80, unit: "EA", unitPrice: 398, taxRate: 18, compliance: "COMPLIANT" },
        { prItemId: prItems[3].id, itemId: itemId["PAN-TEA-0001"], description: "Tea bags 100s", quantity: 50, unit: "BOX", unitPrice: 1120, taxRate: 18, compliance: "COMPLIANT" },
      ],
    },
    prisma,
  );
  await upsertQuote(
    officer,
    {
      rfqId: rfq.id,
      vendorId: vendorId["Paper Plus Supplies"],
      quoteRef: "PPS-26-0455",
      validUntil: FUTURE(30),
      deliveryCharges: 4500,
      deliveryDays: 2,
      paymentTerms: "15 days",
      creditDays: 15,
      technicalCompliance: "COMPLIANT",
      channel: "EMAIL",
      items: [
        { prItemId: prItems[0].id, itemId: itemId["OFF-PAP-0001"], description: "A4 copier paper 80gsm", quantity: 150, unit: "REAM", unitPrice: 1310, taxRate: 18, compliance: "COMPLIANT" },
        { prItemId: prItems[1].id, itemId: itemId["OFF-PEN-0001"], description: "Ball point pen blue (box of 50)", quantity: 40, unit: "BOX", unitPrice: 835, taxRate: 18, compliance: "COMPLIANT" },
        { prItemId: prItems[2].id, itemId: itemId["OFF-FIL-0001"], description: "Box file foolscap", quantity: 80, unit: "EA", unitPrice: 415, taxRate: 18, compliance: "COMPLIANT" },
        { prItemId: prItems[3].id, itemId: itemId["PAN-TEA-0001"], description: "Tea bags 100s", quantity: 50, unit: "BOX", unitPrice: 1145, taxRate: 18, compliance: "COMPLIANT" },
      ],
    },
    prisma,
  );

  const comparative = await buildComparative(
    officer,
    {
      rfqId: rfq.id,
      notes:
        "Two quotations for a routine monthly basket below the three-quotation waiver value. Al-Noor is lowest on every line and delivers without a freight charge.",
    },
    prisma,
  );
  const anQuote = await prisma.vendorQuote.findFirstOrThrow({
    where: { rfqId: rfq.id, vendorId: vendorId["Al-Noor Stationers"] },
  });
  await recommendVendor(
    officer,
    {
      comparativeId: comparative.id,
      quoteId: anQuote.id,
      basis: "Lowest compliant quotation on every line, no delivery charge, and rates held for the quarter.",
    },
    prisma,
  );
  await closeRfq(officer, rfq.id, prisma);

  const po = await createPoFromCase(
    officer,
    {
      prId: pr.id,
      deliveryStoreId: storeId["ST-ZM-HO"],
      deliveryDate: FUTURE(3),
      paymentTerms: "30 days from invoice",
      creditDays: 30,
      termsConditions: "Rates held for the calendar quarter. Delivery to the head office store during working hours.",
    },
    prisma,
  );
  await submitPoForApproval(officer, po.id, prisma);
  await approvePoChain(po.id, "ZM", ["Approved — routine monthly replenishment."]);
  await issuePo(U("asim.javed@zameen.com"), po.id, prisma);
  await recordSavingsForPo(systemActor("SEED"), po.id, prisma);

  const poItems = await prisma.purchaseOrderItem.findMany({ where: { poId: po.id }, orderBy: { lineNo: "asc" } });
  const gp = await createGatePass(
    security,
    {
      poId: po.id,
      storeId: storeId["ST-ZM-HO"],
      vehicleNumber: "LES-8802",
      vehicleType: "Suzuki Ravi",
      driverName: "Akhtar Ali",
      driverPhone: "+92 300 4412119",
      deliveryNoteRef: "ANS/DC/26/1180",
      materialSummary: "Stationery and pantry cartons",
      declaredPackages: 22,
      securityRemarks: "Cartons checked at gate against the challan.",
    },
    prisma,
  );

  const { delivery } = await recordDelivery(
    receiver,
    {
      poId: po.id,
      gatePassId: gp.id,
      storeId: storeId["ST-ZM-HO"],
      deliveryNoteRef: "ANS/DC/26/1180",
      totalPackages: 22,
      packagesVerified: 22,
      packagingCondition: "Sealed cartons",
      physicalCondition: "Good",
      documentationComplete: true,
      remarks: "Full quantity received and counted against the challan.",
      items: poItems.map((pi) => ({
        poItemId: pi.id,
        actualQty: pi.quantity,
        acceptedQty: pi.quantity,
        specificationMatch: true,
        discrepancyType: "OK" as const,
      })),
    },
    prisma,
  );

  const dItems = await prisma.deliveryItem.findMany({ where: { deliveryId: delivery.id }, orderBy: { lineNo: "asc" } });
  await createGrn(
    storeMgr,
    {
      deliveryId: delivery.id,
      remarks: "Full receipt posted to the head office store.",
      items: dItems.map((di, idx) => ({
        deliveryItemId: di.id,
        acceptedQty: di.acceptedQty,
        storeLocationId: idx === 3 ? locationId["ST-ZM-HO:PNT-01"] : locationId["ST-ZM-HO:STA-01"],
      })),
      post: true,
    },
    prisma,
  );

  const invoice = await registerInvoice(
    officer,
    {
      poId: po.id,
      vendorInvoiceNumber: "ANS/INV/26/2233",
      invoiceDate: D(4),
      items: poItems.map((pi) => ({
        poItemId: pi.id,
        description: pi.description,
        quantity: pi.quantity,
        unit: pi.unit,
        unitPrice: pi.unitPrice,
        taxRate: pi.taxRate,
      })),
    },
    prisma,
  );
  if (invoice) {
    await verifyInvoice(officer, invoice.id, prisma);
    await submitInvoiceForApproval(officer, invoice.id, prisma);
    await approveInvoiceChain(invoice.id, "ZM", ["Match passed. Approved."]);
    const handoff = await handoffToFinance(director, invoice.id, "Routine monthly supply, fully received and matched.", prisma);
    await acknowledgeHandoff(finance, handoff.id, { paymentMethod: "BANK_TRANSFER", scheduledDate: D(2) }, prisma);
    await recordPayment(finance, handoff.id, { paymentReference: "HBL-FT-2026-880114", paidDate: D(2), paymentMethod: "BANK_TRANSFER" }, prisma);
  }

  await backdateCase(pr.number, 20);
  log("Flow C", `${pr.number} office supplies — routine monthly cycle completed and paid`);
  return { prNumber: pr.number };
}

// ─────────────────────────────────────────────────────────────
// Flow D — ZM air conditioners: seasonal timing + negotiation savings
// ─────────────────────────────────────────────────────────────
async function flowAirConditioners() {
  const requester = U("tahir.abbas@zameen.com");
  const officer = U("hira.aslam@zameen.com");
  const receiver = U("waqas.ali@zameen.com");
  const storeMgr = U("shakeel.ahmad@zameen.com");
  const security = U("gate.security@zameen.com");
  const inspector = U("sana.iqbal@zameen.com");
  const director = U("kamran.rasheed@zameen.com");
  const finance = U("imran.shafiq@zameen.com");

  const pr = await createPr(
    requester,
    {
      entityId: entityId.ZM,
      departmentId: departmentId["ZM:ADMIN"],
      procurementType: "ON_DEMAND",
      title: "Air conditioning replacement — 3rd & 4th floor (8 units, 1.5 ton inverter)",
      justification:
        "Eight non-inverter units on the 3rd and 4th floors are 9 years old, failing repeatedly and drawing excessive load. Procuring ahead of the summer season to avoid peak-season pricing and installation backlog.",
      costCenter: "ZM-CC-100",
      deliveryStoreId: storeId["ST-ZM-HO"],
      requiredDate: FUTURE(20),
      priority: "NORMAL",
      budgetAmount: 1_700_000,
      budgetCode: "ZM-CAPEX-ADM-2026",
      items: [
        {
          itemId: itemId["HVA-SPL-0001"],
          categoryId: categoryId.HVAC,
          description: "Split air conditioner 1.5 ton DC inverter (heat & cool)",
          brand: "Haier / Gree",
          model: "HSU-18HFCF or equivalent",
          specification:
            "1.5 ton DC inverter, T3 rated compressor, R410a, heat and cool, copper condenser, 10-year compressor warranty, 2-year parts, installation with copper piping included",
          quantity: 8,
          unit: "EA",
          estimatedUnitPrice: 192000,
          disposition: "ASSET",
        },
      ],
    },
    prisma,
  );
  await submitPr(requester, pr.id, prisma);
  await approvePrChain(pr.id, { departmentKey: "ZM:ADMIN", entity: "ZM" }, [
    "Approved. Replacing the failing units before summer is the right call operationally and commercially.",
    "Approved. Buying in the off-season should land below the summer market rate — capture the saving in the comparative.",
    "Approved for sourcing.",
  ]);
  await startSourcing(officer, pr.id, prisma);

  const rfq = await createRfq(
    officer,
    {
      prId: pr.id,
      title: "RFQ — 8 × 1.5 ton DC inverter split AC with installation",
      scope: "Supply, install and commission 8 × 1.5 ton DC inverter split units on the 3rd and 4th floors.",
      terms:
        "Rate to include unit, copper piping up to 12ft, installation, commissioning and removal of the old units. Warranty to be manufacturer-backed and registered.",
      deliveryRequirement: "Delivery and installation within 12 days of purchase order, outside office hours.",
      responseDeadline: FUTURE(2),
      vendorIds: [vendorId["Cool Air Engineering"], vendorId["Breeze Cooling Systems"], vendorId["Techno Solutions"]],
    },
    prisma,
  );
  await issueRfq(officer, rfq.id, prisma);

  const prItem = (await prisma.purchaseRequisitionItem.findFirstOrThrow({ where: { prId: pr.id } })).id;

  await upsertQuote(
    officer,
    {
      rfqId: rfq.id,
      vendorId: vendorId["Cool Air Engineering"],
      quoteRef: "CAE/QT/26/0771",
      validUntil: FUTURE(20),
      deliveryDays: 10,
      paymentTerms: "30 days from commissioning",
      creditDays: 30,
      warrantyMonths: 24,
      warrantyTerms: "2-year parts, 10-year compressor, manufacturer-registered. 1-year free service visits.",
      technicalCompliance: "COMPLIANT",
      complianceNotes: "Haier HSU-18HFCF quoted with full installation and old-unit removal.",
      channel: "EMAIL",
      items: [
        {
          prItemId: prItem,
          itemId: itemId["HVA-SPL-0001"],
          description: "Haier HSU-18HFCF 1.5 ton DC inverter, supplied and installed",
          brand: "Haier",
          model: "HSU-18HFCF",
          specification: "1.5 ton DC inverter, T3 compressor, R410a, installation and commissioning included",
          quantity: 8,
          unit: "EA",
          unitPrice: 174500,
          taxRate: 18,
          deliveryDays: 10,
          compliance: "COMPLIANT",
        },
      ],
    },
    prisma,
  );
  await upsertQuote(
    officer,
    {
      rfqId: rfq.id,
      vendorId: vendorId["Breeze Cooling Systems"],
      quoteRef: "BCS-26-0318",
      validUntil: FUTURE(10),
      deliveryCharges: 24000,
      deliveryDays: 8,
      paymentTerms: "Advance",
      creditDays: 0,
      warrantyMonths: 12,
      warrantyTerms: "1-year parts, 5-year compressor",
      technicalCompliance: "PARTIAL",
      complianceNotes:
        "Gree unit quoted but installation charged separately and compressor warranty is 5 years against the 10 required.",
      channel: "PHYSICAL",
      items: [
        {
          prItemId: prItem,
          itemId: itemId["HVA-SPL-0001"],
          description: "Gree GS-18PITH 1.5 ton inverter (unit only, installation extra)",
          brand: "Gree",
          model: "GS-18PITH11W",
          quantity: 8,
          unit: "EA",
          unitPrice: 169000,
          taxRate: 18,
          deliveryDays: 8,
          compliance: "PARTIAL",
          notes: "Installation quoted separately at PKR 9,500 per unit; warranty below requirement.",
        },
      ],
    },
    prisma,
  );
  await markVendorDeclined(
    officer,
    rfq.id,
    vendorId["Techno Solutions"],
    "Vendor declined — HVAC is outside their approved category and they do not undertake installation.",
    prisma,
  );

  const caeQuote = await prisma.vendorQuote.findFirstOrThrow({
    where: { rfqId: rfq.id, vendorId: vendorId["Cool Air Engineering"] },
  });
  await recordNegotiation(
    officer,
    {
      quoteId: caeQuote.id,
      negotiatedTotal: Math.round(caeQuote.total * 0.93),
      channel: "MEETING",
      notes:
        "Negotiated on off-season timing and an 8-unit single-site installation. Market rate in peak season for the same unit is PKR 198,000–205,000. Vendor reduced the delivered rate by 7% and added a second year of free service visits.",
      outcome: "ACCEPTED",
    },
    prisma,
  );

  const comparative = await buildComparative(
    officer,
    {
      rfqId: rfq.id,
      marketPrice: 8 * 201000 * 1.18,
      notes:
        "Breeze is lower on the unit but charges installation separately (adding PKR 9,500/unit) and offers only a 5-year compressor warranty, making it more expensive and non-compliant on a delivered, installed basis. Cool Air is compliant, installed, negotiated 7% down and well below the peak-season market rate.",
    },
    prisma,
  );
  await recommendVendor(
    officer,
    {
      comparativeId: comparative.id,
      quoteId: caeQuote.id,
      basis:
        "Lowest compliant delivered-and-installed cost. Meets the 10-year compressor warranty requirement, includes old-unit removal, and the off-season purchase captures a material saving against peak-season market rates.",
    },
    prisma,
  );

  // Value is above the ZM committee threshold, so the case goes to CPC.
  const acCase = await createCpcCase(
    officer,
    {
      comparativeId: comparative.id,
      recommendation:
        "Award 8 × 1.5 ton DC inverter units to Cool Air Engineering, supplied and installed, at the negotiated rate. 7% below quotation and roughly 13% below the peak-season market rate.",
      riskNotes:
        "Installation must be completed outside office hours. Warranty registration to be verified before the invoice is released. Old units to be handed to the store for the disposal process.",
    },
    prisma,
  );
  await voteCpc(
    acCase.id,
    "APPROVE",
    "Approved. Buying ahead of the season is the right commercial call and the saving against market rate is well evidenced.",
  );

  const po = await createPoFromCase(
    officer,
    {
      prId: pr.id,
      deliveryStoreId: storeId["ST-ZM-HO"],
      deliveryDate: FUTURE(8),
      paymentTerms: "30 days from commissioning",
      creditDays: 30,
      warrantyTerms: "2-year parts, 10-year compressor, manufacturer-registered",
      termsConditions:
        "1. Installation outside office hours. 2. Old units to be removed and handed to the store for disposal. 3. Warranty cards to be registered before invoice submission. 4. Commissioning certificate required per unit.",
    },
    prisma,
  );
  await submitPoForApproval(officer, po.id, prisma);
  await approvePoChain(po.id, "ZM", ["Approved.", "Approved for issue — good seasonal timing."]);
  await issuePo(director, po.id, prisma);
  await recordSavingsForPo(systemActor("SEED"), po.id, prisma);

  const poItems = await prisma.purchaseOrderItem.findMany({ where: { poId: po.id } });
  const gp = await createGatePass(
    security,
    {
      poId: po.id,
      storeId: storeId["ST-ZM-HO"],
      vehicleNumber: "LEB-1177",
      vehicleType: "Shehzore",
      driverName: "Nadeem Khan",
      deliveryNoteRef: "CAE/DC/26/0442",
      materialSummary: "8 split AC units (indoor + outdoor), piping and brackets",
      declaredQuantity: 8,
      declaredPackages: 24,
      securityRemarks: "Cartons and piping coils verified at gate.",
    },
    prisma,
  );
  const acSerials = Array.from({ length: 8 }, (_, i) => `HR18-26-${String(7710 + i)}`).join(", ");
  const { delivery, inspection } = await recordDelivery(
    receiver,
    {
      poId: po.id,
      gatePassId: gp.id,
      storeId: storeId["ST-ZM-HO"],
      deliveryNoteRef: "CAE/DC/26/0442",
      totalPackages: 24,
      packagesVerified: 24,
      packagingCondition: "Sealed factory cartons",
      physicalCondition: "New; one outdoor unit carton lightly scuffed with no unit damage",
      documentationComplete: true,
      remarks: "All 8 units received with warranty cards. Installation scheduled over the weekend.",
      items: [
        {
          poItemId: poItems[0].id,
          actualQty: 8,
          acceptedQty: 8,
          packages: 24,
          serialNumbers: acSerials,
          warrantyMonths: 24,
          specificationMatch: true,
          conditionNotes: "Model and rating verified against the purchase order on every unit.",
          discrepancyType: "OK",
        },
      ],
    },
    prisma,
  );

  if (inspection) {
    const iItems = await prisma.inspectionItem.findMany({ where: { inspectionId: inspection.id } });
    await recordInspection(
      inspector,
      {
        inspectionId: inspection.id,
        result: "APPROVED",
        findings:
          "All 8 units installed, gas pressure checked and commissioned. Cooling verified at the thermostat. Warranty cards registered with the manufacturer against Zameen Media. Old units removed and handed to the store.",
        signedByName: "Sana Iqbal — IT Infrastructure Engineer (facilities inspection)",
        items: iItems.map((it) => ({
          inspectionItemId: it.id,
          quantityPassed: 8,
          quantityFailed: 0,
          modelVerified: "Haier HSU-18HFCF",
          specVerified: "1.5 ton DC inverter, T3, R410a",
          condition: "New",
          performanceNotes: "Delta-T verified within specification on all units after commissioning.",
          accessoriesComplete: true,
          verdict: "PASS" as const,
        })),
      },
      prisma,
    );
  }

  const dItems = await prisma.deliveryItem.findMany({ where: { deliveryId: delivery.id } });
  await createGrn(
    storeMgr,
    {
      deliveryId: delivery.id,
      remarks: "Commissioned and accepted. Units tagged as assets against the 3rd and 4th floors.",
      items: [
        {
          deliveryItemId: dItems[0].id,
          acceptedQty: 8,
          serialNumbers: acSerials,
          warrantyMonths: 24,
          storeLocationId: locationId["ST-ZM-HO:STA-02"],
          disposition: "ASSET",
        },
      ],
      post: true,
    },
    prisma,
  );

  const invoice = await registerInvoice(
    officer,
    {
      poId: po.id,
      vendorInvoiceNumber: "CAE/INV/26/1109",
      invoiceDate: D(6),
      items: [
        {
          poItemId: poItems[0].id,
          description: "Haier HSU-18HFCF 1.5 ton inverter — supplied, installed and commissioned (8 units)",
          quantity: 8,
          unit: "EA",
          unitPrice: poItems[0].unitPrice,
          taxRate: 18,
        },
      ],
    },
    prisma,
  );
  if (invoice) {
    await verifyInvoice(officer, invoice.id, prisma);
    await submitInvoiceForApproval(officer, invoice.id, prisma);
    await approveInvoiceChain(invoice.id, "ZM", ["Match passed and commissioning certificates received.", "Approved."]);
    const handoff = await handoffToFinance(director, invoice.id, "Installed, commissioned, inspected and matched.", prisma);
    await acknowledgeHandoff(finance, handoff.id, { paymentMethod: "CHEQUE", scheduledDate: FUTURE(4) }, prisma);
  }

  await backdateCase(pr.number, 55);
  log("Flow D", `${pr.number} air conditioners — negotiated 7% below quote and well under peak-season market rate`);
}

// ─────────────────────────────────────────────────────────────
// Flow E — ZD fit-out MD awaiting CPC decision
// ─────────────────────────────────────────────────────────────
async function flowFitoutAwaitingCpc() {
  const pm = U("raza.hussain@zameen.com");
  const officer = U("saad.mirza@zameen.com");

  const pr = await createPr(
    pm,
    {
      entityId: entityId.ZD,
      departmentId: departmentId["ZD:PROJ"],
      procurementType: "MATERIAL_DEMAND",
      title: "MD — Porcelain floor tiles & gypsum board for Park View Tower lobby fit-out",
      justification:
        "Lobby and lift-lobby finishes for floors 1–4 per the approved interior package. Quantities taken off BOQ item 09.04 with 5% wastage allowance.",
      projectId: projectId["ZD-PRK"],
      siteId: siteId["SITE-PRK"],
      costCenter: "ZD-CC-200",
      deliveryStoreId: storeId["ST-PRK"],
      requiredDate: FUTURE(25),
      priority: "HIGH",
      budgetAmount: 9_500_000,
      budgetCode: "ZD-PRK-FITOUT-2026",
      pmOwnerId: pm.id,
      boqReference: "BOQ-PRK-09.04 (Rev B)",
      drawingReference: "IN-401 to IN-408 (Rev C), finishes schedule FS-02",
      technicalNotes:
        "Rectified porcelain, PEI IV minimum, shade to match approved sample board PRK-SB-07. Gypsum board to be moisture-resistant in wet areas.",
      items: [
        {
          itemId: itemId["FIT-TIL-0001"],
          categoryId: categoryId.FITOUT,
          description: "Porcelain floor tile 600x600 rectified, matte",
          brand: "Master Tiles",
          specification: "600x600mm rectified porcelain, matte, PEI IV, shade per approved sample PRK-SB-07",
          quantity: 18000,
          unit: "SQFT",
          estimatedUnitPrice: 385,
          disposition: "PROJECT_MATERIAL",
        },
        {
          itemId: itemId["FIT-GYP-0001"],
          categoryId: categoryId.FITOUT,
          description: "Gypsum board 12.5mm",
          brand: "Knauf",
          specification: "12.5mm x 1200 x 2400mm, regular and moisture-resistant as scheduled",
          quantity: 900,
          unit: "SHEET",
          estimatedUnitPrice: 2450,
          disposition: "PROJECT_MATERIAL",
        },
      ],
    },
    prisma,
  );
  await attachMdDocuments({
    prId: pr.id,
    prNumber: pr.number,
    entity: "ZD",
    uploaderId: pm.id,
    designerId: U("sadia.rehman@zameen.com").id,
    boqName: "BOQ-PRK-09.04 Rev B — Lobby finishes take-off",
    boqFile: "BOQ-PRK-0904-RevB.xlsx",
    drawingName: "IN-401 to IN-408 Rev C — Lobby finishes drawings & FS-02",
    drawingFile: "IN-401-IN-408-RevC.pdf",
  });
  await submitPr(pm, pr.id, prisma);
  await approvePrChain(pr.id, { departmentKey: "ZD:PROJ", entity: "ZD" }, [
    "Quantities and shade selection validated against the approved sample board.",
    "Supply chain reviewed. Three vendors invited.",
    "Approved — route through CPC after the comparative.",
  ]);
  await startSourcing(officer, pr.id, prisma);

  const rfq = await createRfq(
    officer,
    {
      prId: pr.id,
      title: "RFQ — Porcelain tiles & gypsum board (Park View lobby fit-out)",
      scope: "Supply and delivery of porcelain floor tile and gypsum board to Park View Tower site store.",
      terms: "Rates inclusive of tax and delivery. Shade lot to be consistent across the full quantity.",
      responseDeadline: FUTURE(2),
      vendorIds: [vendorId["Bright Build Materials"], vendorId["Interwood Mobel"], vendorId["Prime Electricals"]],
    },
    prisma,
  );
  await issueRfq(officer, rfq.id, prisma);

  const prItems = await prisma.purchaseRequisitionItem.findMany({ where: { prId: pr.id }, orderBy: { lineNo: "asc" } });

  await upsertQuote(
    officer,
    {
      rfqId: rfq.id,
      vendorId: vendorId["Bright Build Materials"],
      quoteRef: "BBM/26/0771",
      validUntil: FUTURE(14),
      deliveryDays: 12,
      paymentTerms: "21 days",
      creditDays: 21,
      technicalCompliance: "COMPLIANT",
      complianceNotes: "Single shade lot confirmed for the full 18,000 sqft. Sample approved against PRK-SB-07.",
      channel: "EMAIL",
      items: [
        { prItemId: prItems[0].id, itemId: itemId["FIT-TIL-0001"], description: "Porcelain floor tile 600x600 rectified matte", quantity: 18000, unit: "SQFT", unitPrice: 371, taxRate: 18, deliveryDays: 12, compliance: "COMPLIANT" },
        { prItemId: prItems[1].id, itemId: itemId["FIT-GYP-0001"], description: "Gypsum board 12.5mm", quantity: 900, unit: "SHEET", unitPrice: 2385, taxRate: 18, deliveryDays: 12, compliance: "COMPLIANT" },
      ],
    },
    prisma,
  );
  await upsertQuote(
    officer,
    {
      rfqId: rfq.id,
      vendorId: vendorId["Interwood Mobel"],
      quoteRef: "IW/PRJ/26/2204",
      validUntil: FUTURE(21),
      deliveryDays: 18,
      paymentTerms: "50% advance, 50% on delivery",
      creditDays: 0,
      technicalCompliance: "COMPLIANT",
      complianceNotes: "Imported equivalent offered; longer lead time but a tighter shade tolerance.",
      channel: "EMAIL",
      items: [
        { prItemId: prItems[0].id, itemId: itemId["FIT-TIL-0001"], description: "Imported rectified porcelain 600x600", quantity: 18000, unit: "SQFT", unitPrice: 398, taxRate: 18, deliveryDays: 18, compliance: "COMPLIANT" },
        { prItemId: prItems[1].id, itemId: itemId["FIT-GYP-0001"], description: "Knauf gypsum board 12.5mm", quantity: 900, unit: "SHEET", unitPrice: 2410, taxRate: 18, deliveryDays: 18, compliance: "COMPLIANT" },
      ],
    },
    prisma,
  );
  await upsertQuote(
    officer,
    {
      rfqId: rfq.id,
      vendorId: vendorId["Prime Electricals"],
      quoteRef: "PE/26/0918",
      validUntil: FUTURE(10),
      deliveryCharges: 85000,
      deliveryDays: 14,
      paymentTerms: "30 days",
      creditDays: 30,
      technicalCompliance: "PARTIAL",
      complianceNotes: "Can supply gypsum board only; tiles sub-contracted with no shade-lot guarantee.",
      channel: "EMAIL",
      items: [
        { prItemId: prItems[0].id, itemId: itemId["FIT-TIL-0001"], description: "Porcelain tile 600x600 (sub-supplied)", quantity: 18000, unit: "SQFT", unitPrice: 364, taxRate: 18, deliveryDays: 14, compliance: "NON_COMPLIANT", notes: "No single shade-lot guarantee." },
        { prItemId: prItems[1].id, itemId: itemId["FIT-GYP-0001"], description: "Gypsum board 12.5mm", quantity: 900, unit: "SHEET", unitPrice: 2350, taxRate: 18, deliveryDays: 14, compliance: "COMPLIANT" },
      ],
    },
    prisma,
  );

  const bbmQuote = await prisma.vendorQuote.findFirstOrThrow({
    where: { rfqId: rfq.id, vendorId: vendorId["Bright Build Materials"] },
  });
  await recordNegotiation(
    officer,
    {
      quoteId: bbmQuote.id,
      negotiatedTotal: Math.round(bbmQuote.total * 0.968),
      channel: "CALL",
      notes: "Negotiated 3.2% on the combined lot in exchange for a single consolidated delivery and 21-day settlement.",
      outcome: "ACCEPTED",
    },
    prisma,
  );

  const comparative = await buildComparative(
    officer,
    {
      rfqId: rfq.id,
      marketPrice: 18000 * 392 * 1.18 + 900 * 2470 * 1.18,
      notes:
        "Prime Electricals is lowest on tiles but cannot guarantee a single shade lot — unacceptable for a lobby floor. Interwood is compliant with a tighter tolerance but 18-day lead time and advance terms. Bright Build is compliant, negotiated and fits the programme.",
    },
    prisma,
  );
  await recommendVendor(
    officer,
    {
      comparativeId: comparative.id,
      quoteId: bbmQuote.id,
      basis:
        "Lowest compliant quotation after negotiation, single shade lot guaranteed for the full quantity, and a 12-day lead time that fits the fit-out programme.",
    },
    prisma,
  );

  const kase = await createCpcCase(
    officer,
    {
      comparativeId: comparative.id,
      recommendation:
        "Award the combined tile and gypsum lot to Bright Build Materials at the negotiated rate. Single shade lot, 12-day delivery, 21-day credit.",
      riskNotes:
        "Shade consistency is the principal risk on a lobby floor. Vendor has committed to a single production lot; QC to verify shade against the approved sample board on delivery.",
    },
    prisma,
  );
  void kase;

  log("Flow E", `${pr.number} fit-out MD — comparative complete, awaiting CPC decision`);
}

// ─────────────────────────────────────────────────────────────
// Flow F/G — requisitions in early states
// ─────────────────────────────────────────────────────────────
async function flowEarlyStagePrs() {
  const marketing = U("mehwish.khan@zameen.com");
  const itUser = U("sana.iqbal@zameen.com");
  const officer = U("hira.aslam@zameen.com");
  const qs = U("arsalan.baig@zameen.com");
  const hodIt = U("bilal.hameed@zameen.com");

  // F — awaiting department approval
  const printerPr = await createPr(
    itUser,
    {
      entityId: entityId.ZM,
      departmentId: departmentId["ZM:IT"],
      procurementType: "ON_DEMAND",
      title: "A3 multifunction printer for the 2nd floor print room",
      justification:
        "The existing A3 device is beyond economical repair (three board failures in six months) and the floor currently has no A3 capability, forcing outsourced printing.",
      costCenter: "ZM-CC-110",
      deliveryStoreId: storeId["ST-ZM-IT"],
      requiredDate: FUTURE(18),
      priority: "NORMAL",
      budgetAmount: 550_000,
      budgetCode: "ZM-CAPEX-IT-2026",
      items: [
        {
          itemId: itemId["IT-PRN-0001"],
          categoryId: categoryId["IT-EQUIP"],
          description: "A3 mono multifunction laser printer",
          brand: "Canon",
          model: "imageRUNNER 2630i",
          specification:
            "A3 mono MFP, minimum 30ppm, automatic duplex, network printing and scanning, 100-sheet ADF, 1-year onsite warranty, starter toner included",
          quantity: 1,
          unit: "EA",
          estimatedUnitPrice: 465000,
          disposition: "ASSET",
        },
      ],
    },
    prisma,
  );
  await submitPr(itUser, printerPr.id, prisma);

  // G — returned to the requester for an incomplete specification
  const marketingPr = await createPr(
    marketing,
    {
      entityId: entityId.ZM,
      departmentId: departmentId["ZM:MKT"],
      procurementType: "ON_DEMAND",
      title: "Exhibition standees and brochures for the spring property expo",
      justification:
        "Marketing collateral for the three-day spring expo. Required on stand before setup day.",
      costCenter: "ZM-CC-120",
      deliveryStoreId: storeId["ST-ZM-HO"],
      requiredDate: FUTURE(11),
      priority: "HIGH",
      budgetAmount: 900_000,
      budgetCode: "ZM-OPEX-MKT-2026",
      items: [
        {
          itemId: itemId["MKT-STD-0001"],
          categoryId: categoryId["MKT-MAT"],
          description: "Roll-up exhibition standee 3x6ft",
          specification: "Roll-up standee, 3x6ft, aluminium base, printed one side",
          quantity: 20,
          unit: "EA",
          estimatedUnitPrice: 12500,
          disposition: "EXPENSE",
        },
        {
          itemId: itemId["MKT-BRO-0001"],
          categoryId: categoryId["MKT-MAT"],
          description: "Project brochure — 12pp A4",
          specification: "12 page A4, 170gsm art paper, matt lamination, saddle stitched",
          quantity: 2000,
          unit: "EA",
          estimatedUnitPrice: 285,
          disposition: "EXPENSE",
        },
      ],
    },
    prisma,
  );
  await submitPr(marketing, marketingPr.id, prisma);
  await decidePr(
    U("adeel.rauf@zameen.com"),
    marketingPr.id,
    "RETURNED",
    "Returned: the artwork reference and finished-size schedule are missing, and the brochure line does not state whether the cover is a separate stock. Procurement cannot issue an RFQ without these. Please attach the approved artwork pack and resubmit.",
    prisma,
  );

  // A ZD requisition sitting in procurement review before sourcing
  const safetyPr = await createPr(
    qs,
    {
      entityId: entityId.ZD,
      departmentId: departmentId["ZD:QS"],
      procurementType: "ON_DEMAND",
      title: "Safety PPE replenishment — Opal Mall and Park View sites",
      justification:
        "Site headcount increased by 60 across both sites. Current PPE stock is below the mandated one-set-per-worker plus 10% buffer.",
      projectId: projectId["ZD-OPL"],
      siteId: siteId["SITE-OPL"],
      costCenter: "ZD-CC-260",
      deliveryStoreId: storeId["WH-MULTAN"],
      requiredDate: FUTURE(9),
      priority: "HIGH",
      budgetAmount: 400_000,
      budgetCode: "ZD-HSE-2026",
      items: [
        { itemId: itemId["SAF-HLM-0001"], categoryId: categoryId.SAFETY, description: "Safety helmet — industrial", specification: "ANSI Z89.1 Type I Class E, ratchet suspension, chin strap", quantity: 80, unit: "EA", estimatedUnitPrice: 2850, disposition: "INVENTORY" },
        { itemId: itemId["SAF-VST-0001"], categoryId: categoryId.SAFETY, description: "Hi-vis safety vest", specification: "Class 2 hi-vis, reflective tape, breathable mesh", quantity: 120, unit: "EA", estimatedUnitPrice: 1150, disposition: "INVENTORY" },
      ],
    },
    prisma,
  );
  await submitPr(qs, safetyPr.id, prisma);
  await approvePrChain(safetyPr.id, { departmentKey: "ZD:QS", entity: "ZD" }, [
    "Approved — PPE shortfall is a compliance issue and must be closed before the next inspection.",
  ]);

  void hodIt;
  void officer;
  log(
    "Flows F–G",
    `${printerPr.number} awaiting department approval, ${marketingPr.number} returned for incomplete specification, ${safetyPr.number} in procurement review`,
  );
}

// ─────────────────────────────────────────────────────────────
// Flow H — ZD cement: PO issued, delivery overdue, no GRN
// ─────────────────────────────────────────────────────────────
async function flowOverdueCement() {
  const pm = U("aliya.zafar@zameen.com");
  const officer = U("danish.raza@zameen.com");
  const director = U("kamran.rasheed@zameen.com");

  const pr = await createPr(
    pm,
    {
      entityId: entityId.ZD,
      departmentId: departmentId["ZD:PROJ"],
      procurementType: "MATERIAL_DEMAND",
      title: "MD — Ordinary Portland cement for Opal Mall basement slab (4,000 bags)",
      justification: "Basement slab and shear wall pours per the concrete programme. Quantity from BOQ 03.01.02.",
      projectId: projectId["ZD-OPL"],
      siteId: siteId["SITE-OPL"],
      costCenter: "ZD-CC-200",
      deliveryStoreId: storeId["ST-OPL"],
      requiredDate: D(4),
      priority: "URGENT",
      budgetAmount: 6_200_000,
      budgetCode: "ZD-OPL-STRUCT-2026",
      pmOwnerId: pm.id,
      boqReference: "BOQ-OPL-03.01.02 (Rev B)",
      drawingReference: "S-101 to S-104 (Rev C)",
      technicalNotes: "OPC Type-I, 50kg bags, BS EN 197-1. Bags to be dry, unbroken and delivered on pallets.",
      items: [
        {
          itemId: itemId["CST-CEM-0001"],
          categoryId: categoryId["CONSTR-CEMENT"],
          description: "Ordinary Portland Cement 50kg bag",
          brand: "Maple Leaf",
          specification: "OPC Type-I, 50kg, BS EN 197-1 compliant, batch and manufacture date printed",
          quantity: 4000,
          unit: "BAG",
          estimatedUnitPrice: 1385,
          disposition: "PROJECT_MATERIAL",
        },
      ],
    },
    prisma,
  );
  await attachMdDocuments({
    prId: pr.id,
    prNumber: pr.number,
    entity: "ZD",
    uploaderId: pm.id,
    boqName: "BOQ-OPL-03.01.02 Rev B — Basement slab concrete take-off",
    boqFile: "BOQ-OPL-030102-RevB.xlsx",
    drawingName: "S-101 to S-104 Rev C — Basement slab & shear wall drawings",
    drawingFile: "S-101-S-104-RevC.pdf",
  });
  await submitPr(pm, pr.id, prisma);
  await approvePrChain(pr.id, { departmentKey: "ZD:PROJ", entity: "ZD" }, [
    "Validated against the concrete programme.",
    "Supply chain reviewed — awarding to the established dealer on rate contract.",
  ]);
  await startSourcing(officer, pr.id, prisma);

  const rfq = await createRfq(
    officer,
    {
      prId: pr.id,
      title: "RFQ — OPC cement 4,000 bags (Opal Mall)",
      scope: "Supply and delivery of 4,000 bags of OPC Type-I to Opal Mall site store, phased with the pour programme.",
      terms: "Rate per bag inclusive of tax and delivery. Payment 21 days from invoice.",
      responseDeadline: FUTURE(1),
      vendorIds: [vendorId["Maple Leaf Cement Dealer — Bilal Traders"], vendorId["Bright Build Materials"]],
    },
    prisma,
  );
  await issueRfq(officer, rfq.id, prisma);

  const prItem = (await prisma.purchaseRequisitionItem.findFirstOrThrow({ where: { prId: pr.id } })).id;
  await upsertQuote(
    officer,
    {
      rfqId: rfq.id,
      vendorId: vendorId["Maple Leaf Cement Dealer — Bilal Traders"],
      quoteRef: "BT/26/0331",
      validUntil: FUTURE(5),
      deliveryDays: 5,
      paymentTerms: "21 days",
      creditDays: 21,
      technicalCompliance: "COMPLIANT",
      channel: "EMAIL",
      items: [
        { prItemId: prItem, itemId: itemId["CST-CEM-0001"], description: "OPC Type-I 50kg bag", quantity: 4000, unit: "BAG", unitPrice: 1352, taxRate: 18, deliveryDays: 5, compliance: "COMPLIANT" },
      ],
    },
    prisma,
  );
  await upsertQuote(
    officer,
    {
      rfqId: rfq.id,
      vendorId: vendorId["Bright Build Materials"],
      quoteRef: "BBM/26/0688",
      validUntil: FUTURE(4),
      deliveryCharges: 42000,
      deliveryDays: 7,
      paymentTerms: "21 days",
      creditDays: 21,
      technicalCompliance: "COMPLIANT",
      channel: "EMAIL",
      items: [
        { prItemId: prItem, itemId: itemId["CST-CEM-0001"], description: "OPC Type-I 50kg bag", quantity: 4000, unit: "BAG", unitPrice: 1368, taxRate: 18, deliveryDays: 7, compliance: "COMPLIANT" },
      ],
    },
    prisma,
  );

  const comparative = await buildComparative(
    officer,
    { rfqId: rfq.id, notes: "Two quotations against an established rate contract. Bilal Traders is lower and delivers without freight." },
    prisma,
  );
  const btQuote = await prisma.vendorQuote.findFirstOrThrow({
    where: { rfqId: rfq.id, vendorId: vendorId["Maple Leaf Cement Dealer — Bilal Traders"] },
  });
  await recommendVendor(
    officer,
    { comparativeId: comparative.id, quoteId: btQuote.id, basis: "Lowest compliant delivered rate with a 5-day lead time matching the pour programme." },
    prisma,
  );

  const cementCase = await createCpcCase(
    officer,
    {
      comparativeId: comparative.id,
      recommendation:
        "Award 4,000 bags of OPC Type-I to Bilal Traders at the lowest compliant delivered rate on the existing rate contract.",
      riskNotes:
        "Delivery must be phased with the pour programme. Cement is perishable in storage — no more than a 10-day stock to be held at site.",
    },
    prisma,
  );
  await voteCpc(cementCase.id, "APPROVE", "Approved. Established rate contract and the lowest delivered rate.");

  const po = await createPoFromCase(
    officer,
    {
      prId: pr.id,
      deliveryStoreId: storeId["ST-OPL"],
      deliveryDate: D(9),
      paymentTerms: "21 days from invoice",
      creditDays: 21,
      termsConditions: "Phased delivery on pallets. Bags with broken seals or hardened material to be rejected at the gate.",
    },
    prisma,
  );
  await submitPoForApproval(officer, po.id, prisma);
  await approvePoChain(po.id, "ZD", ["Approved.", "Approved for issue."]);
  await issuePo(director, po.id, prisma);
  await recordSavingsForPo(systemActor("SEED"), po.id, prisma);
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { issuedAt: D(14), deliveryDate: D(9) } });

  await backdateCase(pr.number, 16);
  log("Flow H", `${pr.number} cement — purchase order issued, delivery 9 days overdue, no GRN raised`);
}

// ─────────────────────────────────────────────────────────────
// Flow I — ZD MEP cable: RFQ issued, awaiting vendor responses
// ─────────────────────────────────────────────────────────────
async function flowRfqAwaitingQuotes() {
  const mep = U("kashif.mehmood@zameen.com");
  const officer = U("saad.mirza@zameen.com");

  const pr = await createPr(
    mep,
    {
      entityId: entityId.ZD,
      departmentId: departmentId["ZD:MEP"],
      procurementType: "MATERIAL_DEMAND",
      title: "MD — Power cable and distribution boards for Residencia Phase II street lighting",
      justification:
        "Street lighting distribution for sectors A and B per the approved electrical layout. Cable lengths from the pull schedule with 8% wastage.",
      projectId: projectId["ZD-RES"],
      siteId: siteId["SITE-RES"],
      costCenter: "ZD-CC-220",
      deliveryStoreId: storeId["ST-RES"],
      requiredDate: FUTURE(22),
      priority: "NORMAL",
      budgetAmount: 5_400_000,
      budgetCode: "ZD-RES-MEP-2026",
      pmOwnerId: U("haroon.rashid@zameen.com").id,
      boqReference: "BOQ-RES-16.02 (Rev A)",
      drawingReference: "E-301 to E-306 (Rev B), cable pull schedule CP-11",
      technicalNotes:
        "Copper conductor only; aluminium not acceptable. Cable to be IEC 60502 compliant with test certificate. Distribution boards to be IP42 minimum with Schneider or equivalent MCBs.",
      items: [
        { itemId: itemId["MEP-CBL-0001"], categoryId: categoryId["MEP-ELEC"], description: "Copper cable 3-core 4mm²", brand: "Pakistan Cables", specification: "3x4mm² copper, PVC insulated, 600/1000V, IEC 60502, test certificate required", quantity: 3200, unit: "M", estimatedUnitPrice: 1180, disposition: "PROJECT_MATERIAL" },
        { itemId: itemId["MEP-DBD-0001"], categoryId: categoryId["MEP-ELEC"], description: "Distribution board 12-way TPN", brand: "Schneider", specification: "12-way TPN, IP42, complete with MCBs per schedule", quantity: 24, unit: "EA", estimatedUnitPrice: 42500, disposition: "PROJECT_MATERIAL" },
      ],
    },
    prisma,
  );
  await attachMdDocuments({
    prId: pr.id,
    prNumber: pr.number,
    entity: "ZD",
    uploaderId: mep.id,
    boqName: "BOQ-RES-16.02 Rev A — Street lighting distribution take-off",
    boqFile: "BOQ-RES-1602-RevA.xlsx",
    drawingName: "E-301 to E-306 Rev B — Electrical layouts & pull schedule CP-11",
    drawingFile: "E-301-E-306-RevB.pdf",
  });
  await submitPr(mep, pr.id, prisma);
  await approvePrChain(pr.id, { departmentKey: "ZD:MEP", entity: "ZD" }, [
    "Cable sizing and board schedule validated against the load calculation.",
    "Supply chain reviewed. Copper-only requirement noted in the RFQ.",
    "Approved for sourcing.",
  ]);
  await startSourcing(officer, pr.id, prisma);

  const rfq = await createRfq(
    officer,
    {
      prId: pr.id,
      title: "RFQ — Copper cable & distribution boards (Residencia Phase II)",
      scope:
        "Supply and delivery of 3,200m 3x4mm² copper cable and 24 × 12-way TPN distribution boards to Residencia Phase II site store.",
      terms:
        "Copper conductor mandatory — aluminium offers will be rejected. IEC 60502 test certificate required. Rates inclusive of tax and delivery.",
      deliveryRequirement: "Delivery to Residencia Phase II Site Store within 15 days of purchase order.",
      responseDeadline: FUTURE(4),
      vendorIds: [vendorId["Prime Electricals"], vendorId["Techno Solutions"], vendorId["Bright Build Materials"]],
    },
    prisma,
  );
  await issueRfq(officer, rfq.id, prisma);

  // One vendor has responded; two are still outstanding.
  const prItems = await prisma.purchaseRequisitionItem.findMany({ where: { prId: pr.id }, orderBy: { lineNo: "asc" } });
  await upsertQuote(
    officer,
    {
      rfqId: rfq.id,
      vendorId: vendorId["Prime Electricals"],
      quoteRef: "PE/26/1044",
      validUntil: FUTURE(18),
      deliveryDays: 14,
      paymentTerms: "30 days",
      creditDays: 30,
      technicalCompliance: "COMPLIANT",
      complianceNotes: "Pakistan Cables copper with IEC test certificate. Schneider boards ex-stock.",
      channel: "EMAIL",
      items: [
        { prItemId: prItems[0].id, itemId: itemId["MEP-CBL-0001"], description: "Pakistan Cables 3x4mm² copper", quantity: 3200, unit: "M", unitPrice: 1148, taxRate: 18, deliveryDays: 14, compliance: "COMPLIANT" },
        { prItemId: prItems[1].id, itemId: itemId["MEP-DBD-0001"], description: "Schneider 12-way TPN DB, IP42", quantity: 24, unit: "EA", unitPrice: 41200, taxRate: 18, deliveryDays: 14, compliance: "COMPLIANT" },
      ],
    },
    prisma,
  );

  log("Flow I", `${pr.number} MEP cable — RFQ issued, 1 of 3 quotations received, 2 outstanding`);
}

// ─────────────────────────────────────────────────────────────
// Flow J/K — petty cash: one closed, one stuck without store entry
// ─────────────────────────────────────────────────────────────
async function flowPettyCash() {
  const requester = U("rabia.noor@zameen.com");
  const officer = U("hira.aslam@zameen.com");
  const psm = U("asim.javed@zameen.com");
  const storeMgr = U("shakeel.ahmad@zameen.com");
  const finance = U("imran.shafiq@zameen.com");
  const zdAdmin = U("zd.admin@zameen.com");
  const zdOfficer = U("danish.raza@zameen.com");

  // J — complete cycle including the store entry
  const pc1 = await createPettyCash(
    requester,
    {
      entityId: entityId.ZM,
      departmentId: departmentId["ZM:ADMIN"],
      purpose: "Urgent replacement toner and whiteboard markers for the 2nd floor",
      justification:
        "Print room ran out of CF259A toner mid-week with a client pitch pack due. Store stock is nil and the scheduled supply order is 8 days out.",
      requiredDate: D(9),
      storeId: storeId["ST-ZM-HO"],
      items: [
        { itemId: itemId["IT-TON-0001"], description: "Toner cartridge CF259A", quantity: 1, unit: "EA", estimatedUnitPrice: 13900, disposition: "INVENTORY" },
        { itemId: itemId["OFF-WBM-0001"], description: "Whiteboard marker set (4 colours)", quantity: 1, unit: "SET", estimatedUnitPrice: 680, disposition: "INVENTORY" },
      ],
    },
    prisma,
  );
  await submitPettyCash(requester, pc1.id, prisma);
  await addPettyCashQuote(officer, { requestId: pc1.id, vendorName: "Al-Noor Stationers", vendorId: vendorId["Al-Noor Stationers"], channel: "PHONE", contactRef: "+92 42 3712 3344", amount: 14850, taxIncluded: true, deliveryDays: 1, notes: "Ex-stock, can deliver same day." }, prisma);
  await addPettyCashQuote(officer, { requestId: pc1.id, vendorName: "Paper Plus Supplies", vendorId: vendorId["Paper Plus Supplies"], channel: "WHATSAPP", contactRef: "WhatsApp quote screenshot attached", amount: 15400, taxIncluded: true, deliveryDays: 1 }, prisma);
  await addPettyCashQuote(officer, { requestId: pc1.id, vendorName: "Hafeez Centre — Shop 44", channel: "PHYSICAL", contactRef: "Handwritten quotation slip", amount: 14200, taxIncluded: false, deliveryDays: 0, notes: "Cash only, no tax invoice." }, prisma);
  await selectPettyCashQuote(
    officer,
    {
      requestId: pc1.id,
      quoteId: (await prisma.pettyCashQuote.findFirstOrThrow({ where: { requestId: pc1.id, vendorName: "Al-Noor Stationers" } })).id,
      justification:
        "Hafeez Centre is PKR 650 cheaper but cash-only with no tax invoice, which cannot be reconciled against the voucher. Al-Noor is the lowest quotation that provides a compliant tax invoice.",
    },
    prisma,
  );
  await approvePettyCash(psm, { requestId: pc1.id, approve: true, reason: "Approved. Genuine urgency, three quotations recorded and the non-lowest selection is justified.", approvedAmount: 14850 }, prisma);

  const pc1Items = await prisma.pettyCashItem.findMany({ where: { requestId: pc1.id }, orderBy: { lineNo: "asc" } });
  await recordPurchase(
    requester,
    {
      requestId: pc1.id,
      actualAmount: 14850,
      purchasedFromVendor: "Al-Noor Stationers",
      receiptRef: "ANS-CR-88214",
      lineAmounts: { [pc1Items[0].id]: 14170, [pc1Items[1].id]: 680 },
    },
    prisma,
  );
  await prisma.document.create({
    data: {
      name: "Cash receipt ANS-CR-88214",
      originalFilename: "ANS-CR-88214.jpg",
      storagePath: "seed/ans-cr-88214.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 412_000,
      documentTypeId: (await prisma.documentType.findUniqueOrThrow({ where: { code: "RECEIPT" } })).id,
      linkedType: "PETTY_CASH",
      linkedId: pc1.id,
      caseKey: pc1.number,
      category: "Receipt",
      description: "Scanned cash purchase receipt.",
      entityId: entityId.ZM,
      uploadedById: requester.id,
    },
  });
  const voucher1 = await generateVoucher(officer, pc1.id, prisma);
  await signVoucher(psm, { voucherId: voucher1.id, approve: true, notes: "Receipt matches the approved amount." }, prisma);
  await completeStoreEntry(
    storeMgr,
    {
      requestId: pc1.id,
      storeId: storeId["ST-ZM-HO"],
      lines: [
        { pettyCashItemId: pc1Items[0].id, itemId: itemId["IT-TON-0001"], quantity: 1, unitCost: 14170, locationId: locationId["ST-ZM-HO:STA-02"] },
        { pettyCashItemId: pc1Items[1].id, itemId: itemId["OFF-WBM-0001"], quantity: 1, unitCost: 680, locationId: locationId["ST-ZM-HO:STA-01"] },
      ],
    },
    prisma,
  );
  await reconcilePettyCash(finance, pc1.id, "Voucher, receipt and store entry all reconcile. Cash float adjusted.", prisma);
  await closePettyCash(finance, pc1.id, prisma);
  await backdateCase(pc1.number, 9);

  // K — the historical gap: voucher approved, store entry outstanding
  const pc2 = await createPettyCash(
    zdAdmin,
    {
      entityId: entityId.ZD,
      departmentId: departmentId["ZD:ADMIN"],
      purpose: "Emergency purchase of hand tools and fixings for the site office fit-out",
      justification:
        "Site office partition work stalled for want of drill bits, anchors and a spirit level. Purchased locally to keep the crew working.",
      requiredDate: D(5),
      storeId: storeId["ST-ZD-OFF"],
      items: [
        { itemId: itemId["OFF-STA-0001"], description: "Heavy duty stapler (site office)", quantity: 2, unit: "EA", estimatedUnitPrice: 2100, disposition: "INVENTORY" },
        { description: "Assorted masonry drill bits, anchors and spirit level", quantity: 1, unit: "SET", estimatedUnitPrice: 8400, disposition: "INVENTORY" },
      ],
    },
    prisma,
  );
  await submitPettyCash(zdAdmin, pc2.id, prisma);
  await addPettyCashQuote(zdOfficer, { requestId: pc2.id, vendorName: "Hardware Market — Ravi Road Stall 12", channel: "PHYSICAL", amount: 12600, taxIncluded: false, deliveryDays: 0 }, prisma);
  await addPettyCashQuote(zdOfficer, { requestId: pc2.id, vendorName: "Tool House Lahore", channel: "WHATSAPP", amount: 13250, taxIncluded: true, deliveryDays: 1 }, prisma);
  await addPettyCashQuote(zdOfficer, { requestId: pc2.id, vendorName: "Al-Fatah Hardware", channel: "PHONE", amount: 13900, taxIncluded: true, deliveryDays: 1 }, prisma);
  await selectPettyCashQuote(
    zdOfficer,
    {
      requestId: pc2.id,
      quoteId: (await prisma.pettyCashQuote.findFirstOrThrow({ where: { requestId: pc2.id, vendorName: "Tool House Lahore" } })).id,
      justification: "Ravi Road stall is marginally cheaper but issues no tax invoice. Tool House is the lowest compliant quotation.",
    },
    prisma,
  );
  await approvePettyCash(psm, { requestId: pc2.id, approve: true, reason: "Approved — genuine site urgency, three quotations recorded.", approvedAmount: 13250 }, prisma);

  const pc2Items = await prisma.pettyCashItem.findMany({ where: { requestId: pc2.id }, orderBy: { lineNo: "asc" } });
  await recordPurchase(
    zdAdmin,
    { requestId: pc2.id, actualAmount: 13250, purchasedFromVendor: "Tool House Lahore", receiptRef: "TH-2026-4471", lineAmounts: { [pc2Items[0].id]: 4300, [pc2Items[1].id]: 8950 } },
    prisma,
  );
  const voucher2 = await generateVoucher(zdOfficer, pc2.id, prisma);
  await signVoucher(psm, { voucherId: voucher2.id, approve: true, notes: "Voucher signed. Store entry still to be completed before reconciliation." }, prisma);
  // Deliberately left at STORE_ENTRY_PENDING — this is the gap the OS now blocks on.
  await backdateCase(pc2.number, 5);

  log(
    "Flows J–K",
    `${pc1.number} closed with store entry, ${pc2.number} blocked at store-entry-pending with a blocking exception`,
  );
}

// ─────────────────────────────────────────────────────────────
// Flow L — store issuance, transfer and an adjustment
// ─────────────────────────────────────────────────────────────
async function flowStoreOperations() {
  const requester = U("rabia.noor@zameen.com");
  const storeMgr = U("shakeel.ahmad@zameen.com");
  const warehouse = U("iftikhar.hussain@zameen.com");
  const siteStore = U("ahsan.iqbal@zameen.com");

  // Issue stationery to marketing
  const issue = await createStoreIssue(
    requester,
    {
      storeId: storeId["ST-ZM-HO"],
      recipientName: "Mehwish Khan — Marketing",
      recipientUserId: U("mehwish.khan@zameen.com").id,
      departmentId: departmentId["ZM:MKT"],
      purpose: "Monthly stationery draw for the marketing floor",
      items: [
        { itemId: itemId["OFF-PAP-0001"], requestedQty: 25, unit: "REAM" },
        { itemId: itemId["OFF-PEN-0001"], requestedQty: 6, unit: "BOX" },
        { itemId: itemId["OFF-FIL-0001"], requestedQty: 15, unit: "EA" },
      ],
      submit: true,
    },
    prisma,
  );
  await decideStoreIssue(storeMgr, { issueId: issue.id, approve: true, reason: "Approved against the monthly allocation." }, prisma);
  await issueStock(storeMgr, { issueId: issue.id }, prisma);

  // A second issue awaiting approval
  const pendingIssue = await createStoreIssue(
    U("sana.iqbal@zameen.com"),
    {
      storeId: storeId["ST-ZM-HO"],
      recipientName: "IT Department — print room",
      recipientUserId: U("sana.iqbal@zameen.com").id,
      departmentId: departmentId["ZM:IT"],
      purpose: "Toner replenishment for the 2nd floor print room",
      items: [{ itemId: itemId["IT-TON-0001"], requestedQty: 1, unit: "EA" }],
      submit: true,
    },
    prisma,
  );
  void pendingIssue;

  // Transfer steel from the site store to the Park View site
  const transfer = await createTransfer(
    U("naveed.anjum@zameen.com"),
    {
      fromStoreId: storeId["ST-OPL"],
      toStoreId: storeId["ST-PRK"],
      reason:
        "Park View column starters require 12mm bar ahead of their own delivery. Opal Mall has surplus against the current pour sequence.",
      items: [{ itemId: itemId["CST-STL-0002"], requestedQty: 5, unit: "TON", batchNumber: "HEAT-A615-26-3358", notes: "Mill tags to travel with the bundles for traceability." }],
      submit: true,
    },
    prisma,
  );
  await decideTransfer(warehouse, { transferId: transfer.id, approve: true, reason: "Approved. Traceability maintained through the heat number." }, prisma);
  await dispatchTransfer(
    U("naveed.anjum@zameen.com"),
    { transferId: transfer.id, vehicleNumber: "TLB-3319", gatePassRef: "OGP-OPL-0221" },
    prisma,
  );
  await receiveTransfer(
    siteStore,
    { transferId: transfer.id, remarks: "5 ton received and weighed in. Mill tags intact." },
    prisma,
  );

  // A transfer still awaiting approval
  const pendingTransfer = await createTransfer(
    warehouse,
    {
      fromStoreId: storeId["WH-MULTAN"],
      toStoreId: storeId["ST-RES"],
      reason: "Pre-positioning safety stock at Residencia ahead of the sector B mobilisation.",
      items: [{ itemId: itemId["SAF-HLM-0001"], requestedQty: 20, unit: "EA" }],
      submit: true,
    },
    prisma,
  ).catch(() => null);
  void pendingTransfer;

  // A documented physical-count adjustment
  await adjustStock(
    storeMgr,
    {
      itemId: itemId["OFF-PAP-0001"],
      storeId: storeId["ST-ZM-HO"],
      quantityDelta: -3,
      unit: "REAM",
      reason:
        "Quarterly physical count variance: 3 reams water-damaged by a pantry leak and written off. Damaged stock photographed and disposed of.",
    },
    prisma,
  );

  log("Flow L", "store issue completed, one pending; inter-site transfer received; count variance adjusted");
}

// ─────────────────────────────────────────────────────────────
// Flow M — asset custody
// ─────────────────────────────────────────────────────────────
async function flowAssets() {
  const itUser = U("sana.iqbal@zameen.com");
  const admin = U("tahir.abbas@zameen.com");

  const laptops = await prisma.asset.findMany({
    where: { item: { sku: "IT-LAP-0001" }, status: "IN_STORAGE" },
    orderBy: { createdAt: "asc" },
    take: 12,
  });
  const custodians = [
    "mehwish.khan@zameen.com",
    "junaid.akhtar@zameen.com",
    "adeel.rauf@zameen.com",
    "ayesha.malik@zameen.com",
    "rabia.noor@zameen.com",
    "usman.tariq@zameen.com",
    "hira.aslam@zameen.com",
    "imran.shafiq@zameen.com",
  ];
  for (const [i, asset] of laptops.slice(0, 8).entries()) {
    const custodianEmail = custodians[i % custodians.length];
    await updateAsset(
      itUser,
      asset.id,
      {
        status: "ISSUED",
        custodianId: U(custodianEmail).id,
        location: `Zameen Tower — ${["3rd", "4th", "5th"][i % 3]} floor`,
        office: "Zameen Tower, Lahore",
        departmentId: departmentId["ZM:IT"],
      },
      `Issued to ${U(custodianEmail).name} against the laptop refresh programme. Asset acceptance form signed.`,
      prisma,
    );
  }
  if (laptops[8]) {
    await updateAsset(
      itUser,
      laptops[8].id,
      { status: "UNDER_REPAIR", conditionNotes: "Keyboard fault reported in week 2; returned to vendor under warranty." },
      "Warranty repair — vendor collected the unit and issued a job sheet.",
      prisma,
    );
  }

  const acUnits = await prisma.asset.findMany({
    where: { item: { sku: "HVA-SPL-0001" } },
    orderBy: { createdAt: "asc" },
    take: 8,
  });
  for (const [i, a] of acUnits.entries()) {
    await updateAsset(
      admin,
      a.id,
      {
        status: "ACTIVE",
        location: `Zameen Tower — ${i < 4 ? "3rd" : "4th"} floor, position ${(i % 4) + 1}`,
        office: "Zameen Tower, Lahore",
        departmentId: departmentId["ZM:ADMIN"],
      },
      "Installed and commissioned. Warranty card registered against the asset tag.",
      prisma,
    );
  }

  log("Flow M", `${laptops.length} laptops and ${acUnits.length} AC units tagged; 8 issued to custodians, 1 under warranty repair`);
}

// ─────────────────────────────────────────────────────────────
// Flow N — disposal & scrap
// ─────────────────────────────────────────────────────────────
async function flowDisposal() {
  const itUser = U("bilal.hameed@zameen.com");
  const admin = U("tahir.abbas@zameen.com");
  const storeMgr = U("shakeel.ahmad@zameen.com");
  const auditor = U("faryal.qureshi@zameen.com");
  const psm = U("asim.javed@zameen.com");
  const mgmt = U("shahid.mahmood@zameen.com");
  const finance = U("imran.shafiq@zameen.com");
  const siteStore = U("naveed.anjum@zameen.com");

  // 1. IT hardware disposal — completed sale
  const idleLaptop = await prisma.asset.findFirst({ where: { status: "UNDER_REPAIR" } });
  const itCase = await createDisposalCase(
    itUser,
    {
      entityId: entityId.ZM,
      title: "Disposal — 14 obsolete laptops, 6 CRT-era monitors and 9 failed motherboards",
      disposalCategory: "IT_HARDWARE",
      recommendedAction: "SALE",
      assessmentNotes:
        "All units are 2017–2019 vintage, out of warranty and below the minimum supported specification. Motherboards are diagnosed unrepairable. Data-bearing drives to be wiped and physically destroyed before release; certificates of destruction to be retained.",
      items: [
        { description: "Obsolete laptops (2017–2019, out of support)", quantity: 14, unit: "EA", condition: "OBSOLETE", bookValue: 0, estimatedValue: 210000, notes: "Drives removed and destroyed prior to sale." },
        { description: "CRT-era and 17\" TFT monitors", quantity: 6, unit: "EA", condition: "OBSOLETE", bookValue: 0, estimatedValue: 24000 },
        { description: "Failed motherboards — diagnosed unrepairable", quantity: 9, unit: "EA", condition: "UNREPAIRABLE", bookValue: 0, estimatedValue: 13500 },
      ],
    },
    prisma,
  );
  await advanceDisposal(itUser, itCase.id, "ASSESSMENT", { assessmentNotes: "Physical inspection completed by IT. Serviceable RAM and drives harvested for spares; the remainder is for sale as e-waste." }, prisma);
  await advanceDisposal(auditor, itCase.id, "AUDIT_REVIEW", { auditNotes: "Audit verified the asset list against the register. Book value is nil on all items. Data destruction certificates sighted for all 14 laptops. No objection." }, prisma);
  await advanceDisposal(psm, itCase.id, "PENDING_APPROVAL", { finalAction: "SALE" }, prisma);
  await advanceDisposal(psm, itCase.id, "APPROVED", { notes: "Approved for disposal by sale through open bidding." }, prisma);
  await addDisposalBid(psm, { caseId: itCase.id, bidderName: "Lahore E-Waste Recyclers", contactPhone: "+92 300 8811223", amount: 218000, notes: "Collection within 3 days, weighs on site." }, prisma);
  await addDisposalBid(psm, { caseId: itCase.id, bidderName: "Hafeez Centre — Computer Scrap Dealers", contactPhone: "+92 321 4477889", amount: 246500, notes: "Highest bid. Willing to pay by online transfer before collection." }, prisma);
  await addDisposalBid(psm, { caseId: itCase.id, bidderName: "Green Tech Recycling", contactPhone: "+92 333 9911002", amount: 201000 }, prisma);
  await advanceDisposal(psm, itCase.id, "BID_EVALUATION", { notes: "Three bids received against the advertised lot." }, prisma);
  const winning = await prisma.disposalBid.findFirstOrThrow({ where: { caseId: itCase.id, bidderName: "Hafeez Centre — Computer Scrap Dealers" } });
  await advanceDisposal(mgmt, itCase.id, "MANAGEMENT_APPROVAL", { winningBidId: winning.id, notes: "Highest bid accepted. Payment to be received in full before any material leaves the premises." }, prisma);
  await advanceDisposal(mgmt, itCase.id, "PAYMENT_PENDING", { notes: "Awaiting payment against the accepted bid." }, prisma);
  await advanceDisposal(finance, itCase.id, "PAYMENT_RECEIVED", { paymentReference: "MEEZAN-IBFT-2026-33119", realisedValue: winning.amount }, prisma);
  await advanceDisposal(mgmt, itCase.id, "COMPLETED", { finalAction: "SALE", realisedValue: winning.amount, notes: "Material collected against a signed outward gate pass. Payment of PKR 246,500 received in full." }, prisma);
  void idleLaptop;

  // 2. Furniture scrap — pending approval
  const furnCase = await createDisposalCase(
    admin,
    {
      entityId: entityId.ZM,
      title: "Scrap — 22 broken task chairs and 4 damaged workstation tops",
      disposalCategory: "FURNITURE",
      recommendedAction: "SCRAP",
      assessmentNotes:
        "Gas lifts collapsed and mesh backs torn beyond repair on 22 chairs; repair quotation exceeds replacement cost. Four workstation tops are water-damaged and delaminating.",
      items: [
        { description: "Ergonomic task chairs — collapsed gas lift, torn mesh", quantity: 22, unit: "EA", condition: "UNREPAIRABLE", bookValue: 0, estimatedValue: 33000 },
        { description: "Workstation tops — water damaged, delaminating", quantity: 4, unit: "EA", condition: "DAMAGED", bookValue: 0, estimatedValue: 6000 },
      ],
    },
    prisma,
  );
  await advanceDisposal(admin, furnCase.id, "ASSESSMENT", { assessmentNotes: "Repair quotation of PKR 9,800 per chair against a replacement cost of PKR 68,500 — repair is uneconomic where the frame is also bent." }, prisma);
  await advanceDisposal(auditor, furnCase.id, "AUDIT_REVIEW", { auditNotes: "Audit sighted a sample of 8 chairs and confirms the condition. Recommend scrap disposal by weight." }, prisma);
  await advanceDisposal(admin, furnCase.id, "PENDING_APPROVAL", { finalAction: "SCRAP" }, prisma);

  // 3. Construction scrap at site — in bidding
  const scrapCase = await createDisposalCase(
    siteStore,
    {
      entityId: entityId.ZD,
      title: "Construction scrap — Opal Mall basement (steel offcuts, formwork, empty cement bags)",
      disposalCategory: "CONSTRUCTION_SCRAP",
      recommendedAction: "SALE",
      assessmentNotes:
        "Accumulated scrap from the basement structural phase. Steel offcuts weighed at the site weighbridge. Formwork ply is beyond reuse after 9 cycles. Yard congestion is affecting material movement.",
      items: [
        { itemId: itemId["CST-STL-0001"], storeId: storeId["ST-OPL"], description: "Steel offcuts and bar ends", quantity: 3.2, unit: "TON", condition: "SCRAP", estimatedValue: 480000 },
        { description: "Formwork plywood — 9 cycles, delaminated", quantity: 180, unit: "SHEET", condition: "UNREPAIRABLE", estimatedValue: 90000 },
        { description: "Empty cement bags (baled)", quantity: 3800, unit: "EA", condition: "SCRAP", estimatedValue: 38000 },
      ],
    },
    prisma,
  );
  await advanceDisposal(siteStore, scrapCase.id, "ASSESSMENT", { assessmentNotes: "Weighbridge slips attached. Scrap segregated into steel, timber and paper for separate lot pricing." }, prisma);
  await advanceDisposal(auditor, scrapCase.id, "AUDIT_REVIEW", { auditNotes: "Audit witnessed the weighbridge measurement of the steel lot. Quantities confirmed. Bidding to be open with a minimum of three bidders." }, prisma);
  await advanceDisposal(U("farhan.siddiqui@zameen.com"), scrapCase.id, "PENDING_APPROVAL", { finalAction: "SALE" }, prisma);
  await advanceDisposal(U("farhan.siddiqui@zameen.com"), scrapCase.id, "APPROVED", { notes: "Approved for sale by open bidding, minimum three bidders." }, prisma);
  await addDisposalBid(U("farhan.siddiqui@zameen.com"), { caseId: scrapCase.id, bidderName: "Badami Bagh Scrap Merchants", contactPhone: "+92 300 4411556", amount: 585000, notes: "Steel lot at PKR 168/kg, timber and paper as a combined lot." }, prisma);
  await addDisposalBid(U("farhan.siddiqui@zameen.com"), { caseId: scrapCase.id, bidderName: "Ravi Metal Traders", contactPhone: "+92 321 7788990", amount: 612000, notes: "Highest bid to date; will collect within 48 hours." }, prisma);

  // 4. Marketing material — complete waste
  const mktCase = await createDisposalCase(
    admin,
    {
      entityId: entityId.ZM,
      title: "Disposal — expired billboard skins and superseded expo collateral",
      disposalCategory: "MARKETING_MATERIAL",
      recommendedAction: "DISPOSE",
      assessmentNotes:
        "Campaign-specific panaflex skins for concluded campaigns and 1,400 brochures carrying superseded pricing. No resale or reuse value; brochures must be shredded because they carry pricing.",
      items: [
        { description: "Billboard panaflex skins — concluded campaigns", quantity: 14, unit: "EA", condition: "OBSOLETE", estimatedValue: 0 },
        { description: "Brochures with superseded pricing", quantity: 1400, unit: "EA", condition: "OBSOLETE", estimatedValue: 0, notes: "To be shredded, not sold." },
      ],
    },
    prisma,
  );
  await advanceDisposal(admin, mktCase.id, "ASSESSMENT", { assessmentNotes: "Confirmed complete waste. Brochures to be shredded on site with a certificate of destruction." }, prisma);

  void storeMgr;
  log("Flow N", "4 disposal cases — 1 sold and completed, 1 in bidding, 1 pending approval, 1 under assessment");
}

// ─────────────────────────────────────────────────────────────
// Flow O — CPC meetings & trader case
// ─────────────────────────────────────────────────────────────
async function flowCpcMeetings() {
  const chair = U("kamran.rasheed@zameen.com");
  const officer = U("hira.aslam@zameen.com");

  await ensureUpcomingMeeting(systemActor("SEED"), entityId.ZM, prisma);
  await ensureUpcomingMeeting(systemActor("SEED"), entityId.ZD, prisma);

  const past = await scheduleMeeting(
    chair,
    {
      entityId: entityId.ZM,
      title: "CPC — Zameen Media — weekly review",
      scheduledAt: D(7, 11),
      meetingType: "WEEKLY",
      location: "Zameen Tower, Board Room, 6th floor",
      agenda:
        "1. Review of cases above the committee threshold.\n2. Laptop refresh award recommendation.\n3. Vendor concentration in IT hardware.\n4. Open purchase orders past their promised delivery date.",
    },
    prisma,
  );
  await recordMinutes(
    chair,
    past.id,
    "The committee reviewed the laptop refresh case and accepted the recommendation to award to Techno Solutions as the lowest compliant offer after two documented negotiation rounds. The committee noted moderate single-vendor concentration in IT hardware and asked procurement to bring at least one additional qualified IT vendor through pre-qualification before the next hardware cycle. Procurement was also asked to table an ageing report of open purchase orders at every meeting.",
    true,
    prisma,
  );

  // Trader / MOQ case
  const printerPr = await prisma.purchaseRequisition.findFirst({
    where: { title: { contains: "A3 multifunction printer" } },
  });
  if (printerPr) {
    await recordTraderCase(
      officer,
      {
        prId: printerPr.id,
        principalVendorId: vendorId["Techno Solutions"],
        traderVendorId: vendorId["Corporate IT Traders"],
        moq: 5,
        requiredQuantity: 1,
        priceDifference: 18500,
        deliveryDays: 2,
        deliveryCharges: 3500,
        reason:
          "The principal distributor will only quote the A3 device at a minimum order quantity of 5 units to obtain principal pricing. Only one unit is required. Corporate IT Traders can supply a single unit ex-stock at PKR 18,500 above the principal's per-unit rate, with 2-day delivery against the principal's 3-week lead time for a single unit. Buying 5 units to meet the MOQ would tie up PKR 1.86m of unneeded capital.",
      },
      prisma,
    );
  }

  log("Flow O", "CPC meetings scheduled for both entities, past meeting minuted, trader/MOQ case recorded");
}

// ─────────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────────
export async function seedFlows() {
  await flowLaptops();
  await flowSteelMd();
  await flowOfficeSupplies();
  await flowAirConditioners();
  await flowFitoutAwaitingCpc();
  await flowEarlyStagePrs();
  await flowOverdueCement();
  await flowRfqAwaitingQuotes();
  await flowPettyCash();
  await flowStoreOperations();
  await flowAssets();
  await flowDisposal();
  await flowCpcMeetings();
}
