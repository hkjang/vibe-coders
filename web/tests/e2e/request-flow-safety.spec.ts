import { expect, type Locator, type Page } from "@playwright/test";
import {
  test,
  type FlowGateway,
  type Kind,
  targetUrl,
  firstId,
  secondId,
  email,
  rootName,
  toolName,
  sessionId,
  rootSpan,
  toolSpan,
  traceResult,
  linksResult,
} from "../fixtures/request-flow-safety-gateway";

// Actual React/router/pointer/keyboard behavior against synthetic HTTP only.
// Existing shared query retries/abort/auth handling remain enabled. No actual
// Go, exact stage start/finish, complete PII removal or opaque-ref linkage proof.
const sheet = (page: Page) => page.getByRole("dialog", { name: "LLM 호출 상세", exact: true });
const card = (page: Page) =>
  sheet(page).getByRole("heading", { name: "처리 흐름", exact: true }).locator("xpath=ancestor::section[1]");
const retry = (page: Page, kind: Kind) =>
  card(page).getByRole("button", {
    name: kind === "trace" ? "처리 흐름 다시 조회" : "연결 기록 다시 조회",
    exact: true,
  });
const row = (page: Page, name: string) =>
  card(page).getByText(name, { exact: true }).locator("xpath=ancestor::li[1]");
