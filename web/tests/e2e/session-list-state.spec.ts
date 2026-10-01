import { expect, type Page } from "@playwright/test";
import {
  test,
  sessionAccount,
  sessionA,
  sessionB,
  sessionC,
  sessionList,
  type SessionListGateway,
} from "./fixtures/session-list-state";

// Synthetic HTTP exercises the real AuthProvider, FeatureRoute, QueryClient,
// browser history, DataTable and Sheet. It does not prove Go scope/DB semantics,
// whole-session completeness, prompt-free DTOs or the existing CSV lifetime.
const path = "/app/observability/sessions";
const period = (page: Page) => page.getByLabel("조회 기간(일)", { exact: true });
const keyword = (page: Page) => page.getByLabel("세션 ID · 메시지 검색", { exact: true });
const refresh = (page: Page) => page.getByRole("button", { name: "새로고침", exact: true });
const table = (page: Page) => page.getByRole("table", { name: "최근 코딩 세션", exact: true });
const criteria = (page: Page) => page.getByRole("region", { name: "목록 조회 기준", exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "세션 비행기록", exact: true });
const select = (page: Page, id = sessionA.session_id) =>
  page.getByRole("button", { name: `${id} 세션 비행기록 열기`, exact: true });
const stat = (page: Page, label: string) =>
  page
    .getByRole("region", { name: "세션 요약", exact: true })
    .getByRole("article")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator("strong");
