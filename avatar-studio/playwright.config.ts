import { defineConfig, devices } from "@playwright/test";

// Two servers from the same production build: open mode on 3100, password mode on 3102.
// Run `npm run build` first; `npm run e2e` starts both servers itself.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
  projects: [
    { name: "open", testMatch: /studio\.spec\.ts/, use: { baseURL: "http://localhost:3100" } },
    { name: "password", testMatch: /password\.spec\.ts/, use: { baseURL: "http://localhost:3102" } },
  ],
  webServer: [
    { command: "npx next start -p 3100", url: "http://localhost:3100/api/status", reuseExistingServer: !process.env.CI, timeout: 120_000 },
    {
      command: "npx next start -p 3102",
      url: "http://localhost:3102/",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { STUDIO_PASSWORD: "hunter2" },
    },
  ],
});
