import { expect, test, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

const scenarios = [
  {
    name: "scorecard",
    feature: "governance.reports",
    path: "/app/governance/reports",
    query: "",
    api: "/admin/teams/scorecard",
    button: "CSV 다운로드",
    filter: "조회 기간",
    next: "7d",
    type: "text/csv",
    filename: /^team-scorecard-.*\.csv$/u,
    body: "team,cost\r\n공개 합성 팀,9007199254740993\r\n",
  },
  {
    name: "narrative",
    feature: "governance.reports",
    path: "/app/governance/reports",
    query: "?tab=narrative",
    api: "/admin/reports/narrative",
    button: "마크다운 다운로드",
    filter: "조회 기간",
    next: "7d",
    type: "text/markdown",
    filename: /^ai-gateway-report-.*\.md$/u,
    body: "# 공개 합성 보고서\r\n\r\n  원본 공백  \r\n",
  },
  {
    name: "sbom",
    feature: "governance.assets",
    path: "/app/governance/assets",
    query: "",
    api: "/admin/sbom",
    button: "JSON 내보내기",
    filter: "자산 유형",
    next: "skill",
    type: "application/json",
    filename: /^ai-asset-sbom\.json$/u,
    body: ' {"name":"공개 합성 자산","large":9007199254740993}\n',
  },
  {
    name: "privacy",
    feature: "security.overview",
    path: "/app/security",
    query: "?tab=privacy",
    api: "/admin/privacy-ledger",
    button: "CSV 내보내기",
    filter: "차원",
    next: "model",
    type: "text/csv",
    filename: /^privacy-ledger-model\.csv$/u,
    body: "model,detections\r\n공개 합성 모델,2\r\n",
  },
  {
    name: "warehouse",
    feature: "data.warehouse",
    path: "/app/data/warehouse",
    query: "",
    api: "/admin/dw/dashboard/export.csv",
    button: "CSV 내보내기",
    filter: "분석 차원",
    next: "provider",
    type: "text/csv",
    filename: /^dw-dashboard-provider-.*\.csv$/u,
    body: "provider,cost\r\n공개 합성 공급자,9007199254740993\r\n",
  },
];
type Scenario = (typeof scenarios)[number];

async function install(page: Page, item: Scenario) {
  const user = {
    id: "public-file-reader",
    name: "공개 합성 파일 조회자",
    email: "files@example.invalid",
    role: "admin",
    roles: ["admin"],
    team_id: "",
    scopes: ["admin:read", "security:read"],
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.163",
    ui_version: "file-ownership-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: item.path,
      legacy_fallback: true,
      feedback_enabled: false,
      telemetry_enabled: false,
    },
    authentication: {
      enabled: false,
      authenticated: true,
      mode: "open",
      keycloak_enabled: false,
      allow_local_login: true,
      sso_login_url: "/auth/keycloak/login",
    },
    user,
    roles: user.roles,
    permissions: user.scopes,
    capabilities: { raw_prompt_view: false },
    allowed_features: [item.feature],
    migration_registry: [
      {
        feature_id: item.feature,
        title: "파일 내보내기 검증",
        app_path: item.path,
        legacy_path: "/admin",
        status: "preview",
        risk_level: "medium",
        required_permission: "admin:read",
        read_only: true,
        enabled_roles: ["admin"],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.84.0",
        available: true,
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: {},
  };
  const readResponses: Record<string, unknown> = {
    "/admin/teams/scorecard": { teams: [] },
    "/admin/reports/narrative": { sections: [], period_start: "2026-10-01", period_end: "2026-10-31" },
    "/admin/sbom": { entries: [] },
    "/admin/privacy-ledger": { rows: [] },
    "/admin/dw/dashboard/overview": { configured: true },
    "/admin/dw/dashboard/timeseries": {},
    "/admin/dw/dashboard/dimensions": {},
    "/admin/dw/dashboard/latency": {},
    "/admin/dw/dashboard/quality": {},
    "/admin/dw/dashboard/routing": {},
    "/admin/dw/dashboard/text2sql": {},
    "/admin/savings": {},
    "/admin/model-migration": {},
  };
  const unexpected: string[] = [];
  const files: Array<{ query: Record<string, string>; method: string; ui: string | undefined }> = [];
  let jsonReads = 0;
  let nextFile: { held?: Promise<void> } | undefined;
  let release = () => {};
  let finished = Promise.resolve();
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/app/")) return route.continue();
    const json = (body: unknown) => route.fulfill({ json: body });
    if (request.method() !== "GET") {
      unexpected.push(request.method() + " " + url.pathname);
      return route.fulfill({ status: 500 });
    }
    if (url.pathname === "/auth/me") return json({ authenticated: true, user });
    if (url.pathname === "/admin/ui-bootstrap") return json(bootstrap);
    if (url.pathname === "/health") return json({ status: "ok" });
    if (
      url.pathname === item.api &&
      nextFile &&
      (item.name === "sbom" ||
        item.name === "warehouse" ||
        ["csv", "md"].includes(url.searchParams.get("format") ?? ""))
    ) {
      const pending = nextFile;
      nextFile = undefined;
      files.push({
        query: Object.fromEntries(url.searchParams),
        method: request.method(),
        ui: request.headers()["x-vibe-ui"],
      });
      let finish = () => {};
      finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      try {
        await pending.held;
        await route.fulfill({ contentType: item.type + "; charset=utf-8", body: item.body });
      } finally {
        finish();
      }
      return;
    }
    if (url.pathname in readResponses) {
      jsonReads++;
      return json(readResponses[url.pathname]);
    }
    unexpected.push(url.pathname);
    return route.fulfill({ status: 500 });
  });
  return {
    files,
    unexpected,
    reads: () => jsonReads,
    queueFile(hold = false) {
      nextFile = hold
        ? {
            held: new Promise<void>((resolve) => {
              release = resolve;
            }),
          }
        : {};
    },
    async release() {
      release();
      await finished;
    },
  };
}

