import { expect, test, type Page, type Request } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Synthetic HTTP fixtures: real React/AuthProvider/ApiClient, not live settings writes.
const row = {
  id: "public-review-set",
  title: "요청 대기 시간 검토",
  status: "approved",
  items: [{ kind: "setting", key: "upstream.timeout", value: "30s" }],
  prior: [],
};
async function install(page: Page, readOnly = false, uncertain = false) {
  const writes: Request[] = [];
  const unexpected: string[] = [];
  let status = row.status;
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.52",
    ui_version: "changeset-browser-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/system/settings",
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
    user: {
      id: "public-reviewer",
      email: "reviewer@example.invalid",
      name: "설정 검토자",
      role: "admin",
      roles: ["admin"],
      team_id: "fixture",
      scopes: ["admin:read", "admin:write"],
      features: { "system.settings": true },
    },
    capabilities: { raw_prompt_view: false },
    roles: ["admin"],
    permissions: ["admin:read", "admin:write"],
    allowed_features: ["system.settings"],
    migration_registry: [
      {
        feature_id: "system.settings",
        title: "시스템 설정",
        app_path: "/app/system/settings",
        legacy_path: "/admin#/settings",
        status: "preview",
        risk_level: "critical",
        required_permission: "admin:read",
        read_only: readOnly,
        enabled_roles: ["admin"],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.86.6",
        available: true,
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: { "/app/system/settings": "/admin#/settings" },
  };
  await page.route("**/*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const call = `${request.method()} ${path}`;
    const json = (body: unknown, code = 200) =>
      route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(body) });
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap);
    if (call === "GET /health" || call === "GET /ready") return json({ status: "ok" });
    if (call === "GET /admin/settings/effective") return json({ settings: [] });
    if (call === "GET /admin/change-sets") return json({ change_sets: [{ ...row, status }] });
    if (call === `POST /admin/change-sets/${row.id}/apply`) {
      writes.push(request);
      status = "applied";
      return json(uncertain ? { status } : { status, applied_count: 1, change_set: { ...row, status } });
    }
    if (path.startsWith("/admin/") || path.startsWith("/auth/")) {
      unexpected.push(call);
      return json({ error: { message: "Unexpected fixture call" } }, 501);
    }
    return route.continue();
  });
  return { writes, unexpected };
}
async function open(page: Page) {
  await page.goto("system/settings?tab=changesets");
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
  await page.getByRole("button", { name: `${row.title} 상세` }).click();
  const sheet = page.getByRole("dialog", { name: row.title, exact: true });
  return sheet;
}
const review = (page: Page) => page.getByRole("dialog", { name: "설정을 실제로 적용할까요?", exact: true });

test("대상과 사유를 확인한 적용은 한 번만 전송하고 새로고침 후 한글 상태를 복원한다", async ({ page }) => {
  const api = await install(page);
  const sheet = await open(page);
  await sheet.getByRole("button", { name: "적용", exact: true }).click();
  const dialog = review(page);
  const save = dialog.getByRole("button", { name: "적용", exact: true });
  await expect(save).toBeDisabled();
  await dialog.getByRole("textbox", { name: "변경 사유", exact: true }).fill("공개 테스트 승인");
  await expect(save).toBeDisabled();
  await dialog.getByRole("textbox", { name: "확인 문구", exact: true }).fill(row.id);
  await save.click();
  await expect(dialog).toBeHidden();
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0]?.postDataJSON()).toEqual({ note: "공개 테스트 승인" });
  await page.reload();
  await expect(page.getByRole("cell", { name: "적용됨", exact: true })).toBeVisible();
  expect(api.unexpected).toEqual([]);
});

test("읽기 전용 전환 상태는 생성과 위험 작업을 잠근다", async ({ page }) => {
  const api = await install(page, true);
  await page.goto("system/settings?tab=changesets");
  await expect(page.getByRole("button", { name: "새 변경 세트", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: `${row.title} 상세` }).click();
  const sheet = page.getByRole("dialog", { name: row.title, exact: true });
  for (const name of ["적용", "삭제", "되돌리기"])
    await expect(sheet.getByRole("button", { name, exact: true })).toBeDisabled();
  expect(api.writes).toEqual([]);
  expect(api.unexpected).toEqual([]);
});

test("불확실한 완료 응답은 재전송 없이 실제 목록 재조회로 확인한다", async ({ page }) => {
  const api = await install(page, false, true);
  const sheet = await open(page);
  await sheet.getByRole("button", { name: "적용", exact: true }).click();
  const dialog = review(page);
  await dialog.getByRole("textbox", { name: "변경 사유", exact: true }).fill("결과 재조회 테스트");
  await dialog.getByRole("textbox", { name: "확인 문구", exact: true }).fill(row.id);
  await dialog.getByRole("button", { name: "적용", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "적용", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "적용", exact: true })).toBeDisabled();
  await sheet.getByRole("button", { name: "패널 닫기", exact: true }).click();
  await page.getByRole("button", { name: "목록 새로고침", exact: true }).click();
  await expect(page.getByRole("cell", { name: "적용됨", exact: true })).toBeVisible();
  expect(api.writes).toHaveLength(1);
  expect(api.unexpected).toEqual([]);
});

test("390px 다크 확인창은 키보드·초점·접근성을 유지한다", async ({ page }, info) => {
  const api = await install(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  const sheet = await open(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ["미리보기", "검토 제출", "되돌리기"]) {
    const button = sheet.getByRole("button", { name, exact: true });
    expect(
      await button.evaluate((node) => {
        const text = [...node.childNodes].find(
          (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
        );
        if (!text) return false;
        const range = document.createRange();
        range.selectNodeContents(text);
        return range.getClientRects().length === 1;
      }),
    ).toBe(true);
  }
  const trigger = sheet.getByRole("button", { name: "적용", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = review(page);
  await expect(dialog).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole("button", { name: "취소", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "대화상자 닫기", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("textbox", { name: "확인 문구", exact: true })).toBeFocused();
  const violations = await page.evaluate(async () => {
    const engine = (
      window as Window & { axe?: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
    ).axe;
    if (!engine) throw new Error("Missing accessibility engine");
    return (await engine.run(document)).violations.map((item) => item.id);
  });
  expect(violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("change-set-mobile-dark.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(api.writes).toEqual([]);
  expect(api.unexpected).toEqual([]);
});
