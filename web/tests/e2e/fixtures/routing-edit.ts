import { expect } from "@playwright/test";
import type { RoutingRule } from "../../../src/shared/api/domains/routing";
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

type EditCall = { method: string; path: string; body: Record<string, unknown> };
type Editor = {
  calls: EditCall[];
  hold: () => void;
  release: () => void;
  malformedAck: () => void;
  failFollowingRead: () => void;
};

/**
 * Reuses synthetic session/list transport without relaxing the original toggle
 * fixture's enabled-only PATCH contract. This edit-specific route records every
 * attempt before handling it and never checks permissions for the UI under test.
 * It cannot establish actual Go/DB concurrency, authorization or cancellation.
 */
export const test = routingTest.extend<{ editor: Editor }>({
  editor: async ({ context, gateway }, runTest) => {
    const calls: EditCall[] = [];
    let gate: Promise<void> | undefined;
    let release: (() => void) | undefined;
    let malformed = false;
    let failRead = false;
    await context.route("**/admin/routing-rules/*", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.push({ method, path, body: structuredClone(body) });
      expect(method).toBe("PATCH");
      expect(
        Object.keys(body).every((key) =>
          [
            "match_pattern",
            "target_model",
            "target_provider",
            "min_complexity",
            "max_complexity",
            "priority",
            "note",
          ].includes(key),
        ),
      ).toBe(true);
      const id = decodeURIComponent(path.slice(listPath.length + 1));
      const rows = gateway.records();
      const index = rows.findIndex((row) => row.id === id);
      const original = rows[index];
      if (!original) return route.fulfill({ status: 404, json: { error: { code: "rule_not_found" } } });
      const saved = { ...original, ...body } as RoutingRule;
      rows[index] = saved;
      gateway.setRows(rows);
      // Synthetic commit before a held/lost/malformed response: browser abort
      // and invalid ACK must not be represented as rollback.
      await gate;
      if (failRead) gateway.setStatus("list", 503);
      await route.fulfill({ status: 200, json: malformed ? {} : { rule: saved } });
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
        malformedAck: () => {
          malformed = true;
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

export function mutationCount(gateway: RoutingToggleGateway, editor: Editor): number {
  return editor.calls.length + gateway.operations.filter((call) => call.action === "patch").length;
}
