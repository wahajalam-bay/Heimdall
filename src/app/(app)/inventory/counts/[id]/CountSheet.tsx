"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ui/forms";
import { Badge, Mono, SectionCard } from "@/components/ui/primitives";
import { recordCountAction } from "../actions";

type Line = {
  id: string;
  lineNo: number;
  sku: string;
  name: string;
  batch: string | null;
  unit: string;
  expectedQty: number;
  countedQty: number | null;
  varianceQty: number | null;
  varianceValue: number | null;
  reason: string | null;
  adjusted: boolean;
};

/**
 * The count sheet.
 *
 * The expected column is deliberately visible while counting. Blind counting —
 * hiding the ledger figure so the counter cannot anchor on it — is the stronger
 * control, but the SOP does not ask for it, and a sheet that hides the expected
 * quantity makes it impossible for the counter to say *why* a line differs,
 * which is the thing the next person actually needs.
 */
export function CountSheet({
  countId,
  lines,
  editable,
}: {
  countId: string;
  lines: Line[];
  editable: boolean;
}) {
  const [counted, setCounted] = useState<Record<string, string>>(
    Object.fromEntries(lines.map((l) => [l.id, l.countedQty === null ? "" : String(l.countedQty)])),
  );
  const [reasons, setReasons] = useState<Record<string, string>>(
    Object.fromEntries(lines.map((l) => [l.id, l.reason ?? ""])),
  );

  const body = (
    <div className="table-wrap">
      <table className="dt">
        <thead>
          <tr>
            <th style={{ width: "3rem" }}>#</th>
            <th style={{ minWidth: "14rem" }}>Item</th>
            <th style={{ width: "9rem" }}>Batch / serial</th>
            <th style={{ width: "8rem" }} className="text-right">
              Expected
            </th>
            <th style={{ width: "8rem" }} className="text-right">
              Counted
            </th>
            <th style={{ width: "8rem" }} className="text-right">
              Variance
            </th>
            <th style={{ minWidth: "13rem" }}>What happened</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const raw = counted[l.id] ?? "";
            const live = raw.trim() === "" ? null : Number(raw);
            const variance = live === null ? null : Number((live - l.expectedQty).toFixed(2));
            const differs = variance !== null && Math.abs(variance) > 1e-9;

            return (
              <tr key={l.id}>
                <td className="tnum">{l.lineNo}</td>
                <td>
                  {l.name}
                  <Mono className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{l.sku}</Mono>
                </td>
                <td className="text-2xs">{l.batch ?? "—"}</td>
                <td className="tnum text-right">
                  {l.expectedQty} {l.unit}
                </td>
                <td>
                  {editable ? (
                    <>
                      <input type="hidden" name="lineId" value={l.id} />
                      <input
                        className="field text-right"
                        type="number"
                        step="any"
                        min="0"
                        name="countedQty"
                        value={raw}
                        onChange={(e) => setCounted((c) => ({ ...c, [l.id]: e.target.value }))}
                        placeholder="—"
                      />
                    </>
                  ) : (
                    <span className="tnum block text-right">
                      {l.countedQty === null ? (
                        <span className="text-2xs text-[var(--c-text-tertiary)]">Not counted</span>
                      ) : (
                        l.countedQty
                      )}
                    </span>
                  )}
                </td>
                <td className="tnum text-right">
                  {variance === null ? (
                    "—"
                  ) : differs ? (
                    <Badge tone={variance < 0 ? "danger" : "warning"}>
                      {variance > 0 ? "+" : ""}
                      {variance}
                    </Badge>
                  ) : (
                    <span className="text-[var(--c-success)]">0</span>
                  )}
                  {l.adjusted && (
                    <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">Corrected</span>
                  )}
                </td>
                <td>
                  {editable ? (
                    <input
                      className="field"
                      name="varianceReason"
                      value={reasons[l.id] ?? ""}
                      onChange={(e) => setReasons((r) => ({ ...r, [l.id]: e.target.value }))}
                      placeholder={differs ? "Required — what you think happened" : ""}
                      required={differs}
                    />
                  ) : (
                    <span className="text-2xs leading-4 text-muted">{l.reason ?? "—"}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  if (!editable) {
    return (
      <SectionCard title="Count sheet" bodyClassName="px-0 py-0">
        {body}
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Count sheet"
      description="Leave a line blank if it has not been counted. Record zero where the shelf is empty — the two are different facts."
      bodyClassName="px-0 py-0"
    >
      <ActionForm
        action={recordCountAction}
        layout="bare"
        submitLabel="Save the count"
        hiddenFields={{ countId }}
      >
        {body}
      </ActionForm>
    </SectionCard>
  );
}