const failure = {
  status: 503,
  requestId: "public-session-list-failed",
  body: { error: { message: "public synthetic list unavailable" } },
};
async function enter(page: Page, target = path, mode: "session" | "legacy_token" | "open" = "session") {
  if (mode === "open") await page.goto(target);
  else {
    await page.goto(`login?return_to=${encodeURIComponent(target)}`);
    if (mode === "session") {
      await page.getByLabel("이메일", { exact: true }).fill(sessionAccount.email);
      await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
      await page.getByRole("button", { name: "로그인", exact: true }).click();
    } else {
      await page.getByLabel("기존 관리자 토큰", { exact: true }).fill("public-session-legacy");
      await page.getByRole("button", { name: "콘솔 열기", exact: true }).click();
    }
  }
  await expect(page.getByRole("heading", { name: "세션 비행기록", exact: true }).first()).toBeAttached();
  // A direct Sheet makes the underlying shell inert; do not interact through it.
  if (!new URL(target, "http://fixture.invalid").searchParams.has("session_id"))
    await page.getByRole("combobox", { name: "자동 새로고침 간격", exact: true }).selectOption("0");
}
async function submit(page: Page, days: string, q = "") {
  await period(page).fill(days);
  await keyword(page).fill(q);
  await page.getByRole("button", { name: "조회", exact: true }).click();
}
async function navigateSearch(page: Page, search: string) {
  // Actual browser history + Router subscription, not a mocked component hook.
  await page.evaluate((value) => {
    history.pushState({}, "", `/app/observability/sessions${value}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, search);
}
async function refreshWithoutMovingFocus(page: Page) {
  await refresh(page).evaluate((node) => {
    if (!(node instanceof HTMLButtonElement)) throw new Error("Missing refresh button");
    node.click();
  });
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function noDetail(page: Page, gateway: SessionListGateway, url: string) {
  await expect(page).toHaveURL(url);
  await expect(dialog(page)).toBeHidden();
  expect(gateway.detailCalls).toHaveLength(0);
}

test("7일 성공 뒤 30일 보류는 이전 기간의 표와 합계를 유지하고 새 선택을 막는다", async ({
  page,
  gateway,
}) => {
  await enter(page);
  await expect(select(page)).toBeVisible();
  await expect(stat(page, "세션")).toHaveText("2");
  await expect(stat(page, "요청")).toHaveText("15");
  const oldTable = await table(page).elementHandle();
  const oldAction = await select(page).elementHandle();
  if (!oldTable || !oldAction) throw new Error("Missing initial real table/action");
  const sequence = gateway.listCalls.length + 1;
  gateway.hold(sequence);
  await submit(page, "30");
  await expect.poll(() => gateway.listCalls.length).toBe(sequence);
  expect(gateway.listCalls.at(-1)?.url.searchParams.get("days")).toBe("30");
  await expect(criteria(page)).toContainText("최근 30일 조회 중 · 아래 표와 합계는 이전 7일 결과");
  await expect(stat(page, "요청")).toHaveText("15");
  expect(await table(page).evaluate((node, previous) => node === previous, oldTable)).toBe(true);
  expect(await select(page).evaluate((node, previous) => node === previous, oldAction)).toBe(true);
  const url = page.url();
  await select(page).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("현재 목록을 다시 확인한 뒤 세션을 선택하세요.", { exact: true }),
  ).toBeVisible();
  await expect(select(page)).toBeFocused();
  await noDetail(page, gateway, url);
  await table(page).getByRole("cell", { name: sessionA.session_id, exact: true }).click();
  await noDetail(page, gateway, url);
  gateway.release(sequence);
  await expect(select(page, sessionC.session_id)).toBeVisible();
  await expect(criteria(page)).toContainText("아래 표와 합계는 최근 30일 응답의 검색 결과입니다.");
  await expect(stat(page, "요청")).toHaveText("47");
  await select(page, sessionC.session_id).click();
  await expect(dialog(page)).toContainText("공개 합성 세션의 제한된 최근 요청");
  expect(gateway.detailCalls).toHaveLength(1);
  expect(gateway.detailCalls[0]?.url.search).toBe("");
  expect(gateway.detailCalls[0]?.headers["x-vibe-route"]).toBe("observability.sessions.flight-recorder");
});

test("미캐시 기간의 최종 실패는 0건을 꾸미지 않고 검색 폼과 재시도를 유지한다", async ({ page, gateway }) => {
  await enter(page);
  await expect(select(page)).toBeVisible();
  gateway.periodReply(30, failure);
  await submit(page, "30");
  await expect(page.getByRole("alert").filter({ hasText: "public-session-list-failed" })).toBeVisible();
  await expect(period(page)).toHaveValue("30");
  await expect(keyword(page)).toBeVisible();
  await expect(table(page)).toBeHidden();
  await expect(page.getByText("표시할 세션이 없습니다.", { exact: true })).toBeHidden();
  const values = await page.getByRole("region", { name: "세션 요약" }).locator("strong").allTextContents();
  expect(values.map((value) => value.replace(/\D/gu, ""))).not.toContain("0");
  expect(gateway.detailCalls).toHaveLength(0);
  gateway.resetPeriod(30);
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(select(page, sessionC.session_id)).toBeVisible();
  await expect(stat(page, "요청")).toHaveText("47");
});

test("같은 7일의 갱신 보류와 실패는 표·초점·마지막 정상 합계를 보존한다", async ({ page, gateway }) => {
  await enter(page);
  await expect(select(page)).toBeVisible();
  const oldAction = await select(page).elementHandle();
  if (!oldAction) throw new Error("Missing initial detail action");
  const sequence = gateway.listCalls.length + 1;
  gateway.hold(sequence);
  gateway.periodReply(7, failure);
  await select(page).focus();
  await refreshWithoutMovingFocus(page);
  await expect.poll(() => gateway.listCalls.length).toBe(sequence);
  await expect(criteria(page)).toContainText("이전 7일 결과");
  await expect(select(page)).toBeFocused();
  await expect(stat(page, "요청")).toHaveText("15");
  const url = page.url();
  await page.keyboard.press("Enter");
  await noDetail(page, gateway, url);
  gateway.release(sequence);
  await expect(page.getByRole("alert").filter({ hasText: "최신 목록을 갱신하지 못해" })).toBeVisible();
  await expect(select(page)).toBeFocused();
  expect(await select(page).evaluate((node, previous) => node === previous, oldAction)).toBe(true);
  await expect(stat(page, "요청")).toHaveText("15");
  await page.keyboard.press("Enter");
  await noDetail(page, gateway, url);
  gateway.resetPeriod(7);
  await refreshWithoutMovingFocus(page);
  await expect(criteria(page)).toContainText("아래 표와 합계는 최근 7일 응답의 검색 결과입니다.");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  expect(gateway.detailCalls).toHaveLength(1);
});

test("실제 days·q 이력 변경은 입력을 맞추고 뒤로·앞으로 가기에도 일치한다", async ({ page, gateway }) => {
  await enter(page);
  await expect(select(page)).toBeVisible();
  await period(page).fill("90");
  await keyword(page).fill("미제출 초안");
  await navigateSearch(page, "?days=30&q=month");
  await expect(period(page)).toHaveValue("30");
  await expect(keyword(page)).toHaveValue("month");
  await expect(select(page, sessionC.session_id)).toBeVisible();
  await page.goBack();
  await expect(period(page)).toHaveValue("7");
  await expect(keyword(page)).toHaveValue("");
  await expect(select(page)).toBeVisible();
  await page.goForward();
  await expect(period(page)).toHaveValue("30");
  await expect(keyword(page)).toHaveValue("month");
  expect(gateway.detailCalls).toHaveLength(0);
  await select(page, sessionC.session_id).click();
  await expect(dialog(page)).toBeVisible();
  expect(new URL(page.url()).searchParams.get("q")).toBe("month");
});

test("session_id만 여닫거나 이력을 이동하면 미제출 입력과 검증 안내를 보존한다", async ({
  page,
  gateway,
}) => {
  await enter(page);
  await expect(select(page)).toBeVisible();
  const draft = `vc_sk_${"x".repeat(32)}`;
  await submit(page, "90", draft);
  const validation = page.getByRole("alert").filter({ hasText: "인증정보로 보이는 검색어" });
  await expect(validation).toBeVisible();
  await select(page).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(period(page)).toHaveValue("90");
  await expect(keyword(page)).toHaveValue(draft);
  await expect(validation).toBeVisible();
  await page.goBack();
  await expect(dialog(page)).toBeVisible();
  await page.goForward();
  await expect(dialog(page)).toBeHidden();
  await refresh(page).click();
  await expect(criteria(page)).toContainText("아래 표와 합계는 최근 7일 응답의 검색 결과입니다.");
  await expect(period(page)).toHaveValue("90");
  await expect(keyword(page)).toHaveValue(draft);
  await expect(validation).toBeVisible();
  expect(gateway.detailCalls).toHaveLength(1);
  await submit(page, "7");
  await expect(validation).toBeHidden();
  await expect(period(page)).toHaveValue("7");
  await expect(keyword(page)).toHaveValue("");
  await keyword(page).fill("새 미제출 초안");
  await page.getByRole("button", { name: "초기화", exact: true }).click();
  await expect(keyword(page)).toHaveValue("");
});

test("최대 200개 수신 목록의 로컬 검색 합계와 검색 없음·응답 빈 목록을 구분한다", async ({
  page,
  gateway,
}) => {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    ...sessionA,
    session_id: `public-batch-${index}`,
    requests: 1,
    errors: 0,
    last_message: index === 199 ? "마지막 공개 검색대상" : "공개 일반 미리보기",
  }));
  gateway.periodReply(7, { body: sessionList(7, rows) });
  await enter(page);
  await expect(stat(page, "세션")).toHaveText("200");
  await expect(
    page.getByText("검색과 합계는 불러온 최대 200개 세션에 적용됩니다.", { exact: true }),
  ).toBeVisible();
  const before = gateway.listCalls.length;
  await submit(page, "7", "마지막 공개");
  await expect(select(page, "public-batch-199")).toBeVisible();
  await expect(stat(page, "세션")).toHaveText("1");
  await expect(stat(page, "요청")).toHaveText("1");
  expect(gateway.listCalls).toHaveLength(before);
  expect(gateway.listCalls.every((call) => !call.url.searchParams.has("q"))).toBe(true);
  await submit(page, "7", "불일치 검색");
  await expect(page.getByText("불러온 세션에서 검색 결과가 없습니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("표시할 세션이 없습니다.", { exact: true })).toBeHidden();
  gateway.periodReply(7, { body: sessionList(7, []) });
  await refresh(page).click();
  await expect(page.getByText("표시할 세션이 없습니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("불러온 세션에서 검색 결과가 없습니다.", { exact: true })).toBeHidden();
  expect(gateway.detailCalls).toHaveLength(0);
});

test("목록 밖 직접 상세는 첫 목록 실패에도 유지되고 기간·검색을 상세 API에 보내지 않는다", async ({
  page,
  gateway,
}) => {
  gateway.periodReply(30, failure);
  const id = "public-session-outside-list";
  await enter(page, `${path}?days=30&q=목록밖&session_id=${id}`);
  await expect(dialog(page)).toContainText(id);
  await expect(dialog(page)).toContainText("목록 기간과 별개인 세션의 제한된 최근 요청을 보여줍니다.");
  await expect(
    page.getByRole("alert", { includeHidden: true }).filter({ hasText: "public-session-list-failed" }),
  ).toBeAttached();
  await expect(dialog(page)).toBeVisible();
  expect(gateway.detailCalls).toHaveLength(1);
  expect(gateway.detailCalls[0]?.url.search).toBe("");
  await page.keyboard.press("Escape");
  await expect(period(page)).toHaveValue("30");
  await expect(keyword(page)).toHaveValue("목록밖");
  await expect(page.getByRole("alert").filter({ hasText: "public-session-list-failed" })).toBeVisible();
});

test("200개 목록에 없는 세션의 직접 주소도 기존 상세 조회를 허용한다", async ({ page, gateway }) => {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    ...sessionA,
    session_id: `public-returned-session-${index}`,
  }));
  gateway.periodReply(7, { body: sessionList(7, rows) });
  const id = "public-unlisted-session";
  await enter(page, `${path}?session_id=${id}`);
  await expect(dialog(page)).toContainText(id);
  await expect(
    page
      .getByRole("region", { name: "세션 요약", exact: true, includeHidden: true })
      .locator("strong")
      .first(),
  ).toHaveText("200");
  expect(rows.some((row) => row.session_id === id)).toBe(false);
  expect(gateway.detailCalls).toHaveLength(1);
  expect(gateway.detailCalls[0]?.url.pathname).toBe(`/admin/sessions/${id}/flight-recorder`);
  expect(gateway.detailCalls[0]?.url.search).toBe("");
});

test("열린 비행기록은 목록의 새 기간 최종 실패에도 같은 DOM과 상세 조회 수를 유지한다", async ({
  page,
  gateway,
}) => {
  await enter(page);
  await select(page).click();
  await expect(dialog(page)).toContainText("공개 합성 세션의 제한된 최근 요청");
  const opened = await dialog(page).elementHandle();
  if (!opened) throw new Error("Missing open Sheet");
  gateway.periodReply(30, failure);
  await navigateSearch(page, `?days=30&session_id=${sessionA.session_id}`);
  await expect(
    page.getByRole("alert", { includeHidden: true }).filter({ hasText: "public-session-list-failed" }),
  ).toBeAttached();
  await expect(dialog(page)).toBeVisible();
  expect(await dialog(page).evaluate((node, previous) => node === previous, opened)).toBe(true);
  expect(gateway.detailCalls).toHaveLength(1);
});

for (const mode of ["legacy_token", "open"] as const) {
  test(`${mode === "open" ? "인증 비활성" : "읽기 전용 기존 토큰"} 모드는 쓰기 없이 현재 세션 상세를 연다`, async ({
    page,
    gateway,
  }) => {
    gateway.authMode(mode);
    await enter(page, path, mode);
    await expect(select(page)).toBeVisible();
    await select(page).click();
    await expect(dialog(page)).toContainText("공개 합성 세션의 제한된 최근 요청");
    expect(gateway.detailCalls).toHaveLength(1);
  });
}

for (const invalid of ["누락", "다른 기간", "소수 기간"] as const) {
  test(`${invalid} 응답 기간은 미확인으로 알리고 해당 행을 새 상세의 근거로 쓰지 않는다`, async ({
    page,
    gateway,
  }) => {
    const body =
      invalid === "누락"
        ? { sessions: [sessionA] }
        : sessionList(invalid === "다른 기간" ? 30 : 7.5, [sessionA]);
    gateway.periodReply(7, { body });
    await enter(page);
    await expect(criteria(page)).toContainText("응답 기간 미확인");
    await expect(select(page)).toBeVisible();
    const url = page.url();
    await select(page).focus();
    await page.keyboard.press("Enter");
    await expect(select(page)).toBeFocused();
    await noDetail(page, gateway, url);
    gateway.resetPeriod(7);
    await refresh(page).click();
    await expect(criteria(page)).toContainText("아래 표와 합계는 최근 7일 응답의 검색 결과입니다.");
    await select(page).click();
    await expect(dialog(page)).toBeVisible();
    expect(gateway.detailCalls).toHaveLength(1);
  });
}

for (const boundary of ["사용자", "팀"] as const) {
  test(`${boundary} 변경 전 보류된 목록은 현재 주체의 행을 덮어쓰지 않는다`, async ({ page, gateway }) => {
    await enter(page);
    await expect(select(page)).toBeVisible();
    const old = gateway.listCalls.length + 1;
    gateway.hold(old);
    await refresh(page).click();
    await expect.poll(() => gateway.listCalls.length).toBe(old);
    const current = { ...sessionB, session_id: "public-current-principal-session" };
    gateway.periodReply(7, { body: sessionList(7, [current]) });
    if (boundary === "사용자") gateway.owner("public-new-session-reader");
    else gateway.team("public-new-session-team");
    await runtime(page);
    await expect(select(page, current.session_id)).toBeVisible();
    gateway.release(old);
    await expect.poll(() => gateway.finished.includes(old)).toBe(true);
    await expect(select(page)).toBeHidden();
    await expect(stat(page, "요청")).toHaveText("3");
    expect(gateway.detailCalls).toHaveLength(0);
    await select(page, current.session_id).click();
    await expect(dialog(page)).toBeVisible();
    expect(gateway.detailCalls).toHaveLength(1);
  });
}

test("서버 가용 표시가 참이어도 현재 admin:read 회수와 복구를 실제 경로에서 따른다", async ({
  page,
  gateway,
}) => {
  await enter(page);
  await expect(select(page)).toBeVisible();
  const url = page.url();
  gateway.readable(false);
  await runtime(page);
  // Server availability deliberately stays true, so FeatureRoute remains
  // mounted; the session-local current-scope guard must refuse admission.
  await expect(
    page.getByRole("heading", { name: "세션 목록 조회 권한을 확인하세요.", exact: true }),
  ).toBeVisible();
  await expect(select(page)).toBeHidden();
  await expect(page).toHaveURL(url);
  await expect(dialog(page)).toBeHidden();
  expect(gateway.detailCalls).toHaveLength(0);
  gateway.readable(true);
  gateway.periodReply(7, { body: sessionList(7, [sessionB]) });
  await runtime(page);
  await expect(select(page, sessionB.session_id)).toBeVisible();
  await expect(select(page)).toBeHidden();
  await select(page, sessionB.session_id).click();
  await expect(dialog(page)).toBeVisible();
  expect(gateway.detailCalls).toHaveLength(1);
});

test("현재 설정의 인증정보 접두사는 입력 단계에서 거부하여 주소 이력에 쓰지 않는다", async ({
  page,
  gateway,
}) => {
  await page.addInitScript(() => {
    const urls: string[] = [];
    Object.defineProperty(window, "__sessionHistoryWrites", { value: urls });
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method].bind(history);
      history[method] = (state: unknown, unused: string, url?: string | URL | null) => {
        if (url != null) urls.push(String(url));
        original(state, unused, url);
      };
    }
  });
  await enter(page);
  await expect(select(page)).toBeVisible();
  gateway.prefixes(["custom_public_"]);
  await runtime(page);
  const marker = `custom_public_${"z".repeat(32)}`;
  const url = page.url();
  await submit(page, "7", marker);
  await expect(page.getByRole("alert").filter({ hasText: "인증정보로 보이는 검색어" })).toBeVisible();
  await expect(page).toHaveURL(url);
  const writes = await page.evaluate(
    () => (window as unknown as { __sessionHistoryWrites: string[] }).__sessionHistoryWrites,
  );
  expect(writes.some((item) => item.includes(marker))).toBe(false);
  expect(gateway.listCalls.some((call) => call.url.href.includes(marker))).toBe(false);
  expect(gateway.detailCalls).toHaveLength(0);
});

test("390px 다크 목록의 긴 한글은 페이지를 넘치지 않고 키보드 상세와 접근성을 유지한다", async ({
  page,
  gateway,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  gateway.periodReply(7, {
    body: sessionList(7, [{ ...sessionA, last_message: "긴 공개 한글 세션 미리보기 ".repeat(30) }]),
  });
  await enter(page);
  await page.setViewportSize({ width: 390, height: 780 });
  await expect(select(page)).toBeVisible();
  await expect(criteria(page)).toContainText("최근 7일 응답");
  const scroll = page.getByLabel(/^최근 코딩 세션 표 영역/u);
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
  await select(page).focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toContainText("목록 기간과 별개인 세션의 제한된 최근 요청");
  await expect(dialog(page).getByRole("button", { name: "패널 닫기", exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("session-list-mobile-dark.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(select(page)).toBeFocused();
  expect(gateway.detailCalls).toHaveLength(1);
});
