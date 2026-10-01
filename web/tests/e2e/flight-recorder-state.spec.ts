import { expect, type Locator, type Page } from "@playwright/test";
import {
  test,
  recorder,
  sessionAccount,
  sessionA,
  sessionB,
  sessionList,
  type FlightRecorderGateway,
} from "./fixtures/flight-recorder-state";

// Synthetic HTTP, real Auth/FeatureRoute/Router/Query/Sheet and native downloads.
// These tests do not prove Go team scope, full-session completeness, atomic
// permission revocation or removal of all PII from cached DTOs / existing CSV cells.
// Query.fetch/captured React callback and same-clock generations have unit tests;
// clicking a detached DOM node is deliberately not used as their substitute.
const path = "/app/observability/sessions";
const description = "목록 기간과 별개인 세션의 제한된 최근 요청을 보여줍니다.";
const dialog = (page: Page) => page.getByRole("dialog", { name: "세션 비행기록", exact: true });
const retry = (page: Page) => dialog(page).getByRole("button", { name: "비행기록 다시 조회", exact: true });
const csv = (page: Page) => dialog(page).getByRole("button", { name: "CSV 내보내기", exact: true });
const select = (page: Page, id = sessionA.session_id) =>
  page.getByRole("button", { name: `${id} 세션 비행기록 열기`, exact: true });
const failure = {
  status: 503,
  requestId: "public-flight-unavailable",
  body: { error: { message: "public synthetic recorder unavailable" } },
};
const columns = [
  "created_at",
  "request_id",
  "trace_id",
  "kind",
  "endpoint",
  "model",
  "provider",
  "status_code",
  "latency_ms",
  "total_tokens",
  "cost_krw",
  "tool_count",
  "secret_events",
  "policy_blocks",
  "code_risk",
];

