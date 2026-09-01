import { prisma, type DbClient } from "@/lib/db";
import { CONFIG_KEYS, getConfigBundle } from "@/lib/config";
import { DOMAIN_ACTIONS, assertAuthority, type Actor } from "@/lib/actor";
import { PERMISSIONS as P } from "@/lib/permissions";
import { raiseException } from "@/lib/exceptions-service";
import { round2 } from "@/lib/format";
import { cpcRequirement } from "./cpc";

/**
 * Purchase order splitting.
 *
 * The committee threshold and the CEO tier are the system's two hard value
 * gates, and the obvious way round both is arithmetic: two orders of 300,000 to
 * the same vendor in the same week never reach a committee that engages at
 * 500,000. Nothing looked for that.
 *
 * ## What counts as a signal, and what does not
 *
 * Splitting is a **pattern**, not an event, and the system cannot tell a split
 * from a legitimate sequence of purchases. A store that orders cement every
 * Monday is not evading anything. So this raises a case for a person to look at
 * — never a block, and never an accusation.
 *
 * The signal it looks for is narrow on purpose, because a detector that fires on
 * ordinary buying gets switched off:
 *
 *   · the same vendor,
 *   · within a window,
 *   · where the orders individually sit **below** the threshold,
 *   · but together sit **at or above** it.
 *
 * The last two are what make it a signal. Orders that were always going to clear
 * the threshold are not evasion; orders that only clear it when added up are the
 * shape worth a second look.
 *
 * ## Two refinements that keep it honest
 *
 * **Orders already referred are excluded.** An order that went to committee did
 * not avoid it, and counting it towards a splitting pattern would flag the very
 * behaviour the control wants.
 *
 * **Orders from one requisition are excluded.** A single approved requisition
 * split across two vendors, or delivered in two lots, is one procurement
 * decision with one approval behind it. Treating that as evasion would flag
 * correct practice, and the noise would bury the real cases.
 */

export type SplitSignal = {
  vendorId: string;
  vendorName: string;
  entityId: string;
  windowDays: number;
  threshold: number;
  orders: Array<{
    id: string;
    number: string;
    total: number;
    issuedAt: Date | null;
    prNumber: string | null;
  }>;
  combinedTotal: number;
  /** How far over the threshold the combined value sits. */
  excess: number;
};

/**
 * Looks for the pattern across recently issued orders.
 *
 * Read-only. Raising the case is a separate call, so the same scan can be shown
 * on a screen without writing anything.
 */
