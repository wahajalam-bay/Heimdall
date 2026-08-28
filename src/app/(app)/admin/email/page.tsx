import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { ActionButton } from "@/components/ui/forms";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import {
  Badge,
  EmptyState,
  InlineAlert,
  Mono,
  PageHeader,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { fmtDateTime, relativeTime } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { outboxSummary } from "@/lib/mail";
import { flushMailAction, requeueMailAction } from "../actions";
import { statusLink } from "@/lib/links";

export const metadata = { title: "Email delivery" };
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "success" | "danger" | "warning" | "progress" | "neutral"> = {
  SENT: "success",
  FAILED: "danger",
  QUEUED: "progress",
  SENDING: "warning",
  SUPPRESSED: "neutral",
};

export default async function AdminEmailPage() {
  const { authorized } = await pageContext(P.CONFIG_MANAGE);
  if (!authorized) {
    return <AccessDenied title="Email delivery" message="You do not have permission to manage email delivery." />;
  }

  const [summary, messages, emailOptIn] = await Promise.all([
    outboxSummary(),
    prisma.emailMessage.findMany({
      orderBy: { queuedAt: "desc" },
      take: 300,
      include: { user: { select: { name: true, email: true } } },
    }),
    prisma.user.count({ where: { active: true, notifyEmail: true } }),
  ]);

  const columns: TableColumn[] = [
    { key: "queued", header: "Queued", locked: true, sortable: true, width: "13rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "8rem" },
    { key: "category", header: "Kind", filterable: true, sortable: true, width: "8rem" },
    { key: "to", header: "Recipient", sortable: true, minWidth: "16rem" },
    { key: "subject", header: "Subject", sortable: true, minWidth: "22rem" },
    { key: "attempts", header: "Attempts", numeric: true, sortable: true, width: "7rem" },
    { key: "transport", header: "Transport", filterable: true, sortable: true, width: "8rem" },
    { key: "sent", header: "Sent", sortable: true, width: "12rem" },
    { key: "error", header: "Last error", sortable: true, minWidth: "20rem" },
    { key: "retry", header: "", width: "7rem" },
  ];

  const rows: TableRow[] = messages.map((m) => ({
    id: m.id,
    flag: m.status === "FAILED" ? "danger" : m.status === "SENT" ? "success" : null,
    search: `${m.subject} ${m.toAddress} ${m.status} ${m.lastError ?? ""}`,
    values: {
      queued: m.queuedAt.toISOString(),
      status: humanize(m.status),
      category: humanize(m.category),
      to: m.toAddress,
      subject: m.subject,
      attempts: m.attempts,
      transport: m.transport ?? "",
      sent: m.sentAt ? m.sentAt.toISOString() : "",
      error: m.lastError ?? "",
      retry: "",
    },
    cells: {
      queued: (
        <span>
          <span className="block text-xs">{fmtDateTime(m.queuedAt)}</span>
          <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{relativeTime(m.queuedAt)}</span>
        </span>
      ),
      status: <Badge tone={STATUS_TONE[m.status] ?? "neutral"}>{humanize(m.status)}</Badge>,
      category: <Badge tone="neutral">{humanize(m.category)}</Badge>,
      to: (
        <span>
          <span className="block text-xs">{m.user?.name ?? m.toName ?? "—"}</span>
          <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{m.toAddress}</span>
        </span>
      ),
      subject: <span className="text-xs">{m.subject}</span>,
      attempts: m.attempts,
      transport: m.transport ? <Mono>{m.transport}</Mono> : "—",
      sent: m.sentAt ? fmtDateTime(m.sentAt) : "—",
      error: m.lastError ? (
        <span className="block max-w-[24rem] truncate text-2xs text-[var(--c-danger)]" title={m.lastError}>
          {m.lastError}
        </span>
      ) : (
        "—"
      ),
      retry:
        m.status === "FAILED" ? (
          <ActionButton action={requeueMailAction} label="Requeue" size="xs" payload={{ id: m.id }} />
        ) : (
          ""
        ),
    },
  }));

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Administration", href: "/admin/users" }, { label: "Email delivery" }]} />
      <PageHeader
        eyebrow="Administration"
        title="Email delivery"
        subtitle="Notifications are written in the application first and mailed from this outbox, so a transport being down delays a message rather than losing it."
        actions={
          <ActionButton
            action={flushMailAction}
            label={summary.queued ? `Send ${summary.queued} queued` : "Send queued mail"}
            tone="primary"
          />
        }
        meta={
          <span className="text-xs text-muted">
            Transport <Mono>{summary.transport}</Mono> · {emailOptIn} user
            {emailOptIn === 1 ? "" : "s"} opted into email
          </span>
        }
      />

      {summary.transport === "logger" && (
        <InlineAlert tone="info">
          The logger transport is active: messages are written to the spool directory instead of being sent. Set{" "}
          <Mono>MAIL_TRANSPORT=http</Mono> with <Mono>MAIL_ENDPOINT</Mono> and <Mono>MAIL_TOKEN</Mono> to deliver
          for real.
        </InlineAlert>
      )}
      {summary.transport === "none" && (
        <InlineAlert tone="warning">
          Mail delivery is switched off. Queued messages stay queued until a transport is configured.
        </InlineAlert>
      )}
      {summary.failed > 0 && (
        <InlineAlert tone="danger">
          {summary.failed} message{summary.failed === 1 ? "" : "s"} failed to send. Fix the cause, then requeue them —
          nothing is retried automatically after five attempts.
        </InlineAlert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="Queued"
          value={summary.queued}
          tone={summary.queued ? "warning" : "default"}
          href={statusLink("/admin/email", "status", ["QUEUED"])}
        />
        <StatTile label="Sending" value={summary.sending} href={statusLink("/admin/email", "status", ["SENDING"])} />
        <StatTile
          label="Sent"
          value={summary.sent}
          tone="success"
          href={statusLink("/admin/email", "status", ["SENT"])}
        />
        <StatTile
          label="Failed"
          value={summary.failed}
          tone={summary.failed ? "danger" : "success"}
          href={statusLink("/admin/email", "status", ["FAILED"])}
        />
        <StatTile
          label="Suppressed"
          value={summary.suppressed}
          hint="Blocked by configuration"
          href={statusLink("/admin/email", "status", ["SUPPRESSED"])}
        />
      </div>

      <DataTable
        id="email-outbox"
        columns={columns}
        rows={rows}
        defaultSort={{ key: "queued", dir: "desc" }}
        exportName="email-outbox"
        emptyState={
          <EmptyState
            title="Nothing has been queued"
            description="Email is queued when a high-priority notification or an approval reminder reaches somebody who has switched email on."
          />
        }
      />
    </div>
  );
}
