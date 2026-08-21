/**
 * Prints one procurement case end-to-end: lifecycle, quantities, match result,
 * exceptions, inventory effect and timeline. Useful for verifying a case by hand.
 *
 *   npx tsx scripts/show-case.ts MD-2026-00001
 */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function run() {
  const key = process.argv[2] ?? "MD-2026-00001";
  const pr = await prisma.purchaseRequisition.findFirst({
    where: { number: key },
    include: {
      entity: true,
      department: true,
      requester: true,
      purchaseOrders: {
        include: {
          items: true,
          vendor: true,
          grns: { include: { items: true, store: true } },
          invoices: { include: { items: true } },
          deliveries: { include: { items: true, inspections: true } },
          gatePasses: true,
        },
      },
      comparatives: { include: { lines: { include: { vendor: true } } } },
      cpcCases: { include: { decisions: { include: { member: true } }, members: true } },
      exceptions: true,
      rfqs: { include: { quotes: { include: { vendor: true, negotiations: true } }, vendors: true } },
    },
  });
  if (!pr) {
    process.stdout.write(`No case found for ${key}\n`);
    await prisma.$disconnect();
    return;
  }

  const line = (s = "") => process.stdout.write(`${s}\n`);
  const money = (n: number) => `PKR ${Math.round(n).toLocaleString("en-PK")}`;

  line(`\n${pr.number}  ${pr.title}`);
  line(`${"".padEnd(78, "-")}`);
  line(`Entity     ${pr.entity.code} — ${pr.entity.name}`);
  line(`Department ${pr.department.name}`);
  line(`Requester  ${pr.requester.name}`);
  line(`Type       ${pr.procurementType}`);
  line(`Status     ${pr.status}`);
  line(`Value      ${money(pr.estimatedValue)}`);
  if (pr.boqReference) line(`BOQ        ${pr.boqReference}`);
  if (pr.drawingReference) line(`Drawing    ${pr.drawingReference}`);

  for (const rfq of pr.rfqs) {
    line(`\nRFQ ${rfq.number} (${rfq.status}) — ${rfq.vendors.length} invited, ${rfq.quotes.length} quoted`);
    for (const q of rfq.quotes) {
      const neg = q.negotiations.at(-1);
      line(
        `  ${q.number} ${q.vendor.name.slice(0, 34).padEnd(34)} ${money(q.total).padStart(16)} ${q.technicalCompliance.padEnd(14)}${neg ? ` negotiated → ${money(neg.negotiatedTotal)}` : ""}`,
      );
    }
  }

  for (const c of pr.comparatives) {
    line(`\nComparative ${c.number} (${c.status})`);
    line(`  previous ${c.previousPrice ? money(c.previousPrice) : "—"}  market ${c.marketPrice ? money(c.marketPrice) : "—"}  lowest ${c.lowestTotal ? money(c.lowestTotal) : "—"}  savings ${money(c.savingsAmount)} (${c.savingsPercent}%)`);
    for (const l of c.lines) {
      const flags = [l.isSelected ? "SELECTED" : "", l.isLowest ? "lowest" : "", l.isLowestCompliant ? "lowest-compliant" : ""].filter(Boolean).join(" ");
      line(`  rank ${String(l.rank).padStart(2)} ${l.vendor.name.slice(0, 32).padEnd(32)} net ${money(l.netTotal).padStart(16)} score ${String(l.scoreTotal).padStart(6)} ${flags}`);
    }
    if (c.nonLowestJustification) line(`  justification: ${c.nonLowestJustification.slice(0, 300)}`);
  }

  for (const k of pr.cpcCases) {
    line(`\nCPC ${k.number} (${k.status}) — ${money(k.amount)}, ${k.members.length} members`);
    for (const d of k.decisions) line(`  ${d.member.name.padEnd(22)} ${d.vote.padEnd(8)} ${(d.comment ?? "").slice(0, 90)}`);
  }

  for (const po of pr.purchaseOrders) {
    line(`\nPO ${po.number} (${po.status}) — ${po.vendor.name}, ${money(po.total)}`);
    if (po.advanceRequired) line(`  advance ${money(po.advanceAmount ?? 0)} (${po.advancePercent}%) status ${po.advanceStatus} collateral ${po.collateralType} ${po.collateralRef ?? ""}`);
    for (const i of po.items) {
      line(
        `  line ${i.lineNo} ${i.description.slice(0, 34).padEnd(34)} ordered ${String(i.quantity).padStart(7)} ${i.unit.padEnd(5)} received ${String(i.receivedQty).padStart(7)} accepted ${String(i.acceptedQty).padStart(7)} pending ${String(Math.max(0, i.quantity - i.acceptedQty)).padStart(7)}`,
      );
    }
    for (const gp of po.gatePasses) line(`  gate pass ${gp.number} serial ${gp.serial} — ${gp.vehicleNumber ?? ""} (${gp.status})`);
    for (const d of po.deliveries) {
      line(`  delivery ${d.number} (${d.status}) — ${d.items.length} line(s), inspections: ${d.inspections.map((i) => `${i.number}:${i.result}`).join(", ") || "none"}`);
      for (const di of d.items) {
        line(`    line ${di.lineNo} expected ${di.expectedQty} delivered ${di.actualQty} accepted ${di.acceptedQty} discrepancy ${di.discrepancyType}`);
      }
    }
    for (const g of po.grns) {
      line(`  GRN ${g.number} (${g.status}) at ${g.store.name} — ${money(g.totalValue)}, inspection ${g.inspectionStatus}`);
      for (const gi of g.items) line(`    line ${gi.lineNo} accepted ${gi.acceptedQty} ${gi.unit} @ ${money(gi.unitPrice)} → ${money(gi.lineValue)}`);
    }
    for (const inv of po.invoices) {
      line(`  Invoice ${inv.number} (${inv.status}) match=${inv.matchStatus} — vendor ref ${inv.vendorInvoiceNumber}, ${money(inv.total)}`);
      for (const il of inv.items) {
        line(`    line ${il.lineNo} invoiced ${il.quantity} vs GRN accepted ${il.grnAcceptedQty ?? "—"} → ${il.matchFlag}`);
      }
      if (inv.matchNotes) line(`    match notes: ${inv.matchNotes.slice(0, 400)}`);
    }
  }

  if (pr.exceptions.length) {
    line(`\nExceptions (${pr.exceptions.length})`);
    for (const e of pr.exceptions) line(`  ${e.number} ${e.type.padEnd(24)} ${e.severity.padEnd(8)} ${e.status.padEnd(10)} ${e.blocking ? "BLOCKING " : ""}${e.title.slice(0, 70)}`);
  }
  const poExceptions = await prisma.exception.findMany({ where: { poId: { in: pr.purchaseOrders.map((p) => p.id) } } });
  if (poExceptions.length) {
    line(`\nExceptions on purchase orders (${poExceptions.length})`);
    for (const e of poExceptions) line(`  ${e.number} ${e.type.padEnd(24)} ${e.severity.padEnd(8)} ${e.status.padEnd(10)} ${e.blocking ? "BLOCKING " : ""}${e.title.slice(0, 70)}`);
  }

  const audit = await prisma.auditLog.findMany({ where: { caseKey: pr.number }, orderBy: { createdAt: "asc" } });
  line(`\nTimeline (${audit.length} events)`);
  for (const a of audit) {
    line(`  ${a.createdAt.toISOString().slice(0, 16).replace("T", " ")}  ${a.action.padEnd(34)} ${(a.actorName ?? "system").slice(0, 20).padEnd(20)} ${(a.entityRef ?? "").slice(0, 18)}`);
  }
  line();
  await prisma.$disconnect();
}

run().catch(async (e) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  await prisma.$disconnect();
  process.exit(1);
});
