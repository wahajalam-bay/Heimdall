import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";
import { documentTimeline } from "@/server/timeline";
import { vendorHistory } from "@/server/vendors";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  BlockedNotice,
  DefList,
  InlineAlert,
  MetaItem,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
  UserChip,
} from "@/components/ui/primitives";
import { Timeline } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { humanize } from "@/lib/domain";
import { fmtDate, fmtDateTime, money, percent, qty, round2 } from "@/lib/format";
import { CastVoteForm, CeoDecisionForm, ResolveCaseForm } from "../../CpcForms";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await prisma.cpcCase.findUnique({ where: { id }, select: { number: true } });
  return { title: c ? `${c.number} — CPC case` : "CPC case" };
}

export default async function CpcCaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.CPC_VIEW);
  if (!authorized) return <AccessDenied title="CPC case" />;

  const kase = await prisma.cpcCase.findUnique({
    where: { id },
    include: {
      pr: {
        select: {
          id: true,
          number: true,
          title: true,
          justification: true,
          procurementType: true,
          priority: true,
          estimatedValue: true,
          entityId: true,
          entity: { select: { code: true, name: true } },
          department: { select: { name: true } },
          project: { select: { id: true, code: true, name: true } },
          requester: { select: { name: true, title: true } },
          items: { select: { id: true, description: true, quantity: true, unit: true, specification: true } },
        },
      },
      meeting: { select: { id: true, number: true, title: true, scheduledAt: true, status: true, location: true } },
      members: { include: { user: { select: { id: true, name: true, title: true } } }, orderBy: { roleLabel: "asc" } },
      decisions: { include: { member: { select: { id: true, name: true, title: true } } }, orderBy: { decidedAt: "asc" } },
      comparative: {
        include: {
          lines: {
            orderBy: { netTotal: "asc" },
            include: {
              vendor: { select: { id: true, name: true, status: true, performanceScore: true, onTimePercent: true } },
              quote: {
                select: {
                  number: true,
                  negotiations: {
                    orderBy: { round: "asc" },
                    include: { negotiatedBy: { select: { name: true } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!kase) notFound();

  const selected = kase.comparative?.lines.find((l) => l.isSelected);
  const lowest = kase.comparative?.lines.find((l) => l.isLowest);

  const [events, threshold, history] = await Promise.all([
    documentTimeline("CpcCase", kase.id),
    getConfigNumber(CONFIG_KEYS.CPC_THRESHOLD, kase.pr.entityId),
    selected ? vendorHistory(selected.vendorId) : Promise.resolve(null),
  ]);

  // Negotiation rounds hang off each quote, so flatten them across the comparative.
  const negotiations = (kase.comparative?.lines ?? []).flatMap((l) =>
    l.quote.negotiations.map((n) => ({ ...n, vendorName: l.vendor.name })),
  );

  const canDecide = userHasPermission(user, P.CPC_DECIDE);
  const canManage = userHasPermission(user, P.CPC_MANAGE);
  // PC-023's second approval. A separate permission, held by no committee role,
  // so the committee cannot approve on the CEO's behalf.
  const canDecideAsCeo = userHasPermission(user, P.CPC_CEO_APPROVE);
  const isMember = kase.members.some((m) => m.userId === user.id);
  const myVote = kase.decisions.find((d) => d.memberId === user.id);
  const required = kase.members.filter((m) => m.required);
  const votedIds = new Set(kase.decisions.map((d) => d.memberId));
  const outstanding = required.filter((m) => !votedIds.has(m.userId));
  const decided = ["APPROVED", "REJECTED", "RETURNED", "CLARIFICATION"].includes(kase.status);
  // Approved by the committee, still waiting on the Office of the CEO. Not
  // "decided" — the requisition has not moved and must not read as if it had.
  const awaitingCeo = kase.status === "PENDING_CEO";

  const notes: string[] = [];
  if (selected && lowest && selected.id !== lowest.id) {
    notes.push(
      `${selected.vendor.name} is not the lowest quote — ${lowest.vendor.name} came in at ${money(lowest.netTotal)}, a difference of ${money(round2(selected.netTotal - lowest.netTotal))}.`,
    );
  }
  if (kase.comparative?.nonLowestJustification) {
    notes.push(`Justification on record: ${kase.comparative.nonLowestJustification}`);
  }
  if (selected && selected.vendor.status !== "APPROVED") {
    notes.push(`${selected.vendor.name} is ${humanize(selected.vendor.status).toLowerCase()}, not fully approved.`);
  }
  if (kase.riskNotes) notes.push(kase.riskNotes);

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "CPC", href: "/cpc" },
          { label: "Cases", href: "/cpc/cases" },
          { label: kase.number },
        ]}
      />

      <PageHeader
        eyebrow={`${kase.pr.entity.code} · ${kase.pr.department.name}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{kase.number}</span>
            <span>{kase.title}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={kase.status} />
            </MetaItem>
            <MetaItem label="Value">{money(kase.amount)}</MetaItem>
            <MetaItem label="Threshold">{money(threshold)}</MetaItem>
            <MetaItem label="Requisition">
              <RefLink href={`/pr/${kase.pr.id}`}>{kase.pr.number}</RefLink>
            </MetaItem>
            <MetaItem label="Votes">
              {votedIds.size} of {required.length}
            </MetaItem>
            <MetaItem label="Raised">{fmtDate(kase.createdAt)}</MetaItem>
          </>
        }
        actions={
          <>
            {!decided && canDecide && (isMember || canManage) && (
              <CastVoteForm
                caseId={kase.id}
                number={kase.number}
                amount={kase.amount}
                vendorName={selected?.vendor.name ?? null}
                isChair={canManage}
                existingVote={myVote?.vote ?? null}
              />
            )}
            {awaitingCeo && canDecideAsCeo && (
              <CeoDecisionForm
                caseId={kase.id}
                number={kase.number}
                amount={money(kase.amount)}
                threshold={money(kase.ceoThresholdAtRaise ?? 0)}
              />
            )}
            {!decided && !awaitingCeo && canManage && (
              <ResolveCaseForm
                caseId={kase.id}
                number={kase.number}
                votesCast={votedIds.size}
                votesRequired={required.length}
              />
            )}
            {kase.comparative && (
              <Link href={`/comparatives/${kase.comparative.id}`} className="btn btn-secondary btn-sm">
                Comparative
              </Link>
            )}
            <Link href={`/pr/${kase.pr.id}?tab=cpc`} className="btn btn-secondary btn-sm">
              Requisition
            </Link>
          </>
        }
      />

      {awaitingCeo && (
        <InlineAlert tone="warning">
          The committee approved this case, and it is <span className="font-600">not cleared</span>. PC-023 requires the
          Office of the CEO above {money(kase.ceoThresholdAtRaise ?? 0)} and this award is {money(kase.amount)}, so the
          requisition is held and no purchase order can be raised until they decide. The threshold shown is the one that
          applied when the case was raised, not today&rsquo;s.
        </InlineAlert>
      )}
      {kase.status === "APPROVED" && (
        <InlineAlert tone="success">
          The committee approved this case{kase.decidedAt ? ` on ${fmtDateTime(kase.decidedAt)}` : ""}.
          {kase.ceoDecidedAt
            ? ` The Office of the CEO approved it on ${fmtDateTime(kase.ceoDecidedAt)} — PC-023 applies above ${money(kase.ceoThresholdAtRaise ?? 0)}.`
            : ""}{" "}
          The requisition has moved to PO preparation — a purchase order cannot be raised without this clearance.
        </InlineAlert>
      )}
      {["REJECTED", "RETURNED", "CLARIFICATION"].includes(kase.status) && (
        <BlockedNotice
          tone={kase.status === "REJECTED" ? "danger" : "warning"}
          title={`The committee ${kase.status === "REJECTED" ? "rejected" : kase.status === "RETURNED" ? "returned" : "asked for clarification on"} this case`}
          reasons={kase.decisions.filter((d) => d.comment).map((d) => `${d.member.name}: ${d.comment}`)}
        />
      )}
      {notes.length > 0 && !decided && <BlockedNotice title="Points the committee should weigh" reasons={notes} />}

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Recommended value" value={money(kase.amount)} />
        <StatTile
          label="Savings claimed"
          value={kase.savingsAmount > 0 ? money(kase.savingsAmount) : "—"}
          tone={kase.savingsAmount > 0 ? "success" : "default"}
        />
        <StatTile
          label="Quotes compared"
          value={kase.comparative?.lines.length ?? 0}
          hint={kase.comparative ? `Comparative ${kase.comparative.number}` : undefined}
        />
        <StatTile
          label="Vendor performance"
          value={
            selected?.vendor.performanceScore !== null && selected?.vendor.performanceScore !== undefined
              ? round2(selected.vendor.performanceScore)
              : "—"
          }
          hint={selected ? selected.vendor.name : undefined}
          tone={
            (selected?.vendor.performanceScore ?? 0) >= 70
              ? "success"
              : (selected?.vendor.performanceScore ?? 100) < 50
                ? "danger"
                : "default"
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <div className="space-y-4">
          {kase.comparative && (
            <SectionCard
              title="What is being recommended"
              description={`Comparative ${kase.comparative.number} · ${kase.comparative.lines.length} quotations`}
              bodyClassName="px-0 py-0"
            >
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Vendor</th>
                      <th>Standing</th>
                      <th className="text-right">Quoted</th>
                      <th className="text-right">After negotiation</th>
                      <th className="text-right">Score</th>
                      <th className="text-right">Delivery</th>
                      <th>Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kase.comparative.lines.map((l) => (
                      <tr
                        key={l.id}
                        className={l.isSelected ? "bg-[var(--c-success-soft)]/40" : undefined}
                      >
                        <td>
                          <RefLink href={`/vendors/${l.vendor.id}`}>{l.vendor.name}</RefLink>
                          {l.isSelected && <Badge tone="success">Recommended</Badge>}
                        </td>
                        <td>
                          <StatusBadge status={l.vendor.status} />
                        </td>
                        <td className="num text-xs">{money(l.total)}</td>
                        <td className="num text-xs font-500">{money(l.netTotal)}</td>
                        <td className="num text-xs">{l.scoreTotal !== null ? round2(l.scoreTotal) : "—"}</td>
                        <td className="num text-2xs">{l.deliveryDays !== null ? `${l.deliveryDays} d` : "—"}</td>
                        <td className="text-2xs">
                          <span className="flex flex-wrap gap-1">
                            {l.isLowest && <Badge tone="info">Lowest</Badge>}
                            {l.isLowestCompliant && <Badge tone="success">Lowest compliant</Badge>}
                            {l.technicalCompliance === "NON_COMPLIANT" && <Badge tone="danger">Non-compliant</Badge>}
                            {l.technicalCompliance === "PARTIAL" && <Badge tone="warning">Partially compliant</Badge>}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {kase.comparative.nonLowestJustification && (
                <div className="border-t border-separator px-4 py-3">
                  <span className="label mb-1 block">Justification for not taking the lowest quote</span>
                  <p className="text-xs leading-5 text-muted">
                    {kase.comparative.nonLowestJustification}
                  </p>
                </div>
              )}
            </SectionCard>
          )}

          <SectionCard title="Procurement's recommendation">
            <DefList
              columns={1}
              items={[
                {
                  label: "Recommendation",
                  value: kase.recommendation ? (
                    <span className="whitespace-pre-wrap">{kase.recommendation}</span>
                  ) : (
                    "Not recorded"
                  ),
                },
                {
                  label: "Risk notes",
                  value: kase.riskNotes ? <span className="whitespace-pre-wrap">{kase.riskNotes}</span> : "None raised",
                },
                {
                  label: "Requisition justification",
                  value: kase.pr.justification ? (
                    <span className="whitespace-pre-wrap">{kase.pr.justification}</span>
                  ) : (
                    "—"
                  ),
                },
              ]}
            />
          </SectionCard>

          <SectionCard title="What is being bought" bodyClassName="px-0 py-0">
            <div className="table-wrap max-h-[20rem] overflow-y-auto">
              <table className="dt">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="text-right">Quantity</th>
                    <th>Specification</th>
                  </tr>
                </thead>
                <tbody>
                  {kase.pr.items.map((i) => (
                    <tr key={i.id}>
                      <td className="text-xs">{i.description}</td>
                      <td className="num text-xs">{qty(i.quantity, i.unit)}</td>
                      <td className="max-w-[24rem] truncate text-2xs text-muted" title={i.specification ?? ""}>
                        {i.specification ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          {negotiations.length > 0 && (
            <SectionCard
              title="Negotiation record"
              description="What was asked for, what was conceded, and by whom."
              bodyClassName="px-0 py-0"
            >
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th className="text-right">Round</th>
                      <th>Vendor</th>
                      <th className="text-right">Before</th>
                      <th className="text-right">After</th>
                      <th className="text-right">Saving</th>
                      <th>Channel</th>
                      <th>Negotiated by</th>
                      <th>Outcome</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {negotiations.map((n) => (
                      <tr key={n.id}>
                        <td className="num text-xs">{n.round}</td>
                        <td className="text-xs">{n.vendorName}</td>
                        <td className="num text-xs">{money(n.originalTotal)}</td>
                        <td className="num text-xs">{money(n.finalTotal ?? n.negotiatedTotal)}</td>
                        <td className="num text-xs text-[var(--c-success)]">
                          {n.savings > 0 ? money(n.savings) : "—"}
                        </td>
                        <td className="text-2xs">{humanize(n.channel)}</td>
                        <td className="text-2xs">{n.negotiatedBy.name}</td>
                        <td className="text-2xs">{humanize(n.outcome)}</td>
                        <td className="text-xs">{fmtDate(n.negotiatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}

          {history && (
            <SectionCard
              title={`Track record — ${selected?.vendor.name}`}
              description="What this vendor has actually delivered for us before."
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <span className="label block">Orders placed</span>
                  <span className="tnum text-[1rem] font-600">{history.totals.orders}</span>
                </div>
                <div>
                  <span className="label block">Historic spend</span>
                  <span className="tnum text-[1rem] font-600">{money(history.totals.spend)}</span>
                </div>
                <div>
                  <span className="label block">On-time delivery</span>
                  <span className="tnum text-[1rem] font-600">
                    {selected?.vendor.onTimePercent !== null && selected?.vendor.onTimePercent !== undefined
                      ? percent(selected.vendor.onTimePercent, 0)
                      : "—"}
                  </span>
                </div>
                <div>
                  <span className="label block">Rejections</span>
                  <span className="tnum text-[1rem] font-600">{history.totals.rejections}</span>
                </div>
                <div>
                  <span className="label block">Invoice issues</span>
                  <span className="tnum text-[1rem] font-600">{history.totals.invoiceIssues}</span>
                </div>
                <div>
                  <span className="label block">Open issues</span>
                  <span
                    className={`tnum text-[1rem] font-600 ${history.totals.openIssues > 0 ? "text-[var(--c-danger)]" : ""}`}
                  >
                    {history.totals.openIssues}
                  </span>
                </div>
              </div>
              {history.issues.length > 0 && (
                <div className="mt-3 border-t border-separator pt-3">
                  <span className="label mb-1.5 block">Recent issues</span>
                  <ul className="space-y-1.5">
                    {history.issues.slice(0, 5).map((i) => (
                      <li key={i.id} className="flex items-center justify-between gap-3 text-2xs">
                        <span className="min-w-0 truncate">
                          <RefLink href={`/vendors/issues/${i.id}`}>{i.number}</RefLink>
                          <span className="ml-2 text-muted">{i.title}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <Badge tone={i.severity === "CRITICAL" ? "danger" : i.severity === "HIGH" ? "warning" : "neutral"}>
                            {humanize(i.severity)}
                          </Badge>
                          <StatusBadge status={i.status} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </SectionCard>
          )}
        </div>

        <div className="space-y-4">
          <SectionCard
            title="Committee"
            description="Membership is derived from the case — the requesting department, procurement, finance and the relevant functional director."
          >
            <ul className="space-y-3">
              {kase.members.map((m) => {
                const vote = kase.decisions.find((d) => d.memberId === m.userId);
                return (
                  <li key={m.id} className="border-b border-separator pb-3 last:border-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <UserChip name={m.user.name} sub={m.roleLabel} />
                      <span className="shrink-0 text-right">
                        {vote ? (
                          <Badge
                            tone={
                              vote.vote === "APPROVE"
                                ? "success"
                                : vote.vote === "REJECT"
                                  ? "danger"
                                  : vote.vote === "ABSTAIN"
                                    ? "neutral"
                                    : "warning"
                            }
                          >
                            {humanize(vote.vote)}
                          </Badge>
                        ) : (
                          <Badge tone={m.required ? "warning" : "neutral"}>
                            {m.required ? "Awaiting" : "Optional"}
                          </Badge>
                        )}
                        {vote && (
                          <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                            {fmtDateTime(vote.decidedAt)}
                          </span>
                        )}
                      </span>
                    </div>
                    {vote?.comment && (
                      <p className="mt-1.5 whitespace-pre-wrap text-2xs leading-4 text-muted">
                        {vote.comment}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
            {outstanding.length > 0 && !decided && (
              <p className="mt-3 border-t border-separator pt-2.5 text-2xs text-[var(--c-text-tertiary)]">
                Waiting on {outstanding.map((m) => m.user.name).join(", ")}.
              </p>
            )}
          </SectionCard>

          <SectionCard title="Case detail">
            <DefList
              columns={1}
              items={[
                { label: "Case number", value: <Mono>{kase.number}</Mono> },
                { label: "Requisition", value: <RefLink href={`/pr/${kase.pr.id}`}>{kase.pr.number}</RefLink> },
                { label: "Requisition title", value: kase.pr.title },
                { label: "Entity", value: kase.pr.entity.name },
                { label: "Department", value: kase.pr.department.name },
                {
                  label: "Project",
                  value: kase.pr.project ? `${kase.pr.project.code} — ${kase.pr.project.name}` : "—",
                },
                {
                  label: "Requested by",
                  value: `${kase.pr.requester.name}${kase.pr.requester.title ? ` — ${kase.pr.requester.title}` : ""}`,
                },
                { label: "Procurement type", value: humanize(kase.pr.procurementType) },
                { label: "Priority", value: humanize(kase.pr.priority) },
                { label: "Estimated value", value: money(kase.pr.estimatedValue) },
                { label: "Recommended value", value: money(kase.amount) },
                { label: "CPC threshold for this entity", value: money(threshold) },
                { label: "Raised at", value: fmtDateTime(kase.createdAt) },
                { label: "Decided at", value: kase.decidedAt ? fmtDateTime(kase.decidedAt) : "Not decided" },
              ]}
            />
          </SectionCard>

          {kase.meeting && (
            <SectionCard title="Tabled at">
              <DefList
                columns={1}
                items={[
                  { label: "Meeting", value: <RefLink href={`/cpc/meetings/${kase.meeting.id}`}>{kase.meeting.number}</RefLink> },
                  { label: "Title", value: kase.meeting.title },
                  { label: "Scheduled", value: fmtDateTime(kase.meeting.scheduledAt) },
                  { label: "Location", value: kase.meeting.location ?? "—" },
                  { label: "Status", value: <StatusBadge status={kase.meeting.status} /> },
                ]}
              />
            </SectionCard>
          )}

          <SectionCard title="Activity">
            <Timeline events={events} emptyLabel="No activity recorded yet." />
          </SectionCard>
        </div>
      </div>

      <DocumentsPanel
        user={user}
        linkedType="CPC"
        linkedId={kase.id}
        entityId={kase.pr.entityId}
        title="Case pack"
        description="Comparative statement, quotations, technical evaluation and anything else the committee relied on."
        defaultCategory="CPC"
      />
    </div>
  );
}
