import { expect, type Page } from "@playwright/test";
import {
  test,
  traceAccount,
  flowRequestA,
  flowRequestB,
  safeFlow,
  spanRef,
} from "./fixtures/trace-safe-flow";
import type { TraceSafeFlow } from "../../src/shared/api/domains/trace-safe-flow.schema";

// Synthetic browser transport tests the actual React router/auth/query lifetime.
// SQLite/PostgreSQL query, scope and raw-column boundaries have separate Go tests.
const card = (page: Page) => page.getByRole("region", { name: "선택한 요청의 단계 기록", exact: true });
const retry = (page: Page) => card(page).getByRole("button", { name: "단계 기록 다시 조회", exact: true });
const stageName = (page: Page, name: string, kind = "MCP 도구") =>
  card(page).getByRole("rowheader", { name: `요청 기록의 하위 단계: ${name} ${kind}`, exact: true });
const select = (page: Page, ordinal = 1) =>
  page.getByRole("button", { name: `${ordinal}번째 요청 [값 비공개] 상세 보기`, exact: true });
function flowSpan(result: TraceSafeFlow, index: number) {
  const span = result.spans[index];
  if (!span) throw new Error("Missing synthetic flow span");
  return span;
}
async function login(page: Page, selected = false) {
  const target = `/app/observability/traces${selected ? `?selected_ref=${flowRequestA.request_ref}` : ""}`;
  await page.goto(`login?return_to=${encodeURIComponent(target)}`);
  await page.getByLabel("이메일", { exact: true }).fill(traceAccount.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(select(page)).toBeVisible();
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function assertNotPersisted(page: Page, markers: string[]) {
  const state = await page.evaluate(() => ({
    url: location.href,
    local: JSON.stringify(Object.entries(localStorage)),
    session: JSON.stringify(Object.entries(sessionStorage)),
    html: document.documentElement.outerHTML,
  }));
  for (const marker of markers) for (const value of Object.values(state)) expect(value).not.toContain(marker);
}

test("조회 전용 사용자가 선택한 요청의 단계·음수 기록 위치·미기록 지연을 확인한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  expect(gateway.calls).toEqual([]);
  await select(page).click();
  await expect(stageName(page, "공개 검색 도구")).toBeVisible();
  await expect(stageName(page, "권한 검사", "텍스트 SQL 단계")).toBeVisible();
  for (const title of ["단계", "상태", "기록 시각", "기록 상대 위치", "기록된 지연"]) {
    await expect(card(page).getByRole("columnheader", { name: title, exact: true })).toBeVisible();
  }
  const tool = card(page).getByRole("row").filter({ hasText: "공개 검색 도구" });
  await expect(tool).toContainText(/-5\s*ms/u);
  await expect(tool).toContainText("소요 시간 미기록");
  await expect(card(page).getByRole("row").filter({ hasText: "권한 검사" })).toContainText(/0\s*ms/u);
  expect(gateway.calls).toHaveLength(1);
  expect(gateway.calls[0]?.url.searchParams.get("created_at")).toBe(flowRequestA.created_at);
  expect(new URL(page.url()).searchParams.get("selected_ref")).toBe(flowRequestA.request_ref);
  expect(new URL(page.url()).searchParams.has("selected_request")).toBe(false);
});

test("딥 링크 새로고침과 같은 비공개 표시의 두 요청을 원문 ID 없이 구분한다", async ({ page, gateway }) => {
  await login(page, true);
  await expect(card(page)).toContainText("공개 검색 도구");
  await page.reload();
  await expect(card(page)).toContainText("공개 검색 도구");
  await select(page, 2).click();
  await expect(card(page)).toContainText("두 번째 조회 도구");
  await expect(card(page)).not.toContainText("공개 검색 도구");
  expect(gateway.calls.at(-1)?.url.searchParams.get("request_ref")).toBe(flowRequestB.request_ref);
  await page.goBack();
  await expect(card(page)).toContainText("공개 검색 도구");
  expect(gateway.calls.at(-1)?.url.searchParams.get("created_at")).toBe(flowRequestA.created_at);
  await page.getByRole("button", { name: "요청 상세 닫기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "추적 탐색기", exact: true })).toBeFocused();
});

for (const mode of ["legacy_token", "open"] as const) {
  test(`${mode === "legacy_token" ? "기존 읽기 전용 관리자 토큰" : "서버 인증 비활성 모드"}의 확인된 조회 권한을 유지한다`, async ({
    page,
    gateway,
  }) => {
    gateway.authMode(mode);
    const target = `/app/observability/traces?selected_ref=${flowRequestA.request_ref}`;
    if (mode === "legacy_token") {
      await page.goto(`login?return_to=${encodeURIComponent(target)}`);
      await page.getByLabel("기존 관리자 토큰", { exact: true }).fill("public-flow-legacy");
      await page.getByRole("button", { name: "콘솔 열기", exact: true }).click();
    } else {
      await page.goto(target);
    }
    await expect(card(page)).toContainText("공개 검색 도구");
    await page.getByLabel("자동 새로고침 간격").selectOption("0");
    expect(gateway.calls).toHaveLength(1);
    await retry(page).click();
    await expect.poll(() => gateway.calls.length).toBe(2);
    await expect(card(page)).toContainText("공개 검색 도구");
  });
}

test("조회 중인 다른 요청으로 이동하면 이전 요청의 늦은 결과를 표시하지 않는다", async ({
  page,
  gateway,
}) => {
  gateway.holdFlow(1);
  await login(page, true);
  await expect.poll(() => gateway.calls.length).toBe(1);
  await select(page, 2).click();
  await expect(card(page)).toContainText("두 번째 조회 도구");
  gateway.releaseFlow(1);
  await expect.poll(() => gateway.finished.includes(1)).toBe(true);
  await expect(card(page)).not.toContainText("공개 검색 도구");
  expect(gateway.calls).toHaveLength(2);
});

test("실패를 빈 기록으로 표시하지 않고 수동 재조회로 복구한다", async ({ page, gateway }) => {
  gateway.reply(1, {
    status: 503,
    body: { error: { message: "public fixture unavailable" } },
    requestId: "public-flow-failed",
  });
  await login(page, true);
  await expect(card(page).getByRole("alert")).toBeVisible();
  await expect(card(page)).toContainText("public-flow-failed");
  expect(gateway.calls).toHaveLength(1);
  await retry(page).click();
  await expect(card(page)).toContainText("공개 검색 도구");
  expect(gateway.calls).toHaveLength(2);
});

test("구버전 또는 조회 불가 응답에서 원문 추적 API로 우회하지 않는다", async ({ page, gateway }) => {
  gateway.reply(1, {
    status: 404,
    body: {
      error: {
        code: "app_request_flow_unavailable",
        message: "현재 조건에서 처리 기록을 확인할 수 없습니다. 목록을 새로 조회하세요.",
      },
    },
  });
  await login(page, true);
  await expect(card(page)).toContainText("이 요청의 단계 기록을 열 수 없습니다.");
  await expect(stageName(page, "공개 검색 도구")).toBeHidden();
  expect(gateway.calls).toHaveLength(1);
  await expect(page.getByRole("heading", { name: "추적 탐색기", exact: true })).toBeVisible();
});

for (const malformed of [
  "duplicate",
  "parent",
  "target",
  "root-time",
  "root-offset",
  "extra",
  "overflow",
] as const) {
  test(`안전한 응답 계약을 위반한 ${malformed} 결과를 표시하지 않는다`, async ({ page, gateway }) => {
    const result = safeFlow();
    let body: unknown = result;
    if (malformed === "duplicate") flowSpan(result, 1).span_ref = spanRef("r");
    if (malformed === "parent") flowSpan(result, 1).parent_ref = spanRef("z");
    if (malformed === "target") result.request_ref = flowRequestB.request_ref;
    if (malformed === "root-time") flowSpan(result, 0).recorded_at = flowRequestB.created_at;
    if (malformed === "root-offset") flowSpan(result, 0).offset_ms = 1;
    if (malformed === "extra") body = { ...result, raw_error: "synthetic-raw-error-canary" };
    if (malformed === "overflow") result.spans = Array.from({ length: 202 }, () => flowSpan(result, 0));
    gateway.reply(1, { body });
    await login(page, true);
    await expect(card(page).getByRole("alert")).toBeVisible();
    await expect(stageName(page, "공개 검색 도구")).toBeHidden();
    await assertNotPersisted(page, ["synthetic-raw-error-canary"]);
    expect(gateway.calls).toHaveLength(1);
  });
}

test("한도 도달·생략과 실제로 조회한 빈 자식 목록을 구분한다", async ({ page, gateway }) => {
  const limited = safeFlow();
  limited.spans = limited.spans.slice(0, 1);
  limited.coverage.tools = { limit: 100, truncated: true, omitted: 100 };
  gateway.reply(1, { body: limited });
  await login(page, true);
  await expect(card(page)).toContainText(/한도|상한/u);
  await expect(card(page)).toContainText(/생략|표시하지 않/u);
  await expect(card(page)).not.toContainText("도구 호출이 없습니다");
  const empty = safeFlow();
  empty.spans = empty.spans.slice(0, 1);
  gateway.reply(2, { body: empty });
  await retry(page).click();
  await expect(card(page)).toContainText(/표시할 하위 단계가 없습니다/u);
  await expect(card(page)).not.toContainText("도구 호출이 없습니다");
});

test("목록 갱신 중 이전 기록과 키보드 초점을 유지하고 새 기준에서 다시 확인한다", async ({
  page,
  gateway,
}) => {
  await login(page, true);
  await expect(card(page)).toContainText("공개 검색 도구");
  const next = gateway.listReads() + 1;
  gateway.holdList(next);
  const refresh = page.getByRole("button", { name: "새로고침", exact: true });
  const scroll = card(page).getByRole("region", { name: "단계 표 가로 스크롤", exact: true });
  await scroll.focus();
  await expect(scroll).toBeFocused();
  await refresh.evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) throw new Error("새로고침 버튼을 찾지 못했습니다");
    button.click();
  });
  await expect.poll(() => gateway.listReads()).toBe(next);
  await expect(card(page)).toContainText("이전 기록");
  await expect(card(page)).toContainText("공개 검색 도구");
  await expect(scroll).toBeFocused();
  expect(gateway.calls).toHaveLength(1);
  gateway.releaseList(next);
  await expect.poll(() => gateway.calls.length).toBe(2);
  await expect(card(page)).toContainText("공개 검색 도구");
  await expect(scroll).toBeFocused();
});

