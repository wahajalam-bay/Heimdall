import { ForbiddenError } from "./errors";
import type { SessionUser } from "./rbac";

/**
 * Who is performing a domain operation, and on what authority.
 *
 * Rule: every mutation authorizes independently, inside the domain function.
 * A check on a page or a server action is not enough — the domain function is
 * the only place that every caller must pass through.
 *
 * That rule collides with a real property of procurement workflow: not every
 * step is a decision somebody makes by holding a permission.
 *
 * A site store user with `grn.post` legitimately causes the purchase order's
 * fulfilment to be recomputed and the requisition to move to GRN_COMPLETED —
 * two things they hold no permission for on their own. A requester legitimately
 * submits their own requisition whether or not they hold `pr.submit`. A nightly
 * sweep legitimately lapses expired insurance with no person involved at all.
 *
 * So an actor arrives with *grounds*, and there are three honest kinds:
 *
 *   1. PERMISSION — the actor holds it. The ordinary case.
 *   2. CASCADE — this step follows from an operation the actor was authorized
 *      for. The *originating* permission is named and re-verified here, so a
 *      caller cannot claim an authority the actor does not hold. The person
 *      stays the audit actor.
 *   3. OWN RECORD — the actor owns the row. Checked against the owner id the
 *      authorizing function read from the database itself, not against anything
 *      the caller asserts.
 *
 * plus system principals: named, with an empty permission list and a finite
 * list of the domain actions they may perform. A permission-based check on a
 * system principal therefore *fails*; only its declared grant admits it.
 *
 * The dishonest kind is `if (internal) skip the check`. It does not appear in
 * this codebase, and `assertAuthority` is written so that it cannot: every path
 * out of it either tests something or throws.
 */

/* ── Domain action registry ───────────────────────────────────────────────
 * Every authorized mutation names itself with one of these. They are stable
 * strings because they appear in audit rows and in system-actor grants, so a
 * rename must be deliberate rather than a silent widening of authority. */

export const DOMAIN_ACTIONS = {
  ALLOCATION_APPLY: "allocation.apply",
  ALLOCATION_BACKFILL: "allocation.backfill",
  ASSET_TAG_FROM_GRN: "asset.tagFromGrn",
  CPC_CASE_CREATE: "cpc.caseCreate",
  CPC_CASE_RESOLVE: "cpc.caseResolve",
  CPC_CEO_DECIDE: "cpc.ceoDecide",
  CPC_MEETING_ENSURE: "cpc.meetingEnsure",
  INSPECTION_SCHEDULE: "inspection.schedule",
  INVENTORY_MOVEMENT_POST: "inventory.movementPost",
  POLICY_LAPSE_EXPIRED: "policy.lapseExpired",
  PQ_EXPIRY_WARN: "prequalification.expiryWarn",
  CONTROL_CALENDAR_ROLL: "control.calendarRoll",
  EXCEPTION_ESCALATE: "exception.escalate",
  APPROVAL_ESCALATE: "approval.escalate",
  SPLIT_DETECT: "compliance.splitDetect",
  CONTRACT_EXPIRY_SWEEP: "contract.expirySweep",
  DELEGATION_SWEEP: "delegation.sweep",
  VENDOR_RETURN_CREATE: "vendorReturn.create",
  PO_FULFILMENT_RECOMPUTE: "po.fulfilmentRecompute",
  PO_ACK_LAPSE: "po.acknowledgementLapse",
  PO_TRANSITION: "po.transition",
  PR_TRANSITION: "pr.transition",
  RESERVATION_CONSUME: "reservation.consume",
  RESERVATION_CREATE: "reservation.create",
  RESERVATION_RELEASE: "reservation.release",
  SAVINGS_RECORD: "savings.record",
  VARIANCE_RECORD: "variance.record",
  VENDOR_PERFORMANCE_COMPUTE: "vendor.performanceCompute",
} as const;

export type DomainAction = (typeof DOMAIN_ACTIONS)[keyof typeof DOMAIN_ACTIONS];

/* ── System actors ─────────────────────────────────────────────────────── */

export type SystemPurpose = "SCHEDULER" | "MIGRATION" | "SEED";

/**
 * Exactly what each purpose may do. Anything absent is refused.
 *
 * These lists name only what is actually wired today, so the grant doubles as a
 * statement of what runs unattended. `lapseExpiredPolicies` and
 * `expireStaleReservations` exist but have no caller yet; the scheduler gets
 * those actions when the job that calls them is written, not in advance.
 */
