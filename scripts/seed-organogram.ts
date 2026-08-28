import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { GRADES, grade } from "@/lib/org";

/**
 * Loads the two supply chain organograms.
 *
 * The source is the pair of slides: Procurement_Department_Organogram and
 * Logistics_Department_Organogram. Their top three positions are the same three
 * people, so this is one organisation with two branches rather than two
 * organisations that happen to share a director.
 *
 * Idempotent: run it again after the slides change and only what moved is
 * written. Nobody is deactivated by this script — a name disappearing from a
 * slide is a decision for somebody to take deliberately, not a side effect of a
 * re-import.
 */

type Person = {
  position: number;
  name: string;
  grade: string;
  /** Only where the appointment is narrower than the grade, e.g. a category. */
  titleOverride?: string;
  /** Named line manager where the slide's order does not imply it. */
  reportsTo?: string;
};

/** Positions 1–3, shared by both slides. */
const LEADERSHIP: Person[] = [
  { position: 1, name: "Mariam Saleem", grade: "SR_DIRECTOR_SCM" },
  { position: 2, name: "Faisal Mir", grade: "DIRECTOR_SCM", reportsTo: "Mariam Saleem" },
  { position: 3, name: "Ali Mehmood", grade: "ASST_DIRECTOR_SCM", reportsTo: "Faisal Mir" },
];

const PROCUREMENT: Person[] = [
  { position: 4, name: "Asif Raza Khan", grade: "SR_MANAGER_PROC", reportsTo: "Ali Mehmood" },
  { position: 5, name: "Arsalan Ahmed", grade: "SR_MANAGER_PROC", reportsTo: "Ali Mehmood" },
  { position: 6, name: "Malik Ahsan Ali", grade: "MANAGER_PROC", reportsTo: "Asif Raza Khan" },
  { position: 7, name: "Umair Butt", grade: "AM_PROC", reportsTo: "Malik Ahsan Ali" },
  { position: 8, name: "Ch Munawar", grade: "AM_PROC", reportsTo: "Malik Ahsan Ali" },
  { position: 9, name: "Zeeshan Baig", grade: "AM_PROC", reportsTo: "Arsalan Ahmed" },
  {
    position: 10,
    name: "Abdul Wahab",
    grade: "CATEGORY_BUYER",
    titleOverride: "Category Buyer — MEP",
    reportsTo: "Umair Butt",
  },
  {
    position: 11,
    name: "Sammar Abbas",
    grade: "CATEGORY_BUYER",
    titleOverride: "Category Buyer — Civil & Grey",
    reportsTo: "Ch Munawar",
  },
  { position: 12, name: "Abdul Wahab Riaz", grade: "SCM_COORDINATOR", reportsTo: "Zeeshan Baig" },
];

const LOGISTICS: Person[] = [
  { position: 4, name: "Basharat Ali", grade: "SR_MANAGER_LOG", reportsTo: "Ali Mehmood" },
  { position: 5, name: "Muaaz Shakeel", grade: "MANAGER_LOG", reportsTo: "Basharat Ali" },
  { position: 6, name: "Sadiq Rashid", grade: "TEAM_LEAD_LOG", reportsTo: "Muaaz Shakeel" },
  { position: 7, name: "Aslam Sabir", grade: "ASSOCIATE_STORES", reportsTo: "Sadiq Rashid" },
  { position: 8, name: "Ikram Aslam", grade: "STORE_INCHARGE", reportsTo: "Aslam Sabir" },
  { position: 9, name: "Zia Ul Qamar", grade: "STORE_INCHARGE", reportsTo: "Aslam Sabir" },
  { position: 10, name: "Zeeshan Khan", grade: "STORE_INCHARGE", reportsTo: "Aslam Sabir" },
  { position: 11, name: "Shams Arif", grade: "STORE_INCHARGE", reportsTo: "Aslam Sabir" },
  { position: 12, name: "Yousaf Bashir", grade: "STORE_INCHARGE", reportsTo: "Aslam Sabir" },
  { position: 13, name: "Imran Khan", grade: "STORE_INCHARGE", reportsTo: "Aslam Sabir" },
  { position: 14, name: "Shafqat Abbas", grade: "STORE_INCHARGE", reportsTo: "Aslam Sabir" },
  { position: 15, name: "M. Shahzad", grade: "STORE_INCHARGE", reportsTo: "Aslam Sabir" },
];

/** The role each grade is granted, so authority follows the organogram. */
const ROLE_FOR_GRADE: Record<string, string[]> = {
  SR_DIRECTOR_SCM: ["PROCUREMENT_DIRECTOR", "MANAGEMENT_COMMITTEE"],
  DIRECTOR_SCM: ["PROCUREMENT_DIRECTOR"],
  ASST_DIRECTOR_SCM: ["PROCUREMENT_SENIOR_MANAGER"],
  SR_MANAGER_PROC: ["PROCUREMENT_SENIOR_MANAGER"],
  MANAGER_PROC: ["PROCUREMENT_OFFICER"],
  AM_PROC: ["PROCUREMENT_OFFICER"],
  CATEGORY_BUYER: ["BUYER"],
  SCM_COORDINATOR: ["PROCUREMENT_OFFICER"],
  SR_MANAGER_LOG: ["WAREHOUSE_MANAGER"],
  MANAGER_LOG: ["WAREHOUSE_MANAGER"],
  TEAM_LEAD_LOG: ["STORE_MANAGER"],
  ASSOCIATE_STORES: ["STORE_MANAGER"],
  STORE_INCHARGE: ["STORE_RECEIVER"],
};

