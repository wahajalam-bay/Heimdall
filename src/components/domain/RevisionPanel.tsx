import { Badge, InlineAlert, Mono, SectionCard } from "@/components/ui/primitives";
import { fmtDateTime } from "@/lib/format";
import { revisionHistory, approvalCoversCurrent } from "@/server/revisions";

/**
 * Version history, and whether the standing approval still covers the document.
 *
 * The second question is the one that matters and the one nothing could answer
 * before. A requisition showing "approved" while sitting two amendments past the
 * version that was approved is not approved in any useful sense, and the banner
 * says so rather than letting the status badge imply otherwise.
 */
export async function RevisionPanel({
  documentType,
  documentId,
  showCoverage = false,
}: {
  documentType: "PR" | "RFQ";
  documentId: string;
  /** PR only — an RFQ has no approval to cover. */
  showCoverage?: boolean;
}) {
  const [history, coverage] = await Promise.all([
    revisionHistory(documentType, documentId),
    showCoverage ? approvalCoversCurrent(documentId).catch(() => null) : Promise.resolve(null),
  ]);

  if (history.length === 0 && !coverage?.note) return null;

  return (
    <div className="space-y-3">
      {coverage?.note && (
        <InlineAlert tone="warning">
          <span className="font-600">The approval on file does not cover this version. </span>
          {coverage.note} It has to be approved again before it can go any further.
        </InlineAlert>
      )}

      {history.length > 0 && (
        <SectionCard
          title={`Versions (${history.length})`}
          description="Each submission is snapshotted, so a past version can be read on its own rather than reconstructed from a diff. The hash is of the snapshot, and matches the one an approver signed."
          bodyClassName="px-0 py-0"
        >
          <ul className="row-list">
            {history.map((r) => (
              <li key={r.version} className="px-3.5 py-2.5">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-xs font-600">Version {r.version}</span>
                  {r.isCurrent && <Badge tone="progress">current</Badge>}
                  {coverage?.approvedVersion === r.version && <Badge tone="success">approved</Badge>}
                  <span className="text-2xs text-[var(--c-text-tertiary)]">
                    {r.createdByName} · {fmtDateTime(r.createdAt)}
                  </span>
                </div>
                {r.amendmentReason && (
                  <p className="mt-1 text-2xs leading-4">
                    <span className="text-[var(--c-text-tertiary)]">Amended because: </span>
                    {r.amendmentReason}
                  </p>
                )}
                {r.changeSummary && (
                  <p className="mt-0.5 text-2xs leading-4 text-muted">{r.changeSummary}</p>
                )}
                <Mono className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                  {r.contentHash.slice(0, 16)}…
                </Mono>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}
