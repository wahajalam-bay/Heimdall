/**
 * The Checklist of Roles & Responsibilities — `image23.PNG` / `image24.PNG`.
 *
 * BO-007: when the Cross Functional Committee is called, "a sheet of predefined
 * tasks at departmental level" is shared "per the Checklist of Roles &
 * Responsibilities". This is that sheet, transcribed from the document: ten
 * departments and the responsibilities each carries on a build-out.
 *
 * Held in code rather than in configuration because it is the document's own
 * content, not a policy setting — changing it would mean the checklist had
 * changed, which is a document revision and not a tuning knob. It is copied onto
 * each build-out when the committee is convened, so a later revision cannot
 * rewrite what a finished project was actually asked to do.
 *
 * The department names are the checklist's own. Several match a Department
 * record and several do not — "Architect" is a function on this checklist and
 * not necessarily a department in the org — so the name is carried as text and
 * matched to a record where one exists.
 */

export type ChecklistEntry = {
  department: string;
  responsibilities: string[];
};

export const BUILD_OUT_CHECKLIST: ChecklistEntry[] = [
  {
    department: "Sales",
    responsibilities: ["Hiring forecast", "Initial requirements coordination"],
  },
  {
    department: "HR",
    responsibilities: ["Attendance machines", "Departmental hiring", "Trainings"],
  },
  {
    department: "IT",
    responsibilities: [
      "Support staff deployment",
      "Database administration",
      "Required trainings",
      "IT equipment deployment",
      "Internet connectivity",
    ],
  },
  {
    department: "Procurement",
    responsibilities: [
      "RFQ to vendors",
      "Quotations",
      "Timely asset tagging",
      "Comparative statements",
      "Procurement orders",
    ],
  },
  {
    department: "Administration",
    responsibilities: [
      "Detailed requirement gathering",
      "Timely deliveries at site",
      "Requirement gathering",
      "Scope of work",
      "Work order generation",
      "Day-wise schedule compliance",
      "Timely BOQ monitoring with actual",
      "Timely reporting of issues",
    ],
  },
  {
    department: "Finance",
    responsibilities: ["Timely disbursement of funds"],
  },
  {
    department: "Internal Audit",
    responsibilities: ["Pre-audit of payments", "Compliance assurance", "BOQ comparison"],
  },
  {
    department: "Architect",
    responsibilities: [
      "Layout finalisation",
      "Design preparation",
      "BOQ finalisation",
      "Timely site visits",
    ],
  },
  {
    department: "Marketing",
    responsibilities: ["Branding requirements at initial stage"],
  },
  {
    department: "Legal",
    responsibilities: ["Contract creation"],
  },
];

/** Flat, in the order the checklist lists them, for copying onto a build-out. */
export function checklistLines(): Array<{ department: string; responsibility: string; sequence: number }> {
  const out: Array<{ department: string; responsibility: string; sequence: number }> = [];
  let seq = 0;
  for (const group of BUILD_OUT_CHECKLIST) {
    for (const responsibility of group.responsibilities) {
      out.push({ department: group.department, responsibility, sequence: (seq += 10) });
    }
  }
  return out;
}

/** How many named responsibilities the document carries. */
export const CHECKLIST_COUNT = BUILD_OUT_CHECKLIST.reduce(
  (a, g) => a + g.responsibilities.length,
  0,
);

/**
 * The Cross Functional Team's seats — `image21.PNG`.
 *
 * The document names a member and a proxy for each seat. Two seats are listed
 * with no proxy at all (Talent Acquisition and Logistic), and that is carried
 * as null rather than filled in: a seat with nobody to stand in is a real gap
 * in the roster, and inventing a name would hide it.
 */
export const CFT_SEATS: Array<{ seat: string; member: string; proxy: string | null }> = [
  { seat: "Sales Central", member: "Shuja Ullah Sheikh", proxy: "Regional Manager" },
  { seat: "Sales North", member: "Hassan Danish", proxy: "Hassan Shah" },
  { seat: "Sales South", member: "Taha Mehmood", proxy: "Murtaza Zaheer" },
  { seat: "Finance", member: "Tanzain Shafqat", proxy: "Hammad Khursheed" },
  { seat: "HR", member: "Wajiha Khan", proxy: "Khurram" },
  { seat: "Talent Acquisition", member: "Aamna Jaffery", proxy: null },
  { seat: "IT", member: "Shahid Hassan", proxy: "Mudassir" },
  { seat: "Procurement", member: "Mariam Saleem", proxy: "Ali Mahmood" },
  { seat: "Internal Audit", member: "Basil Akram", proxy: "Umer Sukhera" },
  { seat: "Architect", member: "Haroon", proxy: "Aasma" },
  { seat: "Legal", member: "Maryam Haq", proxy: "Fareeha" },
  { seat: "Logistic", member: "Basharat Ali", proxy: null },
  { seat: "Administration", member: "Irfan Aslam", proxy: "Adeel Khalid" },
];

/**
 * The Rental & Negotiation Committee's composition — `image22.PNG`.
 *
 * Central is listed in full. North and South are listed as "3 members in total"
 * while naming three apiece including a shared Country Head, which is the
 * arithmetic the source matrix flags — so the named people are carried and the
 * count is left to be read from them rather than asserted.
 */
export const RNC_ROSTER: Array<{
  region: string;
  name: string;
  designation: string;
  memberType: "PERMANENT_MANDATORY" | "PERMANENT" | "OBSERVER";
  isHead?: boolean;
}> = [
  // Central
  {
    region: "CENTRAL",
    name: "Sheikh Shuja ullah Khan",
    designation: "Sr. Director Sales",
    memberType: "PERMANENT_MANDATORY",
    isHead: true,
  },
  {
    region: "CENTRAL",
    name: "Mariam Saleem",
    designation: "Director Procurement",
    memberType: "PERMANENT_MANDATORY",
  },
  {
    region: "CENTRAL",
    name: "Irfan Aslam",
    designation: "Sr. Manager Admin",
    memberType: "PERMANENT_MANDATORY",
  },
  { region: "CENTRAL", name: "Adil Kamal", designation: "Head of Acquisition", memberType: "PERMANENT" },
  { region: "CENTRAL", name: "Haseeb Malik", designation: "Director Marketing", memberType: "PERMANENT" },
  { region: "CENTRAL", name: "Shahid Hassan", designation: "Director IT", memberType: "PERMANENT" },
  { region: "CENTRAL", name: "Tanzain Shafqat", designation: "Head of Finance", memberType: "PERMANENT" },
  {
    region: "CENTRAL",
    name: "Basil Akram",
    designation: "AM Internal Audit",
    memberType: "OBSERVER",
  },
  // North
  { region: "NORTH", name: "Ahmad Bhatti", designation: "Country Head", memberType: "PERMANENT" },
  {
    region: "NORTH",
    name: "Hassan Danish",
    designation: "Senior Director",
    memberType: "PERMANENT_MANDATORY",
    isHead: true,
  },
  {
    region: "NORTH",
    name: "Syed Hassan Ali Shah",
    designation: "Sr Manager Admin",
    memberType: "PERMANENT_MANDATORY",
  },
  // South
  { region: "SOUTH", name: "Ahmad Bhatti", designation: "Country Head", memberType: "PERMANENT" },
  {
    region: "SOUTH",
    name: "Taha Mahmood",
    designation: "Senior Director",
    memberType: "PERMANENT_MANDATORY",
    isHead: true,
  },
  {
    region: "SOUTH",
    name: "Murtaza Zaheer",
    designation: "Sr Manager Admin",
    memberType: "PERMANENT_MANDATORY",
  },
];
