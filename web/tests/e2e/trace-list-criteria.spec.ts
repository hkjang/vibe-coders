import { expect, type Locator, type Page } from "@playwright/test";
import { test, traceAccount, flowRequestA, flowRequestB } from "./fixtures/trace-safe-flow";

// Synthetic transport exercises the real router, auth, QueryClient and visible UI.
// It does not prove server filtering, database scope or the safe-flow SQL contract.
const path = "/app/observability/traces";
const criteria = (page: Page) => page.getByRole("region", { name: "추적 조회 기준", exact: true });
const requested = (page: Page) =>
  criteria(page).getByRole("region", { name: "요청한 조회 기준", exact: true });
const displayed = (page: Page) =>
  criteria(page).getByRole("region", { name: "표시 중인 결과의 조회 기준", exact: true });
const value = (region: Locator, label: string) =>
  region
    .locator("dl > div")
    .filter({ has: region.page().getByText(label, { exact: true }) })
    .locator("dd");
const model = (page: Page) => page.getByRole("textbox", { name: "모델", exact: true });
const select = (page: Page, ordinal = 1) =>
  page.getByRole("button", { name: `${ordinal}번째 요청 [값 비공개] 상세 보기`, exact: true });
const lane = (page: Page, ordinal = 1) =>
  page.getByRole("button", { name: `${ordinal}번째 요청 [값 비공개] 흐름 선택`, exact: true });
