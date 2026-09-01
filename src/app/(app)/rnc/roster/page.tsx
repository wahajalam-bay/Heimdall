import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { Badge, InlineAlert, PageHeader, SectionCard } from "@/components/ui/primitives";
import {
  CENTRAL_QUORUM,
  RNC_MEMBER_TYPE_LABELS,
  type RncMemberType,
} from "@/server/rnc";

export const metadata = { title: "RNC roster" };
export const dynamic = "force-dynamic";

/**
 * The Rental & Negotiation Committee's composition — `image22.PNG`.
 *
 * The page exists mainly to make the quorum arithmetic legible, because the
 * document's own is not. RN-004 asks for three permanent members "in addition to
 * the Head of the Committee". Central can field that. North and South are listed
 * with three members in total — including a Country Head shared between them —
 * so three *besides* the head is impossible there as written.
 *
 * Rather than quietly pick a smaller number, the rule caps the requirement at
 * the region's own voting headcount and every decision records what was actually
 * required of it. This page shows the shortfall so the question can be settled
 * by somebody who knows the intent.
 */
export default async function RncRosterPage() {
  const { ctx, authorized } = await pageContext(P.RNC_VIEW);
  if (!authorized) return <AccessDenied title="RNC roster" />;

  const entityIds = visibleEntityIds(ctx.user);
  const members = await prisma.rncMember.findMany({
    where: { ...(entityIds ? { entityId: { in: entityIds } } : {}), active: true },
    orderBy: [{ region: "asc" }, { sequence: "asc" }],
    include: {
      entity: { select: { code: true } },
      user: { select: { name: true, title: true } },
    },
  });

  const regions = ["CENTRAL", "NORTH", "SOUTH"].map((region) => {
    const rows = members.filter((m) => m.region === region);
    const voting = rows.filter((m) => m.memberType !== "OBSERVER");
    const head = rows.find((m) => m.isHead) ?? null;
    const votingBesideHead = voting.filter((m) => !m.isHead).length;
    const required = region === "CENTRAL" ? CENTRAL_QUORUM : Math.min(CENTRAL_QUORUM, votingBesideHead);
    return { region, rows, voting, head, votingBesideHead, required, short: votingBesideHead < CENTRAL_QUORUM };
  });

  const shortRegions = regions.filter((r) => r.rows.length > 0 && r.short);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Rental committee", href: "/rnc" }, { label: "Roster" }]} />

      <PageHeader
        eyebrow="RNC"
        title="Committee composition"
        subtitle="Three member types, and the difference matters: a permanent-mandatory member must be present or proxied, a permanent member counts toward quorum, and an observer attends without voting or counting."
      />

      {shortRegions.length > 0 && (
        <InlineAlert tone="warning">
          {shortRegions.map((r) => r.region.charAt(0) + r.region.slice(1).toLowerCase()).join(" and ")}{" "}
          {shortRegions.length === 1 ? "has" : "have"} fewer than {CENTRAL_QUORUM} voting members besides the Head of
          the Committee, so RN-004&rsquo;s figure cannot be met there as the document is worded. The requirement is
          capped at the region&rsquo;s own voting headcount and each decision records what was required of it — but
          the intended quorum for these regions is a question for whoever wrote the composition.
        </InlineAlert>
      )}

      {regions
        .filter((r) => r.rows.length > 0)
        .map((r) => (
          <SectionCard
            key={r.region}
            title={r.region.charAt(0) + r.region.slice(1).toLowerCase()}
            description={
              `${r.rows.length} seat(s) · ${r.voting.length} voting · ${r.votingBesideHead} voting beside the head · ` +
              `quorum requires ${r.required}` +
              (r.head ? ` plus ${r.head.memberName}` : " — but no head is named, so RN-004 cannot be satisfied")
            }
            bodyClassName="px-0 py-0"
          >
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ minWidth: "13rem" }}>Member</th>
                    <th style={{ minWidth: "12rem" }}>Designation</th>
                    <th style={{ minWidth: "13rem" }}>Type</th>
                    <th style={{ width: "8rem" }}>Counts?</th>
                  </tr>
                </thead>
                <tbody>
                  {r.rows.map((m) => (
                    <tr key={m.id}>
                      <td className="text-xs">
                        {m.memberName}
                        {m.isHead && <Badge tone="accent" className="ml-2">Head</Badge>}
                        <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                          {m.user ? "linked account" : "by name only"}
                        </span>
                      </td>
                      <td className="text-2xs">{m.designation ?? "—"}</td>
                      <td className="text-2xs">
                        {RNC_MEMBER_TYPE_LABELS[m.memberType as RncMemberType] ?? m.memberType}
                      </td>
                      <td className="text-2xs">
                        {m.memberType === "OBSERVER" ? (
                          <span className="text-[var(--c-text-tertiary)]">no</span>
                        ) : m.isHead ? (
                          <span>separately</span>
                        ) : (
                          <span className="text-[var(--c-success)]">yes</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        ))}

      <p className="text-2xs leading-4 text-[var(--c-text-tertiary)]">
        The head is counted separately from the three, because RN-004 asks for three permanent members{" "}
        <span className="italic">in addition to</span> the Head of the Committee — counting the head among them would
        let a committee of three sit as though it were four.
      </p>
    </div>
  );
}
