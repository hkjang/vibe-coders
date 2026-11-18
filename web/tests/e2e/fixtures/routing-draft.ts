import { expect } from "@playwright/test";
import { test as routingTest, rule } from "../../fixtures/routing-toggle-review-gateway";
import type { RoutingDraftPreviewRequest, RoutingDraftWriteRequest } from "../../../src/shared/api/generated";
export { firstEmail, routingUrl, rule } from "../../fixtures/routing-toggle-review-gateway";

export const test = routingTest.extend<{
  draft: { writes: RoutingDraftWriteRequest[]; conflict: () => void };
}>({
  draft: async ({ context, gateway }, provide) => {
    gateway.setBackendVersion("v0.86.159");
    let revision = "a".repeat(64),
      conflict = false;
    const writes: RoutingDraftWriteRequest[] = [];
    await context.route(/\/admin\/routing-rules(?:\?.*)?$/, async (route) => {
      if (new URL(route.request().url()).search !== "?view=order") return route.fallback();
      expect(route.request().method()).toBe("GET");
      return route.fulfill({ json: { rules: gateway.records(), revision, ambiguous_ties: false } });
    });
    await context.route("**/admin/routing/preview", async (route) => {
      const body = route.request().postDataJSON() as RoutingDraftPreviewRequest;
      expect(body.rule_edit.expected_revision).toBe(revision);
      expect(route.request().method()).toBe("POST");
      const plan = {
        requested_model: body.request.model,
        selected_model: rule().target_model,
        selected_provider: "public-provider",
        policy_api_key_id: "",
        complexity: { score: 12, tier: "simple" },
        risk: { score: 0, tier: "low", categories: [] },
        health_score: 100,
        fallback_plan: ["no_provider_failover:single_matching_provider"],
        route_reason: "complexity_rule",
        decision_reason: "public explanation",
        would_rewrite: true,
      };
      return route.fulfill({
        json: {
          stage: "routing_plan",
          revision,
          runtime_consistency: "sequential_live_reads",
          observed_at: "2026-11-17T00:00:00Z",
          before: plan,
          after: { ...plan, selected_model: body.rule_edit.patch.target_model },
        },
      });
    });
    await context.route("**/admin/routing-rules/*", async (route) => {
      const url = new URL(route.request().url());
      expect(url.search).toBe("?review=edit");
      expect(route.request().method()).toBe("PATCH");
      const body = route.request().postDataJSON() as RoutingDraftWriteRequest;
      writes.push(structuredClone(body));
      if (conflict)
        return route.fulfill({
          status: 409,
          json: { error: { code: "routing_draft_conflict", message: "검토한 설정이 바뀌었습니다." } },
        });
      expect(body.expected_revision).toBe(revision);
      const rows = gateway.records();
      const saved = { ...rule(), ...body.patch };
      gateway.setRows(rows.map((row) => (row.id === saved.id ? saved : row)));
      revision = "b".repeat(64);
      return route.fulfill({ json: { rule: saved, revision } });
    });
    await provide({
      writes,
      conflict: () => {
        conflict = true;
      },
    });
  },
});
