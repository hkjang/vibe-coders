import { expect, type Page } from "@playwright/test";
import {
  test,
  recorder,
  sessionA,
  sessionList,
  type FlightRecorderGateway,
} from "./fixtures/flight-recorder-state";

// Synthetic HTTP denial with real Auth/Query/Router/Sheet. Server RBAC is tested separately.
const denied = (status = 403, requestId = "public-session-denial") => ({
  status,
  requestId,
  body: { error: { message: "PRIVATE_DENIAL_BODY" } },
});
async function enter(page: Page, gateway: FlightRecorderGateway) {
  gateway.authMode("open");
  await page.goto("observability/sessions");
  await expect(
    page.getByRole("button", { name: `${sessionA.session_id} 세션 비행기록 열기`, exact: true }),
  ).toBeVisible();
}
async function open(page: Page) {
  await page.getByRole("button", { name: `${sessionA.session_id} 세션 비행기록 열기`, exact: true }).click();
  await expect(page.getByText("public-flight-request", { exact: true })).toBeVisible();
}
async function runtime(page: Page) {
  const reply = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admin/ui-bootstrap",
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await reply).finished();
}
for (const status of [401, 403]) {
  test(`상세 HTTP ${status} 이후 기록을 숨기고 명시 재조회로 복구한다`, async ({ page, gateway }) => {
    await page.clock.install();
    await enter(page, gateway);
    await open(page);
    gateway.reply(2, denied(status));
    await page.getByRole("button", { name: "비행기록 다시 조회", exact: true }).click();
    const notice = page.getByRole("dialog").getByRole("alert");
    await expect(notice).toContainText("비행기록 조회가 거부되었습니다.");
    await expect(notice).toBeFocused();
    await expect(notice).toContainText("public-session-denial");
    await expect(page.getByText("public-flight-request", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "CSV 내보내기", exact: true })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("PRIVATE_DENIAL_BODY");
    await page.clock.fastForward(61_000);
    await runtime(page);
    expect(gateway.detailCalls).toHaveLength(2);
    gateway.hold(3);
    await notice.getByRole("button", { name: "권한 확인 후 다시 조회" }).click();
    await expect.poll(() => gateway.detailCalls.length).toBe(3);
    await expect(page.getByText("public-flight-request", { exact: true })).toHaveCount(0);
    gateway.release(3);
    await expect(page.getByText("public-flight-request", { exact: true })).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "CSV 내보내기", exact: true }).click();
    expect(await (await download).failure()).toBeNull();
    expect(gateway.downloads).toHaveLength(1);
  });

  test(`목록 HTTP ${status} 이후 기간 변경으로 이전 기록을 복원하지 않는다`, async ({ page, gateway }) => {
    await page.clock.install();
    await enter(page, gateway);
    gateway.period(7, denied(status, "corp_" + "x".repeat(32)));
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    const notice = page.getByRole("alert");
    await expect(notice).toContainText("세션 목록 조회가 거부되었습니다.");
    await expect(notice).toBeFocused();
    await expect(
      page.getByRole("button", { name: `${sessionA.session_id} 세션 비행기록 열기`, exact: true }),
    ).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("corp_" + "x".repeat(32));
    await page.getByLabel("조회 기간(일)").fill("30");
    await page.getByRole("button", { name: "조회", exact: true }).click();
    await page.clock.fastForward(61_000);
    await runtime(page);
    expect(gateway.listCalls).toHaveLength(2);
    await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "권한 확인 후 다시 조회" }).click();
    await expect(
      page.getByRole("button", { name: `${sessionA.session_id} 세션 비행기록 열기`, exact: true }),
    ).toBeVisible();
    expect(gateway.listCalls).toHaveLength(3);
    expect(gateway.listCalls[2]?.url.searchParams.get("days")).toBe("30");
    expect(gateway.detailCalls).toHaveLength(0);
  });
}

test("목록 자동 갱신이 거부되어도 허용된 상세와 키보드 포커스를 유지한다", async ({ page, gateway }) => {
  await page.clock.install();
  await enter(page, gateway);
  await page.getByRole("combobox", { name: "자동 새로고침 간격", exact: true }).selectOption("60");
  await open(page);
  const csv = page.getByRole("button", { name: "CSV 내보내기", exact: true });
  await csv.focus();
  gateway.period(7, denied());
  await page.clock.fastForward(61_000);
  await expect.poll(() => gateway.listCalls.length).toBe(2);
  await expect(page.getByText("세션 목록 조회가 거부되었습니다.")).toBeAttached();
  await expect(csv).toBeFocused();
  await expect(page.getByText("public-flight-request", { exact: true })).toBeVisible();
  expect(gateway.detailCalls).toHaveLength(1);
  const download = page.waitForEvent("download");
  await csv.click();
  expect(await (await download).failure()).toBeNull();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alert")).toBeVisible();
  gateway.period(7, { body: sessionList(7) });
  await page.getByRole("button", { name: "권한 확인 후 다시 조회" }).click();
  await expect(
    page.getByRole("button", { name: `${sessionA.session_id} 세션 비행기록 열기`, exact: true }),
  ).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 조회 거부 안내와 키보드 복구 접근성`, async ({ page, gateway }) => {
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 1000 });
      await enter(page, gateway);
      await open(page);
      gateway.reply(2, denied());
      await page.getByRole("button", { name: "비행기록 다시 조회", exact: true }).click();
      const notice = page.getByRole("dialog").getByRole("alert");
      await expect(notice).toBeFocused();
      await expect(notice).toHaveScreenshot(`session-denied-${theme}-${width}.png`);
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
      gateway.reply(3, { body: recorder() });
      await page.keyboard.press("Enter");
      await expect(page.getByText("public-flight-request", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: `${sessionA.session_id} 세션 비행기록 열기`, exact: true }),
      ).toBeFocused();
    });
  }
}
