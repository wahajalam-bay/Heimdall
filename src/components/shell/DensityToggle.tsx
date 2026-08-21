"use client";

import { useState } from "react";
import { DENSITY_COOKIE, type Density } from "@/lib/nav-state";

/**
 * Row height for the day-long screens.
 *
 * Compact takes roughly a fifth off every table row and card gap, which is worth
 * several more rows on a 1080p display. Stored in a cookie, like the navigation
 * width, so the server renders the chosen density rather than correcting it after
 * hydration.
 */
export function DensityToggle({ initial = "comfortable" }: { initial?: Density }) {
  const [density, setDensity] = useState<Density>(initial);

  const apply = (next: Density) => {
    setDensity(next);
    document.documentElement.dataset.density = next;
    document.cookie = `${DENSITY_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  };

  const next: Density = density === "compact" ? "comfortable" : "compact";

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={() => apply(next)}
      title={`Switch to ${next} row height`}
      aria-label={`Row height: ${density}. Switch to ${next}.`}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
        <rect x="1.5" y="2" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.2" />
        {density === "compact" ? (
          <path d="M4 5.5h8M4 8h8M4 10.5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        ) : (
          <path d="M4 6.5h8M4 10h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        )}
      </svg>
    </button>
  );
}
