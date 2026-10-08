import { expect, type Page } from "@playwright/test";
import {
  feedbackPath,
  loginEmail,
  notePath,
  replacement,
  requestA,
  requestB,
  targetUrl,
  test,
  type LLMReadOwnerGateway,
} from "../fixtures/llm-read-owner-gateway";

// Actual browser AuthProvider/ApiClient plus synthetic HTTP; not Go/IdP/SQL proof.
// Do not run until the root's frozen build and pinned-browser signal are ready.
// Principal replacement is conservative ownership coverage, not a claim that an
// ordinary server refresh changes the authenticated subject.
const detail = (page: Page) => page.getByRole("dialog", { name: "LLM 호출 상세", exact: true });
const editor = (page: Page) => page.getByRole("dialog", { name: "요청 메모·태그 수정", exact: true });
const save = (page: Page) => editor(page).getByRole("button", { name: "메모·태그 저장", exact: true });
const refresh = (page: Page) => page.getByRole("button", { name: "새로고침", exact: true });
const noteRefresh = (page: Page) =>
  editor(page).getByRole("button", { name: "현재 메모·태그 다시 조회", exact: true });
const count = (gateway: LLMReadOwnerGateway, method: string, path?: string) =>
  gateway.calls.filter((call) => call.method === method && (!path || call.path === path)).length;

