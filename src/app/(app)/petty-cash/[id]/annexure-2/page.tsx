import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Mono } from "@/components/ui/primitives";
import { amount, fmtDate, fmtTime, qty } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { CONFIG_KEYS, getConfigNumber } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pc = await prisma.pettyCashRequest.findUnique({
    where: { id },
    select: { number: true },
  });
  return { title: pc ? `${pc.number} — Annexure 2` : "Annexure 2" };
}

/**
 * Annexure 2 — the petty cash form.
 *
 * ZAM/PUR/SOP-01 `image15.png` sets out the route: three quotations from the open
 * market "in written form including social media", the prescribed form filled
 * with all required information, handed to the requisitioner for HOD approval,
 * then approved by the Director Procurement, and the approved form taken to
 * Accounts to collect the cash.
 *
 * So the sheet carries two distinct approvals rather than one, and the quotations
 * print their channel — a WhatsApp price and a walk-in price are both admissible
 * under §4, and the form is where that shows.
 *
 * The floor is printed from configuration rather than hard-coded. §4 routes
 * anything at or above it to the full order process, and a form for a request
 * above the floor says so on its face instead of leaving the reader to know the
 * figure.
 *
 * Deliberately plain: no navigation, no colour, no actions.
 */
export default async function Annexure2Page({ params }: { params: Promise<{ id: string }> }) {
  const { authorized } = await pageContext(P.PETTY_CASH_VIEW);
  if (!authorized) return <AccessDenied title="Annexure 2" />;

  const { id } = await params;
  const pc = await prisma.pettyCashRequest.findUnique({
    where: { id },
    include: {
      entity: { select: { id: true, name: true } },
      department: { select: { name: true } },
      requester: { select: { name: true, title: true } },
      items: { orderBy: { lineNo: "asc" }, include: { item: { select: { sku: true } } } },
      quotes: { orderBy: [{ isSelected: "desc" }, { amount: "asc" }] },
      vouchers: {
        orderBy: { preparedAt: "desc" },
        select: { id: true, number: true, status: true, preparedAt: true },
      },
    },
  });
  if (!pc) notFound();

  // The three named people on the form are stored as bare ids, so they are
  // resolved here rather than through a relation that does not exist.
  const ids = [pc.approvedById, pc.evaluatedById, pc.reconciledById].filter(
    (v): v is string => Boolean(v),
  );
  const [people, limit] = await Promise.all([
    ids.length
      ? prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, title: true },
        })
      : Promise.resolve([]),
    getConfigNumber(CONFIG_KEYS.PETTY_CASH_LIMIT, pc.entityId),
  ]);
  const byId = new Map(people.map((p) => [p.id, p]));
  const approver = pc.approvedById ? byId.get(pc.approvedById) : null;
  const evaluator = pc.evaluatedById ? byId.get(pc.evaluatedById) : null;

  const selected = pc.quotes.find((q) => q.isSelected) ?? null;
  const cheapest = pc.quotes.reduce<typeof selected>(
    (best, q) => (best === null || q.amount < best.amount ? q : best),
    null,
  );
  const aboveFloor = Number.isFinite(limit) && pc.estimatedAmount >= limit;
  const voucher = pc.vouchers[0] ?? null;

  const field = (label: string, value: React.ReactNode) => (
    <div>
      <dt className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );

  return (
    <div className="mx-auto max-w-[58rem] space-y-5 print:max-w-none">
      <div className="no-print flex items-center justify-between">
        <Link className="link text-xs" href={`/petty-cash/${pc.id}`}>
          ← Back to {pc.number}
        </Link>
        <span className="text-2xs text-[var(--c-text-tertiary)]">
          Print this page to produce the form for approval and for Accounts.
        </span>
      </div>

      <div className="card space-y-5 px-6 py-6">
        <header className="border-b border-[var(--c-border)] pb-4 text-center">
          <p className="text-2xs uppercase tracking-widest text-[var(--c-text-tertiary)]">
            {pc.entity.name} · Annexure 2
          </p>
          <h1 className="mt-1 text-base font-semibold">Petty Cash Requisition</h1>
          <Mono className="mt-1 block text-xs text-[var(--c-text-secondary)]">{pc.number}</Mono>
        </header>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-xs sm:grid-cols-4">
          {field("Document no", <Mono className="text-xs">{pc.number}</Mono>)}
          {field("Date", fmtDate(pc.createdAt))}
          {field("Department", pc.department.name)}
          {field("Requested by", pc.requester.name)}
          {field("Required by", pc.requiredDate ? fmtDate(pc.requiredDate) : "—")}
          {field("Estimated", `${pc.currency} ${amount(pc.estimatedAmount)}`)}
          {field(
            "Approved",
            pc.approvedAmount != null ? `${pc.currency} ${amount(pc.approvedAmount)}` : "—",
          )}
          {field("Status", humanize(pc.status))}
        </dl>

        <div>
          <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Purpose</p>
          <p className="mt-1 whitespace-pre-line text-xs leading-5">
            {pc.purpose}
            {pc.justification ? `\n\n${pc.justification}` : ""}
          </p>
        </div>

        {aboveFloor && (
          <p className="border border-[var(--c-warning)] px-3 py-2 text-2xs leading-4">
            This request is {pc.currency} {amount(pc.estimatedAmount)}, at or above the petty cash floor of{" "}
            {pc.currency} {amount(limit)}. §4 routes requests at that level to the purchase order process —
            the form is here as the record of what was raised, not as authority to pay cash.
          </p>
        )}

        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "3rem" }}>Sr.</th>
                <th style={{ width: "7rem" }}>Item code</th>
                <th style={{ minWidth: "16rem" }}>Description</th>
                <th style={{ width: "5rem" }} className="text-right">
                  Qty
                </th>
                <th style={{ width: "4rem" }}>UOM</th>
                <th style={{ width: "6.5rem" }} className="text-right">
                  Est. rate
                </th>
                <th style={{ width: "6.5rem" }} className="text-right">
                  Actual rate
                </th>
                <th style={{ width: "7rem" }} className="text-right">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {pc.items.map((li) => (
                <tr key={li.id}>
                  <td className="tnum">{li.lineNo}</td>
                  <td>
                    <Mono className="text-2xs">{li.item?.sku ?? "—"}</Mono>
                  </td>
                  <td className="text-xs">{li.description}</td>
                  <td className="tnum text-right">{qty(li.quantity)}</td>
                  <td className="text-2xs">{li.unit}</td>
                  <td className="tnum text-right">
                    {li.estimatedUnitPrice != null ? amount(li.estimatedUnitPrice) : "—"}
                  </td>
                  <td className="tnum text-right">
                    {li.actualUnitPrice != null ? amount(li.actualUnitPrice) : "—"}
                  </td>
                  <td className="tnum text-right">{amount(li.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* §4 asks for three open-market quotations "in written form including
            social media". The channel is printed because that is the evidence
            the clause is describing — a price on WhatsApp is admissible, and the
            form should say it came from there. */}
        <div>
          <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
            Open-market quotations
          </p>
          {pc.quotes.length === 0 ? (
            <p className="mt-1 text-2xs text-[var(--c-warning)]">
              None recorded. §4 requires three quotations from the open market before a petty cash purchase.
            </p>
          ) : (
            <div className="table-wrap mt-1.5">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ minWidth: "12rem" }}>Vendor</th>
                    <th style={{ width: "7rem" }}>Channel</th>
                    <th style={{ minWidth: "9rem" }}>Reference</th>
                    <th style={{ width: "5rem" }} className="text-right">
                      Days
                    </th>
                    <th style={{ width: "7rem" }} className="text-right">
                      Amount
                    </th>
                    <th style={{ width: "6rem" }}>Selected</th>
                  </tr>
                </thead>
                <tbody>
                  {pc.quotes.map((q) => (
                    <tr key={q.id}>
                      <td className="text-xs">{q.vendorName}</td>
                      <td className="text-2xs">{humanize(q.channel)}</td>
                      <td className="text-2xs">{q.contactRef ?? "—"}</td>
                      <td className="tnum text-right text-2xs">{q.deliveryDays ?? "—"}</td>
                      <td className="tnum text-right">
                        {amount(q.amount)}
                        {!q.taxIncluded && (
                          <span className="ml-1 text-2xs text-[var(--c-text-tertiary)]">+tax</span>
                        )}
                      </td>
                      <td className="text-2xs">{q.isSelected ? "Yes" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pc.quotes.length > 0 && pc.quotes.length < 3 && (
            <p className="mt-1 text-2xs text-[var(--c-warning)]">
              {pc.quotes.length} quotation{pc.quotes.length === 1 ? "" : "s"} on file. §4 asks for three.
            </p>
          )}
          {selected && cheapest && selected.id !== cheapest.id && (
            <p className="mt-1 text-2xs leading-4">
              The selected quotation is not the lowest — {selected.vendorName} at {amount(selected.amount)} against{" "}
              {cheapest.vendorName} at {amount(cheapest.amount)}.{" "}
              {selected.notes ? selected.notes : "No reason is recorded on the quotation."}
            </p>
          )}
        </div>

        {(pc.purchasedFromVendor || pc.receiptRef || pc.actualAmount != null) && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 border-t border-[var(--c-border)] pt-3 text-xs sm:grid-cols-4">
            {field("Purchased from", pc.purchasedFromVendor ?? "—")}
            {field("Purchased on", pc.purchasedAt ? fmtDate(pc.purchasedAt) : "—")}
            {field("Receipt reference", pc.receiptRef ?? "—")}
            {field(
              "Actual spend",
              pc.actualAmount != null ? `${pc.currency} ${amount(pc.actualAmount)}` : "—",
            )}
          </dl>
        )}

        {/* Two approvals, not one. §4 sends the form to the HOD first and then to
            the Director Procurement, and collapsing them would lose the second
            pair of eyes the route exists to add. */}
        <div className="grid gap-8 border-t border-[var(--c-border)] pt-5 sm:grid-cols-3">
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Head of Department
            </p>
            <div className="mt-7 border-b border-[var(--c-text-tertiary)]" />
            <p className="mt-1 text-xs">{evaluator?.name ?? "Name"}</p>
            <p className="text-2xs text-[var(--c-text-tertiary)]">
              {evaluator?.title ?? "Designation"} · Date
            </p>
          </div>
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Director Procurement
            </p>
            <div className="mt-7 border-b border-[var(--c-text-tertiary)]" />
            <p className="mt-1 text-xs">{approver?.name ?? "Name"}</p>
            <p className="text-2xs text-[var(--c-text-tertiary)]">
              {approver?.title ?? "Designation"}
              {pc.approvedAt ? ` · ${fmtDate(pc.approvedAt)} ${fmtTime(pc.approvedAt)}` : " · Date"}
            </p>
          </div>
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Cash received — Accounts
            </p>
            <div className="mt-7 border-b border-[var(--c-text-tertiary)]" />
            <p className="mt-1 text-xs">Name and signature</p>
            <p className="text-2xs text-[var(--c-text-tertiary)]">
              {voucher ? (
                <>
                  Voucher <Mono className="text-2xs">{voucher.number}</Mono> ·{" "}
                  {humanize(voucher.status)}
                </>
              ) : (
                "Date"
              )}
            </p>
          </div>
        </div>

        {!pc.approvedById && (
          <p className="text-2xs text-[var(--c-warning)]">
            Unapproved. §4 requires the HOD and then the Director Procurement before the form goes to Accounts, and
            neither approval is recorded — so both blocks print blank rather than being filled from the status.
          </p>
        )}
      </div>

      <p className="no-print text-2xs text-[var(--c-text-tertiary)]">
        The floor above which a request goes to the purchase order process is read from configuration for this company,
        not fixed in the page — so a change in policy changes the form rather than needing a code change.
      </p>
    </div>
  );
}
