"use client";

import { ActionForm } from "@/components/ui/forms";
import { Field } from "@/components/ui/field";
import { Mono, SectionCard } from "@/components/ui/primitives";
import { raiseServiceAcceptanceAction } from "./actions";

export type ServiceLine = {
  id: string;
  lineNo: number;
  description: string;
  unit: string;
  quantity: number;
  acceptedToDate: number;
  outstanding: number;
};

/**
 * Raising the acceptance record against a service order.
 *
 * Every line shows what has already been accepted and what remains, because the
 * cumulative cap is the rule people trip over: a monthly cleaning contract
 * accepted three times in one month is the same error as receiving a hundred
 * units against an order for ninety.
 */
export function RaiseServiceAcceptanceForm({
  poId,
  poNumber,
  lines,
  pocName,
}: {
  poId: string;
  poNumber: string;
  lines: ServiceLine[];
  pocName: string | null;
}) {
  const open = lines.filter((l) => l.outstanding > 0);

  if (!open.length) {
    return (
      <SectionCard title="Service acceptance">
        <p className="text-xs text-[var(--c-text-secondary)]">
          Every line on {poNumber} has been accepted in full. Nothing remains open.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Record what was performed"
      description={
        pocName
          ? `This goes to ${pocName} to confirm. Their confirmation, not this record, is what makes the invoice payable.`
          : "The requesting department's point of contact confirms this before the invoice becomes payable."
      }
    >
      <ActionForm
        action={raiseServiceAcceptanceAction}
        layout="bare"
        hiddenFields={{ poId }}
        submitLabel="Raise acceptance record"
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Service period from" name="serviceFrom" hint="Optional, for recurring work.">
            <input className="field" name="serviceFrom" type="date" />
          </Field>
          <Field label="Service period to" name="serviceTo">
            <input className="field" name="serviceTo" type="date" />
          </Field>
          <Field label="Remarks" name="remarks" hint="Required if any line falls short of the order.">
            <input className="field" name="remarks" maxLength={300} />
          </Field>
        </div>

        <div className="table-wrap mt-4">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "3rem" }}>#</th>
                <th style={{ minWidth: "14rem" }}>Service</th>
                <th style={{ width: "7rem" }}>Ordered</th>
                <th style={{ width: "8rem" }}>Already accepted</th>
                <th style={{ width: "7rem" }}>Still open</th>
                <th style={{ width: "8rem" }}>Accept now</th>
                <th style={{ width: "7rem" }}>Not accepted</th>
                <th style={{ minWidth: "10rem" }}>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {open.map((l) => (
                <tr key={l.id}>
                  <td className="tnum">{l.lineNo}</td>
                  <td>{l.description}</td>
                  <td className="tnum">
                    {l.quantity} {l.unit}
                  </td>
                  <td className="tnum">{l.acceptedToDate || "—"}</td>
                  <td className="tnum font-500">
                    {l.outstanding} {l.unit}
                  </td>
                  <td>
                    <input
                      className="field"
                      name={`accepted_${l.id}`}
                      type="number"
                      step="0.01"
                      min="0"
                      max={l.outstanding}
                      placeholder={String(l.outstanding)}
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      name={`rejected_${l.id}`}
                      type="number"
                      step="0.01"
                      min="0"
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      name={`evidence_${l.id}`}
                      maxLength={80}
                      placeholder="Report ref"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-2xs text-[var(--c-text-tertiary)]">
          Accepting more than remains open is refused — going beyond the order needs a purchase order amendment, not a
          larger acceptance. Leave a line blank to omit it. <Mono>{poNumber}</Mono>
        </p>
      </ActionForm>
    </SectionCard>
  );
}
