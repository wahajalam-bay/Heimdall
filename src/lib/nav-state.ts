/**
 * Where the navigation width lives.
 *
 * A cookie rather than local storage, so the server renders the sidebar at the
 * width the user chose instead of correcting it after hydration.
 */
export const NAV_COOKIE = "heimdall_nav";

/** Row height. Same reasoning as the navigation width: the server needs to know. */
export const DENSITY_COOKIE = "heimdall_density";

export type Density = "comfortable" | "compact";

export function isDensity(value: string | undefined): value is Density {
  return value === "comfortable" || value === "compact";
}
