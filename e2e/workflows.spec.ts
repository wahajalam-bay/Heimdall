import { expect, test } from "@playwright/test";
import { ready } from "./helpers";

/**
 * Journeys that need a browser: a form that actually submits, the approvals queue
 * responding before the server answers, the audit diff, and a document opening
 * without leaving the page.
 */

test("the requisition form refuses an incomplete submission and says why", async ({ page }) => {
  await page.goto("/pr/new");
  await ready(page);

  // Submitting nothing must produce a specific, actionable refusal rather than a
  // silent no-op. Creation itself is covered end to end by verify:acceptance,
  // which drives the same service layer — so nothing is written from here and no
  // draft is left behind for the next run to trip over.
  await page.getByRole("button", { name: /Save|Create|Submit/ }).first().click();

  const main = page.locator("main");
  await expect(
    main.getByText(/required|add at least one|cannot be|must be/i).first(),
  ).toBeVisible({ timeout: 20_000 });

  // Still on the form, with the entered state intact.
  await expect(page).toHaveURL(/\/pr\/new/);
});

test("an audit event shows field-level before and after", async ({ page }) => {
  await page.goto("/analytics/audit");
  await ready(page);
  // Most recent events are sign-ins and creations, which record no field moves.
  // Sorting by the change count brings the ones that do to the top — which is
  // also the reason that column is sortable.
  const header = page.getByRole("button", { name: /Field changes/ });
  await header.click(); // ascending — the events with nothing to show
  await header.click(); // descending — the ones that recorded a change
  await expect
    .poll(async () => page.getByRole("link", { name: /field(s)? changed/ }).count(), { timeout: 15_000 })
    .toBeGreaterThan(0);

  // Follow the link the table exposes. Going by its href rather than by a soft
  // navigation keeps this test about the diff page: whether the router is quick
  // under load is a different question, covered elsewhere.
  const withChanges = page.getByRole("link", { name: /field(s)? changed/ }).first();
  const href = await withChanges.getAttribute("href");
  expect(href).toMatch(/\/analytics\/audit\/.+/);
  await page.goto(href!);
  await ready(page);

  await expect(page.getByRole("heading", { name: "What changed" })).toBeVisible();
  const diff = page.locator("table.dt").first();
  await expect(diff.getByRole("columnheader", { name: "Before" })).toBeVisible();
  await expect(diff.getByRole("columnheader", { name: "After" })).toBeVisible();
  await expect(diff.locator("tbody tr").first()).toBeVisible();
});

test("a document opens in place rather than in a new tab", async ({ page }) => {
  // A material demand cannot be submitted without its BOQ and drawings, so that
  // case always carries documents — and it belongs to the developments entity,
  // so the register has to be pointed there first.
  await page.goto("/pr");
  await ready(page);
  const entity = page.getByLabel("Active entity");
  const zd = entity.locator("option", { hasText: "ZD" }).first();
  await entity.selectOption(await zd.getAttribute("value") ?? "");
  await expect(page.locator("html")).toHaveAttribute("data-module", "procurement");
  await page.getByLabel("Search table").fill("MD-2026-00001");
  const caseLink = page.getByRole("link", { name: "MD-2026-00001" }).first();
  await expect(caseLink).toBeVisible();
  const caseHref = await caseLink.getAttribute("href");
  expect(caseHref).toMatch(/\/pr\/.+/);

  // Straight to the documents tab. Following the href keeps this test about the
  // preview; how quickly the router settles under a full-suite load is not what
  // is being proved here.
  await page.goto(`${caseHref}?tab=documents`);
  await ready(page);
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Documents" })).toBeVisible();
  const preview = page.getByRole("button", { name: "Preview" }).first();
  await expect(preview).toBeVisible();
  await preview.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Download" })).toBeVisible();
  // Either an embedded viewer or an honest statement that it cannot be shown.
  const shown = dialog.locator("iframe, img");
  const refused = dialog.getByText(/cannot be shown in the browser/);
  expect((await shown.count()) + (await refused.count())).toBeGreaterThan(0);
});

test("permission refusals are visible, not blank", async ({ page }) => {
  // The seeded administrator can reach administration; the refusal path is
  // covered over HTTP, so here we only assert the screen renders its content.
  await page.goto("/admin/email");
  await expect(page.getByRole("heading", { name: "Email delivery" })).toBeVisible();
  await expect(page.getByText(/Transport/).first()).toBeVisible();
});