test("목록 갱신 실패 후 이전 기록을 새 조회 근거로 쓰지 않는다", async ({ page, gateway }) => {
  await login(page, true);
  await expect(card(page)).toContainText("공개 검색 도구");
  const next = gateway.listReads() + 1;
  for (let i = next; i < next + 5; i += 1)
    gateway.listReply(i, { status: 503, body: { error: { message: "public list unavailable" } } });
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(
    page.getByText("갱신에 실패해 마지막 정상 데이터를 표시합니다.", { exact: true }),
  ).toBeVisible();
  await expect(card(page)).toContainText("이전 기록");
  expect(gateway.calls).toHaveLength(1);
});

test("읽기 권한 회수 후 도착한 응답은 표시하지 않고 복구 시 새로 조회한다", async ({ page, gateway }) => {
  gateway.holdFlow(1);
  const old = safeFlow();
  flowSpan(old, 1).name = "회수 전 과거 기록";
  gateway.reply(1, { body: old });
  await login(page, true);
  await expect.poll(() => gateway.calls.length).toBe(1);
  const reads = gateway.listReads();
  gateway.readable(false);
  await runtime(page);
  await expect(
    page.getByRole("heading", { name: "현재 화면의 요청 조회 권한을 확인할 수 없습니다.", exact: true }),
  ).toBeVisible();
  expect(gateway.listReads()).toBe(reads);
  expect(gateway.calls).toHaveLength(1);
  gateway.releaseFlow(1);
  await expect.poll(() => gateway.finished.includes(1)).toBe(true);
  await expect(stageName(page, "회수 전 과거 기록")).toBeHidden();
  gateway.readable(true);
  await runtime(page);
  await expect(card(page)).toContainText("공개 검색 도구");
  await expect(card(page)).not.toContainText("회수 전 과거 기록");
  expect(gateway.calls.length).toBeGreaterThanOrEqual(2);
});

