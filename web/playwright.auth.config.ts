import { defineConfig, devices } from "@playwright/test";

// Started only by the opt-in Go harness. Never fall back to a development
// server or a deployment supplied through an ambient environment variable.
const baseURL = process.env.APP_BASE_URL;
if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1") {
  throw new Error("The live authentication suite requires the isolated Go harness.");
}

export default defineConfig({
  testDir: "./tests/auth-live",
  testMatch: "auth-live.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["./tests/auth-live/safe-reporter.ts"]],
  outputDir: "./test-results/auth-live-private",
  preserveOutput: "never",
  use: {
    baseURL,
    timezoneId: "Asia/Seoul",
    trace: "off",
    video: "off",
    screenshot: "off",
    serviceWorkers: "block",
  },
  projects: [{ name: "chromium-live-auth", use: { ...devices["Desktop Chrome"] } }],
});
