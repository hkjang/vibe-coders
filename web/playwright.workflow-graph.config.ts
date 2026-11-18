import { defineConfig } from "@playwright/test";
import authConfig from "./playwright.auth.config";
export default defineConfig(authConfig, {
  testMatch: ["workflow-graph-live.spec.ts"],
  reporter: [["./tests/auth-live/safe-reporter.ts", { report: "workflow-graph" }]],
});
