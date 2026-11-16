import { expect, type Page } from "@playwright/test";
import { test, flowRequestA, type TraceFlowGateway } from "./fixtures/trace-safe-flow";
import { test as requestTest } from "./fixtures/request-safe-flow";

// Synthetic HTTP status changes; actual Auth/Query/Router/focus behavior. Server RBAC has separate tests.
const row = (page: Page) =>
  page.getByRole("button", { name: "1번째 요청 [값 비공개] 상세 보기", exact: true });
const table = (page: Page) => page.getByRole("table", { name: "기록된 요청 단계와 시간", exact: true });
const denied = (status = 403, requestId = "public-trace-denial") => ({
  status,
  requestId,
  body: { error: { message: "PRIVATE_DENIAL_BODY" } },
});
async function enter(page: Page, gateway: TraceFlowGateway) {
  gateway.authMode("open");
  await page.goto(`observability/traces?trace_id=public-trace&selected_ref=${flowRequestA.request_ref}`);
  await expect(table(page)).toBeVisible();
}
async function runtime(page: Page) {
  const reply = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admin/ui-bootstrap",
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await reply).finished();
}
for (const status of [401, 403]) {
  test(`목록 HTTP ${status} 이후 연결된 단계도 정리하고 주소 조건으로 다시 조회한다`, async ({
    page,
    gateway,
  }) => {
    await page.clock.install();
    await enter(page, gateway);
    const address = page.url();
    gateway.listReply(2, denied(status));
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    const notice = page.getByRole("alert");
    await expect(notice).toContainText("추적 목록 조회가 거부되었습니다.");
    await expect(notice).toBeFocused();
    await expect(row(page)).toHaveCount(0);
    await expect(table(page)).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("PRIVATE_DENIAL_BODY");
    expect(page.url()).toBe(address);
    await page.clock.fastForward(61_000);
    await runtime(page);
    expect(gateway.listReads()).toBe(2);
    expect(gateway.calls).toHaveLength(1);
    gateway.holdList(3);
    await notice.getByRole("button", { name: "권한 확인 후 다시 조회" }).click();
    await expect.poll(() => gateway.listReads()).toBe(3);
    await expect(table(page)).toHaveCount(0);
    gateway.releaseList(3);
    await expect(table(page)).toBeVisible();
    await expect(row(page)).toBeVisible();
    expect(gateway.calls).toHaveLength(2);
    expect(page.url()).toBe(address);
  });

  test(`단계 HTTP ${status} 이후 목록 갱신으로 기록을 자동 복원하지 않는다`, async ({ page, gateway }) => {
    await enter(page, gateway);
    gateway.reply(2, denied(status));
    await page.getByRole("button", { name: "단계 기록 다시 조회", exact: true }).click();
    const notice = page.getByRole("alert");
    await expect(notice).toContainText("단계 기록 조회가 거부되었습니다.");
    await expect(notice).toBeFocused();
    await expect(notice).toContainText("public-trace-denial");
    await expect(row(page)).toBeVisible();
    await expect(table(page)).toHaveCount(0);
    gateway.holdList(2);
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect(notice.getByRole("button", { name: "권한 확인 후 다시 조회" })).toBeDisabled();
    gateway.releaseList(2);
    await expect(notice.getByRole("button", { name: "권한 확인 후 다시 조회" })).toBeEnabled();
    expect(gateway.calls).toHaveLength(2);
    gateway.holdFlow(3);
    await notice.getByRole("button", { name: "권한 확인 후 다시 조회" }).click();
    await expect.poll(() => gateway.calls.length).toBe(3);
    await expect(table(page)).toHaveCount(0);
    gateway.releaseFlow(3);
    await expect(table(page)).toBeVisible();
    expect(gateway.listReads()).toBe(2);
  });

  requestTest(
    `요청 상세 HTTP ${status} 거부 뒤 같은 대화상자에서 단계만 복구한다`,
    async ({ page, gateway }) => {
      gateway.authMode("open");
      await page.goto("observability/requests");
      await row(page).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "처리 단계 보기", exact: true }).click();
      await expect(table(page)).toBeVisible();
      gateway.reply(2, denied(status, "corp_" + "x".repeat(32)));
      await dialog.getByRole("button", { name: "단계 기록 다시 조회", exact: true }).click();
      const notice = dialog.getByRole("alert");
      await expect(notice).toBeFocused();
      await expect(table(page)).toHaveCount(0);
      await expect(notice).not.toContainText("corp_" + "x".repeat(32));
      await expect(dialog).toBeVisible();
      expect(gateway.listReads()).toBe(1);
      await page.keyboard.press("Tab");
      await expect(notice.getByRole("button", { name: "권한 확인 후 다시 조회" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(table(page)).toBeVisible();
      expect(gateway.calls).toHaveLength(3);
      expect(gateway.listReads()).toBe(1);
      await page.keyboard.press("Escape");
      await expect(row(page)).toBeFocused();
    },
  );
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 단계 조회 거부 안내와 키보드 복구`, async ({ page, gateway }) => {
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 1000 });
      await enter(page, gateway);
      gateway.reply(2, denied());
      await page.getByRole("button", { name: "단계 기록 다시 조회", exact: true }).click();
      const notice = page.getByRole("alert");
      await expect(notice).toBeFocused();
      await expect(notice).toHaveScreenshot(`trace-denied-${theme}-${width}.png`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const violations = await page.evaluate(async () => {
        const axe = (
          window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
        ).axe;
        return (await axe.run(document)).violations.map((item) => item.id);
      });
      expect(violations).toEqual([]);
      await page.keyboard.press("Tab");
      await expect(notice.getByRole("button", { name: "권한 확인 후 다시 조회" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(table(page)).toBeVisible();
      await page.getByRole("button", { name: "요청 상세 닫기", exact: true }).click();
      await expect(page.getByRole("heading", { name: "추적 탐색기", exact: true })).toBeFocused();
    });
  }
}
