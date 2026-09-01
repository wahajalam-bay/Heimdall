import Link from "next/link";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission, type SessionUser } from "@/lib/rbac";
import { Badge, InlineAlert, Mono, SectionCard } from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/forms";
import { fmtDate } from "@/lib/format";
import { paymentPack } from "@/server/payment-pack";
import {
  setPackApplicabilityAction,
  verifyPackItemAction,
  waivePackItemAction,
} from "@/app/(app)/finance/pack-actions";

/**
 * Annexure A, on the invoice.
 *
 * ZAM/PUR/SOP-01 §3.4: procurement "will process all invoices and ensure
 * availability of supporting documents before submitting to finance as per
 * Annexure A". This is that checklist, and its first three entries — the
 * requisition, the order, the goods receipt — are documents this system
 * generates. So the pack populates itself from the chain behind the invoice and
 * names the actual document, rather than asking somebody to upload a scan of a
 * record the system already holds.
 *
 * What it will not do is call that verified. Holding a document and having
 * checked it are two different facts, and the column keeps them apart: the pack
 * can be complete and still show four documents nobody has looked at.
 */
export async function PaymentPackPanel({
  user,
  documentType,
  documentId,
  entityId,
  transactionType,
  description,
}: {
  user: SessionUser;
  documentType: "INVOICE" | "PETTY_CASH";
  documentId: string;
  entityId?: string | null;
  /** GOODS | SERVICES — a service payment has no goods receipt to produce. */
  transactionType?: string;
  description?: string;
}) {
  const pack = await paymentPack(documentType, documentId, { entityId, transactionType });
  if (pack.items.length === 0) {
    // Two different silences, and they must not read as one. Annexure A is
    // seeded for goods; a service payment has no goods receipt to produce, and
    // what its pack should require instead is BD-011 — open, and not for this
    // component to guess.
    const services = transactionType === "SERVICES";
    return (
      <SectionCard
        title="Annexure A — supporting documents"
        description={
          services
            ? "Annexure A is written around a goods purchase — its four unconditional documents include the goods receipt note, which a service payment does not have."
            : "No document pack is configured, so nothing is being required of this payment."
        }
      >
        <p className="text-xs leading-5 text-muted">
          {services ? (
            <>
              No service pack has been defined, so this payment is not being checked against a document set. What
              should stand in place of the receipt — a service acceptance certificate, a completion report — is
              BD-011, and it is open. Nothing is required here rather than the goods set being applied to a payment
              it does not fit.
            </>
          ) : (
            <>
              Run <Mono className="text-2xs">scripts/seed-payment-pack.ts</Mono> to load the seven documents Annexure
              A names.
            </>
          )}
        </p>
      </SectionCard>
    );
  }

  const canAssemble = userHasPermission(user, P.INVOICE_VERIFY, P.PETTY_CASH_APPROVE, P.DOCUMENT_UPLOAD);
  const canVerify = userHasPermission(user, P.INVOICE_VERIFY, P.PETTY_CASH_APPROVE);
  const held = pack.items.filter((i) => i.applicable && i.present).length;
  const needed = pack.items.filter((i) => i.applicable && i.requirementKind !== "OPTIONAL").length;

  const base = { packDocumentType: documentType, packDocumentId: documentId };

  return (
    <SectionCard
      title="Annexure A — supporting documents"
      description={
        description ??
        "§3.4 requires this set to be available before the invoice goes to finance. The requisition, order and receipt are the system's own records, so they are counted as held and linked rather than asked for again."
      }
      actions={
        <span className="text-2xs text-[var(--c-text-tertiary)]">
          {held} of {needed} required held
        </span>
      }
      bodyClassName="px-0 py-0"
    >
      {pack.complete ? (
        pack.unverified.length > 0 ? (
          <div className="px-3.5 pt-3">
            <InlineAlert tone="info">
              The pack is complete, but {pack.unverified.length} document
              {pack.unverified.length === 1 ? " has" : "s have"} not been checked by anyone:{" "}
              {pack.unverified.join(", ")}. Holding a document and having looked at it are different things.
            </InlineAlert>
          </div>
        ) : null
      ) : (
        <div className="px-3.5 pt-3">
          <InlineAlert tone="warning">
            Short by {pack.blockers.length}: {pack.blockers.join(", ")}. Attach what is missing, mark a conditional
            requirement as not applicable with a note, or release it with a recorded exception.
          </InlineAlert>
        </div>
      )}

      {pack.waived.length > 0 && (
        <div className="px-3.5 pt-3">
          <InlineAlert tone="danger">
            Released without the document: {pack.waived.join(", ")}. The payment can proceed, and the exception is on
            the record with the name of whoever allowed it.
          </InlineAlert>
        </div>
      )}

      <div className="table-wrap">
        <table className="dt">
          <thead>
            <tr>
              <th style={{ minWidth: "12rem" }}>Document</th>
              <th style={{ width: "7rem" }}>Required</th>
              <th style={{ minWidth: "14rem" }}>What we hold</th>
              <th style={{ width: "9rem" }}>Checked</th>
              {canAssemble && <th style={{ minWidth: "13rem" }} className="text-right">
                &nbsp;
              </th>}
            </tr>
          </thead>
          <tbody>
            {pack.items.map((item) => {
              const payload = { ...base, documentTypeCode: item.documentTypeCode };
              const excused = !item.applicable;
              return (
                <tr key={item.documentTypeCode}>
                  <td className="text-xs">
                    {item.documentTypeName}
                    {item.condition && (
                      <span className="mt-0.5 block text-2xs leading-4 text-[var(--c-text-tertiary)]">
                        {item.condition}
                      </span>
                    )}
                  </td>
                  <td className="text-2xs">
                    {item.requirementKind === "ALWAYS" ? (
                      <Badge tone="neutral">Always</Badge>
                    ) : item.requirementKind === "CONDITIONAL" ? (
                      excused ? (
                        <Badge tone="neutral">Not applicable</Badge>
                      ) : (
                        <Badge tone="warning">If applicable</Badge>
                      )
                    ) : (
                      <span className="text-[var(--c-text-tertiary)]">Optional</span>
                    )}
                    {excused && item.applicableNote && (
                      <span className="mt-0.5 block text-2xs leading-4 text-[var(--c-text-tertiary)]">
                        {item.applicableNote}
                      </span>
                    )}
                  </td>
                  <td className="text-2xs leading-4">
                    {item.records.length > 0 ? (
                      <span className="space-y-0.5">
                        {item.records.map((r) => (
                          <Link key={r.href} className="link block" href={r.href}>
                            {r.label} <Mono className="text-2xs">{r.ref}</Mono>
                          </Link>
                        ))}
                        <span className="block text-[var(--c-text-tertiary)]">
                          The system&rsquo;s own record
                          {item.satisfiedBy === "ATTACHMENT" ? ", plus an attached copy" : ""}
                        </span>
                      </span>
                    ) : item.satisfiedBy === "ATTACHMENT" ? (
                      <span className="text-[var(--c-success)]">Attached</span>
                    ) : item.exceptionReason ? (
                      <span className="text-[var(--c-danger)]">
                        Waived — {item.exceptionReason}
                        {item.exceptionApprovedByName ? ` (${item.exceptionApprovedByName})` : ""}
                      </span>
                    ) : excused ? (
                      <span className="text-[var(--c-text-tertiary)]">Not required here</span>
                    ) : (
                      <span className="text-[var(--c-warning)]">Nothing held</span>
                    )}
                  </td>
                  <td className="text-2xs">
                    {item.verified ? (
                      <>
                        <Badge tone="success">Checked</Badge>
                        <span className="mt-0.5 block text-[var(--c-text-tertiary)]">
                          {item.verifiedByName}
                          {item.verifiedAt ? ` · ${fmtDate(item.verifiedAt)}` : ""}
                        </span>
                      </>
                    ) : item.present ? (
                      <span className="text-[var(--c-text-tertiary)]">Not yet</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  {canAssemble && (
                    <td className="text-right">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {canVerify && item.present && !item.verified && (
                          <ActionButton
                            action={verifyPackItemAction}
                            label="Checked"
                            size="xs"
                            tone="success"
                            payload={payload}
                          />
                        )}
                        {item.requirementKind === "CONDITIONAL" && !excused && !item.present && (
                          <ActionButton
                            action={setPackApplicabilityAction}
                            label="Not applicable"
                            size="xs"
                            reasonLabel="Why this document does not apply to this payment"
                            reasonRequired
                            payload={{ ...payload, applicable: "false" }}
                          />
                        )}
                        {excused && (
                          <ActionButton
                            action={setPackApplicabilityAction}
                            label="Require it"
                            size="xs"
                            payload={{ ...payload, applicable: "true" }}
                          />
                        )}
                        {item.blocking && (
                          <ActionButton
                            action={waivePackItemAction}
                            label="Release without it"
                            size="xs"
                            tone="danger-soft"
                            reasonLabel="Why this payment proceeds without a document Annexure A requires"
                            reasonRequired
                            payload={payload}
                          />
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="px-3.5 py-2.5 text-2xs leading-4 text-[var(--c-text-tertiary)]">
        Attaching a document is done in the documents panel below; this checklist picks it up. Where a document is one
        the system generates, the link goes to the printable form — so a checker can open what they are signing off
        rather than take the tick on trust.
      </p>
    </SectionCard>
  );
}
