import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { nextNumber, SEQ } from "@/lib/numbering";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { DOMAIN_ACTIONS, assertAuthority, type Actor } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { round2 } from "@/lib/format";
import { cpcRequirement } from "./cpc";

/**
 * Contracts and agreements.
 *
 * ZAM/PUR/SOP-01 §4.6 gives procurement sole authority to issue "purchase order,
 * **contract, agreement** or any other related documents ... with the signature
 * of Manager Procurement or other authorized signatory". The system had purchase
 * orders and nothing else, so a twelve-month AMC lived either as a single order —
 * which closes when its first invoice is paid, taking the obligation with it — or
 * as nothing at all.
 *
 * The CPC mandate names the types: "SLA · Service Contracts · AMC (Annual
 * Maintenance contract) · Buildouts · Onetime Purchases", and the committee
 * approves any contract over the threshold "based on technical, financial and
 * legal implications of proposed contracts".
 *
 * ## What a contract is that a purchase order is not
 *
 * A standing obligation with an end date. That single distinction produces
 * everything here: an expiry somebody has to see coming, and a value drawn down
 * over time by many orders rather than consumed by one.
 *
 * ## The twelve states, and why EXPIRING is one of them
 *
 * A contract inside its notice period needs a decision — renew, renegotiate, or
 * let it run out — and one that has already run out needs a different and more
 * urgent one. Folding both into "expired" loses the window in which anything can
 * usefully be done, which is the only window that matters.
 */

export const CONTRACT_TYPES = [
  "SLA",
  "SERVICE_CONTRACT",
  "AMC",
  "BUILDOUT",
  "ONE_TIME",
  "RENTAL",
  "FRAMEWORK",
  "OTHER",
] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  SLA: "Service level agreement",
  SERVICE_CONTRACT: "Service contract",
  AMC: "Annual maintenance contract",
  BUILDOUT: "Build-out",
  ONE_TIME: "One-time purchase",
  RENTAL: "Rental agreement",
  FRAMEWORK: "Framework / rate agreement",
  OTHER: "Other",
};

export const CONTRACT_STATES = [
  "DRAFT",
  "PENDING_REVIEW",
  "PENDING_APPROVAL",
  "APPROVED",
  "PENDING_SIGNATURE",
  "ACTIVE",
  "EXPIRING",
  "EXPIRED",
  "RENEWED",
  "SUSPENDED",
  "TERMINATED",
  "CLOSED",
] as const;
export type ContractState = (typeof CONTRACT_STATES)[number];

/**
 * What may follow what.
 *
 * EXPIRING and EXPIRED are reachable only from ACTIVE and set by the scheduled
 * sweep, never chosen by hand — a contract is expiring because of its dates, not
 * because somebody says so.
 */
const FLOW: Record<ContractState, ContractState[]> = {
  DRAFT: ["PENDING_REVIEW", "PENDING_APPROVAL", "CLOSED"],
  PENDING_REVIEW: ["PENDING_APPROVAL", "DRAFT", "CLOSED"],
  PENDING_APPROVAL: ["APPROVED", "DRAFT", "CLOSED"],
  APPROVED: ["PENDING_SIGNATURE", "DRAFT", "CLOSED"],
  PENDING_SIGNATURE: ["ACTIVE", "APPROVED", "CLOSED"],
  ACTIVE: ["EXPIRING", "EXPIRED", "SUSPENDED", "TERMINATED", "RENEWED", "CLOSED"],
  EXPIRING: ["RENEWED", "EXPIRED", "TERMINATED", "ACTIVE", "CLOSED"],
  EXPIRED: ["RENEWED", "CLOSED"],
  RENEWED: ["CLOSED"],
  SUSPENDED: ["ACTIVE", "TERMINATED", "CLOSED"],
  TERMINATED: ["CLOSED"],
  CLOSED: [],
};

async function logEvent(
  db: DbClient,
  contractId: string,
  eventType: string,
  opts: { from?: string | null; to?: string | null; note?: string | null; actorId?: string | null } = {},
) {
  await db.contractEvent.create({
    data: {
      contractId,
      eventType,
      fromStatus: opts.from ?? null,
      toStatus: opts.to ?? null,
      note: opts.note ?? null,
      actorId: opts.actorId ?? null,
    },
  });
}

/**
 * Raises a contract.
 *
 * Whether the committee has to approve it is decided from the value, through the
 * same function the committee module uses, and then held. A threshold changed
 * next year must not make a signed contract look as though it dodged a review.
 */
