import { expect, type Page } from "@playwright/test";
import { test, traceAccount, flowRequestA, flowRequestB } from "./fixtures/trace-safe-flow";
const rows = [
  { ...flowRequestA, request_id: "request-a", request_filterable: true },
  { ...flowRequestB, request_id: "request-b", request_filterable: true, status_code: 503, latency_ms: 1250 },
  {
    ...flowRequestA,
    request_ref: `req_${"c".repeat(22)}.${"c".repeat(21)}`,
    trace_id: "[값 비공개]",
    trace_filterable: false,
    status_code: 0,
    created_at: "2026-10-01T00:00:02.123456789Z",
  },
  {
    ...flowRequestA,
    request_ref: `req_${"d".repeat(22)}.${"d".repeat(21)}`,
    trace_id: "[값 비공개]",
    trace_filterable: false,
    created_at: "2026-10-01T00:00:03.123456789Z",
  },
];
const timeline = (page: Page) => page.getByRole("region", { name: "요청 처리 흐름", exact: true });
async function login(page: Page, query = "timeline_view=trace&tz=UTC&limit=25") {
  await page.goto(`login?return_to=${encodeURIComponent(`/app/observability/traces?${query}`)}`);
  await page.getByLabel("이메일", { exact: true }).fill(traceAccount.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(timeline(page)).toBeVisible();
}
test("보기 전환은 조건과 주소 기록을 보존하고 목록을 중복 조회하지 않는다", async ({ page, gateway }) => {
  gateway.rows(rows);
  await login(page, "tz=UTC&limit=25");
  const grouped = page.getByRole("button", { name: "추적별 보기", exact: true });
  await grouped.focus();
  await page.keyboard.press("Enter");
  await expect(grouped).toBeFocused();
  await expect(page).toHaveURL(/tz=UTC&limit=25&timeline_view=trace$/);
  await expect(timeline(page).locator("details")).toHaveCount(3);
  await page.goBack();
  await expect(page.getByRole("button", { name: "시간순 보기" })).toHaveAttribute("aria-pressed", "true");
  await page.goForward();
  await expect(grouped).toHaveAttribute("aria-pressed", "true");
  expect(gateway.listReads()).toBe(1);
  await page.reload();
  await expect(grouped).toHaveAttribute("aria-pressed", "true");
  await expect(timeline(page).locator("details")).toHaveCount(3);
  expect(gateway.listReads()).toBe(2);
  expect(gateway.calls).toHaveLength(0);
  expect(gateway.unexpected).toEqual([]);
});
test("필터 적용·초기화·새로고침 후 추적별 보기와 주소 기록을 유지한다", async ({ page, gateway }) => {
  gateway.rows(rows);
  await login(page, "tz=UTC&limit=25");
  const grouped = page.getByRole("button", { name: "추적별 보기", exact: true });
  await grouped.click();
  await page.getByRole("button", { name: "흐름 조회", exact: true }).click();
  await expect(page).toHaveURL(/timeline_view=trace/);
  await expect(grouped).toHaveAttribute("aria-pressed", "true");
  expect(gateway.listReads()).toBe(1);
  await page.getByRole("combobox", { name: "상태", exact: true }).selectOption("error");
  await page.getByRole("button", { name: "흐름 조회", exact: true }).click();
  await expect(page).toHaveURL(/status=error/);
  await expect(grouped).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(grouped).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "필터 초기화", exact: true }).click();
  await expect(page).toHaveURL(/traces\?timeline_view=trace$/);
  await expect(page.getByRole("combobox", { name: "상태", exact: true })).toHaveValue("");
  await expect(timeline(page).locator("details")).toHaveCount(3);
  await page.goBack();
  await expect(page).toHaveURL(/status=error/);
  await expect(grouped).toHaveAttribute("aria-pressed", "true");
  expect(gateway.calls).toHaveLength(0);
  expect(gateway.unexpected).toEqual([]);
});
test("공유 선택과 접힌 묶음의 상세 닫기가 원래 요청 초점을 복원한다", async ({ page, gateway }) => {
  gateway.rows(rows);
  await login(page, "timeline_view=trace&selected_request=request-b&tz=UTC");
  const group = timeline(page).locator("details").first();
  await expect(group).toHaveAttribute("open", "");
  const trigger = group.getByRole("button", { name: "2번째 요청 request-b 흐름 선택" });
  await trigger.click();
  await group.locator("summary").focus();
  await page.keyboard.press("Space");
  await expect(group).not.toHaveAttribute("open", "");
  await page.getByRole("button", { name: "요청 상세 닫기" }).click();
  await expect(group).toHaveAttribute("open", "");
  await expect(trigger).toBeFocused();
  await expect(page).not.toHaveURL(/selected_/);
  expect(gateway.listReads()).toBe(1);
  expect(gateway.unexpected).toEqual([]);
});
test("요청 표의 선택이 묶음을 펼치고 권한 회수 시 기록을 제거한다", async ({ page, gateway }) => {
  gateway.rows(rows);
  await login(page);
  const group = timeline(page).locator("details").first();
  await expect(group).not.toHaveAttribute("open", "");
  await page.getByRole("button", { name: "2번째 요청 request-b 상세 보기" }).click();
  await expect(group).toHaveAttribute("open", "");
  gateway.readable(false);
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
  await expect(timeline(page)).toHaveCount(0);
  await expect(page.getByText("public-trace", { exact: true })).toHaveCount(0);
  expect(gateway.unexpected).toEqual([]);
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 추적 묶음·키보드·대비·넘침`, async ({ page, gateway }) => {
      gateway.rows(rows);
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 1700 });
      await login(page);
      const card = timeline(page),
        first = card.locator("details").first();
      await expect(card.locator("details")).toHaveCount(3);
      await expect(first).toContainText("현재 페이지 2건");
      await expect(first).toContainText("오류 1건");
      await expect(first).toContainText("최대 지연 1.25초");
      await expect(card.locator("details").nth(1)).toContainText("상태 미확인 1건");
      await card.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await expect(card).toHaveScreenshot(`trace-groups-closed-${theme}-${width}.png`, {
        animations: "disabled",
      });
      await first.locator("summary").focus();
      await page.keyboard.press("Enter");
      await expect(first).toHaveAttribute("open", "");
      await page.keyboard.press("Tab");
      await expect(first.getByRole("button", { name: "1번째 요청 request-a 흐름 선택" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(first.getByRole("button", { name: "2번째 요청 request-b 흐름 선택" })).toBeFocused();
      await card.scrollIntoViewIfNeeded();
      expect((await card.getByRole("heading").boundingBox())?.y).toBeGreaterThanOrEqual(56);
      await expect(card).toHaveScreenshot(`trace-groups-open-${theme}-${width}.png`, {
        animations: "disabled",
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const violations = await page.evaluate(async () => {
        const axe = (
          window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
        ).axe;
        return (await axe.run(document)).violations.map((item) => item.id);
      });
      expect(violations).toEqual([]);
      expect(gateway.calls).toHaveLength(0);
      expect(gateway.listReads()).toBe(1);
      expect(gateway.unexpected).toEqual([]);
    });
  }

test("시간 눈금과 요청 막대의 양 끝이 두 보기와 화면 폭에서 일치한다", async ({ page, gateway }) => {
  gateway.rows(rows);
  await login(page, "tz=UTC&limit=25");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1700 });
    for (const view of ["시간순 보기", "추적별 보기"]) {
      await page.getByRole("button", { name: view, exact: true }).click();
      const card = timeline(page);
      await expect(card).toHaveAttribute("data-timeline-view", view === "추적별 보기" ? "trace" : "time");
      if (view === "추적별 보기") {
        const group = card.locator("details").first();
        if (!(await group.evaluate((el) => (el as HTMLDetailsElement).open)))
          await group.locator("summary").click();
      }
      // Read all geometry in one layout snapshot after the route view has committed.
      const bounds = await card.evaluate((element) => {
        const start = element.querySelector(".trace-scale > span:first-child")?.getBoundingClientRect();
        const end = element.querySelector(".trace-scale > span:last-child")?.getBoundingClientRect();
        const track = element.querySelector(".trace-lane-track")?.getBoundingClientRect();
        if (!start || !end || !track || track.width === 0)
          throw new Error("Expected visible scale and track");
        return { start: Math.abs(start.left - track.left), end: Math.abs(end.right - track.right) };
      });
      expect(bounds.start, `${width} ${view} start`).toBeLessThanOrEqual(1);
      expect(bounds.end, `${width} ${view} end`).toBeLessThanOrEqual(1);
    }
  }
  expect(gateway.listReads()).toBe(1);
});
