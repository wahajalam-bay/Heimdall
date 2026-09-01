"use client";

import { ActionButton, ActionForm } from "@/components/ui/forms";
import { Checkbox, Field, FormSection, TextInput } from "@/components/ui/field";
import { Badge, InlineAlert, SectionCard } from "@/components/ui/primitives";
import { fmtDateTime } from "@/lib/format";
import { humanize } from "@/lib/domain";
import { circulateCpcDecisionAction, setCpcAttendanceAction } from "../../actions";

/**
 * CP-006 attendance and quorum, and CP-016's circulation.
 *
 * The quorum line is stated in words as well as figures, because "3 of 3" does
 * not tell a chair what is missing — whether it is a body in the room, the
 * requisitioner's head, or a mandatory member who sent nobody.
 */
export function QuorumPanel({
  caseId,
  status,
  quorum,
  attendance,
  circulation,
  enforcing,
  canManage,
}: {
  caseId: string;
  status: string;
  quorum: {
    votingSeats: number;
    observerSeats: number;
    required: number;
    present: number;
    requisitionerHeadPresent: boolean;
    requisitionerHeadName: string | null;
    presentByProxy: number;
    mandatoryAbsent: string[];
    quorate: boolean;
    reason: string;
    rosterMissing: boolean;
  };
  attendance: Array<{
    id: string;
    memberId: string;
    memberName: string;
    designation: string | null;
    memberType: string;
    isChair: boolean;
    vacant: boolean;
    attendance: string;
    proxyName: string | null;
  }>;
  circulation: {
    ref: string | null;
    at: Date | null;
    by: string | null;
    ceoOfficeCopied: boolean;
  };
  enforcing: boolean;
  canManage: boolean;
}) {
  const open = !["APPROVED", "REJECTED", "RETURNED"].includes(status);
  const decided = ["APPROVED", "REJECTED", "RETURNED", "PENDING_CEO"].includes(status);

  return (
    <div className="space-y-4">
      <SectionCard
        title="Quorum — CP-006"
        description={quorum.reason}
        bodyClassName="px-0 py-0"
        actions={
          <Badge tone={quorum.quorate ? "success" : "warning"}>
            {quorum.quorate ? "Quorate" : "Not quorate"}
          </Badge>
        }
      >
        {quorum.rosterMissing ? (
          <div className="px-3.5 py-3">
            <InlineAlert tone="danger">
              No standing composition is seeded for this company, so CP-003&rsquo;s nine seats do not exist and the
              quorum cannot be counted. Seed the roster before relying on this.
            </InlineAlert>
          </div>
        ) : (
          <>
            {!enforcing && (
              <p className="px-3.5 pt-3 text-2xs leading-4 text-[var(--c-text-tertiary)]">
                The quorum gate is off, so a decision can still be recorded without it. The count is shown either way,
                and is snapshotted onto the case when the decision is taken.
              </p>
            )}
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ minWidth: "15rem" }}>Seat</th>
                    <th style={{ minWidth: "11rem" }}>Type</th>
                    <th style={{ width: "9rem" }}>Attendance</th>
                    {open && canManage && <th style={{ minWidth: "13rem" }} />}
                  </tr>
                </thead>
                <tbody>
                  {attendance.map((a) => (
                    <tr key={a.id}>
                      <td className="text-xs">
                        {a.designation ?? a.memberName}
                        {a.isChair && <Badge tone="accent" className="ml-2">Chair</Badge>}
                        {a.vacant && (
                          <span className="mt-0.5 block text-2xs text-[var(--c-warning)]">
                            seat vacant — nobody to attend
                          </span>
                        )}
                      </td>
                      <td className="text-2xs">
                        {humanize(a.memberType)}
                        {a.memberType === "OBSERVER" && (
                          <span className="mt-0.5 block text-[var(--c-text-tertiary)]">
                            does not count
                          </span>
                        )}
                      </td>
                      <td className="text-2xs">
                        <Badge
                          tone={
                            a.attendance === "PRESENT"
                              ? "success"
                              : a.attendance === "PROXY"
                                ? "progress"
                                : "neutral"
                          }
                        >
                          {humanize(a.attendance)}
                        </Badge>
                        {a.proxyName && (
                          <span className="mt-0.5 block text-[var(--c-text-tertiary)]">by {a.proxyName}</span>
                        )}
                      </td>
                      {open && canManage && (
                        <td>
                          <div className="flex flex-wrap gap-1.5">
                            <ActionButton
                              action={setCpcAttendanceAction}
                              payload={{ caseId, memberId: a.memberId, attendance: "PRESENT" }}
                              label="Present"
                              size="xs"
                              tone="success"
                              disabled={a.vacant}
                              disabledReason="The seat is vacant, so nobody can attend it."
                            />
                            <ActionButton
                              action={setCpcAttendanceAction}
                              payload={{ caseId, memberId: a.memberId, attendance: "PROXY" }}
                              label="By proxy"
                              size="xs"
                              reasonLabel="Proxy's name"
                              reasonRequired
                              disabled={a.vacant}
                              disabledReason="The seat is vacant."
                            />
                            <ActionButton
                              action={setCpcAttendanceAction}
                              payload={{ caseId, memberId: a.memberId, attendance: "ABSENT" }}
                              label="Absent"
                              size="xs"
                            />
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-3.5 py-2.5 text-2xs leading-4 text-[var(--c-text-tertiary)]">
              {quorum.present} of {quorum.required} permanent members present besides the requisitioner&rsquo;s head
              {quorum.presentByProxy ? `, ${quorum.presentByProxy} by nominated proxy` : ""}.{" "}
              {quorum.requisitionerHeadName && (
                <>
                  The head of {quorum.requisitionerHeadName} is{" "}
                  {quorum.requisitionerHeadPresent ? "present or represented" : (
                    <span className="text-[var(--c-warning)]">neither present nor represented</span>
                  )}
                  .
                </>
              )}
              {quorum.observerSeats > 0 &&
                ` ${quorum.observerSeats} observer seat(s) excluded from the count, per CP-007.`}
            </div>
          </>
        )}
      </SectionCard>

      {decided && (
        <SectionCard
          title="Decision circulation — CP-016"
          description="Once quorum finalises a decision it is shared with committee members, copying the Office of the CEO. That email is attached to the documentation trail Finance initiates payment against — so until it exists, an approval cannot be paid on."
        >
          {circulation.at ? (
            <p className="text-xs">
              {circulation.ref}
              <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                {circulation.by ? `${circulation.by} · ` : ""}
                {fmtDateTime(circulation.at)}
                {circulation.ceoOfficeCopied ? " · Office of the CEO copied" : ""}
              </span>
            </p>
          ) : canManage ? (
            <>
              <InlineAlert tone="warning">
                Decided and not circulated. The payment pack of any invoice against this requisition will show the
                circular as missing, because CP-016 makes it part of the trail Finance pays against.
              </InlineAlert>
              <div className="mt-3">
                <ActionForm
                  action={circulateCpcDecisionAction}
                  layout="bare"
                  submitLabel="Record the circulation"
                  hiddenFields={{ caseId }}
                >
                  <FormSection columns={1}>
                    <Field
                      label="Circular reference"
                      name="circularRef"
                      required
                      hint="A message id, subject line or filing reference — something that can be found again."
                    >
                      <TextInput name="circularRef" required />
                    </Field>
                    <Field label="" name="ceoOfficeCopied">
                      <Checkbox
                        name="ceoOfficeCopied"
                        label="The Office of the CEO was copied"
                        hint="CP-016 names them. Circulating without them is a different act from the one the clause describes, and is refused."
                      />
                    </Field>
                  </FormSection>
                </ActionForm>
              </div>
            </>
          ) : (
            <p className="text-xs text-[var(--c-warning)]">Not circulated.</p>
          )}
        </SectionCard>
      )}
    </div>
  );
}
