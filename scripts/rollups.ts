/**
 * Recomputes the derived figures.
 *
 * Vendor performance and the missing-GRN sweep are rollups over recorded
 * transactions, not stored opinions — they have to be recomputed after any bulk
 * load, and they are the last thing the seed does. Kept as its own script so a
 * failed rollup never means re-seeding the whole database.
 *
 *   npx tsx scripts/rollups.ts
 */
import { prisma } from "../src/lib/db";
import { recomputeAllVendorPerformance } from "../src/server/vendors";
import { sweepMissingGrns } from "../src/server/grn";
import { systemActor } from "@/lib/actor";
import { rollControlCalendar, escalateOverdueExceptions } from "../src/server/controls";
import { lapsePoAcknowledgements } from "../src/server/po";
import { warnExpiringPrequalifications } from "../src/server/prequalification";
import { raiseSplitCases } from "../src/server/split-detector";
import { sweepContractExpiry } from "../src/server/contracts";
import { sweepDelegations } from "../src/server/delegation";

async function main() {
  console.log("\nRecomputing rollups\n");

  await recomputeAllVendorPerformance(systemActor("SCHEDULER"), 12, prisma);
  const scored = await prisma.vendorPerformance.count();
  console.log(`  vendor performance recomputed — ${scored} period record(s)`);

  const raised = await sweepMissingGrns(prisma);
  console.log(`  missing-GRN sweep: ${raised} order(s) flagged as received without a GRN`);

  // The scheduled controls. Each is idempotent, so running this more often than
  // needed is harmless; each is also silent where its control is switched off,
  // because warning about something that cannot happen trains people to ignore
  // the warning.
  const scheduler = systemActor("SCHEDULER");

  const calendar = await rollControlCalendar(scheduler, prisma);
  console.log(
    `  control calendar: ${calendar.opened} period(s) opened, ${calendar.missed} marked missed, ${calendar.notified} notified`,
  );

  const escalated = await escalateOverdueExceptions(scheduler, {}, prisma);
  console.log(
    `  exception escalation: ${escalated.escalated} pushed up the line, ${escalated.stuck} with nobody above them, ${escalated.notified} notified`,
  );

  const acks = await lapsePoAcknowledgements(scheduler, prisma);
  console.log(
    `  purchase order acknowledgements: ${acks.noResponse} closed as no response, ${acks.deemed} deemed accepted through execution`,
  );

  const pq = await warnExpiringPrequalifications(scheduler, {}, prisma);
  console.log(
    `  pre-qualification expiry: ${pq.expired} expired, ${pq.expiring} expiring, ${pq.notified} notified`,
  );

  const splits = await raiseSplitCases(scheduler, {}, prisma);
  console.log(
    `  order-splitting detector: ${splits.found} pattern(s) found, ${splits.raised} case(s) raised, ${splits.alreadyOpen} already open`,
  );

  const contracts = await sweepContractExpiry(scheduler, prisma);
  console.log(
    `  contract expiry: ${contracts.expiring} entered their notice period, ${contracts.expired} expired, ${contracts.autoRenewing} of those renew automatically unless stopped`,
  );

  const delegations = await sweepDelegations(scheduler, prisma);
  console.log(
    `  delegations: ${delegations.activated} came into force, ${delegations.expired} expired`,
  );

  console.log("");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  await prisma.$disconnect();
  process.exit(1);
});
