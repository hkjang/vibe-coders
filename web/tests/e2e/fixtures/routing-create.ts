import { expect } from "@playwright/test";
import type { RoutingRuleInput } from "../../../src/shared/api/domains/routing";
import { test as routingTest, listPath } from "../../fixtures/routing-toggle-review-gateway";

export { firstEmail, routingUrl, listPath, rule, ruleB } from "../../fixtures/routing-toggle-review-gateway";

type CreateCall = { method: string; path: string; body: RoutingRuleInput };
type Creator = {
  calls: CreateCall[];
  hold: () => void;
  release: () => void;
  ack: (value: unknown) => void;
  failFollowingRead: () => void;
};

/** Synthetic transport only: no feature/scope/review guard replaces the UI. */
export const test = routingTest.extend<{ creator: Creator }>({
  creator: async ({ context, gateway }, runTest) => {
    const calls: CreateCall[] = [];
    let gate: Promise<void> | undefined;
    let release: (() => void) | undefined;
    let acknowledgement: { value: unknown } | undefined;
    let failRead = false;
    await context.route(/\/admin\/routing-rules(?:\?.*)?$/, async (route) => {
      const request = route.request();
      if (request.method() === "GET") return route.fallback();
      const method = request.method();
      const path = new URL(request.url()).pathname;
      const body = request.postDataJSON() as RoutingRuleInput;
      calls.push({ method, path, body: structuredClone(body) });
      expect(method).toBe("POST");
      expect(path).toBe(listPath);
      expect(request.headers()["x-vibe-ui"]).toBe("app");
      // Commit precedes fulfillment. The actual Go create ACK uses its original
      // zero timestamp, while GET returns the timestamp filled by the store.
      // Synthetic sequential IDs do not prove global server uniqueness.
      const stored = {
        ...body,
        id: `route_created_${calls.length}`,
        created_at: "2026-10-02T00:00:00Z",
      };
      gateway.setRows([...gateway.records(), stored]);
      await gate;
      if (failRead) gateway.setStatus("list", 503);
      await route.fulfill({
        status: 201,
        json: acknowledgement
          ? acknowledgement.value
          : { rule: { ...stored, created_at: "0001-01-01T00:00:00Z" } },
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
