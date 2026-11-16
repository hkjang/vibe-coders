import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installText2SqlWorkspace } from "../fixtures/text2sql-workspace-browser";
import { workspaceOverview } from "../../src/features/text2sql/overview/text2sql-workspace-fixture";

const fixtureProfile = workspaceOverview.db_profiles[0];
if (!fixtureProfile) throw new Error("Missing profile fixture");
async function install(page: Page, oldServer = false) {
  await installText2SqlWorkspace(page);
  const state = {
    profile: { ...fixtureProfile, revision: "a".repeat(64) },
    conflict: false,
    writes: [] as Record<string, unknown>[],
  };
  await page.route("**/admin/text2sql/profiles**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      if (oldServer) return route.fulfill({ json: { profiles: [state.profile] } });
      expect(url.searchParams.get("view")).toBe("review");
      const profile =
        url.searchParams.get("virtual_model") === state.profile.virtual_model ? state.profile : null;
      return route.fulfill({
        json: { review_supported: true, profile, revision: profile?.revision ?? "absent" },
      });
    }
    expect(request.method()).toBe("PUT");
    const body = request.postDataJSON() as Record<string, unknown>;
    state.writes.push(body);
    if (state.conflict) {
      state.conflict = false;
      state.profile = { ...state.profile, upstream_model: "동료 관리자 모델", revision: "b".repeat(64) };
      return route.fulfill({
        status: 409,
        json: { error: { code: "text2sql_profile_conflict", message: "stale profile" } },
        headers: { "X-Request-ID": "req_profile_conflict" },
      });
    }
    expect(body.expected_revision).toBe(state.profile.revision);
    return route.fulfill({
      json: { profile: { ...body, revision: "c".repeat(64), updated_at: "2026-11-16T00:00:00Z" } },
    });
  });
  return state;
}
async function edit(page: Page) {
  await page.goto("text2sql?tab=runtime");
  await page
    .getByRole("table", { name: "런타임 Text2SQL 프로필" })
    .getByRole("button", { name: "수정" })
    .click();
  const dialog = page.getByRole("dialog", { name: "런타임 프로필 수정" });
  await expect(dialog.getByLabel("업스트림 모델")).toHaveValue("gpt-4o");
  await expect(dialog.getByLabel("업스트림 모델")).toBeFocused();
  return dialog;
}
test("검토·충돌·최신 비교·명시적 저장·포커스 복귀", async ({ page }) => {
  const state = await install(page);
  state.conflict = true;
  const dialog = await edit(page);
  await dialog.getByLabel("업스트림 모델").fill("candidate-model");
  await dialog.getByLabel("변경 사유").fill("정산 처리 지연 개선");
  await dialog.getByRole("button", { name: "변경 검토", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "프로필 변경 검토" })).toBeFocused();
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  expect(state.writes).toHaveLength(0);
  await dialog.getByRole("button", { name: "검토한 변경 저장" }).click();
  await expect(dialog.getByText(/다른 변경이 확인되었습니다/u)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "검토한 변경 저장" })).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  await dialog.getByRole("button", { name: "최신 기준으로 다시 검토" }).click();
  await expect(dialog.getByText("동료 관리자 모델")).toBeVisible();
  await expect(dialog.getByText("candidate-model")).toBeVisible();
  await dialog.getByRole("button", { name: "검토한 변경 저장" }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toMatchObject({
    expected_revision: "b".repeat(64),
    upstream_model: "candidate-model",
    reason: "정산 처리 지연 개선",
  });
  await expect(
    page.getByRole("table", { name: "런타임 Text2SQL 프로필" }).getByRole("button", { name: "수정" }),
  ).toBeFocused();
});
test("구버전 서버에서는 편집과 저장을 차단한다", async ({ page }) => {
  const state = await install(page, true);
  await page.goto("text2sql?tab=runtime");
  await page
    .getByRole("table", { name: "런타임 Text2SQL 프로필" })
    .getByRole("button", { name: "수정" })
    .click();
  const dialog = page.getByRole("dialog", { name: "런타임 프로필 수정" });
  await expect(dialog.getByText("프로필을 확인할 수 없습니다")).toBeVisible();
  await expect(dialog.getByLabel("업스트림 모델")).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
for (const theme of ["light", "dark"] as const)
  for (const width of [390, 1440])
    test(`프로필 검토 ${theme} ${width} · 접근성·화면`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const state = await install(page);
      const dialog = await edit(page);
      await page.mouse.move(0, 0);
      await expect(dialog).toHaveScreenshot(`text2sql-profile-form-${theme}-${width}.png`, {
        animations: "disabled",
      });
      await dialog.getByLabel("업스트림 모델").fill("candidate-model");
      await dialog.getByLabel("변경 사유").fill("정산 모델 변경 범위 확인");
      await dialog.getByLabel("프로필 적용", { exact: true }).uncheck();
      await dialog.getByRole("button", { name: "변경 검토", exact: true }).click();
      await expect(dialog.getByRole("heading", { name: "프로필 변경 검토" })).toBeFocused();
      const violations = await page.evaluate(
        async () =>
          (
            await (window as unknown as { axe: { run: (options: unknown) => Promise<AxeResults> } }).axe.run({
              runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
            })
          ).violations,
      );
      expect(violations).toEqual([]);
      await dialog.getByRole("heading", { name: "프로필 변경 검토" }).focus();
      await page.mouse.move(0, 0);
      await expect(dialog).toHaveScreenshot(`text2sql-profile-review-${theme}-${width}.png`, {
        animations: "disabled",
      });
      expect(state.writes).toHaveLength(0);
    });
