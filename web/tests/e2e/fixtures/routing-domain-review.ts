import { expect } from "@playwright/test";
import { test as routingTest } from "../../fixtures/routing-toggle-review-gateway";

export { firstEmail } from "../../fixtures/routing-toggle-review-gateway";
export const reviewUrl = "/app/routing/rules/learning";
export const reviewPath = "/admin/routing/domain-review";
export const reviewID = " 검토%2f?#\\. ";
export const encodedReviewID = "%20%EA%B2%80%ED%86%A0%252f%3F%23%5C.%20";
export const rawQueryMarker = "SYNTHETIC_DOMAIN_QUERY_NOT_FOR_DISPLAY";
export const reviewRow = {
  id: reviewID,
  decision_id: "public-domain-decision",
  current_route: "public-current-route",
  suggested_route: "public-suggested-route",
  reason: "공개 합성 도메인 분류 검토 사유",
  status: "pending",
  query_text: rawQueryMarker,
  created_at: "2026-10-08T00:00:00Z",
  reviewed_at: "",
};

type ReviewCall = { method: string; path: string; body: string | null; query: Record<string, string> };
type Action = "list" | "decide";
type Reviewer = {
  calls: ReviewCall[];
  finished: ReviewCall[];
  posts: () => ReviewCall[];
  reads: () => ReviewCall[];
  records: () => (typeof reviewRow)[];
  setRows: (rows: (typeof reviewRow)[]) => void;
  ack: (value: unknown) => void;
  setStatus: (action: Action, status: number) => void;
  failFollowingRead: () => void;
  hold: (action: Action) => void;
  release: (action: Action) => void;
};

/** Synthetic HTTP only: no claims about live RBAC, audit, CAS, or server cancellation. */
export const test = routingTest.extend<{ reviewer: Reviewer }>({
  reviewer: async ({ context, gateway, baseURL }, runTest) => {
    if (!baseURL) throw new Error("Synthetic domain review requires an explicit base URL");
    const expectedOrigin = new URL(baseURL).origin;
    // Existing suites keep the parent fixture's default false capability.
    gateway.setRawPromptView(true);
    let rows = [{ ...reviewRow }];
    let acknowledgement: { value: unknown } | undefined;
    let failRead = false;
    const calls: ReviewCall[] = [],
      finished: ReviewCall[] = [];
    const statuses = new Map<Action, number>();
    const gates = new Map<Action, Promise<void>>(),
      releases = new Map<Action, () => void>();
    const release = (action: Action) => {
      releases.get(action)?.();
      releases.delete(action);
      gates.delete(action);
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
        // Record every attempted write before handling it. Do not implement UI
        // permission, consent, row-status, stale-query or retry guards here.
        calls.push(call);
        expect(url.origin).toBe(expectedOrigin);
        expect(request.headers().authorization).toMatch(/^Bearer public-routing-access-[1-9][0-9]*$/u);
        expect(request.headers()["x-vibe-ui"]).toBe("app");
        if (!call.path.startsWith(reviewPath)) {
          expect(call.method).toBe("GET");
          return route.fulfill({
            status: 200,
            json: call.path.endsWith("/learning")
              ? { since: "2026-10-01T00:00:00Z", min_samples: 20, cells: [], recommendations: [] }
              : call.path.endsWith("/domain-decisions")
                ? { decisions: [], signals: {} }
                : { examples: [] },
          });
        }
        const action: Action = call.method === "POST" ? "decide" : "list";
        expect(call.method).toBe(action === "decide" ? "POST" : "GET");
        let snapshot: unknown;
        if (action === "decide") {
          const [id, decision] = decodeURIComponent(call.path.slice(reviewPath.length + 1)).split("/");
          const status = decision === "approve" ? "approved" : "rejected";
          // Commit before held/malformed acknowledgment: an abort is not rollback.
          rows = rows.map((row) =>
            row.id === id ? { ...row, status, reviewed_at: "2026-10-08T01:00:00Z" } : row,
          );
          snapshot = acknowledgement ? structuredClone(acknowledgement.value) : { id, status };
          if (failRead) statuses.set("list", 503);
        } else {
          snapshot = {
            items: structuredClone(rows.filter((row) => row.status === (call.query.status ?? "pending"))),
          };
        }
        const responseStatus = statuses.get(action) ?? 200;
        await gates.get(action);
        try {
          await route.fulfill({
            status: responseStatus,
            headers: { "X-Request-ID": "req-public-domain-review" },
            json:
              responseStatus === 200
                ? snapshot
                : {
                    error: {
                      message: "Synthetic domain review unavailable",
                      type: "server_error",
                      code: "synthetic_failure",
                    },
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
        posts: () => calls.filter((call) => call.method === "POST"),
        reads: () => calls.filter((call) => call.method === "GET" && call.path === reviewPath),
        records: () => structuredClone(rows),
        setRows: (value) => {
          rows = structuredClone(value);
        },
        ack: (value) => {
          acknowledgement = { value };
        },
        setStatus: (action, status) => {
          statuses.set(action, status);
        },
        failFollowingRead: () => {
          failRead = true;
        },
        hold: (action) => gates.set(action, new Promise<void>((resolve) => releases.set(action, resolve))),
        release,
      });
    } finally {
      for (const action of [...gates.keys()]) release(action);
    }
  },
});
