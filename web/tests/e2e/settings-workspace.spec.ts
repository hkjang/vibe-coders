import { expect, test } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installSettingsWorkspace, runtimeKey } from "../fixtures/settings-workspace-browser";

const direct = `system/settings?tab=runtime&q=목록밖&setting=${runtimeKey}`;

test("목록과 독립적인 설정 상세 주소·새로고침·키보드와 뒤로 이동", async ({ page }) => {
  const state = await installSettingsWorkspace(page);
  await page.goto("system/settings?tab=runtime&q=cache&category=cache");
  const link = page.getByRole("link", { name: runtimeKey, exact: true });
  await link.focus();
  await link.press("Enter");
  const sheet = page.getByRole("dialog", { name: runtimeKey, exact: true });
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(/setting=cache.chat_enabled/);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(link).toBeFocused();
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({
    tab: "runtime",
    q: "cache",
    category: "cache",
  });
  await link.press("Enter");
  await expect(sheet).toBeVisible();
  await page.goBack();
  await expect(sheet).toBeHidden();
  await page.goForward();
  await expect(sheet).toBeVisible();
  await page.goto(direct);
  await expect(sheet).toBeVisible();
  await page.reload();
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page.getByText("조건에 맞는 설정이 없습니다.")).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("복구 확인 코드는 상세 조회가 아닌 복구 작업을 선택한 뒤 로드한다", async ({ page }) => {
  const state = await installSettingsWorkspace(page);
  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname);
  });
  await page.goto(direct);
  const sheet = page.getByRole("dialog", { name: runtimeKey, exact: true });
  const revert = sheet.getByRole("button", { name: "기본값(환경변수)으로 되돌리기", exact: true });
  await expect(revert).toBeEnabled();
  expect(scripts.some((path) => /SettingsRecoveryDialog-/u.test(path))).toBe(false);
  await revert.click();
  await expect(page.getByRole("dialog", { name: "환경변수 기본값으로 되돌리기", exact: true })).toBeVisible();
  expect(scripts.some((path) => /SettingsRecoveryDialog-/u.test(path))).toBe(true);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("범주 관리자 저장은 서버 버전 조건을 보내고 읽기 전용 계정은 차단한다", async ({ page }) => {
  const state = await installSettingsWorkspace(page, "ops_admin");
  await page.goto(direct);
  const sheet = page.getByRole("dialog", { name: runtimeKey, exact: true });
  await sheet.getByLabel("새 값", { exact: true }).selectOption("false");
  await sheet.getByLabel("변경 사유").fill("캐시 동작 검토");
  await sheet.getByRole("button", { name: "저장", exact: true }).click();
  await expect(sheet).toBeHidden();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]?.postDataJSON()).toEqual({
    value: "false",
    reason: "캐시 동작 검토",
    expected_version: 3,
  });
  await expect(page.getByRole("button", { name: "ClickHouse 연결 테스트" })).toBeDisabled();
  expect(state.unexpected).toEqual([]);
});

test("조회 계정은 직접 상세에서도 저장·복구·연결 테스트를 실행하지 못한다", async ({ page }) => {
  const state = await installSettingsWorkspace(page, "viewer");
  await page.goto(direct);
  const sheet = page.getByRole("dialog", { name: runtimeKey, exact: true });
  await expect(sheet.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "기본값(환경변수)으로 되돌리기" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "ClickHouse 연결 테스트" })).toBeDisabled();
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("설정 상세 조회 실패에서 요청 ID와 재시도로 복구한다", async ({ page }) => {
  const state = await installSettingsWorkspace(page);
  state.failOnce = true;
  await page.goto(direct);
  const unavailable = page.getByRole("dialog", { name: "설정 상세", exact: true });
  await expect(unavailable.getByText("요청 ID: settings-workspace-fixture")).toBeVisible();
  await unavailable.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByRole("dialog", { name: runtimeKey, exact: true })).toBeVisible();
  expect(state.unexpected).toEqual([]);
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 설정 상세와 초안 접근성·시각 기준`, async ({ page }) => {
      const state = await installSettingsWorkspace(page);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto(direct);
      const sheet = page.getByRole("dialog", { name: runtimeKey, exact: true });
      await sheet.getByLabel("새 값", { exact: true }).selectOption("false");
      await sheet.getByLabel("변경 사유").fill("배포 전 캐시 사용 여부 검토");
      await expect(sheet.getByRole("button", { name: "저장", exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(sheet).toHaveCSS("opacity", "1");
      const violations = await page.evaluate(
        async () =>
          (
            await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
              document,
            )
          ).violations,
      );
      expect(violations).toEqual([]);
      await expect(sheet).toHaveScreenshot(`runtime-setting-${theme}-${width}.png`, {
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      const guard = page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" });
      await expect(guard).toBeVisible();
      await guard.getByRole("button", { name: "계속 편집" }).click();
      await expect(sheet.getByLabel("변경 사유")).toHaveValue("배포 전 캐시 사용 여부 검토");
      expect(state.writes).toEqual([]);
      expect(state.unexpected).toEqual([]);
    });
  }

test("설정 초안 폐기 뒤로가기는 필터 주소를 보존하고 앞으로 이동에서 초기 값을 연다", async ({ page }) => {
  const state = await installSettingsWorkspace(page);
  await page.goto("system/settings?tab=runtime&q=cache&category=cache");
  const before = page.url();
  await page.getByRole("link", { name: runtimeKey, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: runtimeKey, exact: true });
  await sheet.getByLabel("새 값", { exact: true }).selectOption("false");
  await page.goBack();
  await page.getByRole("button", { name: "계속 편집", exact: true }).click();
  await expect(sheet.getByLabel("새 값", { exact: true })).toHaveValue("false");
  await page.goBack();
  await page.getByRole("button", { name: "변경 버리기", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(before);
  await page.goForward();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("새 값", { exact: true })).toHaveValue("true");
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
