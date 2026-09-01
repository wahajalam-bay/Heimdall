"use client";

import { useState } from "react";
import { ActionButton, ActionForm, Modal } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { Badge, InlineAlert, Mono, SectionCard } from "@/components/ui/primitives";
import { TabNav } from "@/components/ui/nav";
import { fmtDate, fmtDateTime, money } from "@/lib/format";
import { humanize } from "@/lib/domain";
import {
  addLessonAction,
  addScheduleDayAction,
  checkScheduleDayAction,
  conveneCfcAction,
  measureBoqLineAction,
  minuteMeetingAction,
  recordRequirementsAction,
  setTimelinesAction,
  updateTaskAction,
  upsertBoqLineAction,
} from "../actions";

type Task = {
  id: string;
  responsibility: string;
  status: string;
  progressNote: string | null;
  notApplicableReason: string | null;
  ownerName: string | null;
  dueDate: Date | null;
};

type Group = {
  department: string;
  total: number;
  done: number;
  blocked: number;
  notApplicable: number;
  rows: Task[];
};

const TASK_TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "progress"> = {
  DONE: "success",
  IN_PROGRESS: "progress",
  BLOCKED: "danger",
  NOT_APPLICABLE: "neutral",
  NOT_STARTED: "warning",
};

/**
 * The working surface of a build-out.
 *
 * Tabbed because the SOP's stages are genuinely different jobs done by different
 * people — Admin gathers requirements, the committee meets, the architect
 * measures the BOQ — and a single scroll would bury the one anybody came for.
 */
export function BuildOutPanels({
  buildOut,
  progress,
  meetings,
  boqLines,
  schedule,
  lessons,
  variance,
  caps,
}: {
  buildOut: {
    id: string;
    number: string;
    status: string;
    headcount: number | null;
    requirementsSummary: string | null;
    specialRequirements: string | null;
    requirementsGatheredAt: Date | null;
    managementApprovedAt: Date | null;
    managementApprovedBy: string | null;
    managementNote: string | null;
    plannedStartDate: Date | null;
    plannedEndDate: Date | null;
  };
  progress: Group[];
  meetings: Array<{
    id: string;
    number: string;
    meetingType: string;
    scheduledAt: Date;
    heldAt: Date | null;
    status: string;
    agenda: string | null;
    minutes: string | null;
  }>;
  boqLines: Array<{
    id: string;
    lineNo: number;
    description: string;
    unit: string;
    budgetQty: number;
    budgetRate: number;
    budgetTotal: number;
    actualQty: number | null;
    actualRate: number | null;
    actualTotal: number | null;
    varianceNote: string | null;
    measuredByName: string | null;
  }>;
  schedule: Array<{
    id: string;
    day: Date;
    activity: string;
    vendorName: string | null;
    status: string;
    slipReason: string | null;
  }>;
  lessons: Array<{
    id: string;
    category: string;
    finding: string;
    recommendation: string | null;
    raisedByName: string;
    raisedAt: Date;
  }>;
  variance: {
    cost: { budget: number; actual: number; variance: number; percent: number | null; linesMeasured: number; linesTotal: number };
    timeline: { plannedDays: number | null; actualDays: number | null; variance: number | null };
  };
  caps: { canEdit: boolean; canMeet: boolean; canTask: boolean; canClose: boolean };
}) {
  const [tab, setTab] = useState("checklist");
  const closed = ["CLOSED", "CANCELLED"].includes(buildOut.status);

  const tabs = [
    { key: "checklist", label: `Checklist (${progress.reduce((a, g) => a + g.total, 0)})` },
    { key: "brief", label: "Brief & timelines" },
    { key: "meetings", label: `Meetings (${meetings.length})` },
    { key: "boq", label: `BOQ (${boqLines.length})` },
    { key: "schedule", label: `Schedule (${schedule.length})` },
    { key: "lessons", label: `Lessons (${lessons.length})` },
  ];

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 border-b border-[var(--c-border)] pb-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={
              tab === t.key
                ? "rounded-md bg-[var(--c-surface-secondary)] px-2.5 py-1 text-xs font-600"
                : "rounded-md px-2.5 py-1 text-xs text-muted hover:bg-[var(--c-surface-secondary)]"
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="pt-4">
        {tab === "checklist" && (
          <ChecklistPanel
            buildOutId={buildOut.id}
            progress={progress}
            canTask={caps.canTask && !closed}
          />
        )}
        {tab === "brief" && <BriefPanel buildOut={buildOut} canEdit={caps.canEdit && !closed} />}
        {tab === "meetings" && (
          <MeetingsPanel
            buildOutId={buildOut.id}
            meetings={meetings}
            canMeet={caps.canMeet && !closed}
          />
        )}
        {tab === "boq" && (
          <BoqPanel
            buildOutId={buildOut.id}
            lines={boqLines}
            variance={variance}
            canEdit={caps.canEdit && !closed}
          />
        )}
        {tab === "schedule" && (
          <SchedulePanel
            buildOutId={buildOut.id}
            days={schedule}
            canEdit={caps.canEdit && !closed}
          />
        )}
        {tab === "lessons" && (
          <LessonsPanel
            buildOutId={buildOut.id}
            lessons={lessons}
            variance={variance}
            canEdit={(caps.canEdit || caps.canClose) && !closed}
          />
        )}
      </div>
    </div>
  );
}