async function login(page: Page) {
  await page.goto(`login?return_to=${encodeURIComponent(targetUrl)}`);
  await page.getByLabel("이메일", { exact: true }).fill(loginEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "LLM 관측", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `${requestA} 호출 상세 열기`, exact: true })).toBeVisible();
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
  await expect(interval).toHaveValue("0");
}
async function showNote(page: Page, id = requestA) {
  await page.getByRole("button", { name: `${id} 호출 상세 열기`, exact: true }).click();
  await page.getByRole("button", { name: "원인 설명 열기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "운영 메모·태그", exact: true })).toBeVisible();
}
async function editNote(page: Page) {
  await showNote(page);
  await page.getByRole("button", { name: "메모·태그 수정", exact: true }).click();
  await editor(page).getByLabel("메모 변경 방법", { exact: true }).selectOption("replace");
  await editor(page).getByLabel("새 메모", { exact: true }).fill(replacement);
}
async function refreshBootstrap(page: Page) {
  const receipt = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admin/ui-bootstrap" && response.status() === 200,
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await receipt).finished();
}
async function absentServerData(page: Page, markers: readonly string[]) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(async () => {
      const html = await page.locator("body").innerHTML();
      return markers.some((marker) => html.includes(marker));
    })
    .toBe(false);
}
async function noStoredDraft(page: Page) {
  expect(
    await page.evaluate(
      (text) =>
        [localStorage, sessionStorage].every((storage) =>
          Object.values(storage).every((value) => !String(value).includes(text)),
        ),
      replacement,
    ),
  ).toBe(true);
  expect(page.url()).not.toContain(encodeURIComponent(replacement));
}
async function noDraftInputs(page: Page) {
  expect(
    await page
      .locator("input,textarea")
      .evaluateAll(
        (elements, text) =>
          elements.some((element) =>
            (element as HTMLInputElement | HTMLTextAreaElement).value.includes(text),
          ),
        replacement,
      ),
  ).toBe(false);
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

test.afterEach(async ({ gateway }, testInfo) => {
  await testInfo.attach("synthetic-llm-request-counts", {
    contentType: "application/json",
    body: JSON.stringify({ calls: gateway.calls, writeAttempts: gateway.writes.length }),
  });
});

for (const transition of ["role", "principal", "team"] as const) {
  test(`같은 브라우저 세대의 ${transition} 변경은 이전 목록·상세·메모를 다시 표시하지 않는다`, async ({
    page,
    gateway,
  }) => {
    if (transition === "team") gateway.configure({ role: "team_admin", writable: false });
    await login(page);
    const old = gateway.markers();
    await expect(page.getByText(old[0], { exact: true })).toBeVisible();
    await showNote(page);
    await expect(detail(page)).toContainText(old[1]);
    await expect(detail(page)).toContainText(old[2]);
    gateway.transition(transition);
    await refreshBootstrap(page);
    await absentServerData(page, old);
    const id = transition === "team" ? requestB : requestA;
    await page.getByRole("button", { name: `${id} 호출 상세 열기`, exact: true }).click();
    await page.getByRole("button", { name: "원인 설명 열기", exact: true }).click();
    for (const marker of old) await expect(detail(page)).not.toContainText(marker);
    if (transition === "role") await expect(detail(page)).toContainText("[REDACTED_EMAIL]");
    if (transition === "team") await expect(detail(page)).toContainText(requestB);
    expect(gateway.writes).toEqual([]);
    expect(count(gateway, "POST", "/auth/refresh")).toBe(1);
  });
}

test("390px 다크 화면에서 note403 뒤 명시적 새 조회·계속 편집만 초안을 복구하며 키보드와 초점을 유지한다", async ({
  page,
  gateway,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);
  const old = gateway.markers();
  await editNote(page);
  const bootstraps = count(gateway, "GET", "/admin/ui-bootstrap");
  gateway.denyNextNote();
  const denial = page.waitForResponse(
    (response) => new URL(response.url()).pathname === notePath && response.status() === 403,
  );
  await noteRefresh(page).focus();
  await page.keyboard.press("Enter");
  await (await denial).finished();
  await expect(page.getByText("조회 권한을 다시 확인하세요.", { exact: true })).toBeVisible();
  await absentServerData(page, old);
  await noDraftInputs(page);
  await noStoredDraft(page);
  expect(gateway.writes).toEqual([]);
  expect(count(gateway, "GET", "/admin/ui-bootstrap")).toBe(bootstraps);
  expect(count(gateway, "POST", "/auth/refresh")).toBe(1);
  await expect(refresh(page)).toBeFocused();
  await noOverflow(page);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (root: Document) => Promise<{ violations: Array<{ id: string; impact: string | null }> }>;
        };
      }
    ).axe;
    return (await axe.run(document)).violations.map(({ id, impact }) => ({ id, impact }));
  });
  expect(violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("llm-terminal-denial-mobile-dark.png"), fullPage: true });

  gateway.restoreAccess();
  await page.keyboard.press("Enter"); // Current focused, visible manual refresh action.
  await expect(page.getByRole("button", { name: `${requestA} 호출 상세 열기`, exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await noDraftInputs(page);
  const noteReads = count(gateway, "GET", notePath);
  gateway.holdNotes();
  await page.getByRole("button", { name: `${requestA} 호출 상세 열기`, exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "원인 설명 열기", exact: true }).focus();
  await page.keyboard.press("Enter");
  const confirmation = page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" });
  await confirmation.getByRole("button", { name: "계속 편집", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(editor(page).getByLabel("새 메모", { exact: true })).toHaveValue(replacement);
  await expect(editor(page).getByLabel("메모 변경 방법", { exact: true })).toHaveValue("replace");
  await expect(save(page)).toBeDisabled();
  await expect(editor(page)).not.toContainText(old[2]);
  await expect(editor(page)).not.toContainText(gateway.noteValue());
  await expect.poll(() => count(gateway, "GET", notePath)).toBeGreaterThan(noteReads);
  gateway.releaseNotes();
  await expect(editor(page)).toContainText(`재조회한 메모: ${gateway.noteValue()}`);
  await expect(editor(page).getByLabel("새 메모", { exact: true })).toHaveValue(replacement);
  await expect(save(page)).toBeEnabled();
  expect(gateway.writes).toEqual([]);
  await noStoredDraft(page);
  await noOverflow(page);
});

test("전송 중 피드백은 현재 읽기401 뒤 늦은 성공에서 토스트·재전송·추가 조회를 만들지 않는다", async ({
  page,
  gateway,
}) => {
  // Custom role can lose admin:read while keeping admin:write. Its already-open
  // bootstrap remains unchanged until a later bootstrap, despite token refresh.
  gateway.configure({ role: "public_llm_operator", writable: true });
  await page.clock.install({ time: Date.parse("2026-10-08T09:00:00Z") });
  await login(page);
  await page.getByLabel("자동 새로고침 간격").selectOption("60");
  await page.getByRole("button", { name: `${requestA} 호출 상세 열기`, exact: true }).click();
  await page.getByRole("button", { name: "피드백 남기기", exact: true }).click();
  const form = page.getByRole("dialog", { name: "피드백 남기기", exact: true });
  await form.getByLabel("의견", { exact: true }).fill(replacement);
  gateway.holdFeedback();
  await form.getByRole("button", { name: "등록", exact: true }).click();
  await expect.poll(() => gateway.writes.length).toBe(1);
  gateway.revokeBackendRead();
  await page.clock.runFor(61_000); // Existing operator-selected background read.
  await expect(page.getByText("조회 권한을 다시 확인하세요.", { exact: true })).toBeVisible();
  await expect(form).toHaveCount(0);
  await noDraftInputs(page);
  const getCount = count(gateway, "GET");
  gateway.releaseFeedback();
  await expect.poll(gateway.feedbackReceipts).toBe(1);
  await page.clock.runFor(1_000);
  await expect(page.getByText("피드백을 등록했습니다.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("피드백을 등록하지 못했습니다.", { exact: true })).toHaveCount(0);
  expect(count(gateway, "GET")).toBe(getCount);
  expect(count(gateway, "POST", feedbackPath)).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await noStoredDraft(page);
});

test("일반503과 쓰기 전용 제한은 같은 소유자의 초안을 지우지 않고 무단 저장만 막는다", async ({
  page,
  gateway,
}) => {
  gateway.configure({ role: "public_llm_operator", writable: true });
  await login(page);
  await editNote(page);
  gateway.setNoteStatus(503);
  await noteRefresh(page).click();
  await expect
    .poll(() => gateway.calls.filter((call) => call.path === notePath && call.status === 503).length)
    .toBeGreaterThan(0);
  await expect(editor(page).getByLabel("새 메모", { exact: true })).toHaveValue(replacement);
  await expect(page.getByText("조회 권한을 다시 확인하세요.", { exact: true })).toHaveCount(0);
  gateway.setNoteStatus(200);
  await expect(noteRefresh(page)).toBeEnabled();
  await noteRefresh(page).click();
  await expect(save(page)).toBeEnabled();
  for (const restriction of ["scope", "feature"] as const) {
    if (restriction === "scope") gateway.setWritable(false);
    else gateway.setReadOnly(true);
    await refreshBootstrap(page);
    await expect(editor(page).getByLabel("새 메모", { exact: true })).toHaveValue(replacement);
    await expect(editor(page).getByLabel("새 메모", { exact: true })).toBeDisabled();
    await expect(save(page)).toBeDisabled();
    await editor(page)
      .locator("form")
      .evaluate((element) => (element as HTMLFormElement).requestSubmit());
    expect(gateway.writes).toEqual([]);
    if (restriction === "scope") gateway.setWritable(true);
    else gateway.setReadOnly(false);
    await refreshBootstrap(page);
    await expect(editor(page).getByLabel("새 메모", { exact: true })).toHaveValue(replacement);
    await expect(save(page)).toBeEnabled();
  }
  expect(gateway.writes).toEqual([]);
});
