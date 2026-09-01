/**
 * A Zameen Media case driven end to end, then every form printed from it.
 *
 * The acceptance run (`scripts/acceptance.ts`) proves the refusals: a short
 * delivery, an over-billed invoice, a payment blocked. This one proves the
 * opposite — a case that goes cleanly all the way through — and then prints each
 * SOP form from the records it produced, so the forms can be read rather than
 * taken on trust.
 *
 *   npx tsx scripts/lifecycle-forms.ts
 *   npx tsx scripts/lifecycle-forms.ts --pr=PR-2026-00034   # resume that case
 *
 * The run is slow because it is real: every stage is a transaction against a
 * remote database, and a case above the committee threshold climbs three
 * approval ladders and a committee vote. `--pr` picks up an existing case and
 * skips whatever it has already done, which is what makes iterating on the
 * later stages bearable.
 *
 * Nothing is fabricated for the printing. Every field below is read back out of
 * the database through the same functions the pages call.
 */
import { writeSync } from "node:fs";
import { prisma } from "../src/lib/db";
import type { SessionUser } from "../src/lib/rbac";
import { PERMISSIONS as P } from "../src/lib/permissions";
import { currentApprover, sessionFor, withPermission, withPermissions } from "./lib/actors";
import { createPr, submitPr, decidePr, startSourcing } from "../src/server/pr";
import { buildComparative, createRfq, issueRfq, recommendVendor, upsertQuote } from "../src/server/sourcing";
import { castCpcDecision, cpcRequirement, createCpcCase } from "../src/server/cpc";
import {
  createPoFromCase,
  decidePo,
  issuePo,
  recordPoAcknowledgement,
  recordPoDistribution,
  submitPoForApproval,
} from "../src/server/po";
import {
  annexure4Signatures,
  createGatePass,
  recordDelivery,
  recordInspection,
  signAnnexure4,
} from "../src/server/receiving";
import { signOffInspection, signoffsFor } from "../src/server/inspection-matrix";
import { createGrn } from "../src/server/grn";
import { handoffToFinance, registerInvoice, verifyInvoice } from "../src/server/invoice";
import { paymentPack, verifyPackItem } from "../src/server/payment-pack";
import { escalateOverdueApprovals, escalateOverdueExceptions } from "../src/server/controls";
import { attestationBlock } from "../src/server/attestation";
import { systemActor } from "../src/lib/actor";
import { availableQuantity } from "../src/server/inventory";

/** `--pr=PR-2026-00034` resumes that case instead of raising a new one. */
const RESUME = (process.argv.find((a) => a.startsWith("--pr=")) ?? "").slice(5).trim() || null;

const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const QTY = 6;
const UNIT_PRICE = 385_000;

/**
 * Unbuffered output.
 *
 * Redirecting this run to a file buffers `console.log`, so a run that takes half
 * an hour shows nothing until it exits — which made a wedged run and a slow one
 * look identical, and cost real time to tell apart. `writeSync` on fd 1 goes
 * straight out.
 */
const say = (line: string) => {
  try {
    writeSync(1, `${line}
`);
  } catch {
    console.log(line);
  }
};

let failures = 0;
let step = 0;

