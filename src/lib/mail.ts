import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma, type DbClient } from "./db";

/**
 * Outbound email.
 *
 * Notifications are written to the database first and mailed from an outbox, so
 * a transport that is down delays delivery rather than losing it, and every
 * attempt is inspectable afterwards. Nothing here pretends to have sent
 * something it did not: the logger transport says plainly that it wrote a file.
 *
 * Configure with:
 *   MAIL_TRANSPORT   logger (default) | http | none
 *   MAIL_FROM        "ProcurementOS <procurement@example.com>"
 *   MAIL_ENDPOINT    HTTPS endpoint for the http transport
 *   MAIL_TOKEN       bearer token for that endpoint
 *   MAIL_SPOOL_DIR   where the logger transport writes (default ./storage/mail)
 */

export type OutgoingEmail = {
  toAddress: string;
  toName?: string | null;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
};

export type SendResult = { ok: true; providerId?: string | null } | { ok: false; error: string };

export type MailTransport = {
  readonly name: string;
  /** True when the transport is configured well enough to attempt a send. */
  ready(): boolean;
  send(email: OutgoingEmail): Promise<SendResult>;
};

const FROM = process.env.MAIL_FROM ?? "ProcurementOS <no-reply@procurementos.local>";

/**
 * Writes each message to a spool directory. This is the default because a
 * development or staging install has no business sending real mail, and a file
 * you can open is more useful than a silent no-op.
 */
