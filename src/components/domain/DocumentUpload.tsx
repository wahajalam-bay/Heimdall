"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui/forms";
import { CONFIDENTIALITY_LEVELS, humanize } from "@/lib/domain";
import { uploadDocumentAction } from "@/app/(app)/pr/actions";

export type DocTypeOption = { code: string; name: string; category: string; allowedExtensions: string };

/**
 * Linked document upload. A document can never be uploaded without a business
 * object, which is enforced again server-side.
 */
export function DocumentUpload({
  linkedType,
  linkedId,
  caseKey,
  entityId,
  documentTypes,
  defaultCategory,
}: {
  linkedType: string;
  linkedId: string;
  caseKey: string | null;
  entityId: string | null;
  documentTypes: DocTypeOption[];
  defaultCategory?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState(
    documentTypes.find((d) => d.category === defaultCategory)?.code ?? documentTypes[0]?.code ?? "",
  );
  const [description, setDescription] = useState("");
  const [confidentiality, setConfidentiality] = useState("INTERNAL");

  const selected = documentTypes.find((d) => d.code === docType);

  const submit = () => {
    if (!file) {
      setError("Choose a file to upload.");
      return;
    }
    setError(null);
    setOk(null);
    start(async () => {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("linkedType", linkedType);
      fd.set("linkedId", linkedId);
      if (caseKey) fd.set("caseKey", caseKey);
      if (entityId) fd.set("entityId", entityId);
      if (docType) fd.set("documentTypeCode", docType);
      if (selected) fd.set("category", selected.category);
      if (description.trim()) fd.set("description", description.trim());
      fd.set("confidentiality", confidentiality);
      const res = await uploadDocumentAction(null, fd);
      if (res.ok) {
        setOk(res.message ?? "Uploaded.");
        setFile(null);
        setDescription("");
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  };

  return (
    <div className="space-y-2.5">
      <div className="grid gap-2.5 sm:grid-cols-[1fr_11rem_9rem_auto] sm:items-end">
        <label className="block">
          <span className="mb-1 block text-2xs font-500 text-muted">File</span>
          <input
            type="file"
            className="field py-1.5"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError(null);
            }}
            accept={selected ? selected.allowedExtensions.split(",").map((x) => `.${x.trim()}`).join(",") : undefined}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-2xs font-500 text-muted">Document type</span>
          <select className="field" value={docType} onChange={(e) => setDocType(e.target.value)}>
            {documentTypes.map((d) => (
              <option key={d.code} value={d.code}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-2xs font-500 text-muted">Access</span>
          <select className="field" value={confidentiality} onChange={(e) => setConfidentiality(e.target.value)}>
            {CONFIDENTIALITY_LEVELS.map((c) => (
              <option key={c} value={c}>
                {humanize(c)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-secondary" onClick={submit} disabled={pending || !file}>
          {pending && <Spinner size={12} />}
          Upload
        </button>
      </div>
      <input
        className="field"
        placeholder="Optional description — what this document is and which revision"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      {error && (
        <p className="rounded-2xl alert-danger px-2.5 py-1.5 text-2xs text-[var(--c-danger)]">
          {error}
        </p>
      )}
      {ok && (
        <p className="rounded-2xl alert-success px-2.5 py-1.5 text-2xs text-[var(--c-success)]">
          {ok}
        </p>
      )}
    </div>
  );
}
