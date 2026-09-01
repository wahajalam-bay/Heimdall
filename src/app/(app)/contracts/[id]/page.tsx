import Link from "next/link";
import { notFound } from "next/navigation";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  BlockedNotice,
  DefList,
  InlineAlert,
  Meter,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatusBadge,
} from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/forms";
import { LifecycleRail, buildRail } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { contractDetail, CONTRACT_TYPE_LABELS, type ContractType } from "@/server/contracts";
import { signContractAction, transitionContractAction } from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await contractDetail(id);
  return { title: c ? `${c.number} — ${c.title}` : "Contract" };
}

const RAIL = [
  "DRAFT",
  "PENDING_REVIEW",
  "PENDING_APPROVAL",
  "APPROVED",
  "PENDING_SIGNATURE",
  "ACTIVE",
] as const;

const DAY = 86400000;

export default async function ContractDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, authorized } = await pageContext(P.PO_VIEW);
  if (!authorized) return <AccessDenied title="Contract" />;

  const { id } = await params;
  const c = await contractDetail(id);
  if (!c) notFound();

  const canEdit = userHasPermission(user, P.PO_CREATE, P.PO_EDIT);
  const canApprove = userHasPermission(user, P.PO_APPROVE);
  const canIssue = userHasPermission(user, P.PO_ISSUE);
  const canClose = userHasPermission(user, P.PO_CLOSE, P.PO_APPROVE);

  const daysLeft = c.endDate ? Math.floor((c.endDate.getTime() - Date.now()) / DAY) : null;
  const inNotice = daysLeft !== null && daysLeft >= 0 && daysLeft <= c.noticeDays;

  // The rail stops at ACTIVE: everything after it — expiring, renewed,
  // terminated — is an outcome rather than a step, and drawing them as steps
  // would suggest a contract is meant to reach termination.
  const railStatus = ["EXPIRING", "EXPIRED", "RENEWED", "SUSPENDED", "TERMINATED", "CLOSED"].includes(
    c.status,
  )
    ? "ACTIVE"
    : c.status;
  const rail = buildRail([...RAIL], railStatus, {
    APPROVED: { at: null, owner: null },
    PENDING_SIGNATURE: { at: c.signedAt, owner: c.authorisedSignatory?.name ?? null },
    ACTIVE: { at: c.startDate, owner: null },
  });

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Procurement" },
          { label: "Contracts", href: "/contracts" },
          { label: c.number },
        ]}
      />

      <PageHeader
        eyebrow={`${c.entity.code} · ${CONTRACT_TYPE_LABELS[c.contractType as ContractType] ?? c.contractType}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <Mono className="text-[1rem] text-muted">{c.number}</Mono>
            <span>{c.title}</span>
          </span>
        }
        meta={
          <>
            <StatusBadge status={c.status} />
            <span className="text-2xs">{c.vendor.name}</span>
            {c.contractValue != null && <span className="text-2xs">{money(c.contractValue)}</span>}
          </>
        }
        actions={
          <>
            {c.status === "DRAFT" && canEdit && (
              <ActionButton
                action={transitionContractAction}
                payload={{ contractId: c.id, to: "PENDING_APPROVAL" }}
                label="Send for approval"
                tone="primary"
              />
            )}
            {c.status === "PENDING_APPROVAL" && canApprove && (
              <ActionButton
                action={transitionContractAction}
                payload={{ contractId: c.id, to: "APPROVED" }}
                label="Approve"
                tone="primary"
                reasonLabel="Approval note (optional)"
              />
            )}
            {["APPROVED", "PENDING_SIGNATURE"].includes(c.status) && !c.signedAt && canIssue && (
              <ActionButton
                action={signContractAction}
                payload={{ contractId: c.id }}
                label="Sign as authorised signatory"
                tone="primary"
                reasonLabel="Note (optional)"
                confirm={`Sign ${c.number} on behalf of the company? §4.6 puts this signature with Manager Procurement or another authorised signatory.`}
              />
            )}
            {c.status === "PENDING_SIGNATURE" && c.signedAt && canIssue && (
              <ActionButton
                action={transitionContractAction}
                payload={{ contractId: c.id, to: "ACTIVE" }}
                label="Activate"
                tone="primary"
                reasonLabel="Who signed for the vendor (optional)"
              />
            )}
            {["ACTIVE", "EXPIRING"].includes(c.status) && canApprove && (
              <ActionButton
                action={transitionContractAction}
                payload={{ contractId: c.id, to: "SUSPENDED" }}
                label="Suspend"
                tone="danger-soft"
                reasonLabel="Why the contract is being suspended"
                reasonRequired
              />
            )}
            {["ACTIVE", "EXPIRING", "SUSPENDED"].includes(c.status) && canApprove && (
              <ActionButton
                action={transitionContractAction}
                payload={{ contractId: c.id, to: "TERMINATED" }}
                label="Terminate"
                tone="danger-soft"
                reasonLabel="Why the contract is being terminated"
                reasonRequired
              />
            )}
            {["EXPIRING", "EXPIRED", "TERMINATED", "RENEWED"].includes(c.status) && canClose && (
              <ActionButton
                action={transitionContractAction}
                payload={{ contractId: c.id, to: "CLOSED" }}
                label="Close"
                tone="secondary"
              />
            )}
          </>
        }
      />

      {c.status === "EXPIRED" && (
        <BlockedNotice
          title="This contract has expired"
          reasons={[
            `It ended ${c.endDate ? fmtDate(c.endDate) : "on its end date"} with no renewal or termination recorded.`,
            "Nothing should be drawn against it, and anything still being supplied under it is being supplied without a contract.",
          ]}
        />
      )}

      {c.status === "EXPIRING" && (
        <InlineAlert tone={c.autoRenew ? "danger" : "warning"}>
          {c.autoRenew
            ? `This contract renews automatically and is inside its ${c.noticeDays}-day notice period — ${daysLeft} days left to stop it. The system will not renew it for you: the flag records what the paper says, and acting on it would create an obligation nobody chose.`
            : `Inside the ${c.noticeDays}-day notice period, ${daysLeft} days to run. Renew, renegotiate, or let it lapse — but decide, because this is the window in which anything can usefully be done.`}
        </InlineAlert>
      )}

      {c.committeeRequired && !["DRAFT", "PENDING_REVIEW"].includes(c.status) && (
        <InlineAlert tone="info">
          Its value takes this contract to the Central Purchase Committee, whose mandate names service contracts,
          SLAs, AMCs and build-outs specifically. Approval is refused until a committee case for it is approved.
        </InlineAlert>
      )}

      <LifecycleRail steps={rail} title="Contract lifecycle" />

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <SectionCard title="Terms">
          <DefList
            columns={2}
            items={[
              { label: "Vendor", value: <RefLink href={`/vendors/${c.vendor.id}`}>{c.vendor.name}</RefLink> },
              { label: "Type", value: CONTRACT_TYPE_LABELS[c.contractType as ContractType] ?? c.contractType },
              { label: "Starts", value: c.startDate ? fmtDate(c.startDate) : "—" },
              { label: "Ends", value: c.endDate ? fmtDate(c.endDate) : "No end date" },
              { label: "Notice period", value: `${c.noticeDays} days` },
              {
                label: "Renews",
                value: c.autoRenew ? (
                  <Badge tone="warning">Automatically, unless stopped</Badge>
                ) : (
                  "Only by agreement"
                ),
              },
              { label: "Payment terms", value: c.paymentTerms ?? "—" },
              { label: "Delivery location", value: c.deliveryLocation ?? "—" },
              ...(c.slaTerms ? [{ label: "Service levels", value: c.slaTerms, span: true as const }] : []),
              ...(c.legalTerms ? [{ label: "Legal terms", value: c.legalTerms, span: true as const }] : []),
              ...(c.description ? [{ label: "Description", value: c.description, span: true as const }] : []),
            ]}
          />
        </SectionCard>

        <div className="space-y-4">
          <SectionCard title="Value">
            {c.contractValue == null ? (
              <p className="text-xs leading-5 text-muted">
                No committed value. A framework or rate agreement commits nothing up front, which is why this is
                blank rather than zero — a zero-value contract and a rate agreement are different things.
              </p>
            ) : (
              <div className="space-y-3">
                <DefList
                  columns={1}
                  items={[
                    { label: "Contract value", value: money(c.contractValue) },
                    { label: "Committed by orders", value: money(c.committedValue) },
                    { label: "Remaining", value: money(c.contractValue - c.committedValue) },
                  ]}
                />
                {c.contractValue > 0 && (
                  <Meter
                    value={c.committedValue}
                    max={c.contractValue}
                    label={`${Math.round((c.committedValue / c.contractValue) * 100)}% committed`}
                    tone={c.committedValue > c.contractValue * 0.9 ? "warning" : "success"}
                  />
                )}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Signatures — §4.6">
            <DefList
              columns={1}
              items={[
                {
                  label: "Authorised signatory",
                  value: c.authorisedSignatory
                    ? `${c.authorisedSignatory.name}${c.authorisedSignatory.title ? ` — ${c.authorisedSignatory.title}` : ""}`
                    : "Not yet signed",
                },
                { label: "Signed", value: c.signedAt ? fmtDateTime(c.signedAt) : "—" },
                { label: "Vendor signatory", value: c.vendorSignatoryName ?? "—" },
                { label: "Vendor signed", value: c.vendorSignedAt ? fmtDateTime(c.vendorSignedAt) : "—" },
              ]}
            />
          </SectionCard>
        </div>
      </div>

      {(c.renewalOf || c.renewals.length > 0) && (
        <SectionCard title="Renewal chain" bodyClassName="px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {c.renewalOf && (
              <>
                <Link className="link" href={`/contracts/${c.renewalOf.id}`}>
                  {c.renewalOf.number}
                </Link>
                <span className="text-[var(--c-text-tertiary)]">→</span>
              </>
            )}
            <Mono className="font-semibold">{c.number}</Mono>
            {c.renewals.map((r) => (
              <span key={r.id} className="flex items-center gap-2">
                <span className="text-[var(--c-text-tertiary)]">→</span>
                <Link className="link" href={`/contracts/${r.id}`}>
                  {r.number}
                </Link>
                <StatusBadge status={r.status} />
              </span>
            ))}
          </div>
        </SectionCard>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Contract history"
          description="The contract's own trail — what happened and when. Kept apart from the audit log because this is a business record people read, and an audit log is forensic."
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: "9rem" }}>When</th>
                  <th style={{ width: "9rem" }}>What</th>
                  <th style={{ minWidth: "14rem" }}>Note</th>
                  <th style={{ width: "9rem" }}>By</th>
                </tr>
              </thead>
              <tbody>
                {c.events.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-[var(--c-text-tertiary)]">
                      Nothing recorded yet.
                    </td>
                  </tr>
                )}
                {c.events.map((e) => (
                  <tr key={e.id}>
                    <td className="text-2xs">{fmtDateTime(e.occurredAt)}</td>
                    <td className="text-2xs">{humanize(e.eventType)}</td>
                    <td className="text-2xs leading-4 text-muted">{e.note ?? "—"}</td>
                    <td className="text-2xs">{e.actor?.name ?? "System"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>

        <DocumentsPanel user={user} linkedType="CONTRACT" linkedId={c.id} title="Documents" />
      </div>
    </div>
  );
}
