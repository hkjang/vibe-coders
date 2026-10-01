import { expect, type Page } from "@playwright/test";
import { test, requestAccount, flowRequestA, flowRequestB, safeFlow } from "./fixtures/request-safe-flow";

// Synthetic transport exercises the actual React auth/router/query/dialog.
// Existing Go tests separately prove the reused endpoint's scope and query bounds.
const dialog = (page: Page) => page.getByRole("dialog");
const card = (page: Page) => page.getByRole("region", { name: "선택한 요청의 단계 기록", exact: true });
const start = (page: Page) => dialog(page).getByRole("button", { name: "처리 단계 보기", exact: true });
const retry = (page: Page) => card(page).getByRole("button", { name: "단계 기록 다시 조회", exact: true });
const select = (page: Page, ordinal = 1) =>
  page.getByRole("button", { name: `${ordinal}번째 요청 [값 비공개] 상세 보기`, exact: true });
function child(result: ReturnType<typeof safeFlow>) {
  const span = result.spans[1];
  if (!span) throw new Error("Missing synthetic child span");
  return span;
}
async function login(page: Page) {
  await page.goto(`login?return_to=${encodeURIComponent("/app/observability/requests")}`);
  await page.getByLabel("이메일", { exact: true }).fill(requestAccount.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(select(page)).toBeVisible();
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
}
async function openFlow(page: Page, ordinal = 1) {
  await select(page, ordinal).click();
  await start(page).click();
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function refreshBehindDialog(page: Page) {
  // Trigger the real React button without stealing focus from the open modal.
  await page.getByRole("button", { name: "새로고침", exact: true, includeHidden: true }).evaluate((node) => {
    if (!(node instanceof HTMLButtonElement)) throw new Error("Missing refresh control");
    node.click();
  });
}
async function navigateSearch(page: Page, search: string) {
  await page.evaluate((value) => {
    history.pushState({}, "", `/app/observability/requests${value}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, search);
}
async function assertNoPersistentMarkers(page: Page, markers: string[]) {
  const values = await page.evaluate(() => [
    location.href,
    JSON.stringify(Object.entries(localStorage)),
    JSON.stringify(Object.entries(sessionStorage)),
    document.documentElement.outerHTML,
  ]);
  for (const value of values) for (const marker of markers) expect(value).not.toContain(marker);
}

test("추적 ID가 없어도 상세에서 명시적으로 처리 단계를 조회하고 같은 비공개 행을 구분한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await select(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("link", { name: "이 요청의 추적 보기" })).toBeHidden();
  await expect(start(page)).toBeVisible();
  expect(gateway.calls).toEqual([]);
  await start(page).focus();
  await page.keyboard.press("Enter");
  await expect(card(page)).toContainText("공개 검색 도구");
  await expect(page.getByRole("group", { name: "단계 기록 조회 결과", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(retry(page)).toBeFocused();
  expect(gateway.calls).toHaveLength(1);
  expect(gateway.calls[0]?.url.searchParams.get("created_at")).toBe(flowRequestA.created_at);
  expect(gateway.calls[0]?.headers["x-vibe-route"]).toBe("observability.requests");
  await page.keyboard.press("Escape");
  await expect(select(page)).toBeFocused();
  await select(page, 2).click();
  await expect(card(page)).toBeHidden();
  expect(gateway.calls).toHaveLength(1);
  await start(page).click();
  await expect(card(page)).toContainText("두 번째 조회 도구");
  await expect(card(page)).not.toContainText("공개 검색 도구");
  expect(gateway.calls[1]?.url.searchParams.get("request_ref")).toBe(flowRequestB.request_ref);
  expect(gateway.calls[1]?.url.searchParams.get("created_at")).toBe(flowRequestB.created_at);
  expect(new URL(page.url()).searchParams.has("selected_request")).toBe(false);
});

for (const mode of ["legacy_token", "open"] as const) {
  test(`${mode === "open" ? "인증 비활성" : "기존 관리자 토큰"} 모드에서도 현재 요청 조회 권한으로 명시 조회한다`, async ({
    page,
    gateway,
  }) => {
    gateway.authMode(mode);
    const target = "/app/observability/requests";
    if (mode === "legacy_token") {
      await page.goto(`login?return_to=${encodeURIComponent(target)}`);
      await page.getByLabel("기존 관리자 토큰", { exact: true }).fill("public-flow-legacy");
      await page.getByRole("button", { name: "콘솔 열기", exact: true }).click();
    } else await page.goto(target);
    await expect(select(page)).toBeVisible();
    await page.getByLabel("자동 새로고침 간격").selectOption("0");
    await select(page).click();
    expect(gateway.calls).toHaveLength(0);
    await start(page).click();
    await expect(card(page)).toContainText("공개 검색 도구");
    expect(gateway.calls).toHaveLength(1);
  });
}

test("닫기와 같은 행 다시 열기는 새로운 명시 조회를 요구하며 늦은 결과를 재사용하지 않는다", async ({
  page,
  gateway,
}) => {
  gateway.holdFlow(1);
  const old = safeFlow();
  child(old).name = "닫힌 수명의 과거 기록";
  gateway.reply(1, { body: old });
  await login(page);
  await openFlow(page);
  await expect.poll(() => gateway.calls.length).toBe(1);
  await page.keyboard.press("Escape");
  await expect(select(page)).toBeFocused();
  await select(page).click();
  await expect(start(page)).toBeVisible();
  gateway.releaseFlow(1);
  await expect.poll(() => gateway.finished.includes(1)).toBe(true);
  await expect(card(page)).toBeHidden();
  expect(gateway.calls).toHaveLength(1);
  await start(page).click();
  await expect(card(page)).toContainText("공개 검색 도구");
  await expect(card(page)).not.toContainText("닫힌 수명의 과거 기록");
});

test("같은 목록의 갱신 중 기록과 초점을 유지하고 새 성공 목록에서 상세를 폐기한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await openFlow(page);
  await expect(card(page)).toContainText("공개 검색 도구");
  const next = gateway.listReads() + 1;
  gateway.holdList(next);
  const scroll = card(page).getByRole("region", { name: "단계 표 가로 스크롤", exact: true });
  await scroll.focus();
  await refreshBehindDialog(page);
  await expect.poll(() => gateway.listReads()).toBe(next);
  await expect(card(page)).toContainText("이전 기록");
  await expect(card(page)).toContainText("공개 검색 도구");
  await expect(scroll).toBeFocused();
  await expect(retry(page)).toHaveAttribute("aria-disabled", "true");
  await retry(page).evaluate((node) => {
    if (node instanceof HTMLButtonElement) node.click();
  });
  expect(gateway.calls).toHaveLength(1);
  gateway.releaseList(next);
  await expect(dialog(page)).toBeHidden();
  await expect(select(page)).toBeFocused();
  await select(page).click();
  await expect(card(page)).toBeHidden();
  expect(gateway.calls).toHaveLength(1);
});

test("실패한 목록의 이전 데이터는 단계 재조회 근거가 되지 않는다", async ({ page, gateway }) => {
  await login(page);
  await openFlow(page);
  await expect(card(page)).toContainText("공개 검색 도구");
  const next = gateway.listReads() + 1;
  for (let i = next; i < next + 6; i += 1)
    gateway.listReply(i, { status: 500, body: { error: { message: "synthetic-list-failure" } } });
  await refreshBehindDialog(page);
  await expect(card(page)).toContainText("최신 조회에 실패했습니다");
  await expect(card(page)).toContainText("공개 검색 도구");
  await expect(retry(page)).toHaveAttribute("aria-disabled", "true");
  expect(gateway.calls).toHaveLength(1);
});

test("필터 A에서 B를 거쳐 캐시 A로 돌아와도 닫힌 상세와 조회 상태가 부활하지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await openFlow(page);
  await expect(card(page)).toContainText("공개 검색 도구");
  await navigateSearch(page, "?status=error");
  await expect(dialog(page)).toBeHidden();
  await expect
    .poll(() => gateway.listCalls.some((url) => url.searchParams.get("status") === "error"))
    .toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(/\/app\/observability\/requests$/u);
  await expect(select(page)).toBeVisible();
  await expect(dialog(page)).toBeHidden();
  await select(page).click();
  await expect(card(page)).toBeHidden();
  expect(gateway.calls).toHaveLength(1);
  await start(page).click();
  await expect(card(page)).toContainText("공개 검색 도구");
  expect(gateway.calls).toHaveLength(2);
});

for (const boundary of ["권한", "팀"] as const) {
  test(`${boundary} 변경 전의 늦은 단계 응답을 버리고 복구 뒤에도 명시 조회만 허용한다`, async ({
    page,
    gateway,
  }) => {
    gateway.holdFlow(1);
    const old = safeFlow();
    child(old).name = "이전 권한 수명의 기록";
    gateway.reply(1, { body: old });
    await login(page);
    await openFlow(page);
    await expect.poll(() => gateway.calls.length).toBe(1);
    if (boundary === "권한") gateway.readable(false);
    else gateway.team("public-next-team");
    await runtime(page);
    await expect(dialog(page)).toBeHidden();
    gateway.releaseFlow(1);
    await expect.poll(() => gateway.finished.includes(1)).toBe(true);
    await expect(card(page)).toBeHidden();
    if (boundary === "권한") gateway.readable(true);
    else gateway.team(requestAccount.team_id);
    await runtime(page);
    await expect(select(page)).toBeVisible();
    await select(page).click();
    await expect(card(page)).toBeHidden();
    expect(gateway.calls).toHaveLength(1);
    await start(page).click();
    await expect(card(page)).toContainText("공개 검색 도구");
    await expect(card(page)).not.toContainText("이전 권한 수명의 기록");
  });
}

for (const status of [404, 500, 503]) {
  test(`${status} 단계 오류를 빈 결과로 표시하거나 원문 API로 우회하지 않고 수동 복구한다`, async ({
    page,
    gateway,
  }) => {
    const marker = "synthetic-private-error-content";
    gateway.reply(1, {
      status,
      requestId: "public-request-flow-error",
      body: { error: { message: marker } },
    });
    await login(page);
    await openFlow(page);
    await expect(card(page).getByRole("alert")).toBeVisible();
    await expect(card(page)).toContainText("public-request-flow-error");
    await expect(card(page)).not.toContainText("표시할 하위 단계가 없습니다");
    await assertNoPersistentMarkers(page, [marker]);
    expect(gateway.calls).toHaveLength(1);
    await retry(page).click();
    await expect(card(page)).toContainText("공개 검색 도구");
    expect(gateway.calls).toHaveLength(2);
  });
}

for (const invalid of ["대상 불일치", "원문 필드"] as const) {
  test(`${invalid} 단계 응답은 표시하지 않는다`, async ({ page, gateway }) => {
    const result = safeFlow();
    const body =
      invalid === "대상 불일치"
        ? { ...result, request_ref: flowRequestB.request_ref }
        : { ...result, raw_error: "synthetic-private-raw-error" };
    gateway.reply(1, { body });
    await login(page);
    await openFlow(page);
    await expect(card(page).getByRole("alert")).toBeVisible();
    await expect(card(page)).not.toContainText("공개 검색 도구");
    await assertNoPersistentMarkers(page, ["synthetic-private-raw-error"]);
    expect(gateway.calls).toHaveLength(1);
  });
}

test("v1 목록은 요약만 제공하고 v2로 복귀해도 예전 상세가 다시 열리지 않는다", async ({ page, gateway }) => {
  await login(page);
  await openFlow(page);
  await expect(card(page)).toContainText("공개 검색 도구");
  gateway.contract(1);
  await refreshBehindDialog(page);
  await expect(dialog(page)).toBeHidden();
  await select(page).click();
  await expect(start(page)).toBeHidden();
  await expect(dialog(page)).toContainText("요청 시각");
  gateway.contract(2);
  await refreshBehindDialog(page);
  await expect(dialog(page)).toBeHidden();
  expect(gateway.calls).toHaveLength(1);
  await select(page).click();
  await expect(card(page)).toBeHidden();
});

test("초 단위 목록 시각을 임의 나노초로 보정하여 단계 조회하지 않는다", async ({ page, gateway }) => {
  gateway.rows([{ ...flowRequestA, created_at: "2026-10-01T00:00:00Z" }]);
  await login(page);
  await select(page).click();
  await expect(dialog(page)).toContainText("요청 시각");
  await expect(start(page)).toBeHidden();
  expect(gateway.calls).toHaveLength(0);
});

test("새 목록에서 선택 행이 사라지면 결과 제목으로 초점을 돌린다", async ({ page, gateway }) => {
  await login(page);
  await openFlow(page);
  await expect(card(page)).toContainText("공개 검색 도구");
  gateway.rows([flowRequestB]);
  await refreshBehindDialog(page);
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole("heading", { name: "요청 조회 결과", exact: true })).toBeFocused();
  expect(gateway.calls).toHaveLength(1);
});

test("390px 다크 상세창의 긴 단계는 표 안에서 스크롤되고 키보드로 닫힌다", async ({
  page,
  gateway,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const result = safeFlow();
  child(result).name = "단계".repeat(40);
  child(result).recorded_at = null;
  child(result).offset_ms = null;
  gateway.reply(1, { body: result });
  await login(page);
  await page.setViewportSize({ width: 390, height: 780 });
  await openFlow(page);
  await expect(card(page).getByRole("table")).toBeVisible();
  await expect(page.getByRole("group", { name: "단계 기록 조회 결과", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(retry(page)).toBeFocused();
  await expect(card(page)).toContainText("소요 시간 미기록");
  const recordedTime = card(page).locator("tbody tr").first().locator("td").nth(1);
  await expect(recordedTime).toHaveCSS("white-space", "nowrap");
  expect(
    await recordedTime.locator("time").evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getClientRects().length;
    }),
  ).toBe(1);
  const scroll = card(page).getByRole("region", { name: "단계 표 가로 스크롤", exact: true });
  await scroll.focus();
  await expect(scroll).toBeFocused();
  expect(await scroll.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
    ).axe;
    return (await axe.run(document)).violations.map((item) => item.id);
  });
  expect(violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("request-flow-mobile-dark.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(select(page)).toBeFocused();
});
