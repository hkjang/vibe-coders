import { expect } from "@playwright/test";
import {
  test as routingTest,
  listPath,
  type RoutingToggleGateway,
} from "../../fixtures/routing-toggle-review-gateway";

export {
  firstEmail,
  rule,
  ruleA,
  ruleB,
  routingUrl,
  listPath,
} from "../../fixtures/routing-toggle-review-gateway";

type DeleteCall = { method: string; path: string; body: string | null };
type Deleter = {
  calls: DeleteCall[];
  hold: () => void;
  release: () => void;
  ack: (value: unknown) => void;
  failFollowingRead: () => void;
};

/** Transport only. Deletion is committed before a held/malformed ACK; abort is not rollback. */
export const test = routingTest.extend<{ deleter: Deleter }>({
  deleter: async ({ context, gateway }, runTest) => {
    const calls: DeleteCall[] = [];
    let gate: Promise<void> | undefined;
    let release: (() => void) | undefined;
    let acknowledgement: { value: unknown } | undefined;
    let failRead = false;
    await context.route("**/admin/routing-rules/*", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      const body = request.postData();
      calls.push({ method, path, body });
      expect(method).toBe("DELETE");
      expect(body).toBeNull();
      expect(request.headers()["x-vibe-ui"]).toBe("app");
      const id = decodeURIComponent(path.slice(listPath.length + 1));
      // Existing Go DELETE is idempotent and does not report affected rows.
      // Do not enforce feature/scopes or review guards on behalf of the UI.
      gateway.setRows(gateway.records().filter((row) => row.id !== id));
      await gate;
      if (failRead) gateway.setStatus("list", 503);
      await route.fulfill({
        status: 200,
        json: acknowledgement ? acknowledgement.value : { id, status: "deleted" },
      });
    });
    try {
      await runTest({
        calls,
        hold: () => {
          gate = new Promise<void>((resolve) => {
            release = resolve;
          });
        },
        release: () => {
          release?.();
          gate = undefined;
        },
        ack: (value) => {
          acknowledgement = { value };
        },
        failFollowingRead: () => {
          failRead = true;
        },
      });
    } finally {
      release?.();
    }
  },
});

export function mutationCount(gateway: RoutingToggleGateway, deleter: Deleter): number {
  return deleter.calls.length + gateway.operations.filter((call) => call.action === "patch").length;
}
