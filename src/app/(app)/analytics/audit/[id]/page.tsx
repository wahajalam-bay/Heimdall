import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { FieldDiff, changedFieldCount } from "@/components/domain/FieldDiff";
import {
  Badge,
  DefList,
  InlineAlert,
  Mono,
  PageHeader,
  SectionCard,
  UserChip,
} from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { fmtDateTime, relativeTime } from "@/lib/format";

export const metadata = { title: "Audit event" };
export const dynamic = "force-dynamic";

/** Links a log row back to the record it describes, where we can. */
const RECORD_ROUTES: Record<string, string> = {
  PurchaseRequisition: "/pr",
  PurchaseOrder: "/po",
  Rfq: "/rfq",
  Comparative: "/comparatives",
  CpcCase: "/cpc/cases",
  CpcMeeting: "/cpc/meetings",
  Grn: "/grn",
  Delivery: "/receiving",
  GatePass: "/gate-passes",
  Inspection: "/inspections",
  Invoice: "/invoices",
  PaymentHandoff: "/finance/handoffs",
  PettyCashRequest: "/petty-cash",
  Vendor: "/vendors",
  VendorIssue: "/vendors/issues",
  VendorBlacklistCase: "/vendors/blacklist",
  Asset: "/assets",
  DisposalCase: "/disposal",
  StoreIssue: "/issuance",
  StoreTransfer: "/transfers",
  Exception: "/analytics/exceptions",
};

/** Parses a stored JSON snapshot, tolerating rows written as plain strings. */
function parseSnapshot(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toChangeSet(raw: string | null): Record<string, { from: unknown; to: unknown }> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, { from: unknown; to: unknown }>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Derives a change set from a pair of snapshots, for events that recorded the
 * whole before and after rather than a field list — a creation, say. Without
 * this those events would show nothing where the interesting part is.
 */
function diffSnapshots(before: unknown, after: unknown) {
  const isRec = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isRec(before) && !isRec(after)) return null;
  const a = isRec(before) ? before : {};
  const b = isRec(after) ? after : {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  if (!keys.length) return null;
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) out[k] = { from: a[k] ?? null, to: b[k] ?? null };
  return out;
}