const flow = (page: Page) => page.getByRole("region", { name: "선택한 요청의 단계 기록", exact: true });
const refresh = (page: Page) => page.getByRole("button", { name: "새로고침", exact: true });
const pendingReason = "현재 목록을 조회 중입니다. 조회가 끝나면 요청 상세를 선택하세요.";
const failedReason = "최신 목록 조회에 실패했습니다. 새로고침 후 요청 상세를 선택하세요.";
const failure = {
  status: 503,
  requestId: "public-trace-list-unavailable",
  body: { error: { message: "public synthetic list unavailable" } },
};
function observeListRequests(page: Page) {
  const requests: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/admin/requests") requests.push(url);
  });
  return requests;
}
async function login(page: Page, search = "") {
  await page.goto(`login?return_to=${encodeURIComponent(`${path}${search}`)}`);
  await page.getByLabel("이메일", { exact: true }).fill(traceAccount.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(criteria(page)).toBeVisible();
  // This shell control is visible at desktop size, not at the mobile breakpoint.
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
}
async function applyModel(page: Page, next: string) {
  await model(page).fill(next);
  await page.getByRole("button", { name: "흐름 조회", exact: true }).click();
}
async function physicalClick(control: Locator, page: Page) {
  // Playwright locator.click waits for aria-disabled=false. Use a real pointer
  // at the visible control to test the product's temporary disabled handler.
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  if (!box) throw new Error("Visible synthetic selection control is missing");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("읽기 전용 목록은 실제 전송한 기준과 현재 페이지 한계를 한글로 표시한다", async ({ page, gateway }) => {
  const requests = observeListRequests(page);
  const search = new URLSearchParams({
    trace_id: "public-trace",
    model: flowRequestA.model,
    from: "2026-10-01T00:00:00Z",
    to: "2026-10-02T00:00:00Z",
    status: "success",
    limit: "25",
    tz: "Asia/Seoul",
  });
  await login(page, `?${search}`);
  await expect(select(page)).toBeEnabled();
  for (const region of [requested(page), displayed(page)]) {
    for (const [label, expected] of [
      ["추적 ID", "public-trace"],
      ["모델", flowRequestA.model],
      ["시작 시각", "2026-10-01T00:00:00Z"],
      ["종료 시각", "2026-10-02T00:00:00Z"],
      ["상태", "성공 (HTTP 2xx·3xx)"],
      ["페이지당 최대 건수", "25건"],
      ["시간대", "Asia/Seoul"],
      ["페이지 위치", "첫 페이지"],
    ] as const)
      await expect(value(region, label)).toHaveText(expected);
  }
  expect(requests).toHaveLength(1);
  expect(requests.map((request) => Object.fromEntries(request.searchParams))).toEqual([
    Object.fromEntries(search),
  ]);
  await expect(criteria(page)).toContainText("서버의 정규화 결과를 뜻하지 않습니다.");
  await expect(criteria(page)).toContainText("전체 추적의 집계가 아닙니다.");
  expect(gateway.calls).toHaveLength(0);
  expect(gateway.writes).toEqual([]);
});

test("새 기준 B를 기다리는 동안 A의 기준을 구분하고 표와 시간축의 선택을 막는다", async ({
  page,
  gateway,
}) => {
  await login(page, `?model=${encodeURIComponent(flowRequestA.model)}`);
  await expect(select(page)).toBeEnabled();
  const next = gateway.listReads() + 1;
  gateway.rows([flowRequestB]);
  gateway.holdList(next);
  await applyModel(page, flowRequestB.model);
  await expect.poll(() => gateway.listReads()).toBe(next);
  await expect(value(requested(page), "모델")).toHaveText(flowRequestB.model);
  await expect(value(displayed(page), "모델")).toHaveText(flowRequestA.model);
  await expect(criteria(page)).toContainText("현재 목록을 확인하는 동안 이전 결과를 표시합니다.");
  for (const control of [select(page), lane(page)]) {
    await expect(control).toHaveAttribute("aria-disabled", "true");
    expect(await control.evaluate((button) => (button as HTMLButtonElement).disabled)).toBe(false);
    await control.focus();
    await expect(control).toBeFocused();
    await control.press("Enter");
    await control.press("Space");
    await physicalClick(control, page);
  }
  await expect(page.getByText(pendingReason, { exact: true }).first()).toBeVisible();
  expect(new URL(page.url()).searchParams.has("selected_ref")).toBe(false);
  await expect(flow(page)).toBeHidden();
  expect(gateway.calls).toHaveLength(0);
  gateway.releaseList(next);
  await expect(value(displayed(page), "모델")).toHaveText(flowRequestB.model);
  await expect(select(page)).toBeEnabled();
  await select(page).click();
  await expect(flow(page)).toContainText("두 번째 조회 도구");
  expect(gateway.calls).toHaveLength(1);
  expect(gateway.calls[0]?.url.searchParams.get("request_ref")).toBe(flowRequestB.request_ref);
});

test("미캐시 B 조회 실패를 A 성공이나 빈 결과로 바꾸지 않고 수동 재시도로 복구한다", async ({
  page,
  gateway,
}) => {
  await login(page, `?model=${encodeURIComponent(flowRequestA.model)}`);
  await expect(select(page)).toBeEnabled();
  const next = gateway.listReads() + 1;
  gateway.listReply(next, failure);
  gateway.listReply(next + 1, failure); // Actual shared QueryClient permits one automatic retry.
  await applyModel(page, flowRequestB.model);
  await expect(
    page.getByRole("heading", { name: "추적 요청 흐름을 불러오지 못했습니다.", exact: true }),
  ).toBeVisible();
  expect(gateway.listReads()).toBe(next + 1);
  await expect(value(requested(page), "모델")).toHaveText(flowRequestB.model);
  await expect(displayed(page)).toContainText("표시할 응답의 조회 기준이 아직 확인되지 않았습니다.");
  await expect(displayed(page).locator("dd")).toHaveCount(0);
  await expect(select(page)).toBeHidden();
  await expect(page.getByRole("heading", { name: "최근 요청이 없습니다.", exact: true })).toBeHidden();
  expect(gateway.calls).toHaveLength(0);
  gateway.rows([flowRequestB]);
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(value(displayed(page), "모델")).toHaveText(flowRequestB.model);
  await expect(page.getByRole("heading", { name: "추적 조회 결과", exact: true })).toBeFocused();
  await select(page).click();
  await expect(flow(page)).toContainText("두 번째 조회 도구");
  expect(gateway.listReads()).toBe(next + 2);
  expect(gateway.calls).toHaveLength(1);
});

test("동일 기준의 갱신과 실패는 상세 DOM·초점을 유지하며 새 선택만 막는다", async ({ page, gateway }) => {
  await login(
    page,
    `?model=${encodeURIComponent(flowRequestA.model)}&selected_ref=${flowRequestA.request_ref}`,
  );
  await expect(flow(page)).toContainText("공개 검색 도구");
  const original = await flow(page).elementHandle();
  const scroll = flow(page).getByRole("region", { name: "단계 표 가로 스크롤", exact: true });
  const next = gateway.listReads() + 1;
  gateway.listReply(next, failure);
  gateway.listReply(next + 1, failure);
  gateway.holdList(next);
  await scroll.focus();
  // Programmatic background refresh intentionally preserves the current focus.
  await refresh(page).evaluate((button) => (button as HTMLButtonElement).click());
  await expect.poll(() => gateway.listReads()).toBe(next);
  await expect(criteria(page)).toContainText("현재 목록을 확인하는 동안 이전 결과를 표시합니다.");
  await expect(scroll).toBeFocused();
  expect(await flow(page).evaluate((node, prior) => node === prior, original)).toBe(true);
  await expect(select(page, 2)).toHaveAttribute("aria-disabled", "true");
  expect(gateway.calls).toHaveLength(1);
  gateway.releaseList(next);
  await expect(criteria(page)).toContainText("현재 조회에 실패해 마지막 정상 결과를 표시합니다.");
  await expect(page.getByRole("button", { name: "재시도", exact: true })).toBeEnabled();
  expect(gateway.listReads()).toBe(next + 1);
  await expect(scroll).toBeFocused();
  await expect(value(displayed(page), "모델")).toHaveText(flowRequestA.model);
  await expect(flow(page)).toContainText("공개 검색 도구");
  await select(page, 2).focus();
  await select(page, 2).press("Enter");
  await physicalClick(lane(page, 2), page);
  await expect(page.getByText(failedReason, { exact: true }).first()).toBeVisible();
  expect(new URL(page.url()).searchParams.get("selected_ref")).toBe(flowRequestA.request_ref);
  expect(gateway.calls).toHaveLength(1);
  await page.getByRole("button", { name: "재시도", exact: true }).click();
  await expect(select(page, 2)).toBeEnabled();
  await expect.poll(() => gateway.calls.length).toBe(2);
  expect(await flow(page).evaluate((node, prior) => node === prior, original)).toBe(true);
  await select(page, 2).click();
  await expect(flow(page)).toContainText("두 번째 조회 도구");
  expect(gateway.calls).toHaveLength(3);
});

test("입력 초안과 검증 오류는 상세 열기·뒤로가기·닫기에서 유지하고 닫은 초점을 복원한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await expect(select(page)).toBeEnabled();
  const reads = gateway.listReads();
  await model(page).fill("아직 제출하지 않은 모델");
  const trace = page.getByRole("textbox", { name: "추적 ID", exact: true });
  await trace.fill("가".repeat(180));
  await page.getByRole("button", { name: "흐름 조회", exact: true }).click();
  await expect(trace).toBeFocused();
  await expect(trace).toHaveAttribute("aria-invalid", "true");
  await select(page).click();
  await expect(flow(page)).toContainText("공개 검색 도구");
  await page.goBack();
  await expect(flow(page)).toBeHidden();
  await expect(model(page)).toHaveValue("아직 제출하지 않은 모델");
  await expect(trace).toHaveAttribute("aria-invalid", "true");
  await select(page).click();
  await expect(flow(page)).toContainText("공개 검색 도구");
  await page.getByRole("button", { name: "요청 상세 닫기", exact: true }).click();
  await expect(select(page)).toBeFocused();
  await expect(model(page)).toHaveValue("아직 제출하지 않은 모델");
  await expect(trace).toHaveAttribute("aria-invalid", "true");
  await expect(value(requested(page), "모델")).toHaveText("지정하지 않음");
  expect(gateway.listReads()).toBe(reads);
});

test("필터 기록 뒤로가기는 제출 기준을 복원하고 초기화는 선택과 초안을 명시적으로 지운다", async ({
  page,
  gateway,
}) => {
  await login(page, "?model=public-A&limit=25");
  await expect(value(displayed(page), "모델")).toHaveText("public-A");
  await applyModel(page, "public-B");
  await expect(value(displayed(page), "모델")).toHaveText("public-B");
  await model(page).fill("제출 전 초안 C");
  await page.goBack();
  await expect(model(page)).toHaveValue("public-A");
  await expect(value(requested(page), "모델")).toHaveText("public-A");
  await expect(value(displayed(page), "모델")).toHaveText("public-A");
  await expect(select(page)).toBeEnabled();
  await select(page).click();
  await expect(flow(page)).toContainText("공개 검색 도구");
  await model(page).fill("초기화할 초안");
  await page.getByRole("button", { name: "필터 초기화", exact: true }).click();
  await expect(model(page)).toHaveValue("");
  await expect(flow(page)).toBeHidden();
  await expect(value(requested(page), "모델")).toHaveText("지정하지 않음");
  await expect(value(displayed(page), "페이지당 최대 건수")).toHaveText("50건");
  expect(new URL(page.url()).searchParams.toString()).toBe("");
  expect(gateway.calls).toHaveLength(1);
});

test("페이지 이동 중 커서 원문 대신 위치를 표시하고 새 페이지 확인 뒤 선택을 허용한다", async ({
  page,
  gateway,
}) => {
  const cursor = `djE6dHJhY2UtbmV4dA.${"n".repeat(43)}`;
  gateway.listReply(1, {
    body: { requests: [flowRequestA], limit: 50, next_cursor: cursor, generated_at: "2026-10-01T00:00:03Z" },
  });
  const requests = observeListRequests(page);
  await login(page);
  await expect(select(page)).toBeEnabled();
  const next = gateway.listReads() + 1;
  gateway.holdList(next);
  gateway.rows([flowRequestB]);
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect.poll(() => gateway.listReads()).toBe(next);
  await expect(value(requested(page), "페이지 위치")).toHaveText("이동한 페이지");
  await expect(value(displayed(page), "페이지 위치")).toHaveText("첫 페이지");
  await expect(criteria(page)).not.toContainText(cursor);
  expect(requests.at(-1)?.searchParams.get("cursor")).toBe(cursor);
  await expect(select(page)).toHaveAttribute("aria-disabled", "true");
  expect(gateway.calls).toHaveLength(0);
  gateway.releaseList(next);
  await expect(value(displayed(page), "페이지 위치")).toHaveText("이동한 페이지");
  await expect(page.getByRole("heading", { name: "추적 조회 결과", exact: true })).toBeFocused();
  await select(page).click();
  await expect(flow(page)).toContainText("두 번째 조회 도구");
});

test("초기 조회 중 선택 딥 링크만으로 단계를 요청하지 않고 현재 목록 확인 후 연결한다", async ({
  page,
  gateway,
}) => {
  gateway.holdList(1);
  await login(page, `?selected_ref=${flowRequestA.request_ref}`);
  await expect.poll(() => gateway.listReads()).toBe(1);
  await expect(displayed(page)).toContainText("표시할 응답의 조회 기준이 아직 확인되지 않았습니다.");
  await expect(criteria(page)).toContainText("현재 조회 기준의 결과를 확인하고 있습니다.");
  expect(gateway.calls).toHaveLength(0);
  await expect(flow(page)).toBeHidden();
  gateway.releaseList(1);
  await expect(flow(page)).toContainText("공개 검색 도구");
  await expect(value(displayed(page), "페이지당 최대 건수")).toHaveText("50건");
  expect(gateway.calls).toHaveLength(1);
});

test("390px 어두운 읽기 전용 화면에서 긴 한글 기준·검증·선택·초점·접근성을 유지한다", async ({
  page,
  gateway,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await login(page);
  await expect(select(page)).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 780 });
  const longModel = "한글연결없는긴조회모델".repeat(7);
  await model(page).fill(longModel);
  const from = page.getByRole("textbox", { name: "시작 시각", exact: true });
  await from.fill("잘못된 시각");
  const reads = gateway.listReads();
  await page.getByRole("button", { name: "흐름 조회", exact: true }).click();
  await expect(from).toBeFocused();
  expect(gateway.listReads()).toBe(reads);
  await from.fill("");
  await model(page).focus();
  await page.keyboard.press("Tab");
  await expect(from).toBeFocused();
  await from.press("Enter");
  await expect(value(displayed(page), "모델")).toHaveText(longModel);
  await criteria(page).scrollIntoViewIfNeeded();
  const bounds = await criteria(page)
    .locator("dt, dd")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right };
      }),
    );
  expect(bounds.length).toBe(32);
  for (const box of bounds) {
    expect(box.left).toBeGreaterThanOrEqual(-1);
    expect(box.right).toBeLessThanOrEqual(391);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await lane(page).focus();
  await lane(page).press("Enter");
  await expect(flow(page)).toContainText("공개 검색 도구");
  await page.getByRole("button", { name: "요청 상세 닫기", exact: true }).click();
  await expect(lane(page)).toBeFocused();
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
    ).axe;
    return (await axe.run(document)).violations.map((item) => item.id);
  });
  expect(violations).toEqual([]);
  await criteria(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("trace-criteria-390-dark.png"), fullPage: true });
  expect(gateway.writes).toEqual([]);
  expect(gateway.calls).toHaveLength(1);
});
