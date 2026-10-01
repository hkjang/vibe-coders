import { expect, type Locator, type Page } from "@playwright/test";
import { test, firstEmail, routingUrl, rule, ruleB, listPath } from "./fixtures/routing-create";

const dialogFor = (page: Page) => page.getByRole("dialog", { name: "라우팅 규칙 추가", exact: true });
const finalFor = (dialog: Locator) => dialog.getByRole("button", { name: "규칙 만들기", exact: true });
const impactFor = (dialog: Locator) =>
  dialog.getByRole("checkbox", {
    name: "사용 중으로 생성되는 규칙의 라우팅 영향을 확인했습니다",
    exact: true,
  });
const expectedInput = {
  match_pattern: "*",
  target_model: "public-created-model",
  target_provider: "",
  min_complexity: 0,
  max_complexity: 100,
  priority: 100,
  note: "",
  enabled: true,
};

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
  const trigger = page.getByRole("button", { name: "규칙 추가", exact: true });
  await trigger.click();
  const dialog = dialogFor(page);
  await expect(dialog.getByRole("textbox", { name: "대상 모델", exact: true })).toBeEditable();
  return { dialog, trigger };
}
async function review(dialog: Locator, model = expectedInput.target_model) {
  await dialog.getByRole("textbox", { name: "대상 모델", exact: true }).fill(model);
  await dialog.getByRole("button", { name: "생성 내용 검토", exact: true }).click();
  await expect(finalFor(dialog)).toBeVisible();
}
async function approve(dialog: Locator) {
  await impactFor(dialog).check();
  await expect(finalFor(dialog)).toBeEnabled();
}
async function refreshIdentity(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}

test("생성할 값과 활성 기본값을 먼저 읽고 영향에 동의하기 전에는 전송하지 않는다", async ({
  page,
  creator,
}) => {
  await login(page);
  const { dialog } = await open(page);
  await review(dialog);
  await expect(dialog).toContainText(expectedInput.target_model);
  await expect(dialog).toContainText("사용 중");
  await expect(finalFor(dialog)).toBeDisabled();
  expect(creator.calls).toEqual([]);
  await approve(dialog);
  expect(creator.calls).toEqual([]);
});

