"use client";

import Link from "next/link";
import { useEffect } from "react";
import { ErrorState, Mono, PageHeader } from "@/components/ui/primitives";

/**
 * Catches anything a page throws that it did not handle itself.
 *
 * The message is deliberately not the raw exception: server errors are opaque in
 * production anyway, and the useful part for whoever is on the phone to support
 * is the digest. Retrying re-runs the server render, which is usually enough when
 * the cause was transient.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaced in the browser console for whoever is debugging the session.
    console.error(error);
  }, [error]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Error"
        title="This screen could not be loaded"
        subtitle="Nothing was changed. The action you were taking has not been recorded, so it is safe to try again."
      />
      <div className="card">
        <ErrorState
          title="The page stopped while loading its data"
          description={
            <>
              Try again — if it keeps happening, quote this reference when you report it:{" "}
              <Mono>{error.digest ?? "no reference"}</Mono>
            </>
          }
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => reset()}>
                Try again
              </button>
              <Link href="/" className="btn btn-secondary btn-sm">
                Go to the dashboard
              </Link>
            </div>
          }
        />
      </div>
    </div>
  );
}