const SYSTEM_GRANTS: Record<SystemPurpose, readonly DomainAction[]> = {
  /** Unattended rollups. `scripts/rollups.ts`. */
  SCHEDULER: [
    DOMAIN_ACTIONS.VENDOR_PERFORMANCE_COMPUTE,
    DOMAIN_ACTIONS.PO_ACK_LAPSE,
    DOMAIN_ACTIONS.PQ_EXPIRY_WARN,
    DOMAIN_ACTIONS.CONTROL_CALENDAR_ROLL,
    DOMAIN_ACTIONS.EXCEPTION_ESCALATE,
    DOMAIN_ACTIONS.APPROVAL_ESCALATE,
    DOMAIN_ACTIONS.SPLIT_DETECT,
    DOMAIN_ACTIONS.CONTRACT_EXPIRY_SWEEP,
    DOMAIN_ACTIONS.DELEGATION_SWEEP,
  ],
  /** One-off backfills run from `scripts/`, never from a request. */
  MIGRATION: [DOMAIN_ACTIONS.ALLOCATION_BACKFILL],
  /** Demo and fixture loading. Broad by design, and unreachable from the app. */
  SEED: Object.values(DOMAIN_ACTIONS),
};

const SYSTEM_NAMES: Record<SystemPurpose, string> = {
  SCHEDULER: "System · scheduler",
  MIGRATION: "System · migration",
  SEED: "System · seed",
};

export type SystemActor = SessionUser & {
  readonly system: SystemPurpose;
  readonly allowedActions: readonly string[];
};

export type Actor = SessionUser | SystemActor;

/**
 * Builds a system principal. Constructed in-process only: nothing decodes one
 * from a cookie, a header or a form field, so a request cannot present itself
 * as the scheduler.
 */
export function systemActor(purpose: SystemPurpose): SystemActor {
  return {
    id: `system:${purpose.toLowerCase()}`,
    email: "",
    name: SYSTEM_NAMES[purpose],
    title: null,
    primaryEntityId: null,
    primaryDepartmentId: null,
    primaryEntityCode: null,
    primaryEntityName: null,
    primaryDepartmentName: null,
    roleCodes: [],
    roleNames: [SYSTEM_NAMES[purpose]],
    // Deliberately empty. A system actor is authorized by its action grant,
    // never by holding a human permission — so a permission-based check on a
    // system actor fails, which is what we want for anything not granted.
    permissions: [],
    entityIds: [],
    system: purpose,
    allowedActions: SYSTEM_GRANTS[purpose],
  };
}

export function isSystemActor(actor: Actor): actor is SystemActor {
  return typeof (actor as SystemActor).system === "string";
}

/* ── Authority ─────────────────────────────────────────────────────────── */

export type Authority =
  /** The actor must personally hold one of these permissions. */
  | { readonly permission: readonly string[] }
  /**
   * This step follows from the operation named in `cascade`, for which the actor
   * was authorized. `from` names the permission that authorized *that*, and is
   * re-verified here — so a caller cannot assert authority the actor lacks.
   */
  | { readonly cascade: string; readonly from: readonly string[] }
  /**
   * The actor owns the record. Some rights do not come from a role: a requester
   * may submit their own requisition whether or not they hold `pr.submit`.
   *
   * This is checked against the owner id on the row the *authorizing* function
   * loaded itself, passed in as `ctx.ownerId` — not against anything the caller
   * asserts. `orPermission` gives the alternative role-based route, so a
   * procurement officer acting on somebody else's requisition still passes.
   */
  | { readonly ownRecord: string; readonly orPermission: readonly string[] };

/** Facts the authorizing function has established from the database itself. */
export type AuthorityContext = { readonly ownerId?: string | null };

/**
 * The single gate. Throws `ForbiddenError` unless the actor is authorized for
 * `action` on the stated grounds.
 */
export function assertAuthority(
  actor: Actor,
  action: DomainAction,
  authority: Authority,
  ctx: AuthorityContext = {},
): void {
  if (isSystemActor(actor)) {
    if (!actor.allowedActions.includes(action)) {
      throw new ForbiddenError(
        `${actor.name} is not authorized for ${action}. Granted: ${actor.allowedActions.join(", ") || "nothing"}.`,
      );
    }
    return;
  }

  if ("ownRecord" in authority) {
    if (ctx.ownerId && ctx.ownerId === actor.id) return;
    if (authority.orPermission.some((p) => actor.permissions.includes(p))) return;
    throw new ForbiddenError(
      `${authority.ownRecord} is limited to the record's owner (${action}). Otherwise requires: ${authority.orPermission.join(" or ")}.`,
    );
  }

  const required = "permission" in authority ? authority.permission : authority.from;
  if (!required.length) {
    // An empty requirement would authorize everyone. Treat it as a programming
    // error rather than an open door.
    throw new ForbiddenError(`${action} has no permission requirement configured; refusing.`);
  }
  if (required.some((p) => actor.permissions.includes(p))) return;

  throw new ForbiddenError(
    "permission" in authority
      ? `You do not have permission to perform this action (${action}). Requires: ${required.join(" or ")}. Your roles: ${actor.roleNames.join(", ") || "none"}.`
      : `This step follows from ${authority.cascade}, which you are not authorized for (${action}). Requires: ${required.join(" or ")}.`,
  );
}