function check(label: string, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  say(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(56)} ${detail}`);
}
function stage(title: string) {
  step += 1;
  say(`\n${String(step).padStart(2, "0")}. ${title}`);
}

/* ── Printing helpers ─────────────────────────────────────── */

const money = (n: number) =>
  n.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "—");
const stamp = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "—");

function form(title: string, ref: string) {
  const head = `${title}  ·  ${ref}`;
  say(`\n\n${"═".repeat(78)}\n  ${head}\n${"═".repeat(78)}`);
}
function pairs(rows: Array<[string, string]>) {
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v] of rows) say(`  ${k.padEnd(w)} : ${v}`);
}
function table(headers: string[], widths: number[], rows: string[][]) {
  const line = (cells: string[]) =>
    "  " + cells.map((c, i) => (i >= 3 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("  ");
  say(line(headers));
  say("  " + widths.map((w) => "─".repeat(w)).join("  "));
  for (const r of rows) say(line(r));
}
function sig(label: string, name: string | null, designation: string | null, when: string) {
  say(`  ${label}`);
  say(`    ${"_".repeat(34)}`);
  say(`    ${name ?? "(unsigned)"}${designation ? `, ${designation}` : ""}   ${when}`);
}

/**
 * Somebody who holds a named role *and* may perform inspections.
 *
 * Falls back to the sanctioned override - a user with INSPECTION_SCHEDULE, which
 * the domain accepts in place of the named function - rather than to any
 * inspector, because that fallback is a policy decision the domain already made
 * and this run should exercise it rather than invent its own.
 */
async function signerHolding(roleCode: string | null, entityId: string): Promise<SessionUser | null> {
  if (roleCode) {
    const held = await prisma.user.findFirst({
      where: {
        active: true,
        roles: { some: { role: { code: roleCode } } },
        OR: [{ primaryEntityId: entityId }, { entityAccess: { some: { entityId } } }],
      },
      select: { email: true },
      orderBy: { email: "asc" },
    });
    if (held) {
      const session = await sessionFor(held.email);
      if (session.permissions.includes(P.INSPECTION_PERFORM)) return session;
    }
  }
  return withPermissions([P.INSPECTION_PERFORM, P.INSPECTION_SCHEDULE], entityId).catch(() => null);
}

async function main() {
  say(`\nZameen Media — one case, end to end, then its forms\n`);
  say(`  Run ${RUN}`);

  /* ── Fixtures, all resolved from live data ───────────── */
  const entity = await prisma.entity.findFirstOrThrow({ where: { code: "ZM" } });
  const [department, store] = await Promise.all([
    prisma.department.findFirstOrThrow({
      where: { entityId: entity.id, active: true },
      orderBy: { name: "asc" },
    }),
    prisma.store.findFirstOrThrow({
      where: { entityId: entity.id, active: true, code: "ST-ZM-IT" },
    }),
  ]);
  // IT equipment: the category requires inspection, so Annexure 4 is genuinely
  // raised, and the SOP's chart routes its technical and qualitative checks to
  // IT rather than to the store — which is the whole point of the chart being
  // per-category.
  const item = await prisma.item.findFirstOrThrow({
    where: { active: true, category: { code: "IT-EQUIP" } },
    include: { category: true },
    orderBy: { sku: "asc" },
  });
  const vendors = await prisma.vendor.findMany({
    where: { status: "APPROVED", entityLinks: { some: { entityId: entity.id, approved: true } } },
    take: 3,
    orderBy: { name: "asc" },
  });
  if (vendors.length < 3) throw new Error("The run needs three approved Zameen Media vendors.");

  // Resolved together rather than one after another. Each lookup joins users
  // through roles to permissions and costs about five seconds against this
  // database; eleven of them in series was a minute of doing nothing before the
  // first stage even started.
  const [
    requester,
    officer,
    buyer,
    selector,
    poCreator,
    security,
    receiver,
    inspector,
    storeKeeper,
    financeUser,
    auditor,
  ] = await Promise.all([
    withPermission(P.PR_CREATE, entity.id),
    withPermission(P.RFQ_ISSUE, entity.id),
    withPermission(P.QUOTE_ENTER, entity.id),
    withPermission(P.VENDOR_SELECT, entity.id),
    withPermission(P.PO_CREATE, entity.id),
    withPermission(P.GATE_PASS_CREATE),
    withPermission(P.RECEIVE_GOODS, entity.id),
    withPermission(P.INSPECTION_PERFORM),
    withPermissions([P.GRN_CREATE, P.GRN_POST], entity.id),
    withPermission(P.INVOICE_CREATE, entity.id),
    withPermission(P.EXCEPTION_MANAGE),
  ]);

  say(
    `  ${entity.name} · ${department.name} · ${store.name}\n` +
      `  ${item.sku} ${item.name} (${item.category.name}) · ${QTY} ${item.unit} at ${money(UNIT_PRICE)}`,
  );

  /* ── 1 · Requisition ─────────────────────────────────── */
  stage("Requisition — raised, submitted, approved through its chain");

  const resumed = RESUME
    ? await prisma.purchaseRequisition.findFirst({
        where: { number: RESUME },
        select: { id: true, number: true, status: true },
      })
    : null;
  if (RESUME && !resumed) throw new Error(`No requisition numbered ${RESUME}.`);
  if (resumed) {
    say(`  Resuming ${resumed.number} at ${resumed.status} — earlier stages are already on the record.`);
  }

  const pr = resumed ?? (await createPr(requester, {
    entityId: entity.id,
    departmentId: department.id,
    procurementType: "ON_DEMAND",
    procurementKind: "GOODS",
    title: `Lifecycle run ${RUN} — ${item.name}, ${QTY} ${item.unit}`,
    justification:
      "Reserve stock has fallen to the minimum level and the current consumption rate clears it inside the month.",
    deliveryStoreId: store.id,
    requiredLocation: `${store.name} — floor store`,
    documentComments: "Raised against the monthly stock review; no substitute brand is acceptable.",
    requiredDate: new Date(Date.now() + 14 * 86_400_000),
    priority: "NORMAL",
    items: [
      {
        itemId: item.id,
        categoryId: item.categoryId,
        description: item.name,
        specification: "As per catalogue specification; sealed packaging.",
        quantity: QTY,
        unit: item.unit,
        estimatedUnitPrice: UNIT_PRICE,
        itemCode: item.sku,
        requiredDate: new Date(Date.now() + 14 * 86_400_000),
      },
    ],
  }));
  check(
    resumed ? "requisition resumed from the record" : "requisition created",
    resumed ? true : pr.status === "DRAFT",
    `${pr.number} · ${pr.status}`,
  );

  let guard = 0;
  if (!resumed) {
    await submitPr(requester, pr.id, prisma);
    while (guard++ < 8) {
      const next = await currentApprover("PR", pr.id, entity.id);
      if (!next) break;
      await decidePr(next, pr.id, "APPROVED", `Approved on lifecycle run ${RUN}.`, prisma);
    }
  }
  const approvedPr = await prisma.purchaseRequisition.findUniqueOrThrow({ where: { id: pr.id } });
  // A resumed case is normally well past approval, so the check is that it got
  // there — not that it is sitting on the doorstep.
  const PAST_APPROVAL = [
    "APPROVED",
    "PROCUREMENT_REVIEW",
    "SOURCING",
    "CPC_REVIEW",
    "PO_PREPARATION",
    "PO_ISSUED",
    "PARTIALLY_RECEIVED",
    "RECEIVED",
    "CLOSED",
  ];
  check(
    "requisition approved and its signature captured",
    PAST_APPROVAL.includes(approvedPr.status),
    `${approvedPr.number} · ${approvedPr.status}`,
  );

  /* ── 2 · Sourcing ────────────────────────────────────── */
  stage("Sourcing — RFQ to three vendors, three quotations");
  const heldRfq = await prisma.rfq.findFirst({
    where: { prId: pr.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, number: true, status: true, _count: { select: { quotes: true } } },
  });
  if (heldRfq && heldRfq._count.quotes >= 3) {
    check(
      "sourcing already on the record",
      true,
      `${heldRfq.number} · ${heldRfq._count.quotes} quotation(s)`,
    );
  }
  const skipSourcing = Boolean(heldRfq && heldRfq._count.quotes >= 3);

  if (!skipSourcing && approvedPr.status !== "SOURCING") {
    // A resumed case may already be past sourcing, in which case the transition
    // is refused and rightly so. That is not a failure of the run.
    await startSourcing(officer, pr.id, prisma).catch(() => undefined);
  }
  const rfq = skipSourcing
    ? heldRfq!
    : await createRfq(
    officer,
    {
      prId: pr.id,
      title: `RFQ — lifecycle run ${RUN}`,
      scope: `Supply of ${QTY} ${item.unit} ${item.name} to ${store.name}.`,
      responseDeadline: new Date(Date.now() + 5 * 86_400_000),
      vendorIds: vendors.map((v) => v.id),
    },
    prisma,
  );
  if (!skipSourcing) await issueRfq(officer, rfq.id, prisma);

  const prItem = await prisma.purchaseRequisitionItem.findFirstOrThrow({ where: { prId: pr.id } });
  const prices = [UNIT_PRICE * 1.06, UNIT_PRICE, UNIT_PRICE * 1.02];
  for (const [i, vendor] of skipSourcing ? [] : vendors.entries()) {
    await upsertQuote(
      buyer,
      {
        rfqId: rfq.id,
        vendorId: vendor.id,
        quoteRef: `Q/${RUN}/${i + 1}`,
        deliveryDays: 5 + i * 2,
        paymentTerms: "30 days from GRN",
        creditDays: 30,
        technicalCompliance: "COMPLIANT",
        complianceNotes: "Meets the catalogue specification.",
        items: [
          {
            prItemId: prItem.id,
            itemId: item.id,
            description: prItem.description,
            quantity: QTY,
            unit: item.unit,
            unitPrice: Math.round(prices[i]),
            taxRate: 18,
            deliveryDays: 5 + i * 2,
            compliance: "COMPLIANT",
          },
        ],
      },
      prisma,
    );
  }
  if (!skipSourcing) {
    check("three quotations recorded", true, `Q/${RUN}/1-3 from ${vendors.map((v) => v.name).join(", ")}`);
  }

  /* ── 3 · Comparative ─────────────────────────────────── */
  stage("Comparative — the lowest compliant quotation wins");
  const heldComparative = await prisma.comparative.findFirst({
    where: { prId: pr.id },
    orderBy: { updatedAt: "desc" },
  });
  const selectedCount = heldComparative
    ? await prisma.comparativeLine.count({ where: { comparativeId: heldComparative.id, isSelected: true } })
    : 0;
  const comparativeDone = Boolean(heldComparative && selectedCount > 0);
  const comparative = comparativeDone
    ? heldComparative!
    : await buildComparative(
        officer,
        { rfqId: rfq.id, notes: `Comparative for lifecycle run ${RUN}.` },
        prisma,
      );
  const lines = await prisma.comparativeLine.findMany({
    where: { comparativeId: comparative.id },
    include: { vendor: true },
  });
  const award = comparativeDone
    ? lines.find((l) => l.isSelected)!
    : lines.filter((l) => l.technicalCompliance === "COMPLIANT").sort((a, b) => a.netTotal - b.netTotal)[0];
  if (!comparativeDone)
    await recommendVendor(
    selector,
    {
      comparativeId: comparative.id,
      quoteId: award.quoteId,
      basis: "Lowest technically compliant quotation on a delivered, tax-inclusive basis.",
    },
    prisma,
  );
  check(
    comparativeDone ? "award already on the record" : "award recorded against the lowest compliant vendor",
    true,
    `${award.vendor.name} at ${money(award.netTotal)}`,
  );

  /* ── 4 · Committee, if the value requires it ─────────── */
  stage("Committee — applied only if the configured threshold is crossed");
  const requirement = await cpcRequirement(entity.id, award.netTotal, "ON_DEMAND", prisma);
  check(
    "committee requirement derived from configuration",
    true,
    `${requirement.required ? "required" : "not required"} — ${requirement.reason}`,
  );
  const heldCase = await prisma.cpcCase.findFirst({
    where: { prId: pr.id, status: { notIn: ["REJECTED"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, number: true, status: true },
  });
  if (heldCase) {
    check("committee case already on the record", true, `${heldCase.number} · ${heldCase.status}`);
  }
  if (requirement.required && !heldCase) {
    const kase = await createCpcCase(
      officer,
      {
        comparativeId: comparative.id,
        recommendation: `Award ${award.vendor.name} at ${money(award.netTotal)}.`,
        riskNotes: "Routine stock replenishment; no single-source risk.",
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
        { caseId: kase.id, vote: "APPROVE", comment: "Compliant award at the benchmark price." },
        prisma,
      );
    }
    const decided = await prisma.cpcCase.findUniqueOrThrow({ where: { id: kase.id } });
    check("committee approved by recorded votes", decided.status === "APPROVED", `${decided.number}`);
  }

  /* ── 5 · Purchase order ──────────────────────────────── */
  stage("Purchase order — approved, signed, issued, distributed, acknowledged");
  const heldPo = await prisma.purchaseOrder.findFirst({
    where: { prId: pr.id, status: { notIn: ["CANCELLED"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, number: true, status: true },
  });
  const poDone = Boolean(heldPo && ["ISSUED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CLOSED"].includes(heldPo.status));
  const po = poDone
    ? heldPo!
    : heldPo ?? (await createPoFromCase(
    poCreator,
    {
      prId: pr.id,
      deliveryStoreId: store.id,
      deliveryDate: new Date(Date.now() + 10 * 86_400_000),
      paymentTerms: "30 days from GRN",
      creditDays: 30,
      warrantyTerms: "Manufacturer warranty as supplied.",
    },
    prisma,
  ));

  if (!poDone) {
    await submitPoForApproval(poCreator, po.id, prisma).catch(() => undefined);
    guard = 0;
    while (guard++ < 8) {
      const next = await currentApprover("PO", po.id, entity.id);
      if (!next) break;
      await decidePo(next, po.id, "APPROVED", `Approved on lifecycle run ${RUN}.`, prisma);
    }
    await issuePo(poCreator, po.id, prisma);
    await recordPoDistribution(
      poCreator,
      { poId: po.id, channel: "EMAIL", reference: `mail/${RUN}/po` },
      prisma,
    );
    await recordPoAcknowledgement(
      poCreator,
      {
        poId: po.id,
        state: "ACKNOWLEDGED",
        byName: `${award.vendor.name} — sales desk`,
        notes: "Confirmed quantity, rate and delivery date by return email.",
      },
      prisma,
    );
  }
  const issued = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: po.id },
    include: { items: true, authorisedSignatory: true },
  });
  check(
    "order issued with a named signatory and a vendor confirmation",
    issued.status === "ISSUED" && Boolean(issued.authorisedSignatoryId) && issued.acknowledgementStatus === "ACKNOWLEDGED",
    `${issued.number} · signed by ${issued.authorisedSignatory?.name} · ${issued.acknowledgementStatus}`,
  );

  /* ── 6 · Receiving ───────────────────────────────────── */
  stage("Receiving — gate pass, delivery in full, inspection signed by each concern");
  const heldDelivery = await prisma.delivery.findFirst({
    where: { poId: po.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, number: true, gatePassId: true },
  });
  const gatePass = heldDelivery?.gatePassId
    ? await prisma.gatePass.findUniqueOrThrow({ where: { id: heldDelivery.gatePassId } })
    : await createGatePass(
    security,
    {
      direction: "INWARD",
      poId: po.id,
      vendorId: issued.vendorId,
      storeId: store.id,
      vehicleNumber: `LEA-${RUN.slice(-4)}`,
      driverName: "Abdul Rehman",
      deliveryNoteRef: `DN/${RUN}`,
      materialSummary: `${item.name} — ${QTY} ${item.unit} declared`,
      declaredQuantity: QTY,
    },
    prisma,
  );
  const poItem = issued.items[0];
  const received = heldDelivery
    ? { delivery: heldDelivery }
    : await recordDelivery(
    receiver,
    {
      poId: po.id,
      gatePassId: gatePass.id,
      storeId: store.id,
      deliveryNoteRef: `DN/${RUN}`,
      totalPackages: 8,
      packagesVerified: 8,
      documentationComplete: true,
      remarks: "Delivered in full; packaging intact.",
      items: [
        {
          poItemId: poItem.id,
          actualQty: QTY,
          acceptedQty: QTY,
          specificationMatch: true,
        },
      ],
    },
    prisma,
  );
  const delivery = received.delivery;
  check(
    heldDelivery ? "delivery already on the record" : "delivery recorded in full against the order",
    true,
    `${delivery.number} · ${QTY} ${item.unit}`,
  );

  const inspection = await prisma.inspection.findFirst({
    where: { deliveryId: delivery.id },
    include: { items: true },
  });
  if (inspection) {
    // Each named concern from the SOP's chart signs its own line first — the
    // inspection cannot close while one is blank.
    const signoffs = await signoffsFor(inspection.id, prisma);
    for (const s of signoffs) {
      // The chart names a *function* per check and the domain refuses a signer
      // from anywhere else, which is the whole point of the chart. So each
      // signature is taken from somebody who holds that function's role, the way
      // a real deployment would route it.
      const signer = await signerHolding(s.ownerRoleCode, entity.id);
      if (!signer) {
        say(`        (${s.typeLabel}: nobody holds ${s.ownerRoleCode ?? s.ownerLabel})`);
        continue;
      }
      await signOffInspection(
        signer,
        { signoffId: s.id, verdict: "PASS", notes: `${s.typeLabel} verified on run ${RUN}.` },
        prisma,
      ).catch((e) => {
        say(`        (${s.typeLabel}: ${e instanceof Error ? e.message.slice(0, 90) : e})`);
      });
      say(`        ${s.typeLabel.padEnd(14)} signed by ${signer.name} (${s.ownerLabel})`);
    }
    const after = await signoffsFor(inspection.id, prisma);
    check(
      "every concern named by the SOP's chart has signed",
      after.every((s) => s.signedAt !== null),
      after.map((s) => `${s.typeLabel}=${s.signedAt ? "signed" : "blank"}`).join(" · "),
    );

    // An inspection already closed is not re-closed. The domain refuses it and
    // is right to — a second approval of the same inspection would be a second
    // set of numbers on a form somebody already signed.
    const inspectionOpen = !["APPROVED", "REJECTED"].includes(inspection.result ?? "");
    if (inspectionOpen)
      await recordInspection(
      inspector,
      {
        inspectionId: inspection.id,
        result: "APPROVED",
        findings: "Quantity counted, packaging and specification verified against the order.",
        signedByName: inspector.name,
        items: inspection.items.map((it) => ({
          inspectionItemId: it.id,
          quantityPassed: it.quantityInspected || QTY,
          quantityFailed: 0,
          verdict: "PASS" as const,
          notes: "Conforms.",
        })),
      },
      prisma,
    );
    if (!inspectionOpen) {
      check("inspection already closed on the record", true, `${inspection.number} · ${inspection.result}`);
    }
    // Annexure 4's two blocks are two different signatures.
    await signAnnexure4(receiver, { inspectionId: inspection.id, block: "LOGISTICS" }, prisma).catch(
      (e) => say(`        (logistics block: ${e instanceof Error ? e.message.slice(0, 90) : e})`),
    );
  }

  /* ── 7 · Goods receipt ───────────────────────────────── */
  stage("Goods receipt — posted to inventory for what was accepted");
  const stockBefore = item.id ? await availableQuantity(item.id, store.id, prisma) : 0;
  const deliveryItem = await prisma.deliveryItem.findFirstOrThrow({ where: { deliveryId: delivery.id } });
  const heldGrn = await prisma.grn.findFirst({
    where: { deliveryId: delivery.id, status: { not: "CANCELLED" } },
    orderBy: { createdAt: "desc" },
    select: { id: true, number: true, status: true },
  });
  const grn = heldGrn ?? (await createGrn(
    storeKeeper,
    {
      deliveryId: delivery.id,
      storeId: store.id,
      remarks: `Lifecycle run ${RUN}.`,
      items: [
        {
          deliveryItemId: deliveryItem.id,
          acceptedQty: QTY,
          rejectedQty: 0,
          // A laptop is serialised, so the receipt needs one serial per unit.
          // The domain refuses the receipt otherwise, which is the point: an
          // asset register built from a count rather than from serials cannot
          // tell you which machine is where.
          serialNumbers: Array.from({ length: QTY }, (_, i) => `${RUN}-SN-${String(i + 1).padStart(3, "0")}`).join(", "),
        },
      ],
      post: true,
    },
    prisma,
  ));
  const posted = await prisma.grn.findUniqueOrThrow({ where: { id: grn.id }, include: { items: true } });
  const stockAfter = await availableQuantity(item.id, store.id, prisma);
  check(
    "receipt posted and inventory moved by exactly that quantity",
    posted.status === "POSTED" && Math.abs(stockAfter - stockBefore - QTY) < 0.001,
    `${posted.number} · ${stockBefore} → ${stockAfter} ${item.unit}`,
  );

  /* ── 8 · Invoice, pack and payment ───────────────────── */
  stage("Invoice — matched, Annexure A assembled, handed to finance");
  const heldInvoice = await prisma.invoice.findFirst({
    where: { poId: po.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, number: true },
  });
  const registered = heldInvoice ?? (await registerInvoice(
    financeUser,
    {
      poId: po.id,
      vendorInvoiceNumber: `LC/${RUN}/INV`,
      invoiceDate: new Date(),
      dueDate: new Date(Date.now() + 30 * 86_400_000),
      items: [
        {
          poItemId: poItem.id,
          description: poItem.description,
          quantity: QTY,
          unit: poItem.unit,
          unitPrice: poItem.unitPrice,
          taxRate: poItem.taxRate ?? 18,
        },
      ],
      grnIds: [grn.id],
    },
    prisma,
  ));
  if (!registered) throw new Error("Invoice registration returned nothing.");
  await verifyInvoice(financeUser, registered.id, prisma).catch(() => undefined);
  const matched = await prisma.invoice.findUniqueOrThrow({ where: { id: registered.id } });
  check(
    "three-way match passes on a correctly billed invoice",
    matched.matchStatus === "PASSED",
    `${matched.number} · match ${matched.matchStatus} · ${matched.status}`,
  );

  // The pack populates itself from the chain; the conditional documents are
  // answered, then each held document is checked by a person.
  let pack = await paymentPack(
    "INVOICE",
    matched.id,
    { entityId: entity.id, transactionType: issued.procurementKind },
    prisma,
  );
  check(
    "Annexure A populated from the records behind the invoice",
    pack.items.filter((i) => i.satisfiedBy === "RECORD").length >= 4,
    pack.items
      .filter((i) => i.satisfiedBy === "RECORD")
      .map((i) => `${i.documentTypeCode}=${i.records.map((r) => r.ref).join(",")}`)
      .join(" · "),
  );

  const verifier = await withPermission(P.INVOICE_VERIFY, entity.id);
  for (const it of pack.items.filter((i) => i.present && !i.verified)) {
    await verifyPackItem(
      verifier,
      { documentType: "INVOICE", documentId: matched.id, documentTypeCode: it.documentTypeCode },
      prisma,
    );
  }
  pack = await paymentPack(
    "INVOICE",
    matched.id,
    { entityId: entity.id, transactionType: issued.procurementKind },
    prisma,
  );
  check(
    "each held document is checked against a named person",
    pack.unverified.length === 0,
    pack.items
      .filter((i) => i.verified)
      .map((i) => `${i.documentTypeCode} by ${i.verifiedByName}`)
      .join(" · "),
  );

  const handoff = await handoffToFinance(
    await withPermission(P.FINANCE_HANDOFF, entity.id),
    matched.id,
    `Lifecycle run ${RUN} — match passed and the document pack is complete.`,
    prisma,
  ).catch((e) => {
    say(`        (handoff: ${e instanceof Error ? e.message.slice(0, 120) : e})`);
    return null;
  });
  check(
    "payment handed to finance once the match and the pack are clean",
    Boolean(handoff),
    handoff ? `${handoff.number} · ${money(handoff.amount)}` : "refused",
  );

  /* ── 9 · Escalation ──────────────────────────────────── */
  stage("Escalation — an unacknowledged exception climbs the organogram");
  // Any exception this case raised, aged past its due date so the sweep sees it.
  const ex = await prisma.exception.findFirst({
    where: { caseKey: pr.number, status: { in: ["OPEN", "IN_PROGRESS"] } },
    orderBy: { createdAt: "desc" },
    include: { owner: { select: { name: true, reportsToId: true } } },
  });
  if (!ex) {
    say("        (this case raised no exception — a clean run raises none, which is the point)");
    // Nothing to escalate from this case. Show the sweep against whatever else
    // stands overdue, so the mechanism is still exercised on real rows.
    const swept = await escalateOverdueExceptions(auditor, {}, prisma);
    check(
      "escalation sweep ran against the open book",
      true,
      `${swept.escalated} escalated · ${swept.stuck} with nobody above them · ${swept.notified} notified`,
    );
  } else {
    const ownerName = ex.owner?.name ?? "unassigned";
    const hasLine = Boolean(ex.owner?.reportsToId);
    await prisma.exception.update({
      where: { id: ex.id },
      data: { dueAt: new Date(Date.now() - 3 * 86_400_000), acknowledgedAt: null },
    });
    const swept = await escalateOverdueExceptions(auditor, {}, prisma);
    const after = await prisma.exception.findUniqueOrThrow({
      where: { id: ex.id },
      include: { escalatedTo: { select: { name: true, title: true } } },
    });
    check(
      hasLine ? "the overdue exception escalated to the owner's manager" : "no reporting line above the owner, reported not hidden",
      hasLine ? after.escalationLevel > ex.escalationLevel : swept.stuck > 0,
      hasLine
        ? `${after.number} · level ${ex.escalationLevel} → ${after.escalationLevel} · ${ownerName} → ${after.escalatedTo?.name}`
        : `${after.number} · owner ${ownerName} reports to nobody · ${swept.stuck} stuck`,
    );
    say(
      `        sweep: ${swept.escalated} escalated, ${swept.stuck} stuck, ${swept.notified} notified`,
    );
  }


  /* ── 10 · Approval past its SLA ──────────────────────── */
  stage("Approval SLA — a step nobody touched is escalated, not reassigned");
  // A second, small requisition, submitted and then left alone. Small on purpose:
  // it stops below the committee threshold, so its chain is short and the run
  // does not spend another five minutes on votes it is not testing.
  const stalled = await createPr(requester, {
    entityId: entity.id,
    departmentId: department.id,
    procurementType: "ON_DEMAND",
    procurementKind: "GOODS",
    title: `Lifecycle run ${RUN} — SLA probe, 1 ${item.unit}`,
    justification: "Raised to leave an approval sitting past its deadline, so the sweep has something real to find.",
    deliveryStoreId: store.id,
    requiredDate: new Date(Date.now() + 14 * 86_400_000),
    items: [
      {
        itemId: item.id,
        categoryId: item.categoryId,
        description: item.name,
        specification: "As per catalogue specification.",
        quantity: 1,
        unit: item.unit,
        estimatedUnitPrice: 9_500,
        itemCode: item.sku,
      },
    ],
  });
  await submitPr(requester, stalled.id, prisma);

  const pendingStep = await prisma.approvalAction.findFirst({
    where: { instance: { documentId: stalled.id, status: "PENDING" }, action: "PENDING" },
    orderBy: { sequence: "asc" },
    include: { instance: { select: { documentRef: true, currentSequence: true } } },
  });
  if (!pendingStep) {
    say("        (this requisition needed no approval, so there is no step to age)");
  } else {
    // Age it past its deadline and past the grace period. The sweep's own grace
    // is what separates "an approver an hour late" from "a stalled document",
    // and a test that skipped the grace would not be testing the rule.
    await prisma.approvalAction.update({
      where: { id: pendingStep.id },
      data: { dueAt: new Date(Date.now() - 4 * 86_400_000) },
    });
    const before = await prisma.approvalAction.findUniqueOrThrow({
      where: { id: pendingStep.id },
      select: { escalationLevel: true, action: true, actorId: true, assignedRoleCode: true },
    });

    const swept = await escalateOverdueApprovals(auditor, {}, prisma);
    const after = await prisma.approvalAction.findUniqueOrThrow({
      where: { id: pendingStep.id },
      include: { escalatedTo: { select: { name: true, title: true } } },
    });

    check(
      "the step past its SLA was escalated up the organogram",
      after.escalationLevel > before.escalationLevel,
      `${pendingStep.instance.documentRef} · "${pendingStep.stepName}" · level ${before.escalationLevel} → ` +
        `${after.escalationLevel} · told ${after.escalatedTo?.name ?? "nobody"}`,
    );
    // The point of the design: escalating tells somebody, it does not hand the
    // decision over. If this ever fails, an SLA breach has become a way round
    // the approver.
    check(
      "the approval itself did not move",
      after.action === "PENDING" && after.actorId === before.actorId,
      `still ${after.action}, still assigned to ${after.assignedRoleCode ?? "the same person"}`,
    );
    const delay = await prisma.exception.findFirst({
      where: { type: "APPROVAL_DELAY", documentId: stalled.id },
      include: { owner: { select: { name: true } } },
    });
    check(
      "a tracked exception was raised so it joins the existing ladder",
      Boolean(delay),
      delay ? `${delay.number} · ${delay.severity} · owned by ${delay.owner?.name}` : "none raised",
    );
    say(
      `        sweep: ${swept.escalated} step(s) escalated, ${swept.raised} exception(s) raised, ` +
        `${swept.stuck} with nobody above the approver, ${swept.notified} notified`,
    );
  }

  /* ══ THE FORMS ═══════════════════════════════════════ */
  say(`\n\n${"█".repeat(78)}\n  THE FORMS, PRINTED FROM THE RECORDS ABOVE\n${"█".repeat(78)}`);

  /* ── Annexure 1 ──────────────────────────────────────── */
  const prFull = await prisma.purchaseRequisition.findUniqueOrThrow({
    where: { id: pr.id },
    include: {
      entity: true,
      department: true,
      requester: true,
      approvedBy: true,
      deliveryStore: true,
      items: { orderBy: { lineNo: "asc" }, include: { item: true } },
    },
  });
  const prSigs = await attestationBlock("PR", pr.id, ["APPROVED", "REVIEWED"], prisma);
  const prSig = prSigs.find((b) => b.signed) ?? prSigs[0];

  form(`ANNEXURE 1 — PURCHASE REQUISITION`, prFull.number);
  pairs([
    ["Document no", prFull.number],
    ["Document date", day(prFull.createdAt)],
    ["Required date", day(prFull.requiredDate)],
    ["Department", prFull.department.name],
    ["Required by", prFull.requester.name],
    ["Req location", prFull.requiredLocation ?? prFull.deliveryStore?.name ?? "—"],
    ["Approved by", prFull.approvedBy?.name ?? prSig?.name ?? "—"],
    ["Approval status", prFull.status],
  ]);
  say(`\n  Description / comments:\n    ${prFull.title}\n    ${prFull.justification ?? ""}`);
  say("");
  table(
    ["Sr", "Item code", "Description", "Qty", "UOM", "Unit cost", "Total", "In stock"],
    [3, 12, 30, 6, 5, 11, 12, 9],
    prFull.items.map((li) => [
      String(li.lineNo),
      li.itemCode ?? li.item?.sku ?? "—",
      li.description.slice(0, 30),
      String(li.quantity),
      li.unit,
      li.estimatedUnitPrice != null ? money(li.estimatedUnitPrice) : "—",
      money(li.estimatedTotal),
      li.inStockAtRequest != null ? String(li.inStockAtRequest) : "—",
    ]),
  );
  say(`\n  Document comments: ${prFull.documentComments ?? ""}`);
  say("");
  sig(
    "HOD / Regional Head",
    prSig?.name ?? null,
    prSig?.designation ?? null,
    prSig?.signedAt ? `Date ${day(prSig.signedAt)}   Time ${prSig.signedAt.toISOString().slice(11, 16)}` : "Date __  Time __",
  );
  say(`    Stamp: ${prSig?.stampRef ?? "[   affix stamp   ]"}`);

  /* ── Purchase order ──────────────────────────────────── */
  const poFull = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: po.id },
    include: {
      entity: true,
      vendor: true,
      pr: true,
      deliveryStore: true,
      createdBy: true,
      authorisedSignatory: true,
      items: { orderBy: { lineNo: "asc" }, include: { item: true } },
    },
  });
  form(`PURCHASE ORDER`, poFull.number);
  pairs([
    ["Order date", day(poFull.issuedAt ?? poFull.createdAt)],
    ["Supplier", `${poFull.vendor.name} (${poFull.vendor.code})`],
    ["Deliver to", poFull.deliveryStore?.name ?? "—"],
    ["Against requisition", poFull.pr?.number ?? "—"],
    ["Payment terms", poFull.paymentTerms ?? "—"],
    ["Warranty", poFull.warrantyTerms ?? "—"],
    ["Currency", poFull.currency],
    ["Status", poFull.status],
  ]);
  say("");
  table(
    ["Sr", "Item code", "Description", "Qty", "UOM", "Unit price", "Tax %", "Line total"],
    [3, 12, 30, 6, 5, 12, 6, 13],
    poFull.items.map((li) => [
      String(li.lineNo),
      li.item?.sku ?? "—",
      li.description.slice(0, 30),
      String(li.quantity),
      li.unit,
      money(li.unitPrice),
      String(li.taxRate),
      money(li.lineTotal),
    ]),
  );
  say(
    `\n  Subtotal ${money(poFull.subtotal)}   Tax ${money(poFull.taxAmount)}   TOTAL ${poFull.currency} ${money(poFull.total)}`,
  );
  say("");
  sig(
    "Authorised signatory — Procurement (§4.6)",
    poFull.authorisedSignatory?.name ?? null,
    poFull.authorisedSignatory?.title ?? null,
    poFull.signedAt ? stamp(poFull.signedAt) : "Date __",
  );
  say("");
  sig(
    "Supplier acknowledgement",
    poFull.acknowledgedByName,
    poFull.acknowledgementStatus,
    poFull.acknowledgedAt ? stamp(poFull.acknowledgedAt) : "Date __",
  );
  say(
    `    Distributed by ${poFull.distributionChannel ?? "—"} ${poFull.distributionRef ?? ""} on ${day(poFull.distributedAt)}`,
  );

  /* ── Annexure 4 ──────────────────────────────────────── */
  const inspFull = inspection
    ? await prisma.inspection.findUniqueOrThrow({
        where: { id: inspection.id },
        include: {
          po: { include: { vendor: true } },
          delivery: { include: { store: true, receivedBy: true } },
          items: { orderBy: { lineNo: "asc" }, include: { item: true } },
        },
      })
    : null;

  if (inspFull) {
    const a4 = await annexure4Signatures(inspFull.id, prisma);
    const marks = await signoffsFor(inspFull.id, prisma);
    form(`ANNEXURE 4 — GOODS / MATERIAL INSPECTION NOTE`, inspFull.number);
    pairs([
      ["Receiving date", day(inspFull.receivedDate ?? inspFull.delivery?.deliveryDate)],
      ["Inspection date", day(inspFull.inspectedAt)],
      ["Supplier", inspFull.po?.vendor.name ?? "—"],
      ["Store", inspFull.delivery?.store.name ?? "—"],
      ["Against order", inspFull.po?.number ?? "—"],
      ["Result", inspFull.result ?? "—"],
    ]);
    say("");
    table(
      ["Sr", "Item code", "Description", "Inspd", "Passed", "Rejected", "Verdict"],
      [3, 12, 30, 7, 7, 9, 9],
      inspFull.items.map((li) => [
        String(li.lineNo),
        li.item?.sku ?? "—",
        (li.description ?? "").slice(0, 30),
        String(li.quantityInspected),
        String(li.quantityPassed),
        String(li.quantityFailed),
        li.verdict ?? "—",
      ]),
    );
    const t = inspFull.items.reduce(
      (a, li) => ({
        insp: a.insp + li.quantityInspected,
        pass: a.pass + li.quantityPassed,
        fail: a.fail + li.quantityFailed,
      }),
      { insp: 0, pass: 0, fail: 0 },
    );
    say(
      `\n  Received ${QTY}   Inspected ${t.insp}   Accepted ${t.pass}   Returned ${t.fail}  ${item.unit}`,
    );
    say(`\n  Sign-offs required by the SOP's inspection chart:`);
    for (const m of marks) {
      say(
        `    ${m.typeLabel.padEnd(22)} ${m.ownerLabel.padEnd(16)} ${
          m.signedAt ? `${m.verdict} by ${m.signedByName} on ${day(m.signedAt)}` : "UNSIGNED"
        }`,
      );
    }
    say("");
    sig("Logistics (Received by)", a4.logistics?.name ?? null, a4.logistics?.designation ?? null, a4.logistics?.signedAt ? day(a4.logistics.signedAt) : "Date __");
    say("");
    sig(
      "Concerned Department (Signature — POC)",
      a4.department?.name ?? null,
      a4.department?.designation ?? null,
      a4.department?.signedAt ? day(a4.department.signedAt) : "Date __",
    );
    if (!a4.department) {
      say(`    (the department's POC has not signed — §3.2 requires them, and the inspector cannot stand in)`);
    }
  }

  /* ── GRN ─────────────────────────────────────────────── */
  const grnFull = await prisma.grn.findUniqueOrThrow({
    where: { id: grn.id },
    include: {
      po: { include: { pr: true, entity: true } },
      vendor: true,
      store: true,
      delivery: true,
      gatePass: true,
      inspection: true,
      receivedBy: true,
      postedBy: true,
      items: { orderBy: { lineNo: "asc" }, include: { item: true } },
    },
  });
  form(`GOODS RECEIPT NOTE`, grnFull.number);
  pairs([
    ["Receipt date", day(grnFull.receivedAt)],
    ["Supplier", grnFull.vendor.name],
    ["Store", grnFull.store.name],
    ["Against order", grnFull.po.number],
    ["Against requisition", grnFull.po.pr?.number ?? "—"],
    ["Value", `${grnFull.po.currency} ${money(grnFull.totalValue)}`],
    ["Status", grnFull.status],
  ]);
  say(`\n  The receiving chain:`);
  say(`    Inward gate pass  ${grnFull.gatePass?.serial ?? "none"}  ${day(grnFull.gatePass?.arrivedAt)}  ${grnFull.gatePass?.vehicleNumber ?? ""}`);
  say(`    Delivery          ${grnFull.delivery?.number ?? "none"}  ${day(grnFull.delivery?.deliveryDate)}  DN ${grnFull.delivery?.deliveryNoteRef ?? "—"}`);
  say(`    Inspection        ${grnFull.inspection?.number ?? grnFull.inspectionStatus}  ${grnFull.inspection?.result ?? ""}`);
  say("");
  table(
    ["Sr", "Item code", "Description", "Ordrd", "Recvd", "Accptd", "Rejctd", "Line value"],
    [3, 12, 26, 7, 7, 8, 8, 13],
    grnFull.items.map((li) => [
      String(li.lineNo),
      li.item?.sku ?? "—",
      li.description.slice(0, 26),
      String(li.orderedQty),
      String(li.receivedQty),
      String(li.acceptedQty),
      String(li.rejectedQty),
      money(li.lineValue),
    ]),
  );
  say("");
  sig("Received by — Store", grnFull.receivedBy.name, grnFull.receivedBy.title, stamp(grnFull.receivedAt));
  say("");
  sig("Posted to inventory by", grnFull.postedBy?.name ?? null, grnFull.postedBy?.title ?? null, stamp(grnFull.postedAt));

  /* ── Annexure A ──────────────────────────────────────── */
  const invFull = await prisma.invoice.findUniqueOrThrow({
    where: { id: matched.id },
    include: { vendor: true, po: true },
  });
  form(`ANNEXURE A — SUPPORTING DOCUMENTS FOR PAYMENT`, invFull.number);
  pairs([
    ["Invoice", `${invFull.number} (vendor ref ${invFull.vendorInvoiceNumber})`],
    ["Supplier", invFull.vendor.name],
    ["Against order", invFull.po.number],
    ["Net payable", `${invFull.currency} ${money(invFull.netPayable || invFull.total)}`],
    ["Three-way match", invFull.matchStatus],
    ["Status", invFull.status],
  ]);
  say("");
  table(
    ["Document", "Required", "What we hold", "Ref", "Checked by"],
    [26, 12, 16, 18, 20],
    pack.items.map((i) => [
      i.documentTypeName.slice(0, 26),
      i.requirementKind === "ALWAYS" ? "always" : i.applicable ? "if applic." : "n/a",
      i.satisfiedBy === "RECORD"
        ? "system record"
        : i.satisfiedBy === "ATTACHMENT"
          ? "attached file"
          : i.exceptionReason
            ? "WAIVED"
            : i.applicable
              ? "nothing"
              : "not required",
      i.records.map((r) => r.ref).join(",").slice(0, 18) || "—",
      i.verified ? (i.verifiedByName ?? "—") : "—",
    ]),
  );
  say(
    `\n  Complete: ${pack.complete}   Blockers: ${pack.blockers.join(", ") || "none"}   Unchecked: ${pack.unverified.join(", ") || "none"}`,
  );
  if (handoff) {
    say(`\n  Handed to finance as ${handoff.number} for ${money(handoff.amount)} — the pack was complete and checked.`);
  }

  /* ── Summary ─────────────────────────────────────────── */
  say(
    `\n\n  Chain: ${prFull.number} → ${rfq.number} → ${comparative.number} → ${poFull.number} → ` +
      `${grnFull.gatePass?.serial ?? "—"} → ${grnFull.delivery?.number ?? "—"} → ${inspFull?.number ?? "—"} → ` +
      `${grnFull.number} → ${invFull.number}${handoff ? ` → ${handoff.number}` : ""}`,
  );
  say(`\n  ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`\nRun failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  await prisma.$disconnect();
  process.exit(1);
});
