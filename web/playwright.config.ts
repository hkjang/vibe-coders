import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.APP_BASE_URL ?? "http://127.0.0.1:4173/app/",
    timezoneId: "Asia/Seoul",
    trace: "retain-on-failure",
  },
  webServer: process.env.APP_BASE_URL
    ? undefined
    : {
        command: "pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort",
        url: "http://127.0.0.1:4173/app/",
        reuseExistingServer: !process.env.CI,
      },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
