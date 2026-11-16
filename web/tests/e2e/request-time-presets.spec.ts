import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installRequestBulk } from "../fixtures/request-bulk-browser";

const now = "2026-11-17T00:30:00.000Z";
async function open(page: Page) {
  const fixture = await installRequestBulk(page);
  await page.clock.setFixedTime(new Date(now));
  await page.route("**/admin/suggest?*", (route) => route.fulfill({ json: { values: [] } }));
  const reads: URLSearchParams[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/admin/requests") reads.push(url.searchParams);
  });
  await page.goto("observability/requests?model=공개+모델&limit=25&tz=America%2FLos_Angeles");
  await expect(page.getByRole("table")).toBeVisible();
  return { ...fixture, reads };
}

test("빠른 기간은 다른 초안을 보존하고 조회할 때 페이지를 초기화한다", async ({ page }) => {
  const fixture = await open(page);
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.has("cursor")).toBe(true);
  await expect(page.getByRole("table")).toContainText("요청-4");
  await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
  await page.getByLabel("모델", { exact: true }).fill("입력 중인 모델");
  const before = fixture.bulk.reads;
  await page.getByRole("button", { name: "최근 24시간", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("시작 시각", { exact: true })).toHaveValue("2026-11-16T00:30:00.000Z");
  await expect(page.getByLabel("종료 시각", { exact: true })).toHaveValue(now);
  await expect(page.getByLabel("모델", { exact: true })).toHaveValue("입력 중인 모델");
  expect(new URL(page.url()).searchParams.has("from")).toBe(false);
  expect(fixture.bulk.reads).toBe(before);
  await page.getByRole("button", { name: "조회", exact: true }).click();
  await expect.poll(() => fixture.reads.at(-1)?.get("from")).toBe("2026-11-16T00:30:00.000Z");
  expect(fixture.reads.at(-1)?.get("to")).toBe(now);
  expect(fixture.reads.at(-1)?.get("model")).toBe("입력 중인 모델");
  expect(fixture.reads.at(-1)?.get("tz")).toBe("America/Los_Angeles");
  expect(fixture.reads.at(-1)?.get("limit")).toBe("25");
  expect(fixture.reads.at(-1)?.has("cursor")).toBe(false);
  await expect(page.getByRole("region", { name: "요청 조회 조건", exact: true })).toContainText(now);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("직접 수정의 기간 검증과 다시 선택·초기화를 유지한다", async ({ page }) => {
  const fixture = await open(page);
  await page.getByRole("button", { name: "최근 1시간", exact: true }).click();
  await page.getByLabel("종료 시각", { exact: true }).fill("2026-11-15");
  const before = fixture.bulk.reads;
  await page.getByRole("button", { name: "조회", exact: true }).click();
  await expect(page.getByText("종료 시각은 시작 시각보다 빠를 수 없습니다.")).toBeVisible();
  await expect(page.getByLabel("종료 시각", { exact: true })).toBeFocused();
  expect(fixture.bulk.reads).toBe(before);
  await page.clock.setFixedTime(new Date("2026-11-17T01:30:00Z"));
  await page.getByRole("button", { name: "최근 1시간", exact: true }).click();
  await expect(page.getByLabel("시작 시각", { exact: true })).toHaveValue(now);
  await expect(page.getByText("종료 시각은 시작 시각보다 빠를 수 없습니다.")).toHaveCount(0);
  await page.getByRole("button", { name: "필터 초기화", exact: true }).click();
  await expect(page.getByLabel("시작 시각", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("종료 시각", { exact: true })).toHaveValue("");
  await expect(page.locator(".request-time-preset-notice")).toBeEmpty();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("적용 기간은 뒤로·앞으로·새로고침에서 같은 절대 시각으로 복원한다", async ({ page }) => {
  const fixture = await open(page);
  await page.getByRole("button", { name: "최근 7일", exact: true }).click();
  await page.getByRole("button", { name: "조회", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("to")).toBe(now);
  await expect(page.getByRole("region", { name: "요청 조회 조건", exact: true })).toContainText(
    "적용 중인 조건 3개",
  );
  await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.has("from")).toBe(false);
  await expect(page.getByLabel("시작 시각", { exact: true })).toHaveValue("");
  await page.goForward();
  await expect(page.getByLabel("시작 시각", { exact: true })).toHaveValue("2026-11-10T00:30:00.000Z");
  await page.clock.setFixedTime(new Date("2026-11-18T00:30:00Z"));
  await page.reload();
  await expect(page.getByLabel("종료 시각", { exact: true })).toHaveValue(now);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 기간 빠른 입력의 한글·키보드·접근성`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await open(page);
      const preset = page.getByRole("button", { name: "최근 30일", exact: true });
      await preset.focus();
      await page.keyboard.press("Enter");
      await expect(preset).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(
        await page.evaluate(
          async () =>
            (
              await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
                document,
              )
            ).violations,
        ),
      ).toEqual([]);
      await page.mouse.move(0, 0);
      await expect(page.locator(".request-filters")).toHaveScreenshot(
        `request-period-${theme}-${width}.png`,
        {
          animations: "disabled",
        },
      );
      expect(fixture.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
