import Link from "next/link";

export const metadata = { title: "Not found" };

/**
 * For addresses outside the signed-in application — a mistyped or stale link
 * followed before signing in. Deliberately self-contained: there is no session
 * here, so there is no navigation to render around it.
 */
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6 py-16">
      <div className="max-w-md text-center">
        <span
          className="mx-auto mb-4 flex size-8 items-center justify-center rounded-xl text-xs font-700 text-white"
          style={{ background: "var(--c-accent)" }}
          aria-hidden
        >
          H
        </span>
        <h1 className="text-[1.375rem] leading-7 font-600 tracking-[-0.018em]">This page does not exist</h1>
        <p className="mt-2 text-[0.8125rem] leading-5 text-muted">
          Check the address, or sign in and use the search in the top bar to find the document by its number.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Link href="/" className="btn btn-primary btn-sm">
            Go to ProcurementOS
          </Link>
          <Link href="/login" className="btn btn-secondary btn-sm">
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
