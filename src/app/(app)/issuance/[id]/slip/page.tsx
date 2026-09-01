import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Mono } from "@/components/ui/primitives";
import { fmtDate, fmtDateTime, qty } from "@/lib/format";
import { issueAttestations } from "@/server/stores";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const i = await prisma.storeIssue.findUnique({ where: { id }, select: { number: true } });
  return { title: i ? `${i.number} — Issuance slip` : "Issuance slip" };
}

/**
 * The Issuance Slip, for signing.
 *
 * ZAM/PUR/SOP-01 Store Flow (b): issuance is against an Issuance Slip signed by
 * the receiver. This is that slip — the issued quantities as the ledger holds
 * them, with a signature block for the receiver and the storekeeper.
 *
 * Deliberately plain. It is a document to be printed, signed and filed, so it
 * carries no navigation, no actions and no colour, and everything on it is a
 * fact from the record rather than a field to fill in later.
 */
export default async function IssuanceSlipPage({ params }: { params: Promise<{ id: string }> }) {
  const { authorized } = await pageContext(P.INVENTORY_VIEW, P.STORE_ISSUE);
  if (!authorized) return <AccessDenied title="Issuance slip" />;

  const { id } = await params;
  const issue = await prisma.storeIssue.findUnique({
    where: { id },
    include: {
      store: { select: { name: true, entity: { select: { name: true, code: true } } } },
      requestedBy: { select: { name: true, title: true } },
      items: {
        orderBy: { lineNo: "asc" },
        include: { item: { select: { sku: true, name: true, unit: true } } },
      },
    },
  });
  if (!issue) notFound();

  const [signatures, issuedBy, department, project, recipientUser] = await Promise.all([
    issueAttestations(issue.id),
    issue.issuedById
      ? prisma.user.findUnique({ where: { id: issue.issuedById }, select: { name: true, title: true } })
      : Promise.resolve(null),
    issue.departmentId
      ? prisma.department.findUnique({ where: { id: issue.departmentId }, select: { name: true } })
      : Promise.resolve(null),
    issue.projectId
      ? prisma.project.findUnique({ where: { id: issue.projectId }, select: { name: true } })
      : Promise.resolve(null),
    issue.recipientUserId
      ? prisma.user.findUnique({ where: { id: issue.recipientUserId }, select: { name: true, title: true } })
      : Promise.resolve(null),
  ]);

  const acknowledgement = signatures.find((s) => s.attestationType === "ACKNOWLEDGED");
  const lines = issue.items.filter((li) => li.issuedQty > 0);

  return (
    <div className="mx-auto max-w-[52rem] space-y-5 print:max-w-none">
      <div className="no-print flex items-center justify-between">
        <Link className="link text-xs" href={`/issuance/${issue.id}`}>
          ← Back to {issue.number}
        </Link>
        <span className="text-2xs text-[var(--c-text-tertiary)]">
          Print this page to produce the signed slip.
        </span>
      </div>

      <div className="card space-y-5 px-6 py-6">
        <header className="flex items-start justify-between border-b border-[var(--c-border)] pb-4">
          <div>
            <h1 className="text-lg font-semibold">Issuance Slip</h1>
            <p className="mt-0.5 text-xs text-[var(--c-text-secondary)]">
              {issue.store.entity?.name ?? "—"} · {issue.store.name}
            </p>
          </div>
          <div className="text-right">
            <Mono className="text-sm font-semibold">{issue.number}</Mono>
            <p className="mt-0.5 text-2xs text-[var(--c-text-tertiary)]">
              {issue.issuedAt ? fmtDate(issue.issuedAt) : "Not yet issued"}
            </p>
          </div>
        </header>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Issued to</dt>
            <dd className="mt-0.5">{issue.recipientName}</dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Department</dt>
            <dd className="mt-0.5">{department?.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Project</dt>
            <dd className="mt-0.5">{project?.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Requested by</dt>
            <dd className="mt-0.5">{issue.requestedBy.name}</dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Purpose</dt>
            <dd className="mt-0.5">{issue.purpose ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Status</dt>
            <dd className="mt-0.5">{issue.status.replace(/_/g, " ").toLowerCase()}</dd>
          </div>
        </dl>

        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "3rem" }}>#</th>
                <th style={{ minWidth: "14rem" }}>Item</th>
                <th style={{ width: "9rem" }}>Batch / serial</th>
                <th style={{ width: "7rem" }} className="text-right">
                  Approved
                </th>
                <th style={{ width: "7rem" }} className="text-right">
                  Issued
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-[var(--c-text-tertiary)]">
                    Nothing has been issued against this requisition yet, so there is nothing to sign for.
                  </td>
                </tr>
              )}
              {lines.map((li) => (
                <tr key={li.id}>
                  <td className="tnum">{li.lineNo}</td>
                  <td>
                    {li.item.name}
                    <Mono className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{li.item.sku}</Mono>
                  </td>
                  <td className="text-2xs">{li.serialNumber ?? li.batchNumber ?? "—"}</td>
                  <td className="tnum text-right">{qty(li.approvedQty ?? li.requestedQty)}</td>
                  <td className="tnum text-right font-semibold">
                    {qty(li.issuedQty)} {li.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid gap-6 border-t border-[var(--c-border)] pt-5 sm:grid-cols-2">
          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">Issued by (Store)</p>
            <div className="mt-6 border-b border-[var(--c-text-tertiary)]" />
            <p className="mt-1 text-xs">{issuedBy?.name ?? "—"}</p>
            <p className="text-2xs text-[var(--c-text-tertiary)]">
              {issuedBy?.title ?? ""}
              {issue.issuedAt ? ` · ${fmtDate(issue.issuedAt)}` : ""}
            </p>
          </div>

          <div>
            <p className="text-2xs uppercase tracking-wide text-[var(--c-text-tertiary)]">
              Received by (User department)
            </p>
            <div className="mt-6 border-b border-[var(--c-text-tertiary)]" />
            <p className="mt-1 text-xs">{recipientUser?.name ?? issue.recipientName}</p>
            <p className="text-2xs text-[var(--c-text-tertiary)]">
              {acknowledgement
                ? `Acknowledged in the system ${fmtDateTime(acknowledgement.signedAt)}`
                : "Signature required — ZAM/PUR/SOP-01 Store Flow"}
            </p>
          </div>
        </div>

        {acknowledgement?.comment && (
          <p className="border-t border-[var(--c-border)] pt-3 text-2xs text-[var(--c-text-secondary)]">
            {acknowledgement.comment}
          </p>
        )}
      </div>

      <p className="no-print text-2xs text-[var(--c-text-tertiary)]">
        Quantities are the issued figures from the inventory ledger, not what was requested or approved. A receiver
        signs for what they actually took.
      </p>
    </div>
  );
}
