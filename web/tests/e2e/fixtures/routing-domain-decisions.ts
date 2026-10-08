import { expect } from "@playwright/test";
import { test as routingTest } from "../../fixtures/routing-toggle-review-gateway";

export { firstEmail } from "../../fixtures/routing-toggle-review-gateway";
export const decisionsUrl = "/app/routing/rules/learning";
export const decisionsPath = "/admin/routing/domain-decisions";
export const rawDecisionMarker = "PUBLIC-UNCONTRACTED-DOMAIN-QUERY-MARKER";
export const decisionRow = {
  id: "dd_public_01",
  request_id: "req_public_01",
  user_id: "public-user",
  team_id: "public-team",
  query_hash: "public-query-hash",
  route: "public-route",
  confidence: 1.12,
  tool_names: ["public-candidate-tool"],
  evidence_score: 2.25,
  evidence_count: 2,
  fallback_used: false,
  blocked_by_governance: false,
  reason: "공개 합성 결정 사유 01",
  created_at: "2026-10-08T00:00:00Z",
  query_text: rawDecisionMarker,
};
export const signalRow = {
  id: "sig_public_01",
  decision_id: decisionRow.id,
  source: "selector",
  route: decisionRow.route,
  score: 1.12,
  reason: "공개 합성 선택기 근거 01",
  created_at: "2026-10-08T00:00:01Z",
  query_text: rawDecisionMarker,
};
export function reportFor(count = 1) {
  const decisions = Array.from({ length: count }, (_, index) => ({
    ...decisionRow,
    id: `dd_public_${String(index + 1).padStart(2, "0")}`,
    request_id: `req_public_${String(index + 1).padStart(2, "0")}`,
    reason: `공개 합성 결정 사유 ${String(index + 1).padStart(2, "0")}`,
  }));
  return {
    decisions,
    signals: Object.fromEntries(
      decisions.map((item, index) => [
        item.id,
        [{ ...signalRow, id: `sig_public_${index + 1}`, decision_id: item.id }],
      ]),
    ),
  };
}
type DecisionCall = { method: string; path: string; body: string | null; query: Record<string, string> };
type Explorer = {
  calls: DecisionCall[];
  finished: DecisionCall[];
  reads: () => DecisionCall[];
  writes: () => DecisionCall[];
  setReport: (value: unknown) => void;
  setStatus: (value: number) => void;
  hold: () => void;
  release: () => void;
};

/** Synthetic HTTP only: actual Go auth, stored evidence semantics and filtering have separate tests. */
export const test = routingTest.extend<{ explorer: Explorer }>({
  explorer: async ({ context, gateway, baseURL }, runTest) => {
    if (!baseURL) throw new Error("Synthetic domain decision tests need a base URL");
    const origin = new URL(baseURL).origin;
    gateway.setRawPromptView(true);
    const calls: DecisionCall[] = [],
      finished: DecisionCall[] = [];
    let report: unknown = reportFor(),
      status = 200;
    let gate: Promise<void> | undefined, unblock: (() => void) | undefined;
    const release = () => {
      unblock?.();
      gate = undefined;
      unblock = undefined;
    };
    await context.route(
      /\/admin\/routing\/(?:learning|domain-decisions|domain-review(?:\/[^?]*)?|domain-examples)(?:\?.*)?$/,
      async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        const call = {
          method: request.method(),
          path: url.pathname,
          body: request.postData(),
          query: Object.fromEntries(url.searchParams),
        };
        calls.push(call);
        expect(url.origin).toBe(origin);
        expect(request.headers().authorization).toMatch(/^Bearer public-routing-access-[1-9][0-9]*$/u);
        expect(request.headers()["x-vibe-ui"]).toBe("app");
        expect(call.method).toBe("GET");
        if (call.path !== decisionsPath)
          return route.fulfill({
            status: 200,
            json: call.path.endsWith("learning")
              ? { since: "2026-10-01T00:00:00Z", min_samples: 20, cells: [], recommendations: [] }
              : call.path.endsWith("domain-review")
                ? { items: [] }
                : { examples: [] },
          });
        // Snapshot before any wait: aborting a client request does not change this response.
        const snapshot = structuredClone(report),
          responseStatus = status;
        if (
          typeof snapshot === "object" &&
          snapshot !== null &&
          "decisions" in snapshot &&
          Array.isArray(snapshot.decisions)
        ) {
          snapshot.decisions = snapshot.decisions
            .filter(
              (item: typeof decisionRow) =>
                (!call.query.route || item.route === call.query.route) &&
                (!call.query.request_id || item.request_id === call.query.request_id),
            )
            .slice(0, Number(call.query.limit ?? 50));
        }
        await gate;
        try {
          await route.fulfill({
            status: responseStatus,
            headers: { "X-Request-ID": "req-public-decision-response" },
            json:
              responseStatus === 200
                ? snapshot
                : {
                    error: { message: "Public synthetic decision failure", type: "server_error" },
                    query_text: rawDecisionMarker,
                  },
          });
        } finally {
          finished.push(call);
        }
      },
    );
    try {
      await runTest({
        calls,
        finished,
        reads: () => calls.filter((call) => call.method === "GET" && call.path === decisionsPath),
        writes: () => calls.filter((call) => call.method !== "GET"),
        setReport: (value) => {
          report = structuredClone(value);
        },
        setStatus: (value) => {
          status = value;
        },
        hold: () => {
          gate = new Promise<void>((resolve) => {
            unblock = resolve;
          });
        },
        release,
      });
    } finally {
      release();
    }
  },
});
