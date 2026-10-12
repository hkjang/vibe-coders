import { expect, type Page } from "@playwright/test";
import { first, second, test } from "../fixtures/workflow-ownership-gateway";

async function open(page: Page) {
  await page.goto("agents/workflows");
  await page.getByRole("button", { name: `${first.name} 상세 열기`, exact: true }).click();
  await expect(page.getByRole("dialog", { name: first.name, exact: true })).toBeVisible();
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}

for (const mode of ["read_only", "preview_read_only"] as const) {
  test(`${mode}: 변경 버튼을 막고 읽기 전용 모의 검사만 보낸다`, async ({ page, gateway }) => {
    gateway.setMode(mode);
    await open(page);
    const detail = page.getByRole("dialog", { name: first.name, exact: true });
    for (const name of ["게시", "수정", "삭제"])
      await expect(detail.getByRole("button", { name, exact: true })).toBeDisabled();
    await detail.getByRole("button", { name: "드라이런", exact: true }).click();
    await expect(detail.getByRole("heading", { name: "드라이런 결과", exact: true })).toBeVisible();
    expect(gateway.simulations).toEqual([first.id]);
    expect(gateway.writes).toEqual([]);
  });
}

test("열린 게시창을 읽기 전용 전환 후 키보드로 제출할 수 없다", async ({ page, gateway }) => {
  await open(page);
  await page.getByRole("button", { name: "게시", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "워크플로 게시", exact: true });
  await dialog.getByLabel(/^변경 사유/).fill("합성 게시 검토");
  gateway.setMode("read_only");
  await runtime(page);
  await expect(dialog.getByRole("button", { name: "게시", exact: true })).toBeDisabled();
  await page.keyboard.press("Enter");
  expect(gateway.writes).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("모바일 편집 초안을 보존하고 읽기 전용 전환 뒤 직접 제출도 거부한다", async ({
  page,
  gateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await open(page);
  await page.getByRole("button", { name: "수정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "워크플로 수정", exact: true });
  await dialog.getByLabel(/^이름/).fill("보존할 합성 초안");
  gateway.setMode("preview_read_only");
  await runtime(page);
  await expect(dialog.getByRole("button", { name: "수정 저장", exact: true })).toBeDisabled();
  await expect(dialog.getByLabel(/^이름/)).toHaveValue("보존할 합성 초안");
  await dialog.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
  expect(gateway.writes).toEqual([]);
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const api = (
      window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
    ).axe;
    return (await api.run(document)).violations.map(({ id }) => id);
  });
  expect(violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("workflow-readonly-mobile.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" })).toBeVisible();
  await page.getByRole("button", { name: "계속 편집", exact: true }).click();
  await expect(dialog.getByLabel(/^이름/)).toHaveValue("보존할 합성 초안");
});

test("늦은 모의 검사 결과가 다른 업무 상세에 섞이지 않는다", async ({ page, gateway }) => {
  gateway.holdSimulation();
  await open(page);
  await page.getByRole("button", { name: "드라이런", exact: true }).click();
  await expect.poll(() => gateway.simulations.length).toBe(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: `${second.name} 상세 열기`, exact: true }).click();
  const detail = page.getByRole("dialog", { name: second.name, exact: true });
  await expect(detail).toBeVisible();
  const response = page.waitForResponse(
    (item) => new URL(item.url()).pathname === "/admin/workflows/wf_first/dry-run",
  );
  gateway.releaseSimulation();
  await (await response).finished();
  await detail.getByRole("button", { name: "드라이런", exact: true }).click();
  await expect(detail.getByText("두 번째 업무 검사 근거", { exact: true })).toBeVisible();
  await expect(detail.getByText("첫 번째 업무 검사 근거", { exact: true })).toHaveCount(0);
  expect(gateway.simulations).toEqual([first.id, second.id]);
  expect(gateway.writes).toEqual([]);
});
