import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { Badge, InlineAlert, PageHeader, SectionCard, StatTile } from "@/components/ui/primitives";

export const metadata = { title: "Cross Functional Team" };
export const dynamic = "force-dynamic";

/**
 * The Cross Functional Team roster — `image21.PNG`.
 *
 * Every seat on this list is copied onto each committee meeting as an attendance
 * row, so an absence is a recorded fact rather than a blank. The two things the
 * page is built to show are the ones that break a meeting: a seat with no proxy,
 * and a seat held by somebody the system cannot notify.
 */
export default async function CfcRosterPage() {
  const { ctx, authorized } = await pageContext(P.BUILD_OUT_VIEW);
  if (!authorized) return <AccessDenied title="Cross Functional Team" />;

  const entityIds = visibleEntityIds(ctx.user);
  const seats = await prisma.cfcMember.findMany({
    where: { ...(entityIds ? { entityId: { in: entityIds } } : {}), active: true },
    orderBy: [{ entityId: "asc" }, { sequence: "asc" }],
    include: {
      entity: { select: { code: true, name: true } },
      member: { select: { name: true, title: true, active: true } },
      proxy: { select: { name: true, title: true, active: true } },
    },
  });

  const noProxy = seats.filter((s) => !s.proxyName);
  const unlinked = seats.filter((s) => !s.memberId);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Build-outs", href: "/build-outs" }, { label: "CFC roster" }]} />

      <PageHeader
        eyebrow="Build-outs"
        title="Cross Functional Team"
        subtitle="The committee that is called at the start of a build-out and meets every Friday until it closes. The roster names a member and a proxy for each seat — the proxy is what lets a meeting go ahead when somebody cannot attend."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Seats" value={seats.length} />
        <StatTile
          label="No proxy named"
          value={noProxy.length}
          hint={noProxy.length ? "A seat with nobody to stand in" : "Every seat covered"}
          tone={noProxy.length ? "warning" : undefined}
        />
        <StatTile
          label="Not linked to an account"
          value={unlinked.length}
          hint={unlinked.length ? "Cannot be notified by the system" : "All linked"}
          tone={unlinked.length ? "warning" : undefined}
        />
      </div>

      {noProxy.length > 0 && (
        <InlineAlert tone="warning">
          {noProxy.length} seat{noProxy.length === 1 ? "" : "s"} the document names no proxy for:{" "}
          {noProxy.map((s) => s.seat).join(", ")}. Carried as empty rather than filled in — if that member cannot
          attend, the seat is simply absent, and the roster should say so rather than imply cover that does not exist.
        </InlineAlert>
      )}

      {unlinked.length > 0 && (
        <InlineAlert tone="info">
          {unlinked.length} seat{unlinked.length === 1 ? " is" : "s are"} held by name only, with no matching account:{" "}
          {unlinked.map((s) => s.memberName).filter(Boolean).join(", ")}. They appear on the roster and on every
          attendance sheet, and the system cannot notify them. Linking an account fixes that.
        </InlineAlert>
      )}

      <SectionCard
        title="The roster"
        description="image21.PNG, as the document lists it."
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ minWidth: "10rem" }}>Seat</th>
                <th style={{ minWidth: "13rem" }}>Member</th>
                <th style={{ minWidth: "13rem" }}>Proxy</th>
                <th style={{ width: "7rem" }}>Company</th>
              </tr>
            </thead>
            <tbody>
              {seats.map((s) => (
                <tr key={s.id}>
                  <td className="text-xs font-500">{s.seat}</td>
                  <td className="text-xs">
                    {s.member?.name ?? s.memberName ?? "—"}
                    <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                      {s.member ? (s.member.title ?? "linked account") : "by name only"}
                    </span>
                  </td>
                  <td className="text-xs">
                    {s.proxyName ? (
                      <>
                        {s.proxy?.name ?? s.proxyName}
                        <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                          {s.proxy ? (s.proxy.title ?? "linked account") : "by name only"}
                        </span>
                      </>
                    ) : (
                      <Badge tone="warning">none named</Badge>
                    )}
                  </td>
                  <td className="text-2xs">{s.entity.code}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
