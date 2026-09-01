import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  InlineAlert,
  MetaItem,
  Mono,
  PageHeader,
  SectionCard,
  StatTile,
} from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/forms";
import { fmtDate, fmtDateTime, money, percent } from "@/lib/format";
import { humanize } from "@/lib/domain";
import {
  comparative,
  quorumFor,
  RNC_CASE_STATE_LABELS,
  RNC_MEMBER_TYPE_LABELS,
  type RncCaseState,
  type RncMemberType,
} from "@/server/rnc";
import { conveneRncAction, setAttendanceAction, castRncVoteAction } from "../actions";
import { RncPanels } from "./RncPanels";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await prisma.rncCase.findUnique({ where: { id }, select: { number: true, title: true } });
  return { title: c ? `${c.number} — ${c.title}` : "Rental case" };
}

export default async function RncCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, authorized } = await pageContext(P.RNC_VIEW);
  if (!authorized) return <AccessDenied title="Rental case" />;

  const kase = await prisma.rncCase.findUnique({
    where: { id },
    include: {
      entity: { select: { code: true, name: true } },
      createdBy: { select: { name: true } },
      buildOut: { select: { id: true, number: true, name: true } },
      attendance: { include: { member: true } },
      votes: { include: { member: true }, orderBy: { castAt: "asc" } },
    },
  });
  if (!kase) notFound();

  const [quotes, quorum] = await Promise.all([comparative(kase.id), quorumFor(kase.id)]);

  const canRaise = userHasPermission(ctx.user, P.RNC_CASE_RAISE, P.RNC_MANAGE);
  const canManage = userHasPermission(ctx.user, P.RNC_MANAGE);
  const canVote = userHasPermission(ctx.user, P.RNC_DECIDE);

  const selected = quotes.find((q) => q.isSelected) ?? null;
  const decided = ["APPROVED", "REJECTED", "AGREEMENT_SIGNED", "CLOSED"].includes(kase.status);
  const mySeat = kase.attendance.find((a) => a.member.userId === ctx.user.id);
  const myVote = kase.votes.find((v) => v.member.userId === ctx.user.id);

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[{ label: "Rental committee", href: "/rnc" }, { label: kase.number }]}
      />

      <PageHeader
        eyebrow={`${kase.entity.code} · ${kase.region.charAt(0)}${kase.region.slice(1).toLowerCase()}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{kase.number}</span>
            <span>{kase.title}</span>
          </span>
        }
        actions={
          <>
            {kase.status === "DRAFT" && canRaise && (
              <ActionButton
                action={conveneRncAction}
                payload={{ caseId: kase.id }}
                label="Put to the committee"
                tone="primary"
              />
            )}
            {kase.status === "PENDING_RNC" && canVote && mySeat && mySeat.member.memberType !== "OBSERVER" && (
              <>
                <ActionButton
                  action={castRncVoteAction}
                  payload={{ caseId: kase.id, vote: "APPROVE" }}
                  label={myVote ? "Change to approve" : "Approve"}
                  tone="success"
                />
                <ActionButton
                  action={castRncVoteAction}
                  payload={{ caseId: kase.id, vote: "REJECT" }}
                  label="Reject"
                  tone="danger-soft"
                  reasonLabel="Why"
                  reasonRequired
                />
              </>
            )}
            {kase.buildOut && (
              <Link className="btn btn-secondary btn-sm" href={`/build-outs/${kase.buildOut.id}`}>
                {kase.buildOut.number}
              </Link>
            )}
          </>
        }
        meta={
          <>
            <MetaItem label="Status">
              <Badge
                tone={
                  kase.status === "APPROVED" || kase.status === "AGREEMENT_SIGNED"
                    ? "success"
                    : kase.status === "REJECTED"
                      ? "danger"
                      : kase.status === "DEFERRED"
                        ? "warning"
                        : "progress"
                }
              >
                {RNC_CASE_STATE_LABELS[kase.status as RncCaseState] ?? kase.status}
              </Badge>
            </MetaItem>
            {selected && <MetaItem label="Landlord">{selected.landlordName}</MetaItem>}
            {selected && <MetaItem label="Monthly rent">{money(selected.monthlyRent)}</MetaItem>}
            <MetaItem label="Raised by">{kase.createdBy.name}</MetaItem>
            {kase.decidedAt && <MetaItem label="Decided">{fmtDate(kase.decidedAt)}</MetaItem>}
          </>
        }
      />

      {kase.status === "APPROVED" && !kase.decisionEmailRef && (
        <InlineAlert tone="danger">
          Approved, and Finance cannot act on it. RN-010 makes the decision email — to members, copying the
          CEO&rsquo;s office, with the documentation trail — the thing payment is initiated against. Record it below.
        </InlineAlert>
      )}

      {kase.status === "DEFERRED" && (
        <InlineAlert tone="warning">
          Deferred to the next RNC. {kase.deferredReason}
        </InlineAlert>
      )}

      {kase.status === "PENDING_RNC" && (
        <InlineAlert tone={quorum.quorate ? "info" : "warning"}>
          <span className="font-600">{quorum.quorate ? "Quorate. " : "Not quorate. "}</span>
          {quorum.reason}
          {!quorum.quorate && " RN-004's own remedy is to defer to the next RNC."}
        </InlineAlert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile
          label="Quorum"
          value={`${quorum.present}/${quorum.required}`}
          hint={quorum.headPresent ? "Head present" : "Head absent"}
          tone={quorum.quorate ? "success" : "warning"}
        />
        <StatTile label="Voting seats" value={quorum.votingSeats} hint="Observers excluded" />
        <StatTile label="Quotations" value={quotes.length} hint={quotes.length < 2 ? "RN-007 needs a comparative" : "Comparative"} tone={quotes.length < 2 ? "warning" : undefined} />
        <StatTile
          label="Votes cast"
          value={kase.votes.length}
          hint={`${kase.votes.filter((v) => v.vote === "APPROVE").length} approve`}
        />
      </div>

      <RncPanels
        kase={{
          id: kase.id,
          number: kase.number,
          status: kase.status,
          needAssessment: kase.needAssessment,
          locationNote: kase.locationNote,
          commercialTerms: kase.commercialTerms,
          marketPracticeNote: kase.marketPracticeNote,
          landlordObligations: kase.landlordObligations,
          decisionSummary: kase.decisionSummary,
          decisionEmailRef: kase.decisionEmailRef,
          decisionEmailSentAt: kase.decisionEmailSentAt,
          ceoOfficeCopied: kase.ceoOfficeCopied,
          quorumRequired: kase.quorumRequired,
          quorumPresent: kase.quorumPresent,
          headPresent: kase.headPresent,
        }}
        quotes={quotes.map((q) => ({
          id: q.id,
          landlordName: q.landlordName,
          propertyRef: q.propertyRef,
          areaSqft: q.areaSqft,
          monthlyRent: q.monthlyRent,
          annualEscalationPercent: q.annualEscalationPercent,
          advanceMonths: q.advanceMonths,
          securityDeposit: q.securityDeposit,
          leaseYears: q.leaseYears,
          technicalEvaluation: q.technicalEvaluation,
          environmentalImpact: q.environmentalImpact,
          quoteAnalysisNote: q.quoteAnalysisNote,
          isSelected: q.isSelected,
          isLowest: q.isLowest,
          selectionReason: q.selectionReason,
          indicativeLeaseCost: q.indicativeLeaseCost,
        }))}
        attendance={kase.attendance.map((a) => ({
          id: a.id,
          memberId: a.memberId,
          memberName: a.member.memberName,
          designation: a.member.designation,
          memberType: a.member.memberType,
          isHead: a.member.isHead,
          attendance: a.attendance,
          proxyName: a.proxyName,
        }))}
        votes={kase.votes.map((v) => ({
          id: v.id,
          memberName: v.member.memberName,
          vote: v.vote,
          comment: v.comment,
          castAt: v.castAt,
        }))}
        quorum={quorum}
        caps={{ canRaise, canManage, canVote }}
      />
    </div>
  );
}
