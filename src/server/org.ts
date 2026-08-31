import { prisma, withTransaction, type DbClient } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { GRADES, buildOrgTree, grade, gradesAbove, pocLabel, type ScmFunction } from "@/lib/org";

/**
 * The organisation as the system uses it.
 *
 * Two things depend on this. Approval routing, which needs to know who is above
 * a person when a decision has to move up; and the points of contact, which are
 * what turn "procurement will handle it" into a named person a requester can
 * chase. Both were previously answerable only by asking somebody.
 */

export type OrgPerson = {
  id: string;
  name: string;
  email: string;
  title: string | null;
  active: boolean;
  grade: string | null;
  scmFunction: string | null;
  orgPosition: number | null;
  reportsToId: string | null;
};

/** Everybody placed on the organogram, in the order the slide printed them. */
export async function orgPeople(fn?: ScmFunction, db: DbClient = prisma): Promise<OrgPerson[]> {
  const people = await db.user.findMany({
    where: {
      grade: { not: null },
      ...(fn ? { OR: [{ scmFunction: fn }, { scmFunction: "SHARED" }] } : {}),
    },
    select: {
      id: true,
      name: true,
      email: true,
      title: true,
      active: true,
      grade: true,
      scmFunction: true,
      orgPosition: true,
      reportsToId: true,
    },
    orderBy: [{ orgPosition: "asc" }, { name: "asc" }],
  });
  return people;
}

/** The organogram as a tree, for the screen that draws it. */
export async function orgTree(fn?: ScmFunction, db: DbClient = prisma) {
  const people = await orgPeople(fn, db);
  return buildOrgTree(people, fn);
}

/**
 * Who this person reports to.
 *
 * The named line manager wins when one is recorded; otherwise the most senior
 * active person at the grade above on the same branch. That fallback is what
 * keeps a chain moving when somebody leaves and their reports have not yet been
 * re-pointed.
 */
export async function lineManager(userId: string, db: DbClient = prisma): Promise<OrgPerson | null> {
  const me = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, grade: true, scmFunction: true, reportsToId: true },
  });
  if (!me) return null;

  if (me.reportsToId) {
    const named = await db.user.findFirst({
      where: { id: me.reportsToId, active: true },
      select: {
        id: true,
        name: true,
        email: true,
        title: true,
        active: true,
        grade: true,
        scmFunction: true,
        orgPosition: true,
        reportsToId: true,
      },
    });
    if (named) return named;
  }

  for (const up of gradesAbove(me.grade)) {
    const candidate = await db.user.findFirst({
      where: { grade: up.code, active: true, id: { not: userId } },
      orderBy: [{ orgPosition: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        title: true,
        active: true,
        grade: true,
        scmFunction: true,
        orgPosition: true,
        reportsToId: true,
      },
    });
    if (candidate) return candidate;
  }
  return null;
}

/**
 * The escalation chain above a person, nearest first.
 *
 * An approval that has sat past its target is handed to the next name on this
 * list rather than to "whoever holds the role", which is how a queue ends up
 * with three people each assuming another one has it.
 */
export async function escalationChain(userId: string, db: DbClient = prisma): Promise<OrgPerson[]> {
  const chain: OrgPerson[] = [];
  const seen = new Set<string>([userId]);
  let current = userId;
  // The ladder is thirteen rungs; the bound is a guard against a reporting loop
  // somebody has entered by hand, not an expectation about depth.
  for (let i = 0; i < GRADES.length; i++) {
    const up = await lineManager(current, db);
    if (!up || seen.has(up.id)) break;
    chain.push(up);
    seen.add(up.id);
    current = up.id;
  }
  return chain;
}

/**
 * The people at or above a grade, for an approval step that names a grade
 * rather than a role.
 */
export async function peopleAtOrAbove(gradeCode: string, db: DbClient = prisma): Promise<OrgPerson[]> {
  const g = grade(gradeCode);
  if (!g) return [];
  const codes = [g.code, ...gradesAbove(gradeCode).map((x) => x.code)];
  return db.user.findMany({
    where: { grade: { in: codes }, active: true },
    orderBy: [{ orgPosition: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      title: true,
      active: true,
      grade: true,
      scmFunction: true,
      orgPosition: true,
      reportsToId: true,
    },
  });
}

/* ── Points of contact ────────────────────────────────────── */

export type Poc = {
  id: string;
  userId: string;
  name: string;
  email: string;
  title: string | null;
  grade: string | null;
  responsibility: string;
  responsibilityLabel: string;
  primary: boolean;
};

/**
 * Who to speak to for a department, optionally for one responsibility.
 *
 * Falls back to the department's general contacts when nobody is named for the
 * specific responsibility, then to the department head — so the question "who
 * owns this" always has an answer rather than an empty list.
 */
export async function pocsFor(
  departmentId: string,
  responsibility?: string,
  db: DbClient = prisma,
): Promise<Poc[]> {
  const rows = await db.departmentPoc.findMany({
    where: {
      departmentId,
      active: true,
      ...(responsibility ? { OR: [{ responsibility }, { responsibility: "GENERAL" }] } : {}),
    },
    include: { user: { select: { id: true, name: true, email: true, title: true, grade: true, active: true } } },
    orderBy: [{ primary: "desc" }],
  });

  const live = rows.filter((r) => r.user.active);
  const mapped = live.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: r.user.name,
    email: r.user.email,
    title: r.user.title,
    grade: r.user.grade,
    responsibility: r.responsibility,
    responsibilityLabel: pocLabel(r.responsibility),
    primary: r.primary,
  }));

  // Named for this responsibility beats a general contact.
  if (responsibility) {
    const exact = mapped.filter((m) => m.responsibility === responsibility);
    if (exact.length) return exact;
  }
  return mapped;
}

