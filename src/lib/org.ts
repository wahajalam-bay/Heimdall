/**
 * The supply chain organisation, as it is actually structured.
 *
 * Approval routing until now knew only about roles: a rule could say "a senior
 * manager approves this" but not *which* senior manager, and nothing recorded
 * that an assistant manager reports to a manager who reports to an assistant
 * director. That is the difference between a chain that can escalate and a queue
 * that stalls with nobody named.
 *
 * The two organograms — procurement and logistics — share their top three
 * positions, so this is one ladder with two branches below the assistant
 * director. The grades are the rungs; a person's grade is what decides who is
 * above them.
 */

/** The functions the ladder branches into below the shared leadership. */
export const SCM_FUNCTIONS = ["SHARED", "PROCUREMENT", "LOGISTICS"] as const;
export type ScmFunction = (typeof SCM_FUNCTIONS)[number];

export type Grade = {
  code: string;
  title: string;
  /**
   * Seniority. Higher approves lower; the escalation path is simply the next
   * grade up within the same branch, then up the shared leadership.
   */
  rank: number;
  fn: ScmFunction;
  /** The grade this one reports into. Null only at the top. */
  reportsTo: string | null;
};

/**
 * Every rung on both organograms.
 *
 * Ranks are spaced by ten so a grade can be inserted between two others without
 * renumbering the ladder — which would otherwise silently re-point every
 * approval rule that named a rank.
 */
export const GRADES: Grade[] = [
  // Shared leadership: positions 1–3 on both organograms.
  { code: "SR_DIRECTOR_SCM", title: "Sr. Director Procurement & SCM", rank: 100, fn: "SHARED", reportsTo: null },
  { code: "DIRECTOR_SCM", title: "Director Procurement & SCM", rank: 90, fn: "SHARED", reportsTo: "SR_DIRECTOR_SCM" },
  {
    code: "ASST_DIRECTOR_SCM",
    title: "Assistant Director Procurement & SCM",
    rank: 80,
    fn: "SHARED",
    reportsTo: "DIRECTOR_SCM",
  },

  // Procurement branch.
  {
    code: "SR_MANAGER_PROC",
    title: "Sr. Manager Procurement & SCM",
    rank: 70,
    fn: "PROCUREMENT",
    reportsTo: "ASST_DIRECTOR_SCM",
  },
  {
    code: "MANAGER_PROC",
    title: "Manager Procurement & SCM",
    rank: 60,
    fn: "PROCUREMENT",
    reportsTo: "SR_MANAGER_PROC",
  },
  {
    code: "AM_PROC",
    title: "Assistant Manager Procurement & SCM",
    rank: 50,
    fn: "PROCUREMENT",
    reportsTo: "MANAGER_PROC",
  },
  { code: "CATEGORY_BUYER", title: "Category Buyer", rank: 40, fn: "PROCUREMENT", reportsTo: "AM_PROC" },
  { code: "SCM_COORDINATOR", title: "Supply Chain Coordinator", rank: 30, fn: "PROCUREMENT", reportsTo: "AM_PROC" },

  // Logistics and stores branch.
  {
    code: "SR_MANAGER_LOG",
    title: "Sr. Manager Logistics & Stores",
    rank: 70,
    fn: "LOGISTICS",
    reportsTo: "ASST_DIRECTOR_SCM",
  },
  {
    code: "MANAGER_LOG",
    title: "Manager Logistics & Stores",
    rank: 60,
    fn: "LOGISTICS",
    reportsTo: "SR_MANAGER_LOG",
  },
  { code: "TEAM_LEAD_LOG", title: "Team Lead Logistics", rank: 55, fn: "LOGISTICS", reportsTo: "MANAGER_LOG" },
  { code: "ASSOCIATE_STORES", title: "Associate Stores", rank: 45, fn: "LOGISTICS", reportsTo: "TEAM_LEAD_LOG" },
  { code: "STORE_INCHARGE", title: "Store Incharge", rank: 35, fn: "LOGISTICS", reportsTo: "ASSOCIATE_STORES" },
];

