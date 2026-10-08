import { expect, type Page } from "@playwright/test";
import { firstEmail, firstId, initial, xviewUrl } from "../fixtures/request-note-gateway";
import { cursor, livePoint, serverStart, test } from "../fixtures/xview-live-gateway";

async function login(page: Page, suffix = "?window=5m") {
  await page.goto(`login?return_to=${encodeURIComponent(xviewUrl + suffix)}`);
  await page.getByLabel("이메일", { exact: true }).fill(firstEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "XView 실시간", exact: true })).toBeVisible();
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
  // On mobile this control is hidden; a fresh profile still starts with polling opt-in (0).
  await expect(interval).toHaveValue("0");
  await expect(page.getByRole("img", { name: /산점도/u })).toBeVisible();
  await expect(page.getByText(/^마지막 응답 확인/u)).toBeVisible();
}
const summary = (page: Page) => page.getByRole("region", { name: "지금 확인할 신호" });
const selection = (page: Page) => page.getByRole("dialog", { name: /^선택한 요청/u });
const deltas = (calls: URL[]) => calls.filter((url) => url.pathname === "/admin/xview/delta");

test.afterEach(async ({ liveGateway }, testInfo) => {
  await testInfo.attach("synthetic-xview-get-sequence", {
    contentType: "application/json",
    body: JSON.stringify(
      liveGateway.calls.map((url) => ({ path: url.pathname, query: [...url.searchParams] })),
    ),
  });
});

test("masked 읽기와 표시점 P95를 유지하며 빈 응답도 확인 시각을 갱신한다", async ({ page, liveGateway }) => {
  await page.clock.install({ time: serverStart + 8 * 3_600_000 });
  liveGateway.points = Array.from({ length: 20 }, (_, i) =>
    livePoint(`public-${i}`, serverStart - 30_000, i + 1),
  );
  await login(page);
  await expect(summary(page)).toContainText("19ms");
  const receipt = page.getByText(/^마지막 응답 확인/u);
  const before = await receipt.getAttribute("title");
  await page.clock.runFor(1_600);
  await expect(receipt).not.toHaveAttribute("title", before ?? "");
  expect(deltas(liveGateway.calls)).toHaveLength(1);
  await expect(summary(page)).toContainText("19ms");
});

test("상대 구간 만료는 표시점만 제거하고 이미 선택한 원본과 초점을 보존한다", async ({
  page,
  liveGateway,
}) => {
  await page.clock.install({ time: serverStart + 8 * 3_600_000 });
  liveGateway.points = [livePoint(firstId, serverStart - 299_000), livePoint("note-request-two")];
  await login(page);
  const trigger = page.getByRole("button", { name: "최근 25건 선택", exact: true });
  await trigger.click();
  const original = selection(page);
  await expect(original).toHaveAccessibleName("선택한 요청 2건");
  liveGateway.serverTime = new Date(serverStart + 16_000).toISOString();
  await page.clock.runFor(16_000);
  await expect(original).toHaveAccessibleName("선택한 요청 2건");
  await original.getByRole("button", { name: "패널 닫기" }).click();
  await expect(summary(page).getByText("1", { exact: true })).toBeVisible();
  await expect(trigger).toBeFocused();
});

test("6,001번째 수신점은 최근 6,000건 제한을 숨기지 않는다", async ({ page, liveGateway }) => {
  await page.clock.install({ time: serverStart });
  liveGateway.points = Array.from({ length: 6_000 }, (_, i) =>
    livePoint(`public-${i}`, serverStart - 60_000 + i),
  );
  liveGateway.respond = () => ({
    points: [livePoint("public-new", serverStart)],
    cursor: { ingested_at: "2026-10-08T09:00:00.000000001Z", request_id: "public-new" },
  });
  await login(page);
  await page.clock.runFor(1_600);
  await expect(page.getByText("표본이 상한에 걸렸습니다.", { exact: true })).toBeVisible();
  await expect(summary(page).getByText("6,000", { exact: true })).toBeVisible();
});

test("정체 커서는 빠른 연속 조회를 멈추고 정상 간격으로만 확인한다", async ({ page, liveGateway }) => {
  await page.clock.install({ time: serverStart });
  liveGateway.respond = () => ({ has_more: true, cursor });
  await login(page);
  await page.clock.runFor(1_600);
  await expect.poll(() => deltas(liveGateway.calls).length).toBe(1);
  await expect(
    page.getByText("커서 진행을 확인할 수 없어 빠른 연속 조회를 멈췄습니다.", { exact: true }),
  ).toBeVisible();
  await page.clock.runFor(1_500);
  await expect.poll(() => deltas(liveGateway.calls).length).toBe(2);
});

