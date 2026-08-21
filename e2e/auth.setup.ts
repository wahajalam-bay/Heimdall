import { test as setup, expect } from "@playwright/test";

const ADMIN_STATE = "e2e/.auth/admin.json";
const APPROVER_STATE = "e2e/.auth/approver.json";

/** Signs in through the real form and keeps the session for the other specs. */
async function signIn(page: import("@playwright/test").Page, email: string, state: string) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("Passw0rd!");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible({ timeout: 30_000 });
  await page.context().storageState({ path: state });
}

setup("sign in as the system administrator", async ({ page }) => {
  await signIn(page, "system.admin@zameen.com", ADMIN_STATE);
});

/**
 * An approver, because the queue only exists for somebody who actually has
 * decisions waiting — as an administrator the spec would prove nothing but that
 * the empty state renders. Override with E2E_APPROVER when the seeded queue for
 * this account has been worked through.
 */
setup("sign in as an approver with work waiting", async ({ page }) => {
  await signIn(page, process.env.E2E_APPROVER ?? "asim.javed@zameen.com", APPROVER_STATE);
});
