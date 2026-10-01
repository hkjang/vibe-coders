import { expect, type Page } from "@playwright/test";
import {
  test,
  firstEmail,
  routingUrl,
  rule,
  ruleA,
  ruleB,
  listPath,
  mutationCount,
} from "./fixtures/routing-edit";

const dialogFor = (page: Page) => page.getByRole("dialog", { name: "라우팅 규칙 수정", exact: true });
async function login(page: Page) {
  await page.goto(`login?return_to=${encodeURIComponent(routingUrl)}`);
  await page.getByLabel("이메일", { exact: true }).fill(firstEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("table", { name: "복잡도 기반 라우팅 규칙 목록", exact: true })).toBeVisible();
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
}
async function open(page: Page) {
  const original = rule();
  const trigger = page.getByRole("button", {
    name: `${original.match_pattern} → ${original.target_model} 규칙 수정`,
    exact: true,
  });
  await trigger.click();
  const dialog = dialogFor(page);
  await expect(dialog.getByRole("textbox", { name: "대상 모델", exact: true })).toBeEnabled();
  return { dialog, trigger };
}
async function review(page: Page, target = "public-edited-model") {
  const dialog = dialogFor(page);
  await dialog.getByRole("textbox", { name: "대상 모델", exact: true }).fill(target);
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "규칙 저장", exact: true })).toBeVisible();
  return dialog;
}
async function refreshIdentity(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}

test("한글 변경 비교 뒤 같은 규칙 ID만 한 번 저장하고 생성·삭제하지 않는다", async ({
  page,
  gateway,
  editor,
}) => {
  await login(page);
  await open(page);
  const dialog = await review(page);
  await expect(dialog).toContainText("현재 저장값");
  await expect(dialog).toContainText("저장할 값");
  await expect(dialog).toContainText(rule().target_model);
  await expect(dialog).toContainText("public-edited-model");
  expect(mutationCount(gateway, editor)).toBe(0);
  editor.hold();
  await dialog.getByRole("button", { name: "규칙 저장", exact: true }).click();
  await expect.poll(() => editor.calls.length).toBe(1);
  const save = dialog.getByRole("button", { name: "규칙 저장", exact: true });
  await expect(save).toBeDisabled();
  expect(editor.calls[0]).toMatchObject({
    method: "PATCH",
    path: `${listPath}/${ruleA}`,
    body: { target_model: "public-edited-model" },
  });
  expect(editor.calls[0]?.body).not.toHaveProperty("enabled");
  expect(gateway.records()).toEqual([{ ...rule(), target_model: "public-edited-model" }, rule(ruleB)]);
  editor.release();
  await expect(page.getByText("라우팅 규칙을 저장했습니다.", { exact: true })).toBeVisible();
  expect(mutationCount(gateway, editor)).toBe(1);
});

test("변경 없는 규칙은 저장하지 않는다", async ({ page, gateway, editor }) => {
  await login(page);
  const { dialog } = await open(page);
  const button = dialog.getByRole("button", { name: "변경 내용 검토", exact: true });
  if (await button.isEnabled()) await button.click();
  await expect(dialog.getByRole("button", { name: "규칙 저장", exact: true })).toHaveCount(0);
  expect(mutationCount(gateway, editor)).toBe(0);
  expect(gateway.records()).toEqual([rule(), rule(ruleB)]);
});

test("검토 후 서버 원본이 바뀌면 초안을 보존하고 PATCH하지 않는다", async ({ page, gateway, editor }) => {
  await login(page);
  await open(page);
  const dialog = await review(page);
  gateway.setRows([{ ...rule(), enabled: false }, rule(ruleB)]);
  await dialog.getByRole("button", { name: "규칙 저장", exact: true }).click();
  await expect(dialog).toContainText("원본 규칙이 변경되었습니다");
  await expect(dialog).toContainText("public-edited-model");
  expect(mutationCount(gateway, editor)).toBe(0);
  expect(gateway.records()).toEqual([{ ...rule(), enabled: false }, rule(ruleB)]);
});

