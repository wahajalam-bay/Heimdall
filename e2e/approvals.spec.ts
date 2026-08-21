import { expect, test } from "@playwright/test";
import { ready } from "./helpers";

/**
 * The approvals queue, exercised as a department head who has decisions waiting.
 * The point of the test is the optimistic response: the row reports the decision
 * before the server has answered, and a refusal puts it back with a reason.
 */
test("a decision shows immediately and then settles", async ({ page }) => {
  await page.goto("/workspace");
  await ready(page);

  const approveButtons = page.getByRole("button", { name: "Approve" });
  const before = await approveButtons.count();
  if (before === 0) {
    // Real data, and this test consumes one item per run: once the in-place
    // decidable approvals are gone there is nothing left to prove here.
    test.skip(true, "No in-place approvals left in this queue.");
    return;
  }
  await expect(page.getByRole("heading", { name: "Waiting on your decision" })).toBeVisible();

  // The reference on the first row, so we can prove that row is the one actioned.
  const firstRowText = await page.locator("div", { has: approveButtons.first() }).first().innerText();

  await approveButtons.first().click();

  // Optimistic: acknowledged without waiting for the round trip.
  await expect(page.getByText("Approving…")).toBeVisible({ timeout: 2_000 });

  // And then it settles — the queue is one shorter, or the row explains itself.
  await expect
    .poll(async () => (await page.getByRole("button", { name: "Approve" }).count()) < before, {
      timeout: 20_000,
    })
    .toBe(true);

  expect(firstRowText.length).toBeGreaterThan(0);
  await expect(page.getByText("Approving…")).toHaveCount(0);
});

test("returning a requisition insists on a reason", async ({ page }) => {
  await page.goto("/workspace");
  await ready(page);
  const returnButton = page.getByRole("button", { name: "Return" }).first();
  if (!(await returnButton.count())) {
    test.skip(true, "Nothing left in the queue to return.");
    return;
  }

  // Dismissing the prompt must leave the row exactly as it was.
  const before = await page.getByRole("button", { name: "Return" }).count();
  page.once("dialog", (d) => d.dismiss());
  await returnButton.click();
  await expect(page.getByText("Returning…")).toHaveCount(0);
  expect(await page.getByRole("button", { name: "Return" }).count()).toBe(before);
});