async function login(page: Page) {
  await page.goto(`login?return_to=${encodeURIComponent(targetUrl)}`);
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByLabel("사용자 메뉴")).toBeVisible();
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
}
async function open(page: Page, id = firstId) {
  await page.getByRole("button", { name: `${id} 호출 상세 열기`, exact: true }).click();
  await sheet(page).getByRole("button", { name: "원인 설명 열기", exact: true }).click();
  await expect(card(page)).toBeVisible();
}
async function ready(page: Page) {
  await expect(row(page, rootName)).toBeVisible();
  await expect(card(page).getByText("MCP 1건", { exact: true })).toBeVisible();
  await expect(retry(page, "trace")).toBeEnabled();
  await expect(retry(page, "links")).toBeEnabled();
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function release(gateway: FlowGateway, kind: Kind, sequence: number) {
  gateway.release(kind, sequence);
  await expect.poll(() => gateway.finished.has(`${kind}:${sequence}`)).toBe(true);
}
async function noSecretLocation(page: Page, marker: string) {
  expect(page.url()).not.toContain(marker);
  expect(page.url()).not.toContain(encodeURIComponent(marker));
  expect(
    await page.evaluate(
      (value) =>
        [localStorage, sessionStorage].every((storage) =>
          Object.values(storage).every((stored) => !String(stored).includes(value)),
        ),
      marker,
    ),
  ).toBe(true);
}

for (const mode of ["preview", "read_only", "preview_read_only"] as const) {
  test(`${mode}: admin:read 사용자가 실제 상세에서 흐름과 연결 기록을 GET으로 조회한다`, async ({
    page,
    gateway,
  }) => {
    gateway.setMode(mode);
    await login(page);
    await open(page);
    await ready(page);
    expect(gateway.attempts.map(({ kind, id, method }) => ({ kind, id, method }))).toEqual(
      expect.arrayContaining([
        { kind: "trace", id: firstId, method: "GET" },
        { kind: "links", id: firstId, method: "GET" },
      ]),
    );
    expect(gateway.count("trace")).toBe(1);
    expect(gateway.count("links")).toBe(1);
    await expect(row(page, rootName).getByText("정상", { exact: true })).toBeVisible();
    await expect(sheet(page).getByRole("button", { name: "분석 실행", exact: true })).toBeDisabled();
    await expect(sheet(page).getByRole("button", { name: "재실행", exact: true })).toBeDisabled();
  });
}
test("흐름이 대기 중이어도 성공한 연결 기록을 표시하고 서로 다른 조회 버튼은 독립적이다", async ({
  page,
  gateway,
}) => {
  gateway.hold("trace", 1);
  await login(page);
  await open(page);
  await expect(card(page).getByText("처리 흐름을 불러오는 중입니다.", { exact: true })).toBeVisible();
  await expect(card(page).getByText("MCP 1건", { exact: true })).toBeVisible();
  await expect(retry(page, "trace")).toBeDisabled();
  await expect(retry(page, "links")).toBeEnabled();
  await retry(page, "links").click();
  await expect.poll(() => gateway.count("links")).toBe(2);
  expect(gateway.count("trace")).toBe(1);
  await expect(card(page).getByText("표시할 스팬이 없습니다.", { exact: true })).toHaveCount(0);
  await release(gateway, "trace", 1);
  await ready(page);
});
for (const kind of ["trace", "links"] as const) {
  test(`${kind}: 첫 503과 기본 재시도를 보존하며 수동 재시도는 실패한 조회만 다시 보낸다`, async ({
    page,
    gateway,
  }) => {
    gateway.setReply(kind, { status: 503 });
    await login(page);
    await open(page);
    const title = kind === "trace" ? "처리 흐름을 불러오지 못했습니다." : "연결 기록을 불러오지 못했습니다.";
    await expect(card(page).getByText(title, { exact: true })).toBeVisible();
    await expect(card(page)).toContainText(`flow-${kind}-response`);
    // Production QueryClient retries a retryable 503 once. This is not a
    // claim that the first button caused only one transport attempt.
    expect(gateway.count(kind)).toBe(2);
    expect(gateway.count(kind === "trace" ? "links" : "trace")).toBe(1);
    await expect(card(page).getByText("표시할 스팬이 없습니다.", { exact: true })).toHaveCount(0);
    if (kind === "links") await expect(row(page, rootName)).toBeVisible();
    gateway.setReply(kind, {});
    await retry(page, kind).click();
    await ready(page);
    expect(gateway.count(kind)).toBe(3);
    expect(gateway.count(kind === "trace" ? "links" : "trace")).toBe(1);
  });
}
for (const kind of ["trace", "links"] as const) {
  test(`${kind}: 재조회 실패는 이전 정상 데이터를 표시하고 독립적인 수동 복구를 제공한다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await open(page);
    await ready(page);
    gateway.setReply(kind, { status: 503 });
    await retry(page, kind).click();
    const stale = kind === "trace" ? "이전 처리 흐름을 표시합니다." : "이전 연결 기록을 표시합니다.";
    await expect(card(page).getByText(stale, { exact: true })).toBeVisible();
    const failed = kind === "trace" ? "처리 흐름을 불러오지 못했습니다." : "연결 기록을 불러오지 못했습니다.";
    // Previous data is also disclosed while a refresh is still pending. Wait
    // for its terminal error/idle state before counting the automatic retry.
    await expect(card(page).getByText(failed, { exact: true })).toBeVisible();
    await expect(retry(page, kind)).toBeEnabled();
    await expect(row(page, rootName)).toBeVisible();
    await expect(card(page).getByText("MCP 1건", { exact: true })).toBeVisible();
    expect(gateway.count(kind)).toBe(3);
    expect(gateway.count(kind === "trace" ? "links" : "trace")).toBe(1);
    gateway.setReply(kind, {});
    await retry(page, kind).click();
    await expect(card(page).getByText(stale, { exact: true })).toHaveCount(0);
    await ready(page);
    expect(gateway.count(kind)).toBe(4);
  });
}
test("양쪽 조회 실패 중 흐름만 복구해도 연결 오류는 별도로 남고 빈 기록으로 단정하지 않는다", async ({
  page,
  gateway,
}) => {
  gateway.setReply("trace", { status: 503 });
  gateway.setReply("links", { status: 503 });
  await login(page);
  await open(page);
  await expect(card(page).getByText("처리 흐름을 불러오지 못했습니다.", { exact: true })).toBeVisible();
  await expect(card(page).getByText("연결 기록을 불러오지 못했습니다.", { exact: true })).toBeVisible();
  gateway.setReply("trace", {});
  await retry(page, "trace").click();
  await expect(row(page, rootName)).toBeVisible();
  await expect(card(page).getByText("연결 기록을 불러오지 못했습니다.", { exact: true })).toBeVisible();
  await expect(card(page).getByText("표시할 스팬이 없습니다.", { exact: true })).toHaveCount(0);
  expect(gateway.count("trace")).toBe(3);
  expect(gateway.count("links")).toBe(2);
});
for (const variant of ["omitted", "null", "empty"] as const) {
  test(`${variant}: 호환 어댑터의 빈 목록을 실제 단계 미실행으로 해석하지 않는다`, async ({
    page,
    gateway,
  }) => {
    const body = traceResult({ spans: variant === "null" ? null : variant === "empty" ? [] : undefined });
    gateway.setReply("trace", { body });
    await login(page);
    await open(page);
    await expect(card(page).getByText("표시할 스팬이 없습니다.", { exact: true })).toBeVisible();
    await expect(card(page)).not.toContainText("단계가 기록되지 않았습니다");
    await expect(card(page).getByRole("link", { name: "세션 흐름 보기" })).toBeVisible();
    expect(gateway.count("trace")).toBe(1);
    // JSON omission/null/[] converge in the real loose adapter; this does not
    // add a strict response contract or distinguish those sources in the UI.
  });
}
test("일부 연결 건수가 누락되면 0 대신 미확인으로 표시하되 실제 0은 보존한다", async ({ page, gateway }) => {
  gateway.setReply("links", { body: linksResult({ counts: { tools: 1, tool_errors: 0 } }) });
  await login(page);
  await open(page);
  await expect(card(page).getByText("MCP 미확인", { exact: true })).toBeVisible();
  await expect(card(page).getByText("Text2SQL 미확인", { exact: true })).toBeVisible();
  await expect(card(page).getByText("도구 오류 0건", { exact: true })).toBeVisible();
  await expect(card(page).getByText("MCP 0건", { exact: true })).toHaveCount(0);
});
test("건너뜀과 미확인 상태는 정상이 아니며 캐시는 오류 상태를 덮어쓰지 않는다", async ({ page, gateway }) => {
  gateway.setReply("trace", {
    body: traceResult({
      spans: [
        rootSpan({ name: "공개 오류 요청", status: "error", error: "공개 오류 사유", cache_hit: true }),
        toolSpan({
          span_id: "span:t2s:skipped",
          name: "text2sql:execute",
          kind: "text2sql",
          status: "skipped",
          error: "explain_guard_failed",
        }),
        toolSpan({
          span_id: "span:t2s:future",
          name: "미확인 단계",
          kind: "text2sql",
          status: "future_status",
          cache_hit: true,
        }),
      ],
    }),
  });
  await login(page);
  await open(page);
  await expect(row(page, "공개 오류 요청").getByText("오류", { exact: true })).toBeVisible();
  await expect(row(page, "공개 오류 요청")).toContainText("캐시 적중");
  await expect(row(page, "text2sql:execute").getByText("건너뜀", { exact: true })).toBeVisible();
  await expect(row(page, "미확인 단계").getByText("상태 미확인", { exact: true })).toBeVisible();
  await expect(row(page, "미확인 단계").getByText("정상", { exact: true })).toHaveCount(0);
});
test("루트 기록0·도구 미기록·Text2SQL 기록 상대위치를 실제 시작이나 종료로 주장하지 않는다", async ({
  page,
  gateway,
}) => {
  gateway.setReply("trace", {
    body: traceResult({
      total_ms: 340,
      spans: [
        rootSpan({ duration_ms: 0 }),
        toolSpan(),
        toolSpan({
          span_id: "span:t2s:public-execute",
          name: "text2sql:execute",
          kind: "text2sql",
          start_offset_ms: 300,
          duration_ms: 40,
        }),
      ],
    }),
  });
  await login(page);
  await open(page);
  await expect(row(page, rootName)).toContainText("기록된 지연 0ms");
  await expect(row(page, toolName)).toContainText("소요 시간 미기록");
  await expect(row(page, "text2sql:execute")).toContainText("기록된 상대 위치 +300ms");
  await expect(row(page, "text2sql:execute")).toContainText("기록된 지연 40ms");
  await expect(card(page)).not.toContainText("시작 +");
  await expect(card(page)).not.toContainText("프롬프트나 SQL 원문은 포함하지 않습니다.");
  await expect(card(page)).toContainText(/오류.*원문|민감.*포함/u);
});
test("현재 접두사 변경은 이름·오류·대체 ID·종류와 세션 링크를 재조회 없이 표시 보호한다", async ({
  page,
  gateway,
}) => {
  const prefix = "flow_runtime_";
  const marker = `${prefix}${"a".repeat(36)}`;
  gateway.setReply("trace", {
    body: traceResult({
      spans: [
        rootSpan({ name: `공개 ${marker}`, error: `공개 오류 ${marker}`, status: "error" }),
        toolSpan({ span_id: `span:tool:${marker}`, name: "", kind: marker }),
      ],
    }),
  });
  gateway.setReply("links", { body: linksResult({ session_id: marker }) });
  await login(page);
  await open(page);
  await expect(card(page)).toContainText(marker);
  gateway.setPrefixes([prefix]);
  await runtime(page);
  await expect.poll(() => card(page).evaluate((element) => element.outerHTML)).not.toContain(marker);
  await expect(card(page).getByRole("link", { name: "세션 흐름 보기" })).toHaveCount(0);
  expect(gateway.count("trace")).toBe(1);
  expect(gateway.count("links")).toBe(1);
  await noSecretLocation(page, marker);
});
test("기본 비밀 형태의 응답 세션 ID를 href나 DOM에 넣지 않는다", async ({ page, gateway }) => {
  const marker = `vc_sk_${"b".repeat(36)}`;
  gateway.setReply("links", { body: linksResult({ session_id: marker }) });
  await login(page);
  await open(page);
  await expect(card(page)).toContainText(
    "세션 식별자를 안전하게 확인할 수 없어 이동 링크를 표시하지 않습니다.",
  );
  expect(await card(page).evaluate((element) => element.outerHTML)).not.toContain(marker);
  await expect(card(page).getByRole("link", { name: "세션 흐름 보기" })).toHaveCount(0);
  await noSecretLocation(page, marker);
});
test("오류 Request ID도 현재 비밀 표시 규칙을 적용하고 오류 원문을 삽입하지 않는다", async ({
  page,
  gateway,
}) => {
  const marker = `vc_sk_${"c".repeat(36)}`;
  gateway.setReply("trace", { status: 503, requestId: marker });
  await login(page);
  await open(page);
  await expect(card(page).getByText("처리 흐름을 불러오지 못했습니다.", { exact: true })).toBeVisible();
  expect(await card(page).evaluate((element) => element.outerHTML)).not.toContain(marker);
  await expect(card(page)).not.toContainText("Synthetic flow read unavailable");
  await noSecretLocation(page, marker);
});
test("세션 링크는 /app basename을 한 번만 붙이고 같은 문서의 기존 XView 경로로 이동한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await open(page);
  await ready(page);
  await page.evaluate(() => {
    (window as Window & { flowDocument?: string }).flowDocument = "same-document";
  });
  const link = card(page).getByRole("link", { name: "세션 흐름 보기", exact: true });
  await expect(link).toHaveAttribute("href", `/app/observability/xview?session_id=${sessionId}`);
  await link.click();
  await expect(page.getByRole("heading", { name: "XView 실시간", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/app/observability/xview");
  expect(new URL(page.url()).searchParams.get("session_id")).toBe(sessionId);
  expect(await page.evaluate(() => (window as Window & { flowDocument?: string }).flowDocument)).toBe(
    "same-document",
  );
  expect(gateway.count("trace")).toBe(1);
  // This proves the existing destination only, not the waterfall purpose tab.
});
test("열린 조회의 읽기 전용 전환은 순수 GET 응답을 유지한다", async ({ page, gateway }) => {
  gateway.hold("trace", 1);
  await login(page);
  await open(page);
  await expect.poll(() => gateway.count("trace")).toBe(1);
  gateway.setMode("preview_read_only");
  await runtime(page);
  await expect(card(page)).toBeVisible();
  await release(gateway, "trace", 1);
  await ready(page);
  expect(gateway.count("trace")).toBe(1);
});
test("A 상세를 닫고 B를 연 뒤 늦은 A 응답은 현재 B 기록에 섞이지 않는다", async ({ page, gateway }) => {
  gateway.hold("trace", 1, { body: traceResult({ spans: [rootSpan({ name: "이전 A 기록" })] }) });
  await login(page);
  await open(page);
  await expect.poll(() => gateway.count("trace")).toBe(1);
  await sheet(page).getByRole("button", { name: "패널 닫기", exact: true }).click();
  await expect(sheet(page)).toBeHidden();
  gateway.setReply("trace", {
    body: traceResult({ spans: [rootSpan({ name: "현재 B 기록" }, secondId)] }, secondId),
  });
  await open(page, secondId);
  await expect(row(page, "현재 B 기록")).toBeVisible();
  await release(gateway, "trace", 1);
  await expect(row(page, "현재 B 기록")).toBeVisible();
  await expect(card(page)).not.toContainText("이전 A 기록");
  expect(gateway.attempts.filter((item) => item.kind === "trace").map(({ id }) => id)).toEqual([
    firstId,
    secondId,
  ]);
  // Transport cancellation can prevent old JS delivery. Captured callback or
  // same-instance finally ordering is not established by this browser case.
});

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  for (const region of [sheet(page), card(page), ...(await card(page).locator("li").all())])
    expect(await region.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
}
async function axe(page: Page) {
  return page.evaluate(async () => {
    const engine = (
      window as Window & {
        axe?: {
          run: (root: Document) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
        };
      }
    ).axe;
    if (!engine) throw new Error("Accessibility engine missing");
    return (await engine.run(document)).violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map(({ target }) => target),
    }));
  });
}
async function fullHit(button: Locator) {
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport({ ratio: 1 });
  expect(
    await button.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit === node || (hit !== null && node.contains(hit));
    }),
  ).toBe(true);
}
test("390px 다크 상세는 긴 한글 원문 줄바꿈·실제 키보드 재조회·접근성과 가로 경계를 유지한다", async ({
  page,
  gateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  gateway.setMode("preview_read_only");
  const longName = `공개-${"긴처리단계이름".repeat(28)}`;
  const longReason = `${"공개오류설명".repeat(22)}\n둘째 줄도 생략 없이 확인합니다.`;
  const body = traceResult({
    spans: [rootSpan({ name: longName, status: "error", error: longReason }), toolSpan()],
  });
  gateway.setReply("trace", { body });
  await login(page);
  await open(page);
  await expect(row(page, longName)).toBeVisible();
  expect(await row(page, longName).locator("code").textContent()).toBe(longName);
  expect(await row(page, longName).getByText(longReason, { exact: true }).textContent()).toBe(longReason);
  await noOverflow(page);
  expect(await axe(page)).toEqual([]);
  await fullHit(retry(page, "trace"));
  await retry(page, "trace").click();
  await expect.poll(() => gateway.count("trace")).toBe(2);
  await expect(retry(page, "trace")).toBeEnabled();
  // Reach the adjacent independent query using a real Tab, then hold that
  // keyboard-triggered request. Do not focus it using script.
  await page.keyboard.press("Tab");
  await expect(retry(page, "links")).toBeFocused();
  gateway.hold("links", 2);
  await page.keyboard.press("Enter");
  await expect.poll(() => gateway.count("links")).toBe(2);
  await expect(retry(page, "links")).toBeDisabled();
  await expect(retry(page, "trace")).toBeEnabled();
  await noOverflow(page);
  expect(await axe(page)).toEqual([]);
  await release(gateway, "links", 2);
  await expect(retry(page, "links")).toBeEnabled();
  await row(page, toolName).scrollIntoViewIfNeeded();
  await expect(row(page, toolName)).toBeInViewport({ ratio: 1 });
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath("request-flow-long-records-explicit-scroll.png") });
  await fullHit(sheet(page).getByRole("button", { name: "패널 닫기", exact: true }));
  await sheet(page).getByRole("button", { name: "패널 닫기", exact: true }).click();
  await expect(sheet(page)).toBeHidden();
  await expect(page.getByRole("button", { name: `${firstId} 호출 상세 열기`, exact: true })).toBeFocused();
});
