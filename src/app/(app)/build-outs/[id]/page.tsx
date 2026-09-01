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
import { LifecycleRail, type RailStep } from "@/components/ui/workflow";
import { fmtDate, fmtDateTime, money, round2 } from "@/lib/format";
import { humanize } from "@/lib/domain";
import {
  BUILD_OUT_STATE_LABELS,
  checklistProgress,
  variance,
  type BuildOutState,
} from "@/server/buildout";
import { approveBuildOutAction, closeBuildOutAction, scheduleWeeklyAction } from "../actions";
import { BuildOutPanels } from "./BuildOutPanels";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const b = await prisma.buildOut.findUnique({ where: { id }, select: { number: true, name: true } });
  return { title: b ? `${b.number} — ${b.name}` : "Build-out" };
}

/**
 * One build-out.
 *
 * Laid out as the SOP's own sequence, because the sequence is the control: the
 * go-ahead, the requirements, the timelines, the committee, the checklist, the
 * weekly reviews, and the closing variance. What each stage is missing is said
 * where the stage is, rather than collected into a list nobody reads.
 */
export default async function BuildOutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, authorized } = await pageContext(P.BUILD_OUT_VIEW);
  if (!authorized) return <AccessDenied title="Build-out" />;

  const buildOut = await prisma.buildOut.findUnique({
    where: { id },
    include: {
      entity: { select: { code: true, name: true } },
      project: { select: { id: true, code: true, name: true } },
      site: { select: { name: true } },
      createdBy: { select: { name: true } },
      managementApprovedBy: { select: { name: true, title: true } },
      requirementsGatheredBy: { select: { name: true } },
      meetings: { orderBy: { scheduledAt: "desc" } },
      boqLines: { orderBy: { lineNo: "asc" }, include: { measuredBy: { select: { name: true } } } },
      schedule: { orderBy: { day: "asc" }, include: { vendor: { select: { name: true } } } },
      lessons: { orderBy: { raisedAt: "desc" }, include: { raisedBy: { select: { name: true } } } },
      rncCases: { select: { id: true, number: true, status: true, title: true } },
    },
  });
  if (!buildOut) notFound();

  const [progress, v] = await Promise.all([checklistProgress(buildOut.id), variance(buildOut.id)]);

  const canApprove = userHasPermission(ctx.user, P.BUILD_OUT_MANAGEMENT_APPROVE);
  const canEdit = userHasPermission(ctx.user, P.BUILD_OUT_EDIT);
  const canMeet = userHasPermission(ctx.user, P.BUILD_OUT_MEETING_MANAGE);
  const canClose = userHasPermission(ctx.user, P.BUILD_OUT_CLOSE);
  const canTask = userHasPermission(ctx.user, P.BUILD_OUT_TASK_UPDATE, P.BUILD_OUT_EDIT);

  const totalTasks = progress.reduce((a, g) => a + g.total, 0);
  const doneTasks = progress.reduce((a, g) => a + g.done + g.notApplicable, 0);
  const blockedTasks = progress.reduce((a, g) => a + g.blocked, 0);
  const lastHeld = buildOut.meetings.find((m) => m.status === "HELD");
  const nextMeeting = buildOut.meetings.find((m) => m.status === "SCHEDULED");
  const closed = ["CLOSED", "CANCELLED"].includes(buildOut.status);

  // The rail is the SOP's sequence, and each stage is "current" only once the one
  // before it is done — which is what makes a skipped step visible rather than
  // merely absent.
  const stageDone = [
    true,
    Boolean(buildOut.managementApprovedAt),
    Boolean(buildOut.requirementsGatheredAt),
    Boolean(buildOut.timelinesSharedAt),
    buildOut.meetings.length > 0,
    buildOut.status === "CLOSED",
  ];
  const firstOpen = stageDone.findIndex((d) => !d);
  const stageState = (i: number): RailStep["state"] =>
    buildOut.status === "CANCELLED" ? "skipped" : stageDone[i] ? "done" : i === firstOpen ? "current" : "pending";

  const rail: RailStep[] = [
    { key: "DRAFT", label: "Raised", state: stageState(0), at: buildOut.createdAt },
    {
      key: "MANAGEMENT",
      label: "Management go-ahead",
      state: stageState(1),
      at: buildOut.managementApprovedAt,
      owner: buildOut.managementApprovedBy?.name ?? null,
      note: buildOut.managementApprovedAt ? null : "BO-002 puts this first",
    },
    {
      key: "REQUIREMENTS",
      label: "Requirements gathered",
      state: stageState(2),
      at: buildOut.requirementsGatheredAt,
      owner: buildOut.requirementsGatheredBy?.name ?? null,
    },
    { key: "TIMELINES", label: "Timelines shared", state: stageState(3), at: buildOut.timelinesSharedAt },
    {
      key: "CFC",
      label: "Committee convened",
      state: stageState(4),
      at: buildOut.meetings.at(-1)?.scheduledAt ?? null,
    },
    { key: "CLOSED", label: "Closed", state: stageState(5), at: buildOut.closedAt },
  ];

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[{ label: "Build-outs", href: "/build-outs" }, { label: buildOut.number }]}
      />

      <PageHeader
        eyebrow={`${buildOut.entity.code} · ${buildOut.region.charAt(0)}${buildOut.region.slice(1).toLowerCase()}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{buildOut.number}</span>
            <span>{buildOut.name}</span>
          </span>
        }
        actions={
          <>
            {!buildOut.managementApprovedAt && canApprove && (
              <ActionButton
                action={approveBuildOutAction}
                payload={{ buildOutId: buildOut.id }}
                label="Give management's go-ahead"
                tone="primary"
                reasonLabel="Note (optional)"
              />
            )}
            {["CFC_PRESENTED", "IN_EXECUTION"].includes(buildOut.status) && canMeet && (
              <ActionButton
                action={scheduleWeeklyAction}
                payload={{ buildOutId: buildOut.id }}
                label="Schedule the Friday review"
              />
            )}
            {!closed && canClose && (
              <ActionButton
                action={closeBuildOutAction}
                payload={{ buildOutId: buildOut.id }}
                label="Close the build-out"
                tone="success"
                reasonLabel="Closing summary"
                confirm="Close this build-out? The cost and timeline variance goes to management."
              />
            )}
          </>
        }
        meta={
          <>
            <MetaItem label="Stage">
              <Badge tone={closed ? "success" : "progress"}>
                {BUILD_OUT_STATE_LABELS[buildOut.status as BuildOutState] ?? buildOut.status}
              </Badge>
            </MetaItem>
            {buildOut.city && <MetaItem label="City">{buildOut.city}</MetaItem>}
            {buildOut.headcount != null && <MetaItem label="Headcount">{buildOut.headcount}</MetaItem>}
            {buildOut.project && (
              <MetaItem label="Project">
                <Link className="link" href={`/projects/${buildOut.project.id}`}>
                  {buildOut.project.code}
                </Link>
              </MetaItem>
            )}
            <MetaItem label="Raised by">{buildOut.createdBy.name}</MetaItem>
            {buildOut.plannedStartDate && buildOut.plannedEndDate && (
              <MetaItem label="Planned">
                {fmtDate(buildOut.plannedStartDate)} → {fmtDate(buildOut.plannedEndDate)}
              </MetaItem>
            )}
          </>
        }
      />

      {!buildOut.managementApprovedAt && (
        <InlineAlert tone="warning">
          No management go-ahead. BO-002 makes that the first step, and requirement gathering is refused until it is
          recorded — by somebody other than whoever raised this.
        </InlineAlert>
      )}

      <LifecycleRail steps={rail} title="The SOP's sequence" />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile
          label="Checklist"
          value={totalTasks ? `${doneTasks}/${totalTasks}` : "—"}
          hint={totalTasks ? `${blockedTasks} blocked` : "Handed out when the committee convenes"}
          tone={blockedTasks ? "warning" : undefined}
        />
        <StatTile
          label="Cost"
          value={v.cost.budget ? money(v.cost.actual) : "—"}
          hint={v.cost.budget ? `against ${money(v.cost.budget)}` : "No BOQ yet"}
          tone={v.cost.variance > 0 ? "danger" : v.cost.actual > 0 ? "success" : undefined}
        />
        <StatTile
          label="BOQ measured"
          value={v.cost.linesTotal ? `${v.cost.linesMeasured}/${v.cost.linesTotal}` : "—"}
          hint="BO-014 · measured against the BOQ"
        />
        <StatTile
          label="Last review"
          value={lastHeld ? fmtDate(lastHeld.heldAt) : "None"}
          hint={nextMeeting ? `Next ${fmtDate(nextMeeting.scheduledAt)}` : "None scheduled"}
          tone={!lastHeld && buildOut.status === "IN_EXECUTION" ? "warning" : undefined}
        />
      </div>

      {buildOut.rncCases.length > 0 && (
        <SectionCard
          title="Rental committee"
          description="BO-003 — the building itself is acquired through the RNC, and the lease decision is its case, not this one."
          bodyClassName="px-3.5 py-3"
        >
          <ul className="space-y-1 text-xs">
            {buildOut.rncCases.map((c) => (
              <li key={c.id}>
                <Link className="link" href={`/rnc/${c.id}`}>
                  <Mono className="text-2xs">{c.number}</Mono>
                </Link>{" "}
                {c.title} — {humanize(c.status)}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <BuildOutPanels
        buildOut={{
          id: buildOut.id,
          number: buildOut.number,
          status: buildOut.status,
          headcount: buildOut.headcount,
          requirementsSummary: buildOut.requirementsSummary,
          specialRequirements: buildOut.specialRequirements,
          requirementsGatheredAt: buildOut.requirementsGatheredAt,
          managementApprovedAt: buildOut.managementApprovedAt,
          managementApprovedBy: buildOut.managementApprovedBy?.name ?? null,
          managementNote: buildOut.managementNote,
          plannedStartDate: buildOut.plannedStartDate,
          plannedEndDate: buildOut.plannedEndDate,
        }}
        progress={progress.map((g) => ({
          department: g.department,
          total: g.total,
          done: g.done,
          blocked: g.blocked,
          notApplicable: g.notApplicable,
          rows: g.rows.map((r) => ({
            id: r.id,
            responsibility: r.responsibility,
            status: r.status,
            progressNote: r.progressNote,
            notApplicableReason: r.notApplicableReason,
            ownerName: r.owner?.name ?? null,
            dueDate: r.dueDate,
          })),
        }))}
        meetings={buildOut.meetings.map((m) => ({
          id: m.id,
          number: m.number,
          meetingType: m.meetingType,
          scheduledAt: m.scheduledAt,
          heldAt: m.heldAt,
          status: m.status,
          agenda: m.agenda,
          minutes: m.minutes,
        }))}
        boqLines={buildOut.boqLines.map((l) => ({
          id: l.id,
          lineNo: l.lineNo,
          description: l.description,
          unit: l.unit,
          budgetQty: l.budgetQty,
          budgetRate: l.budgetRate,
          budgetTotal: l.budgetTotal,
          actualQty: l.actualQty,
          actualRate: l.actualRate,
          actualTotal: l.actualTotal,
          varianceNote: l.varianceNote,
          measuredByName: l.measuredBy?.name ?? null,
        }))}
        schedule={buildOut.schedule.map((d) => ({
          id: d.id,
          day: d.day,
          activity: d.activity,
          vendorName: d.vendor?.name ?? d.vendorName,
          status: d.status,
          slipReason: d.slipReason,
        }))}
        lessons={buildOut.lessons.map((l) => ({
          id: l.id,
          category: l.category,
          finding: l.finding,
          recommendation: l.recommendation,
          raisedByName: l.raisedBy.name,
          raisedAt: l.raisedAt,
        }))}
        variance={v}
        caps={{ canEdit, canMeet, canTask, canClose }}
      />
    </div>
  );
}