export async function createContract(
  user: SessionUser,
  input: {
    entityId: string;
    vendorId: string;
    title: string;
    description?: string | null;
    contractType?: ContractType;
    contractValue?: number | null;
    currency?: string;
    startDate?: Date | null;
    endDate?: Date | null;
    noticeDays?: number;
    autoRenew?: boolean;
    paymentTerms?: string | null;
    deliveryLocation?: string | null;
    legalTerms?: string | null;
    slaTerms?: string | null;
    prId?: string | null;
    renewalOfId?: string | null;
  },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    // §4.6 gives procurement *sole* authority here, so the permission is the
    // order-issuing one rather than a general edit right.
    if (!userHasPermission(user, P.PO_CREATE, P.PO_ISSUE)) {
      throw new RuleViolationError(
        "ZAM/PUR/SOP-01 §4.6 gives the procurement department sole authority to issue a contract or agreement.",
      );
    }
    if (!input.title?.trim()) throw new ValidationError("Give the contract a title.");
    if (input.contractType && !CONTRACT_TYPES.includes(input.contractType)) {
      throw new ValidationError("That is not a recognised contract type.");
    }
    if (input.startDate && input.endDate && input.endDate <= input.startDate) {
      throw new ValidationError("The contract must end after it starts.");
    }
    // A standing obligation with no end date is the thing this model exists to
    // prevent, so it is refused for every type that has a term.
    const termless = input.contractType === "ONE_TIME" || input.contractType === "OTHER";
    if (!termless && !input.endDate) {
      throw new ValidationError(
        "State when the contract ends. A standing obligation with no end date is exactly what gets paid for after it stops being needed.",
      );
    }

    const value = input.contractValue ?? null;
    // Asked through the committee module, so the contract and the committee
    // cannot disagree about where the line sits.
    const cpc = await cpcRequirement(
      input.entityId,
      value ?? 0,
      input.contractType === "AMC" || input.contractType === "SLA"
        ? "SERVICE"
        : (input.contractType ?? "SERVICE_CONTRACT"),
      tx,
    );

    const contract = await tx.contract.create({
      data: {
        number: await nextNumber(SEQ.CONTRACT, tx),
        entityId: input.entityId,
        vendorId: input.vendorId,
        title: input.title.trim(),
        description: input.description?.trim() || null,
        contractType: input.contractType ?? "SERVICE_CONTRACT",
        status: "DRAFT",
        currency: input.currency ?? "PKR",
        contractValue: value,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        noticeDays: input.noticeDays ?? 60,
        autoRenew: input.autoRenew ?? false,
        paymentTerms: input.paymentTerms?.trim() || null,
        deliveryLocation: input.deliveryLocation?.trim() || null,
        legalTerms: input.legalTerms?.trim() || null,
        slaTerms: input.slaTerms?.trim() || null,
        prId: input.prId ?? null,
        renewalOfId: input.renewalOfId ?? null,
        committeeRequired: cpc.required,
        createdById: user.id,
      },
    });

    await logEvent(tx, contract.id, "CREATED", {
      to: "DRAFT",
      note: `${CONTRACT_TYPE_LABELS[contract.contractType as ContractType] ?? contract.contractType}${cpc.required ? " — committee approval required" : ""}`,
      actorId: user.id,
    });
    await writeAudit(
      {
        entityType: "Contract",
        entityId: contract.id,
        entityRef: contract.number,
        action: "CONTRACT_CREATED",
        newValue: {
          type: contract.contractType,
          value,
          endDate: contract.endDate,
          committeeRequired: cpc.required,
        },
        actor: user,
      },
      tx,
    );
    return contract;
  });
}

/**
 * Moves a contract along.
 *
 * `EXPIRING` and `EXPIRED` are refused here: those are consequences of dates and
 * are set by the scheduled sweep. A contract is expiring because of its term,
 * not because somebody typed it.
 */
