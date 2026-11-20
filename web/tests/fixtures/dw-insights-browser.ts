import { expect, test as base, type BrowserContext } from "@playwright/test";
import { bootstrap as baseBootstrap } from "./mcp-upstream-gateway";

async function install(context: BrowserContext) {
  const identity = baseBootstrap("writable");
  const feature = identity.migration_registry[0];
  if (!feature) throw new Error("Missing feature fixture");
  const bootstrap = {
    ...identity,
    backend_version: "v0.86.177",
    ui_version: "public-dw-insights-fixture",
    ui: { ...identity.ui, default_entry: "/app/data/warehouse" },
    user: { ...identity.user, scopes: ["admin:read"], features: { "data.warehouse": true } },
    permissions: ["admin:read"],
    allowed_features: ["data.warehouse"],
    migration_registry: [
      {
        ...feature,
        feature_id: "data.warehouse",
        title: "데이터 웨어하우스",
        app_path: "/app/data/warehouse",
        legacy_path: "/admin#/dw",
        read_only: true,
      },
    ],
    legacy_route_map: { "/app/data/warehouse": "/admin#/dw" },
  };
  const reads: URL[] = [];
  const unexpected: string[] = [];
  let supported = true;
  let mismatch = false;
  let denied = false;
  const row = {
    value: "공개 분석 모델의 긴 이름_".repeat(8),
    requests: 14,
    tokens: 18,
    cost_krw: 24,
    errors: 3,
    error_rate: 3 / 14,
  };
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      unexpected.push("external");
      return route.abort();
    }
    if (url.pathname === "/admin/ui-bootstrap") return json(bootstrap);
    if (["/health", "/ready"].includes(url.pathname)) return json({ status: "ok" });
    if (url.pathname.startsWith("/admin/dw/dashboard/")) {
      reads.push(url);
      if (req.method() !== "GET") {
        unexpected.push(req.method() + " " + url.pathname);
        return json({}, 405);
      }
      const path = url.pathname.split("/").at(-1);
      if (path === "overview")
        return json({
          configured: true,
          since: "2024-02-29",
          requests: 1234,
          tokens: 123400,
          cost_krw: 45678,
          errors: 12,
          error_rate: 0.01,
        });
      if (path === "timeseries") {
        const week = url.searchParams.get("bucket") === "week";
        const dates = week
          ? ["2024-02-26", "2024-03-04"]
          : Array.from({ length: 12 }, (_, i) =>
              new Date(Date.UTC(2024, 1, 29 + i)).toISOString().slice(0, 10),
            );
        return json({
          configured: true,
          since: "2024-02-29",
          bucket: week ? "week" : "day",
          ...(supported ? { date_bounds_supported: true } : {}),
          points: dates.map((day, i) => ({
            day,
            requests: 20 + i,
            tokens: 100 + i,
            cost_krw: [1250, 0, 1960, 2500, 1700][i % 5],
            errors: i % 3,
          })),
        });
      }
      if (path === "dimensions") {
        if (denied)
          return json(
            { error: { message: "public denied", code: "forbidden", type: "permission_error" } },
            403,
          );
        return json({
          configured: true,
          since: mismatch ? "2024-01-01" : (url.searchParams.get("since_day") ?? "2024-02-29"),
          until: url.searchParams.get("until_day") ?? "",
          dimension: url.searchParams.get("dimension"),
          order_by: "cost_krw",
          rows: [row],
        });
      }
      if (path === "export.csv")
        return route.fulfill({
          status: 200,
          contentType: "text/csv",
          body: "model,requests,tokens,cost_krw,errors\npublic,14,18,24,3\n",
        });
      if (["latency", "quality", "routing", "text2sql"].includes(path ?? ""))
        return json({ configured: false });
    }
    if (url.pathname === "/admin/savings") return json({ scopes: [], total_savings_krw: 0 });
    if (url.pathname === "/admin/model-migration") return json({ recommendations: [], count: 0 });
    if (/^\/(admin|auth|me|v1|mcp)(\/|$)/u.test(url.pathname)) {
      unexpected.push(req.method() + " " + url.pathname);
      return json({}, 501);
    }
    return route.continue();
  });
  return {
    reads,
    unexpected,
    unsupported() {
      supported = false;
    },
    mismatch() {
      mismatch = true;
    },
    deny(value: boolean) {
      denied = value;
    },
  };
}
export const test = base.extend<{ gateway: Awaited<ReturnType<typeof install>> }>({
  gateway: [
    async ({ context }, use) => {
      const gateway = await install(context);
      await use(gateway);
      expect(gateway.unexpected).toEqual([]);
    },
    { auto: true },
  ],
});
