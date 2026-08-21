import { expect, test } from "@playwright/test";
import { ready } from "./helpers";

/**
 * The application shell: navigation rail, keyboard paths, density and charts.
 * These are the behaviours that only exist in a browser — everything here would
 * pass an HTTP check while being broken on screen.
 */

test.describe("navigation rail", () => {
  test("collapses to an icon rail, and stays collapsed across a reload", async ({ page }) => {
    await page.goto("/pr");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Purchase Requisitions" })).toBeVisible();

    const expanded = await page.locator("aside").first().evaluate((el) => el.getBoundingClientRect().width);
    await page.getByRole("button", { name: "Collapse navigation" }).click();

    // Labels go, icons stay, and the plate narrows.
    await expect(page.getByRole("button", { name: "Expand navigation" })).toBeVisible();
    await expect(nav.getByText("Purchase Requisitions", { exact: true })).toHaveCount(0);
    const collapsed = await page.locator("aside").first().evaluate((el) => el.getBoundingClientRect().width);
    expect(collapsed).toBeLessThan(expanded / 2);

    // The choice is a cookie, so the server renders it on the next request.
    await page.reload();
    await expect(page.getByRole("button", { name: "Expand navigation" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-nav", "rail");

    // Hovering a rail item names it, since the label is not on screen.
    await nav.getByRole("link", { name: /Purchase Requisitions/ }).hover();
    await expect(page.getByText("Purchase Requisitions", { exact: false }).last()).toBeVisible();

    await page.getByRole("button", { name: "Expand navigation" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-nav", "full");
  });

  test("Ctrl+B toggles the rail", async ({ page }) => {
    await page.goto("/po");
    await expect(page.locator("html")).toHaveAttribute("data-nav", "full");
    await page.keyboard.press("Control+b");
    await expect(page.locator("html")).toHaveAttribute("data-nav", "rail");
    await page.keyboard.press("Control+b");
    await expect(page.locator("html")).toHaveAttribute("data-nav", "full");
  });

  test("filters the navigation as you type", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByLabel("Filter navigation").fill("vend");
    await expect(nav.getByRole("link", { name: "Vendor Directory" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Purchase Requisitions" })).toHaveCount(0);
  });

  test("the module in view is published for the colour coding to follow", async ({ page }) => {
    for (const [path, module] of [
      ["/pr", "procurement"],
      ["/receiving", "operations"],
      ["/invoices", "finance"],
      ["/analytics/spend", "analytics"],
    ] as const) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("data-module", module);
    }
  });
});

test.describe("keyboard", () => {
  test("search opens on the shortcut and results are driven with the arrows", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Control+k");
    const search = page.getByLabel("Global search");
    await expect(search).toBeFocused();

    await search.fill("PR-2026");
    const results = page.getByRole("listbox", { name: "Search results" });
    await expect(results).toBeVisible();
    await expect(results.getByRole("option").first()).toBeVisible();

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page).not.toHaveURL(/\/$/);
  });

  test("? lists the shortcuts, and g-then-letter jumps", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Shift+Slash");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Go to")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await page.keyboard.press("g");
    await page.keyboard.press("r");
    await expect(page).toHaveURL(/\/pr$/);
  });

  test("skip link jumps past the navigation", async ({ page }) => {
    await page.goto("/pr");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
  });
});

test.describe("density", () => {
  test("compact shortens every row, and persists", async ({ page }) => {
    await page.goto("/pr");
    await ready(page);
    const firstCell = page.locator("table.dt tbody td").first();
    await expect(firstCell).toBeVisible();
    const comfortable = await firstCell.evaluate((el) => getComputedStyle(el).paddingTop);

    await page.getByRole("button", { name: /Row height/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
    const compact = await firstCell.evaluate((el) => getComputedStyle(el).paddingTop);
    expect(parseFloat(compact)).toBeLessThan(parseFloat(comfortable));

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");

    await page.getByRole("button", { name: /Row height/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-density", "comfortable");
  });
});

test.describe("charts", () => {
  for (const width of [1280, 1440, 1024]) {
    test(`fit their container at ${width}px, and refit when the rail collapses`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/analytics");
      // Charts live in cards on this page and in figures elsewhere; the plot is
      // identified by being a fluid SVG, not by its wrapper.
      const svg = page.locator('main svg[viewBox][width="100%"]').first();
      await expect(svg).toBeVisible();

      const overflowing = async () =>
        page.evaluate(() => {
          const body = document.body;
          return body.scrollWidth > body.clientWidth + 1;
        });
      expect(await overflowing()).toBe(false);

      // The plot must track its card, not a stale measurement.
      const before = await svg.evaluate((el) => el.getBoundingClientRect().width);
      await page.keyboard.press("Control+b");
      await expect(page.locator("html")).toHaveAttribute("data-nav", "rail");
      await page.waitForTimeout(400);
      const after = await svg.evaluate((el) => el.getBoundingClientRect().width);
      expect(after).toBeGreaterThan(before);
      expect(await overflowing()).toBe(false);

      await page.keyboard.press("Control+b");
    });
  }
});
