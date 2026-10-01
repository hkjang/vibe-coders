import { expect, type Locator, type Page } from "@playwright/test";
import {
  test,
  firstEmail,
  routingUrl,
  rule,
  ruleA,
  ruleB,
  listPath,
  mutationCount,
} from "./fixtures/routing-delete";

const dialogFor = (page: Page) => page.getByRole("dialog", { name: "라우팅 규칙 삭제", exact: true });
const phraseFor = (dialog: Locator) => dialog.getByRole("textbox", { name: "삭제 확인 문구", exact: true });
const activeFor = (dialog: Locator) =>
  dialog.getByRole("checkbox", { name: "사용 중인 규칙의 라우팅 영향을 확인했습니다", exact: true });
const finalFor = (dialog: Locator) => dialog.getByRole("button", { name: "규칙 삭제", exact: true });
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
  const trigger = page.getByRole("button", {
    name: `${rule().match_pattern} → ${rule().target_model} 규칙 삭제`,
    exact: true,
  });
  await trigger.click();
  const dialog = dialogFor(page);
  await expect(phraseFor(dialog)).toBeEditable();
  return { dialog, trigger };
}
async function confirm(dialog: Locator, active = true) {
  await phraseFor(dialog).fill("규칙 삭제");
  if (active) await activeFor(dialog).check();
  await expect(finalFor(dialog)).toBeEnabled();
}
async function refreshIdentity(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}

test("고정된 대상과 사용 중 영향 확인 전에는 삭제할 수 없다", async ({ page, gateway, deleter }) => {
  await login(page);
  const { dialog } = await open(page);
  await expect(dialog).toContainText(ruleA);
  await expect(dialog).toContainText(rule().target_model);
  await expect(dialog).toContainText("사용 중");
  await expect(finalFor(dialog)).toBeDisabled();
  await phraseFor(dialog).fill("삭제");
  await activeFor(dialog).check();
  await expect(finalFor(dialog)).toBeDisabled();
  await activeFor(dialog).uncheck();
  await phraseFor(dialog).fill("규칙 삭제");
  await expect(finalFor(dialog)).toBeDisabled();
  expect(mutationCount(gateway, deleter)).toBe(0);
});

test("현재 원본 확인 뒤 고정 ID를 한 번만 삭제하고 다른 규칙과 복귀 초점을 보존한다", async ({
  page,
  gateway,
  deleter,
}) => {
  await login(page);
  const { dialog } = await open(page);
  await confirm(dialog);
  const reads = gateway.count("list");
  deleter.hold();
  await finalFor(dialog).click();
  await expect.poll(() => deleter.calls.length).toBe(1);
  expect(gateway.count("list")).toBeGreaterThan(reads);
  expect(deleter.calls).toEqual([{ method: "DELETE", path: `${listPath}/${ruleA}`, body: null }]);
  expect(gateway.records()).toEqual([rule(ruleB)]);
  await expect(finalFor(dialog)).toBeDisabled();
  deleter.release();
  await expect(dialog).toContainText("라우팅 규칙 삭제 요청을 확인했습니다.");
  expect(mutationCount(gateway, deleter)).toBe(1);
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.classList.contains("routing-panel-stack")))
    .toBe(true);
});

test("취소하면 삭제하지 않고 원래 버튼으로 복귀한다", async ({ page, gateway, deleter }) => {
  await login(page);
  const { dialog, trigger } = await open(page);
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(mutationCount(gateway, deleter)).toBe(0);
  expect(gateway.records()).toEqual([rule(), rule(ruleB)]);
});

test("검토 후 바뀐 서버 원본은 삭제하지 않는다", async ({ page, gateway, deleter }) => {
  await login(page);
  const { dialog } = await open(page);
  await confirm(dialog);
  gateway.setRows([{ ...rule(), priority: 30 }, rule(ruleB)]);
  await finalFor(dialog).click();
  await expect(dialog).toContainText("원본 규칙이 변경되었거나 없습니다");
  expect(mutationCount(gateway, deleter)).toBe(0);
  expect(gateway.records()).toEqual([{ ...rule(), priority: 30 }, rule(ruleB)]);
});

for (const mode of ["write_revoked", "read_only", "preview_read_only"] as const) {
  test(`열린 확인에서 권한 상태가 ${mode}로 바뀌면 삭제를 막는다`, async ({ page, gateway, deleter }) => {
    await login(page);
    const { dialog } = await open(page);
    await confirm(dialog);
    if (mode === "write_revoked") gateway.setWrite(false);
    else gateway.setMode(mode);
    await refreshIdentity(page);
    await expect(finalFor(dialog)).toBeDisabled();
    await expect(dialog).toContainText(rule().target_model);
    expect(mutationCount(gateway, deleter)).toBe(0);
  });
}