export async function detectSplits(
  filter: { entityId?: string | null; windowDays?: number; since?: Date } = {},
  db: DbClient = prisma,
): Promise<SplitSignal[]> {
  const cfg = await getConfigBundle(
    [CONFIG_KEYS.SPLIT_WINDOW_DAYS, CONFIG_KEYS.SPLIT_MIN_ORDERS],
    filter.entityId ?? null,
    db,
  );
  const windowDays =
    filter.windowDays ?? (Number(cfg[CONFIG_KEYS.SPLIT_WINDOW_DAYS]) || 30);
  const minOrders = Number(cfg[CONFIG_KEYS.SPLIT_MIN_ORDERS]) || 2;

  const since = filter.since ?? new Date(Date.now() - windowDays * 86400000);

  const orders = await db.purchaseOrder.findMany({
    where: {
      status: { in: ["ISSUED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CLOSED"] },
      issuedAt: { gte: since },
      ...(filter.entityId ? { entityId: filter.entityId } : {}),
    },
    select: {
      id: true,
      number: true,
      total: true,
      issuedAt: true,
      entityId: true,
      vendorId: true,
      prId: true,
      vendor: { select: { name: true } },
      pr: { select: { number: true, procurementType: true } },
      // An order that went to committee did not avoid one.
      exceptions: { where: { type: "OTHER" }, select: { id: true } },
    },
    orderBy: { issuedAt: "asc" },
    take: 2000,
  });
  if (!orders.length) return [];

  // Which of these already went through a committee case.
  const referred = new Set<string>();
  const prIds = [...new Set(orders.map((o) => o.prId).filter((x): x is string => !!x))];
  if (prIds.length) {
    const cases = await db.cpcCase.findMany({
      where: { prId: { in: prIds }, status: { in: ["APPROVED", "PENDING_DECISION", "IN_MEETING", "SCHEDULED"] } },
      select: { prId: true },
    });
    const referredPrs = new Set(cases.map((c) => c.prId));
    for (const o of orders) if (o.prId && referredPrs.has(o.prId)) referred.add(o.id);
  }

  const byKey = new Map<string, typeof orders>();
  for (const o of orders) {
    if (referred.has(o.id)) continue;
    const key = `${o.entityId}|${o.vendorId}`;
    byKey.set(key, [...(byKey.get(key) ?? []), o]);
  }

  const signals: SplitSignal[] = [];

  for (const group of byKey.values()) {
    if (group.length < minOrders) continue;

    // The threshold for this entity and the kind of buying it is, asked through
    // the committee module so the detector and the gate cannot disagree about
    // where the line sits.
    const first = group[0]!;
    const cpc = await cpcRequirement(
      first.entityId,
      0,
      first.pr?.procurementType ?? "ON_DEMAND",
      db,
    );
    const threshold = cpc.threshold;
    if (!(threshold > 0)) continue;

    // Only orders that individually sit below the line. One that was always
    // over it went to committee on its own merits.
    const under = group.filter((o) => o.total < threshold);
    if (under.length < minOrders) continue;

    // One requisition delivered as several orders is one decision with one
    // approval behind it, not a split.
    const distinctPrs = new Set(under.map((o) => o.prId ?? o.id));
    if (distinctPrs.size < minOrders) continue;

    const combined = round2(under.reduce((a, o) => a + o.total, 0));
    if (combined < threshold) continue;

    signals.push({
      vendorId: first.vendorId,
      vendorName: first.vendor.name,
      entityId: first.entityId,
      windowDays,
      threshold,
      orders: under.map((o) => ({
        id: o.id,
        number: o.number,
        total: round2(o.total),
        issuedAt: o.issuedAt,
        prNumber: o.pr?.number ?? null,
      })),
      combinedTotal: combined,
      excess: round2(combined - threshold),
    });
  }

  // Largest excess first — the most worth a person's time.
  signals.sort((a, b) => b.excess - a.excess);
  return signals;
}

/**
 * Raises a compliance case for each pattern found.
 *
 * A case, not an alert and not a block. The meeting requirements ask for a
 * compliance case precisely because the system cannot tell a split from a
 * legitimate sequence — only a person can, and the case is where they say which
 * it was.
 *
 * Idempotent within the window: a pattern already carrying an open case is not
 * raised again, because a detector that raises the same case every night is a
 * detector everybody mutes.
 */
export async function raiseSplitCases(
  actor: Actor,
  opts: { entityId?: string | null; windowDays?: number } = {},
  db: DbClient = prisma,
): Promise<{ found: number; raised: number; alreadyOpen: number }> {
  assertAuthority(actor, DOMAIN_ACTIONS.SPLIT_DETECT, {
    permission: [P.EXCEPTION_MANAGE, P.AUDIT_VIEW],
  });

  const signals = await detectSplits(opts, db);
  let raised = 0;
  let alreadyOpen = 0;

  for (const s of signals) {
    const anchor = s.orders[0]!;
    const existing = await db.exception.findFirst({
      where: {
        type: "VENDOR_COMPLIANCE",
        documentType: "PO",
        documentId: anchor.id,
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
      select: { id: true },
    });
    if (existing) {
      alreadyOpen += 1;
      continue;
    }

    await raiseException(
      {
        type: "VENDOR_COMPLIANCE",
        severity: s.excess > s.threshold ? "HIGH" : "MEDIUM",
        title: `${s.orders.length} orders to ${s.vendorName} totalling more than the committee threshold`,
        description:
          `${s.orders.map((o) => `${o.number} (${o.total.toLocaleString("en-PK")})`).join(", ")} ` +
          `were issued within ${s.windowDays} days. Each sits below the ${s.threshold.toLocaleString("en-PK")} ` +
          `threshold; together they come to ${s.combinedTotal.toLocaleString("en-PK")}. ` +
          "This may be an ordinary sequence of purchases or it may be a split — the system cannot tell, " +
          "which is why this is a case for review rather than a block.",
        documentType: "PO",
        documentId: anchor.id,
        documentRef: anchor.number,
        entityId: s.entityId,
        poId: anchor.id,
        blocking: false,
        notifyRoles: ["AUDIT_USER", "PROCUREMENT_SENIOR_MANAGER"],
      },
      db,
    );
    raised += 1;
  }

  return { found: signals.length, raised, alreadyOpen };
}
