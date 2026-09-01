import { prisma, type DbClient } from "@/lib/db";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { DOMAIN_ACTIONS, assertAuthority, type Actor } from "@/lib/actor";
import { PERMISSIONS as P } from "@/lib/permissions";
import { notify } from "@/lib/notify";

/**
 * Pre-qualification validity and requalification.
 *
 * Meeting requirement 20 asks for "vendor PQ expiry after 2 years" and
 * "requalification". `checkVendorEligibility` already refuses a vendor whose
 * pre-qualification has lapsed, and the requalification path already exists —
 * record a fresh evaluation, approve it, and `decideVendorApproval` resets the
 * clock.
 *
 * What was missing is the part that makes any of it happen: **nobody could see
 * it coming.** The validity setting ships at zero for Zameen Media, so nothing
 * expires; and if somebody set it to twenty-four months tomorrow, every vendor
 * approved more than two years ago would become ineligible in the same instant,
 * with the first anybody heard of it being a refused requisition.
 *
 * So this module does three things and deliberately changes no policy:
 *
 *   · **Standing** — where every approved vendor sits against the validity in
 *     force, including the honest answer for vendors with no approval date on
 *     record, which is that their position is unknown rather than valid.
 *   · **Preview** — what a proposed validity *would* do, before anybody sets it.
 *     Turning on an expiry control is a decision with a blast radius, and the
 *     business is entitled to see the radius first.
 *   · **Warning** — a scheduled nudge as expiry approaches, so requalification
 *     is triggered by a calendar rather than by a blocked purchase.
 *
 * The switch itself stays where it is. Enabling expiry is a business decision
 * with consequences for live vendors, and a module should not make it.
 */

export type PqState =
  | "VALID"
  | "EXPIRING"
  | "EXPIRED"
  | "NOT_TRACKED"
  | "NO_APPROVAL_DATE";

export type PqStanding = {
  vendorId: string;
  code: string;
  name: string;
  status: string;
  approvedAt: Date | null;
  validityMonths: number;
  expiresAt: Date | null;
  daysRemaining: number | null;
  state: PqState;
  /** Last time a pre-qualification evaluation was recorded, if ever. */
  lastEvaluatedAt: Date | null;
};

const DAY = 86400000;

function expiryOf(approvedAt: Date, months: number): Date {
  const d = new Date(approvedAt);
  d.setMonth(d.getMonth() + months);
  return d;
}

/**
 * Where each approved vendor stands against the validity currently in force.
 *
 * `warnDays` decides what counts as expiring rather than valid; it does not
 * change eligibility, only the colour of the row.
 */
export async function pqStanding(
  filter: { entityId?: string | null; warnDays?: number } = {},
  db: DbClient = prisma,
): Promise<{ rows: PqStanding[]; validityMonths: number; warnDays: number }> {
  const validityMonths = await getConfigNumber(
    CONFIG_KEYS.POLICY_PQ_VALIDITY_MONTHS,
    filter.entityId ?? null,
    db,
  );
  const warnDays = filter.warnDays ?? 90;

  const vendors = await db.vendor.findMany({
    where: {
      status: { in: ["APPROVED", "ACTIVE", "CONDITIONAL"] },
      ...(filter.entityId ? { entityLinks: { some: { entityId: filter.entityId } } } : {}),
    },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      approvedAt: true,
      evaluations: {
        orderBy: { evaluatedAt: "desc" },
        take: 1,
        select: { evaluatedAt: true },
      },
    },
    take: 2000,
  });

  const now = Date.now();
  const rows: PqStanding[] = vendors.map((v) => {
    const lastEvaluatedAt = v.evaluations[0]?.evaluatedAt ?? null;
    const base: PqStanding = {
      vendorId: v.id,
      code: v.code,
      name: v.name,
      status: v.status,
      approvedAt: v.approvedAt,
      validityMonths,
      expiresAt: null,
      daysRemaining: null,
      state: "NOT_TRACKED",
      lastEvaluatedAt,
    };
    if (validityMonths <= 0) return base;
    // An approved vendor with no approval date cannot be placed on the clock.
    // Calling that valid would be an assumption in the vendor's favour, and
    // calling it expired would be one against them — so it is neither.
    if (!v.approvedAt) return { ...base, state: "NO_APPROVAL_DATE" };

    const expiresAt = expiryOf(v.approvedAt, validityMonths);
    const daysRemaining = Math.floor((expiresAt.getTime() - now) / DAY);
    return {
      ...base,
      expiresAt,
      daysRemaining,
      state: daysRemaining < 0 ? "EXPIRED" : daysRemaining <= warnDays ? "EXPIRING" : "VALID",
    };
  });

  // Worst position first.
  const rank: Record<PqState, number> = {
    EXPIRED: 0,
    EXPIRING: 1,
    NO_APPROVAL_DATE: 2,
    VALID: 3,
    NOT_TRACKED: 4,
  };
  rows.sort(
    (a, b) => rank[a.state] - rank[b.state] || (a.daysRemaining ?? 1e9) - (b.daysRemaining ?? 1e9),
  );
  return { rows, validityMonths, warnDays };
}