export const loggerTransport: MailTransport = {
  name: "logger",
  ready: () => true,
  async send(email) {
    const dir = path.resolve(process.env.MAIL_SPOOL_DIR ?? "./storage/mail");
    try {
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safe = email.toAddress.replace(/[^\w.@-]/g, "_");
      const file = path.join(dir, `${stamp}-${safe}.eml`);
      const lines = [
        `From: ${FROM}`,
        `To: ${email.toName ? `${email.toName} <${email.toAddress}>` : email.toAddress}`,
        `Subject: ${email.subject}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        email.bodyText,
      ];
      await writeFile(file, lines.join("\r\n"), "utf8");
      return { ok: true, providerId: path.relative(process.cwd(), file) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};

/**
 * Posts to an HTTPS mail API — the shape most providers accept (Resend, Postmark
 * with a shim, or an internal relay). No SDK, so there is nothing to install and
 * nothing to keep in step.
 */
export const httpTransport: MailTransport = {
  name: "http",
  ready: () => Boolean(process.env.MAIL_ENDPOINT),
  async send(email) {
    const endpoint = process.env.MAIL_ENDPOINT;
    if (!endpoint) return { ok: false, error: "MAIL_ENDPOINT is not set." };
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.MAIL_TOKEN ? { authorization: `Bearer ${process.env.MAIL_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          from: FROM,
          to: [email.toAddress],
          subject: email.subject,
          text: email.bodyText,
          ...(email.bodyHtml ? { html: email.bodyHtml } : {}),
        }),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        return { ok: false, error: `HTTP ${res.status} from the mail endpoint: ${detail}` };
      }
      const json = (await res.json().catch(() => ({}))) as { id?: string; MessageID?: string };
      return { ok: true, providerId: json.id ?? json.MessageID ?? null };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};

/**
 * Delivery switched off. Reporting itself as not ready means the flush leaves
 * messages queued instead of marking them failed — the outbox is then a true record
 * of what is waiting for a transport, which is what the admin screen says.
 */
export const nullTransport: MailTransport = {
  name: "none",
  ready: () => false,
  async send() {
    return { ok: false, error: "Mail delivery is disabled (MAIL_TRANSPORT=none)." };
  },
};

export function activeTransport(): MailTransport {
  switch ((process.env.MAIL_TRANSPORT ?? "logger").toLowerCase()) {
    case "http":
      return httpTransport;
    case "none":
      return nullTransport;
    default:
      return loggerTransport;
  }
}

/* ── Queueing ─────────────────────────────────────────────── */

export type QueueInput = OutgoingEmail & {
  category?: "APPROVAL" | "REMINDER" | "EXCEPTION" | "DIGEST" | "GENERAL";
  userId?: string | null;
  notificationId?: string | null;
  linkUrl?: string | null;
  entityId?: string | null;
};

export async function queueEmail(input: QueueInput, db: DbClient = prisma) {
  return db.emailMessage.create({
    data: {
      toAddress: input.toAddress,
      toName: input.toName ?? null,
      subject: input.subject,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml ?? null,
      category: input.category ?? "GENERAL",
      userId: input.userId ?? null,
      notificationId: input.notificationId ?? null,
      linkUrl: input.linkUrl ?? null,
      entityId: input.entityId ?? null,
    },
  });
}

const APP_URL = process.env.APP_URL ?? "http://localhost:3737";

/** Plain-text body for a notification. Deliberately short: the app is the record. */
export function renderNotificationEmail(input: {
  recipientName: string;
  title: string;
  body?: string | null;
  linkUrl?: string | null;
  priority?: string;
}) {
  const lines = [
    `${input.recipientName},`,
    "",
    input.title,
    ...(input.body ? ["", input.body] : []),
    ...(input.linkUrl ? ["", `Open it in ProcurementOS: ${APP_URL}${input.linkUrl}`] : []),
    "",
    "You are receiving this because email notifications are switched on for your account.",
    "Turn them off under Settings in ProcurementOS.",
  ];
  return lines.join("\n");
}

/* ── Delivery ─────────────────────────────────────────────── */

export type FlushResult = {
  transport: string;
  attempted: number;
  sent: number;
  failed: number;
  errors: string[];
};

const MAX_ATTEMPTS = 5;

/**
 * Sends what is queued. Safe to call repeatedly: a message is claimed before the
 * transport is touched, and a failure is recorded with its attempt count so a
 * permanently broken address stops being retried.
 */
export async function flushOutbox(limit = 50, db: DbClient = prisma): Promise<FlushResult> {
  const transport = activeTransport();
  const result: FlushResult = { transport: transport.name, attempted: 0, sent: 0, failed: 0, errors: [] };

  if (!transport.ready()) {
    result.errors.push(`Transport "${transport.name}" is not configured.`);
    return result;
  }

  const queued = await db.emailMessage.findMany({
    where: { status: { in: ["QUEUED", "FAILED"] }, attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { queuedAt: "asc" },
    take: limit,
  });

  for (const message of queued) {
    // Claim it first, so two concurrent flushes cannot both send the same mail.
    const claimed = await db.emailMessage.updateMany({
      where: { id: message.id, status: message.status },
      data: { status: "SENDING", attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue;
    result.attempted += 1;

    const outcome = await transport.send({
      toAddress: message.toAddress,
      toName: message.toName,
      subject: message.subject,
      bodyText: message.bodyText,
      bodyHtml: message.bodyHtml,
    });

    if (outcome.ok) {
      await db.emailMessage.update({
        where: { id: message.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          transport: transport.name,
          providerId: outcome.providerId ?? null,
          lastError: null,
        },
      });
      result.sent += 1;
    } else {
      await db.emailMessage.update({
        where: { id: message.id },
        data: { status: "FAILED", failedAt: new Date(), transport: transport.name, lastError: outcome.error },
      });
      result.failed += 1;
      if (!result.errors.includes(outcome.error)) result.errors.push(outcome.error);
    }
  }

  return result;
}

/** Counts for the administration screen. */
export async function outboxSummary(db: DbClient = prisma) {
  const rows = await db.emailMessage.groupBy({ by: ["status"], _count: { _all: true } });
  const by = (status: string) => rows.find((r) => r.status === status)?._count._all ?? 0;
  return {
    queued: by("QUEUED"),
    sending: by("SENDING"),
    sent: by("SENT"),
    failed: by("FAILED"),
    suppressed: by("SUPPRESSED"),
    transport: activeTransport().name,
  };
}
