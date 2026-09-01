/**
 * Seeds the Annexure A document set for Zameen Media.
 *
 * Run: npx tsx scripts/seed-payment-pack.ts
 *
 * ZAM/PUR/SOP-01 §3.4 requires procurement to ensure the supporting documents
 * are available before an invoice goes to finance, "as per Annexure A", and the
 * annexure (`image14.PNG`) lists seven. Four are unconditional; three carry
 * "(if applicable)" on the diagram itself, which is why the requirement needs a
 * conditional kind rather than a boolean.
 *
 * Idempotent. Every row cites the passage it comes from.
 */
import { prisma } from "../src/lib/db";
import { ENTITY_CODES } from "../src/lib/domain";

type Row = {
  code: string;
  requirement: "ALWAYS" | "CONDITIONAL" | "OPTIONAL";
  condition?: string;
  sequence: number;
  source: string;
};

/** Annexure A, in the order the diagram lists them. */
const ANNEXURE_A: Row[] = [
  {
    code: "PR-FORM",
    requirement: "ALWAYS",
    sequence: 10,
    source: "ZAM/PUR/SOP-01 Annexure A (image14.PNG) — 'PR'",
  },
  {
    code: "PO-DOC",
    requirement: "ALWAYS",
    sequence: 20,
    source: "ZAM/PUR/SOP-01 Annexure A — 'PO'",
  },
  {
    code: "GRN-DOC",
    requirement: "ALWAYS",
    sequence: 30,
    source: "ZAM/PUR/SOP-01 Annexure A — 'GRN'",
  },
  {
    code: "INVOICE-DOC",
    requirement: "ALWAYS",
    sequence: 40,
    source: "ZAM/PUR/SOP-01 Annexure A — 'Invoice'",
  },
  {
    code: "OTHER",
    requirement: "CONDITIONAL",
    condition:
      "An undertaking is held from the vendor — Annexure A marks this '(if applicable)'.",
    sequence: 50,
    source: "ZAM/PUR/SOP-01 Annexure A — 'Undertaking (if applicable)'",
  },
  {
    code: "MILL-CERT",
    requirement: "CONDITIONAL",
    condition: "Imported goods, where a goods declaration exists.",
    sequence: 60,
    source: "ZAM/PUR/SOP-01 Annexure A — 'GD (if applicable)'",
  },
  {
    code: "STRN-CERT",
    requirement: "CONDITIONAL",
    condition: "The vendor or the transaction carries a tax exemption.",
    sequence: 70,
    source: "ZAM/PUR/SOP-01 Annexure A — 'Exemptions (if applicable)'",
  },
  {
    code: "CPC-DECISION",
    requirement: "CONDITIONAL",
    condition:
      "The purchase went to the committee. CP-016 attaches the circulated decision to the documentation trail Finance pays against, so where a case exists the circular is required — and satisfied by the record, not by a re-uploaded file.",
    sequence: 45,
    source:
      "ZAM/PUR/SOP-01 CPC § decision mechanism (CP-016) — 'This approval email is attached with the standard documentation trail required to initiate any payment request through Finance'",
  },
];

/**
 * Document types Annexure A does not itself list, which the pack still needs.
 *
 * CP-016 puts the committee's circulated decision into the same payment trail
 * without naming it as an Annexure A line, so the type is created here rather
 * than mapped onto a near neighbour — there is no near neighbour, and folding it
 * into OTHER would make the pack unable to tell a committee circular from an
 * undertaking.
 */
const EXTRA_TYPES: Array<{ code: string; name: string; category: string }> = [
  { code: "CPC-DECISION", name: "CPC Decision Circular", category: "Approval" },
];

/**
 * Two of Annexure A's documents have no exact counterpart among the thirty
 * seeded types, so the nearest is used and said so rather than a new type being
 * invented on a guess:
 *
 *   · **Undertaking** → `OTHER`. There is no undertaking type. This is flagged
 *     below so somebody can add one properly.
 *   · **GD** → `MILL-CERT`. Also imperfect; a goods declaration is a customs
 *     document, not a mill certificate.
 *
 * Both mappings are recorded in the source reference, so the substitution is
 * visible on the screen rather than buried here.
 */
const IMPERFECT = new Set(["OTHER", "MILL-CERT"]);

async function main() {
  const zam = await prisma.entity.findFirst({ where: { code: ENTITY_CODES.ZM } });
  if (!zam) throw new Error("Zameen Media entity not found. Run the seed first.");

  for (const extra of EXTRA_TYPES) {
    const held = await prisma.documentType.findUnique({ where: { code: extra.code } });
    if (!held) {
      await prisma.documentType.create({
        data: { code: extra.code, name: extra.name, category: extra.category, required: false },
      });
      console.log(`  + document type ${extra.code} — ${extra.name}`);
    }
  }

  const types = await prisma.documentType.findMany({ select: { id: true, code: true, name: true } });
  const byCode = new Map(types.map((t) => [t.code, t]));

  let written = 0;
  const notes: string[] = [];

  for (const row of ANNEXURE_A) {
    const type = byCode.get(row.code);
    if (!type) {
      notes.push(`  ! no document type '${row.code}' — skipped`);
      continue;
    }

    const existing = await prisma.paymentPackRequirement.findFirst({
      where: { entityId: zam.id, transactionType: "GOODS", documentTypeId: type.id },
    });

    const data = {
      entityId: zam.id,
      transactionType: "GOODS",
      documentTypeId: type.id,
      requirement: row.requirement,
      condition: row.condition ?? null,
      sequence: row.sequence,
      active: true,
      sourceReference:
        row.source + (IMPERFECT.has(row.code) ? " — MAPPED to the nearest existing type; a dedicated type is wanted" : ""),
    };

    if (existing) {
      await prisma.paymentPackRequirement.update({ where: { id: existing.id }, data });
    } else {
      await prisma.paymentPackRequirement.create({ data });
    }
    written += 1;
    console.log(
      `  ${row.requirement.padEnd(11)} ${type.name}${row.condition ? `  — ${row.condition}` : ""}`,
    );
  }

  console.log(`\n${written} requirements written for Zameen Media, transaction type GOODS.`);

  if (notes.length) {
    console.log("\nUnmapped:");
    for (const n of notes) console.log(n);
  }

  console.log("\nTwo mappings are imperfect and are labelled as such on the screen:");
  console.log("  Undertaking  → 'Other Supporting Document' (no undertaking type exists)");
  console.log("  GD           → 'Mill / Test Certificate' (a GD is a customs document)");
  console.log("Add dedicated document types for both, then re-run this to repoint them.");

  console.log("\nServices are deliberately not seeded: Annexure A's chain is written");
  console.log("around a goods receipt, and what a service payment needs in place of a");
  console.log("GRN is a business decision, not something to infer. See BD-011.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
