import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installText2SqlWorkspace } from "../fixtures/text2sql-workspace-browser";
import { workspaceOverview } from "../../src/features/text2sql/overview/text2sql-workspace-fixture";

const fixture = workspaceOverview.db_profiles[0];
if (!fixture) throw new Error("Missing profile fixture");
const initialProfile = { ...fixture, revision: "a".repeat(64) };
async function install(page: Page) {
  await installText2SqlWorkspace(page);
  const state = {
    profile: { ...initialProfile },
    deleted: false,
    conflict: false,
    unavailable: false,
    writes: [] as Record<string, unknown>[],
  };
  await page.route("**/admin/text2sql**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname === "/admin/text2sql")
      return route.fulfill({
        json: { ...workspaceOverview, db_profiles: state.deleted ? [] : [state.profile] },
      });
    if (!url.pathname.startsWith("/admin/text2sql/profiles")) return route.fallback();
    if (request.method() === "GET") {
      expect(url.pathname).toBe("/admin/text2sql/profiles");
      expect(url.searchParams.get("view")).toBe("review");
      expect(url.searchParams.get("virtual_model")).toBe(state.profile.virtual_model);
      return route.fulfill({
        json: {
          review_supported: true,
          profile: state.deleted ? null : state.profile,
          revision: state.deleted ? "absent" : state.profile.revision,
        },
      });
    }
    expect(url.pathname).toBe("/admin/text2sql/profiles/reviewed-delete");
    expect(request.method()).toBe("POST");
    const body = request.postDataJSON() as Record<string, unknown>;
    state.writes.push(body);
    expect(body.virtual_model).toBe(state.profile.virtual_model);
    expect(body.confirmation).toBe(state.profile.virtual_model);
    expect(body.reason).toBeTruthy();
    if (state.unavailable) {
      state.deleted = true;
      return route.fulfill({ status: 503, json: { error: { code: "text2sql_profile_review_unavailable" } } });
    }
    if (state.conflict) {
      state.conflict = false;
      state.profile = { ...state.profile, upstream_model: "동료 관리자 모델", revision: "b".repeat(64) };
      return route.fulfill({ status: 409, json: { error: { code: "text2sql_profile_conflict" } } });
    }
    expect(body.expected_revision).toBe(state.profile.revision);
    state.deleted = true;
    return route.fulfill({
      json: {
        virtual_model: state.profile.virtual_model,
        status: "deleted",
        reviewed_revision: state.profile.revision,
      },
    });
  });
  return state;
}
async function openDelete(page: Page) {
  await page.goto("text2sql?tab=runtime");
  await page
    .getByRole("table", { name: "런타임 Text2SQL 프로필" })
    .getByRole("button", { name: "삭제", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "런타임 프로필 삭제" });
  await expect(dialog.getByRole("heading", { name: "삭제 영향과 현재 설정" })).toBeFocused();
  await expect(dialog.getByText("프로필 삭제는 SQL 실행 중지가 아닙니다")).toBeVisible();
  return dialog;
}
test("삭제 전 검토·충돌 후 재확인·행 제거 후 본문 포커스", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  const state = await install(page);
  state.conflict = true;
  const dialog = await openDelete(page);
  await dialog.getByRole("button", { name: "검토한 프로필 삭제" }).click();
  await expect(dialog.getByLabel("삭제할 가상 모델 이름")).toBeFocused();
  expect(state.writes).toHaveLength(0);
  await dialog.getByLabel("삭제할 가상 모델 이름").fill(state.profile.virtual_model);
  await dialog.getByLabel("삭제 사유").fill("이전 설정 정리");
  await dialog.getByRole("button", { name: "검토한 프로필 삭제" }).click();
  await expect(dialog.getByRole("button", { name: "검토한 프로필 삭제" })).toBeDisabled();
  const retryBounds = await dialog.getByRole("button", { name: "최신 상태로 다시 검토" }).boundingBox();
  if (!retryBounds) throw new Error("삭제 재검토 버튼의 위치를 확인할 수 없습니다.");
  expect(retryBounds.x).toBeGreaterThanOrEqual(0);
  expect(retryBounds.x + retryBounds.width).toBeLessThanOrEqual(390);
  expect(state.writes).toHaveLength(1);
  await dialog.getByRole("button", { name: "최신 상태로 다시 검토" }).click();
  await expect(dialog.getByRole("heading", { name: "삭제 영향과 현재 설정" })).toBeFocused();
  await expect(dialog.getByText("동료 관리자 모델")).toBeVisible();
  await expect(dialog.getByText("gpt-4o")).toBeVisible();
  await expect(dialog.getByLabel("삭제할 가상 모델 이름")).toBeEmpty();
  await expect(dialog.getByLabel("삭제 사유")).toHaveValue("이전 설정 정리");
  await dialog.getByLabel("삭제할 가상 모델 이름").fill(state.profile.virtual_model);
  await dialog.getByRole("button", { name: "검토한 프로필 삭제" }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes).toHaveLength(2);
  await expect(
    page
      .getByRole("table", { name: "런타임 Text2SQL 프로필" })
      .getByRole("button", { name: "삭제", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("#main-content")).toBeFocused();
});
test("삭제 결과가 불확실하면 재전송 없이 현재 존재 여부를 확인한다", async ({ page }) => {
  const state = await install(page);
  state.unavailable = true;
  const dialog = await openDelete(page);
  await dialog.getByLabel("삭제할 가상 모델 이름").fill(state.profile.virtual_model);
  await dialog.getByLabel("삭제 사유").fill("이전 설정 정리");
  await dialog.getByRole("button", { name: "검토한 프로필 삭제" }).click();
  await dialog.getByRole("button", { name: "최신 상태로 다시 검토" }).click();
  await expect(dialog.getByText("프로필이 더 이상 존재하지 않습니다")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "취소" })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "검토한 프로필 삭제" })).toBeDisabled();
  expect(state.writes).toHaveLength(1);
});
for (const theme of ["light", "dark"] as const)
  for (const width of [390, 1440])
    test(`프로필 삭제 ${theme} ${width} · 접근성·키보드·화면`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const state = await install(page);
      const dialog = await openDelete(page);
      const violations = await page.evaluate(
        async () =>
          (
            await (window as unknown as { axe: { run: (options: unknown) => Promise<AxeResults> } }).axe.run({
              runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
            })
          ).violations,
      );
      expect(violations).toEqual([]);
      await page.mouse.move(0, 0);
      await expect(dialog).toHaveScreenshot(`text2sql-profile-delete-${theme}-${width}.png`, {
        animations: "disabled",
      });
      for (let index = 0; index < 8; index++) {
        await page.keyboard.press("Tab");
        expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      }
      await dialog.getByLabel("삭제할 가상 모델 이름").fill(state.profile.virtual_model);
      await dialog.getByLabel("삭제 사유").fill("확인한 설정 정리");
      await expect(dialog.getByText("삭제 사유를 입력하세요.", { exact: true })).toHaveCount(0);
      await expect(
        dialog.getByText("삭제할 가상 모델 이름을 정확히 입력하세요.", { exact: true }),
      ).toHaveCount(0);
      await page.mouse.move(0, 0);
      await expect(dialog).toHaveScreenshot(`text2sql-profile-delete-confirm-${theme}-${width}.png`, {
        animations: "disabled",
      });
      expect(state.writes).toHaveLength(0);
    });
