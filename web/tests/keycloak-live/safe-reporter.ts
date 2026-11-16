import { rename } from "node:fs/promises";
import type { FullResult } from "@playwright/test/reporter";
import SafeAuthReporter from "../auth-live/safe-reporter.ts";

export default class KeycloakReporter extends SafeAuthReporter {
  override async onEnd(result: FullResult): Promise<void> {
    await super.onEnd(result);
    await rename("test-results/auth-live-summary.json", "test-results/keycloak-live-summary.json");
  }
}
