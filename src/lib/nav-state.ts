/**
 * Where the navigation width lives.
 *
 * A cookie rather than local storage, so the server renders the sidebar at the
 * width the user chose instead of correcting it after hydration.
 */
export const NAV_COOKIE = "procurementos_nav";

/** Row height. Same reasoning as the navigation width: the server needs to know. */
export const DENSITY_COOKIE = "procurementos_density";

export type Density = "comfortable" | "compact";

export function isDensity(value: string | undefined): value is Density {
  return value === "comfortable" || value === "compact";
}
