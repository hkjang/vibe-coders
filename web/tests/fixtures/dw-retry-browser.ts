import { expect, test as base, type BrowserContext } from "@playwright/test";
import { bootstrap as baseBootstrap } from "./mcp-upstream-gateway";
import type { DwRetryReview, DwRetryRun } from "../../src/shared/api/generated";

const revision = "a".repeat(64);
export const retryReview: DwRetryReview = {
  revision,
  run_id: `dwr_${revision}`,
  reviewed_at: "2026-11-20T06:00:00.000000000Z",
  expires_at: "2026-11-20T06:05:00.000000000Z",
  all: false,
  eligible_dimensions: 1,
  estimated_rows: 1001,
  dimensions: [
    {
      dimension: "model",
      since: "2026-11-01",
      until: "2026-11-20",
      estimated_rows: 1001,
      sent_rows: 0,
      status: "queued",
      issue: "",
    },
    {
      dimension: "text2sql_fact",
      since: "2026-11-01T00:00:00.000000000Z",
      until: "2026-11-20T06:00:00.000000000Z",
      estimated_rows: 0,
      sent_rows: 0,
      status: "blocked",
      issue: "fact_not_configured",
    },
  ],
};
export const retryRunning: DwRetryRun = {
  id: retryReview.run_id,
  status: "running",
  reviewed_at: retryReview.reviewed_at,
  created_at: retryReview.reviewed_at,
  updated_at: retryReview.reviewed_at,
  finished_at: "",
  progress: {
    estimated_rows: 1001,
    sent_rows: 0,
    finished_dimensions: 0,
    dimensions: retryReview.dimensions,
  },
};
function bootstrap() {
  const value = baseBootstrap("writable");
  const feature = value.migration_registry[0];
  if (!feature) throw new Error("Missing fixture feature");
  const scopes = ["admin:read", "admin:write"];
  return {
    ...value,
    // Keep the real API capability version, but avoid unrelated UI upgrade
    // notices in screenshots. Embedded version matching is verified separately.
    backend_version: "v0.86.173",
    ui_version: "public-dw-retry-fixture",
    ui: { ...value.ui, default_entry: "/app/data/warehouse" },
    user: { ...value.user, scopes, features: { "data.warehouse": true } },
    permissions: scopes,
    allowed_features: ["data.warehouse"],
    migration_registry: [
      {
        ...feature,
        feature_id: "data.warehouse",
        title: "데이터 웨어하우스",
        app_path: "/app/data/warehouse",
        legacy_path: "/admin#/dw",
      },
    ],
    legacy_route_map: { "/app/data/warehouse": "/admin#/dw" },
  };
}
async function install(context: BrowserContext) {
  const writes: unknown[] = [];
  const reads: string[] = [];
  const unexpected: string[] = [];
  let job: DwRetryRun | undefined;
  let review = structuredClone(retryReview);
  let loseResponse = false;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const call = `${request.method()} ${url.pathname}`;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      unexpected.push(call);
      return route.abort();
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap());
    if (call === "GET /health" || call === "GET /ready") return json({ status: "ok" });
    if (call === "GET /admin/dw/clickhouse/overview") return json({ configured: false });
    if (call === "GET /admin/dw/sink-status")
      return json({
        configured: true,
        state: [],
        retries: [{ dimension: "model", since_day: "2026-11-01", attempts: 2, error: "합성 연결 오류" }],
      });
    if (call === "GET /admin/dw/sink-retry") {
      reads.push(url.search);
      if (url.searchParams.has("job_id"))
        return job && job.id === url.searchParams.get("job_id")
          ? json(job)
          : json(
              { error: { message: "No job", code: "sink_run_not_found", type: "invalid_request_error" } },
              404,
            );
      return json(review);
    }
    if (call === "POST /admin/dw/sink-retry") {
      expect(url.search).toBe("?reviewed=1");
      writes.push(request.postDataJSON());
      job = {
        ...structuredClone(retryRunning),
        id: review.run_id,
        reviewed_at: review.reviewed_at,
        progress: {
          ...structuredClone(retryRunning.progress),
          estimated_rows: review.estimated_rows,
          dimensions: structuredClone(review.dimensions),
        },
      };
      return loseResponse ? route.abort("failed") : json(job, 202);
    }
    if (/^\/(admin|auth|me|v1|mcp)(\/|$)/u.test(url.pathname)) {
      unexpected.push(call);
      return json({ error: { message: "Unexpected fixture request" } }, 501);
    }
    return route.continue();
  });
  return {
    writes,
    reads,
    unexpected,
    requeue() {
      review = {
        ...structuredClone(retryReview),
        revision: "b".repeat(64),
        run_id: `dwr_${"b".repeat(64)}`,
        estimated_rows: 1,
        dimensions: retryReview.dimensions.map((row) =>
          row.dimension === "model" ? { ...row, estimated_rows: 1 } : { ...row },
        ),
      };
    },
    loseResponse() {
      loseResponse = true;
    },
    finish() {
      job = {
        ...retryRunning,
        status: "partial_failed",
        progress: {
          ...retryRunning.progress,
          sent_rows: 1000,
          finished_dimensions: 2,
          dimensions: retryReview.dimensions.map((row) =>
            row.dimension === "model"
              ? { ...row, status: "failed", sent_rows: 1000, issue: "delivery_incomplete" }
              : row,
          ),
        },
      };
    },
  };
}
export const test = base.extend<{ gateway: Awaited<ReturnType<typeof install>> }>({
  gateway: async ({ context }, runFixture) => {
    const gateway = await install(context);
    await runFixture(gateway);
    expect(gateway.unexpected).toEqual([]);
  },
});
