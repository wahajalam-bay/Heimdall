/**
 * Populates ProcurementOS end to end.
 *
 * Everything below is written through the same service functions the
 * application calls, so approvals, inventory, exceptions, savings, tasks,
 * notifications and the audit trail are all genuine rather than fabricated
 * rows. Actors are resolved by permission from live data, never hard-coded.
 *
 * The mix is deliberate: cases that run all the way to a recorded payment and a
 * closed order, cases parked at each in-flight stage so every queue in the
 * application has something real in it, petty cash including one request held at
 * the store-entry gate, store issues and inter-store transfers, asset tagging
 * and a disposal case taken to completion, vendor pre-qualification and issue
 * handling, shared saved views, and document reads that leave an access trail.
 *
 *   npx tsx scripts/populate.ts
 */
import { createHash } from "node:crypto";
import { prisma } from "../src/lib/db";
import type { SessionUser } from "../src/lib/rbac";
import { PERMISSIONS as P } from "../src/lib/permissions";
import { CONFIG_KEYS, getConfigNumber } from "../src/lib/config";
import { createPr, submitPr, decidePr, startSourcing } from "../src/server/pr";
import {
  buildComparative,
  createRfq,
  issueRfq,
  recommendVendor,
  recordNegotiation,
  upsertQuote,
} from "../src/server/sourcing";
import { castCpcDecision, cpcRequirement, createCpcCase } from "../src/server/cpc";
import { closePo, createPoFromCase, decidePo, issuePo, submitPoForApproval } from "../src/server/po";
import { createGatePass, recordDelivery, recordInspection } from "../src/server/receiving";
import { createGrn } from "../src/server/grn";
import {
  acknowledgeHandoff,
  decideInvoice,
  handoffToFinance,
  recordPayment,
  registerInvoice,
  submitInvoiceForApproval,
  verifyInvoice,
} from "../src/server/invoice";
import {
  addPettyCashQuote,
  approvePettyCash,
  beginQuoteCollection,
  closePettyCash,
  completeStoreEntry,
  createPettyCash,
  generateVoucher,
  reconcilePettyCash,
  recordPurchase,
  selectPettyCashQuote,
  signVoucher,
  submitPettyCash,
} from "../src/server/pettycash";
import {
  adjustStock,
  createStoreIssue,
  createTransfer,
  decideStoreIssue,
  decideTransfer,
  dispatchTransfer,
  issueStock,
  receiveTransfer,
} from "../src/server/stores";
import {
  addDisposalBid,
  advanceDisposal,
  createDisposalCase,
  tagAssetsFromGrn,
} from "../src/server/assets";
import { readDocument } from "../src/server/documents";
import {
  decideVendorApproval,
  evaluateVendor,
  raiseVendorIssue,
  recomputeAllVendorPerformance,
  updateVendorIssue,
} from "../src/server/vendors";
import { recordSavingsForPo } from "../src/server/analytics";
import { availableQuantity } from "../src/server/inventory";
import { currentApprover, sessionFor, withPermission, withPermissions, withoutPermissions } from "./lib/actors";
import { objectExists, putObject, storageDescription } from "../src/lib/storage";
import { buildCsv, buildJpeg, buildPdf } from "./lib/artefacts";
import { systemActor } from "@/lib/actor";

/* ── Reporting ────────────────────────────────────────────── */

const created: string[] = [];
const problems: string[] = [];

function note(line: string) {
  created.push(line);
  console.log(`     ${line}`);
}

function section(title: string) {
  console.log(`\n${title}`);
}

/** Records a step that could not complete, without aborting the whole run. */
function problem(what: string, e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  problems.push(`${what}: ${message}`);
  console.log(`     SKIPPED ${what} — ${message}`);
}

const REF = Date.now().toString(36).toUpperCase().slice(-4);
const day = (n: number) => new Date(Date.now() + n * 86_400_000);

/* ── Case specification ──────────────────────────────────── */

type Outcome =
  | "PAID" // through to a recorded payment and a closed order
  | "AWAITING_INVOICE" // goods received, invoice not yet registered
  | "PO_ISSUED" // order with the vendor, nothing delivered
  | "AWAITING_CPC" // comparative recommended, committee has not sat
  | "AWAITING_QUOTES" // RFQ issued, vendors have not responded
  | "PENDING_APPROVAL" // submitted, sitting with an approver
  | "DRAFT"; // being written by the requester

type CaseSpec = {
  entity: "ZM" | "ZD";
  procurementType: "MONTHLY_RECURRING" | "ON_DEMAND" | "MATERIAL_DEMAND" | "SERVICE";
  title: string;
  categoryCode: string;
  quantity: number;
  unitPrice: number;
  disposition: "INVENTORY" | "CONSUMABLE" | "EXPENSE" | "ASSET" | "PROJECT_MATERIAL";
  outcome: Outcome;
  justification: string;
  specification: string;
  vendorHint?: string;
};

const CASES: CaseSpec[] = [
  {
    entity: "ZM",
    procurementType: "ON_DEMAND",
    title: "Dell Latitude 5550 laptops for the sales expansion intake",
    categoryCode: "IT-EQUIP",
    quantity: 12,
    unitPrice: 318_000,
    disposition: "ASSET",
    outcome: "PAID",
    justification: "Twelve confirmed joiners in inside sales; existing pool has no spare machines.",
    specification: "Core Ultra 7, 32GB, 1TB NVMe, 3-year on-site warranty, Windows 11 Pro.",
    vendorHint: "computer",
  },
  {
    entity: "ZM",
    procurementType: "MONTHLY_RECURRING",
    title: "Quarterly office consumables replenishment — head office",
    categoryCode: "OFF-SUPPLY",
    quantity: 400,
    unitPrice: 1_450,
    disposition: "CONSUMABLE",
    outcome: "PAID",
    justification: "Standing quarterly replenishment against the agreed consumption baseline.",
    specification: "As per the approved office stationery standard list.",
    vendorHint: "station",
  },
  {
    entity: "ZD",
    procurementType: "MATERIAL_DEMAND",
    title: "Ordinary Portland cement for the Opal Mall slab pour",
    categoryCode: "CONSTR-CEMENT",
    quantity: 2_400,
    unitPrice: 1_285,
    disposition: "PROJECT_MATERIAL",
    outcome: "PAID",
    justification: "Slab pour sequence 3 per the approved BOQ take-off.",
    specification: "OPC 53 grade, 50kg bags, mill test certificate per despatch.",
    vendorHint: "material",
  },
  {
    entity: "ZM",
    procurementType: "ON_DEMAND",
    title: "Meeting room air conditioning replacement — 2nd floor",
    categoryCode: "HVAC",
    quantity: 6,
    unitPrice: 214_500,
    disposition: "ASSET",
    outcome: "AWAITING_INVOICE",
    justification: "Four units beyond economic repair; two rooms unusable in summer.",
    specification: "1.5 ton DC inverter, T3 compressor, installation and old-unit removal included.",
  },
  {
    entity: "ZD",
    procurementType: "MATERIAL_DEMAND",
    title: "Deformed steel bar Grade 60 — 12mm for column starters",
    categoryCode: "CONSTR-STEEL",
    quantity: 45,
    unitPrice: 271_400,
    disposition: "PROJECT_MATERIAL",
    outcome: "PO_ISSUED",
    justification: "Column starter bars for the next lift; mill certificates required per heat.",
    specification: "ASTM A615 Grade 60, single mill, per-heat mill certificates.",
  },
  {
    entity: "ZM",
    procurementType: "ON_DEMAND",
    title: "Ergonomic task chairs for the expanded floor plate",
    categoryCode: "FURN",
    quantity: 40,
    unitPrice: 46_800,
    disposition: "INVENTORY",
    outcome: "AWAITING_CPC",
    justification: "Floor plate extended by 40 seats; chairs are the only outstanding item.",
    specification: "Mesh back, adjustable lumbar and arms, 5-year frame warranty.",
  },
  {
    entity: "ZD",
    procurementType: "ON_DEMAND",
    title: "Site safety equipment for the second construction crew",
    categoryCode: "SAFETY",
    quantity: 120,
    unitPrice: 8_650,
    disposition: "INVENTORY",
    outcome: "AWAITING_QUOTES",
    justification: "Second crew mobilises this month and cannot be inducted without PPE.",
    specification: "EN397 helmets, EN20345 S3 boots, high-visibility vests, cut-5 gloves.",
  },
  {
    entity: "ZM",
    procurementType: "SERVICE",
    title: "Annual external audit of procurement controls",
    categoryCode: "SERVICES",
    quantity: 1,
    unitPrice: 1_650_000,
    disposition: "EXPENSE",
    outcome: "PENDING_APPROVAL",
    justification: "Board-mandated annual review of procurement and payment controls.",
    specification: "Scope: three-way match, approval integrity, vendor onboarding, petty cash.",
  },
  {
    entity: "ZD",
    procurementType: "MATERIAL_DEMAND",
    title: "MEP electrical rough-in materials for tower B",
    categoryCode: "MEP-ELEC",
    quantity: 3_200,
    unitPrice: 940,
    disposition: "PROJECT_MATERIAL",
    outcome: "DRAFT",
    justification: "Rough-in schedule for tower B floors 4 to 9.",
    specification: "Single-core 2.5mm² copper, LSZH, per the approved cable schedule.",
  },
];

