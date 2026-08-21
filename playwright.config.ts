import { defineConfig, devices } from "@playwright/test";

/**
 * Browser coverage for the things HTTP checks cannot see: a form actually
 * submitting, the navigation rail collapsing and staying collapsed, keyboard
 * paths, and charts fitting their container at real viewport widths.
 *
 * Runs against the production build on port 3737 and reuses a server that is
 * already up, so it can be pointed at a running instance during development.
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.artifacts",
  fullyParallel: false,
  workers: 1,
  // Every page here is rendered per request against SQLite; under a full-suite
  // load a soft navigation occasionally stalls. One retry keeps the signal about
  // the product rather than about the machine.
  retries: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3737",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      testIgnore: /approvals\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/admin.json" },
      dependencies: ["setup"],
    },
    {
      name: "approver",
      testMatch: /approvals\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/approver.json" },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: "npm run start",
    url: process.env.E2E_BASE_URL ?? "http://localhost:3737",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
