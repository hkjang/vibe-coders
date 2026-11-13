import { expect } from "@playwright/test";
import { test as routingTest, rule, ruleB } from "../../fixtures/routing-toggle-review-gateway";
import type { RoutingOrderRequest, RoutingOrderPreviewRequest } from "../../../src/shared/api/generated";

export { firstEmail, routingUrl } from "../../fixtures/routing-toggle-review-gateway";
interface Ordering {
  saves: RoutingOrderRequest[];
  loseResponse: () => void;
}
// A synthetic transport. Database revision/locking/audit are verified in Go tests.
export const test = routingTest.extend<{ ordering: Ordering }>({
  ordering: async ({ context, gateway }, runTest) => {
    gateway.setBackendVersion("v0.86.91");
    gateway.setRows(
      [rule(), rule(ruleB)].map((row) => ({
        ...row,
        priority: 100,
        match_pattern: "public-*",
        max_complexity: 100,
      })),
    );
    let revision = "a".repeat(64);
    let lost = false;
    const saves: RoutingOrderRequest[] = [];
    await context.route(/\/admin\/routing-rules(?:\?.*)?$/, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "GET" && url.search === "?view=order")
        return route.fulfill({ json: { rules: gateway.records(), revision, ambiguous_ties: true } });
      if (request.method() !== "PATCH") return route.fallback();
      const body = request.postDataJSON() as RoutingOrderRequest;
      expect(url.search).toBe("");
      expect(body.expected_revision).toBe(revision);
      expect(request.headers()["x-vibe-ui"]).toBe("app");
      saves.push(structuredClone(body));
      const current = gateway.records();
      const rows = body.order.map((id, index) => {
        const original = current.find((row) => row.id === id);
        if (!original) throw new Error("Unknown synthetic rule in proposed order");
        return { ...original, priority: index + 1 };
      });
      gateway.setRows(rows);
      revision = "b".repeat(64);
      if (lost) return route.abort("connectionfailed");
      await route.fulfill({ json: { rules: rows, revision, ambiguous_ties: false } });
    });
    await context.route("**/admin/routing/preview", async (route) => {
      const request = route.request();
      expect(request.method()).toBe("POST");
      const body = request.postDataJSON() as RoutingOrderPreviewRequest;
      expect(body.rule_revision).toBe(revision);
      const decision = (id: string) => ({
        matched_rule_id: id,
        applied: true,
        target_model: gateway.records().find((row) => row.id === id)?.target_model ?? "",
        target_provider: "public-provider",
      });
      await route.fulfill({
        json: {
          stage: "complexity_rules",
          revision,
          ambiguous_before_order: true,
          before: decision(gateway.records()[0]?.id ?? ""),
          after: decision(body.rule_order[0] ?? ""),
        },
      });
    });
    await runTest({
      saves,
      loseResponse: () => {
        lost = true;
      },
    });
  },
});
