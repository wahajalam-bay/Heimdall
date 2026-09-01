import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { Badge, InlineAlert, PageHeader, SectionCard, StatTile } from "@/components/ui/primitives";
import { CONFIG_KEYS, getConfigBool } from "@/lib/config";
import {
  CPC_MEMBER_TYPE_LABELS,
  CPC_PERMANENT_QUORUM,
  type CpcMemberType,
} from "@/server/cpc-quorum";

export const metadata = { title: "CPC composition" };
export const dynamic = "force-dynamic";

/**
 * The standing CPC composition — CP-003.
 *
 * The page exists to answer one question before a case needs it: can this
 * committee actually reach quorum? CP-006 wants three voting members present
 * besides the requisitioner's department head, and a roster with two filled
 * seats cannot deliver that however many meetings are called.
 */
export default async function CpcRosterPage() {
  const { ctx, authorized } = await pageContext(P.CPC_VIEW);
  if (!authorized) return <AccessDenied title="CPC composition" />;

  const entityIds = visibleEntityIds(ctx.user);
  const [seats, enforcing] = await Promise.all([
    prisma.cpcRosterMember.findMany({
      where: { ...(entityIds ? { entityId: { in: entityIds } } : {}), active: true },
      orderBy: [{ entityId: "asc" }, { sequence: "asc" }],
      include: {
        entity: { select: { code: true, name: true } },
        user: { select: { name: true, title: true, active: true } },
      },
    }),
    getConfigBool(CONFIG_KEYS.ENFORCE_CPC_QUORUM, ctx.entityId ?? null),
  ]);

  const voting = seats.filter((s) => s.memberType !== "OBSERVER");
  const observers = seats.filter((s) => s.memberType === "OBSERVER");
  const vacant = seats.filter((s) => !s.userId);
  const votingFilled = voting.filter((s) => s.userId).length;
  // The head of the requisitioning department is required in addition to the
  // three, and is usually not a roster seat — so the roster needs three filled
  // voting seats of its own to be able to field a quorum.
  const canReachQuorum = votingFilled >= CPC_PERMANENT_QUORUM;

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "CPC", href: "/cpc" }, { label: "Composition" }]} />

      <PageHeader
        eyebrow="CPC"
        title="Committee composition"
        subtitle="Nine seats with designations and types. The type is what the quorum arithmetic turns on: an observer attends and neither votes nor counts."
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="Seats" value={seats.length} hint="CP-003 asks for nine" />
        <StatTile label="Voting" value={voting.length} hint={`${observers.length} observer`} />
        <StatTile
          label="Filled"
          value={`${seats.length - vacant.length}/${seats.length}`}
          hint={vacant.length ? `${vacant.length} vacant` : "All seats held"}
          tone={vacant.length ? "warning" : "success"}
        />
        <StatTile
          label="Can reach quorum"
          value={canReachQuorum ? "Yes" : "No"}
          hint={`${votingFilled} voting seat(s) filled, ${CPC_PERMANENT_QUORUM} needed`}
          tone={canReachQuorum ? "success" : "danger"}
        />
      </div>

      {!canReachQuorum && (
        <InlineAlert tone="danger">
          Only {votingFilled} voting seat{votingFilled === 1 ? " is" : "s are"} filled. CP-006 needs{" "}
          {CPC_PERMANENT_QUORUM} permanent members present <span className="italic">in addition to</span> the head of
          the requisitioning department, so this committee cannot be quorate however many meetings are called. Fill the
          vacant seats before turning on the quorum gate.
        </InlineAlert>
      )}

      <InlineAlert tone={enforcing ? "success" : "info"}>
        {enforcing ? (
          <>
            The quorum gate is <span className="font-600">on</span>: a non-quorate committee may only defer a case,
            which is CP-006&rsquo;s own remedy.
          </>
        ) : (
          <>
            The quorum gate is <span className="font-600">off</span>. The quorum is counted and shown on every case,
            and a decision taken without it is still allowed — turn on{" "}
            <span className="mono text-2xs">policy.enforce_cpc_quorum</span> once the seats are filled and cases in
            flight have attendance recorded.
          </>
        )}
      </InlineAlert>

      <SectionCard
        title="The nine seats"
        description="CP-003 names the count and the types, not the people. A vacant seat is shown vacant — a quorum counted against invented members would report itself satisfied."
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ minWidth: "16rem" }}>Designation</th>
                <th style={{ minWidth: "13rem" }}>Held by</th>
                <th style={{ minWidth: "13rem" }}>Type</th>
                <th style={{ width: "8rem" }}>Counts?</th>
                <th style={{ width: "7rem" }}>Company</th>
              </tr>
            </thead>
            <tbody>
              {seats.map((s) => (
                <tr key={s.id}>
                  <td className="text-xs">
                    {s.designation ?? s.memberName}
                    {s.isChair && <Badge tone="accent" className="ml-2">Chair</Badge>}
                  </td>
                  <td className="text-xs">
                    {s.user ? (
                      <>
                        {s.user.name}
                        <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                          {s.user.title ?? ""}
                        </span>
                      </>
                    ) : (
                      <Badge tone="warning">vacant</Badge>
                    )}
                  </td>
                  <td className="text-2xs">
                    {CPC_MEMBER_TYPE_LABELS[s.memberType as CpcMemberType] ?? s.memberType}
                  </td>
                  <td className="text-2xs">
                    {s.memberType === "OBSERVER" ? (
                      <span className="text-[var(--c-text-tertiary)]">no — CP-007</span>
                    ) : (
                      <span className="text-[var(--c-success)]">yes</span>
                    )}
                  </td>
                  <td className="text-2xs">{s.entity.code}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <p className="text-2xs leading-4 text-[var(--c-text-tertiary)]">
        The requisitioning department&rsquo;s head is counted separately from the three, because CP-006 requires them{" "}
        <span className="italic">in addition to</span> the permanent members — counting them among the three would let
        a committee of three sit as though it were four.
      </p>
    </div>
  );
}
