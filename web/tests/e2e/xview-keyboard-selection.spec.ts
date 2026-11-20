import { expect, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { firstEmail, firstId, xviewUrl } from "../fixtures/request-note-gateway";
import { cursor, livePoint, serverStart, test } from "../fixtures/xview-live-gateway";

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
});

async function enter(page: Page) {
  const tableAssets: string[] = [];
  page.on("request", (request) => {
    if (/\/ScatterRequestTable-[^/]+\.js$/u.test(new URL(request.url()).pathname))
      tableAssets.push(request.url());
  });
  await page.goto(`login?return_to=${encodeURIComponent(xviewUrl + "?window=5m")}`);
  await page.getByLabel("이메일", { exact: true }).fill(firstEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "XView 실시간", exact: true })).toBeVisible();
  expect(tableAssets).toHaveLength(0);
  const summary = page.locator("summary").filter({ hasText: "표로 보기" });
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("table", { name: "산점도에 표시된 요청", exact: true })).toBeVisible();
  expect(tableAssets).toHaveLength(1);
}

async function keyboardPage(page: Page, key: "Home" | "End") {
  await page.getByRole("combobox", { name: "페이지 이동", exact: true }).focus();
  await page.keyboard.press(key);
  await page.keyboard.press("Enter");
}

async function selectRequest(page: Page, id: string) {
  const checkbox = page.getByRole("checkbox", { name: `${id} 비교 대상으로 선택`, exact: true });
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
}

test("최근 200건 밖의 요청을 키보드로 열고 원래 버튼으로 초점을 복원한다", async ({ page, liveGateway }) => {
  await page.clock.install({ time: serverStart });
  await page.route(`**/admin/requests/${firstId}/io`, (route) =>
    route.fulfill({
      json: {
        request_id: firstId,
        input: { state: "missing" },
        output: { state: "missing", kind: "none" },
        capture: { response_text: false, raw_prompts: false, response_max_bytes: 0 },
        masked: true,
      },
    }),
  );
  liveGateway.points = [
    livePoint(firstId, serverStart - 240_000, 1000),
    ...Array.from({ length: 200 }, (_, i) => livePoint(`public-recent-${i}`, serverStart - 30_000 + i)),
  ];
  await enter(page);
  await keyboardPage(page, "End");
  await expect(page.getByRole("combobox", { name: "페이지 이동", exact: true })).toHaveValue("4");
  const open = page.getByRole("button", { name: `${firstId} 선택`, exact: true });
  await open.focus();
  const detail = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/admin/requests/${firstId}/io`,
  );
  await page.keyboard.press("Enter");
  expect((await detail).status()).toBe(200);
  await expect(page.getByRole("dialog", { name: "요청 입력과 출력", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();
});

test("페이지를 넘겨 임의의 두 요청을 비교하고 표 탐색 중 실시간 갱신을 멈춘다", async ({
  page,
  liveGateway,
}) => {
  await page.clock.install({ time: serverStart });
  liveGateway.points = [
    livePoint(firstId, serverStart - 240_000),
    ...Array.from({ length: 200 }, (_, i) => livePoint(`public-recent-${i}`, serverStart - 30_000 + i)),
  ];
  await enter(page);
  await expect(
    page.getByText("표를 탐색하는 동안 자동 갱신을 멈췄습니다. 표를 닫으면 다시 갱신합니다.", {
      exact: true,
    }),
  ).toBeVisible();
  const before = liveGateway.calls.filter((url) => url.pathname === "/admin/xview/delta").length;
  await page.clock.runFor(6_000);
  expect(liveGateway.calls.filter((url) => url.pathname === "/admin/xview/delta")).toHaveLength(before);
  await selectRequest(page, "public-recent-199");
  await keyboardPage(page, "End");
  await selectRequest(page, firstId);
  const compare = page.getByRole("button", { name: "선택한 2건 비교", exact: true });
  await compare.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "선택한 요청 2건", exact: true });
  await expect(sheet).toContainText(firstId);
  await expect(sheet).toContainText("public-recent-199");
  await page.keyboard.press("Escape");
  await expect(compare).toBeFocused();
  await keyboardPage(page, "Home");
  await expect(
    page.getByRole("checkbox", { name: "public-recent-199 비교 대상으로 선택", exact: true }),
  ).toBeChecked();
  const summary = page.locator("summary").filter({ hasText: "표로 보기" });
  await summary.focus();
  await page.keyboard.press("Enter");
  liveGateway.respond = () => ({
    points: [livePoint("public-new-arrival", serverStart + 7_000)],
    cursor: { ...cursor, ingested_at: "2026-10-08T09:00:07.000000001Z" },
    server_time: new Date(serverStart + 7_000).toISOString(),
  });
  await page.clock.runFor(2_000);
  await expect
    .poll(() => liveGateway.calls.filter((url) => url.pathname === "/admin/xview/delta").length)
    .toBeGreaterThan(before);
});

test("6,000건의 마지막 페이지까지 접근하며 표 행 수를 제한한다", async ({ page, liveGateway }) => {
  await page.clock.install({ time: serverStart });
  liveGateway.points = Array.from({ length: 6000 }, (_, i) =>
    livePoint(`public-buffer-${i}`, serverStart - 240_000 + i),
  );
  await enter(page);
  const table = page.getByRole("table", { name: "산점도에 표시된 요청", exact: true });
  await expect(table.getByRole("row")).toHaveCount(51);
  await keyboardPage(page, "End");
  await expect(page.getByRole("combobox", { name: "페이지 이동", exact: true })).toHaveValue("119");
  await selectRequest(page, "public-buffer-0");
  await expect(table.getByRole("row")).toHaveCount(51);
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 긴 식별자·열 경계·키보드·접근성`, async ({ page, liveGateway }) => {
      await page.clock.install({ time: serverStart });
      await page.setViewportSize({ width, height: 950 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      liveGateway.points = [
        livePoint(firstId),
        {
          ...livePoint("public-long-" + "request-".repeat(18)),
          model: "긴 모델 이름과 공백 없는 식별자를 함께 확인합니다_".repeat(5),
        },
      ];
      await enter(page);
      await selectRequest(page, firstId);
      const area = page.locator(".xview-point-table");
      await area.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 1440) {
        expect(
          await area
            .locator(".data-table-scroll")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      }
      const result = await page.evaluate(async () => {
        const root = document.querySelector(".xview-point-table");
        if (!root) throw new Error("요청 표를 찾지 못했습니다.");
        return (window as unknown as { axe: { run: (root: Element) => Promise<AxeResults> } }).axe.run(root);
      });
      expect(result.violations).toEqual([]);
      await expect(area).toHaveScreenshot(`xview-table-${theme}-${width}.png`);
    });
  }
}
