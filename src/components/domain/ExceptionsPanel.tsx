import Link from "next/link";
import { prisma } from "@/lib/db";
import { Badge, EmptyState, SectionCard } from "@/components/ui/primitives";
import { SEVERITY_TONE, humanize, toneFor } from "@/lib/domain";
import { fmtDateTime, relativeTime } from "@/lib/format";

/** Exceptions raised against a document or a whole case. */
export async function ExceptionsPanel({
  where,
  title = "Exceptions",
  emptyLabel = "No exceptions have been raised.",
}: {
  where:
    | { documentType: string; documentId: string }
    | { caseKey: string }
    | { prId: string }
    | { poId: string }
    | { invoiceId: string };
  title?: string;
  emptyLabel?: string;
}) {
  const rows = await prisma.exception.findMany({
    where,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: { owner: { select: { name: true } }, raisedBy: { select: { name: true } } },
  });

  const open = rows.filter((r) => ["OPEN", "IN_PROGRESS"].includes(r.status));
  const blocking = open.filter((r) => r.blocking);

  return (
    <SectionCard
      title={title}
      description={
        rows.length
          ? `${open.length} open of ${rows.length} raised${blocking.length ? ` · ${blocking.length} blocking` : ""}`
          : undefined
      }
      actions={
        blocking.length > 0 && (
          <Badge tone="danger">
            {blocking.length} blocking
          </Badge>
        )
      }
      bodyClassName="px-0 py-0"
    >
      {rows.length === 0 ? (
        <EmptyState compact title="Clear" description={emptyLabel} />
      ) : (
        <ul className="row-list">
          {rows.map((e) => (
            <li key={e.id} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/analytics/exceptions/${e.id}`} className="mono text-[var(--c-accent-text)] hover:underline">
                      {e.number}
                    </Link>
                    <Badge tone={SEVERITY_TONE[e.severity] ?? "neutral"}>{humanize(e.severity)}</Badge>
                    <Badge tone={toneFor(e.status)}>{humanize(e.status)}</Badge>
                    {e.blocking && <Badge tone="danger">Blocking</Badge>}
                    <span className="text-2xs text-[var(--c-text-tertiary)]">{humanize(e.type)}</span>
                  </div>
                  <p className="mt-1 text-[0.8125rem] leading-5">{e.title}</p>
                  {e.description && (
                    <p className="mt-0.5 text-xs leading-5 text-muted">{e.description}</p>
                  )}
                  {e.resolution && (
                    <p className="mt-1 rounded-sm border-l-2 border-[var(--c-success-border)] bg-[var(--c-success-soft)] px-2 py-1 text-xs text-[var(--c-success)]">
                      {e.resolution}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right text-2xs text-[var(--c-text-tertiary)]">
                  <div>{fmtDateTime(e.createdAt)}</div>
                  {e.owner && <div className="text-muted">Owner: {e.owner.name}</div>}
                  {e.dueAt && !e.resolvedAt && (
                    <div className={e.dueAt < new Date() ? "text-[var(--c-danger)]" : undefined}>
                      Due {relativeTime(e.dueAt)}
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
