import { defineConfig } from "@playwright/test";
import authConfig from "./playwright.auth.config";

// Same loopback-only, secret-safe runner; separate database, result and scope.
export default defineConfig(authConfig, {
  testMatch: ["simulation-live.spec.ts"],
  reporter: [["./tests/auth-live/safe-reporter.ts", { report: "simulation" }]],
});
