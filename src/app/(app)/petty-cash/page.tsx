import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, visibleEntityIds } from "@/lib/rbac";
import { pettyCashStoreEntryGap } from "@/server/pettycash";
import { AccessDenied } from "@/components/ui/guard";
import { DataTable, type TableColumn, type TableRow } from "@/components/ui/DataTable";
import {
  Badge,
  EmptyState,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { ageDays, fmtDate, money, round2 } from "@/lib/format";
import { statusLink, tableLink } from "@/lib/links";

export const metadata = { title: "Petty Cash" };
export const dynamic = "force-dynamic";

const OPEN_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_EVALUATION",
  "QUOTES_PENDING",
  "QUOTES_COMPARED",
  "PENDING_APPROVAL",
  "APPROVED",
  "PURCHASED",
  "RECEIPT_UPLOADED",
  "VOUCHER_GENERATED",
  "VOUCHER_APPROVED",
  "STORE_ENTRY_PENDING",
  "STORE_ENTRY_DONE",
  "RECONCILED",
];

export default async function PettyCashPage() {
  const { user, ctx, authorized } = await pageContext(P.PETTY_CASH_VIEW);
  if (!authorized) {
    return <AccessDenied title="Petty cash" message="You do not have permission to view petty cash requests." />;
  }

  const [requests, savedViews, gap] = await Promise.all([
    prisma.pettyCashRequest.findMany({
      where: ctx.entityFilter,
      orderBy: { createdAt: "desc" },
      take: 400,
      include: {
        entity: { select: { code: true } },
        department: { select: { name: true } },
        requester: { select: { name: true } },
        items: { select: { id: true, disposition: true, storeEntered: true, lineTotal: true } },
        quotes: { select: { id: true, isSelected: true, vendorName: true, amount: true } },
        vouchers: { select: { id: true, number: true, status: true } },
      },
    }),
    prisma.savedView.findMany({
      where: { resource: "petty-cash", OR: [{ userId: user.id }, { isShared: true }] },
      select: { id: true, name: true, config: true, isShared: true },
    }),
    pettyCashStoreEntryGap(visibleEntityIds(user)),
  ]);

  const canCreate = userHasPermission(user, P.PETTY_CASH_CREATE);

  const stats = {
    open: requests.filter((r) => OPEN_STATUSES.includes(r.status) && r.status !== "RECONCILED").length,
    awaitingApproval: requests.filter((r) => r.status === "PENDING_APPROVAL").length,
    storeGap: gap.length,
    spentOpen: round2(
      requests
        .filter((r) => OPEN_STATUSES.includes(r.status))
        .reduce((a, r) => a + (r.actualAmount ?? r.approvedAmount ?? r.estimatedAmount), 0),
    ),
  };

  const columns: TableColumn[] = [
    { key: "number", header: "Request", locked: true, sortable: true, width: "10rem" },
    { key: "entity", header: "Entity", filterable: true, sortable: true, width: "5rem" },
    { key: "department", header: "Department", filterable: true, sortable: true, width: "13rem" },
    { key: "purpose", header: "Purpose", sortable: true, minWidth: "20rem" },
    { key: "estimated", header: "Estimated", numeric: true, sortable: true, width: "9rem" },
    { key: "approved", header: "Approved", numeric: true, sortable: true, width: "9rem" },
    { key: "actual", header: "Actual", numeric: true, sortable: true, width: "9rem" },
    { key: "quotes", header: "Quotes", numeric: true, sortable: true, width: "6.5rem" },
    { key: "vendor", header: "Selected vendor", sortable: true, width: "13rem" },
    { key: "status", header: "Status", filterable: true, sortable: true, width: "12rem" },
    { key: "storeEntry", header: "Store entry", filterable: true, sortable: true, width: "10rem" },
    { key: "voucher", header: "Voucher", sortable: true, width: "10rem" },
    { key: "requester", header: "Requested by", sortable: true, width: "12rem" },
    { key: "raised", header: "Raised", sortable: true, width: "8.5rem" },
    { key: "age", header: "Age (days)", numeric: true, sortable: true, width: "7.5rem", defaultHidden: true },
    // "Store entry" counts the lines still outstanding, so its values differ per
    // row and nothing could filter on them. This says only whether a gap exists,
    // which is what the tile above is counting.
    { key: "storeGapState", header: "Store gap", filterable: true, sortable: true, width: "10rem", defaultHidden: true },
  ];

  const rows: TableRow[] = requests.map((r) => {
    const selected = r.quotes.find((q) => q.isSelected);
    const voucher = r.vouchers[r.vouchers.length - 1];
    const storeLines = r.items.filter((i) => ["INVENTORY", "ASSET", "PROJECT_MATERIAL"].includes(i.disposition));
    const storePending = storeLines.filter((i) => !i.storeEntered).length;
    const storeEntry = !r.storeRequired
      ? "Not required"
      : storePending === 0
        ? "Complete"
        : `${storePending} pending`;
    const blocked = r.storeRequired && storePending > 0 && !["DRAFT", "SUBMITTED", "REJECTED", "CANCELLED"].includes(r.status);
    return {
      id: r.id,
      href: `/petty-cash/${r.id}`,
      flag: blocked ? "danger" : r.status === "CLOSED" ? "success" : r.status === "PENDING_APPROVAL" ? "warning" : null,
      search: `${r.number} ${r.purpose} ${r.department.name} ${selected?.vendorName ?? ""}`,
      values: {
        storeGapState: !r.storeRequired ? "Not required" : storePending > 0 ? "Outstanding" : "Complete",
        number: r.number,
        entity: r.entity.code,
        department: r.department.name,
        purpose: r.purpose,
        estimated: r.estimatedAmount,
        approved: r.approvedAmount ?? 0,
        actual: r.actualAmount ?? 0,
        quotes: r.quotes.length,
        vendor: selected?.vendorName ?? r.purchasedFromVendor ?? "",
        status: humanize(r.status),
        storeEntry,
        voucher: voucher?.number ?? "",
        requester: r.requester.name,
        raised: r.createdAt.toISOString(),
        age: ageDays(r.createdAt) ?? 0,
      },
      cells: {
        storeGapState:
          !r.storeRequired ? (
            <span className="text-[var(--c-text-tertiary)]">Not required</span>
          ) : storePending > 0 ? (
            <Badge tone="danger">Outstanding</Badge>
          ) : (
            <span className="text-[var(--c-text-tertiary)]">Complete</span>
          ),
        number: <RefLink href={`/petty-cash/${r.id}`}>{r.number}</RefLink>,
        entity: <Badge tone="neutral">{r.entity.code}</Badge>,
        department: r.department.name,
        purpose: (
          <span className="block max-w-[28rem] truncate" title={r.purpose}>
            {r.purpose}
          </span>
        ),
        estimated: <Mono>{money(r.estimatedAmount)}</Mono>,
        approved: r.approvedAmount ? <Mono>{money(r.approvedAmount)}</Mono> : "—",
        actual: r.actualAmount ? <Mono>{money(r.actualAmount)}</Mono> : "—",
        quotes: r.quotes.length,
        vendor: selected?.vendorName ?? r.purchasedFromVendor ?? "—",
        status: <StatusBadge status={r.status} />,
        storeEntry: !r.storeRequired ? (
          <span className="text-2xs text-[var(--c-text-tertiary)]">Not required</span>
        ) : storePending === 0 ? (
          <Badge tone="success">Complete</Badge>
        ) : (
          <Badge tone="danger">{storePending} pending</Badge>
        ),
        voucher: voucher ? (
          <span className="flex items-center gap-1.5">
            <Mono>{voucher.number}</Mono>
            <StatusBadge status={voucher.status} />
          </span>
        ) : (
          "—"
        ),
        requester: r.requester.name,
        raised: fmtDate(r.createdAt),
        age: ageDays(r.createdAt) ?? 0,
      },
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Procurement"
        title="Petty cash"
        subtitle="Small cash purchases with the full control chain: market quotes, approval, receipt, voucher signature, store entry and reconciliation."
        actions={
          canCreate && (
            <Link href="/petty-cash/new" className="btn btn-primary btn-sm">
              Raise petty cash request
            </Link>
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Open requests"
          value={stats.open}
          href={statusLink("/petty-cash", "status", OPEN_STATUSES.filter((st) => st !== "RECONCILED"))}
        />
        <StatTile
          label="Awaiting approval"
          value={stats.awaitingApproval}
          tone={stats.awaitingApproval ? "warning" : "default"}
          href={statusLink("/petty-cash", "status", ["PENDING_APPROVAL"])}
        />
        <StatTile
          label="Missing store entry"
          value={stats.storeGap}
          tone={stats.storeGap ? "danger" : "success"}
          hint="Purchased, stored, never booked into inventory"
          href={tableLink("/petty-cash", { storeGapState: "Outstanding" })}
        />
        <StatTile
          label="Cash committed on open requests"
          value={money(stats.spentOpen)}
          href={statusLink("/petty-cash", "status", OPEN_STATUSES)}
        />
      </div>

      {gap.length > 0 && (
        <SectionCard
          title="Purchased but never entered into a store"
          description="These requests bought inventory, asset or project material and the goods have not reached the ledger. Reconciliation and closure are blocked until they do."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Purpose</th>
                  <th>Department</th>
                  <th>Status</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Lines pending</th>
                  <th className="text-right">Days waiting</th>
                </tr>
              </thead>
              <tbody>
                {gap.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <RefLink href={`/petty-cash/${g.id}`}>{g.number}</RefLink>
                    </td>
                    <td className="max-w-[26rem] truncate text-xs" title={g.purpose}>
                      {g.purpose}
                    </td>
                    <td className="text-xs">{g.department}</td>
                    <td>
                      <StatusBadge status={g.status} />
                    </td>
                    <td className="num text-xs">{money(g.amount)}</td>
                    <td className="num text-xs font-600 text-[var(--c-danger)]">{g.unbooked}</td>
                    <td className="num text-xs">{ageDays(g.updatedAt) ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <DataTable
        id="petty-cash"
        columns={columns}
        rows={rows}
        savedViews={savedViews}
        defaultSort={{ key: "raised", dir: "desc" }}
        exportName="petty-cash"
        emptyState={
          <EmptyState
            title="No petty cash requests"
            description="Petty cash covers small, urgent purchases under the configured ceiling. Market quotes are still required, and stored goods must still reach inventory."
            action={
              canCreate && (
                <Link href="/petty-cash/new" className="btn btn-primary btn-sm">
                  Raise petty cash request
                </Link>
              )
            }
          />
        }
      />
    </div>
  );
}
