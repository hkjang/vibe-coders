import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installPromptLibrary } from "../fixtures/prompt-library-browser";

// Actual React/ApiClient and embedded assets; synthetic HTTP establishes UI
// dispatch behavior. Server persistence and RBAC are covered by the Go tests.
async function fixture(page: Page, readonly = false) {
  const base = await installPromptLibrary(page, readonly);
  base.bootstrap.backend_version = "v0.86.136";
  base.bootstrap.allowed_features = ["security.redteam"];
  const feature = base.bootstrap.migration_registry[0];
  if (!feature) throw Error("Missing synthetic feature");
  Object.assign(feature, {
    feature_id: "security.redteam",
    title: "레드팀 자동화",
    app_path: "/app/redteam",
    legacy_path: "/admin#/redteam",
    required_permission: "admin:read",
    risk_level: "critical",
  });
  const state = { enabled: false, readStatus: 200, writeStatus: 200, legacy: false, unrelatedFailure: false };
  let revision = "1".repeat(32),
    reads = 0;
  const writes: unknown[] = [];
  const current = () => ({
    enabled: state.enabled,
    ...(state.legacy
      ? {}
      : {
          scope: "responding_process",
          instance_ref: "process_0123456789abcdef",
          review_token: revision,
          observed_at: "2026-11-17T02:00:00Z",
        }),
  });
  await page.route("**/admin/redteam/**", async (route) => {
    const request = route.request();
    if (new URL(request.url()).pathname !== "/admin/redteam/kill-switch") {
      expect(request.method()).toBe("GET");
      return route.fulfill({ status: state.unrelatedFailure ? 503 : 200, json: {} });
    }
    if (request.method() === "GET") {
      reads++;
      return route.fulfill({
        status: state.readStatus,
        json: state.readStatus === 200 ? current() : { error: { code: "public_state_unavailable" } },
      });
    }
    expect(request.method()).toBe("POST");
    expect(request.headers()["x-vibe-route"]).toBe("security.redteam");
    const body: unknown = request.postDataJSON();
    writes.push(body);
    expect(body).toEqual({
      enabled: !state.enabled,
      reason: "공개 운영 점검",
      expected_review_token: revision,
    });
    if (state.writeStatus !== 200)
      return route.fulfill({
        status: state.writeStatus,
        json: { error: { code: "public_unknown_outcome" } },
      });
    state.enabled = !state.enabled;
    revision = revision === "1".repeat(32) ? "2".repeat(32) : "3".repeat(32);
    return route.fulfill({ json: { ...current(), reason: "공개 운영 점검" } });
  });
  return { ...base, state, writes, reads: () => reads };
}

async function open(page: Page, enabled = false) {
  const label = enabled ? "레드팀 처리 재개" : "레드팀 처리 중지";
  const button = page.getByRole("button", { name: `${label} 검토`, exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  const dialog = page.getByRole("dialog", { name: label, exact: true });
  const submit = dialog.getByRole("button", { name: enabled ? "재개" : "중지", exact: true });
  await expect(submit).toBeDisabled();
  await dialog.getByRole("textbox", { name: "변경 사유", exact: true }).fill("공개 운영 점검");
  await expect(submit).toBeDisabled();
  await dialog.getByRole("textbox", { name: "확인 문구", exact: true }).fill(label);
  return { button, dialog, submit };
}

test("중지·해제 모두 사유·대상과 현재 리비전을 확인하고 한 번만 보낸다", async ({ page }) => {
  const api = await fixture(page);
  await page.goto("redteam?tab=schedules");
  for (const enabled of [false, true]) {
    const { dialog, submit } = await open(page, enabled);
    expect(api.writes).toHaveLength(enabled ? 1 : 0);
    await submit.click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(() => api.writes.length).toBe(enabled ? 2 : 1);
  }
  await page.reload();
  await expect(page.getByText("긴급 중지 해제", { exact: true })).toBeVisible();
  api.check();
});

test("결과 불명 후 조회해도 같은 확인에서 재전송하지 않는다", async ({ page }) => {
  const api = await fixture(page);
  api.state.writeStatus = 503;
  await page.goto("redteam");
  const { dialog, submit } = await open(page);
  await submit.click();
  await expect(dialog.getByText("처리 결과 확인이 필요합니다.")).toBeVisible();
  await expect(submit).toBeDisabled();
  const reads = api.reads();
  await dialog.getByRole("button", { name: "현재 상태만 다시 조회" }).click();
  await expect.poll(api.reads).toBeGreaterThan(reads);
  await expect(submit).toBeDisabled();
  expect(api.writes).toHaveLength(1);
  api.check();
});

for (const kind of ["unavailable", "legacy", "readonly"] as const)
  test(`${kind}: 미확인·구형·읽기 전용 상태에서는 변경을 잠근다`, async ({ page }) => {
    const api = await fixture(page, kind === "readonly");
    if (kind === "unavailable") api.state.readStatus = 503;
    if (kind === "legacy") api.state.legacy = true;
    await page.goto("redteam");
    await expect(page.getByRole("heading", { name: "레드팀 긴급 제어", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "레드팀 처리 중지 검토" })).toBeDisabled();
    if (kind === "unavailable") {
      await expect(page.getByText("현재 레드팀 상태를 확인하지 못했습니다.")).toBeVisible();
      await expect(page.getByText("긴급 중지 해제", { exact: true })).toHaveCount(0);
    }
    expect(api.writes).toEqual([]);
    api.check();
  });

test("다른 레드팀 조회가 모두 실패해도 긴급 제어는 별도로 확인한다", async ({ page }) => {
  const api = await fixture(page);
  api.state.unrelatedFailure = true;
  await page.goto("redteam");
  await expect(page.getByRole("heading", { name: "화면을 불러오지 못했습니다." })).toBeVisible();
  const { submit } = await open(page);
  await submit.click();
  await expect.poll(() => api.writes.length).toBe(1);
  api.check();
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}px 긴급 제어·확인 화면 접근성`, async ({ page }) => {
      const api = await fixture(page);
      await page.setViewportSize({ width, height: width === 390 ? 1000 : 1100 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("redteam?tab=schedules");
      const trigger = page.getByRole("button", { name: "레드팀 처리 중지 검토" });
      await expect(trigger).toBeEnabled();
      const label = page.getByText("레드팀 실행 키", { exact: true });
      const clear = page.getByRole("button", { name: "키 지우기", exact: true });
      const labelBox = await label.boundingBox(),
        clearBox = await clear.boundingBox();
      expect(labelBox?.height).toBeLessThan(32);
      expect(clearBox?.height).toBeLessThan(48);
      expect((await trigger.boundingBox())?.height).toBeLessThan(48);
      const violations = () =>
        page.evaluate(
          async () =>
            (
              await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
                document,
              )
            ).violations,
        );
      expect(await violations()).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(page).toHaveScreenshot(`redteam-emergency-${theme}-${width}.png`, {
        fullPage: true,
        animations: "disabled",
      });
      await trigger.focus();
      await trigger.press("Enter");
      const dialog = page.getByRole("dialog", { name: "레드팀 처리 중지", exact: true });
      await expect(dialog).toBeVisible();
      expect(await violations()).toEqual([]);
      await expect(dialog).toHaveScreenshot(`redteam-emergency-review-${theme}-${width}.png`, {
        animations: "disabled",
      });
      for (let index = 0; index < 12; index++) {
        await page.keyboard.press("Tab");
        expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      expect(api.writes).toEqual([]);
      api.check();
    });
