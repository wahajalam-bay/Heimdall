/**
 * Seeds the standing CPC composition — CP-003.
 *
 *   npx tsx scripts/seed-cpc-roster.ts
 *
 * CP-003 asks for "9 seats per entity with designations and types". It names the
 * count and the shape; unlike the RNC's `image22`, it does not name the people.
 *
 * So this seeds the nine seats **by designation, with nobody in them**, and links
 * a person only where exactly one active account holds the obvious role. A seat
 * with no holder is visible on the roster and in the access review as a gap to
 * fill — which is the truth. Inventing nine committee members would be far worse
 * than an empty roster, because a quorum counted against invented members would
 * report itself satisfied.
 *
 * The designations are the ones the system already convenes per case in
 * `resolveMembers`, plus the types CP-007 needs: Internal Audit sits as an
 * observer, attending without voting or counting.
 *
 * Idempotent.
 */
import { prisma } from "../src/lib/db";
import { ENTITY_CODES } from "../src/lib/domain";

type Seat = {
  designation: string;
  /** The role whose single holder, if there is one, fills the seat. */
  roleCode: string | null;
  memberType: "PERMANENT_MANDATORY" | "PERMANENT" | "OBSERVER";
  isChair?: boolean;
};

/**
 * Nine seats.
 *
 * Three are mandatory because CP-011 makes the committee approve the order on
 * "technical, financial and legal implications" — procurement, finance and the
 * functional side are the three that judgement cannot be made without.
 */
const SEATS: Seat[] = [
  {
    designation: "Director Procurement",
    roleCode: "PROCUREMENT_DIRECTOR",
    memberType: "PERMANENT_MANDATORY",
    isChair: true,
  },
  {
    designation: "Head of Finance",
    roleCode: "FINANCE_APPROVER",
    memberType: "PERMANENT_MANDATORY",
  },
  {
    designation: "Senior Manager Administration",
    roleCode: "ADMIN_FLOOR_MANAGER",
    memberType: "PERMANENT_MANDATORY",
  },
  { designation: "Procurement Senior Manager", roleCode: "PROCUREMENT_SENIOR_MANAGER", memberType: "PERMANENT" },
  { designation: "Director IT", roleCode: "IT_USER", memberType: "PERMANENT" },
  { designation: "Management Committee representative", roleCode: "MANAGEMENT_COMMITTEE", memberType: "PERMANENT" },
  { designation: "Warehouse / Logistics Manager", roleCode: "WAREHOUSE_MANAGER", memberType: "PERMANENT" },
  { designation: "Project Management representative", roleCode: "PM_USER", memberType: "PERMANENT" },
  // CP-007's reason for existing.
  { designation: "Internal Audit", roleCode: "AUDIT_USER", memberType: "OBSERVER" },
];

async function soleHolder(roleCode: string | null, entityId: string) {
  if (!roleCode) return null;
  const holders = await prisma.user.findMany({
    where: {
      active: true,
      roles: { some: { role: { code: roleCode } } },
      OR: [{ primaryEntityId: entityId }, { entityAccess: { some: { entityId } } }],
    },
    select: { id: true, name: true },
    take: 2,
  });
  // Only when unambiguous. Picking the first of several would be choosing a
  // committee member by alphabet.
  return holders.length === 1 ? holders[0] : null;
}

async function main() {
  const zam = await prisma.entity.findFirst({ where: { code: ENTITY_CODES.ZM } });
  if (!zam) throw new Error("Zameen Media entity not found.");

  console.log("\nCPC standing composition — CP-003\n");
  let filled = 0;
  let empty = 0;

  for (const [i, seat] of SEATS.entries()) {
    const holder = await soleHolder(seat.roleCode, zam.id);
    if (holder) filled += 1;
    else empty += 1;

    const data = {
      userId: holder?.id ?? null,
      designation: seat.designation,
      memberType: seat.memberType,
      isChair: seat.isChair ?? false,
      active: true,
      sequence: (i + 1) * 10,
    };
    const existing = await prisma.cpcRosterMember.findUnique({
      where: { entityId_memberName: { entityId: zam.id, memberName: seat.designation } },
    });
    if (existing) await prisma.cpcRosterMember.update({ where: { id: existing.id }, data });
    else
      await prisma.cpcRosterMember.create({
        data: { ...data, entityId: zam.id, memberName: seat.designation },
      });

    console.log(
      `  ${seat.designation.padEnd(38)} ${seat.memberType.padEnd(20)}${seat.isChair ? "CHAIR  " : "       "}` +
        (holder ? holder.name : "— vacant"),
    );
  }

  const voting = SEATS.filter((s) => s.memberType !== "OBSERVER").length;
  console.log(`\n  ${SEATS.length} seats · ${voting} voting · ${SEATS.length - voting} observer`);
  console.log(`  ${filled} filled from a single unambiguous role holder · ${empty} vacant`);
  console.log(
    "\n  CP-003 names the count and the types, not the people. Vacant seats are left vacant:",
  );
  console.log(
    "  a quorum counted against invented members would report itself satisfied, which is the",
  );
  console.log("  one outcome worse than an empty roster.\n");
  console.log(
    "  CP-006 needs three voting members present besides the requisitioner's department head.",
  );
  console.log(
    `  With ${filled} seat(s) filled, that is ${filled >= 4 ? "reachable" : "not yet reachable"} — assign the rest before turning`,
  );
  console.log("  on policy.enforce_cpc_quorum.\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