test("계정 A에서 B를 거쳐 A로 복귀해도 처음 수명의 응답을 재사용하지 않는다", async ({ page, gateway }) => {
  gateway.holdFlow(1);
  const old = safeFlow();
  flowSpan(old, 1).name = "첫 계정 수명의 과거 기록";
  gateway.reply(1, { body: old });
  await login(page, true);
  await expect.poll(() => gateway.calls.length).toBe(1);
  gateway.owner("public-reader-b");
  await runtime(page);
  await expect.poll(() => gateway.calls.length).toBeGreaterThanOrEqual(2);
  gateway.owner(traceAccount.id);
  await runtime(page);
  await expect.poll(() => gateway.calls.length).toBeGreaterThanOrEqual(3);
  gateway.releaseFlow(1);
  await expect.poll(() => gateway.finished.includes(1)).toBe(true);
  await expect(card(page)).toContainText("공개 검색 도구");
  await expect(card(page)).not.toContainText("첫 계정 수명의 과거 기록");
});

test("계정 전환의 새 목록이 도착하기 전에는 이전 목록과 단계 조회를 재사용하지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page, true);
  await expect(card(page)).toContainText("공개 검색 도구");
  const next = gateway.listReads() + 1;
  gateway.holdList(next);
  gateway.owner("public-reader-b");
  await runtime(page);
  await expect.poll(() => gateway.listReads()).toBe(next);
  await expect(page.getByText("공개 추적 모델", { exact: true })).toBeHidden();
  await expect(card(page)).toBeHidden();
  expect(gateway.calls).toHaveLength(1);
  gateway.releaseList(next);
  await expect(card(page)).toContainText("공개 검색 도구");
  expect(gateway.calls).toHaveLength(2);
});

