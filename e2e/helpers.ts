import type { Page } from "@playwright/test";

/**
 * Waits until the page is interactive.
 *
 * Sorting, tabs and row clicks are client behaviour, and a click that lands
 * before hydration is silently dropped — which looks exactly like a broken
 * feature. Every spec that clicks something client-driven waits here first.
 */
export async function ready(page: Page) {
  await page.waitForLoadState("networkidle");
}
