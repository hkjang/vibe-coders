import { defineConfig, devices } from "@playwright/test";
import { isAbsolute, resolve } from "node:path";

const baseURL = process.env.APP_BASE_URL;
const scratch = process.env.TMPDIR;
if (
  process.env.VIBE_PROVIDER_CONNECTION_BROWSER_TEST !== "1" ||
  !baseURL ||
  new URL(baseURL).hostname !== "127.0.0.1" ||
  !scratch ||
  !isAbsolute(scratch)
) {
  throw new Error("The provider connection suite requires the isolated Go harness.");
}
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
  testDir: "./tests/provider-connection-live",
  testMatch: "provider-connection.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: [["./tests/provider-connection-live/safe-reporter.ts"]],
  outputDir: resolve(scratch, "provider-connection-private"),
  preserveOutput: "never",
  use: {
    baseURL,
    actionTimeout: 10_000,
    timezoneId: "Asia/Seoul",
    trace: "off",
    video: "off",
    screenshot: "off",
    serviceWorkers: "block",
  },
  projects: [{ name: "chromium-live-provider", use: { ...devices["Desktop Chrome"] } }],
});