async function enter(page: Page, target = path, mode: "session" | "legacy_token" | "open" = "session") {
  if (mode === "open") await page.goto(target);
  else {
    await page.goto(`login?return_to=${encodeURIComponent(target)}`);
    if (mode === "session") {
      await page.getByLabel("이메일", { exact: true }).fill(sessionAccount.email);
      await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
      await page.getByRole("button", { name: "로그인", exact: true }).click();
    } else {
      await page.getByLabel("기존 관리자 토큰", { exact: true }).fill("public-flight-legacy");
      await page.getByRole("button", { name: "콘솔 열기", exact: true }).click();
    }
  }
  await expect(page.getByRole("heading", { name: "세션 비행기록", exact: true }).first()).toBeAttached();
  if (!new URL(target, "http://fixture.invalid").searchParams.has("session_id"))
    await page.getByRole("combobox", { name: "자동 새로고침 간격", exact: true }).selectOption("0");
}
async function open(page: Page) {
  await select(page).click();
  await expect(dialog(page)).toBeVisible();
}
async function navigateSearch(page: Page, search: string) {
  await page.evaluate((value) => {
    history.pushState({}, "", `/app/observability/sessions${value}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, search);
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function nativeClick(button: Locator) {
  // Dispatch a real button click even when aria-disabled. The application
  // handler, not Playwright's actionability check, must refuse stale admission.
  await button.evaluate((node) => {
    if (!(node instanceof HTMLButtonElement)) throw new Error("Expected actual button");
    node.click();
  });
}
async function noDownload(page: Page, gateway: FlightRecorderGateway, expected = 0) {
  expect(gateway.downloads).toHaveLength(expected);
  const created = await page.evaluate(
    () =>
      (window as unknown as { __flightBlobEvidence: { created: string[] } }).__flightBlobEvidence.created
        .length,
  );
  expect(created).toBe(expected);
}
async function downloadCsv(page: Page, gateway: FlightRecorderGateway) {
  const before = gateway.downloads.length;
  const pending = page.waitForEvent("download");
  await csv(page).click();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  const stream = await download.createReadStream();
  const chunks: Uint8Array[] = [];
  for await (const value of stream) {
    const chunk: unknown = value;
    if (!(chunk instanceof Uint8Array)) throw new Error("Expected native download bytes");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  expect(text.split("\r\n")[0]).toBe(`\uFEFF${columns.join(",")}`);
  expect(gateway.downloads).toHaveLength(before + 1);
  const evidence = await page.evaluate(
    () =>
      (window as unknown as { __flightBlobEvidence: { created: string[]; nativeBlobs: boolean[] } })
        .__flightBlobEvidence,
  );
  expect(evidence.created).toHaveLength(before + 1);
  expect(evidence.nativeBlobs.every(Boolean)).toBe(true);
  // Do not freeze a filename choice here; existing CSV fields remain unchanged.
  return text;
}

for (const masked of [false, true]) {
  test(`${masked ? "마스킹 표시 ID" : "일반 동일 ID"}의 현재 정상 응답은 실제 15열 CSV로 내려받는다`, async ({
    page,
    gateway,
  }) => {
    const target = masked ? "public-reader@example.invalid" : sessionA.session_id;
    const display = masked ? "[REDACTED_EMAIL]" : target;
    const body = recorder(display, { model: "=SUM(1,2)", provider: '공개 "공급자"\n둘째 줄' });
    gateway.target(target, { body: { ...body, raw_extension: "public-extra-not-exported" } });
    await enter(page, `${path}?session_id=${encodeURIComponent(target)}`);
    await expect(dialog(page).getByText(display, { exact: true })).toBeVisible();
    await expect(dialog(page).getByText("public-flight-request", { exact: true })).toBeVisible();
    const text = await downloadCsv(page, gateway);
    expect(text).toContain('"\'=SUM(1,2)"');
    expect(text).toContain('"공개 ""공급자""\n둘째 줄"');
    expect(text).not.toContain("public-preview-not-a-csv-column");
    expect(text).not.toContain("public-extra-not-exported");
    expect(gateway.detailCalls).toHaveLength(1);
    expect(decodeURIComponent(gateway.detailCalls[0]?.url.pathname ?? "")).toBe(
      `/admin/sessions/${target}/flight-recorder`,
    );
    expect(gateway.detailCalls[0]?.url.search).toBe("");
    expect(gateway.detailCalls[0]?.headers["x-vibe-route"]).toBe("observability.sessions.flight-recorder");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const value = (
            window as unknown as { __flightBlobEvidence: { created: string[]; revoked: string[] } }
          ).__flightBlobEvidence;
          return value.revoked.includes(value.created[0] ?? "");
        }),
      )
      .toBe(true);
  });
}

test("명시 재조회 보류·실패는 이전 DOM과 초점을 유지하고 CSV를 잠근 뒤 새 성공에서 복구한다", async ({
  page,
  gateway,
}) => {
  await enter(page);
  await open(page);
  const old = dialog(page).getByText("public-flight-request", { exact: true });
  await expect(old).toBeVisible();
  const oldNode = await old.elementHandle();
  if (!oldNode) throw new Error("Expected initial recorder row");
  // Baseline reaches a genuine successful old-product recorder first.
  await expect(retry(page)).toBeVisible();
  gateway.reply(2, failure);
  gateway.hold(2);
  await retry(page).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => gateway.detailCalls.length).toBe(2);
  await expect(retry(page)).toBeFocused();
  await expect(retry(page)).toHaveAttribute("aria-disabled", "true");
  await expect(dialog(page)).toContainText("이전 응답을 표시합니다.");
  expect(await old.evaluate((node, previous) => node === previous, oldNode)).toBe(true);
  await page.keyboard.press("Enter");
  await nativeClick(retry(page));
  await nativeClick(retry(page));
  expect(gateway.detailCalls).toHaveLength(2);
  await expect(csv(page)).toHaveAttribute("aria-disabled", "true");
  await nativeClick(csv(page));
  await noDownload(page, gateway);
  gateway.release(2);
  await expect(dialog(page)).toContainText("비행기록을 갱신하지 못했습니다.");
  await expect(dialog(page)).toContainText("public-flight-unavailable");
  await expect(old).toBeVisible();
  expect(await old.evaluate((node, previous) => node === previous, oldNode)).toBe(true);
  await expect(retry(page)).toBeFocused();
  await nativeClick(csv(page));
  await noDownload(page, gateway);
  gateway.reply(3, { body: recorder(sessionA.session_id, { request_id: "public-flight-fresh" }) });
  await page.keyboard.press("Enter");
  await expect(dialog(page).getByText("public-flight-fresh", { exact: true })).toBeVisible();
  expect(gateway.detailCalls).toHaveLength(3);
  const text = await downloadCsv(page, gateway);
  expect(text).toContain("public-flight-fresh");
  expect(text).not.toContain("public-flight-request");
});

for (const mode of ["legacy_token", "open"] as const) {
  test(`${mode === "open" ? "인증 비활성" : "읽기 전용 기존 토큰"}도 현재 상세의 재조회와 CSV만 수행한다`, async ({
    page,
    gateway,
  }) => {
    gateway.authMode(mode);
    await enter(page, path, mode);
    await open(page);
    await expect(csv(page)).toBeVisible();
    await retry(page).click();
    await expect.poll(() => gateway.detailCalls.length).toBe(2);
    await expect(csv(page)).toBeEnabled();
    expect(await downloadCsv(page, gateway)).toContain("public-flight-request");
  });
}

test("첫 실패는 자동 재시도 없이 수동 조회를 기다리고 정상 빈 응답과 구분한다", async ({ page, gateway }) => {
  await page.clock.install();
  gateway.target(sessionA.session_id, failure);
  await enter(page);
  await open(page);
  await expect(dialog(page)).toContainText("비행기록을 불러오지 못했습니다.");
  await expect(dialog(page)).not.toContainText("이 응답에서 확인할 기록이 없습니다.");
  await expect(csv(page)).toBeHidden();
  // Browser timers advance, but HTTP/auth/router remain real.
  await page.clock.runFor(2100);
  expect(gateway.detailCalls).toHaveLength(1);
  await noDownload(page, gateway);
  gateway.target(sessionA.session_id, {
    body: recorder(sessionA.session_id, { request_id: "public-first-error-recovered" }),
  });
  gateway.hold(2);
  const oldButton = await retry(page).elementHandle();
  if (!oldButton) throw new Error("Expected initial error retry action");
  await retry(page).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => gateway.detailCalls.length).toBe(2);
  await expect(retry(page)).toBeFocused();
  expect(await retry(page).evaluate((node, previous) => node === previous, oldButton)).toBe(true);
  await expect(retry(page)).toHaveAttribute("aria-busy", "true");
  await expect(retry(page)).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  await nativeClick(retry(page));
  expect(gateway.detailCalls).toHaveLength(2);
  await expect(csv(page)).toBeHidden();
  await noDownload(page, gateway);
  gateway.release(2);
  await expect(dialog(page)).toContainText("public-first-error-recovered");
  await expect(csv(page)).toBeEnabled();
  expect(gateway.detailCalls).toHaveLength(2);
  expect(await downloadCsv(page, gateway)).toContain("public-first-error-recovered");
});

test("404 상세는 전체 무기록을 단정하지 않고 수동 성공 뒤 CSV를 허용한다", async ({ page, gateway }) => {
  gateway.reply(1, { ...failure, status: 404, requestId: "public-flight-not-found" });
  await enter(page, `${path}?session_id=public-outside-session`);
  await expect(dialog(page)).toContainText("비행기록을 불러오지 못했습니다.");
  await expect(dialog(page)).not.toContainText("요청이 아직 없습니다");
  await expect(csv(page)).toBeHidden();
  await noDownload(page, gateway);
  await retry(page).click();
  await expect(csv(page)).toBeEnabled();
  expect(await downloadCsv(page, gateway)).toContain("public-flight-request");
  expect(gateway.detailCalls).toHaveLength(2);
});

test("창 가시성 복구는 오래된 상세를 자동 재조회하지 않고 명시 버튼만 새 GET을 보낸다", async ({
  page,
  gateway,
}) => {
  await page.clock.install();
  await enter(page);
  await open(page);
  await expect(csv(page)).toBeEnabled();
  await page.clock.fastForward(31_000);
  await runtime(page);
  await page.clock.runFor(100);
  expect(gateway.detailCalls).toHaveLength(1);
  await retry(page).click();
  await expect.poll(() => gateway.detailCalls.length).toBe(2);
  await expect(csv(page)).toBeEnabled();
  expect(await downloadCsv(page, gateway)).toContain("public-flight-request");
});

test("대상 A→B→A에서 늦은 A 응답은 새 A 기록이나 CSV를 덮어쓰지 않는다", async ({ page, gateway }) => {
  await enter(page);
  await open(page);
  await expect(csv(page)).toBeEnabled();
  gateway.reply(2, { body: recorder(sessionA.session_id, { request_id: "public-retired-alpha" }) });
  gateway.hold(2);
  await retry(page).click();
  await expect.poll(() => gateway.detailCalls.length).toBe(2);
  gateway.reply(3, { body: recorder(sessionB.session_id, { request_id: "public-current-beta" }) });
  await navigateSearch(page, `?session_id=${sessionB.session_id}`);
  await expect(dialog(page)).toContainText("public-current-beta");
  gateway.reply(4, { body: recorder(sessionA.session_id, { request_id: "public-new-alpha" }) });
  await page.goBack();
  await expect(dialog(page)).toContainText("public-new-alpha");
  gateway.release(2);
  await expect.poll(() => gateway.finished.includes(2)).toBe(true);
  await expect(dialog(page)).not.toContainText("public-retired-alpha");
  expect(gateway.detailCalls).toHaveLength(4);
  const text = await downloadCsv(page, gateway);
  expect(text).toContain("public-new-alpha");
  expect(text).not.toContain("public-retired-alpha");
});

test("닫고 같은 세션을 다시 열면 이전 조회 수명을 재사용하지 않는다", async ({ page, gateway }) => {
  await enter(page);
  await open(page);
  await expect(csv(page)).toBeEnabled();
  gateway.reply(2, { body: recorder(sessionA.session_id, { request_id: "public-closed-lifetime" }) });
  gateway.hold(2);
  await retry(page).click();
  await expect.poll(() => gateway.detailCalls.length).toBe(2);
  await page.keyboard.press("Escape");
  await expect(select(page)).toBeFocused();
  gateway.reply(3, { body: recorder(sessionA.session_id, { request_id: "public-reopened-lifetime" }) });
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toContainText("public-reopened-lifetime");
  gateway.release(2);
  await expect.poll(() => gateway.finished.includes(2)).toBe(true);
  await expect(dialog(page)).not.toContainText("public-closed-lifetime");
  expect(gateway.detailCalls).toHaveLength(3);
  const text = await downloadCsv(page, gateway);
  expect(text).toContain("public-reopened-lifetime");
  expect(text).not.toContain("public-closed-lifetime");
});

for (const boundary of ["사용자", "팀"] as const) {
  test(`${boundary} A→B→A의 같은 상세 주소는 이전 권한의 늦은 응답을 재사용하지 않는다`, async ({
    page,
    gateway,
  }) => {
    gateway.reply(1, { body: recorder(sessionA.session_id, { request_id: "public-retired-owner" }) });
    gateway.hold(1);
    await enter(page, `${path}?session_id=${sessionA.session_id}`);
    await expect.poll(() => gateway.detailCalls.length).toBe(1);
    gateway.reply(2, { body: recorder(sessionA.session_id, { request_id: "public-current-owner" }) });
    if (boundary === "사용자") gateway.owner("public-second-reader");
    else gateway.team("public-second-team");
    await runtime(page);
    await expect(dialog(page)).toContainText("public-current-owner");
    gateway.reply(3, { body: recorder(sessionA.session_id, { request_id: "public-restored-owner" }) });
    if (boundary === "사용자") gateway.owner(sessionAccount.id);
    else gateway.team(sessionAccount.team_id);
    await runtime(page);
    await expect(dialog(page)).toContainText("public-restored-owner");
    gateway.release(1);
    await expect.poll(() => gateway.finished.includes(1)).toBe(true);
    await expect(dialog(page)).not.toContainText("public-retired-owner");
    await noDownload(page, gateway);
    expect(gateway.detailCalls).toHaveLength(3);
    const text = await downloadCsv(page, gateway);
    expect(text).toContain("public-restored-owner");
    expect(text).not.toContain("public-retired-owner");
  });
}

test("현재 읽기 권한 회수는 열린 CSV를 제거하고 권한 복구 뒤 새 응답만 허용한다", async ({
  page,
  gateway,
}) => {
  await enter(page, `${path}?session_id=${sessionA.session_id}`);
  await expect(csv(page)).toBeEnabled();
  gateway.readable(false);
  await runtime(page);
  await expect(
    page.getByRole("heading", { name: "세션 목록 조회 권한을 확인하세요.", exact: true }),
  ).toBeVisible();
  await expect(dialog(page)).toBeHidden();
  await noDownload(page, gateway);
  expect(gateway.detailCalls).toHaveLength(1);
  gateway.reply(2, { body: recorder(sessionA.session_id, { request_id: "public-restored-read" }) });
  gateway.readable(true);
  await runtime(page);
  await expect(dialog(page)).toContainText("public-restored-read");
  expect(gateway.detailCalls).toHaveLength(2);
  expect(await downloadCsv(page, gateway)).toContain("public-restored-read");
});

test("다른 탭 로그아웃 뒤 늦은 응답은 새 로그인 상세와 CSV를 복원하지 않는다", async ({
  page,
  context,
  gateway,
}) => {
  await enter(page);
  const other = await context.newPage();
  await enter(other);
  gateway.reply(1, { body: recorder(sessionA.session_id, { request_id: "public-old-epoch" }) });
  gateway.hold(1);
  await open(page);
  await expect.poll(() => gateway.detailCalls.length).toBe(1);
  await other.getByLabel("사용자 메뉴", { exact: true }).click();
  await other.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect.poll(gateway.logouts).toBe(1);
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await expect(dialog(page)).toBeHidden();
  await noDownload(page, gateway);
  gateway.reply(2, { body: recorder(sessionA.session_id, { request_id: "public-new-epoch" }) });
  // Use the actual redirected login form, preserving this document's auth epoch.
  await page.getByLabel("이메일", { exact: true }).fill(sessionAccount.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/observability\/sessions(?:\?|$)/u);
  if (!new URL(page.url()).searchParams.has("session_id")) await open(page);
  await expect(dialog(page)).toContainText("public-new-epoch");
  gateway.release(1);
  await expect.poll(() => gateway.finished.includes(1)).toBe(true);
  await expect(dialog(page)).not.toContainText("public-old-epoch");
  expect(await downloadCsv(page, gateway)).toContain("public-new-epoch");
  expect(gateway.detailCalls).toHaveLength(2);
});

test("목록 기간·검색과 실패는 열린 상세 DOM·CSV 기준을 바꾸거나 추가 GET하지 않는다", async ({
  page,
  gateway,
}) => {
  await enter(page);
  await open(page);
  await expect(csv(page)).toBeEnabled();
  const old = await dialog(page).getByText("public-flight-request", { exact: true }).elementHandle();
  if (!old) throw new Error("Expected initial record");
  gateway.period(30, failure);
  await navigateSearch(page, `?days=30&q=목록불일치&session_id=${sessionA.session_id}`);
  await expect(
    page.getByRole("alert", { includeHidden: true }).filter({ hasText: "public-flight-unavailable" }),
  ).toBeAttached();
  expect(
    await dialog(page)
      .getByText("public-flight-request", { exact: true })
      .evaluate((node, previous) => node === previous, old),
  ).toBe(true);
  expect(gateway.detailCalls).toHaveLength(1);
  expect(gateway.detailCalls[0]?.url.search).toBe("");
  expect(await downloadCsv(page, gateway)).toContain("public-flight-request");
});

test("200개 목록 밖의 직접 상세는 목록 오류와 별개로 현재 CSV를 제공한다", async ({ page, gateway }) => {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    ...sessionA,
    session_id: `public-listed-${index}`,
  }));
  gateway.period(7, { body: sessionList(7, rows) });
  const id = "public-outside-flight-session";
  await enter(page, `${path}?session_id=${id}`);
  await expect(csv(page)).toBeEnabled();
  expect(rows.some((row) => row.session_id === id)).toBe(false);
  expect(await downloadCsv(page, gateway)).toContain("public-flight-request");
  gateway.period(30, failure);
  await navigateSearch(page, `?days=30&session_id=${id}`);
  await expect(
    page.getByRole("alert", { includeHidden: true }).filter({ hasText: "public-flight-unavailable" }),
  ).toBeAttached();
  expect(gateway.detailCalls).toHaveLength(1);
  expect(await downloadCsv(page, gateway)).toContain("public-flight-request");
});

for (const verdict of ["", "미지원 판정"]) {
  test(`${verdict ? "알 수 없는" : "빈"} 판정은 중립으로 알리고 오래된 서버 note를 복창하지 않는다`, async ({
    page,
    gateway,
  }) => {
    const body = recorder();
    body.summary.verdict = verdict;
    gateway.reply(1, { body });
    await enter(page, `${path}?session_id=${sessionA.session_id}`);
    const unknown = dialog(page).getByRole("status").filter({ hasText: "판정 확인 불가" });
    await expect(unknown).toBeVisible();
    await expect(unknown).toHaveClass(/inline-notice-info/u);
    await expect(dialog(page)).toContainText(description);
    await expect(dialog(page)).not.toContainText(body.note);
    await expect(dialog(page).getByText("공급자", { exact: true })).toBeVisible();
    await expect(dialog(page).getByText("첫 기록 시각", { exact: true })).toBeVisible();
    await expect(dialog(page).getByText("마지막 기록 시각", { exact: true })).toBeVisible();
    expect(await downloadCsv(page, gateway)).toContain("public-flight-request");
  });
}

for (const empty of ["빈 배열", "누락 배열"] as const) {
  test(`${empty} 응답은 이번 응답의 기록 없음만 설명하고 CSV를 만들지 않는다`, async ({ page, gateway }) => {
    const body = recorder();
    gateway.reply(1, { body: { ...body, events: empty === "빈 배열" ? [] : undefined } });
    await enter(page, `${path}?session_id=${sessionA.session_id}`);
    await expect(dialog(page)).toContainText("이 응답에서 확인할 기록이 없습니다.");
    await expect(dialog(page)).not.toContainText("요청이 아직 없습니다");
    await expect(dialog(page)).not.toContainText(body.note);
    await nativeClick(csv(page));
    await noDownload(page, gateway);
  });
}

test("현재 설정의 인증정보 접두사를 담은 오류 ID는 안내에 재노출하지 않는다", async ({ page, gateway }) => {
  await enter(page);
  gateway.prefixes(["custom_flight_"]);
  await runtime(page);
  const marker = `custom_flight_${"z".repeat(32)}`;
  gateway.reply(1, { ...failure, requestId: marker });
  await open(page);
  await expect(dialog(page)).toContainText("비행기록을 불러오지 못했습니다.");
  await expect(dialog(page)).not.toContainText(marker);
  expect(await dialog(page).evaluate((node) => node.outerHTML)).not.toContain(marker);
  await retry(page).click();
  await expect(csv(page)).toBeEnabled();
  expect(await downloadCsv(page, gateway)).toContain("public-flight-request");
});

test("390px 다크 상세의 긴 한글은 실제 스크롤·키보드 재조회·Escape 복귀와 접근성을 유지한다", async ({
  page,
  gateway,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const body = recorder(sessionA.session_id, {
    model: "긴한글모델".repeat(30),
    provider: "긴한글공급자".repeat(30),
  });
  body.summary.headline = "긴 공개 한글 요약 ".repeat(20);
  const event = body.events[0];
  if (!event) throw new Error("Expected synthetic initial event");
  body.events = Array.from({ length: 15 }, (_, index) => ({
    ...event,
    request_id: `public-long-record-${index}`,
  }));
  gateway.target(sessionA.session_id, { body });
  await enter(page);
  // Set the real header refresh control before its responsive mobile hiding.
  // Every detail interaction and assertion below still runs at 390px.
  await page.setViewportSize({ width: 390, height: 780 });
  await select(page).focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page).getByText("public-long-record-0", { exact: true })).toBeAttached();
  await expect(dialog(page).getByRole("button", { name: "패널 닫기", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const scroll = dialog(page).locator(".sheet-body");
  expect(await scroll.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  expect(await scroll.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await scroll.hover();
  await page.mouse.wheel(0, 900);
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await retry(page).focus();
  gateway.hold(2);
  await page.keyboard.press("Enter");
  await expect.poll(() => gateway.detailCalls.length).toBe(2);
  await expect(retry(page)).toBeFocused();
  await page.keyboard.press("Enter");
  expect(gateway.detailCalls).toHaveLength(2);
  await noDownload(page, gateway);
  gateway.release(2);
  await expect(csv(page)).toBeEnabled();
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
    ).axe;
    return (await axe.run(document)).violations.map((item) => item.id);
  });
  expect(violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("flight-recorder-mobile-dark.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(select(page)).toBeFocused();
});
