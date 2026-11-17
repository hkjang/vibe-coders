import { defineConfig } from "@playwright/test";
import authConfig from "./playwright.auth.config";

export default defineConfig(authConfig, {
  testMatch: ["routing-draft-live.spec.ts"],
  reporter: [["./tests/auth-live/safe-reporter.ts", { report: "routing-draft" }]],
});
