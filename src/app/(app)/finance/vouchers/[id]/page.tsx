import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { ActionButton } from "@/components/ui/forms";
import {
  Badge,
  BlockedNotice,
  DefList,
  EmptyState,
  InlineAlert,
  MetaItem,
  PageHeader,
  RefLink,
  SectionCard,
  StatusBadge,
} from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { fmtDateTime, money, relativeTime } from "@/lib/format";
import { cancelVoucherAction, signVoucherAction } from "../../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = await prisma.voucher.findUnique({ where: { id }, select: { number: true } });
  return { title: v ? `Voucher ${v.number}` : "Voucher" };
}

/**
 * One voucher, and the ladder it is climbing.
 *
 * The signatures are shown in sequence with who signed and when, because that
 * ordering is the control. The current signatory is the only one offered the
 * buttons — a ladder that can be climbed from the top is not a ladder.
 */
export default async function VoucherPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.VOUCHER_VIEW);
  if (!authorized) {
    return <AccessDenied title="Voucher" message="You do not have permission to view payment vouchers." />;
  }

  const voucher = await prisma.voucher.findUnique({
    where: { id },
    include: {
      entity: { select: { code: true, name: true } },
      preparedBy: { select: { name: true } },
      items: { orderBy: { lineNo: "asc" } },
      signatures: {
        orderBy: { sequence: "asc" },
        include: { signedBy: { select: { name: true } } },
      },
      payments: { orderBy: { handedOffAt: "desc" } },
      invoice: {
        include: {
          vendor: { select: { id: true, name: true } },
          po: { select: { id: true, number: true, total: true } },
          taxLines: true,
          grnLinks: { include: { grn: { select: { id: true, number: true } } } },
        },
      },
    },
  });
  if (!voucher) notFound();

  const step = voucher.signatures.find((s) => s.status === "PENDING");
  const canSignThis =
    voucher.status === "PENDING_SIGNATORIES" &&
    Boolean(step) &&
    (user.roleCodes.includes(step!.roleCode) || userHasPermission(user, P.VOUCHER_SIGN_ANY)) &&
    userHasPermission(user, P.VOUCHER_SIGN, P.VOUCHER_SIGN_ANY);
  const canCancel =
    userHasPermission(user, P.VOUCHER_GENERATE) && !["PAID", "CANCELLED"].includes(voucher.status);

  const signedCount = voucher.signatures.filter((s) => s.status === "APPROVED").length;

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Finance", href: "/finance/vouchers" },
          { label: "Vouchers", href: "/finance/vouchers" },
          { label: voucher.number },
        ]}
      />

      <PageHeader
        eyebrow={`${voucher.entity.code} · ${humanize(voucher.type)}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{voucher.number}</span>
            <span>{money(voucher.netAmount, voucher.currency)}</span>
          </span>
        }
        subtitle={voucher.narration ?? undefined}
        meta={
          <>
            <MetaItem label="Status">
              <StatusBadge status={voucher.status} />
            </MetaItem>
            <MetaItem label="Vendor">
              <Link href={`/vendors/${voucher.invoice.vendor.id}`} className="text-[var(--c-accent-text)]">
                {voucher.invoice.vendor.name}
              </Link>
            </MetaItem>
            <MetaItem label="Signatures">
              {signedCount} of {voucher.signatures.length}
            </MetaItem>
            <MetaItem label="Prepared">{relativeTime(voucher.preparedAt)}</MetaItem>
          </>
        }
        actions={
          <>
            {canSignThis && (
              <>
                <ActionButton
                  action={signVoucherAction}
                  payload={{ voucherId: voucher.id, approve: "true" }}
                  label={`Sign as ${humanize(step!.roleCode)}`}
                  tone="primary"
                  confirm={`Sign ${voucher.number} for ${money(voucher.netAmount, voucher.currency)}? This is signature ${step!.sequence} of ${voucher.signatures.length}.`}
                />
                <ActionButton
                  action={signVoucherAction}
                  payload={{ voucherId: voucher.id, approve: "false" }}
                  label="Refuse"
                  tone="danger-soft"
                  reasonLabel="Why is this payment being refused?"
                  reasonRequired
                />
              </>
            )}
            {canCancel && (
              <ActionButton
                action={cancelVoucherAction}
                payload={{ voucherId: voucher.id }}
                label="Cancel"
                tone="danger"
                reasonLabel="Why is this voucher being cancelled?"
                reasonRequired
                confirm="Cancel this voucher? The invoice returns to approved and a new voucher can be raised."
              />
            )}
          </>
        }
      />

      {voucher.status === "REJECTED" && (
        <BlockedNotice
          title="This payment was refused"
          reasons={[voucher.rejectReason ?? "No reason recorded."]}
        />
      )}

      {voucher.status === "APPROVED" && (
        <InlineAlert tone="success">
          Fully signed. {money(voucher.netAmount, voucher.currency)} is cleared for release to{" "}
          {voucher.invoice.vendor.name}.
        </InlineAlert>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <div className="space-y-4">
          <SectionCard
            title="Signatures"
            description="In sequence. Each rung applies above its own amount."
            bodyClassName="px-0 pb-0"
          >
            <div className="table-wrap">
              <table className="dt min-w-[34rem]">
                <thead>
                  <tr>
                    <th style={{ width: "3rem" }}>#</th>
                    <th>Role</th>
                    <th className="text-right">Applies above</th>
                    <th>Status</th>
                    <th>Signed by</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {voucher.signatures.map((s) => (
                    <tr key={s.id}>
                      <td className="tnum">{s.sequence}</td>
                      <td className="text-xs font-500">{humanize(s.roleCode)}</td>
                      <td className="num">
                        {s.thresholdAmount > 0 ? money(s.thresholdAmount, voucher.currency, { compact: true }) : "Any"}
                      </td>
                      <td>
                        <StatusBadge status={s.status} />
                        {s.id === step?.id && (
                          <span className="ml-1">
                            <Badge tone="warning">Current</Badge>
                          </span>
                        )}
                      </td>
                      <td className="text-xs">{s.signedBy?.name ?? "—"}</td>
                      <td className="text-2xs">{s.signedAt ? fmtDateTime(s.signedAt) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {voucher.signatures.some((s) => s.comment) && (
              <div className="row-list border-t border-separator">
                {voucher.signatures
                  .filter((s) => s.comment)
                  .map((s) => (
                    <div key={`c-${s.id}`} className="row-static">
                      <div className="label">
                        {humanize(s.roleCode)} · {s.signedBy?.name ?? "—"}
                      </div>
                      <p className="mt-0.5 text-xs leading-5">{s.comment}</p>
                    </div>
                  ))}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Voucher lines" bodyClassName="px-0 pb-0">
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: "3rem" }}>#</th>
                    <th>Description</th>
                    <th>Side</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {voucher.items.map((it) => (
                    <tr key={it.id}>
                      <td className="tnum">{it.lineNo}</td>
                      <td className="wrap text-xs">{it.description}</td>
                      <td>
                        <Badge tone={it.side === "CREDIT" ? "warning" : "neutral"}>{humanize(it.side)}</Badge>
                      </td>
                      <td className="num">{money(it.amount, voucher.currency)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} className="text-right">
                      Net payable
                    </td>
                    <td className="num font-600">{money(voucher.netAmount, voucher.currency)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </SectionCard>

          <SectionCard
            title="What this pays for"
            description="The documents the payment rests on."
            bodyClassName="px-0 pb-0"
          >
            <div className="row-list">
              <div className="row-static flex flex-wrap items-center gap-2 text-xs">
                <Badge tone="accent">Invoice</Badge>
                <RefLink href={`/invoices/${voucher.invoice.id}`}>{voucher.invoice.vendorInvoiceNumber}</RefLink>
                <StatusBadge status={voucher.invoice.status} />
                <span className="tnum text-muted">{money(voucher.invoice.total, voucher.currency)}</span>
                <Badge tone={voucher.invoice.matchStatus === "PASSED" ? "success" : "danger"}>
                  Match {humanize(voucher.invoice.matchStatus)}
                </Badge>
              </div>
              {voucher.invoice.po && (
                <div className="row-static flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone="neutral">Order</Badge>
                  <RefLink href={`/po/${voucher.invoice.po.id}`}>{voucher.invoice.po.number}</RefLink>
                  <span className="tnum text-muted">{money(voucher.invoice.po.total, voucher.currency)}</span>
                </div>
              )}
              {voucher.invoice.grnLinks.map((l) => (
                <div key={l.grn.id} className="row-static flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone="success">Receipt</Badge>
                  <RefLink href={`/grn/${l.grn.id}`}>{l.grn.number}</RefLink>
                </div>
              ))}
              {voucher.invoice.taxLines.length > 0 && (
                <div className="row-static">
                  <div className="label mb-1">Tax</div>
                  <div className="flex flex-wrap gap-1.5">
                    {voucher.invoice.taxLines.map((t) => (
                      <Badge key={t.id} tone={t.status === "VERIFIED" ? "success" : "warning"}>
                        {t.label} {t.rate}% — {money(t.amount, voucher.currency, { compact: true })}
                        {t.withheld ? " (withheld)" : ""}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </SectionCard>

          {voucher.payments.length > 0 && (
            <SectionCard title="Payments released" bodyClassName="px-0 pb-0">
              <div className="table-wrap">
                <table className="dt min-w-[32rem]">
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th className="text-right">Amount</th>
                      <th>Method</th>
                      <th>Status</th>
                      <th>Paid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {voucher.payments.map((p) => (
                      <tr key={p.id}>
                        <td className="mono text-2xs">{p.number}</td>
                        <td className="num">{money(p.amount, p.currency)}</td>
                        <td className="text-xs">{p.paymentMethod ? humanize(p.paymentMethod) : "—"}</td>
                        <td>
                          <StatusBadge status={p.status} />
                        </td>
                        <td className="text-2xs">{p.paidDate ? fmtDateTime(p.paidDate) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}
        </div>

        <div className="space-y-4">
          <SectionCard title="Amounts">
            <DefList
              columns={1}
              items={[
                { label: "Gross", value: money(voucher.grossAmount, voucher.currency) },
                { label: "Tax included", value: money(voucher.taxAmount, voucher.currency) },
                {
                  label: "Withholding deducted",
                  value: voucher.withholdingTax ? money(voucher.withholdingTax, voucher.currency) : "—",
                },
                {
                  label: "Other deductions",
                  value: voucher.deductions ? money(voucher.deductions, voucher.currency) : "—",
                },
                { label: "Net payable", value: money(voucher.netAmount, voucher.currency) },
                { label: "Ledger account", value: voucher.glAccount ?? "—" },
                { label: "Prepared by", value: voucher.preparedBy.name },
                { label: "Prepared", value: fmtDateTime(voucher.preparedAt) },
                ...(voucher.approvedAt ? [{ label: "Fully signed", value: fmtDateTime(voucher.approvedAt) }] : []),
                ...(voucher.paidAt ? [{ label: "Paid", value: fmtDateTime(voucher.paidAt) }] : []),
              ]}
            />
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
