import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { Badge, InlineAlert, Mono, PageHeader, StatTile } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/DataTable";
import { fmtDate, money } from "@/lib/format";
import { RNC_CASE_STATE_LABELS, type RncCaseState } from "@/server/rnc";

export const metadata = { title: "Rental committee" };
export const dynamic = "force-dynamic";

/**
 * The Rental & Negotiation Committee.
 *
 * Two columns carry the weight. **Quorum** is the one RN-004 makes a rule the
 * system counts rather than assumes. **Decision trail** is RN-010: an approved
 * case is not finished until the decision email exists, copying the CEO's
 * office, because that email is what Finance pays against — so an approval with
 * no trail is money that cannot move, and the list says so rather than showing
 * it as done.
 */
export default async function RncPage() {
  const { ctx, authorized } = await pageContext(P.RNC_VIEW);
  if (!authorized) return <AccessDenied title="Rental committee" />;

  const canRaise = userHasPermission(ctx.user, P.RNC_CASE_RAISE, P.RNC_MANAGE);
  const entityIds = visibleEntityIds(ctx.user);

  const cases = await prisma.rncCase.findMany({
    where: entityIds ? { entityId: { in: entityIds } } : {},
    orderBy: [{ createdAt: "desc" }],
    include: {
      entity: { select: { code: true } },
      quotes: { where: { isSelected: true }, take: 1 },
      buildOut: { select: { id: true, number: true } },
      _count: { select: { quotes: true, votes: true } },
    },
  });

  const withCommittee = cases.filter((c) => c.status === "PENDING_RNC");
  const deferred = cases.filter((c) => c.status === "DEFERRED");
  const awaitingTrail = cases.filter((c) => c.status === "APPROVED" && !c.decisionEmailRef);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Rental committee" }]} />

      <PageHeader
        eyebrow="RNC"
        title="Rental & Negotiation Committee"
        subtitle="Landlord selection on a comparative, a quorum the system counts, and a decision email copying the CEO's office that Finance pays against."
        actions={
          <>
            <Link className="btn btn-secondary btn-sm" href="/rnc/roster">
              Roster
            </Link>
            {canRaise && (
              <Link className="btn btn-primary btn-sm" href="/rnc/new">
                Raise a case
              </Link>
            )}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="Cases" value={cases.length} />
        <StatTile label="With the committee" value={withCommittee.length} tone={withCommittee.length ? "warning" : undefined} />
        <StatTile
          label="Deferred"
          value={deferred.length}
          hint={deferred.length ? "Short of quorum last time" : "None"}
          tone={deferred.length ? "warning" : undefined}
        />
        <StatTile
          label="Approved, no trail"
          value={awaitingTrail.length}
          hint={awaitingTrail.length ? "Finance cannot pay yet" : "All trails recorded"}
          tone={awaitingTrail.length ? "danger" : undefined}
        />
      </div>

      {awaitingTrail.length > 0 && (
        <InlineAlert tone="danger">
          {awaitingTrail.length} approved case{awaitingTrail.length === 1 ? " has" : "s have"} no decision email
          recorded: {awaitingTrail.map((c) => c.number).join(", ")}. RN-010 makes that email — to members, copying the
          CEO&rsquo;s office, with the documentation trail — the thing Finance initiates payment against. Until it
          exists the approval cannot be acted on.
        </InlineAlert>
      )}

      <DataTable
        id="rnc-cases"
        columns={[
          { key: "number", header: "Number", sortable: true, width: "9rem" },
          { key: "title", header: "Case", sortable: true, minWidth: "16rem" },
          { key: "region", header: "Region", filterable: true, sortable: true, width: "8rem" },
          { key: "status", header: "Status", filterable: true, sortable: true, width: "11rem" },
          { key: "quotes", header: "Quotes", align: "right", width: "6rem" },
          { key: "landlord", header: "Selected landlord", minWidth: "12rem" },
          { key: "rent", header: "Monthly rent", align: "right", sortable: true, width: "10rem" },
          { key: "trail", header: "Decision trail", width: "12rem" },
        ]}
        rows={cases.map((c) => {
          const selected = c.quotes[0] ?? null;
          return {
            id: c.id,
            href: `/rnc/${c.id}`,
            search: `${c.number} ${c.title} ${selected?.landlordName ?? ""}`,
            flag: c.status === "APPROVED" && !c.decisionEmailRef ? ("danger" as const) : null,
            cells: {
              number: <Mono className="text-xs">{c.number}</Mono>,
              title: (
                <>
                  {c.title}
                  <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                    {c.entity.code}
                    {c.buildOut ? ` · build-out ${c.buildOut.number}` : ""}
                  </span>
                </>
              ),
              region: c.region.charAt(0) + c.region.slice(1).toLowerCase(),
              status: (
                <Badge
                  tone={
                    c.status === "APPROVED" || c.status === "AGREEMENT_SIGNED"
                      ? "success"
                      : c.status === "REJECTED"
                        ? "danger"
                        : c.status === "DEFERRED"
                          ? "warning"
                          : c.status === "PENDING_RNC"
                            ? "progress"
                            : "neutral"
                  }
                >
                  {RNC_CASE_STATE_LABELS[c.status as RncCaseState] ?? c.status}
                </Badge>
              ),
              quotes: c._count.quotes,
              landlord: selected?.landlordName ?? <span className="text-[var(--c-text-tertiary)]">—</span>,
              rent: selected ? money(selected.monthlyRent) : "—",
              trail:
                c.status !== "APPROVED" ? (
                  "—"
                ) : c.decisionEmailRef ? (
                  <span className="text-2xs">
                    {c.decisionEmailRef}
                    <span className="mt-0.5 block text-[var(--c-text-tertiary)]">
                      {c.decisionEmailSentAt ? fmtDate(c.decisionEmailSentAt) : ""}
                      {c.ceoOfficeCopied ? " · CEO copied" : ""}
                    </span>
                  </span>
                ) : (
                  <Badge tone="danger">not recorded</Badge>
                ),
            },
            values: {
              number: c.number,
              title: c.title,
              region: c.region,
              status: RNC_CASE_STATE_LABELS[c.status as RncCaseState] ?? c.status,
              rent: selected?.monthlyRent ?? 0,
            },
          };
        })}
        emptyState="No rental committee cases yet."
      />
    </div>
  );
}