const BY_CODE = new Map(GRADES.map((g) => [g.code, g]));

export function grade(code: string | null | undefined): Grade | null {
  return code ? (BY_CODE.get(code) ?? null) : null;
}

export function gradeTitle(code: string | null | undefined): string {
  return grade(code)?.title ?? "—";
}

/**
 * The chain of grades above this one, nearest first.
 *
 * Used to escalate: when the named approver at a grade is unavailable, the next
 * person up this list is the one with the standing to decide instead.
 */
export function gradesAbove(code: string | null | undefined): Grade[] {
  const chain: Grade[] = [];
  let g = grade(code);
  const seen = new Set<string>();
  while (g?.reportsTo && !seen.has(g.reportsTo)) {
    seen.add(g.reportsTo);
    const up = grade(g.reportsTo);
    if (!up) break;
    chain.push(up);
    g = up;
  }
  return chain;
}

/** True when `approver` sits at or above `subject` on the same branch. */
export function outranks(approverGrade: string | null | undefined, subjectGrade: string | null | undefined): boolean {
  const a = grade(approverGrade);
  const s = grade(subjectGrade);
  if (!a || !s) return false;
  if (a.rank > s.rank) return a.fn === "SHARED" || a.fn === s.fn;
  return false;
}

/**
 * The organogram as a tree, for display.
 *
 * `people` are grouped under the grade they hold, and grades under the grade
 * they report to, so the shape on screen is the shape on the slide.
 */
export type OrgNode = {
  grade: Grade;
  people: Array<{ id: string; name: string; email: string; title: string | null; active: boolean }>;
  children: OrgNode[];
};

export function buildOrgTree(
  people: Array<{ id: string; name: string; email: string; title: string | null; active: boolean; grade: string | null }>,
  fn?: ScmFunction,
): OrgNode[] {
  const relevant = fn ? GRADES.filter((g) => g.fn === "SHARED" || g.fn === fn) : GRADES;
  const nodes = new Map<string, OrgNode>();
  for (const g of relevant) {
    nodes.set(g.code, { grade: g, people: [], children: [] });
  }
  for (const p of people) {
    const node = p.grade ? nodes.get(p.grade) : null;
    if (node) node.people.push(p);
  }
  for (const node of nodes.values()) {
    node.people.sort((a, b) => a.name.localeCompare(b.name));
  }
  const roots: OrgNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.grade.reportsTo ? nodes.get(node.grade.reportsTo) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortChildren = (n: OrgNode) => {
    n.children.sort((a, b) => b.grade.rank - a.grade.rank || a.grade.title.localeCompare(b.grade.title));
    n.children.forEach(sortChildren);
  };
  roots.forEach(sortChildren);
  return roots.sort((a, b) => b.grade.rank - a.grade.rank);
}

/**
 * What a point of contact is responsible for.
 *
 * The organogram names a category buyer for MEP and another for civil and grey,
 * so the responsibility is part of the appointment rather than a property of the
 * person: one buyer can be the contact for a category and not for the store.
 */
export const POC_RESPONSIBILITIES = [
  { code: "GENERAL", label: "General" },
  { code: "REQUISITION", label: "Requisitions" },
  { code: "SOURCING", label: "Sourcing and RFQ" },
  { code: "CATEGORY_MEP", label: "Category — MEP" },
  { code: "CATEGORY_CIVIL", label: "Category — civil and grey" },
  { code: "STORES", label: "Stores and receiving" },
  { code: "LOGISTICS", label: "Logistics" },
  { code: "FINANCE", label: "Finance handoff" },
] as const;

export type PocResponsibility = (typeof POC_RESPONSIBILITIES)[number]["code"];

export function pocLabel(code: string): string {
  return POC_RESPONSIBILITIES.find((r) => r.code === code)?.label ?? code;
}
