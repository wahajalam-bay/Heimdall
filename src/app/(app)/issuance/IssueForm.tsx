"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { ActionForm } from "@/components/ui/forms";
import { Field, FormSection, Select, TextArea, TextInput } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";
import { createIssueAction, stockForStore } from "@/app/(app)/stores/actions";
import { MovementEditor, type StockLine } from "./MovementEditor";

export function IssueForm({
  stores,
  departments,
  projects,
  users,
  initialStoreId,
  initialStock,
}: {
  stores: Array<{ id: string; code: string; name: string; kind: string }>;
  departments: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; code: string; name: string }>;
  users: Array<{ id: string; name: string; title: string | null }>;
  initialStoreId: string;
  initialStock: StockLine[];
}) {
  const [storeId, setStoreId] = useState(initialStoreId);
  const [stock, setStock] = useState<StockLine[]>(initialStock);
  const [loading, start] = useTransition();
  const [recipientUserId, setRecipientUserId] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [submit, setSubmit] = useState(true);

  // Availability is store-specific, so reload it whenever the store changes.
  useEffect(() => {
    if (storeId === initialStoreId) return;
    start(async () => {
      const rows = await stockForStore(storeId);
      setStock(rows);
    });
  }, [storeId, initialStoreId]);

  const chooseRecipient = (id: string) => {
    setRecipientUserId(id);
    const u = users.find((x) => x.id === id);
    if (u) setRecipientName(u.title ? `${u.name} — ${u.title}` : u.name);
  };

  return (
    <ActionForm
      action={createIssueAction}
      submitLabel={submit ? "Submit for store approval" : "Save draft"}
      hiddenFields={{ recipientUserId: recipientUserId || undefined, submit: submit ? "true" : "" }}
      onSuccessRedirect={(data) => {
        const d = data as { id?: string } | null;
        return d?.id ? `/issuance/${d.id}` : "/issuance";
      }}
      footerSticky
      secondary={
        <>
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-[var(--c-text-secondary)]">
            <input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} />
            Submit for approval immediately
          </label>
          <Link href="/issuance" className="btn btn-secondary">
            Cancel
          </Link>
        </>
      }
    >
      <InlineAlert tone="info">
        Issuing stock reduces inventory. Consumables are deducted; where an asset tag is given, custody transfers to the
        named person and the asset register is updated.
      </InlineAlert>

      <FormSection title="Issue detail" columns={3}>
        <Field label="Issuing store" name="storeId" required>
          <Select
            name="storeId"
            options={stores.map((s) => ({ value: s.id, label: `${s.name} · ${humanize(s.kind)}` }))}
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
          />
        </Field>
        <Field label="Recipient (internal user)" name="recipientUserSelect" hint="Optional — fills the name below.">
          <Select
            name="recipientUserSelect"
            placeholder="Select a person…"
            options={users.map((u) => ({ value: u.id, label: `${u.name}${u.title ? ` — ${u.title}` : ""}` }))}
            value={recipientUserId}
            onChange={(e) => chooseRecipient(e.target.value)}
          />
        </Field>
        <Field label="Issued to" name="recipientName" required hint="Who physically takes the stock.">
          <TextInput name="recipientName" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
        </Field>
        <Field label="Department" name="departmentId">
          <Select
            name="departmentId"
            placeholder="Not department specific"
            options={departments.map((d) => ({ value: d.id, label: d.name }))}
          />
        </Field>
        <Field label="Project" name="projectId">
          <Select
            name="projectId"
            placeholder="Not project related"
            options={projects.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }))}
          />
        </Field>
        <Field label="Purpose" name="purpose" required span>
          <TextArea name="purpose" rows={2} placeholder="What the stock is needed for." />
        </Field>
      </FormSection>

      <FormSection title="Items to issue" columns={1}>
        <div className="sm:col-span-full">
          {loading ? (
            <p className="text-xs text-[var(--c-text-secondary)]">Loading availability for the selected store…</p>
          ) : (
            <MovementEditor
              stock={stock}
              showCustody
              users={users}
              emptyMessage="This store currently holds no free stock. Receive goods or transfer stock in before issuing."
            />
          )}
        </div>
      </FormSection>
    </ActionForm>
  );
}
