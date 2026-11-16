import { defineConfig, devices } from "@playwright/test";
import { isAbsolute, resolve } from "node:path";

if (process.env.APP_BASE_URL !== "https://127.0.0.1:4187") {
  throw new Error("The product suite requires its isolated HTTPS gateway.");
}
const scratch = process.env.TMPDIR;
if (!scratch || !isAbsolute(scratch)) throw new Error("Private harness scratch is required.");
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
  testDir: "./tests/keycloak-live",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 40_000,
  expect: { timeout: 8_000 },
  reporter: [["./tests/keycloak-live/safe-reporter.ts"]],
  outputDir: resolve(scratch, "keycloak-browser-private"),
  preserveOutput: "never",
  use: {
    baseURL: process.env.APP_BASE_URL,
    timezoneId: "Asia/Seoul",
    trace: "off",
    screenshot: "off",
    video: "off",
    serviceWorkers: "block",
    // The fixture has ephemeral certificates; this tests HTTPS/cookie/redirect
    // behavior, not browser CA validation or a production certificate deployment.
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: "keycloak-https", use: { ...devices["Desktop Chrome"] } }],
});
