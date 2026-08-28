import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs, TabNav } from "@/components/ui/nav";
import { Badge, EmptyState, InlineAlert, PageHeader, RefLink, StatTile, UserChip } from "@/components/ui/primitives";
import { orgTree } from "@/server/org";
import { GRADES, POC_RESPONSIBILITIES, pocLabel, type OrgNode, type ScmFunction } from "@/lib/org";
import { tableLink } from "@/lib/links";

export const metadata = { title: "Organogram" };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const TABS: Array<{ key: string; label: string; fn?: ScmFunction }> = [
  { key: "all", label: "Whole function" },
  { key: "procurement", label: "Procurement", fn: "PROCUREMENT" },
  { key: "logistics", label: "Logistics & stores", fn: "LOGISTICS" },
];

/**
 * The supply chain organogram, and who it makes responsible for what.
 *
 * The two slides this is loaded from — procurement and logistics — share their
 * top three positions, so they are one organisation with two branches rather
 * than two charts that happen to name the same director. Approval escalation and
 * the department points of contact both read from this, which is why it is worth
 * being able to see it.
 */
export default async function OrganogramPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { authorized } = await pageContext(P.USER_MANAGE, P.MASTER_VIEW);
  if (!authorized) {
    return <AccessDenied title="Organogram" message="You do not have permission to view the organisation structure." />;
  }

  const sp = await searchParams;
  const tab = typeof sp.tab === "string" ? sp.tab : "all";
  const active = TABS.find((t) => t.key === tab) ?? TABS[0];

  const [tree, placed, unplaced, pocs] = await Promise.all([
    orgTree(active.fn),
    prisma.user.count({ where: { grade: { not: null }, active: true } }),
    prisma.user.count({ where: { grade: null, active: true } }),
    prisma.departmentPoc.findMany({
      where: { active: true },
      include: {
        user: { select: { id: true, name: true, title: true, active: true } },
        department: { select: { id: true, name: true, entity: { select: { code: true } } } },
      },
      orderBy: [{ responsibility: "asc" }, { primary: "desc" }],
    }),
  ]);

  const livePocs = pocs.filter((p) => p.user.active);
  const byResponsibility = new Map<string, typeof livePocs>();
  for (const p of livePocs) {
    const list = byResponsibility.get(p.responsibility) ?? [];
    list.push(p);
    byResponsibility.set(p.responsibility, list);
  }
  const uncovered = POC_RESPONSIBILITIES.filter((r) => !byResponsibility.has(r.code));

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Administration", href: "/admin" }, { label: "Organogram" }]} />

      <PageHeader
        eyebrow="Administration"
        title="Supply chain organogram"
        subtitle="Who sits where, who they report to, and which of them a requester should be speaking to. Approval escalation reads the same structure."
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="People placed"
          value={placed}
          hint={`Across ${GRADES.length} grades`}
          tone="accent"
          href="/admin/organogram"
        />
        <StatTile
          label="Not on the organogram"
          value={unplaced}
          hint="Active accounts with no grade"
          tone={unplaced ? "warning" : "success"}
          href={tableLink("/admin/users", { status: "Active" })}
        />
        <StatTile label="Points of contact" value={livePocs.length} hint="Live appointments" href="#pocs" />
        <StatTile
          label="Responsibilities uncovered"
          value={uncovered.length}
          hint={uncovered.length ? uncovered.map((u) => u.label).join(", ") : "Every responsibility is named"}
          tone={uncovered.length ? "warning" : "success"}
          href="#pocs"
        />
      </div>

      <TabNav baseHref="/admin/organogram" tabs={TABS.map((t) => ({ key: t.key, label: t.label }))} active={active.key} />

      {tree.length === 0 ? (
        <EmptyState
          title="Nobody is placed on the organogram"
          description="Run the organogram loader to import the procurement and logistics charts, or set a grade on a user from the directory."
          action={
            <Link href="/admin/users" className="btn btn-secondary btn-sm">
              Open the directory
            </Link>
          }
        />
      ) : (
        <div className="card card-pad space-y-1">
          {tree.map((node) => (
            <OrgBranch key={node.grade.code} node={node} depth={0} />
          ))}
        </div>
      )}

      <section id="pocs" className="scroll-mt-20 space-y-3">
        <h2 className="text-sm leading-6 font-medium">Points of contact</h2>
        <InlineAlert tone="info">
          A requester who does not know who to chase is a requisition that sits. These are the names a document is
          routed to, per department and per responsibility — a category buyer for MEP is not the person to ask about a
          store receipt.
        </InlineAlert>

        {livePocs.length === 0 ? (
          <EmptyState compact title="No points of contact appointed" />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[...byResponsibility.entries()].map(([code, list]) => (
              <div key={code} className="card card-pad">
                <h3 className="label mb-2 border-b border-separator pb-1.5">{pocLabel(code)}</h3>
                <ul className="row-list">
                  {[...new Map(list.map((p) => [p.user.id, p])).values()].map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2 py-1.5">
                      <UserChip name={p.user.name} sub={p.user.title} />
                      <span className="flex shrink-0 items-center gap-1.5">
                        {p.primary && <Badge tone="success">Primary</Badge>}
                        <span className="text-2xs text-[var(--c-text-tertiary)]">
                          {list.filter((x) => x.user.id === p.user.id).length} dept
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * One rung and everything under it.
 *
 * Indentation carries the reporting line, which is what the slide used a box and
 * a connector for. A grade nobody holds still shows: an empty rung is a gap in
 * the chain, and hiding it would hide the gap.
 */
function OrgBranch({ node, depth }: { node: OrgNode; depth: number }) {
  return (
    <div>
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 py-1.5 pl-3"
        style={{
          marginLeft: `${Math.min(depth, 6) * 1.25}rem`,
          borderColor: depth === 0 ? "var(--c-accent)" : "var(--c-separator)",
        }}
      >
        <span className="text-[0.8125rem] leading-5 font-500">{node.grade.title}</span>
        <Badge tone="neutral">{node.grade.fn === "SHARED" ? "Both functions" : node.grade.fn === "PROCUREMENT" ? "Procurement" : "Logistics"}</Badge>
        {node.people.length === 0 ? (
          <Badge tone="warning">Nobody at this grade</Badge>
        ) : (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {node.people.map((p) => (
              <RefLink key={p.id} href={`/admin/users?q=${encodeURIComponent(p.name)}`}>
                {p.name}
              </RefLink>
            ))}
          </span>
        )}
      </div>
      {node.children.map((child) => (
        <OrgBranch key={child.grade.code} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}
