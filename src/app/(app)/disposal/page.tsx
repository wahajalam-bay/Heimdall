import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import {
  Badge,
  EmptyState,
  InlineAlert,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { DISPOSAL_LIFECYCLE, humanize } from "@/lib/domain";
import { ageDays, fmtDate, money, percent, round2 } from "@/lib/format";

export const metadata = { title: "Disposal" };
export const dynamic = "force-dynamic";

export default async function DisposalPage() {
  const { user, ctx, authorized } = await pageContext(P.DISPOSAL_VIEW);
  if (!authorized) {
    return <AccessDenied title="Disposal" message="You do not have permission to view disposal cases." />;
  }

  const [cases, savedViews] = await Promise.all([
    prisma.disposalCase.findMany({
      where: ctx.entityFilter,
      orderBy: { raisedAt: "desc" },
      take: 400,
      include: {
        entity: { select: { code: true } },
        raisedBy: { select: { name: true } },
        items: { select: { id: true, bookValue: true, estimatedValue: true, realisedValue: true, condition: true } },
        bids: { select: { id: true, amount: true, status: true, bidderName: true } },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "disposal", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
  ]);

  const canCreate = userHasPermission(user, P.DISPOSAL_CREATE);
  const open = cases.filter((c) => !["COMPLETED", "REJECTED", "CANCELLED"].includes(c.stage));
  const completed = cases.filter((c) => c.stage === "COMPLETED");
  const awaitingAudit = cases.filter((c) => c.stage === "AUDIT_REVIEW");
  const realised = round2(completed.reduce((a, c) => a + (c.realisedValue ?? 0), 0));

  const stageCounts = DISPOSAL_LIFECYCLE.map((s) => ({ stage: s, count: cases.filter((c) => c.stage === s).length }));

  const columns: TableColumn[] = [
    { key: "number", header: "Case", locked: true, sortable: true, width: "10rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "title", header: "Case", sortable: true, minWidth: "20rem" },
    { key: "category", header: "Category", filterable: true, sortable: true, width: "13rem" },
    { key: "stage", header: "Stage", filterable: true, sortable: true, width: "13rem" },
    { key: "recommended", header: "Recommended", filterable: true, sortable: true, width: "10rem" },
    { key: "final", header: "Final action", filterable: true, sortable: true, width: "10rem" },
    { key: "items", header: "Items", numeric: true, sortable: true, width: "6.5rem" },
    { key: "bookValue", header: "Book value", numeric: true, sortable: true, width: "11rem" },
    { key: "estimated", header: "Estimated", numeric: true, sortable: true, width: "11rem" },
    { key: "bids", header: "Bids", numeric: true, sortable: true, width: "6.5rem" },
    { key: "highestBid", header: "Highest bid", numeric: true, sortable: true, width: "11rem" },
    { key: "realised", header: "Realised", numeric: true, sortable: true, width: "11rem" },
    { key: "recovery", header: "Recovery", numeric: true, sortable: true, width: "9rem" },
    { key: "bidding", header: "Bidding required", filterable: true, sortable: true, width: "10rem" },
    { key: "raisedBy", header: "Raised by", sortable: true, width: "12rem" },
    { key: "raised", header: "Raised", sortable: true, width: "9rem" },
    { key: "age", header: "Age (days)", numeric: true, sortable: true, width: "8rem" },
  ];

  const rows: TableRow[] = cases.map((c) => {
    const bookValue = round2(c.items.reduce((a, i) => a + (i.bookValue ?? 0), 0));
    const estimated = c.estimatedValue ?? round2(c.items.reduce((a, i) => a + (i.estimatedValue ?? 0), 0));
    const highest = c.bids.length ? Math.max(...c.bids.map((b) => b.amount)) : 0;
    const isOpen = !["COMPLETED", "REJECTED", "CANCELLED"].includes(c.stage);
    const age = ageDays(c.raisedAt) ?? 0;
    const recovery = bookValue > 0 && c.realisedValue ? round2((c.realisedValue / bookValue) * 100) : null;
    return {
      id: c.id,
      href: `/disposal/${c.id}`,
      flag:
        c.stage === "REJECTED"
          ? "danger"
          : isOpen && age > 30
            ? "warning"
            : c.stage === "COMPLETED"
              ? "success"
              : null,
      search: `${c.number} ${c.title} ${c.disposalCategory} ${c.bids.map((b) => b.bidderName).join(" ")}`,
      values: {
        number: c.number,
        entity: c.entity.code,
        title: c.title,
        category: humanize(c.disposalCategory),
        stage: humanize(c.stage),
        recommended: c.recommendedAction ? humanize(c.recommendedAction) : "",
        final: c.finalAction ? humanize(c.finalAction) : "",
        items: c.items.length,
        bookValue,
        estimated,
        bids: c.bids.length,
        highestBid: highest,
        realised: c.realisedValue ?? 0,
        recovery: recovery ?? 0,
        bidding: c.biddingRequired ? "Yes" : "No",
        raisedBy: c.raisedBy.name,
        raised: c.raisedAt.toISOString(),
        age,
      },
      cells: {
        number: <RefLink href={`/disposal/${c.id}`}>{c.number}</RefLink>,
        entity: <Badge tone="neutral">{c.entity.code}</Badge>,
        title: (
          <span className="block max-w-[28rem] truncate" title={c.title}>
            {c.title}
          </span>
        ),
        category: humanize(c.disposalCategory),
        stage: <StatusBadge status={c.stage} />,
        recommended: c.recommendedAction ? humanize(c.recommendedAction) : "—",
        final: c.finalAction ? <Badge tone="info">{humanize(c.finalAction)}</Badge> : "—",
        items: c.items.length,
        bookValue: bookValue > 0 ? <Mono>{money(bookValue)}</Mono> : "—",
        estimated: estimated > 0 ? <Mono>{money(estimated)}</Mono> : "—",
        bids: c.bids.length === 0 ? (c.biddingRequired ? <Badge tone="warning">None</Badge> : "—") : c.bids.length,
        highestBid: highest > 0 ? <Mono>{money(highest)}</Mono> : "—",
        realised: c.realisedValue ? <Mono>{money(c.realisedValue)}</Mono> : "—",
        recovery:
          recovery === null ? (
            "—"
          ) : (
            <Badge tone={recovery >= 50 ? "success" : recovery >= 20 ? "warning" : "danger"}>
              {percent(recovery, 0)}
            </Badge>
          ),
        bidding: c.biddingRequired ? <Badge tone="info">Required</Badge> : <Badge tone="neutral">No</Badge>,
        raisedBy: c.raisedBy.name,
        raised: fmtDate(c.raisedAt),
        age: isOpen ? age : "—",
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Assets"
        title="Disposal cases"
        subtitle="Assessment, audit review, approval and — above the configured threshold — competitive bidding, before anything leaves the business."
        actions={
          <>
            <Link href="/disposal/scrap" className="btn btn-secondary btn-sm">
              Scrap and waste
            </Link>
            <Link href="/assets" className="btn btn-secondary btn-sm">
              Asset register
            </Link>
            {canCreate && (
              <Link href="/disposal/new" className="btn btn-primary btn-sm">
                Raise disposal
              </Link>
            )}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Open cases" value={open.length} tone={open.length ? "warning" : "default"} />
        <StatTile label="Awaiting audit review" value={awaitingAudit.length} tone={awaitingAudit.length ? "accent" : "default"} />
        <StatTile label="Completed" value={completed.length} tone="success" />
        <StatTile label="Value realised" value={money(realised)} hint="From completed disposals" />
      </div>

      {open.length > 0 && (
        <SectionCard title="Where open cases sit" description="Stage distribution across live disposal cases.">
          <div className="flex flex-wrap gap-2">
            {stageCounts
              .filter((s) => s.count > 0)
              .map((s) => (
                <span
                  key={s.stage}
                  className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs"
                >
                  <StatusBadge status={s.stage} />
                  <span className="tnum font-600">{s.count}</span>
                </span>
              ))}
          </div>
        </SectionCard>
      )}

      {cases.some((c) => c.biddingRequired && c.bids.length === 0 && ["APPROVED", "BIDDING"].includes(c.stage)) && (
        <InlineAlert tone="warning">
          Some approved cases require competitive bidding but have no bids recorded. They cannot progress to management
          approval until bids exist.
        </InlineAlert>
      )}

      <DataTable
        id="disposal"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "raised", dir: "desc" }}
        exportName="disposal-cases"
        emptyState={
          <EmptyState
            title="No disposal cases"
            description="Raise a case for idle assets, obsolete equipment, construction scrap or waste. Nothing is written off without the governed route."
            action={
              canCreate && (
                <Link href="/disposal/new" className="btn btn-primary btn-sm">
                  Raise disposal
                </Link>
              )
            }
          />
        }
      />
    </div>
  );
}
