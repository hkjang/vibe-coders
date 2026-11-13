import type { Page } from "@playwright/test";
import { installSettingsWorkspace } from "./settings-workspace-browser";
export const globalKey = "ui.app.enabled";
export const featureKey = "ui.app.feature.system.settings.rollout";
export async function installSettingSearch(page: Page, failOnce = false) {
  const fixture = await installSettingsWorkspace(page, "viewer");
  fixture.bootstrap.backend_version = "v0.86.99";
  const template = fixture.settings[0];
  if (!template) throw new Error("Missing fixture setting");
  fixture.settings.push(
    { ...template, key: globalKey, category: "ui.app", description: "신규 콘솔 사용 여부" },
    {
      ...template,
      key: featureKey,
      category: "ui.app.features",
      type: "int",
      value: "30",
      description: "시스템 설정의 사용자 점진 배포 비율",
    },
    {
      ...template,
      key: "ui.app.feature.system.settings.status",
      category: "ui.app.features",
      type: "string",
      value: "preview",
      description: "시스템 설정의 전환 상태",
    },
  );
  const searches: unknown[] = [];
  await page.route("**/admin/ui-telemetry/summary?*", (route) =>
    route.fulfill({
      json: {
        enabled: false,
        days: 7,
        from: "",
        to: "",
        retention_days: 30,
        visit_limit: 100000,
        features: [],
      },
    }),
  );
  await page.route("**/admin/resource-search", (route) => {
    const request = route.request();
    if (request.method() !== "POST" || new URL(request.url()).search)
      throw new Error("Search transport changed");
    const body = request.postDataJSON() as { query: string; kinds: string[] };
    searches.push(body);
    const failed = failOnce && searches.length === 1;
    const items = fixture.settings
      .filter((row) =>
        [row.key, row.category, row.description].some((text) =>
          text.toLowerCase().includes(body.query.toLowerCase()),
        ),
      )
      .map((row) => ({ kind: "setting", id: row.key, title: row.description }));
    return route.fulfill({
      json: {
        request_id: "setting-search-fixture",
        groups: [
          {
            kind: "setting",
            status: failed ? "unavailable" : "ok",
            limited: false,
            items: failed ? [] : items,
          },
        ],
      },
    });
  });
  return { ...fixture, searches };
}