export default async function AuditEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { authorized } = await pageContext(P.AUDIT_VIEW);
  if (!authorized) {
    return <AccessDenied title="Audit event" message="You do not have permission to read the audit trail." />;
  }

  const log = await prisma.auditLog.findUnique({
    where: { id },
    include: { actor: { select: { id: true, name: true, title: true, email: true } } },
  });
  if (!log) notFound();

  const changes = toChangeSet(log.changes);
  const before = parseSnapshot(log.oldValue);
  const after = parseSnapshot(log.newValue);
  const derived = changes ?? diffSnapshots(before, after);
  const changedCount = changedFieldCount(derived);

  const recordBase = RECORD_ROUTES[log.entityType];
  const recordHref = recordBase ? `${recordBase}/${log.entityId}` : null;

  // The rest of the story: what else happened to this record, and to this case.
  const [recordHistory, caseHistory] = await Promise.all([
    prisma.auditLog.findMany({
      where: { entityType: log.entityType, entityId: log.entityId, id: { not: log.id } },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    log.caseKey
      ? prisma.auditLog.findMany({
          where: { caseKey: log.caseKey, id: { not: log.id } },
          orderBy: { createdAt: "desc" },
          take: 25,
        })
      : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Analytics", href: "/analytics" },
          { label: "Audit trail", href: "/analytics/audit" },
          { label: humanize(log.action) },
        ]}
      />

      <PageHeader
        eyebrow="Audit event"
        title={humanize(log.action)}
        subtitle={
          changedCount
            ? `${changedCount} field${changedCount === 1 ? "" : "s"} changed on ${log.entityType} ${log.entityRef ?? log.entityId}.`
            : `Recorded against ${log.entityType} ${log.entityRef ?? log.entityId}.`
        }
        actions={
          recordHref && (
            <Link href={recordHref} className="btn btn-secondary btn-sm">
              Open the record
            </Link>
          )
        }
        meta={
          <>
            <span className="text-xs text-[var(--c-text-secondary)]">{fmtDateTime(log.createdAt)}</span>
            <span className="text-xs text-[var(--c-text-tertiary)]">{relativeTime(log.createdAt)}</span>
            {log.caseKey && (
              <Link href={`/analytics/audit?q=${encodeURIComponent(log.caseKey)}`} className="text-xs">
                <Mono>{log.caseKey}</Mono>
              </Link>
            )}
          </>
        }
      />

      {log.reason && (
        <InlineAlert tone="info">
          <span className="font-500">Reason given:</span> {log.reason}
        </InlineAlert>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <SectionCard
          title="What changed"
          description={
            changes
              ? "Field-level record written at the time of the change."
              : "Derived by comparing the before and after snapshots this event stored."
          }
          bodyClassName="px-0 py-0"
        >
          <FieldDiff
            changes={derived}
            emptyLabel="This event recorded no field values — it marks that the action happened."
          />
        </SectionCard>

        <div className="space-y-4">
          <SectionCard title="Who and where">
            <DefList
              items={[
                {
                  label: "Actor",
                  value: log.actor ? (
                    <UserChip name={log.actor.name} sub={log.actor.title ?? log.actor.email} />
                  ) : (
                    <span>{log.actorName ?? "System"}</span>
                  ),
                },
                { label: "Acting as", value: log.actorRoles ?? "Automated" },
                { label: "When", value: fmtDateTime(log.createdAt) },
                { label: "IP address", value: log.ip ? <Mono>{log.ip}</Mono> : "—" },
                {
                  label: "Client",
                  value: log.userAgent ? (
                    <span className="block max-w-[16rem] truncate text-2xs" title={log.userAgent}>
                      {log.userAgent}
                    </span>
                  ) : (
                    "—"
                  ),
                },
              ]}
            />
          </SectionCard>

          <SectionCard title="Record">
            <DefList
              items={[
                { label: "Type", value: humanize(log.entityType) },
                {
                  label: "Reference",
                  value: recordHref ? (
                    <Link href={recordHref}>
                      <Mono>{log.entityRef ?? log.entityId}</Mono>
                    </Link>
                  ) : (
                    <Mono>{log.entityRef ?? log.entityId}</Mono>
                  ),
                },
                { label: "Identifier", value: <Mono>{log.entityId}</Mono> },
                { label: "Event id", value: <Mono>{log.id}</Mono> },
              ]}
            />
          </SectionCard>
        </div>
      </div>

      {(recordHistory.length > 0 || caseHistory.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard
            title="Everything else on this record"
            description={`${recordHistory.length} other event${recordHistory.length === 1 ? "" : "s"}.`}
            bodyClassName="px-0 py-0"
          >
            <HistoryList rows={recordHistory} />
          </SectionCard>
          {log.caseKey && (
            <SectionCard
              title={`Everything else on ${log.caseKey}`}
              description={`${caseHistory.length} other event${caseHistory.length === 1 ? "" : "s"} across the case.`}
              bodyClassName="px-0 py-0"
            >
              <HistoryList rows={caseHistory} />
            </SectionCard>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryList({
  rows,
}: {
  rows: Array<{
    id: string;
    action: string;
    actorName: string | null;
    createdAt: Date;
    entityRef: string | null;
    changes: string | null;
  }>;
}) {
  if (!rows.length) {
    return <p className="px-4 py-6 text-center text-xs text-[var(--c-text-secondary)]">Nothing else recorded.</p>;
  }
  return (
    <ul className="divide-y divide-[var(--c-border-subtle)]">
      {rows.map((r) => {
        const count = changedFieldCount(toChangeSet(r.changes));
        return (
          <li key={r.id} className="flex items-baseline justify-between gap-3 px-4 py-2">
            <Link href={`/analytics/audit/${r.id}`} className="min-w-0 flex-1 truncate text-xs">
              {humanize(r.action)}
              {r.entityRef && (
                <span className="ml-1.5 text-2xs text-[var(--c-text-tertiary)]">{r.entityRef}</span>
              )}
            </Link>
            {count > 0 && (
              <Badge tone="neutral">
                {count} field{count === 1 ? "" : "s"}
              </Badge>
            )}
            <span className="shrink-0 text-2xs text-[var(--c-text-tertiary)]">{relativeTime(r.createdAt)}</span>
          </li>
        );
      })}
    </ul>
  );
}