/* ── Case driver ──────────────────────────────────────────── */

type Fixtures = {
  entityId: string;
  entityCode: "ZM" | "ZD";
  departmentId: string;
  projectId: string | null;
  siteId: string | null;
  storeId: string;
  categoryId: string;
  categoryCode: string;
  itemId: string | null;
  unit: string;
  vendorIds: string[];
};

async function fixturesFor(spec: CaseSpec): Promise<Fixtures> {
  const entity = await prisma.entity.findFirstOrThrow({ where: { code: spec.entity } });
  const category = await prisma.category.findFirstOrThrow({ where: { code: spec.categoryCode } });
  const item = await prisma.item.findFirst({
    where: { active: true, categoryId: category.id },
    orderBy: { sku: "asc" },
  });
  const project =
    spec.entity === "ZD"
      ? await prisma.project.findFirst({
          where: { entityId: entity.id, status: { notIn: ["CLOSED", "CANCELLED"] } },
        })
      : null;
  const site = project
    ? await prisma.site.findFirst({ where: { entityId: entity.id, active: true, projectId: project.id } })
    : null;
  const store = await prisma.store.findFirstOrThrow({
    where: { entityId: entity.id, active: true, ...(site ? { OR: [{ siteId: site.id }, { siteId: null }] } : {}) },
    orderBy: site ? { siteId: "desc" } : { code: "asc" },
  });
  const department = await prisma.department.findFirstOrThrow({
    where: { entityId: entity.id, active: true },
    orderBy: { name: "asc" },
  });

  // Prefer vendors whose declared categories match; fall back to any approved
  // vendor cleared for this entity.
  const approved = await prisma.vendor.findMany({
    where: { status: { in: ["APPROVED", "CONDITIONAL"] }, entityLinks: { some: { entityId: entity.id, approved: true } } },
    select: { id: true, name: true, categories: true },
    orderBy: { name: "asc" },
  });
  const hint = spec.vendorHint?.toLowerCase();
  const preferred = approved.filter(
    (v) =>
      (hint && `${v.name} ${v.categories ?? ""}`.toLowerCase().includes(hint)) ||
      (v.categories ?? "").toLowerCase().includes(spec.categoryCode.toLowerCase()),
  );
  const pool = [...preferred, ...approved.filter((v) => !preferred.some((p) => p.id === v.id))];
  if (pool.length < 3) throw new Error(`Fewer than three approved vendors for ${spec.entity}.`);

  return {
    entityId: entity.id,
    entityCode: spec.entity,
    departmentId: department.id,
    projectId: project?.id ?? null,
    siteId: site?.id ?? null,
    storeId: store.id,
    categoryId: category.id,
    categoryCode: category.code,
    itemId: item?.id ?? null,
    unit: item?.unit ?? (spec.procurementType === "SERVICE" ? "JOB" : "EA"),
    vendorIds: pool.slice(0, 3).map((v) => v.id),
  };
}

