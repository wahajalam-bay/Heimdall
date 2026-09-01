"use client";

import { useState } from "react";
import { ActionForm, Modal } from "@/components/ui/forms";
import { Field, Select, TextArea, TextInput } from "@/components/ui/field";
import { Badge, InlineAlert, Mono, SectionCard } from "@/components/ui/primitives";
import { handOffToRepairAction, inspectReturnAction, setDispositionAction } from "../actions";

type Line = {
  id: string;
  lineNo: number;
  description: string;
  sku: string | null;
  tag: string | null;
  quantity: number;
  unit: string;
  serial: string | null;
  condition: string;
  conditionNotes: string | null;
  verdict: string | null;
  disposition: string | null;
  dispositionNote: string | null;
  stacked: boolean;
};

const CONDITION_TONE: Record<string, "success" | "warning" | "danger"> = {
  GOOD: "success",
  USABLE: "success",
  DAMAGED: "warning",
  FAULTY: "danger",
  BEYOND_REPAIR: "danger",
};

/**
 * The returned lines, their inspection verdicts and where each unit went.
 *
 * Per line, because one return holds a working monitor and a dead laptop, and a
 * single verdict over both would send the monitor for repair or the laptop to
 * the shelf.
 */
export function InspectReturn({
  returnId,
  lines,
  canInspect,
  canHandOff,
  canDisposition,
}: {
  returnId: string;
  lines: Line[];
  canInspect: boolean;
  canHandOff: boolean;
  canDisposition: boolean;
}) {
  const [verdicts, setVerdicts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [handOff, setHandOff] = useState(false);
  const [dispositioning, setDispositioning] = useState<Line | null>(null);

  const table = (
    <div className="table-wrap">
      <table className="dt">
        <thead>
          <tr>
            <th style={{ width: "3rem" }}>#</th>
            <th style={{ minWidth: "14rem" }}>What came back</th>
            <th style={{ width: "7rem" }} className="text-right">
              Qty
            </th>
            <th style={{ width: "8rem" }}>As received</th>
            {canInspect && <th style={{ width: "8rem" }}>Verdict</th>}
            {canInspect && <th style={{ minWidth: "11rem" }}>What failed</th>}
            {!canInspect && <th style={{ width: "8rem" }}>Inspection</th>}
            <th style={{ width: "9rem" }}>Went to</th>
            {canDisposition && <th style={{ width: "5rem" }} />}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const needsVerdict = canInspect && l.verdict === null;
            return (
              <tr key={l.id}>
                <td className="tnum">{l.lineNo}</td>
                <td>
                  {l.description}
                  <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                    {[l.sku, l.tag, l.serial].filter(Boolean).join(" · ") || "Not in the catalogue"}
                  </span>
                </td>
                <td className="tnum text-right">
                  {l.quantity} {l.unit}
                </td>
                <td>
                  <Badge tone={CONDITION_TONE[l.condition] ?? "warning"}>
                    {l.condition.replace(/_/g, " ").toLowerCase()}
                  </Badge>
                  {l.conditionNotes && (
                    <span className="mt-0.5 block text-2xs text-muted">{l.conditionNotes}</span>
                  )}
                </td>
                {canInspect ? (
                  <>
                    <td>
                      {needsVerdict ? (
                        <>
                          <input type="hidden" name="lineId" value={l.id} />
                          <select
                            className="field"
                            name="verdict"
                            value={verdicts[l.id] ?? ""}
                            onChange={(e) => setVerdicts((v) => ({ ...v, [l.id]: e.target.value }))}
                          >
                            <option value="">Not yet</option>
                            <option value="PASS">Pass</option>
                            <option value="FAIL">Fail</option>
                          </select>
                        </>
                      ) : (
                        <Badge tone={l.verdict === "FAIL" ? "danger" : l.verdict === "PASS" ? "success" : "info"}>
                          {l.verdict === "NOT_INSPECTED" ? "Not IT" : (l.verdict ?? "—")}
                        </Badge>
                      )}
                    </td>
                    <td>
                      {needsVerdict && (
                        <input
                          className="field"
                          name="verdictNote"
                          value={notes[l.id] ?? ""}
                          onChange={(e) => setNotes((n) => ({ ...n, [l.id]: e.target.value }))}
                          placeholder={verdicts[l.id] === "FAIL" ? "Required" : ""}
                          required={verdicts[l.id] === "FAIL"}
                        />
                      )}
                      {!needsVerdict && (
                        <span className="text-2xs leading-4 text-muted">{l.dispositionNote ?? "—"}</span>
                      )}
                    </td>
                  </>
                ) : (
                  <td>
                    <Badge tone={l.verdict === "FAIL" ? "danger" : l.verdict === "PASS" ? "success" : "info"}>
                      {l.verdict === "NOT_INSPECTED" ? "Not IT" : (l.verdict ?? "Pending")}
                    </Badge>
                  </td>
                )}
                <td>
                  {l.disposition ? (
                    <Badge
                      tone={
                        l.disposition === "STACK"
                          ? "success"
                          : l.disposition === "REPAIR"
                            ? "warning"
                            : l.disposition === "DISPOSE"
                              ? "danger"
                              : "info"
                      }
                    >
                      {l.disposition.toLowerCase()}
                    </Badge>
                  ) : (
                    <span className="text-2xs text-[var(--c-text-tertiary)]">Undecided</span>
                  )}
                  {l.stacked && (
                    <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">In stock</span>
                  )}
                </td>
                {canDisposition && (
                  <td>
                    {!l.stacked && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => setDispositioning(l)}
                      >
                        Set
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <SectionCard
        title="Returned items"
        description="Verdicts are per line: one return holds a working monitor and a dead laptop, and a single verdict over both would send one of them to the wrong place."
        bodyClassName="px-0 py-0"
        actions={
          canHandOff ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setHandOff(true)}>
              Hand off to Repair &amp; Maintenance
            </button>
          ) : undefined
        }
      >
        {canInspect ? (
          <ActionForm
            action={inspectReturnAction}
            layout="bare"
            submitLabel="Record the inspection"
            hiddenFields={{ returnId }}
          >
            {table}
            <div className="px-3.5 py-3">
              <Field label="Inspection notes" name="inspectionNotes">
                <TextInput name="inspectionNotes" />
              </Field>
            </div>
            <div className="px-3.5 pb-3">
              <InlineAlert tone="info">
                A failed unit is dispositioned for Repair and Maintenance automatically — the SOP does not let a
                failure go back on the shelf, so the disposition follows the verdict rather than being a second
                decision somebody might make differently.
              </InlineAlert>
            </div>
          </ActionForm>
        ) : (
          table
        )}
      </SectionCard>

      <Modal
        open={handOff}
        onClose={() => setHandOff(false)}
        title="Hand off to Repair and Maintenance"
        description="ZAM/PUR/SOP-01: a unit that fails inspection is sent to the Repair and Maintenance department."
        size="md"
      >
        <ActionForm
          action={handOffToRepairAction}
          layout="bare"
          submitLabel="Record the hand-off"
          hiddenFields={{ returnId }}
          secondary={
            <button type="button" className="btn btn-secondary" onClick={() => setHandOff(false)}>
              Cancel
            </button>
          }
        >
          <Field
            label="Reference from Repair and Maintenance"
            name="reference"
            required
            hint="A hand-off with no reference cannot be chased."
          >
            <TextInput name="reference" required />
          </Field>
          <Field label="Note" name="note">
            <TextArea name="note" rows={2} />
          </Field>
        </ActionForm>
      </Modal>

      <Modal
        open={!!dispositioning}
        onClose={() => setDispositioning(null)}
        title={dispositioning ? `Line ${dispositioning.lineNo} — where it goes` : ""}
        size="md"
      >
        {dispositioning && (
          <ActionForm
            action={setDispositionAction}
            layout="bare"
            submitLabel="Record"
            hiddenFields={{ returnId, lineId: dispositioning.id }}
            secondary={
              <button type="button" className="btn btn-secondary" onClick={() => setDispositioning(null)}>
                Cancel
              </button>
            }
          >
            <p className="text-xs text-muted">
              <Mono className="text-2xs">{dispositioning.sku ?? dispositioning.tag ?? "—"}</Mono>{" "}
              {dispositioning.description}
            </p>
            <Field label="Where it goes" name="disposition" required>
              <Select
                name="disposition"
                required
                defaultValue={dispositioning.disposition ?? "STACK"}
                options={[
                  { value: "STACK", label: "Back into stock" },
                  { value: "REPAIR", label: "Repair and Maintenance" },
                  { value: "DISPOSE", label: "Disposal" },
                  { value: "HOLD", label: "Hold — decision pending" },
                ]}
              />
            </Field>
            <Field
              label="Why"
              name="note"
              hint="Required for anything other than stacking: it is a decision somebody should be able to read back."
            >
              <TextArea name="note" rows={2} defaultValue={dispositioning.dispositionNote ?? ""} />
            </Field>
          </ActionForm>
        )}
      </Modal>
    </>
  );
}
