import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** Prisma transaction client type — anything that accepts model delegates. */
export type Tx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;


export type DbClient = PrismaClient | Tx;

/** True when the handle is already inside a transaction. */
export function inTransaction(db: DbClient): boolean {
  return !("$transaction" in db);
}

/**
 * Work to run *after* the transaction commits.
 *
 * Two kinds of thing must not sit inside a transaction, for opposite reasons.
 *
 * The first is anything the operation is allowed to survive without. Posting a
 * receipt tags assets, and asset tagging is explicitly non-blocking — the code
 * catches its errors and carries on. That is safe outside a transaction and a
 * trap inside one: Postgres aborts the whole transaction on the first failed
 * statement, so a caught-and-ignored database error poisons every write that
 * follows it. The catch hides the failure and the receipt silently does not
 * post. Deferring it keeps the intent — tagging must not block posting — and
 * makes it true again.
 *
 * The second is anything slow or external. Nothing in this codebase sends mail
 * inline (`queueEmail` writes an `EmailMessage` row that a sweep flushes later),
 * so that risk is already handled — but the rule stands for whatever comes next.
 *
 * A deferred job that fails is logged and does not undo the commit. That is the
 * point: the receipt is posted, and a missing asset tag is a follow-up, not a
 * reason to un-receive goods.
 */
export type DeferredJob = { label: string; run: () => Promise<unknown> };

/**
 * How long an interactive transaction may take before Prisma aborts it.
 *
 * Prisma's default is five seconds. Measured against this database, a single
 * query costs about 1.25s from a developer machine and about 600ms from inside a
 * transaction, where the connection is pinned — the instance is in
 * ap-southeast-2 and the round trip dominates. A purchase order creation issues
 * roughly forty statements once its allocation and requisition transition are
 * counted, so it needs something like twenty-five seconds, and a goods receipt
 * with several lines needs more.
 *
 * Two minutes is therefore an accommodation for that latency, not a target. In a
 * deployment co-located with the database the same chains run in a fraction of a
 * second. Lower this with `DB_TX_TIMEOUT_MS` where the database is near, and
 * treat a chain that needs it as a chain whose reads want batching — which is
 * why `allocate` no longer queries per line.
 */
const TX_TIMEOUT_MS = Number(process.env.DB_TX_TIMEOUT_MS ?? 120_000);
/** How long to wait for a pool slot before giving up. */
const TX_MAX_WAIT_MS = Number(process.env.DB_TX_MAX_WAIT_MS ?? 10_000);

/**
 * Runs `fn` in a transaction, then runs whatever it deferred.
 *
 * Nested calls join the caller's transaction rather than opening a second one,
 * so a domain function that is atomic on its own stays atomic when another
 * calls it — and does not deadlock against itself waiting for a pool slot the
 * outer transaction is holding. In that case the deferred jobs are handed
 * upward and run when the outermost transaction commits.
 *
 * The timeouts are raised from Prisma's 5-second default because the goods
 * receipt chain is long: it writes the receipt, a ledger movement and a price
 * history row per line, then the order, the requisition and the notifications.
 * Supabase runs behind a pooler, so a transaction holds a slot for its whole
 * duration — which is the reason nothing but database work belongs inside one.
 */
export async function withTransaction<T>(
  db: DbClient,
  fn: (tx: Tx, defer: (job: DeferredJob) => void) => Promise<T>,
): Promise<T> {
  // Already inside one: join it. The outer call owns commit and deferral.
  if (inTransaction(db)) {
    const parent = pendingDeferrals.get(db as Tx);
    return fn(db as Tx, (job) => {
      if (parent) {
        parent.push(job);
        return;
      }
      // A transaction handle nobody registered — someone called `$transaction`
      // directly instead of going through here. There is no commit hook to hang
      // the job on, so it would be dropped. Say so rather than lose it quietly.
      console.error(
        `[after-commit] "${job.label}" was deferred inside a transaction not opened by withTransaction, ` +
          "so there is nothing to run it after. Open the transaction with withTransaction.",
      );
    });
  }

  const deferred: DeferredJob[] = [];
  const startedAt = Date.now();
  let result: T;
  try {
    result = await (db as PrismaClient).$transaction(
      async (tx) => {
        pendingDeferrals.set(tx, deferred);
        try {
          return await fn(tx, (job) => deferred.push(job));
        } finally {
          pendingDeferrals.delete(tx);
        }
      },
      { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
    );
  } catch (e) {
    // A transaction that hits the timeout aborts everything it did, and Prisma's
    // message for it does not say how long it ran or what the ceiling was. One
    // of these went past silently during testing and the only symptom was a
    // process that stopped, so the duration is attached before rethrowing.
    const ms = Date.now() - startedAt;
    if (ms > TX_TIMEOUT_MS * 0.9) {
      console.error(
        `[transaction] rolled back after ${ms}ms against a ${TX_TIMEOUT_MS}ms limit. ` +
          "Every write in it is undone. Batch the reads in this chain, or raise DB_TX_TIMEOUT_MS.",
      );
    }
    throw e;
  }

  for (const job of deferred) {
    try {
      await job.run();
    } catch (e) {
      // Logged, never rethrown. The transaction has committed; failing here
      // would report an error for work that actually succeeded.
      console.error(`[after-commit] ${job.label} failed:`, e);
    }
  }

  return result;
}

/**
 * Deferral lists by transaction handle, so a nested `withTransaction` can add to
 * the outermost one. A WeakMap because the key is Prisma's own short-lived
 * transaction client and nothing should keep it alive.
 */
const pendingDeferrals = new WeakMap<Tx, DeferredJob[]>();
