"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/forms";
import { Badge, Mono } from "@/components/ui/primitives";
import { humanize } from "@/lib/domain";

/**
 * Opens a document where the reader is.
 *
 * Reviewing a mill certificate against a GRN line means holding both in mind, and
 * a new browser tab breaks that. PDFs and images render in place; anything else
 * says plainly that it has to be downloaded rather than pretending to preview it.
 * The bytes come from the same guarded route as the download, so access is
 * re-checked and logged either way.
 */
export function DocumentPreview({
  id,
  name,
  mimeType,
  filename,
  confidentiality,
}: {
  id: string;
  name: string;
  mimeType: string;
  filename: string;
  confidentiality: string;
}) {
  const [open, setOpen] = useState(false);

  const kind = mimeType.startsWith("image/")
    ? "image"
    : mimeType === "application/pdf"
      ? "pdf"
      : mimeType.startsWith("text/")
        ? "text"
        : "other";

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-xs shrink-0"
        onClick={() => setOpen(true)}
        title="Preview without leaving the page — access is logged"
      >
        Preview
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={name}
        size="xl"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Mono>{filename}</Mono>
            <Badge tone="neutral">{humanize(confidentiality)}</Badge>
            <span className="text-2xs text-[var(--c-text-tertiary)]">Opening this is recorded in the audit trail</span>
          </span>
        }
        footer={
          <div className="flex flex-wrap items-center gap-2">
            <a href={`/api/documents/${id}?download=1`} className="btn btn-secondary btn-sm">
              Download
            </a>
            <a
              href={`/api/documents/${id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost btn-sm"
            >
              Open in a new tab
            </a>
          </div>
        }
      >
        {kind === "image" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/documents/${id}`}
            alt={name}
            className="mx-auto max-h-[70vh] w-auto max-w-full rounded-lg border border-border"
          />
        )}

        {(kind === "pdf" || kind === "text") && (
          <iframe
            src={`/api/documents/${id}`}
            title={name}
            className="h-[70vh] w-full rounded-lg border border-border bg-surface-secondary"
          />
        )}

        {kind === "other" && (
          <p className="px-2 py-10 text-center text-xs text-muted">
            This file type cannot be shown in the browser. Download it to open in the right application.
          </p>
        )}
      </Modal>
    </>
  );
}
