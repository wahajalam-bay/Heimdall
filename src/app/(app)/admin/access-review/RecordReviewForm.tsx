"use client";

import { ActionForm } from "@/components/ui/forms";
import { Field, TextArea } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { recordAccessReviewAction } from "./actions";

export function RecordReviewForm({
  period,
  entityId,
  summary,
}: {
  period: string;
  entityId: string | null;
  summary: {
    flagged: number;
    onBothSides: number;
    noRole: number;
    inactiveWithRoles: number;
  };
}) {
  return (
    <ActionForm
      action={recordAccessReviewAction}
      layout="bare"
      submitLabel={`Record the ${period} review`}
      hiddenFields={{ periodLabel: period, ...(entityId ? { entityId } : {}) }}
    >
      <InlineAlert tone="info">
        What goes on the record with your note: {summary.flagged} account(s) flagged,{" "}
        {summary.noRole} active with no role, {summary.inactiveWithRoles} inactive still holding roles,{" "}
        {summary.onBothSides} person-separations where one person holds both sides. Those figures are captured at the
        moment you record, not recomputed later.
      </InlineAlert>

      <Field
        label="What you looked at and what you concluded"
        name="notes"
        required
        hint="A review is somebody saying the list is right. Without that it is a report, and the register cannot tell the two apart."
      >
        <TextArea name="notes" rows={4} required />
      </Field>
    </ActionForm>
  );
}