/** The points of contact the organogram implies, by responsibility. */
const POCS: Array<{ name: string; responsibility: string; primary: boolean }> = [
  { name: "Ali Mehmood", responsibility: "GENERAL", primary: true },
  { name: "Asif Raza Khan", responsibility: "SOURCING", primary: true },
  { name: "Arsalan Ahmed", responsibility: "SOURCING", primary: false },
  { name: "Malik Ahsan Ali", responsibility: "REQUISITION", primary: true },
  { name: "Abdul Wahab", responsibility: "CATEGORY_MEP", primary: true },
  { name: "Sammar Abbas", responsibility: "CATEGORY_CIVIL", primary: true },
  { name: "Abdul Wahab Riaz", responsibility: "REQUISITION", primary: false },
  { name: "Basharat Ali", responsibility: "LOGISTICS", primary: true },
  { name: "Muaaz Shakeel", responsibility: "STORES", primary: true },
  { name: "Aslam Sabir", responsibility: "STORES", primary: false },
];

/**
 * An address for somebody the slide names but the directory does not hold.
 *
 * Derived rather than invented so a re-run finds the same account: the same name
 * always resolves to the same address, and a real address entered later by an
 * administrator is never overwritten by this script.
 */
function addressFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .trim()
    .split(/\s+/)
    .join(".");
  return `${slug}@zameen.com`;
}

async function upsertPerson(p: Person, fn: string, defaultPassword: string) {
  const g = grade(p.grade);
  if (!g) throw new Error(`${p.name} holds grade ${p.grade}, which is not on the ladder.`);

  const email = addressFor(p.name);
  const existing =
    (await prisma.user.findFirst({ where: { email } })) ??
    (await prisma.user.findFirst({ where: { name: p.name } }));

  const title = p.titleOverride ?? g.title;
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { title, grade: p.grade, scmFunction: g.fn === "SHARED" ? "SHARED" : fn, orgPosition: p.position },
    });
    return existing.id;
  }

  const created = await prisma.user.create({
    data: {
      email,
      name: p.name,
      title,
      passwordHash: defaultPassword,
      grade: p.grade,
      scmFunction: g.fn === "SHARED" ? "SHARED" : fn,
      orgPosition: p.position,
    },
  });
  return created.id;
}

async function main() {
  // The same shared seed password every other loaded account uses.
  const defaultPassword = await bcrypt.hash("Passw0rd!", 10);
  const idByName = new Map<string, string>();

  console.log("Loading the supply chain organogram\n");

  for (const [fn, list] of [
    ["SHARED", LEADERSHIP],
    ["PROCUREMENT", PROCUREMENT],
    ["LOGISTICS", LOGISTICS],
  ] as const) {
    for (const p of list) {
      const id = await upsertPerson(p, fn, defaultPassword);
      idByName.set(p.name, id);
      console.log(`  ${String(p.position).padStart(2)}  ${p.name.padEnd(20)} ${p.titleOverride ?? grade(p.grade)!.title}`);
    }
  }

  // Reporting lines are set in a second pass: a manager must exist before
  // somebody can be pointed at them.
  console.log("\nReporting lines");
  let lines = 0;
  for (const p of [...LEADERSHIP, ...PROCUREMENT, ...LOGISTICS]) {
    if (!p.reportsTo) continue;
    const me = idByName.get(p.name);
    const boss = idByName.get(p.reportsTo);
    if (!me || !boss) {
      console.log(`  ! ${p.name} -> ${p.reportsTo}: one of them is not on the organogram`);
      continue;
    }
    await prisma.user.update({ where: { id: me }, data: { reportsToId: boss } });
    lines++;
  }
  console.log(`  ${lines} reporting line(s) recorded`);

  // Roles, so authority follows the organogram rather than being granted by hand.
  console.log("\nRole grants");
  let grants = 0;
  for (const p of [...LEADERSHIP, ...PROCUREMENT, ...LOGISTICS]) {
    const userId = idByName.get(p.name);
    if (!userId) continue;
    for (const roleCode of ROLE_FOR_GRADE[p.grade] ?? []) {
      const role = await prisma.role.findUnique({ where: { code: roleCode } });
      if (!role) {
        console.log(`  ! role ${roleCode} is not defined; run sync:rbac first`);
        continue;
      }
      const held = await prisma.userRole.findFirst({ where: { userId, roleId: role.id } });
      if (!held) {
        await prisma.userRole.create({ data: { userId, roleId: role.id } });
        grants++;
      }
    }
  }
  console.log(`  ${grants} role(s) granted (existing grants left alone)`);

  // Points of contact, against every department that has none for that
  // responsibility. A department that has already named somebody keeps them.
  console.log("\nPoints of contact");
  const departments = await prisma.department.findMany({ where: { active: true }, select: { id: true, name: true } });
  let appointed = 0;
  for (const dept of departments) {
    for (const poc of POCS) {
      const userId = idByName.get(poc.name);
      if (!userId) continue;
      const already = await prisma.departmentPoc.findFirst({
        where: { departmentId: dept.id, responsibility: poc.responsibility, active: true },
      });
      if (already) continue;
      await prisma.departmentPoc.create({
        data: { departmentId: dept.id, userId, responsibility: poc.responsibility, primary: poc.primary },
      });
      appointed++;
    }
  }
  console.log(`  ${appointed} appointment(s) across ${departments.length} department(s)`);

  const placed = await prisma.user.count({ where: { grade: { not: null } } });
  console.log(`\n${placed} people placed across ${GRADES.length} grades.`);
  console.log("Position 13 on the procurement slide was unassigned and has not been created.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
