/**
 * Seeds the Policy Pack: one row per contested setting, per entity.
 *
 * Run: npx tsx scripts/seed-policy.ts
 *
 * Idempotent. Every value written here is traceable to a passage or an annexure
 * image in one of the two supplied SOPs, and the ones that rest on a document
 * contradicting itself are reported as `awaiting confirmation` at the end rather
 * than quietly applied.
 *
 * Where the two entities differ because each SOP is explicit for its own entity,
 * both values are written — which is the whole point. A single global value is
 * what made ZAM's three-month evaluation cycle and Wednesday committee vanish
 * behind ZD's annual cycle and Thursday.
 */
import { prisma } from "../src/lib/db";
import { CONFIG_KEYS, setConfig } from "../src/lib/config";
import { BLACKLIST_GROUNDS, POLICY_CHOICES } from "../src/lib/policy";
import { ENTITY_CODES } from "../src/lib/domain";

type Row = { key: string; value: unknown; type: "string" | "number" | "boolean" | "json"; why: string };

/** Values that differ by entity, each from that entity's own SOP. */
const PER_ENTITY: Record<string, Row[]> = {
  [ENTITY_CODES.ZM]: [
    {
      key: CONFIG_KEYS.POLICY_VENDOR_EVALUATION_INTERVAL_MONTHS,
      value: 3,
      type: "number",
      why: 'PC-001 · ZAM §5.9 "evaluated after every three months"',
    },
    {
      key: CONFIG_KEYS.POLICY_CPC_MEETING_WEEKDAY,
      value: 3,
      type: "number",
      why: 'PC-007 · ZAM CPC "Every Wednesday followed by management committee meeting"',
    },
    {
      key: CONFIG_KEYS.POLICY_PAYMENT_ROUTE,
      value: "PAY-ZAM-ANNEXA",
      type: "string",
      why: "PC-010 · ZAM image14.PNG Annexure A — two Internal Audit checkpoints, KPMG tax step, collection Tuesday and Friday",
    },
    {
      key: CONFIG_KEYS.POLICY_BLOCKING_ENABLED,
      value: false,
      type: "boolean",
      why: "PC-020 · ZAM states no blocking concept. Off until ZAM adopts one.",
    },
    {
      key: CONFIG_KEYS.POLICY_PQ_VALIDITY_MONTHS,
      value: 0,
      type: "number",
      why: "PC-021 · ZAM §5.1 states no validity period. Control inactive rather than borrowing ZD's two years.",
    },
    {
      key: CONFIG_KEYS.POLICY_PETTY_CASH_ROUTE,
      value: [
        { seq: 1, role: "HOD", label: "Requester HOD approval" },
        { seq: 2, role: "PROCUREMENT_DIRECTOR", label: "Director Procurement approval" },
      ],
      type: "json",
      why: "PC-016 · ZAM image15.png Annexure 2 — HOD then Dir. Procurement, then collect cash from Accounts",
    },
  ],
  [ENTITY_CODES.ZD]: [
    {
      key: CONFIG_KEYS.POLICY_VENDOR_EVALUATION_INTERVAL_MONTHS,
      value: 12,
      type: "number",
      why: 'PC-001 · ZD §5.9 "evaluated annually"; §2.3.3 i "on Yearly basis"',
    },
    {
      key: CONFIG_KEYS.POLICY_CPC_MEETING_WEEKDAY,
      value: 4,
      type: "number",
      why: 'PC-007 · ZD CPC "Every Thursday followed by management committee meeting"',
    },
    {
      key: CONFIG_KEYS.POLICY_PAYMENT_ROUTE,
      value: "PAY-ZD-JEFFI",
      type: "string",
      why: "PC-010 · ZD image14.png — PV plus JEFFI, single IA checkpoint with a resubmission loop, 9 documents",
    },
    {
      key: CONFIG_KEYS.POLICY_BLOCKING_ENABLED,
      value: true,
      type: "boolean",
      why: "PC-020 · ZD §2.3.4 iv–vi defines temporary blocking, distinct from blacklisting",
    },
    {
      key: CONFIG_KEYS.POLICY_PQ_VALIDITY_MONTHS,
      value: 24,
      type: "number",
      why: 'PC-021 · ZD §2.3.1 iii "valid for a period of two (2) years"',
    },
    {
      key: CONFIG_KEYS.POLICY_PETTY_CASH_ROUTE,
      value: [
        { seq: 1, role: "HOD", label: "Requester HOD approval" },
        {
          seq: 2,
          role: "PROCUREMENT_SENIOR_MANAGER",
          label: "Sr. Manager Procurement — review and approve manual comparative",
          awaitingConfirmation: true,
        },
        { seq: 3, role: "PROCUREMENT_DIRECTOR", label: "Director Procurement approval" },
      ],
      type: "json",
      why: "PC-016 · ZD Sr. Manager responsibilities add a comparative review step the flow diagram does not show — flagged for confirmation",
    },
  ],
};

/** Grounds lists, per entity, verbatim and not merged. */
const GROUNDS_KEY = "policy.blacklist_grounds";

async function main() {
  const entities = await prisma.entity.findMany({ select: { id: true, code: true, name: true } });
  if (!entities.length) throw new Error("No entities. Run the seed first.");

  let written = 0;

  for (const entity of entities) {
    const rows = PER_ENTITY[entity.code];
    if (!rows) {
      console.log(`  ${entity.code}: no entity-specific policy rows defined — global defaults apply`);
      continue;
    }
    console.log(`\n${entity.code} · ${entity.name}`);
    for (const r of rows) {
      await setConfig(r.key, r.value, entity.id, "seed-policy");
      written += 1;
      console.log(`  ${r.key.replace("policy.", "")} = ${JSON.stringify(r.value)}`);
      console.log(`      ${r.why}`);
    }

    const grounds = BLACKLIST_GROUNDS[entity.code];
    if (grounds) {
      await setConfig(GROUNDS_KEY, grounds, entity.id, "seed-policy");
      written += 1;
      console.log(`  blacklist_grounds = ${grounds.length} grounds, verbatim from ${entity.code} §5.14 / §2.3.4 ii`);
    }
  }

  console.log(`\n${written} policy rows written.`);

  const unconfirmed = POLICY_CHOICES.filter((c) => c.confirm);
  if (unconfirmed.length) {
    console.log(`\n${unconfirmed.length} setting(s) are running on a reading nobody has confirmed:`);
    for (const c of unconfirmed) {
      const chosen = c.variants.find((v) => v.code === c.defaults[ENTITY_CODES.ZM]);
      console.log(`  ${c.conflict}  ${c.question}`);
      console.log(`         running: ${chosen?.label ?? c.defaults[ENTITY_CODES.ZM]}`);
      console.log(`         because: ${c.rationale}`);
    }
    console.log("\nSelect these at /admin/policy-conflicts. Until then the compliance report");
    console.log("reports them as unconfirmed, not as compliant.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
