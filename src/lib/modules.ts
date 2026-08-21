/**
 * Module identity colours.
 *
 * Each area of the system owns one hue, so a screen announces where you are
 * before you read its title: the navigation group marker, the active nav row,
 * the page eyebrow and the rule under the top bar all resolve to the same
 * `--c-mod` value. The hues are the validated categorical set, so a module
 * colour and a chart series can never disagree.
 */
export const MODULE_KEYS = [
  "home",
  "procurement",
  "operations",
  "vendors",
  "cpc",
  "finance",
  "assets",
  "analytics",
  "admin",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

/** Navigation group label → module key. Group labels are the source of truth. */
export function moduleForGroup(label: string): ModuleKey {
  const key = label.trim().toLowerCase();
  return (MODULE_KEYS as readonly string[]).includes(key) ? (key as ModuleKey) : "home";
}

/**
 * The custom property holding a module's hue. The navigation plate is a deep
 * green in both themes, so it needs its own brighter set rather than the one
 * tuned for page surfaces.
 */
export function moduleColor(key: ModuleKey, on: "page" | "rail" = "page") {
  return on === "rail" ? `var(--c-nav-mod-${key})` : `var(--c-mod-${key})`;
}