test("저장 응답이 불명확하면 실제 값 조회만 하고 같은 창에서 재전송하지 않는다", async ({
  page,
  gateway,
  editor,
}) => {
  await login(page);
  await open(page);
  const dialog = await review(page);
  editor.malformedAck();
  await dialog.getByRole("button", { name: "규칙 저장", exact: true }).click();
  await expect(dialog).toContainText("저장 여부를 확인하지 못했습니다");
  expect(gateway.records()[0]?.target_model).toBe("public-edited-model");
  expect(mutationCount(gateway, editor)).toBe(1);
  const before = gateway.count("list");
  await dialog.getByRole("button", { name: "목록 다시 조회", exact: true }).click();
  await expect.poll(() => gateway.count("list")).toBeGreaterThan(before);
  await expect(dialog.getByRole("button", { name: "규칙 저장", exact: true })).toBeDisabled();
  expect(mutationCount(gateway, editor)).toBe(1);
});

test("확인된 저장 뒤 조회 실패는 저장 실패와 구분한다", async ({ page, gateway, editor }) => {
  await login(page);
  await open(page);
  const dialog = await review(page);
  editor.failFollowingRead();
  await dialog.getByRole("button", { name: "규칙 저장", exact: true }).click();
  await expect(
    page.getByText("저장은 완료했지만 목록을 다시 조회하지 못했습니다.", { exact: true }),
  ).toBeVisible();
  expect(gateway.records()[0]?.target_model).toBe("public-edited-model");
  expect(mutationCount(gateway, editor)).toBe(1);
});

test("보호된 기존 메모는 화면·접근성 이름에 노출하거나 마스킹 문구로 덮어쓰지 않는다", async ({
  page,
  gateway,
  editor,
}) => {
  const secret = `private_edit_${"s".repeat(48)}`;
  gateway.setPrefixes(["private_edit_"]);
  gateway.setRows([{ ...rule(), note: secret }, rule(ruleB)]);
  await login(page);
  await expect(page.locator("body")).not.toContainText(secret);
  const opened = await open(page);
  await expect(opened.dialog).toContainText("기존 값 유지");
  const dialog = await review(page);
  await expect(dialog.getByRole("region", { name: "규칙 변경 비교" })).toContainText(
    "민감정보가 포함될 수 있어 표시하지 않습니다.",
  );
  expect(await page.locator("body").evaluate((body) => body.outerHTML)).not.toContain(secret);
  await dialog.getByRole("button", { name: "규칙 저장", exact: true }).click();
  await expect.poll(() => editor.calls.length).toBe(1);
  expect(editor.calls[0]?.body).not.toHaveProperty("note");
  expect(gateway.records()[0]?.note).toBe(secret);
});

test("열린 검토의 쓰기 권한을 회수하면 내용을 유지하되 저장을 막는다", async ({ page, gateway, editor }) => {
  await login(page);
  await open(page);
  const dialog = await review(page);
  gateway.setWrite(false);
  await refreshIdentity(page);
  await expect(dialog.getByRole("button", { name: "규칙 저장", exact: true })).toBeDisabled();
  await expect(dialog).toContainText("public-edited-model");
  expect(mutationCount(gateway, editor)).toBe(0);
});

test("390px 다크 화면에서 검토 표를 읽고 키보드로 이동하며 접근성 오류가 없다", async ({
  page,
  gateway,
  editor,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const dialog = await review(page, "public-edited-model-with-a-long-display-name");
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: (root: Element, options: object) => Promise<{ violations: { id: string }[] }> };
      }
    ).axe;
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error("검토 대화상자가 없습니다.");
    return (
      await axe.run(dialog, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
      })
    ).violations;
  });
  expect(violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("routing-edit-review-mobile-dark.png"), fullPage: true });
  expect(mutationCount(gateway, editor)).toBe(0);
});
