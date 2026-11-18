import { expect, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { test, firstEmail, routingUrl, rule } from "./fixtures/routing-draft";

async function prepare(page: Page) {
  await page.goto(`login?return_to=${encodeURIComponent(routingUrl)}`);
  await page.getByLabel("이메일", { exact: true }).fill(firstEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await page
    .getByRole("button", { name: `${rule().match_pattern} → ${rule().target_model} 규칙 수정`, exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "라우팅 규칙 수정", exact: true });
  await dialog.getByRole("textbox", { name: "대상 모델", exact: true }).fill("public-candidate-model");
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await dialog.getByRole("textbox", { name: "시험 모델", exact: true }).fill("public-a-request");
  await dialog
    .getByRole("textbox", { name: "예시 요청", exact: true })
    .fill("공개 예시로 모델 선택을 비교합니다.");
  await dialog.getByRole("textbox", { name: "변경 사유", exact: true }).fill("응답 모델 변경 검토");
  return dialog;
}

test("초안 계획 비교 후 같은 기준과 사유로 저장하고 새로고침해 확인한다", async ({ page, draft }) => {
  const dialog = await prepare(page);
  await expect(dialog.getByRole("button", { name: "규칙 저장", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "초안 결과 비교", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "실행 계획 비교 결과" })).toBeFocused();
  await expect(dialog).toContainText("public-candidate-model (변경)");
  await dialog.getByRole("button", { name: "규칙 저장", exact: true }).dblclick();
  await expect(dialog).toContainText("라우팅 규칙을 저장했습니다.");
  expect(draft.writes).toEqual([
    {
      expected_revision: "a".repeat(64),
      reason: "응답 모델 변경 검토",
      patch: { target_model: "public-candidate-model" },
    },
  ]);
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("table", { name: "복잡도 기반 라우팅 규칙 목록" })).toContainText(
    "public-candidate-model",
  );
});
test("저장 충돌을 자동 재전송하지 않고 입력 수정 시 비교 결과를 지운다", async ({ page, draft }) => {
  const dialog = await prepare(page);
  await dialog.getByRole("button", { name: "초안 결과 비교", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "실행 계획 비교 결과" })).toBeVisible();
  await dialog.getByRole("textbox", { name: "예시 요청", exact: true }).fill("바꾼 공개 예시");
  await expect(dialog.getByRole("heading", { name: "실행 계획 비교 결과" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "규칙 저장", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "초안 결과 비교", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "규칙 저장", exact: true })).toBeEnabled();
  draft.conflict();
  await dialog.getByRole("button", { name: "규칙 저장", exact: true }).click();
  await expect(dialog).toContainText("저장 여부를 확인하지 못했습니다.");
  await expect(dialog.getByRole("button", { name: "규칙 저장", exact: true })).toBeDisabled();
  expect(draft.writes).toHaveLength(1);
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`초안 비교 키보드·접근성·화면 ${theme}-${width}`, async ({ page, draft }) => {
      await page.setViewportSize({ width, height: 960 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.clock.setFixedTime(new Date("2026-11-17T00:00:00Z"));
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const dialog = await prepare(page);
      await dialog.getByRole("button", { name: "초안 결과 비교", exact: true }).focus();
      await page.keyboard.press("Enter");
      const heading = dialog.getByRole("heading", { name: "실행 계획 비교 결과" });
      await expect(heading).toBeFocused();
      await expect(dialog.getByRole("row", { name: /선택 모델/ })).toBeInViewport();
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (target: string) => Promise<AxeResults> } }).axe;
        return (await axe.run('[role="dialog"]')).violations.map((item) => ({
          id: item.id,
          nodes: item.nodes.map((node) => node.target),
        }));
      });
      expect(violations).toEqual([]);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(page).toHaveScreenshot(`routing-draft-${theme}-${width}.png`, { fullPage: true });
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      expect(draft.writes).toEqual([]);
    });
  }