/* ── Checklist ────────────────────────────────────────────── */

function ChecklistPanel({
  buildOutId,
  progress,
  canTask,
}: {
  buildOutId: string;
  progress: Group[];
  canTask: boolean;
}) {
  if (progress.length === 0) {
    return (
      <InlineAlert tone="info">
        The checklist is handed out when the Cross Functional Committee is convened — BO-007. Convene it from the
        Meetings tab, and all ten departments&rsquo; responsibilities are copied onto this project at once.
      </InlineAlert>
    );
  }
  return (
    <div className="space-y-4">
      {progress.map((g) => (
        <SectionCard
          key={g.department}
          title={g.department}
          description={`${g.done} of ${g.total} done${g.blocked ? ` · ${g.blocked} blocked` : ""}${
            g.notApplicable ? ` · ${g.notApplicable} not applicable` : ""
          }`}
          bodyClassName="px-0 py-0"
        >
          <ul className="row-list">
            {g.rows.map((t) => (
              <li key={t.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs">{t.responsibility}</span>
                    <Badge tone={TASK_TONE[t.status] ?? "neutral"}>{humanize(t.status)}</Badge>
                  </div>
                  {t.progressNote && (
                    <p className="mt-0.5 text-2xs leading-4 text-muted">{t.progressNote}</p>
                  )}
                  {t.notApplicableReason && (
                    <p className="mt-0.5 text-2xs leading-4 text-[var(--c-text-tertiary)]">
                      Not applicable — {t.notApplicableReason}
                    </p>
                  )}
                  <p className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">
                    {t.ownerName ?? "unassigned"}
                    {t.dueDate ? ` · due ${fmtDate(t.dueDate)}` : ""}
                  </p>
                </div>
                {canTask && <TaskForm buildOutId={buildOutId} task={t} />}
              </li>
            ))}
          </ul>
        </SectionCard>
      ))}
    </div>
  );
}

function TaskForm({ buildOutId, task }: { buildOutId: string; task: Task }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(task.status);
  return (
    <>
      <button type="button" className="btn btn-secondary btn-xs" onClick={() => setOpen(true)}>
        Update
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={task.responsibility}
        description="Progress as it will be read in the Friday review."
      >
        <ActionForm
          action={updateTaskAction}
          layout="bare"
          submitLabel="Save"
          hiddenFields={{ buildOutId, taskId: task.id, status }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={1}>
            <Field label="Status" name="statusChoice" required>
              <Select
                name="statusChoice"
                value={status}
                onChange={(e) => setStatus(e.currentTarget.value)}
                options={[
                  { value: "NOT_STARTED", label: "Not started" },
                  { value: "IN_PROGRESS", label: "In progress" },
                  { value: "BLOCKED", label: "Blocked" },
                  { value: "DONE", label: "Done" },
                  { value: "NOT_APPLICABLE", label: "Not applicable here" },
                ]}
              />
            </Field>
            <Field
              label="Progress note"
              name="progressNote"
              hint={status === "BLOCKED" ? "Required — say what is blocking it." : undefined}
            >
              <TextArea name="progressNote" rows={2} defaultValue={task.progressNote ?? ""} />
            </Field>
            {status === "NOT_APPLICABLE" && (
              <Field
                label="Why it does not apply"
                name="notApplicableReason"
                required
                hint="The checklist is the document's own, so dropping a line needs a reason."
              >
                <TextArea name="notApplicableReason" rows={2} required />
              </Field>
            )}
            <Field label="Due date" name="dueDate">
              <TextInput
                type="date"
                name="dueDate"
                defaultValue={task.dueDate ? task.dueDate.toISOString().slice(0, 10) : ""}
              />
            </Field>
          </FormSection>
        </ActionForm>
      </Modal>
    </>
  );
}

/* ── Brief and timelines ──────────────────────────────────── */

function BriefPanel({
  buildOut,
  canEdit,
}: {
  buildOut: {
    id: string;
    headcount: number | null;
    requirementsSummary: string | null;
    specialRequirements: string | null;
    requirementsGatheredAt: Date | null;
    managementApprovedAt: Date | null;
    managementApprovedBy: string | null;
    managementNote: string | null;
    plannedStartDate: Date | null;
    plannedEndDate: Date | null;
  };
  canEdit: boolean;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionCard
        title="Requirements — BO-004"
        description="What Admin gathered from the departments, Sales especially."
      >
        {buildOut.requirementsGatheredAt ? (
          <div className="space-y-2 text-xs">
            <p>
              <span className="text-[var(--c-text-tertiary)]">Headcount: </span>
              {buildOut.headcount ?? "—"}
            </p>
            <p className="whitespace-pre-line leading-5">{buildOut.requirementsSummary}</p>
            {buildOut.specialRequirements && (
              <p className="whitespace-pre-line leading-5 text-muted">
                Special: {buildOut.specialRequirements}
              </p>
            )}
            <p className="text-2xs text-[var(--c-text-tertiary)]">
              Recorded {fmtDateTime(buildOut.requirementsGatheredAt)}
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted">Not gathered yet.</p>
        )}
        {canEdit && (
          <div className="mt-3">
            <ActionForm
              action={recordRequirementsAction}
              layout="bare"
              submitLabel="Record requirements"
              hiddenFields={{ buildOutId: buildOut.id }}
            >
              <FormSection columns={1}>
                <Field label="Headcount" name="headcount">
                  <TextInput
                    type="number"
                    min="0"
                    step="1"
                    name="headcount"
                    defaultValue={buildOut.headcount ?? ""}
                  />
                </Field>
                <Field label="What the departments asked for" name="requirementsSummary" required>
                  <TextArea
                    name="requirementsSummary"
                    rows={4}
                    required
                    defaultValue={buildOut.requirementsSummary ?? ""}
                  />
                </Field>
                <Field label="Special requirements" name="specialRequirements">
                  <TextArea
                    name="specialRequirements"
                    rows={2}
                    defaultValue={buildOut.specialRequirements ?? ""}
                  />
                </Field>
              </FormSection>
            </ActionForm>
          </div>
        )}
      </SectionCard>

      <div className="space-y-4">
        <SectionCard
          title="Management go-ahead — BO-002"
          description="The first step of the SOP, and a decision by somebody other than whoever raised the project."
        >
          {buildOut.managementApprovedAt ? (
            <p className="text-xs">
              {buildOut.managementApprovedBy} on {fmtDateTime(buildOut.managementApprovedAt)}
              {buildOut.managementNote && (
                <span className="mt-1 block text-2xs leading-4 text-muted">{buildOut.managementNote}</span>
              )}
            </p>
          ) : (
            <p className="text-xs text-[var(--c-warning)]">Not given. Nothing else can start.</p>
          )}
        </SectionCard>

        <SectionCard
          title="Timelines — BO-006"
          description="Defined at an early stage and shared with the committee, which is what the weekly deadlines are cut from."
        >
          {buildOut.plannedStartDate && buildOut.plannedEndDate ? (
            <p className="text-xs">
              {fmtDate(buildOut.plannedStartDate)} → {fmtDate(buildOut.plannedEndDate)}
            </p>
          ) : (
            <p className="text-xs text-muted">Not set.</p>
          )}
          {canEdit && (
            <div className="mt-3">
              <ActionForm
                action={setTimelinesAction}
                layout="bare"
                submitLabel="Set timelines"
                hiddenFields={{ buildOutId: buildOut.id }}
              >
                <FormSection columns={2}>
                  <Field label="Planned start" name="plannedStartDate" required>
                    <TextInput
                      type="date"
                      name="plannedStartDate"
                      required
                      defaultValue={buildOut.plannedStartDate?.toISOString().slice(0, 10) ?? ""}
                    />
                  </Field>
                  <Field label="Planned end" name="plannedEndDate" required>
                    <TextInput
                      type="date"
                      name="plannedEndDate"
                      required
                      defaultValue={buildOut.plannedEndDate?.toISOString().slice(0, 10) ?? ""}
                    />
                  </Field>
                </FormSection>
              </ActionForm>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

/* ── Meetings ─────────────────────────────────────────────── */

function MeetingsPanel({
  buildOutId,
  meetings,
  canMeet,
}: {
  buildOutId: string;
  meetings: Array<{
    id: string;
    number: string;
    meetingType: string;
    scheduledAt: Date;
    heldAt: Date | null;
    status: string;
    agenda: string | null;
    minutes: string | null;
  }>;
  canMeet: boolean;
}) {
  const kickoff = meetings.some((m) => m.meetingType === "KICKOFF");
  return (
    <div className="space-y-4">
      {!kickoff && canMeet && (
        <SectionCard
          title="Convene the committee — BO-007"
          description="Project details, scope and the departmental checklist. Refused until the go-ahead, the requirements and the timelines all exist, because there is nothing to present without them."
        >
          <ActionForm
            action={conveneCfcAction}
            layout="bare"
            submitLabel="Convene the CFC"
            hiddenFields={{ buildOutId }}
          >
            <FormSection columns={2}>
              <Field label="When" name="scheduledAt" required>
                <TextInput type="datetime-local" name="scheduledAt" required />
              </Field>
              <Field label="Where" name="location">
                <TextInput name="location" placeholder="Boardroom, Zameen Tower" />
              </Field>
              <Field label="Agenda" name="agenda" className="sm:col-span-2">
                <TextArea name="agenda" rows={2} />
              </Field>
            </FormSection>
          </ActionForm>
        </SectionCard>
      )}

      {meetings.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted">No meetings yet.</p>
      ) : (
        <div className="space-y-3">
          {meetings.map((m) => (
            <SectionCard
              key={m.id}
              title={
                <span className="flex flex-wrap items-baseline gap-2">
                  <Mono className="text-xs">{m.number}</Mono>
                  <Badge tone={m.status === "HELD" ? "success" : "progress"}>{humanize(m.meetingType)}</Badge>
                </span>
              }
              description={`${fmtDateTime(m.scheduledAt)}${m.heldAt ? ` · held ${fmtDate(m.heldAt)}` : ""}`}
              bodyClassName="px-3.5 py-3"
            >
              {m.agenda && <p className="text-2xs leading-4 text-muted">{m.agenda}</p>}
              {m.minutes ? (
                <p className="mt-2 whitespace-pre-line text-xs leading-5">{m.minutes}</p>
              ) : canMeet ? (
                <div className="mt-2">
                  <ActionForm
                    action={minuteMeetingAction}
                    layout="bare"
                    submitLabel="Record minutes"
                    hiddenFields={{ buildOutId, meetingId: m.id }}
                  >
                    <Field label="Minutes" name="minutes" required>
                      <TextArea name="minutes" rows={3} required />
                    </Field>
                  </ActionForm>
                </div>
              ) : (
                <p className="mt-2 text-2xs text-[var(--c-text-tertiary)]">Not yet minuted.</p>
              )}
            </SectionCard>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── BOQ ──────────────────────────────────────────────────── */

function BoqPanel({
  buildOutId,
  lines,
  variance,
  canEdit,
}: {
  buildOutId: string;
  lines: Array<{
    id: string;
    lineNo: number;
    description: string;
    unit: string;
    budgetQty: number;
    budgetRate: number;
    budgetTotal: number;
    actualQty: number | null;
    actualRate: number | null;
    actualTotal: number | null;
    varianceNote: string | null;
    measuredByName: string | null;
  }>;
  variance: {
    cost: { budget: number; actual: number; variance: number; percent: number | null; linesMeasured: number; linesTotal: number };
  };
  canEdit: boolean;
}) {
  return (
    <div className="space-y-4">
      <SectionCard
        title="Bill of quantities — BO-014"
        description="Budget and measured actual side by side. The measured figure never replaces the budget, because the variance is the deliverable."
        bodyClassName="px-0 py-0"
      >
        {lines.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-xs text-muted">No BOQ lines yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: "3rem" }}>Sr</th>
                  <th style={{ minWidth: "14rem" }}>Description</th>
                  <th style={{ width: "4rem" }}>Unit</th>
                  <th style={{ width: "6rem" }} className="text-right">Budget qty</th>
                  <th style={{ width: "7rem" }} className="text-right">Budget</th>
                  <th style={{ width: "6rem" }} className="text-right">Actual qty</th>
                  <th style={{ width: "7rem" }} className="text-right">Actual</th>
                  <th style={{ width: "7rem" }} className="text-right">Variance</th>
                  <th style={{ width: "6rem" }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const varianceAmount = l.actualTotal != null ? l.actualTotal - l.budgetTotal : null;
                  return (
                    <tr key={l.id}>
                      <td className="tnum">{l.lineNo}</td>
                      <td className="text-xs">
                        {l.description}
                        {l.varianceNote && (
                          <span className="mt-0.5 block text-2xs leading-4 text-[var(--c-text-tertiary)]">
                            {l.varianceNote}
                          </span>
                        )}
                      </td>
                      <td className="text-2xs">{l.unit}</td>
                      <td className="tnum text-right">{l.budgetQty}</td>
                      <td className="tnum text-right">{money(l.budgetTotal)}</td>
                      <td className="tnum text-right">{l.actualQty ?? "—"}</td>
                      <td className="tnum text-right">{l.actualTotal != null ? money(l.actualTotal) : "—"}</td>
                      <td
                        className={`tnum text-right ${
                          varianceAmount == null
                            ? ""
                            : varianceAmount > 0
                              ? "text-[var(--c-danger)]"
                              : "text-[var(--c-success)]"
                        }`}
                      >
                        {varianceAmount == null ? "—" : money(varianceAmount)}
                      </td>
                      <td className="text-right">
                        {canEdit && <MeasureForm buildOutId={buildOutId} line={l} />}
                      </td>
                    </tr>
                  );
                })}
                <tr>
                  <td colSpan={4} className="text-2xs uppercase tracking-wide">Total</td>
                  <td className="tnum text-right font-semibold">{money(variance.cost.budget)}</td>
                  <td />
                  <td className="tnum text-right font-semibold">{money(variance.cost.actual)}</td>
                  <td
                    className={`tnum text-right font-semibold ${
                      variance.cost.variance > 0 ? "text-[var(--c-danger)]" : "text-[var(--c-success)]"
                    }`}
                  >
                    {money(variance.cost.variance)}
                    {variance.cost.percent != null && (
                      <span className="ml-1 text-2xs">
                        ({variance.cost.percent > 0 ? "+" : ""}
                        {variance.cost.percent}%)
                      </span>
                    )}
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {canEdit && (
        <SectionCard title="Add or replace a BOQ line">
          <ActionForm
            action={upsertBoqLineAction}
            layout="bare"
            submitLabel="Save line"
            hiddenFields={{ buildOutId }}
            resetOnSuccess
          >
            <FormSection columns={3}>
              <Field label="Line no" name="lineNo" required>
                <TextInput type="number" min="1" step="1" name="lineNo" required />
              </Field>
              <Field label="Description" name="description" required className="sm:col-span-2">
                <TextInput name="description" required />
              </Field>
              <Field label="Unit" name="unit" required>
                <TextInput name="unit" required placeholder="sqft" />
              </Field>
              <Field label="Budget quantity" name="budgetQty" required>
                <TextInput type="number" min="0" step="0.01" name="budgetQty" required />
              </Field>
              <Field label="Budget rate" name="budgetRate" required>
                <TextInput type="number" min="0" step="0.01" name="budgetRate" required />
              </Field>
            </FormSection>
          </ActionForm>
        </SectionCard>
      )}
    </div>
  );
}

function MeasureForm({
  buildOutId,
  line,
}: {
  buildOutId: string;
  line: { id: string; lineNo: number; description: string; budgetTotal: number; actualQty: number | null; actualRate: number | null };
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-secondary btn-xs" onClick={() => setOpen(true)}>
        Measure
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Line ${line.lineNo} — ${line.description}`}
        description={`Budget ${money(line.budgetTotal)}. A line materially over budget needs a reason, because the closing variance goes to management.`}
      >
        <ActionForm
          action={measureBoqLineAction}
          layout="bare"
          submitLabel="Record the measurement"
          hiddenFields={{ buildOutId, lineId: line.id }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          }
        >
          <FormSection columns={2}>
            <Field label="Actual quantity" name="actualQty" required>
              <TextInput
                type="number"
                min="0"
                step="0.01"
                name="actualQty"
                required
                defaultValue={line.actualQty ?? ""}
              />
            </Field>
            <Field label="Actual rate" name="actualRate" required>
              <TextInput
                type="number"
                min="0"
                step="0.01"
                name="actualRate"
                required
                defaultValue={line.actualRate ?? ""}
              />
            </Field>
            <Field label="Variance note" name="varianceNote" className="sm:col-span-2">
              <TextArea name="varianceNote" rows={2} />
            </Field>
          </FormSection>
        </ActionForm>
      </Modal>
    </>
  );
}

/* ── Schedule ─────────────────────────────────────────────── */

function SchedulePanel({
  buildOutId,
  days,
  canEdit,
}: {
  buildOutId: string;
  days: Array<{
    id: string;
    day: Date;
    activity: string;
    vendorName: string | null;
    status: string;
    slipReason: string | null;
  }>;
  canEdit: boolean;
}) {
  const slipped = days.filter((d) => d.status === "SLIPPED").length;
  return (
    <div className="space-y-4">
      {slipped > 0 && (
        <InlineAlert tone="warning">
          {slipped} day{slipped === 1 ? "" : "s"} slipped. BO-015 puts the day-wise schedule with Admin and asks for
          compliance to be checked at regular intervals — a slip caught late is a slip that has already moved the end
          date.
        </InlineAlert>
      )}
      <SectionCard
        title="Day-wise vendor schedule — BO-015"
        description="Agreed with the vendor, and checked as it runs."
        bodyClassName="px-0 py-0"
      >
        {days.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-xs text-muted">No schedule yet.</p>
        ) : (
          <ul className="row-list">
            {days.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
                <span className="w-24 shrink-0 text-2xs text-[var(--c-text-tertiary)]">{fmtDate(d.day)}</span>
                <div className="min-w-0 flex-1">
                  <span className="text-xs">{d.activity}</span>
                  {d.vendorName && (
                    <span className="ml-2 text-2xs text-[var(--c-text-tertiary)]">{d.vendorName}</span>
                  )}
                  {d.slipReason && (
                    <span className="mt-0.5 block text-2xs leading-4 text-[var(--c-warning)]">{d.slipReason}</span>
                  )}
                </div>
                <Badge
                  tone={
                    d.status === "DONE"
                      ? "success"
                      : d.status === "SLIPPED"
                        ? "danger"
                        : d.status === "ON_TRACK"
                          ? "progress"
                          : "neutral"
                  }
                >
                  {humanize(d.status)}
                </Badge>
                {canEdit && (
                  <div className="flex gap-1.5">
                    <ActionButton
                      action={checkScheduleDayAction}
                      payload={{ buildOutId, dayId: d.id, status: "DONE" }}
                      label="Done"
                      size="xs"
                      tone="success"
                    />
                    <ActionButton
                      action={checkScheduleDayAction}
                      payload={{ buildOutId, dayId: d.id, status: "SLIPPED" }}
                      label="Slipped"
                      size="xs"
                      tone="danger-soft"
                      reasonLabel="Why it slipped"
                      reasonRequired
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {canEdit && (
        <SectionCard title="Add a day">
          <ActionForm
            action={addScheduleDayAction}
            layout="bare"
            submitLabel="Add"
            hiddenFields={{ buildOutId }}
            resetOnSuccess
          >
            <FormSection columns={3}>
              <Field label="Day" name="day" required>
                <TextInput type="date" name="day" required />
              </Field>
              <Field label="Activity" name="activity" required>
                <TextInput name="activity" required placeholder="Ceiling grid installation" />
              </Field>
              <Field label="Vendor" name="vendorName">
                <TextInput name="vendorName" />
              </Field>
            </FormSection>
          </ActionForm>
        </SectionCard>
      )}
    </div>
  );
}

/* ── Lessons ──────────────────────────────────────────────── */

function LessonsPanel({
  buildOutId,
  lessons,
  variance,
  canEdit,
}: {
  buildOutId: string;
  lessons: Array<{
    id: string;
    category: string;
    finding: string;
    recommendation: string | null;
    raisedByName: string;
    raisedAt: Date;
  }>;
  variance: {
    cost: { budget: number; actual: number; variance: number; percent: number | null };
    timeline: { plannedDays: number | null; actualDays: number | null; variance: number | null };
  };
  canEdit: boolean;
}) {
  return (
    <div className="space-y-4">
      <SectionCard
        title="Budget against actual — BO-010"
        description="Presented to management at closure, on cost and on timeline."
        bodyClassName="px-3.5 py-3"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="text-xs">
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Cost</p>
            <p className="mt-1">
              {money(variance.cost.actual)} against {money(variance.cost.budget)}
              {variance.cost.percent != null && (
                <span className={variance.cost.variance > 0 ? " text-[var(--c-danger)]" : " text-[var(--c-success)]"}>
                  {" "}
                  ({variance.cost.percent > 0 ? "+" : ""}
                  {variance.cost.percent}%)
                </span>
              )}
            </p>
          </div>
          <div className="text-xs">
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Timeline</p>
            <p className="mt-1">
              {variance.timeline.actualDays == null || variance.timeline.plannedDays == null ? (
                <span className="text-muted">Not yet measurable — needs both a planned and an actual span.</span>
              ) : (
                <>
                  {variance.timeline.actualDays} days against {variance.timeline.plannedDays} planned
                  {variance.timeline.variance != null && variance.timeline.variance !== 0 && (
                    <span
                      className={
                        variance.timeline.variance > 0 ? " text-[var(--c-danger)]" : " text-[var(--c-success)]"
                      }
                    >
                      {" "}
                      ({variance.timeline.variance > 0 ? "+" : ""}
                      {variance.timeline.variance})
                    </span>
                  )}
                </>
              )}
            </p>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Lesson-learnt report — BO-010"
        description="Loopholes and shortcomings, for the next project. Closure is refused while this is empty, because an empty report is not one."
        bodyClassName="px-0 py-0"
      >
        {lessons.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-xs text-muted">Nothing recorded yet.</p>
        ) : (
          <ul className="row-list">
            {lessons.map((l) => (
              <li key={l.id} className="px-3.5 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{humanize(l.category)}</Badge>
                  <span className="text-2xs text-[var(--c-text-tertiary)]">
                    {l.raisedByName} · {fmtDate(l.raisedAt)}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-5">{l.finding}</p>
                {l.recommendation && (
                  <p className="mt-0.5 text-2xs leading-4 text-muted">→ {l.recommendation}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {canEdit && (
        <SectionCard title="Record a lesson">
          <ActionForm
            action={addLessonAction}
            layout="bare"
            submitLabel="Record"
            hiddenFields={{ buildOutId }}
            resetOnSuccess
          >
            <FormSection columns={1}>
              <Field label="Category" name="category" required>
                <Select
                  name="category"
                  defaultValue="COORDINATION"
                  options={[
                    { value: "COST", label: "Cost" },
                    { value: "TIMELINE", label: "Timeline" },
                    { value: "QUALITY", label: "Quality" },
                    { value: "COORDINATION", label: "Coordination" },
                    { value: "VENDOR", label: "Vendor" },
                    { value: "OTHER", label: "Other" },
                  ]}
                />
              </Field>
              <Field label="What went wrong" name="finding" required>
                <TextArea name="finding" rows={3} required />
              </Field>
              <Field
                label="What to do differently"
                name="recommendation"
                hint="A loophole with no remedy is a complaint. The report is meant to serve the next project."
              >
                <TextArea name="recommendation" rows={2} />
              </Field>
            </FormSection>
          </ActionForm>
        </SectionCard>
      )}
    </div>
  );
}
