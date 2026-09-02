"use client";

/**
 * Last resort: an error thrown by the root layout itself, before the application
 * shell or its stylesheet exist. Everything here is inline because nothing else
 * can be relied on at this point.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          background: "#f7f8fa",
          color: "#16191f",
          font: "400 15px/1.55 ui-sans-serif, system-ui, sans-serif",
          padding: "2rem",
        }}
      >
        <main style={{ maxWidth: "26rem", textAlign: "center" }}>
          <div
            style={{
              width: 32,
              height: 32,
              margin: "0 auto 1rem",
              borderRadius: 8,
              background: "#0a7a45",
              color: "#fff",
              display: "grid",
              placeItems: "center",
              fontWeight: 700,
              fontSize: 13,
            }}
            aria-hidden
          >
            H
          </div>
          <h1 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>ProcurementOS could not start</h1>
          <p style={{ margin: "0.5rem 0 1.25rem", color: "#5a6172", fontSize: "0.875rem" }}>
            Nothing was changed. Reload to try again, and quote{" "}
            <code style={{ fontFamily: "ui-monospace, monospace" }}>{error.digest ?? "no reference"}</code> if
            you report it.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              border: "1px solid #0a7a45",
              background: "#0a7a45",
              color: "#fff",
              borderRadius: 6,
              padding: "0.4375rem 0.875rem",
              fontSize: "0.8125rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
