import { expect, test } from "@playwright/test";
import process from "node:process";
import type { AxeResults } from "axe-core";
import { installSettingsWorkspace } from "../fixtures/settings-workspace-browser";
import { expectCellBoundaries } from "../fixtures/table-cell-boundaries";
import { expectReadableTableText } from "../fixtures/table-text-readability";

const keys = [
  [
    "env.auth_enabled",
    "bool",
    "true",
    "계정 인증 사용 여부(AUTH_ENABLED). SSO와 로컬 로그인 허용은 SSO 설정도 함께 확인하세요.",
  ],
  [
    "env.auth_access_token_ttl",
    "duration",
    "15m0s",
    "새 접근 토큰의 유효기간(AUTH_ACCESS_TOKEN_TTL). 15m0s는 15분입니다. 변경 후 재시작해야 하며 이미 발급한 토큰의 만료시각을 바꾸지 않습니다.",
  ],
  [
    "env.auth_refresh_token_ttl",
    "duration",
    "168h0m0s",
    "갱신 토큰과 세션의 유효기간(AUTH_REFRESH_TOKEN_TTL). 168h0m0s는 7일입니다. 변경 후 재시작해야 합니다.",
  ],
  [
    "env.auth_jwt_configured",
    "bool",
    "true",
    "JWT 서명 키(AUTH_JWT_SECRET)의 설정 여부만 표시하며 값은 반환하지 않습니다.",
  ],
  [
    "env.self_service_keys_enabled",
    "bool",
    "false",
    "개인의 API 키 관리 허용 여부(SELF_SERVICE_KEYS_ENABLED). 키의 권한은 사용자 역할 범위로 제한됩니다.",
  ],
];

test("실제 Go 설정 응답의 인증 시작값을 표와 상세에서 읽는다", async ({ page }) => {
  test.skip(process.env.APP_AUTH_STARTUP_LIVE !== "1", "격리된 Go embed 실행에서만 검증합니다.");
  await page.goto("system/settings?tab=runtime&category=env.auth");
  const table = page.getByRole("table", { name: "런타임 설정 목록", exact: true });
  await expect(table.getByRole("row")).toHaveCount(6);
  const ttl = table
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: "접근 토큰 유효기간", exact: true }) });
  await expect(ttl).toContainText("17m0s");
  await expect(ttl).toContainText("환경변수");
  await ttl.getByRole("link", { name: "접근 토큰 유효기간", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "접근 토큰 유효기간", exact: true });
  await expect(dialog).toContainText("17m0s");
  await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await expect(page.locator("body")).not.toContainText("public-auth-startup-only");
});

for (const width of [390, 1440])
  for (const theme of ["light", "dark"] as const) {
    test(`인증 시작 설정의 한글·읽기 전용·키보드·표 경계 ${width}px ${theme}`, async ({ page }, info) => {
      const state = await installSettingsWorkspace(page);
      state.settings = keys.map(([key = "", type = "", value = "", description = ""]) => ({
        key,
        type,
        value,
        description,
        category: "env.auth",
        read_only: true,
        restart_required: true,
        source: "env",
        effective_source: "bootstrap_env",
        can_write: false,
        is_secret: false,
        is_set: true,
      }));
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("system/settings?tab=runtime&category=env.auth");
      await expect(page.getByRole("combobox", { name: "범주", exact: true })).toHaveValue("env.auth");
      await expect(page.getByText("인증 시작 설정", { exact: true })).toBeVisible();
      const table = page.getByRole("table", { name: "런타임 설정 목록", exact: true });
      await expect(table.getByRole("row")).toHaveCount(6);
      await expectCellBoundaries(table);
      await expectReadableTableText(table);
      const keyLines = await table.getByText("env.auth_access_token_ttl", { exact: true }).evaluate((key) => {
        const lineHeight = Number.parseFloat(getComputedStyle(key).lineHeight);
        return key.getBoundingClientRect().height / lineHeight;
      });
      expect(keyLines).toBeLessThanOrEqual(2);
      await page.screenshot({ path: info.outputPath(`auth-settings-${theme}-${width}.png`), fullPage: true });
      const link = page.getByRole("link", { name: "접근 토큰 유효기간", exact: true });
      await link.focus();
      await link.press("Enter");
      const dialog = page.getByRole("dialog", { name: "접근 토큰 유효기간", exact: true });
      await expect(dialog).toBeVisible();
      await expect(page).toHaveURL(/setting=env.auth_access_token_ttl/u);
      await page.reload();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
      await expect(
        dialog.getByRole("button", { name: "기본값(환경변수)으로 되돌리기", exact: true }),
      ).toBeDisabled();
      expect(
        await page.evaluate(
          async () =>
            (
              await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
                document,
              )
            ).violations,
        ),
      ).toEqual([]);
      await expect(dialog).toHaveScreenshot(`auth-settings-detail-${theme}-${width}.png`);
      const scrollRegion = dialog.getByRole("region", { name: "설정 상세 내용", exact: true });
      await expect(scrollRegion).toHaveAttribute("tabindex", "0");
      if (width === 390) {
        await scrollRegion.focus();
        await scrollRegion.press("PageDown");
        await expect.poll(() => scrollRegion.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      }
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await link.focus();
      await link.press("Enter");
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(link).toBeFocused();
      expect(state.writes).toEqual([]);
      expect(state.unexpected).toEqual([]);
    });
  }