test("서버 시각 미확인과 고정 종료 구간을 정직하게 안내한다", async ({ page, liveGateway }) => {
  await page.clock.install({ time: serverStart + 8 * 3_600_000 });
  liveGateway.serverTime = "";
  await login(page, "?from=2026-10-08T00%3A00&to=2026-10-09T00%3A00");
  await expect(page.getByText("서버 시각을 확인할 수 없습니다.", { exact: true })).toBeVisible();
  await expect(
    page.getByText("종료 시각이 정해진 구간입니다. 자동 조회를 하지 않습니다.", { exact: true }),
  ).toBeVisible();
  await page.clock.runFor(16_000);
  expect(deltas(liveGateway.calls)).toEqual([]);
  await expect(summary(page).getByText("2", { exact: true })).toBeVisible();
});

test("주기 보완과 메타데이터 재조회는 기존 GET 계약으로만 실행한다", async ({
  page,
  liveGateway,
  gateway,
}) => {
  await page.clock.install({ time: serverStart });
  await login(page);
  const first = page.waitForResponse((response) => new URL(response.url()).pathname === "/admin/xview/delta");
  await page.clock.runFor(1_600);
  await (await first).finished();
  const reconcile = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get("reconcile") === "true",
  );
  await page.clock.runFor(16_000);
  await (await reconcile).finished();
  const refresh = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get("refresh") === "true",
  );
  await page.clock.runFor(285_100);
  await (await refresh).finished();
  expect(deltas(liveGateway.calls).some((url) => url.searchParams.get("reconcile") === "true")).toBe(true);
  expect(deltas(liveGateway.calls).some((url) => url.searchParams.get("refresh") === "true")).toBe(true);
  expect(gateway.writes).toEqual([]);
});

for (const status of [401, 403]) {
  test(`최종 ${status}는 이전 선택을 폐기하고 명시적 조회로만 복구한다`, async ({ page, liveGateway }) => {
    await page.clock.install({ time: serverStart });
    await login(page);
    // No refresh token: exercise the actual ApiClient terminal-401 path.
    await page.evaluate(() => sessionStorage.removeItem("vibe.app.auth.refresh"));
    await page.reload();
    await expect(page.getByRole("button", { name: "최근 25건 선택" })).toBeEnabled();
    await page.getByRole("button", { name: "최근 25건 선택" }).click();
    liveGateway.deltaStatus = status;
    await page.clock.runFor(1_600);
    await expect(selection(page)).toBeHidden();
    await expect(page.getByText(/로그인 상태 또는 XView 조회 권한을 확인할 수 없습니다/u)).toBeVisible();
    const retry = page.getByRole("button", { name: "지금 새로고침", exact: true });
    await expect(retry).toBeFocused();
    const before = deltas(liveGateway.calls).length;
    liveGateway.snapshotStatus = 503;
    await retry.click();
    await expect(page.getByText("표시할 요청이 없습니다.", { exact: true })).toBeVisible();
    liveGateway.snapshotStatus = 200;
    liveGateway.deltaStatus = 200;
    liveGateway.points = [livePoint("public-fresh")];
    await retry.click();
    await expect(page.getByRole("button", { name: "최근 25건 선택" })).toBeEnabled();
    await expect(selection(page)).toBeHidden();
    await page.clock.runFor(5_000);
    expect(deltas(liveGateway.calls)).toHaveLength(before);
    await expect(page.getByText(/자동 조회가 중지되어 있습니다/u)).toBeVisible();
    await page.getByRole("button", { name: "최근 25건 선택" }).click();
    await expect(selection(page)).toContainText("public-fresh");
    await expect(selection(page)).not.toContainText(firstId);
  });
}

test("만료와 snapshot 503 뒤에도 열린 메모의 DOM·초안·폐기 확인을 유지한다", async ({
  page,
  liveGateway,
  gateway,
}) => {
  await page.clock.install({ time: serverStart });
  await login(page);
  await page.getByRole("button", { name: "최근 25건 선택" }).click();
  await page.getByRole("button", { name: `${firstId} 원인 설명 열기`, exact: true }).click();
  await page.getByRole("button", { name: "메모·태그 수정", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "요청 메모·태그 수정", exact: true });
  await editor.getByLabel("메모 변경 방법", { exact: true }).selectOption("replace");
  await editor.getByLabel("새 메모", { exact: true }).fill("보존할 합성 초안");
  await editor.evaluate((node) => node.setAttribute("data-lifetime-proof", "same-editor"));
  liveGateway.serverTime = new Date(serverStart + 360_000).toISOString();
  await page.clock.runFor(16_000);
  liveGateway.snapshotStatus = 503;
  // Direct parent callback boundary, not a claim that modal-inert controls are clickable.
  await page
    .getByRole("button", { name: "지금 새로고침", exact: true, includeHidden: true })
    .evaluate((node) => (node as HTMLButtonElement).click());
  await expect(editor).toHaveAttribute("data-lifetime-proof", "same-editor");
  await expect(editor.getByLabel("새 메모", { exact: true })).toHaveValue("보존할 합성 초안");
  const parent = page.getByRole("dialog", { name: "요청 원인 설명", exact: true, includeHidden: true });
  await parent
    .getByRole("button", { name: "패널 닫기", includeHidden: true })
    .evaluate((node) => (node as HTMLButtonElement).click());
  await page.getByRole("alertdialog").getByRole("button", { name: "계속 편집" }).click();
  await expect(editor.getByLabel("새 메모", { exact: true })).toHaveValue("보존할 합성 초안");
  expect(gateway.writes).toEqual([]);
});