export type PqPreview = {
  proposedMonths: number;
  currentMonths: number;
  totalApproved: number;
  /** Ineligible the moment the setting is saved. */
  expiredImmediately: number;
  expiringWithin90: number;
  stillValid: number;
  /** Approved vendors with no approval date, whose position cannot be computed. */
  undatable: number;
  /** The names, so the decision is taken with the list in front of somebody. */
  wouldExpire: Array<{ code: string; name: string; approvedAt: Date | null; overdueDays: number }>;
};

/**
 * What a proposed validity would do if it were switched on today.
 *
 * The point of this is the `expiredImmediately` figure. Setting a two-year
 * validity on a vendor list that has never had one does not start a clock — it
 * finishes one that has been running unobserved, and every vendor approved more
 * than two years ago becomes ineligible at once. That is a decision somebody
 * should take with the list in front of them, not discover from a refused
 * requisition.
 */
export async function pqPreview(
  entityId: string | null,
  proposedMonths: number,
  db: DbClient = prisma,
): Promise<PqPreview> {
  const currentMonths = await getConfigNumber(CONFIG_KEYS.POLICY_PQ_VALIDITY_MONTHS, entityId, db);

  const vendors = await db.vendor.findMany({
    where: {
      status: { in: ["APPROVED", "ACTIVE", "CONDITIONAL"] },
      ...(entityId ? { entityLinks: { some: { entityId } } } : {}),
    },
    select: { code: true, name: true, approvedAt: true },
    take: 2000,
  });

  const now = Date.now();
  let expiredImmediately = 0;
  let expiringWithin90 = 0;
  let stillValid = 0;
  let undatable = 0;
  const wouldExpire: PqPreview["wouldExpire"] = [];

  for (const v of vendors) {
    if (!v.approvedAt) {
      undatable += 1;
      continue;
    }
    if (proposedMonths <= 0) {
      stillValid += 1;
      continue;
    }
    const expiresAt = expiryOf(v.approvedAt, proposedMonths);
    const days = Math.floor((expiresAt.getTime() - now) / DAY);
    if (days < 0) {
      expiredImmediately += 1;
      wouldExpire.push({
        code: v.code,
        name: v.name,
        approvedAt: v.approvedAt,
        overdueDays: Math.abs(days),
      });
    } else if (days <= 90) expiringWithin90 += 1;
    else stillValid += 1;
  }

  wouldExpire.sort((a, b) => b.overdueDays - a.overdueDays);
  return {
    proposedMonths,
    currentMonths,
    totalApproved: vendors.length,
    expiredImmediately,
    expiringWithin90,
    stillValid,
    undatable,
    wouldExpire: wouldExpire.slice(0, 200),
  };
}

/**
 * Warns procurement about pre-qualifications approaching expiry.
 *
 * Run as a job. Silent when the control is off, because warning about an expiry
 * that will never happen trains people to ignore the warning.
 */
export async function warnExpiringPrequalifications(
  actor: Actor,
  opts: { entityId?: string | null; warnDays?: number } = {},
  db: DbClient = prisma,
): Promise<{ expiring: number; expired: number; notified: number }> {
  assertAuthority(actor, DOMAIN_ACTIONS.PQ_EXPIRY_WARN, {
    permission: [P.VENDOR_APPROVE, P.VENDOR_EVALUATE],
  });

  const { rows, validityMonths } = await pqStanding(
    { entityId: opts.entityId ?? null, warnDays: opts.warnDays ?? 90 },
    db,
  );
  if (validityMonths <= 0) return { expiring: 0, expired: 0, notified: 0 };

  const expiring = rows.filter((r) => r.state === "EXPIRING");
  const expired = rows.filter((r) => r.state === "EXPIRED");
  if (!expiring.length && !expired.length) {
    return { expiring: 0, expired: 0, notified: 0 };
  }

  const notified = await notify(
    {
      roleCodes: ["PROCUREMENT_OFFICER", "PROCUREMENT_SENIOR_MANAGER", "PROCUREMENT_DIRECTOR"],
      entityId: opts.entityId ?? null,
      type: "GENERAL",
      priority: expired.length ? "HIGH" : "NORMAL",
      title: expired.length
        ? `${expired.length} vendor pre-qualification${expired.length === 1 ? " has" : "s have"} expired`
        : `${expiring.length} vendor pre-qualification${expiring.length === 1 ? "" : "s"} expiring soon`,
      body:
        [
          expired.length ? `Expired: ${expired.slice(0, 8).map((r) => r.name).join(", ")}` : "",
          expiring.length
            ? `Expiring within ${opts.warnDays ?? 90} days: ${expiring.slice(0, 8).map((r) => r.name).join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join(" · ") + ` (validity ${validityMonths} months).`,
      linkType: "VENDOR",
      linkUrl: "/vendors/prequalification",
    },
    db,
  );

  return { expiring: expiring.length, expired: expired.length, notified };
}