/** Attaches the BOQ and drawing pack a Material Demand cannot be submitted without. */
async function attachMdPack(prId: string, prNumber: string, entityId: string, uploaderId: string) {
  for (const [code, category, label] of [
    ["BOQ", "BOQ", "Bill of quantities take-off"],
    ["DRAWING", "Drawing", "Approved drawings and schedules"],
  ] as const) {
    const type = await prisma.documentType.findUnique({ where: { code } });
    if (!type) continue;
    await prisma.document.create({
      data: {
        name: `${label} — ${prNumber}`,
        originalFilename: `${prNumber.toLowerCase()}-${category.toLowerCase()}.pdf`,
        storagePath: `cases/${prNumber}/${category.toLowerCase()}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 486_400,
        documentTypeId: type.id,
        linkedType: "PR",
        linkedId: prId,
        caseKey: prNumber,
        category,
        description: `${label} supporting ${prNumber}.`,
        entityId,
        uploadedById: uploaderId,
      },
    });
  }
}

async function driveCase(spec: CaseSpec) {
  const f = await fixturesFor(spec);
  const requester = await withPermission(P.PR_CREATE, f.entityId);
  const officer = await withPermission(P.RFQ_ISSUE, f.entityId);
  const buyer = await withPermission(P.QUOTE_ENTER, f.entityId);
  const selector = await withPermission(P.VENDOR_SELECT, f.entityId);
  const pmOwner =
    spec.procurementType === "MATERIAL_DEMAND"
      ? await prisma.user
          .findFirst({
            where: {
              active: true,
              roles: { some: { role: { code: "PM_USER" } } },
              OR: [{ primaryEntityId: f.entityId }, { entityAccess: { some: { entityId: f.entityId } } }],
            },
            select: { email: true },
          })
          .then((u) => (u ? sessionFor(u.email) : requester))
      : null;

  /* Requisition */
  const pr = await createPr(requester, {
    entityId: f.entityId,
    departmentId: f.departmentId,
    procurementType: spec.procurementType,
    title: spec.title,
    justification: spec.justification,
    projectId: f.projectId,
    siteId: f.siteId,
    pmOwnerId: pmOwner?.id ?? null,
    deliveryStoreId: f.storeId,
    requiredDate: day(spec.outcome === "DRAFT" ? 30 : 18),
    priority: spec.quantity > 1_000 ? "HIGH" : "NORMAL",
    boqReference: spec.procurementType === "MATERIAL_DEMAND" ? `BOQ/${f.entityCode}/${REF}` : null,
    drawingReference: spec.procurementType === "MATERIAL_DEMAND" ? `DWG/${f.entityCode}/${REF}` : null,
    items: [
      {
        itemId: f.itemId,
        categoryId: f.categoryId,
        description: spec.title.replace(/ for .*$/, ""),
        specification: spec.specification,
        quantity: spec.quantity,
        unit: f.unit,
        estimatedUnitPrice: spec.unitPrice,
        requiredDate: day(18),
        disposition: spec.disposition,
      },
    ],
  });
  if (spec.outcome === "DRAFT") {
    note(`${pr.number} draft · ${spec.title}`);
    return;
  }

  if (spec.procurementType === "MATERIAL_DEMAND") {
    await attachMdPack(pr.id, pr.number, f.entityId, requester.id);
  }
  await submitPr(requester, pr.id, prisma);
  if (spec.outcome === "PENDING_APPROVAL") {
    const holder = await currentApprover(
      spec.procurementType === "MATERIAL_DEMAND" ? "MATERIAL_DEMAND" : "PR",
      pr.id,
      f.entityId,
    );
    note(`${pr.number} awaiting ${holder ? holder.name : "an approver"} · ${spec.title}`);
    return;
  }

  const docType = spec.procurementType === "MATERIAL_DEMAND" ? "MATERIAL_DEMAND" : "PR";
  for (let i = 0; i < 8; i += 1) {
    const approver = await currentApprover(docType, pr.id, f.entityId);
    if (!approver) break;
    await decidePr(approver, pr.id, "APPROVED", "Reviewed against the department budget and approved.", prisma);
  }

  /* Sourcing */
  const state = await prisma.purchaseRequisition.findUniqueOrThrow({ where: { id: pr.id } });
  if (state.status !== "SOURCING") await startSourcing(officer, pr.id, prisma);
  const rfq = await createRfq(
    officer,
    {
      prId: pr.id,
      title: `RFQ — ${spec.title}`,
      scope: spec.specification,
      terms: "Delivered to store, taxes inclusive, 30 days credit from GRN.",
      responseDeadline: day(6),
      vendorIds: f.vendorIds,
    },
    prisma,
  );
  await issueRfq(officer, rfq.id, prisma);
  if (spec.outcome === "AWAITING_QUOTES") {
    note(`${pr.number} → ${rfq.number} issued to ${f.vendorIds.length} vendors, awaiting responses`);
    return;
  }

  const prItem = await prisma.purchaseRequisitionItem.findFirstOrThrow({ where: { prId: pr.id } });
  const factors = [1, 1.062, 0.978];
  const compliance = ["COMPLIANT", "COMPLIANT", "PARTIAL"] as const;
  for (const [i, vendorId] of f.vendorIds.entries()) {
    await upsertQuote(
      buyer,
      {
        rfqId: rfq.id,
        vendorId,
        quoteRef: `${REF}-${rfq.number.slice(-4)}-${i + 1}`,
        deliveryDays: 6 + i * 4,
        paymentTerms: "30 days from GRN",
        creditDays: 30,
        warrantyMonths: spec.disposition === "ASSET" ? 36 : null,
        technicalCompliance: compliance[i],
        complianceNotes:
          compliance[i] === "PARTIAL"
            ? "Offers an equivalent rather than the specified make; certification incomplete."
            : "Meets the specification in full.",
        items: [
          {
            prItemId: prItem.id,
            itemId: f.itemId,
            description: prItem.description,
            quantity: spec.quantity,
            unit: f.unit,
            unitPrice: Math.round(spec.unitPrice * factors[i]),
            taxRate: 18,
            deliveryDays: 6 + i * 4,
            compliance: compliance[i],
          },
        ],
      },
      prisma,
    );
  }

  /* Negotiation on the front-runner, then the comparative */
  const quotes = await prisma.vendorQuote.findMany({
    where: { rfqId: rfq.id },
    include: { vendor: true },
    orderBy: { total: "asc" },
  });
  const negotiator = await withPermission(P.NEGOTIATE, f.entityId);
  const frontRunner = quotes.find((q) => q.technicalCompliance === "COMPLIANT") ?? quotes[0];
  await recordNegotiation(
    negotiator,
    {
      quoteId: frontRunner.id,
      negotiatedTotal: Math.round(frontRunner.total * 0.968),
      channel: "CALL",
      outcome: "ACCEPTED",
      notes: "Held two rounds on price and freight; vendor conceded on both against a firm delivery date.",
    },
    prisma,
  );

  const comparative = await buildComparative(
    officer,
    {
      rfqId: rfq.id,
      marketPrice: Math.round(spec.unitPrice * spec.quantity * 1.08),
      notes: "Scored on price, compliance, delivery, vendor record, warranty and terms.",
    },
    prisma,
  );
  const lines = await prisma.comparativeLine.findMany({
    where: { comparativeId: comparative.id },
    include: { vendor: true },
  });
  const compliant = lines.filter((l) => l.technicalCompliance === "COMPLIANT");
  const chosen = (compliant.length ? compliant : lines).sort((a, b) => a.netTotal - b.netTotal)[0];
  await recommendVendor(
    selector,
    {
      comparativeId: comparative.id,
      quoteId: chosen.quoteId,
      basis: "Lowest technically compliant quotation after negotiation, on a delivered tax-inclusive basis.",
    },
    prisma,
  );

  /* Committee */
  const requirement = await cpcRequirement(f.entityId, chosen.netTotal, spec.procurementType, prisma);
  if (requirement.required) {
    const kase = await createCpcCase(
      officer,
      {
        comparativeId: comparative.id,
        recommendation: `Award ${chosen.vendor.name} at PKR ${chosen.netTotal.toLocaleString("en-PK")}.`,
        riskNotes: "Price held for the delivery window; no advance requested.",
      },
      prisma,
    );
    if (spec.outcome === "AWAITING_CPC") {
      note(`${pr.number} → ${comparative.number} → ${kase.number} tabled, awaiting the committee`);
      return;
    }
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
        { caseId: kase.id, vote: "APPROVE", comment: "Compliant award, negotiation evidenced, price benchmarked." },
        prisma,
      );
    }
  } else if (spec.outcome === "AWAITING_CPC") {
    note(`${pr.number} → ${comparative.number} recommended (below the committee threshold)`);
    return;
  }

  /* Purchase order */
  const poCreator = await withPermission(P.PO_CREATE, f.entityId);
  const po = await createPoFromCase(
    poCreator,
    {
      prId: pr.id,
      deliveryStoreId: f.storeId,
      deliveryDate: day(12),
      paymentTerms: "30 days from GRN",
      creditDays: 30,
      warrantyTerms: spec.disposition === "ASSET" ? "36 months on-site, parts and labour." : null,
    },
    prisma,
  );
  await submitPoForApproval(poCreator, po.id, prisma);
  for (let i = 0; i < 8; i += 1) {
    const approver = await currentApprover("PO", po.id, f.entityId);
    if (!approver) break;
    await decidePo(approver, po.id, "APPROVED", "Terms and pricing verified against the comparative.", prisma);
  }
  await issuePo(poCreator, po.id, prisma);
  await recordSavingsForPo(systemActor("SEED"), po.id, prisma).catch(() => undefined);
  if (spec.outcome === "PO_ISSUED") {
    note(`${pr.number} → ${po.number} issued to ${chosen.vendor.name}, awaiting delivery`);
    return;
  }

  /* Receiving, inspection, GRN */
  const issued = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: po.id },
    include: { items: true, vendor: true },
  });
  const security = await withPermission(P.GATE_PASS_CREATE);
  const receiver = await withPermission(P.RECEIVE_GOODS, f.entityId);
  const gatePass = await createGatePass(
    security,
    {
      direction: "INWARD",
      poId: po.id,
      vendorId: issued.vendorId,
      storeId: f.storeId,
      vehicleNumber: `${f.entityCode}-${REF}-${issued.number.slice(-3)}`,
      driverName: "Abdul Ghafoor",
      deliveryNoteRef: `DN/${issued.number.slice(-5)}`,
      materialSummary: `${prItem.description} — ${spec.quantity} ${f.unit}`,
      declaredQuantity: spec.quantity,
    },
    prisma,
  );
  const received = await recordDelivery(
    receiver,
    {
      poId: po.id,
      gatePassId: gatePass.id,
      storeId: f.storeId,
      deliveryNoteRef: `DN/${issued.number.slice(-5)}`,
      totalPackages: Math.max(1, Math.round(spec.quantity / 20)),
      packagesVerified: Math.max(1, Math.round(spec.quantity / 20)),
      documentationComplete: true,
      remarks: "Quantities and condition verified against the delivery note at the gate.",
      items: issued.items.map((it) => ({
        poItemId: it.id,
        actualQty: it.quantity,
        acceptedQty: it.quantity,
        specificationMatch: true,
      })),
    },
    prisma,
  );

  const inspection = await prisma.inspection.findFirst({
    where: { deliveryId: received.delivery.id },
    include: { items: true },
  });
  if (inspection) {
    const inspector = await withPermission(P.INSPECTION_PERFORM);
    await recordInspection(
      inspector,
      {
        inspectionId: inspection.id,
        result: "APPROVED",
        findings: "Make, model and specification verified against the order and the vendor's certificates.",
        signedByName: inspector.name,
        items: inspection.items.map((it) => ({
          inspectionItemId: it.id,
          quantityPassed: it.quantityInspected || spec.quantity,
          quantityFailed: 0,
          verdict: "PASS" as const,
          notes: "Conforms to the specification.",
        })),
      },
      prisma,
    );
  }

  // Posting to inventory is a separate right from raising the GRN.
  const storeKeeper = await withPermissions([P.GRN_CREATE, P.GRN_POST], f.entityId);
  const deliveryItems = await prisma.deliveryItem.findMany({ where: { deliveryId: received.delivery.id } });
  const grn = await createGrn(
    storeKeeper,
    {
      deliveryId: received.delivery.id,
      storeId: f.storeId,
      remarks: "Taken into store against the verified delivery.",
      items: deliveryItems.map((di) => ({
        deliveryItemId: di.id,
        acceptedQty: di.acceptedQty,
        rejectedQty: 0,
        batchNumber: spec.disposition === "PROJECT_MATERIAL" ? `B-${REF}-${di.lineNo}` : null,
      })),
      post: true,
    },
    prisma,
  );

  if (spec.disposition === "ASSET") {
    try {
      const tagged = await tagAssetsFromGrn(storeKeeper, grn.id, prisma);
      const count = Array.isArray(tagged) ? tagged.length : 0;
      if (count) note(`${grn.number} raised ${count} tagged asset(s)`);
    } catch (e) {
      problem(`asset tagging for ${grn.number}`, e);
    }
  }

  if (spec.outcome === "AWAITING_INVOICE") {
    note(`${pr.number} → ${po.number} → ${grn.number} received, awaiting the vendor invoice`);
    return;
  }

  /* Invoice, three-way match, approval, payment */
  const financeUser = await withPermission(P.INVOICE_CREATE, f.entityId);
  const grnItems = await prisma.grnItem.findMany({ where: { grnId: grn.id }, include: { poItem: true } });
  const registered = await registerInvoice(
    financeUser,
    {
      poId: po.id,
      vendorInvoiceNumber: `${issued.vendor.code}/${REF}/${issued.number.slice(-4)}`,
      invoiceDate: day(-1),
      dueDate: day(29),
      items: grnItems.map((gi) => ({
        poItemId: gi.poItemId,
        description: gi.poItem?.description ?? prItem.description,
        quantity: gi.acceptedQty,
        unit: gi.poItem?.unit ?? f.unit,
        unitPrice: gi.poItem?.unitPrice ?? spec.unitPrice,
        taxRate: gi.poItem?.taxRate ?? 18,
      })),
      grnIds: [grn.id],
    },
    prisma,
  );
  if (!registered) throw new Error("The invoice was not returned after registration.");
  await verifyInvoice(financeUser, registered.id, prisma);

  const matched = await prisma.invoice.findUniqueOrThrow({ where: { id: registered.id } });
  if (matched.matchStatus !== "PASSED") {
    note(`${matched.number} held at ${matched.matchStatus} — ${matched.matchNotes ?? "see the match detail"}`);
    return;
  }

  const verifier = await withPermission(P.INVOICE_VERIFY, f.entityId);
  await submitInvoiceForApproval(verifier, registered.id, prisma);
  for (let i = 0; i < 8; i += 1) {
    const approver = await currentApprover("INVOICE", registered.id, f.entityId);
    if (!approver) break;
    await decideInvoice(approver, registered.id, "APPROVED", "Match passed; payment approved.", prisma);
  }

  const handoffUser = await withPermission(P.FINANCE_HANDOFF, f.entityId);
  const handoff = await handoffToFinance(
    handoffUser,
    registered.id,
    "Match passed against the posted GRN; released for payment on terms.",
    prisma,
  );
  const financeAck = await withPermission(P.FINANCE_ACK, f.entityId);
  await acknowledgeHandoff(
    financeAck,
    handoff.id,
    {
      paymentMethod: "BANK_TRANSFER",
      bankAccount: "Operating account — Meezan",
      scheduledDate: day(3),
      notes: "Scheduled in the next payment run.",
    },
    prisma,
  );
  const payer = await withPermission(P.PAYMENT_RECORD, f.entityId);
  await recordPayment(
    payer,
    handoff.id,
    { paymentReference: `FT-${REF}-${handoff.number.slice(-4)}`, paidDate: day(3), paymentMethod: "BANK_TRANSFER" },
    prisma,
  );

  const closer = await withPermission(P.PO_CLOSE, f.entityId);
  await closePo(closer, po.id, "Received in full, invoiced, matched and paid. Nothing outstanding.", prisma);
  note(`${pr.number} → ${po.number} → ${grn.number} → ${matched.number} paid and closed`);
}

/* ── Petty cash ───────────────────────────────────────────── */

type PettySpec = {
  entity: "ZM" | "ZD";
  purpose: string;
  categoryCode: string;
  disposition: "INVENTORY" | "CONSUMABLE" | "EXPENSE";
  quantity: number;
  unitPrice: number;
  hold?: "STORE_ENTRY";
};

const PETTY: PettySpec[] = [
  {
    entity: "ZM",
    purpose: "Emergency replacement of two failed UPS batteries in the server room",
    categoryCode: "IT-PERIPH",
    disposition: "INVENTORY",
    quantity: 2,
    unitPrice: 21_500,
  },
  {
    entity: "ZM",
    purpose: "Pantry and housekeeping top-up ahead of the board meeting",
    categoryCode: "PANTRY",
    disposition: "EXPENSE",
    quantity: 1,
    unitPrice: 18_400,
  },
  {
    entity: "ZD",
    purpose: "Site consumables for the night pour — gloves, tie wire and tarpaulin",
    categoryCode: "SAFETY",
    disposition: "INVENTORY",
    quantity: 30,
    unitPrice: 1_180,
    hold: "STORE_ENTRY",
  },
];

async function drivePettyCash(spec: PettySpec) {
  const entity = await prisma.entity.findFirstOrThrow({ where: { code: spec.entity } });
  const category = await prisma.category.findFirstOrThrow({ where: { code: spec.categoryCode } });
  const item = await prisma.item.findFirst({ where: { active: true, categoryId: category.id } });
  const store = await prisma.store.findFirstOrThrow({ where: { entityId: entity.id, active: true } });
  const department = await prisma.department.findFirstOrThrow({
    where: { entityId: entity.id, active: true },
    orderBy: { name: "asc" },
  });
  const requester = await withPermission(P.PETTY_CASH_CREATE, entity.id);
  const evaluator = await withPermission(P.PETTY_CASH_EVALUATE, entity.id);
  const approver = await withPermission(P.PETTY_CASH_APPROVE, entity.id);
  const reconciler = await withPermission(P.PETTY_CASH_RECONCILE, entity.id);
  const storeKeeper = await withPermission(P.GRN_CREATE, entity.id);

  // Petty cash is capped by configuration, so the ask is sized to the live limit
  // rather than to a number baked into this script.
  const limit = await getConfigNumber(CONFIG_KEYS.PETTY_CASH_LIMIT, entity.id, prisma);
  const unitPrice = Math.min(spec.unitPrice, Math.max(1, Math.floor((limit * 0.8) / spec.quantity)));
  const estimated = spec.quantity * unitPrice;
  if (estimated > limit) throw new Error(`Estimate PKR ${estimated} exceeds the petty cash limit of PKR ${limit}.`);

  const pc = await createPettyCash(
    requester,
    {
      entityId: entity.id,
      departmentId: department.id,
      purpose: spec.purpose,
      justification: "Needed same-day; too small and too urgent for the full requisition route.",
      requiredDate: day(1),
      storeId: spec.disposition === "EXPENSE" ? null : store.id,
      items: [
        {
          itemId: item?.id ?? null,
          description: spec.purpose.replace(/^[A-Z][a-z]+ (of |for )?/, ""),
          quantity: spec.quantity,
          unit: item?.unit ?? "EA",
          estimatedUnitPrice: unitPrice,
          disposition: spec.disposition,
        },
      ],
    },
    prisma,
  );

  await submitPettyCash(requester, pc.id, prisma);
  await beginQuoteCollection(evaluator, pc.id, prisma);
  const vendorNames = ["Al-Karam Traders", "City Hardware", "Metro Supply Co"];
  for (const [i, vendorName] of vendorNames.entries()) {
    await addPettyCashQuote(
      evaluator,
      {
        requestId: pc.id,
        vendorName,
        channel: i === 0 ? "WALK_IN" : "CALL",
        contactRef: `03${i}0-${REF}`,
        amount: Math.round(estimated * (1 + i * 0.06)),
        notes: i === 0 ? "Nearest supplier, stock on hand." : "Quoted over the phone, stock confirmed.",
      },
      prisma,
    );
  }
  const quotes = await prisma.pettyCashQuote.findMany({
    where: { requestId: pc.id },
    orderBy: { amount: "asc" },
  });
  await selectPettyCashQuote(
    evaluator,
    { requestId: pc.id, quoteId: quotes[0].id, justification: "Cheapest of three with stock available today." },
    prisma,
  );
  await approvePettyCash(
    approver,
    { requestId: pc.id, approve: true, reason: "Within the petty cash limit and properly quoted.", approvedAmount: quotes[0].amount },
    prisma,
  );
  await recordPurchase(
    approver,
    {
      requestId: pc.id,
      actualAmount: quotes[0].amount,
      purchasedFromVendor: quotes[0].vendorName,
      receiptRef: `RCPT/${REF}/${pc.number.slice(-4)}`,
    },
    prisma,
  );
  const voucher = await generateVoucher(approver, pc.id, prisma);
  await signVoucher(approver, { voucherId: voucher.id, approve: true, notes: "Receipt matches the approved quote." }, prisma);

  const afterVoucher = await prisma.pettyCashRequest.findUniqueOrThrow({ where: { id: pc.id } });
  if (afterVoucher.status === "STORE_ENTRY_PENDING") {
    if (spec.hold === "STORE_ENTRY") {
      note(`${pc.number} held at the store-entry gate — cash spent, goods not yet on the ledger`);
      return;
    }
    const items = await prisma.pettyCashItem.findMany({ where: { requestId: pc.id } });
    await completeStoreEntry(
      storeKeeper,
      {
        requestId: pc.id,
        storeId: store.id,
        lines: items
          .filter((it) => it.itemId)
          .map((it) => ({
            pettyCashItemId: it.id,
            itemId: it.itemId as string,
            quantity: it.quantity,
            unitCost: quotes[0].amount / Math.max(1, it.quantity),
          })),
      },
      prisma,
    );
  }
  await reconcilePettyCash(reconciler, pc.id, "Receipt, voucher and store entry all agree.", prisma);
  await closePettyCash(reconciler, pc.id, prisma);
  note(`${pc.number} closed · ${spec.purpose.slice(0, 52)}`);
}

/* ── Store operations ─────────────────────────────────────── */

async function driveStoreOperations() {
  const buckets = await prisma.inventoryItem.findMany({
    where: { quantity: { gt: 4 } },
    include: { item: true, store: { include: { entity: true } } },
    orderBy: { quantity: "desc" },
    take: 12,
  });
  if (!buckets.length) throw new Error("No stock on hand to issue or transfer.");

  /* Two issues out of the fullest buckets */
  for (const bucket of buckets.slice(0, 2)) {
    const entityId = bucket.store.entityId;
    const requester = await withPermission(P.STORE_ISSUE, entityId);
    const approver = await withPermission(P.STORE_ISSUE_APPROVE, entityId);
    const issuer = await withPermission(P.STORE_ISSUE, entityId);
    const department = await prisma.department.findFirstOrThrow({
      where: { entityId, active: true },
      orderBy: { name: "asc" },
    });
    const available = await availableQuantity(bucket.itemId, bucket.storeId, prisma);
    const qty = Math.max(1, Math.floor(Math.min(available, bucket.quantity) / 3));

    const issue = await createStoreIssue(
      requester,
      {
        storeId: bucket.storeId,
        recipientName: `${department.name} — ${requester.name}`,
        recipientUserId: requester.id,
        departmentId: department.id,
        purpose: `Consumption against ${department.name} operations`,
        items: [{ itemId: bucket.itemId, requestedQty: qty, unit: bucket.item.unit }],
        submit: true,
      },
      prisma,
    );
    await decideStoreIssue(
      approver,
      { issueId: issue.id, approve: true, reason: "Within the department's consumption pattern." },
      prisma,
    );
    await issueStock(issuer, { issueId: issue.id }, prisma);
    note(`${issue.number} issued ${qty} ${bucket.item.unit} of ${bucket.item.name} from ${bucket.store.name}`);
  }

  /* One inter-store transfer, dispatched and received */
  const source = buckets[0];
  const target = await prisma.store.findFirst({
    where: { entityId: source.store.entityId, active: true, id: { not: source.storeId } },
  });
  if (target) {
    const entityId = source.store.entityId;
    const requester = await withPermission(P.STORE_TRANSFER, entityId);
    const approver = await withPermission(P.STORE_TRANSFER_APPROVE, entityId);
    const available = await availableQuantity(source.itemId, source.storeId, prisma);
    const qty = Math.max(1, Math.floor(available / 4));
    if (qty > 0) {
      const transfer = await createTransfer(
        requester,
        {
          fromStoreId: source.storeId,
          toStoreId: target.id,
          reason: `Rebalancing stock towards ${target.name} where consumption is running ahead.`,
          items: [{ itemId: source.itemId, requestedQty: qty, unit: source.item.unit }],
          submit: true,
        },
        prisma,
      );
      await decideTransfer(approver, { transferId: transfer.id, approve: true, reason: "Rebalancing approved." }, prisma);
      await dispatchTransfer(
        requester,
        { transferId: transfer.id, vehicleNumber: `TRF-${REF}`, gatePassRef: `GP/TRF/${REF}` },
        prisma,
      );
      await receiveTransfer(
        await withPermission(P.RECEIVE_GOODS, entityId),
        { transferId: transfer.id, remarks: "Received complete, quantities verified against the dispatch note." },
        prisma,
      );
      note(`${transfer.number} moved ${qty} ${source.item.unit} ${source.store.name} → ${target.name}`);
    }
  }

  /* One counted adjustment, with a reason on the record */
  const countBucket = buckets[buckets.length - 1];
  const adjuster = await withPermission(P.INVENTORY_ADJUST, countBucket.store.entityId);
  await adjustStock(
    adjuster,
    {
      itemId: countBucket.itemId,
      storeId: countBucket.storeId,
      quantityDelta: -1,
      unit: countBucket.item.unit,
      reason: "Physical count variance of one unit confirmed by recount; written off with store manager sign-off.",
    },
    prisma,
  );
  note(`Stock adjustment recorded against ${countBucket.item.name} at ${countBucket.store.name}`);
}

/* ── Disposal ─────────────────────────────────────────────── */

async function driveDisposal() {
  const assets = await prisma.asset.findMany({
    where: { status: { in: ["IN_STORAGE", "UNDER_REPAIR", "ACTIVE"] } },
    include: { entity: true, item: true },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    take: 3,
  });
  if (!assets.length) throw new Error("No assets available to dispose of.");
  const entityId = assets[0].entityId;
  const pool = assets.filter((a) => a.entityId === entityId);

  const raiser = await withPermission(P.DISPOSAL_CREATE, entityId);
  const kase = await createDisposalCase(
    raiser,
    {
      entityId,
      title: "End-of-life IT equipment — batch disposal by sealed bid",
      disposalCategory: "SCRAP_SALE",
      recommendedAction: "SELL",
      assessmentNotes: "Beyond economic repair; no internal redeployment available.",
      estimatedValue: pool.length * 9_500,
      items: pool.map((a) => ({
        assetId: a.id,
        itemId: a.itemId,
        description: `${a.name} (${a.tag})`,
        quantity: 1,
        unit: "EA",
        condition: "UNSERVICEABLE",
        bookValue: a.currentValue ?? 0,
        estimatedValue: 9_500,
        notes: "Retained data wiped and certified before release.",
      })),
    },
    prisma,
  );

  const assessor = await withPermission(P.DISPOSAL_CREATE, entityId).catch(() => raiser);
  const auditor = await withPermission(P.DISPOSAL_AUDIT_REVIEW, entityId).catch(() => assessor);
  const approver = await withPermission(P.DISPOSAL_APPROVE, entityId).catch(() => auditor);
  const management = await withPermission(P.DISPOSAL_MANAGEMENT_APPROVE, entityId).catch(() => approver);

  await advanceDisposal(assessor, kase.id, "ASSESSMENT", {
    assessmentNotes: "Inspected by IT; boards failed, batteries swollen, no resale value as working units.",
  }, prisma);
  await advanceDisposal(auditor, kase.id, "AUDIT_REVIEW", {
    auditNotes: "Asset register entries, custody history and book values verified against the ledger.",
  }, prisma);
  await advanceDisposal(approver, kase.id, "PENDING_APPROVAL", { notes: "Tabled for disposal approval." }, prisma);
  await advanceDisposal(approver, kase.id, "APPROVED", { notes: "Approved for sealed-bid sale as scrap." }, prisma);
  await advanceDisposal(approver, kase.id, "BIDDING", { bidDeadline: day(7), notes: "Invited three scrap buyers." }, prisma);

  const bidder = await withPermission(P.DISPOSAL_APPROVE, entityId).catch(() => approver);
  const bids = [
    { bidderName: "Shahzad Scrap Traders", amount: pool.length * 9_100 },
    { bidderName: "Ravi Metal Recovery", amount: pool.length * 10_400 },
    { bidderName: "Lahore Salvage Co", amount: pool.length * 8_600 },
  ];
  for (const b of bids) {
    await addDisposalBid(
      bidder,
      { caseId: kase.id, bidderName: b.bidderName, amount: b.amount, contactPhone: `042-${REF}`, notes: "Sealed bid opened in committee." },
      prisma,
    );
  }
  const recorded = await prisma.disposalBid.findMany({ where: { caseId: kase.id }, orderBy: { amount: "desc" } });
  await advanceDisposal(approver, kase.id, "BID_EVALUATION", {
    notes: "Three sealed bids opened and tabulated.",
  }, prisma);
  await advanceDisposal(management, kase.id, "MANAGEMENT_APPROVAL", {
    notes: `Highest bid ${recorded[0].bidderName} at PKR ${recorded[0].amount.toLocaleString("en-PK")} recommended.`,
    winningBidId: recorded[0].id,
  }, prisma);
  await advanceDisposal(approver, kase.id, "PAYMENT_PENDING", { notes: "Award letter issued to the highest bidder." }, prisma);
  await advanceDisposal(approver, kase.id, "PAYMENT_RECEIVED", {
    notes: `Payment received in full, reference DEP-${REF}.`,
  }, prisma);
  await advanceDisposal(approver, kase.id, "COMPLETED", {
    finalAction: "SOLD",
    notes: "Goods released against a signed outward gate pass; asset register updated.",
  }, prisma);
  note(`${kase.number} completed — ${pool.length} asset(s) sold to ${recorded[0].bidderName}`);
}

/* ── Vendor governance ────────────────────────────────────── */

async function driveVendorGovernance() {
  const evaluator = await withPermission(P.VENDOR_EVALUATE);
  const approver = await withPermission(P.VENDOR_APPROVE);
  const criteria = await prisma.evaluationCriterion.findMany({ where: { active: true } });

  const prospects = await prisma.vendor.findMany({
    where: { status: { in: ["PROSPECT", "UNDER_EVALUATION", "PENDING_APPROVAL"] } },
    take: 2,
    orderBy: { name: "asc" },
  });
  for (const [i, vendor] of prospects.entries()) {
    // A strong candidate and a marginal one, so both outcomes exist in the data.
    const share = i === 0 ? 0.88 : 0.62;
    await evaluateVendor(
      evaluator,
      {
        vendorId: vendor.id,
        scores: criteria.map((c) => ({
          criterionId: c.id,
          score: Math.round(c.maxScore * share * 10) / 10,
          comment: i === 0 ? "Evidence provided and verified." : "Partial evidence; some gaps remain.",
        })),
        recommendation: i === 0 ? "APPROVE" : "CONDITIONAL",
        notes:
          i === 0
            ? "Documentation complete, references checked, capacity verified by site visit."
            : "Financials thin and only one verifiable reference; recommend a conditional start.",
        submit: true,
      },
      prisma,
    );
    const decision = i === 0 ? "APPROVE" : "CONDITIONAL";
    await decideVendorApproval(
      approver,
      {
        vendorId: vendor.id,
        decision,
        reason:
          i === 0
            ? "Scored above the pass mark with complete documentation; approved for sourcing."
            : "Scored above the pass mark but with gaps; approved conditionally with a six-month review.",
      },
      prisma,
    );
    note(`${vendor.name} pre-qualified and ${decision === "APPROVE" ? "approved" : "approved conditionally"}`);
  }

  /* An issue raised against a live order and worked through to closure */
  const raiser = await withPermission(P.VENDOR_ISSUE_RAISE);
  const late = await prisma.purchaseOrder.findFirst({
    where: { status: { in: ["PARTIALLY_RECEIVED", "ISSUED"] } },
    include: { vendor: true },
    orderBy: { createdAt: "desc" },
  });
  if (late) {
    const issue = await raiseVendorIssue(
      raiser,
      {
        vendorId: late.vendorId,
        issueType: "DELIVERY_DELAY",
        severity: "MEDIUM",
        title: `${late.vendor.name}: delivery running behind the agreed date on ${late.number}`,
        description:
          "Vendor missed the committed despatch window without notice and the site is waiting on the balance.",
        relatedPoId: late.id,
      },
      prisma,
    );
    await updateVendorIssue(
      raiser,
      issue.id,
      {
        status: "RESOLVED",
        vendorResponse: "Mill allocation slipped; balance despatched with a revised schedule and freight at their cost.",
        resolution: "Balance delivered against the revised schedule. Recorded on the vendor's performance history.",
      },
      prisma,
    );
    note(`${issue.number} raised against ${late.vendor.name} and resolved`);
  }

  await recomputeAllVendorPerformance(systemActor("SEED"), 12, prisma);
  note("Vendor performance recomputed from recorded transactions");
}

/* ── Saved views ──────────────────────────────────────────── */

async function driveSavedViews() {
  const owner = await withPermission(P.USER_MANAGE);
  // Resource keys, column keys and filter values below are the ones the registers
  // actually render, so every view applies rather than silently matching nothing.
  const views: Array<{ resource: string; name: string; config: Record<string, unknown> }> = [
    { resource: "prs", name: "Awaiting department approval", config: { filters: { status: "Under Department Approval" }, sort: { key: "required", dir: "asc" } } },
    { resource: "prs", name: "High priority", config: { filters: { priority: "High" }, sort: { key: "number", dir: "desc" } } },
    { resource: "prs", name: "Material demands", config: { filters: { type: "Material Demand (MD)" }, sort: { key: "number", dir: "desc" } } },
    { resource: "pos", name: "Issued orders", config: { filters: { status: "Issued" }, sort: { key: "number", dir: "desc" } } },
    { resource: "pos", name: "Partially received", config: { filters: { status: "Partially Received" }, sort: { key: "number", dir: "desc" } } },
    { resource: "open-pos", name: "Most overdue first", config: { sort: { key: "daysOverdue", dir: "desc" }, pageSize: 50 } },
    { resource: "invoices", name: "Failing the match", config: { filters: { matchStatus: "Failed" }, sort: { key: "invoiceDate", dir: "desc" } } },
    { resource: "invoices", name: "Blocked by an exception", config: { filters: { blocking: "Yes" }, sort: { key: "dueDate", dir: "asc" } } },
    { resource: "invoices", name: "Paid", config: { filters: { status: "Paid" }, sort: { key: "invoiceDate", dir: "desc" } } },
    { resource: "grns", name: "Posted, newest first", config: { filters: { status: "Posted" }, sort: { key: "receivedAt", dir: "desc" }, pageSize: 50 } },
    { resource: "receiving", name: "Awaiting inspection", config: { sort: { key: "date", dir: "desc" } } },
    { resource: "vendors", name: "Conditional approvals", config: { filters: { status: "Conditional" }, sort: { key: "name", dir: "asc" } } },
    { resource: "vendors", name: "Blacklisted", config: { filters: { status: "Blacklisted" }, sort: { key: "name", dir: "asc" } } },
    { resource: "vendors", name: "Traders", config: { filters: { type: "Trader" }, sort: { key: "name", dir: "asc" } } },
    { resource: "exceptions", name: "Blocking and open", config: { filters: { blocking: "Yes", status: "Open" }, sort: { key: "raised", dir: "asc" } } },
    { resource: "exceptions", name: "Quantity mismatches", config: { filters: { type: "Quantity Mismatch" }, sort: { key: "raised", dir: "desc" } } },
    { resource: "petty-cash", name: "Store entry outstanding", config: { filters: { storeEntry: "1 pending" }, sort: { key: "raised", dir: "asc" } } },
    { resource: "assets", name: "In storage", config: { filters: { status: "In Storage" }, sort: { key: "tag", dir: "asc" } } },
    { resource: "assets", name: "Under repair", config: { filters: { status: "Under Repair" }, sort: { key: "tag", dir: "asc" } } },
    { resource: "disposal", name: "Newest cases", config: { sort: { key: "raised", dir: "desc" } } },
  ];
  for (const v of views) {
    await prisma.savedView.upsert({
      where: { userId_resource_name: { userId: owner.id, resource: v.resource, name: v.name } },
      update: { config: JSON.stringify(v.config), isShared: true },
      create: { userId: owner.id, resource: v.resource, name: v.name, config: JSON.stringify(v.config), isShared: true },
    });
  }
  const resources = new Set(views.map((v) => v.resource));
  note(`${views.length} shared saved views across ${resources.size} registers`);
}

/* ── Document artefacts ───────────────────────────────────── */

function entityLabel(
  entities: Map<string, { code: string; name: string }>,
  entityId: string | null,
) {
  const e = entityId ? entities.get(entityId) : null;
  return e ? `${e.code} — ${e.name}` : "Group";
}

/**
 * Writes the file behind every document record that has none. Without this the
 * register lists documents nobody can open: the metadata exists but the stored
 * artefact never did.
 */
async function materialiseDocuments() {
  const docs = await prisma.document.findMany({
    include: { documentType: { select: { name: true } } },
    orderBy: { uploadedAt: "asc" },
  });
  // Documents carry an entity id rather than a relation.
  const entities = new Map(
    (await prisma.entity.findMany({ select: { id: true, code: true, name: true } })).map((e) => [e.id, e]),
  );

  const seen = new Set<string>();
  let written = 0;
  let realigned = 0;

  for (const doc of docs) {
    // Two records must never share one artefact, or a download would serve the
    // wrong paper.
    let storagePath = doc.storagePath;
    if (seen.has(storagePath)) {
      const ext = storagePath.includes(".") ? storagePath.split(".").pop() : "pdf";
      storagePath = `generated/${doc.linkedType.toLowerCase()}/${doc.id}.${ext}`;
      realigned += 1;
    }
    seen.add(storagePath);

    const exists = await objectExists(storagePath);
    if (exists && storagePath === doc.storagePath) continue;

    const context = [
      `Document type: ${doc.documentType?.name ?? doc.category}`,
      `Reference: ${doc.caseKey ?? doc.linkedType}`,
      `Entity: ${entityLabel(entities, doc.entityId)}`,
      `Classification: ${doc.confidentiality}`,
      `Linked to: ${doc.linkedType} ${doc.linkedId}`,
      "",
      ...(doc.description ? [doc.description] : []),
    ];

    let buf: Buffer;
    let mimeType = doc.mimeType;
    let originalFilename = doc.originalFilename;

    if (doc.mimeType.startsWith("image/")) {
      buf = buildJpeg();
      mimeType = "image/jpeg";
      originalFilename = originalFilename.replace(/\.[^.]+$/, "") + ".jpg";
    } else if (doc.mimeType.includes("spreadsheet") || doc.mimeType.includes("ms-excel") || doc.mimeType === "text/csv") {
      // A spreadsheet artefact is written as CSV, and the record is realigned to
      // match — the row must describe the file that actually exists.
      buf = buildCsv(
        ["Reference", "Description", "Unit", "Quantity", "Rate", "Amount"],
        [
          [doc.caseKey ?? "—", doc.name, "EA", 1, 0, 0],
          ["", "Prepared from the approved take-off. Figures carried into the requisition.", "", "", "", ""],
        ],
      );
      mimeType = "text/csv";
      originalFilename = originalFilename.replace(/\.[^.]+$/, "") + ".csv";
    } else {
      buf = buildPdf(doc.name, context);
      mimeType = "application/pdf";
      originalFilename = originalFilename.replace(/\.[^.]+$/, "") + ".pdf";
    }

    await putObject(storagePath, buf, mimeType);
    await prisma.document.update({
      where: { id: doc.id },
      data: {
        storagePath,
        mimeType,
        originalFilename,
        sizeBytes: buf.byteLength,
        checksum: createHash("sha256").update(buf).digest("hex"),
      },
    });
    written += 1;
  }

  note(`${written} document artefact(s) written to ${storageDescription()}`);
  if (realigned) note(`${realigned} document(s) moved off a shared storage path`);
}

/* ── Document access trail ────────────────────────────────── */

async function driveDocumentAccess() {
  const docs = await prisma.document.findMany({
    where: { archived: false },
    include: { documentType: true },
    orderBy: { uploadedAt: "desc" },
    take: 8,
  });
  const reader = await withPermissions([
    P.DOCUMENT_VIEW,
    P.DOCUMENT_VIEW_CONFIDENTIAL,
    P.DOCUMENT_VIEW_RESTRICTED,
  ]);
  let views = 0;
  for (const [i, doc] of docs.entries()) {
    try {
      await readDocument(reader, doc.id, i % 3 === 0 ? "DOWNLOAD" : "VIEW", "127.0.0.1");
      views += 1;
    } catch {
      /* Not visible to this reader — that refusal is itself logged. */
    }
  }

  // One deliberate attempt by somebody without document access, so the audit
  // screen shows a refusal as well as a trail of legitimate reads.
  const restricted = await prisma.document.findFirst({
    where: { archived: false, documentType: { viewPermission: { not: null } } },
    include: { documentType: true },
  });
  const gated = restricted?.documentType?.viewPermission ?? null;
  if (restricted && gated) {
    const outsider = await withoutPermissions(gated, P.DOCUMENT_VIEW_CONFIDENTIAL, P.DOCUMENT_VIEW_RESTRICTED);
    try {
      await readDocument(outsider, restricted.id, "VIEW", "127.0.0.1");
    } catch {
      note(`Access refusal logged: ${outsider.name} → ${restricted.name}`);
    }
  }
  note(`${views} document read(s) recorded on the access log`);
}

/* ── Main ─────────────────────────────────────────────────── */

async function main() {
  console.log("\nPopulating ProcurementOS end to end\n");

  section("Procurement cases");
  for (const spec of CASES) {
    try {
      await driveCase(spec);
    } catch (e) {
      problem(`case "${spec.title.slice(0, 44)}"`, e);
    }
  }

  section("Petty cash");
  for (const spec of PETTY) {
    try {
      await drivePettyCash(spec);
    } catch (e) {
      problem(`petty cash "${spec.purpose.slice(0, 44)}"`, e);
    }
  }

  section("Store operations");
  try {
    await driveStoreOperations();
  } catch (e) {
    problem("store operations", e);
  }

  section("Assets and disposal");
  try {
    await driveDisposal();
  } catch (e) {
    problem("disposal", e);
  }

  section("Vendor governance");
  try {
    await driveVendorGovernance();
  } catch (e) {
    problem("vendor governance", e);
  }

  section("Saved views");
  try {
    await driveSavedViews();
  } catch (e) {
    problem("saved views", e);
  }

  section("Documents");
  try {
    await materialiseDocuments();
  } catch (e) {
    problem("document artefacts", e);
  }

  section("Document access");
  try {
    await driveDocumentAccess();
  } catch (e) {
    problem("document access", e);
  }

  console.log(`\n${created.length} item(s) written.`);
  if (problems.length) {
    console.log(`\n${problems.length} step(s) did not complete:`);
    for (const p of problems) console.log(`  · ${p}`);
  }
  await prisma.$disconnect();
  process.exit(problems.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`\nPopulation failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  await prisma.$disconnect();
  process.exit(1);
});