for (const ack of [{}, { id: ruleB, status: "deleted" }, { id: ruleA, status: "ok" }]) {
  test(`불명확한 삭제 응답은 재조회해도 같은 창에서 재전송하지 않는다: ${JSON.stringify(ack)}`, async ({
    page,
    gateway,
    deleter,
  }) => {
    await login(page);
    const { dialog } = await open(page);
    await confirm(dialog);
    deleter.ack(ack);
    await finalFor(dialog).click();
    await expect(dialog).toContainText("삭제 여부를 확인하지 못했습니다.");
    expect(gateway.records()).toEqual([rule(ruleB)]);
    const reads = gateway.count("list");
    await dialog.getByRole("button", { name: "목록 다시 조회", exact: true }).click();
    await expect.poll(() => gateway.count("list")).toBeGreaterThan(reads);
    await expect(dialog.getByRole("button", { name: "목록 다시 조회", exact: true })).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expect(finalFor(dialog)).toBeDisabled();
    expect(mutationCount(gateway, deleter)).toBe(1);
  });
}

test("삭제 요청 확인 뒤 조회 실패는 삭제 실패와 구분하고 조회만 복구한다", async ({
  page,
  gateway,
  deleter,
}) => {
  await login(page);
  const { dialog } = await open(page);
  await confirm(dialog);
  deleter.failFollowingRead();
  await finalFor(dialog).click();
  await expect(dialog).toContainText("삭제 요청은 확인했지만 목록을 다시 조회하지 못했습니다.");
  await expect(dialog).toContainText("라우팅 규칙 삭제 요청을 확인했습니다.");
  expect(gateway.records()).toEqual([rule(ruleB)]);
  expect(mutationCount(gateway, deleter)).toBe(1);
  gateway.setStatus("list", 200);
  await dialog.getByRole("button", { name: "목록 다시 조회", exact: true }).click();
  await expect(dialog).not.toContainText("삭제 요청은 확인했지만 목록을 다시 조회하지 못했습니다.");
  expect(mutationCount(gateway, deleter)).toBe(1);
});

test("보호된 원문은 삭제 대상 설명과 접근성 이름에도 노출하지 않는다", async ({ page, gateway, deleter }) => {
  const secret = `private_delete_${"x".repeat(48)}`;
  const protectedRule = {
    ...rule(),
    id: `${secret}_id`,
    match_pattern: `${secret}_pattern`,
    target_model: `${secret}_model`,
    target_provider: `${secret}_provider`,
    note: `${secret}_note`,
  };
  gateway.setPrefixes(["private_delete_"]);
  gateway.setRows([protectedRule, rule(ruleB)]);
  await login(page);
  expect(await page.locator("body").evaluate((body) => body.outerHTML)).not.toContain(secret);
  await page
    .getByRole("button", { name: /규칙 삭제$/ })
    .first()
    .click();
  const dialog = dialogFor(page);
  await expect(phraseFor(dialog)).toBeEditable();
  await expect(dialog).toContainText("민감정보가 포함될 수 있어 표시하지 않습니다.");
  expect(await page.locator("body").evaluate((body) => body.outerHTML)).not.toContain(secret);
  await confirm(dialog);
  await finalFor(dialog).click();
  await expect(dialog).toContainText("라우팅 규칙 삭제 요청을 확인했습니다.");
  expect(deleter.calls).toEqual([{ method: "DELETE", path: `${listPath}/${protectedRule.id}`, body: null }]);
  expect(gateway.records()).toEqual([rule(ruleB)]);
});

test("중지된 규칙도 명시 문구로 확인하며 사용 중 동의는 요구하지 않는다", async ({
  page,
  gateway,
  deleter,
}) => {
  gateway.setRows([rule(ruleA, false), rule(ruleB)]);
  await login(page);
  const { dialog } = await open(page);
  await expect(dialog).toContainText("중지됨");
  await expect(activeFor(dialog)).toHaveCount(0);
  await confirm(dialog, false);
  await finalFor(dialog).click();
  await expect(dialog).toContainText("라우팅 규칙 삭제 요청을 확인했습니다.");
  expect(mutationCount(gateway, deleter)).toBe(1);
});

test("390px 다크 화면의 삭제 확인을 키보드로 읽고 접근성 오류 없이 취소한다", async ({
  page,
  gateway,
  deleter,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const { dialog } = await open(page);
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
    if (!dialog) throw new Error("삭제 확인 대화상자가 없습니다.");
    return (
      await axe.run(dialog, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
      })
    ).violations;
  });
  expect(violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("routing-delete-review-mobile-dark.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(mutationCount(gateway, deleter)).toBe(0);
});