/** The single person to name on a document, or null when nobody is appointed. */
export async function primaryPoc(
  departmentId: string,
  responsibility?: string,
  db: DbClient = prisma,
): Promise<Poc | null> {
  const all = await pocsFor(departmentId, responsibility, db);
  return all.find((p) => p.primary) ?? all[0] ?? null;
}

/* ── Maintenance ─────────────────────────────────────────── */

export async function placeOnOrganogram(
  user: SessionUser,
  input: {
    userId: string;
    grade: string | null;
    scmFunction?: string | null;
    reportsToId?: string | null;
    orgPosition?: number | null;
  },
  db: DbClient = prisma,
) {
  if (!userHasPermission(user, P.USER_MANAGE)) {
    throw new ForbiddenError("You do not have permission to change the organisation structure.");
  }
  const subject = await db.user.findUnique({ where: { id: input.userId }, select: { id: true, name: true } });
  if (!subject) throw new NotFoundError("User");

  if (input.grade && !grade(input.grade)) {
    throw new ValidationError(`${input.grade} is not a grade on the organogram.`);
  }
  if (input.reportsToId === input.userId) {
    throw new ValidationError("Somebody cannot report to themselves.");
  }
  // A reporting loop would make escalation run forever; it is refused at the
  // point of entry rather than guarded against on every read.
  if (input.reportsToId) {
    let cursor: string | null = input.reportsToId;
    const seen = new Set<string>([input.userId]);
    while (cursor) {
      if (seen.has(cursor)) throw new ValidationError("That reporting line loops back on itself.");
      seen.add(cursor);
      const next: { reportsToId: string | null } | null = await db.user.findUnique({
        where: { id: cursor },
        select: { reportsToId: true },
      });
      cursor = next?.reportsToId ?? null;
    }
  }

  const g = grade(input.grade);
  const updated = await db.user.update({
    where: { id: input.userId },
    data: {
      grade: input.grade,
      scmFunction: input.scmFunction ?? g?.fn ?? null,
      reportsToId: input.reportsToId ?? null,
      orgPosition: input.orgPosition ?? null,
      ...(g ? { title: g.title } : {}),
    },
  });

  await writeAudit(
    {
      entityType: "User",
      entityId: updated.id,
      entityRef: updated.name,
      action: "ORG_PLACEMENT_CHANGED",
      newValue: { grade: updated.grade, reportsToId: updated.reportsToId },
      actor: user,
    },
    db,
  );
  return updated;
}

export async function appointPoc(
  user: SessionUser,
  input: { departmentId: string; userId: string; responsibility: string; primary?: boolean },
  db: DbClient = prisma,
) {
  return withTransaction(db, async (tx) => {
    if (!userHasPermission(user, P.MASTER_DATA_MANAGE, P.USER_MANAGE)) {
      throw new ForbiddenError("You do not have permission to appoint a point of contact.");
    }
    // Only one primary per responsibility: two primaries is the same as none,
    // because a requester still has to choose.
    if (input.primary) {
      await tx.departmentPoc.updateMany({
        where: { departmentId: input.departmentId, responsibility: input.responsibility, primary: true },
        data: { primary: false },
      });
    }
    const existing = await tx.departmentPoc.findFirst({
      where: { departmentId: input.departmentId, userId: input.userId, responsibility: input.responsibility },
    });
    const poc = existing
      ? await tx.departmentPoc.update({
          where: { id: existing.id },
          data: { primary: Boolean(input.primary), active: true },
        })
      : await tx.departmentPoc.create({
          data: {
            departmentId: input.departmentId,
            userId: input.userId,
            responsibility: input.responsibility,
            primary: Boolean(input.primary),
          },
        });

    await writeAudit(
      {
        entityType: "DepartmentPoc",
        entityId: poc.id,
        entityRef: pocLabel(input.responsibility),
        action: existing ? "POC_UPDATED" : "POC_APPOINTED",
        newValue: { userId: input.userId, primary: poc.primary },
        actor: user,
      },
      tx,
    );
    return poc;
  });
}

export async function removePoc(user: SessionUser, pocId: string, db: DbClient = prisma) {
  if (!userHasPermission(user, P.MASTER_DATA_MANAGE, P.USER_MANAGE)) {
    throw new ForbiddenError("You do not have permission to remove a point of contact.");
  }
  const poc = await db.departmentPoc.update({ where: { id: pocId }, data: { active: false } });
  await writeAudit(
    { entityType: "DepartmentPoc", entityId: poc.id, action: "POC_REMOVED", actor: user },
    db,
  );
  return poc;
}