test("390px 다크 화면에서 상태·키보드 선택·초점 복귀와 axe를 확인한다", async ({
  page,
  liveGateway,
}, testInfo) => {
  void liveGateway;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);
  await page.screenshot({ path: testInfo.outputPath("xview-live-mobile-dark.png"), fullPage: true });
  const trigger = page.getByRole("button", { name: "최근 25건 선택", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(selection(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as { axe: { run: (root: Document) => Promise<{ violations: unknown[] }> } }
    ).axe;
    return (await axe.run(document)).violations;
  });
  expect(violations).toEqual([]);
});

async function openDraft(page: Page) {
  await page.getByRole("button", { name: "최근 25건 선택" }).click();
  await page.getByRole("button", { name: `${firstId} 원인 설명 열기`, exact: true }).click();
  await page.getByRole("button", { name: "메모·태그 수정", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "요청 메모·태그 수정", exact: true });
  await editor.getByLabel("메모 변경 방법", { exact: true }).selectOption("replace");
  await editor.getByLabel("새 메모", { exact: true }).fill("권한 복구 후 이어 쓸 합성 초안");
  return editor;
}
async function reopenDraft(page: Page) {
  await page.getByRole("button", { name: "최근 25건 선택" }).click();
  await page.getByRole("button", { name: `${firstId} 원인 설명 열기`, exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "계속 편집" }).click();
  return page.getByRole("dialog", { name: "요청 메모·태그 수정", exact: true });
}

test("권한 거부 뒤 초안은 같은 요청에서 명시적으로 재개하고 새 메모 확인을 기다린다", async ({
  page,
  liveGateway,
  gateway,
}) => {
  await page.clock.install({ time: serverStart });
  await login(page);
  const original = await openDraft(page);
  liveGateway.deltaStatus = 403;
  await page.clock.runFor(1_600);
  await expect(original).toBeHidden();
  await expect(page.getByText(initial.note, { exact: false })).toHaveCount(0);
  liveGateway.deltaStatus = 200;
  await page.getByRole("button", { name: "지금 새로고침", exact: true }).click();
  await expect(original).toBeHidden();
  gateway.holdReads();
  gateway.replaceNote({ ...initial, note: "새로 확인한 합성 메모" });
  const resumed = await reopenDraft(page);
  await expect(resumed.getByLabel("새 메모", { exact: true })).toHaveValue("권한 복구 후 이어 쓸 합성 초안");
  const save = resumed.getByRole("button", { name: "메모·태그 저장", exact: true });
  await expect(save).toBeDisabled();
  await expect(resumed).not.toContainText(initial.note);
  gateway.releaseReads();
  await expect(resumed).toContainText("새로 확인한 합성 메모");
  await expect(save).toBeEnabled();
  await resumed.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "계속 편집" }).click();
  await expect(resumed.getByLabel("새 메모", { exact: true })).toHaveValue("권한 복구 후 이어 쓸 합성 초안");
  expect(gateway.writes).toEqual([]);
});

test("이미 보낸 메모의 늦은 성공은 자동 복귀·추가 조회·재전송을 만들지 않는다", async ({
  page,
  liveGateway,
  gateway,
}) => {
  await page.clock.install({ time: serverStart });
  await login(page);
  const original = await openDraft(page);
  gateway.holdWrites();
  await original.getByRole("button", { name: "메모·태그 저장", exact: true }).click();
  await expect.poll(() => gateway.writes.length).toBe(1);
  liveGateway.deltaStatus = 403;
  await page.clock.runFor(1_600);
  await expect(original).toBeHidden();
  const reads = gateway.reads();
  const completed = page.waitForResponse((response) => response.request().method() === "PATCH");
  gateway.releaseWrites();
  await (await completed).finished();
  await page.clock.runFor(100);
  await expect(page.getByText("요청 메모·태그를 저장했습니다.", { exact: true })).toHaveCount(0);
  expect(gateway.reads()).toBe(reads);
  liveGateway.deltaStatus = 200;
  await page.getByRole("button", { name: "지금 새로고침", exact: true }).click();
  const resumed = await reopenDraft(page);
  await expect(resumed).toContainText("이전에 보낸 저장 요청을 확인했습니다.");
  await expect(resumed.getByRole("button", { name: "메모·태그 저장", exact: true })).toBeDisabled();
  await resumed.locator("form").evaluate((node) => (node as HTMLFormElement).requestSubmit());
  expect(gateway.writes).toHaveLength(1);
});
