import { expect, type Page } from "@playwright/test";
import { first, second, test } from "../fixtures/mcp-upstream-gateway";

async function open(page: Page) {
  await page.goto(`mcp?tab=upstreams&upstream=${first.id}`);
  await expect(page.getByRole("dialog", { name: first.name, exact: true })).toBeVisible();
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
for (const mode of ["read_only", "preview_read_only"] as const) {
  test(`${mode}: MCP 서버 조회는 유지하고 변경·진단은 차단한다`, async ({ page, gateway }) => {
    gateway.setMode(mode);
    await open(page);
    const detail = page.getByRole("dialog", { name: first.name, exact: true });
    for (const name of ["수정", "삭제", "연결 진단", "사용 중지"])
      await expect(detail.getByRole("button", { name, exact: true })).toBeDisabled();
    expect(gateway.writes).toEqual([]);
  });
}
test("MCP 서버 이름 검색에서 키보드로 상세를 열고 주소를 복원한다", async ({ page, gateway }) => {
  await page.goto("mcp?tab=upstreams");
  await expect(page.getByRole("heading", { name: "MCP 운영", exact: true })).toBeVisible();
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
  await palette.getByRole("button", { name: "자원 검색", exact: true }).click();
  await palette.getByRole("combobox").fill("첫 번째");
  await expect(palette.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: first.name, exact: true })).toBeVisible();
  expect(gateway.searches).toEqual([{ query: "첫 번째", kinds: ["mcp_upstream"] }]);
  expect(new URL(page.url()).searchParams.get("tab")).toBe("upstreams");
  await page.reload();
  await expect(page.getByRole("dialog", { name: first.name, exact: true })).toBeVisible();
  expect(gateway.writes).toEqual([]);
});
test("없는 MCP 서버의 주소를 정상 중지 상태로 표시하지 않는다", async ({ page, gateway }) => {
  await page.goto("mcp?tab=upstreams&upstream=missing-server");
  const detail = page.getByRole("dialog");
  await expect(detail.getByText("MCP 서버를 찾을 수 없습니다.", { exact: true })).toBeVisible();
  await expect(detail.getByText("상태", { exact: true })).toHaveCount(0);
  expect(gateway.reads).toEqual(["GET /admin/mcp/upstreams"]);
  expect(gateway.writes).toEqual([]);
});
test("모바일 MCP 편집 초안을 읽기 전용 전환 후에도 보존한다", async ({ page, gateway }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await open(page);
  await page.getByRole("button", { name: "수정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "업스트림 수정", exact: true });
  await dialog.getByLabel(/^표시 이름/).fill("보존할 서버 초안");
  gateway.setMode("read_only");
  await runtime(page);
  await expect(dialog.getByLabel(/^표시 이름/)).toHaveValue("보존할 서버 초안");
  await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await dialog.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
  expect(gateway.writes).toEqual([]);
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
    ).axe;
    return (await axe.run(document)).violations.map(({ id }) => id);
  });
  expect(violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("mcp-readonly-mobile.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" })).toBeVisible();
});
test("MCP 삭제 확인 중 읽기 전용 전환은 확인만 잠근다", async ({ page, gateway }) => {
  await open(page);
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "업스트림을 삭제할까요?", exact: true });
  gateway.setMode("preview_read_only");
  await runtime(page);
  await expect(dialog.getByRole("button", { name: "삭제", exact: true })).toBeDisabled();
  await page.keyboard.press("Enter");
  expect(gateway.writes).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});
test("MCP 조회 권한을 잃으면 이전 서버 상세를 즉시 제거한다", async ({ page, gateway }) => {
  await open(page);
  gateway.setMode("no_read");
  await runtime(page);
  await expect(page.getByRole("dialog", { name: first.name, exact: true })).not.toBeVisible();
  await expect(page.getByText("MCP 서버 조회 권한이 없습니다.", { exact: true })).toBeVisible();
  expect(gateway.writes).toEqual([]);
});
test("늦은 연결 진단 결과를 다른 MCP 서버에 표시하지 않는다", async ({ page, gateway }) => {
  gateway.holdProbe();
  await open(page);
  await page.getByRole("button", { name: "연결 진단", exact: true }).click();
  await expect.poll(() => gateway.writes.length).toBe(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: `${second.name} 상세 열기`, exact: true }).click();
  gateway.releaseProbe();
  const detail = page.getByRole("dialog", { name: second.name, exact: true });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("button", { name: "연결 진단", exact: true })).toBeEnabled();
  await expect(detail.getByText("first-server-only-tool", { exact: true })).toHaveCount(0);
});
