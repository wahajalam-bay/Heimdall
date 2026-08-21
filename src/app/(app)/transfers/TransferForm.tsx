"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { createTransferAction, stockForStore } from "@/app/(app)/stores/actions";
import { MovementEditor, type StockLine } from "@/app/(app)/issuance/MovementEditor";

export function TransferForm({
  stores,
  initialFromStoreId,
  initialStock,
}: {
  stores: Array<{ id: string; code: string; name: string; kind: string; entityId: string }>;
  initialFromStoreId: string;
  initialStock: StockLine[];
}) {
  const [fromStoreId, setFromStoreId] = useState(initialFromStoreId);
  const [toStoreId, setToStoreId] = useState("");
  const [stock, setStock] = useState<StockLine[]>(initialStock);
  const [loading, start] = useTransition();
  const [submit, setSubmit] = useState(true);

  useEffect(() => {
    if (fromStoreId === initialFromStoreId) return;
    start(async () => {
      const rows = await stockForStore(fromStoreId);
      setStock(rows);
    });
  }, [fromStoreId, initialFromStoreId]);

  const from = stores.find((s) => s.id === fromStoreId);
  const to = stores.find((s) => s.id === toStoreId);
  const crossEntity = useMemo(
    () => !!from && !!to && from.entityId !== to.entityId,
    [from, to],
  );

  return (
    <ActionForm
      action={createTransferAction}
      submitLabel={submit ? "Submit for approval" : "Save draft"}
      hiddenFields={{ submit: submit ? "true" : "" }}
      onSuccessRedirect={(data) => {
        const d = data as { id?: string } | null;
        return d?.id ? `/transfers/${d.id}` : "/transfers";
      }}
      footerSticky
      secondary={
        <>
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-[var(--c-text-secondary)]">
            <input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} />
            Submit for approval immediately
          </label>
          <Link href="/transfers" className="btn btn-secondary">
            Cancel
          </Link>
        </>
      }
    >
      <InlineAlert tone="info">
        A transfer moves stock between stores in two recorded steps: dispatch reduces the source store, receipt increases
        the destination. Stock in transit belongs to neither store balance.
      </InlineAlert>

      <FormSection title="Route" columns={2}>
        <Field label="From store" name="fromStoreId" required hint="Stock is drawn from this store on dispatch.">
          <Select
            name="fromStoreId"
            options={stores.map((s) => ({ value: s.id, label: `${s.name} · ${humanize(s.kind)}` }))}
            value={fromStoreId}
            onChange={(e) => setFromStoreId(e.target.value)}
          />
        </Field>
        <Field label="To store" name="toStoreId" required hint="Destination store receives the stock on arrival.">
          <Select
            name="toStoreId"
            placeholder="Select destination…"
            options={stores
              .filter((s) => s.id !== fromStoreId)
              .map((s) => ({ value: s.id, label: `${s.name} · ${humanize(s.kind)}` }))}
            value={toStoreId}
            onChange={(e) => setToStoreId(e.target.value)}
          />
        </Field>
        <Field label="Reason for transfer" name="reason" required span hint="Why the stock needs to move.">
          <TextArea
            name="reason"
            rows={2}
            placeholder="e.g. Site 2 has run short of cement ahead of the Thursday pour; central warehouse holds surplus."
          />
        </Field>
      </FormSection>

      {crossEntity && (
        <InlineAlert tone="warning">
          {from?.name} and {to?.name} belong to different entities. This transfer moves value between legal entities and
          will need finance to record the inter-company charge.
        </InlineAlert>
      )}

      <FormSection title="Items to transfer" columns={1}>
        <div className="sm:col-span-full">
          {loading ? (
            <p className="text-xs text-[var(--c-text-secondary)]">Loading availability for the source store…</p>
          ) : (
            <MovementEditor
              stock={stock}
              emptyMessage="The source store holds no free stock to transfer."
            />
          )}
        </div>
      </FormSection>
    </ActionForm>
  );
}
