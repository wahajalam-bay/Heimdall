import Link from "next/link";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  InlineAlert,
  Mono,
  PageHeader,
  SectionCard,
  StatTile,
} from "@/components/ui/primitives";
import { fmtDate } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { controlCalendar, controlOwners } from "@/server/controls";
import { ControlActions } from "./ControlActions";

export const metadata = { title: "Control calendar" };
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info"> = {
  COMPLETED: "success",
  DUE: "warning",
  MISSED: "danger",
  WAIVED: "info",
  NOT_APPLICABLE: "info",
};

/**
 * The control calendar.
 *
 * The SOP scatters recurring obligations through its text and nothing in the
 * system knew any of them were due. Each depended on somebody remembering, which
 * is not a control.
 *
 * The most important thing on this page is a row with nothing in it. A calendar
 * that only records what was done cannot tell you what was not, and what was not
 * done is the only question worth asking of one.
 */
export default async function ControlCalendarPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { ctx, authorized } = await pageContext(P.AUDIT_VIEW, P.ANALYTICS_VIEW);
  if (!authorized) {
    return <AccessDenied title="Control calendar" message="You do not have access to the control calendar." />;
  }

  const sp = await searchParams;
  const status = first(sp.status) ?? null;

  const { rows, awaitingRollout } = await controlCalendar({ entityId: ctx.entityId, status });
  const owners = await controlOwners(
    rows.map((r) => r.ownerRoleCode).filter((x): x is string => !!x),
  );

  const missed = rows.filter((r) => r.status === "MISSED");
  const due = rows.filter((r) => r.status === "DUE");
  const completed = rows.filter((r) => r.status === "COMPLETED");
  const waived = rows.filter((r) => ["WAIVED", "NOT_APPLICABLE"].includes(r.status));
  const unowned = rows.filter((r) => !r.ownerRoleCode || (owners.get(r.ownerRoleCode) ?? 0) === 0);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Analytics", href: "/analytics" }, { label: "Controls" }]} />

      <PageHeader
        eyebrow="Governance"
        title="Control calendar"
        subtitle="The recurring obligations the SOP sets out, and whether each period's was performed. A run is created when its period opens, so a control nobody performed is a row with nothing in it."
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile
          label="Missed"
          value={missed.length}
          hint={missed.length ? "Past due with nothing recorded" : "None"}
          tone={missed.length ? "danger" : undefined}
        />
        <StatTile label="Due now" value={due.length} tone={due.length ? "warning" : undefined} />
        <StatTile label="Performed" value={completed.length} />
        <StatTile
          label="Excused"
          value={waived.length}
          hint={waived.length ? "Waived or not applicable" : "None"}
        />
      </div>

      {missed.length > 0 && (
        <InlineAlert tone="danger">
          {missed.length} control period{missed.length === 1 ? "" : "s"} passed with nothing recorded:{" "}
          {missed.slice(0, 4).map((m) => `${m.name} (${m.periodLabel})`).join(", ")}
          {missed.length > 4 ? `, and ${missed.length - 4} more` : ""}. A missed control is the finding, so it stays
          on the record rather than rolling forward.
        </InlineAlert>
      )}

      {unowned.length > 0 && (
        <InlineAlert tone="warning">
          {unowned.length} control{unowned.length === 1 ? " has" : "s have"} no active holder for the role that owns{" "}
          {unowned.length === 1 ? "it" : "them"}. A control owned by an empty office is a control nobody performs.
        </InlineAlert>
      )}

      {awaitingRollout.length > 0 && (
        <SectionCard
          title="Listed but not being run"
          description="Controls the requirements name, which the system cannot yet observe — shown rather than hidden, because a calendar that omits what it is not doing is worse than one that admits it."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: "12rem" }}>Code</th>
                  <th style={{ minWidth: "16rem" }}>Control</th>
                  <th style={{ minWidth: "18rem" }}>Where it comes from</th>
                </tr>
              </thead>
              <tbody>
                {awaitingRollout.map((a) => (
                  <tr key={a.code}>
                    <td>
                      <Mono className="text-2xs">{a.code}</Mono>
                    </td>
                    <td className="text-xs">{a.name}</td>
                    <td className="text-2xs leading-4 text-muted">{a.sourceReference ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <SectionCard title="Calendar" bodyClassName="px-0 py-0">
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ minWidth: "15rem" }}>Control</th>
                <th style={{ width: "8rem" }}>Period</th>
                <th style={{ width: "9rem" }}>Due</th>
                <th style={{ width: "10rem" }}>State</th>
                <th style={{ width: "12rem" }}>Owner</th>
                <th style={{ minWidth: "12rem" }}>Evidence</th>
                <th style={{ width: "11rem" }} className="no-print" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-[var(--c-text-tertiary)]">
                    No control periods yet. Run <Mono className="text-2xs">seed-controls</Mono> to load the SOP&rsquo;s
                    recurring obligations.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const holders = r.ownerRoleCode ? (owners.get(r.ownerRoleCode) ?? 0) : 0;
                return (
                  <tr key={r.runId}>
                    <td>
                      {r.actionUrl ? (
                        <Link className="link" href={r.actionUrl}>
                          {r.name}
                        </Link>
                      ) : (
                        r.name
                      )}
                      <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                        {r.frequencyLabel}
                        {r.sourceReference ? ` · ${r.sourceReference.slice(0, 90)}` : ""}
                      </span>
                    </td>
                    <td className="text-2xs">{r.periodLabel}</td>
                    <td className="text-2xs">
                      {fmtDate(r.dueAt)}
                      {r.overdueDays !== null && r.overdueDays > 0 && (
                        <span className="mt-0.5 block text-[var(--c-danger)]">{r.overdueDays}d late</span>
                      )}
                    </td>
                    <td>
                      <Badge tone={STATUS_TONE[r.status] ?? "info"}>{humanize(r.status)}</Badge>
                    </td>
                    <td className="text-2xs">
                      {r.ownerRoleCode ? (
                        <>
                          {r.ownerRoleCode.replace(/_/g, " ").toLowerCase()}
                          <span
                            className={
                              holders
                                ? "mt-0.5 block text-[var(--c-text-tertiary)]"
                                : "mt-0.5 block text-[var(--c-warning)]"
                            }
                          >
                            {holders ? `${holders} holder${holders === 1 ? "" : "s"}` : "nobody holds this role"}
                          </span>
                        </>
                      ) : (
                        <span className="text-[var(--c-warning)]">unassigned</span>
                      )}
                    </td>
                    <td className="text-2xs leading-4 text-muted">
                      {r.status === "COMPLETED"
                        ? [r.performedByName, r.evidenceRef].filter(Boolean).join(" · ") || "Recorded"
                        : (r.waiverReason ?? "—")}
                    </td>
                    <td className="no-print">
                      {["DUE", "MISSED"].includes(r.status) && (
                        <ControlActions runId={r.runId} name={r.name} period={r.periodLabel} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        Controls are owned by a role rather than a person, because people leave and the obligation does not — the run
        names whoever performed it. A period that passes its grace with nothing recorded is marked missed and stays
        that way: rolling it forward would erase the finding.
      </p>
    </div>
  );
}