test("검토한 8개 값을 한 번만 전송하고 zero 생성 응답 시각을 정상 수용한다", async ({
  page,
  gateway,
  creator,
}) => {
  await login(page);
  const { dialog, trigger } = await open(page);
  await dialog.getByRole("textbox", { name: "모델 패턴", exact: true }).fill("   ");
  await review(dialog, "  public-created-model  ");
  await approve(dialog);
  creator.hold();
  await finalFor(dialog).click();
  await expect.poll(() => creator.calls.length).toBe(1);
  expect(creator.calls).toEqual([{ method: "POST", path: listPath, body: expectedInput }]);
  await expect(finalFor(dialog)).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(gateway.records().slice(0, 2)).toEqual([rule(), rule(ruleB)]);
  creator.release();
  await expect(dialog).toContainText("라우팅 규칙 생성 요청을 확인했습니다.");
  expect(gateway.records()[2]).toEqual({
    ...expectedInput,
    id: "route_created_1",
    created_at: "2026-10-02T00:00:00Z",
  });
  expect(gateway.operations.filter((item) => item.action === "patch")).toEqual([]);
  expect(creator.calls).toHaveLength(1);
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("검토에서 입력을 바꾸면 이전 동의를 버리고 새 값으로 다시 검토한다", async ({ page, creator }) => {
  await login(page);
  const { dialog } = await open(page);
  await review(dialog);
  await approve(dialog);
  await dialog.getByRole("button", { name: "입력 수정", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "모델 패턴", exact: true })).toBeFocused();
  await review(dialog, "public-revised-model");
  await expect(impactFor(dialog)).not.toBeChecked();
  await expect(finalFor(dialog)).toBeDisabled();
  await approve(dialog);
  await finalFor(dialog).click();
  await expect(dialog).toContainText("라우팅 규칙 생성 요청을 확인했습니다.");
  expect(creator.calls).toHaveLength(1);
  expect(creator.calls[0]?.body).toEqual({ ...expectedInput, target_model: "public-revised-model" });
});

test("비어 있는 목록에서도 기존 조회와 생성 API로 규칙을 만든다", async ({ page, gateway, creator }) => {
  gateway.setRows([]);
  await login(page);
  const { dialog } = await open(page);
  await review(dialog);
  await approve(dialog);
  await finalFor(dialog).click();
  await expect(dialog).toContainText("라우팅 규칙 생성 요청을 확인했습니다.");
  expect(gateway.records()).toHaveLength(1);
  expect(creator.calls).toHaveLength(1);
});

for (const mode of ["write_revoked", "read_only", "preview_read_only"] as const) {
  test(`검토 중 권한이 ${mode}로 바뀌면 생성하지 않는다`, async ({ page, gateway, creator }) => {
    await login(page);
    const { dialog } = await open(page);
    await review(dialog);
    await approve(dialog);
    if (mode === "write_revoked") gateway.setWrite(false);
    else gateway.setMode(mode);
    await refreshIdentity(page);
    await expect(finalFor(dialog)).toBeDisabled();
    await expect(dialog).toContainText(expectedInput.target_model);
    expect(creator.calls).toEqual([]);
  });
}

for (const ack of [
  {},
  { rule: {} },
  { rule: { ...expectedInput, id: "route_created_1", enabled: false, created_at: "0001-01-01T00:00:00Z" } },
]) {
  test(`불명확한 생성 응답은 수동 조회 후에도 같은 창에서 재전송하지 않는다: ${JSON.stringify(ack)}`, async ({
    page,
    gateway,
    creator,
  }) => {
    await login(page);
    const { dialog } = await open(page);
    await review(dialog);
    await approve(dialog);
    creator.ack(ack);
    await finalFor(dialog).click();
    await expect(dialog).toContainText("생성 여부를 확인하지 못했습니다.");
    expect(gateway.records()).toHaveLength(3);
    const before = gateway.count("list");
    const refresh = dialog.getByRole("button", { name: "목록 다시 조회", exact: true });
    await refresh.click();
    await expect.poll(() => gateway.count("list")).toBeGreaterThan(before);
    await expect(refresh).toHaveAttribute("aria-busy", "false");
    await expect(finalFor(dialog)).toBeDisabled();
    expect(creator.calls).toHaveLength(1);
  });
}

test("확인된 생성 요청 뒤 조회 실패는 조회만 복구하고 새 규칙을 중복 생성하지 않는다", async ({
  page,
  gateway,
  creator,
}) => {
  await login(page);
  const { dialog } = await open(page);
  await review(dialog);
  await approve(dialog);
  creator.failFollowingRead();
  await finalFor(dialog).click();
  await expect(dialog).toContainText("생성 요청은 확인했지만 목록을 다시 조회하지 못했습니다.");
  await expect(dialog).toContainText("라우팅 규칙 생성 요청을 확인했습니다.");
  gateway.setStatus("list", 200);
  const refresh = dialog.getByRole("button", { name: "목록 다시 조회", exact: true });
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(dialog).not.toContainText("생성 요청은 확인했지만 목록을 다시 조회하지 못했습니다.");
  expect(creator.calls).toHaveLength(1);
});

test("입력한 초안을 닫을 때 계속 편집하거나 명시적으로 버릴 수 있다", async ({ page, creator }) => {
  await login(page);
  const { dialog, trigger } = await open(page);
  await dialog.getByRole("textbox", { name: "대상 모델", exact: true }).fill(expectedInput.target_model);
  await page.keyboard.press("Escape");
  const warning = page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다", exact: true });
  await expect(warning).toBeVisible();
  await warning.getByRole("button", { name: "계속 편집", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "대상 모델", exact: true })).toHaveValue(
    expectedInput.target_model,
  );
  await page.keyboard.press("Escape");
  await warning.getByRole("button", { name: "변경 버리기", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(creator.calls).toEqual([]);
});

test("잘못된 복잡도 범위는 첫 오류 입력에 초점을 돌리고 전송하지 않는다", async ({ page, creator }) => {
  await login(page);
  const { dialog } = await open(page);
  await dialog.getByRole("spinbutton", { name: "최소 복잡도", exact: true }).fill("80");
  await dialog.getByRole("spinbutton", { name: "최대 복잡도", exact: true }).fill("20");
  await dialog.getByRole("textbox", { name: "대상 모델", exact: true }).fill(expectedInput.target_model);
  await dialog.getByRole("button", { name: "생성 내용 검토", exact: true }).click();
  await expect(dialog.getByRole("spinbutton", { name: "최소 복잡도", exact: true })).toBeFocused();
  expect(creator.calls).toEqual([]);
});

test("390px 다크 화면에서 검토·동의를 키보드로 사용하고 접근성 오류가 없다", async ({
  page,
  creator,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const { dialog } = await open(page);
  await review(dialog);
  await expect(dialog.getByRole("heading", { name: "생성 내용 검토", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(impactFor(dialog)).toBeFocused();
  await page.keyboard.press("Space");
  await expect(impactFor(dialog)).toBeChecked();
  const finalButton = finalFor(dialog);
  await expect(finalButton).toBeInViewport({ ratio: 1 });
  expect(
    await finalButton.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      return button.contains(
        document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
      );
    }),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: (root: Element, options: object) => Promise<{ violations: { id: string }[] }> };
      }
    ).axe;
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error("생성 검토 대화상자가 없습니다.");
    return (
      await axe.run(dialog, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
      })
    ).violations;
  });
  expect(violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("routing-create-review-mobile-dark.png"),
    fullPage: true,
  });
  expect(creator.calls).toEqual([]);
});
