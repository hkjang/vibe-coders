import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installRequestBulk } from "../fixtures/request-bulk-browser";

const region = (page: Page) => page.getByRole("region", { name: "요청 조회 조건", exact: true });
async function open(page: Page, query = "model=공개+모델&session_id=session-a&language=ko&limit=25&tz=UTC") {
  const fixture = await installRequestBulk(page);
  await page.route("**/admin/suggest?*", async (route) => {
    if (route.request().method() !== "GET") {
      fixture.writes.push(route.request());
      return route.fulfill({ status: 405, json: {} });
    }
    return route.fulfill({ json: { values: [] } });
  });
  const reads: URLSearchParams[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/admin/requests") reads.push(url.searchParams);
  });
  await page.goto(`observability/requests?${query}`);
  await expect(region(page)).toContainText("적용 중인 조건");
  return { ...fixture, reads };
}

test("접힌 고급 필터와 적용 조건을 표시하고 해제 시 페이지·선택·초안을 정리한다", async ({ page }) => {
  const fixture = await open(page);
  await expect(page.locator(".request-advanced summary")).toContainText("2개 적용");
  await expect(page.locator(".request-advanced")).not.toHaveAttribute("open");
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.has("cursor")).toBe(true);
  await page.getByRole("button", { name: "여러 요청 선택", exact: true }).click();
  await page.getByRole("checkbox", { name: "1번째 요청 선택", exact: true }).check();
  await page.getByLabel("모델", { exact: true }).fill("아직 적용하지 않은 모델");
  await expect(region(page)).not.toContainText("아직 적용하지 않은 모델");
  await page.getByRole("button", { name: "모델 필터 해제", exact: true }).click();
  await expect(region(page)).toContainText("적용 중인 조건 2개");
  expect(new URL(page.url()).searchParams.toString()).toBe(
    "session_id=session-a&language=ko&limit=25&tz=UTC",
  );
  await expect(page.getByRole("heading", { name: "요청 조회 결과", exact: true })).toBeFocused();
  await expect(page.getByRole("checkbox", { name: "1번째 요청 선택", exact: true })).not.toBeChecked();
  await expect(page.getByLabel("모델", { exact: true })).toHaveValue("");
  expect(fixture.reads.at(-1)?.has("cursor")).toBe(false);
  expect(fixture.reads.at(-1)?.has("model")).toBe(false);
  expect(fixture.reads.at(-1)?.get("session_id")).toBe("session-a");
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("개별 해제와 뒤로·앞으로·새로고침에서 같은 조회 조건을 복원한다", async ({ page }) => {
  const fixture = await open(page, "model=공개+모델&limit=25&tz=UTC");
  await page.getByRole("button", { name: "모델 필터 해제", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(region(page)).toContainText("적용 중인 조건 0개");
  await expect(region(page)).toContainText("표시 시간대 UTC · 페이지당 25건");
  await page.goBack();
  await expect(region(page)).toContainText("공개 모델");
  await page.goForward();
  await expect(region(page)).toContainText("적용 중인 조건 0개");
  await page.goBack();
  await page.reload();
  await expect(region(page)).toContainText("적용 중인 조건 1개");
  await expect(page.getByLabel("모델", { exact: true })).toHaveValue("공개 모델");
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("실패한 갱신을 적용 완료로 표시하지 않고 조회 거부 뒤 요약도 제거한다", async ({ page }) => {
  const fixture = await open(page);
  fixture.bulk.status = 503;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByText("갱신에 실패해 마지막 정상 데이터를 표시합니다.")).toBeVisible();
  await expect(region(page)).toContainText("조회 요청 조건 3개");
  fixture.bulk.status = 403;
  await page.getByRole("button", { name: "재시도", exact: true }).click();
  await expect(region(page)).toHaveCount(0);
  fixture.bulk.status = 200;
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(region(page)).toContainText("적용 중인 조건 3개");
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 활성 필터의 한글·접근성·긴 값`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const query = new URLSearchParams({
        model: "긴 모델 이름 ".repeat(12).trim(),
        status: "error",
        session_id: "session-a",
        language: "ko",
        tz: "UTC",
        limit: "25",
      });
      const fixture = await open(page, query.toString());
      await expect(region(page)).toContainText("오류 (4xx·5xx)");
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
      await expect(region(page)).toHaveScreenshot(`request-filters-${theme}-${width}.png`, {
        animations: "disabled",
      });
      expect(fixture.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
