import type { Page } from "@playwright/test";
import { installOverviewWorkspace } from "./overview-workspace-browser";

export async function installOverviewTrend(page: Page) {
  const fixture = await installOverviewWorkspace(page);
  fixture.bootstrap.backend_version = "v0.86.122";
  const trend = { status: 200, empty: false, reads: [] as { window: string; bucket: string }[] };
  await page.route("**/admin/timeseries?*", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET") {
      fixture.writes.push(route.request());
      return route.fulfill({ status: 405, json: {} });
    }
    const window = url.searchParams.get("window") ?? "";
    const bucket = url.searchParams.get("bucket") ?? "";
    trend.reads.push({ window, bucket });
    if (trend.status !== 200)
      return route.fulfill({
        status: trend.status,
        json: { error: { message: "synthetic trend failure" } },
        headers: { "X-Request-ID": "trend-fixture" },
      });
    return route.fulfill({
      json: {
        bucket,
        since: "2026-11-16T16:15:00Z",
        points: trend.empty
          ? []
          : [
              {
                date: bucket === "hour" ? "2026-11-17T01" : "2026-11-16",
                bucket,
                requests: 2,
                tokens: 12,
                cost_krw: 0.0004,
              },
              {
                date: bucket === "hour" ? "2026-11-17T02" : "2026-11-17",
                bucket,
                requests: 10,
                tokens: 7,
                cost_krw: 0.0012,
              },
            ],
      },
    });
  });
  await page.clock.setFixedTime(new Date("2026-11-16T17:15:00Z"));
  return { ...fixture, trend };
}
