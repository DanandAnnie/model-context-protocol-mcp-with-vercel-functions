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
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    // Chromium names a download in the system's file-name encoding; a container with no locale set (C/POSIX) saves
    // any non-ASCII name as "download". Desktops run a UTF-8 locale, so the browser gets one here too.
    launchOptions: { env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } },
  },
  projects: [
    { name: "open", testMatch: /studio\.spec\.ts/, use: { baseURL: "http://localhost:3100" } },
    { name: "password", testMatch: /password\.spec\.ts/, use: { baseURL: "http://localhost:3102" } },
  ],
  webServer: [
    { command: "npx next start -p 3100", url: "http://localhost:3100/api/status", reuseExistingServer: !process.env.CI, timeout: 120_000, env: { APP_URL: "http://localhost:3100" } },
    {
      command: "npx next start -p 3102",
      url: "http://localhost:3102/",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { STUDIO_PASSWORD: "hunter2", APP_URL: "http://localhost:3102" },
    },
  ],
});
