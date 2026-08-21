/**
 * Sends whatever is queued in the email outbox.
 *
 * Intended for a cron entry — every few minutes is plenty. The transport comes
 * from MAIL_TRANSPORT; with the default logger transport the messages are written
 * to the spool directory instead of being sent, and it says so.
 *
 *   npx tsx scripts/flush-mail.ts [limit]
 */
import { prisma } from "../src/lib/db";
import { flushOutbox, outboxSummary } from "../src/lib/mail";

async function main() {
  const limit = Number(process.argv[2] ?? 100);
  const before = await outboxSummary();
  const result = await flushOutbox(limit);
  const after = await outboxSummary();

  console.log(`\nEmail outbox — transport "${result.transport}"\n`);
  console.log(`  attempted ${result.attempted} · sent ${result.sent} · failed ${result.failed}`);
  console.log(`  queued ${before.queued} → ${after.queued} · failed ${before.failed} → ${after.failed}`);
  for (const e of result.errors) console.log(`  · ${e}`);
  console.log("");
  await prisma.$disconnect();
  process.exit(result.failed > 0 && result.sent === 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
