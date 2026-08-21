"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, Spinner } from "@/components/ui/forms";
import { Checkbox } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { money } from "@/lib/format";
import { addCasesToMeetingAction } from "@/app/(app)/cpc/actions";

/** Pulls unscheduled cases onto an existing meeting's agenda. */
export function AgendaPicker({
  meetingId,
  cases,
}: {
  meetingId: string;
  cases: Array<{ id: string; number: string; title: string; amount: number; prNumber: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const submit = () => {
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.set("meetingId", meetingId);
      for (const id of selected) fd.append("caseIds", id);
      const res = await addCasesToMeetingAction(fd);
      if (res.ok) {
        setOpen(false);
        setSelected([]);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  };

  return (
    <>
      <button type="button" className="btn btn-secondary btn-xs" onClick={() => setOpen(true)}>
        Add cases
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add cases to this agenda"
        description="Only unscheduled cases from the same entity are offered."
        size="lg"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={submit}
              disabled={pending || selected.length === 0}
            >
              {pending && <Spinner size={12} />}
              Add {selected.length > 0 ? `${selected.length} case(s)` : "cases"}
            </button>
          </>
        }
      >
        <div className="space-y-1.5">
          {cases.map((c) => (
            <Checkbox
              key={c.id}
              label={`${c.number} — ${c.title}`}
              hint={`${c.prNumber} · ${money(c.amount)}`}
              checked={selected.includes(c.id)}
              onChange={() => setSelected((p) => (p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p, c.id]))}
            />
          ))}
        </div>
        {error && (
          <div className="mt-3">
            <InlineAlert tone="danger">{error}</InlineAlert>
          </div>
        )}
      </Modal>
    </>
  );
}