for (const item of scenarios) {
  test(`${item.name}: changed filters discard the old export and a fresh download preserves bytes`, async ({
    page,
  }) => {
    const fixture = await install(page, item);
    const downloads: string[] = [];
    page.on("download", (download) => downloads.push(download.suggestedFilename()));
    await page.goto(item.path + item.query);
    await expect.poll(fixture.reads).toBeGreaterThan(0);
    const button = page.getByRole("button", { name: item.button, exact: true });
    await expect(button).toBeEnabled();
    fixture.queueFile(true);
    await button.click();
    await expect.poll(() => fixture.files.length).toBe(1);
    await page.getByRole("combobox", { name: item.filter, exact: true }).selectOption(item.next);
    await fixture.release();
    await expect(button).toBeEnabled();
    fixture.queueFile();
    const next = page.waitForEvent("download");
    await button.click();
    const download = await next;
    expect(download.suggestedFilename()).toMatch(item.filename);
    const stream = await download.createReadStream();
    if (!stream) throw new Error("download is unavailable");
    const chunks: number[] = [];
    for await (const chunk of stream) chunks.push(...new Uint8Array(chunk));
    expect(chunks).toEqual(Array.from(new TextEncoder().encode(item.body)));
    expect(downloads).toEqual([download.suggestedFilename()]);
    expect(fixture.files).toHaveLength(2);
    expect(fixture.files.every((entry) => entry.method === "GET" && entry.ui === "app")).toBe(true);
    if (item.name === "scorecard" || item.name === "narrative")
      expect(fixture.files.map((entry) => entry.query.window)).toEqual(["30d", "7d"]);
    if (item.name === "privacy")
      expect(fixture.files.map((entry) => entry.query.dimension)).toEqual(["team", "model"]);
    if (item.name === "warehouse") {
      expect(fixture.files.map((entry) => entry.query.dimension)).toEqual(["model", "provider"]);
      expect(fixture.files.every((entry) => entry.query.limit === "100")).toBe(true);
    }
    expect(fixture.unexpected).toEqual([]);
    await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
  });
}
