"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ui/forms";
import { Field } from "@/components/ui/field";
import { SectionCard } from "@/components/ui/primitives";
import { confirmServiceAcceptanceAction } from "./actions";

/**
 * The point of contact's decision.
 *
 * Accepting and refusing are one form with one decision, not two buttons that
 * look alike — a refusal needs a reason and an acceptance does not, so the form
 * asks for what the chosen decision requires.
 */
export function ConfirmServiceForm({
  id,
  number,
  shortfall,
}: {
  id: string;
  number: string;
  shortfall: boolean;
}) {
  const [decision, setDecision] = useState<"ACCEPT" | "REJECT">("ACCEPT");

  return (
    <SectionCard
      title="Confirm the work was performed"
      description="Your confirmation is what makes the vendor's invoice payable, so it is recorded against your name."
    >
      <ActionForm
        action={confirmServiceAcceptanceAction}
        layout="bare"
        hiddenFields={{ id, decision }}
        submitLabel={decision === "ACCEPT" ? `Confirm ${number}` : `Refuse ${number}`}
        submitTone={decision === "ACCEPT" ? "success" : "danger"}
        confirm={
          decision === "ACCEPT"
            ? "Confirm that this work was performed as recorded. The vendor's invoice becomes payable against it."
            : undefined
        }
      >
        <Field label="Decision" name="decisionChoice">
          <select
            className="field"
            value={decision}
            onChange={(e) => setDecision(e.target.value as "ACCEPT" | "REJECT")}
          >
            <option value="ACCEPT">The work was performed as recorded</option>
            <option value="REJECT">The work was not performed — refuse</option>
          </select>
        </Field>

        <Field
          label={decision === "REJECT" ? "Why is this refused?" : "Remarks"}
          name="comment"
          hint={
            decision === "REJECT"
              ? "Required. The vendor is told this, and the invoice stays blocked until it is settled."
              : shortfall
                ? "Part of the order was not accepted. Note what was missed, so the shortfall is answerable later."
                : "Optional."
          }
        >
          <textarea
            className="field"
            name="comment"
            rows={3}
            required={decision === "REJECT"}
            placeholder={
              decision === "REJECT"
                ? "What was not delivered, and what the vendor needs to put right"
                : "Anything worth recording about how the work went"
            }
          />
        </Field>
      </ActionForm>
    </SectionCard>
  );
}