test("현재 민감값 접두사에 따라 단계 이름과 실패 요청 ID를 보호한다", async ({ page, gateway }) => {
  const marker = `corp_${"q".repeat(40)}`;
  const result = safeFlow();
  flowSpan(result, 1).name = marker;
  gateway.reply(1, { body: result });
  await login(page, true);
  await expect(card(page).getByRole("table")).toBeVisible();
  await assertNotPersisted(page, [marker]);
  gateway.reply(2, { status: 503, requestId: marker, body: { error: { message: marker } } });
  await retry(page).click();
  await expect(card(page).getByRole("alert")).toBeVisible();
  await assertNotPersisted(page, [marker]);
});

test("이미 조회한 단계에도 변경된 민감값 접두사의 표시 보호를 적용한다", async ({ page, gateway }) => {
  const marker = `newcorp_${"z".repeat(40)}`;
  gateway.prefixes([]);
  const result = safeFlow();
  flowSpan(result, 1).name = marker;
  gateway.reply(1, { body: result });
  await login(page, true);
  await expect(stageName(page, marker)).toBeVisible();
  gateway.prefixes(["newcorp_"]);
  await runtime(page);
  await expect(stageName(page, marker)).toBeHidden();
  await assertNotPersisted(page, [marker]);
});

test("390px 다크 화면의 긴 단계와 미기록 값은 키보드로 읽을 수 있다", async ({ page, gateway }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const result = safeFlow();
  flowSpan(result, 1).name = "단계".repeat(40);
  flowSpan(result, 1).recorded_at = null;
  flowSpan(result, 1).offset_ms = null;
  gateway.reply(1, { body: result });
  await login(page);
  await page.setViewportSize({ width: 390, height: 780 });
  await select(page).click();
  await expect(card(page).getByRole("table")).toBeVisible();
  await expect(card(page)).toContainText("소요 시간 미기록");
  const recordedTime = card(page).locator("tbody tr").first().locator("td").nth(1);
  await expect(recordedTime).toHaveCSS("white-space", "nowrap");
  expect(
    await recordedTime.locator("time").evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getClientRects().length;
    }),
  ).toBe(1);
  await retry(page).focus();
  await expect(retry(page)).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  const scroll = card(page).getByRole("region", { name: "단계 표 가로 스크롤", exact: true });
  await scroll.focus();
  await expect(scroll).toBeFocused();
  expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
    ).axe;
    return (await axe.run(document)).violations.map((item) => item.id);
  });
  expect(violations).toEqual([]);
  await card(page).screenshot({ path: testInfo.outputPath("trace-flow-mobile-card.png") });
  await page.screenshot({ path: testInfo.outputPath("trace-flow-mobile-dark.png"), fullPage: true });
  await page.getByRole("button", { name: "요청 상세 닫기", exact: true }).click();
  await expect(select(page)).toBeFocused();
});
