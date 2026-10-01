import { expect } from "@playwright/test";
import type { RoutingLearningReport } from "../../../src/shared/api/domains/routing";
import { test as createTest } from "./routing-create";

export { firstEmail, listPath } from "./routing-create";
export const learningUrl = "/app/routing/rules/learning";
export const learningPath = "/admin/routing/learning";
export const learningModel = "public-recommended-model";

export function reportFor(bucket = "low", model = learningModel): RoutingLearningReport {
  const selected = {
    task_type: "code",
    bucket,
    model,
    requests: 30,
    successes: 29,
    success_rate: 29 / 30,
    fallback_rate: 0,
    avg_cost_krw: 1.25,
    avg_latency_ms: 120,
    thumbs_up: 2,
    thumbs_down: 0,
  };
  return {
    since: "2026-09-25T12:00:00Z",
    min_samples: 20,
    cells: [
      selected,
      {
        ...selected,
        model: "public-observed-model",
        requests: 40,
        successes: 30,
        success_rate: 0.75,
        avg_cost_krw: 2,
      },
      {
        ...selected,
        model: "public-under-sampled-model",
        requests: 1,
        successes: 1,
        success_rate: 1,
        thumbs_up: 1,
      },
    ],
    recommendations: [
      {
        task_type: "code",
        bucket,
        recommended_model: model,
        success_rate: 29 / 30,
        avg_cost_krw: 1.25,
        samples: 30,
        top_model: "public-observed-model",
        top_success_rate: 0.75,
        differs: true,
        confident: false,
        rationale: "공개 합성 관측 결과 · 일부 비교 모델 표본 부족",
      },
    ],
  };
}

type LearningCall = { method: string; path: string; window: string | null };
type Learner = {
  calls: LearningCall[];
  finished: LearningCall[];
  setReport: (report: unknown) => void;
  setStatus: (status: number) => void;
  hold: () => void;
  release: () => void;
};

/** Synthetic transport, not Go RBAC, recommendation calculation or server writes. */
export const test = createTest.extend<{ learner: Learner }>({
  learner: async ({ context, creator, baseURL }, runTest) => {
    // Ensure the parent POST handler is installed even for read-only scenarios.
    expect(creator.calls).toEqual([]);
    if (!baseURL) throw new Error("Synthetic learning fixture requires an explicit base URL");
    const expectedOrigin = new URL(baseURL).origin;
    const calls: LearningCall[] = [],
      finished: LearningCall[] = [];
    let report: unknown = reportFor(),
      status = 200;
    let gate: Promise<void> | undefined, unblock: (() => void) | undefined;
    const release = () => {
      unblock?.();
      gate = undefined;
      unblock = undefined;
    };
    await context.route(
      /\/admin\/routing\/(learning|domain-decisions|domain-review|domain-examples)(?:\?.*)?$/,
      async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        const call = { method: request.method(), path: url.pathname, window: url.searchParams.get("window") };
        calls.push(call); // Attempts precede all fixture handling and validation.
        expect(url.origin).toBe(expectedOrigin);
        // Synthetic header shape only, not live authentication or scope checks.
        expect(request.headers().authorization).toMatch(/^Bearer public-routing-access-[1-9][0-9]*$/u);
        expect(call.method).toBe("GET");
        expect(request.headers()["x-vibe-ui"]).toBe("app");
        if (call.path !== learningPath) {
          return route.fulfill({
            status: 200,
            json: call.path.endsWith("domain-decisions")
              ? { decisions: [], signals: {} }
              : call.path.endsWith("domain-review")
                ? { items: [] }
                : { examples: [] },
          });
        }
        // Capture the response at dispatch, before held fulfillment. No UI guard
        // is implemented here: stale/unknown/readonly requests remain observable.
        const snapshot = structuredClone(report),
          responseStatus = status;
        await gate;
        try {
          await route.fulfill({
            status: responseStatus,
            headers: { "X-Request-ID": "req-public-learning-review" },
            json:
              responseStatus === 200
                ? snapshot
                : {
                    error: {
                      message: "Synthetic learning report unavailable",
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