export async function transitionContract(
  user: SessionUser,
  input: { contractId: string; to: ContractState; reason?: string | null; vendorSignatoryName?: string | null },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    const c = await tx.contract.findUnique({
      where: { id: input.contractId },
      include: { vendor: { select: { name: true } } },
    });
    if (!c) throw new NotFoundError("Contract");

    const from = c.status as ContractState;
    if (!CONTRACT_STATES.includes(input.to)) {
      throw new ValidationError("That is not a recognised contract state.");
    }
    if (["EXPIRING", "EXPIRED"].includes(input.to)) {
      throw new RuleViolationError(
        "A contract is expiring or expired because of its dates, not because somebody says so. The scheduled sweep sets those.",
      );
    }
    if (!FLOW[from]?.includes(input.to)) {
      throw new RuleViolationError(
        `${c.number} cannot go from ${from.replace(/_/g, " ").toLowerCase()} to ${input.to.replace(/_/g, " ").toLowerCase()}. ` +
          `Permitted: ${(FLOW[from] ?? []).join(", ").toLowerCase() || "nothing"}.`,
      );
    }

    // Who may do what.
    const need = (...codes: string[]) => {
      if (!userHasPermission(user, ...codes)) {
        throw new RuleViolationError(`You do not have permission to move this contract to ${input.to}.`);
      }
    };
    if (["PENDING_REVIEW", "PENDING_APPROVAL", "DRAFT"].includes(input.to)) need(P.PO_CREATE, P.PO_EDIT);
    if (input.to === "APPROVED") need(P.PO_APPROVE);
    if (input.to === "PENDING_SIGNATURE") need(P.PO_ISSUE, P.PO_APPROVE);
    if (input.to === "ACTIVE") need(P.PO_ISSUE);
    if (["SUSPENDED", "TERMINATED"].includes(input.to)) need(P.PO_APPROVE, P.PO_CANCEL);
    if (input.to === "RENEWED") need(P.PO_CREATE, P.PO_ISSUE);
    if (input.to === "CLOSED") need(P.PO_CLOSE, P.PO_APPROVE);

    // Gates.
    if (input.to === "APPROVED" && c.committeeRequired) {
      const approved = await tx.cpcCase.findFirst({
        where: {
          status: "APPROVED",
          OR: [{ id: c.cpcCaseId ?? "__none__" }, ...(c.prId ? [{ prId: c.prId }] : [])],
        },
        select: { number: true },
      });
      if (!approved) {
        throw new RuleViolationError(
          `${c.number} is at or above the committee threshold, so the CPC must approve it before procurement does. ` +
            "The committee's mandate names contracts specifically.",
        );
      }
    }
    if (input.to === "ACTIVE") {
      if (!c.signedAt) {
        throw new RuleViolationError(
          `${c.number} has not been signed. §4.6 requires the signature of Manager Procurement or another authorised signatory before it goes to the vendor.`,
        );
      }
      if (!c.startDate || !c.endDate) {
        throw new RuleViolationError(
          "A contract cannot become active without a start and an end date — nothing would know when it runs out.",
        );
      }
    }
    if (["SUSPENDED", "TERMINATED"].includes(input.to) && !input.reason?.trim()) {
      throw new ValidationError(`State why the contract is being ${input.to.toLowerCase()}.`);
    }

    const updated = await tx.contract.update({
      where: { id: c.id },
      data: {
        status: input.to,
        statusReason: input.reason?.trim() || null,
        ...(input.to === "TERMINATED"
          ? { terminatedAt: new Date(), terminationReason: input.reason?.trim() ?? null }
          : {}),
        ...(input.to === "CLOSED" ? { closedAt: new Date() } : {}),
        ...(input.to === "ACTIVE" && input.vendorSignatoryName?.trim()
          ? { vendorSignedAt: new Date(), vendorSignatoryName: input.vendorSignatoryName.trim() }
          : {}),
      },
    });

    const EVENT: Record<string, string> = {
      PENDING_REVIEW: "REVIEWED",
      APPROVED: "APPROVED",
      ACTIVE: "ACTIVATED",
      SUSPENDED: "SUSPENDED",
      TERMINATED: "TERMINATED",
      RENEWED: "RENEWED",
      CLOSED: "CLOSED",
    };
    await logEvent(tx, c.id, EVENT[input.to] ?? "AMENDED", {
      from,
      to: input.to,
      note: input.reason?.trim() ?? null,
      actorId: user.id,
    });
    await writeAudit(
      {
        entityType: "Contract",
        entityId: c.id,
        entityRef: c.number,
        action: `CONTRACT_${input.to}`,
        changes: { status: { from, to: input.to } },
        reason: input.reason?.trim() ?? null,
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/**
 * Records the authorised signature — §4.6.
 *
 * Separate from activation because they are separate acts: signing is procurement
 * committing the company, activating is the contract starting to run. A contract
 * signed in March that starts in April is ordinary.
 */
export async function signContract(
  user: SessionUser,
  input: { contractId: string; note?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.PO_ISSUE)) {
    throw new RuleViolationError(
      "§4.6 requires the signature of Manager Procurement or another authorised signatory.",
    );
  }
  const c = await db.contract.findUnique({
    where: { id: input.contractId },
    select: { id: true, number: true, status: true, signedAt: true, committeeRequired: true },
  });
  if (!c) throw new NotFoundError("Contract");
  if (c.signedAt) throw new RuleViolationError(`${c.number} has already been signed.`);
  if (!["APPROVED", "PENDING_SIGNATURE"].includes(c.status)) {
    throw new RuleViolationError(
      `${c.number} is ${c.status.replace(/_/g, " ").toLowerCase()}. A contract is signed once it has been approved.`,
    );
  }

  const updated = await db.contract.update({
    where: { id: c.id },
    data: {
      authorisedSignatoryId: user.id,
      signedAt: new Date(),
      status: "PENDING_SIGNATURE",
    },
  });
  await logEvent(db, c.id, "SIGNED", {
    from: c.status,
    to: "PENDING_SIGNATURE",
    note: input.note?.trim() ?? null,
    actorId: user.id,
  });
  await writeAudit(
    {
      entityType: "Contract",
      entityId: c.id,
      entityRef: c.number,
      action: "CONTRACT_SIGNED",
      newValue: { signatory: user.name },
      reason: input.note?.trim() ?? null,
      actor: user,
    },
    db,
  );
  return updated;
}

/**
 * Moves contracts into and out of their notice window, and warns.
 *
 * Run as a job. Three transitions, all from dates rather than opinions:
 *
 *   · ACTIVE → EXPIRING once inside the notice period, so there is a window in
 *     which something can be done;
 *   · ACTIVE or EXPIRING → EXPIRED once the end date has passed;
 *   · a warning for anything auto-renewing inside its notice window, because an
 *     auto-renewing contract nobody is watching is the one that keeps being paid
 *     for after it stops being needed.
 *
 * It never renews anything. `autoRenew` describes what the paper says, and the
 * system acting on that by itself would create an obligation nobody chose.
 */
export async function sweepContractExpiry(
  actor: Actor,
  db: DbClient = prisma,
): Promise<{ expiring: number; expired: number; autoRenewing: number; notified: number }> {
  assertAuthority(actor, DOMAIN_ACTIONS.CONTRACT_EXPIRY_SWEEP, {
    permission: [P.PO_ISSUE, P.PO_APPROVE, P.AUDIT_VIEW],
  });

  const now = new Date();
  const live = await db.contract.findMany({
    where: { status: { in: ["ACTIVE", "EXPIRING"] }, endDate: { not: null } },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      endDate: true,
      noticeDays: true,
      autoRenew: true,
      entityId: true,
      vendor: { select: { name: true } },
    },
    take: 1000,
  });

  const expiringNow: typeof live = [];
  const expiredNow: typeof live = [];

  for (const c of live) {
    const end = c.endDate!;
    if (end.getTime() < now.getTime()) {
      if (c.status !== "EXPIRED") expiredNow.push(c);
      continue;
    }
    const noticeFrom = new Date(end.getTime() - c.noticeDays * 86400000);
    if (now >= noticeFrom && c.status === "ACTIVE") expiringNow.push(c);
  }

  for (const c of expiringNow) {
    await db.contract.update({ where: { id: c.id }, data: { status: "EXPIRING" } });
    await logEvent(db, c.id, "EXPIRY_WARNED", {
      from: "ACTIVE",
      to: "EXPIRING",
      note: `Inside its ${c.noticeDays}-day notice period; ends ${c.endDate!.toISOString().slice(0, 10)}.`,
    });
    await writeAudit(
      {
        entityType: "Contract",
        entityId: c.id,
        entityRef: c.number,
        action: "CONTRACT_EXPIRING",
        newValue: { endDate: c.endDate, noticeDays: c.noticeDays, autoRenew: c.autoRenew },
        actor,
      },
      db,
    );
  }
  for (const c of expiredNow) {
    await db.contract.update({ where: { id: c.id }, data: { status: "EXPIRED" } });
    await logEvent(db, c.id, "EXPIRY_WARNED", {
      from: c.status,
      to: "EXPIRED",
      note: `Ended ${c.endDate!.toISOString().slice(0, 10)}.`,
    });
    await writeAudit(
      {
        entityType: "Contract",
        entityId: c.id,
        entityRef: c.number,
        action: "CONTRACT_EXPIRED",
        newValue: { endDate: c.endDate },
        actor,
      },
      db,
    );
  }

  const autoRenewing = expiringNow.filter((c) => c.autoRenew);
  let notified = 0;
  if (expiringNow.length || expiredNow.length) {
    notified = await notify(
      {
        roleCodes: ["PROCUREMENT_OFFICER", "PROCUREMENT_SENIOR_MANAGER", "ADMIN_FLOOR_MANAGER"],
        type: "GENERAL",
        priority: autoRenewing.length || expiredNow.length ? "HIGH" : "NORMAL",
        title:
          expiredNow.length
            ? `${expiredNow.length} contract${expiredNow.length === 1 ? " has" : "s have"} expired`
            : `${expiringNow.length} contract${expiringNow.length === 1 ? "" : "s"} inside the notice period`,
        body:
          [...expiredNow, ...expiringNow]
            .slice(0, 8)
            .map((c) => `${c.number} ${c.vendor.name} (ends ${c.endDate!.toISOString().slice(0, 10)})`)
            .join(", ") +
          (autoRenewing.length
            ? ` · ${autoRenewing.length} will renew automatically unless somebody stops them.`
            : ""),
        linkType: "CONTRACT",
        linkUrl: "/contracts",
      },
      db,
    );
  }

  return {
    expiring: expiringNow.length,
    expired: expiredNow.length,
    autoRenewing: autoRenewing.length,
    notified,
  };
}

/**
 * Adds an order's value to what the contract has committed.
 *
 * Called when an order raised against a contract is issued. Refuses to take the
 * contract past its committed value where one is set — a framework agreement
 * with no value commits nothing and is exempt, which is the point of leaving the
 * value null rather than zero.
 */
export async function drawDownContract(
  contractId: string,
  amount: number,
  ref: string,
  db: DbClient = prisma,
): Promise<{ committed: number; remaining: number | null }> {
  const c = await db.contract.findUnique({
    where: { id: contractId },
    select: { id: true, number: true, contractValue: true, committedValue: true, status: true },
  });
  if (!c) throw new NotFoundError("Contract");
  if (!["ACTIVE", "EXPIRING"].includes(c.status)) {
    throw new RuleViolationError(
      `${c.number} is ${c.status.replace(/_/g, " ").toLowerCase()}, so nothing can be drawn against it.`,
    );
  }

  const committed = round2(c.committedValue + amount);
  if (c.contractValue != null && c.contractValue > 0 && committed > c.contractValue + 0.01) {
    throw new RuleViolationError(
      `${ref} would take ${c.number} to ${committed.toLocaleString("en-PK")} against a contract value of ` +
        `${c.contractValue.toLocaleString("en-PK")}. Amend the contract, or raise this outside it.`,
    );
  }

  await db.contract.update({ where: { id: c.id }, data: { committedValue: committed } });
  await logEvent(db, c.id, "AMENDED", { note: `${ref} drew ${amount.toLocaleString("en-PK")}.` });
  return {
    committed,
    remaining: c.contractValue != null ? round2(c.contractValue - committed) : null,
  };
}

export async function listContracts(
  filter: { entityIds?: string[] | null; status?: string | null; vendorId?: string | null } = {},
  db: DbClient = prisma,
) {
  return db.contract.findMany({
    where: {
      ...(filter.entityIds ? { entityId: { in: filter.entityIds } } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.vendorId ? { vendorId: filter.vendorId } : {}),
    },
    include: {
      vendor: { select: { id: true, name: true } },
      entity: { select: { code: true } },
      createdBy: { select: { name: true } },
      authorisedSignatory: { select: { name: true } },
    },
    orderBy: [{ endDate: "asc" }],
    take: 400,
  });
}

export async function contractDetail(id: string, db: DbClient = prisma) {
  return db.contract.findUnique({
    where: { id },
    include: {
      vendor: true,
      entity: { select: { code: true, name: true } },
      createdBy: { select: { name: true, title: true } },
      authorisedSignatory: { select: { name: true, title: true } },
      renewalOf: { select: { id: true, number: true } },
      renewals: { select: { id: true, number: true, status: true } },
      pr: { select: { id: true, number: true } },
      events: {
        orderBy: { occurredAt: "desc" },
        include: { actor: { select: { name: true } } },
        take: 100,
      },
    },
  });
}
