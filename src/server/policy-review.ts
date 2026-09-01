import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { NotFoundError, RuleViolationError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { assertEntityAccess, userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";

/**
 * AS-014 — the business unit manager's review obligations.
 *
 * The Scrap Material Policy's enforcement clauses put three standing duties on
 * business unit managers, and each is a different act:
 *
 *   1. Review the policy with employees, and *maintain documentation of the
 *      review*. Not "publish the policy" — sit down with the team and keep the
 *      note that it happened.
 *   2. Incorporate the policy into new-employee orientation. A joiner-facing
 *      obligation, so it is measured against joiners rather than against a date.
 *   3. Periodically review disposal procedures and practices. A look at how the
 *      thing is actually being done, which is not the same as reading the policy.
 *
 * Policy *acknowledgement* already exists — each person ticking that they have
 * read a version. This is the manager's side of it, and the two are deliberately
 * separate: a team where everybody has acknowledged the document and nobody has
 * ever discussed it satisfies one and not the other, which is precisely the
 * distinction the clause draws by asking for a documented review.
 */

export const REVIEW_KINDS = ["TEAM_REVIEW", "ORIENTATION", "PRACTICE_REVIEW"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_KIND_LABELS: Record<ReviewKind, string> = {
  TEAM_REVIEW: "Policy reviewed with the team",
  ORIENTATION: "Policy covered in new-employee orientation",
  PRACTICE_REVIEW: "Disposal procedures and practices reviewed",
};

export const REVIEW_KIND_SOURCE: Record<ReviewKind, string> = {
  TEAM_REVIEW:
    "Scrap Material Policy enforcement 1 — 'review the policy with employees and maintain documentation of the review'.",
  ORIENTATION:
    "Scrap Material Policy enforcement 2 — 'incorporate the policy into new-employee orientation'.",
  PRACTICE_REVIEW:
    "Scrap Material Policy enforcement 3 — 'periodically review disposal procedures and practices'.",
};

export async function recordPolicyReview(
  user: SessionUser,
  input: {
    policyId: string;
    kind: ReviewKind;
    departmentId?: string | null;
    entityId?: string | null;
    attendeeCount?: number | null;
    attendeeNames?: string | null;
    notes: string;
    reviewedAt?: Date | null;
    /** For a practice review: what was found, which is the point of doing one. */
    findings?: string | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.CONFIG_MANAGE, P.ROLE_MANAGE, P.DISPOSAL_APPROVE, P.AUDIT_VIEW)) {
    throw new RuleViolationError("You do not have permission to record a policy review.");
  }
  if (!REVIEW_KINDS.includes(input.kind)) throw new ValidationError("Unknown review kind.");
  if (!input.notes?.trim()) {
    throw new ValidationError(
      "Say what the review covered. The clause asks for documentation of the review, and a record with no content is not documentation.",
    );
  }
  // A practice review with no findings has not looked at anything. "Nothing to
  // report" is a finding and can be written; silence cannot.
  if (input.kind === "PRACTICE_REVIEW" && !input.findings?.trim()) {
    throw new ValidationError(
      "Record what the practice review found — including 'nothing wanting', if that is the answer. A review with no findings is indistinguishable from one that did not happen.",
    );
  }
  if (input.kind === "TEAM_REVIEW" && !(input.attendeeCount && input.attendeeCount > 0)) {
    throw new ValidationError(
      "Say how many people attended. A review with the team is a meeting, and a meeting with nobody in it is not one.",
    );
  }

  const policy = await db.policyDocument.findUnique({
    where: { id: input.policyId },
    select: { id: true, code: true, title: true, version: true, entityId: true },
  });
  if (!policy) throw new NotFoundError("Policy");
  if (policy.entityId) assertEntityAccess(user, policy.entityId);

  const review = await db.policyReview.create({
    data: {
      policyId: policy.id,
      kind: input.kind,
      // The version reviewed, snapshotted. A review of version 2 says nothing
      // about version 3, and a register that forgot which was reviewed would
      // report a stale review as current.
      policyVersion: policy.version,
      departmentId: input.departmentId ?? null,
      entityId: input.entityId ?? policy.entityId ?? null,
      attendeeCount: input.attendeeCount ?? null,
      attendeeNames: input.attendeeNames?.trim() || null,
      notes: input.notes.trim(),
      findings: input.findings?.trim() || null,
      reviewedById: user.id,
      reviewedAt: input.reviewedAt ?? new Date(),
    },
  });

  await writeAudit(
    {
      entityType: "PolicyDocument",
      entityId: policy.id,
      entityRef: `${policy.code} v${policy.version}`,
      action: "POLICY_REVIEW_RECORDED",
      newValue: {
        kind: input.kind,
        attendees: input.attendeeCount ?? null,
        findings: input.findings ?? null,
      },
      actor: user,
    },
    db,
  );
  return review;
}

/**
 * Where each manager's obligations stand.
 *
 * Measured per department, because that is who the clause puts the duty on. The
 * orientation obligation is measured against *joiners* rather than a date: a
 * department that has taken nobody on has nothing outstanding, and one that has
 * taken on four people since its last orientation record has four.
 */
export async function reviewStanding(
  opts: { entityIds?: string[] | null; windowDays?: number } = {},
  db: DbClient = prisma,
) {
  const windowDays = opts.windowDays ?? 365;
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const [policies, departments, reviews] = await Promise.all([
    db.policyDocument.findMany({
      where: { status: "PUBLISHED", ...(opts.entityIds ? { OR: [{ entityId: { in: opts.entityIds } }, { entityId: null }] } : {}) },
      select: { id: true, code: true, title: true, version: true, publishedAt: true },
      orderBy: { code: "asc" },
    }),
    db.department.findMany({
      where: { active: true, ...(opts.entityIds ? { entityId: { in: opts.entityIds } } : {}) },
      select: { id: true, name: true, headId: true },
      orderBy: { name: "asc" },
    }),
    db.policyReview.findMany({
      where: { reviewedAt: { gte: since } },
      include: { reviewedBy: { select: { name: true } } },
      orderBy: { reviewedAt: "desc" },
    }),
  ]);

  return policies.map((policy) => ({
    policy,
    departments: departments.map((dept) => {
      const mine = reviews.filter(
        (r) => r.policyId === policy.id && r.departmentId === dept.id && r.policyVersion === policy.version,
      );
      const byKind = (kind: ReviewKind) => mine.find((r) => r.kind === kind) ?? null;
      const team = byKind("TEAM_REVIEW");
      const orientation = byKind("ORIENTATION");
      const practice = byKind("PRACTICE_REVIEW");
      return {
        department: dept.name,
        departmentId: dept.id,
        headId: dept.headId,
        team: team
          ? { at: team.reviewedAt, by: team.reviewedBy.name, attendees: team.attendeeCount }
          : null,
        orientation: orientation ? { at: orientation.reviewedAt, by: orientation.reviewedBy.name } : null,
        practice: practice
          ? { at: practice.reviewedAt, by: practice.reviewedBy.name, findings: practice.findings }
          : null,
        outstanding: [
          team ? null : "TEAM_REVIEW",
          orientation ? null : "ORIENTATION",
          practice ? null : "PRACTICE_REVIEW",
        ].filter(Boolean) as ReviewKind[],
      };
    }),
  }));
}

/**
 * Joiners since a department last recorded an orientation.
 *
 * The clause's obligation is about people, not dates, and this is the honest
 * measure of it: everyone who arrived after the last orientation record and has
 * therefore not been through one.
 */
export async function orientationGap(
  policyId: string,
  opts: { entityIds?: string[] | null } = {},
  db: DbClient = prisma,
) {
  const [departments, records] = await Promise.all([
    db.department.findMany({
      where: { active: true, ...(opts.entityIds ? { entityId: { in: opts.entityIds } } : {}) },
      select: { id: true, name: true },
    }),
    db.policyReview.findMany({
      where: { policyId, kind: "ORIENTATION" },
      orderBy: { reviewedAt: "desc" },
      select: { departmentId: true, reviewedAt: true },
    }),
  ]);
  const lastByDept = new Map<string, Date>();
  for (const r of records) {
    if (r.departmentId && !lastByDept.has(r.departmentId)) lastByDept.set(r.departmentId, r.reviewedAt);
  }

  const out: Array<{ department: string; departmentId: string; since: Date | null; joiners: string[] }> = [];
  for (const dept of departments) {
    const since = lastByDept.get(dept.id) ?? null;
    const joiners = await db.user.findMany({
      where: {
        active: true,
        primaryDepartmentId: dept.id,
        ...(since ? { createdAt: { gt: since } } : {}),
      },
      select: { name: true },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
    if (joiners.length) {
      out.push({ department: dept.name, departmentId: dept.id, since, joiners: joiners.map((j) => j.name) });
    }
  }
  return out;
}

/**
 * PO-006 — tells Logistics an order is in the pipeline.
 *
 * "Logistics informed through a copy of the PO regarding shipment in the
 * pipeline, to align receipt and storage." Distribution to the *vendor* was
 * already tracked; this is the internal leg, and it exists for a practical
 * reason: the store needs to know what is coming so there is somewhere to put it.
 *
 * Recorded on the order's distribution trail and notified to the receiving store,
 * so a delivery that arrives unannounced is visibly one nobody was told about.
 */
export async function informLogistics(
  user: SessionUser,
  input: { poId: string; note?: string | null },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.PO_ISSUE, P.PO_EDIT)) {
    throw new RuleViolationError("You do not have permission to distribute a purchase order.");
  }
  return withTransaction(db, async (tx) => {
    const po = await tx.purchaseOrder.findUnique({
      where: { id: input.poId },
      include: {
        vendor: { select: { name: true } },
        deliveryStore: { select: { id: true, name: true, managerId: true, entityId: true, kind: true } },
        items: { select: { description: true, quantity: true, unit: true } },
      },
    });
    if (!po) throw new NotFoundError("Purchase order");
    assertEntityAccess(user, po.entityId);
    if (!["ISSUED", "APPROVED", "PARTIALLY_RECEIVED"].includes(po.status)) {
      throw new RuleViolationError(
        `${po.number} is ${po.status}. There is no shipment in the pipeline to tell Logistics about.`,
      );
    }
    if (po.logisticsInformedAt) {
      throw new RuleViolationError(`Logistics has already been told about ${po.number}.`);
    }

    const updated = await tx.purchaseOrder.update({
      where: { id: po.id },
      data: {
        logisticsInformedAt: new Date(),
        logisticsInformedById: user.id,
        logisticsNote: input.note?.trim() || null,
      },
    });

    const summary = po.items
      .slice(0, 4)
      .map((i) => `${i.description} — ${i.quantity} ${i.unit}`)
      .join("; ");

    await notify(
      {
        ...(po.deliveryStore?.managerId
          ? { userIds: [po.deliveryStore.managerId] }
          : {
              roleCodes: [
                po.deliveryStore?.kind === "SITE_STORE" ? "SITE_STORE_USER" : "STORE_RECEIVER",
                "WAREHOUSE_MANAGER",
              ],
            }),
        entityId: po.entityId,
        type: "PO_IN_PIPELINE",
        title: `${po.number} in the pipeline — ${po.vendor.name}`,
        body:
          `${summary}${po.items.length > 4 ? `; and ${po.items.length - 4} more line(s)` : ""}. ` +
          `Delivery to ${po.deliveryStore?.name ?? "an unnamed store"}` +
          (po.deliveryDate ? ` by ${po.deliveryDate.toISOString().slice(0, 10)}` : "") +
          ". Align receipt and storage." +
          (input.note?.trim() ? ` ${input.note.trim()}` : ""),
        priority: "NORMAL",
        linkType: "PO",
        linkId: po.id,
        linkUrl: `/po/${po.id}`,
      },
      tx,
    );

    await writeAudit(
      {
        entityType: "PurchaseOrder",
        entityId: po.id,
        entityRef: po.number,
        action: "PO_LOGISTICS_INFORMED",
        newValue: { store: po.deliveryStore?.name ?? null, note: input.note ?? null },
        actor: user,
      },
      tx,
    );
    return updated;
  });
}

/**
 * Issued orders Logistics was never told about.
 *
 * The gap PO-006 exists to close: goods on their way to a store that does not
 * know they are coming, which is how a delivery ends up in a corridor.
 */
export async function logisticsNotInformed(
  opts: { entityIds?: string[] | null } = {},
  db: DbClient = prisma,
) {
  return db.purchaseOrder.findMany({
    where: {
      status: { in: ["ISSUED", "PARTIALLY_RECEIVED"] },
      logisticsInformedAt: null,
      ...(opts.entityIds ? { entityId: { in: opts.entityIds } } : {}),
    },
    select: {
      id: true,
      number: true,
      issuedAt: true,
      deliveryDate: true,
      total: true,
      currency: true,
      vendor: { select: { name: true } },
      deliveryStore: { select: { name: true } },
    },
    orderBy: { issuedAt: "asc" },
    take: 200,
  });
}
