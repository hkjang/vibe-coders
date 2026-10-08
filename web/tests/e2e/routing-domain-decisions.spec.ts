import { expect, type Page } from "@playwright/test";
import {
  test,
  firstEmail,
  decisionsUrl,
  decisionRow,
  signalRow,
  reportFor,
  rawDecisionMarker,
} from "./fixtures/routing-domain-decisions";

const sectionFor = (page: Page) =>
  page
    .locator("section.section-card")
    .filter({ has: page.getByRole("heading", { name: "도메인 결정 로그", exact: true }) });
const tableFor = (page: Page) => page.getByRole("table", { name: "도메인 결정 로그", exact: true });
const dialogFor = (page: Page) => page.getByRole("dialog", { name: "도메인 결정 근거", exact: true });
async function login(page: Page, target = decisionsUrl) {
  await page.goto(`login?return_to=${encodeURIComponent(target)}`);
  await page.getByLabel("이메일", { exact: true }).fill(firstEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "학습 구간", exact: true })).toBeVisible();
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
}
async function open(page: Page) {
  const trigger = tableFor(page)
    .getByRole("button", { name: /결정 근거 보기$/u })
    .first();
  const triggerHandle = await trigger.elementHandle();
  await trigger.click();
  const dialog = dialogFor(page);
  await expect(dialog.getByRole("heading", { name: "선택한 결정 기록", exact: true })).toBeFocused();
  return { dialog, trigger, triggerHandle };
}
async function refreshIdentity(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}

test("최근 최대 50건 조회의 21번째 행은 추가 GET 없는 응답 내부 페이지에서 찾는다", async ({
  page,
  explorer,
}) => {
  explorer.setReport(reportFor(25));
  await login(page, `${decisionsUrl}?window=30d&route=public-route`);
  await expect(sectionFor(page)).toContainText("조회된 최근 25건");
  await expect(tableFor(page).getByRole("row")).toHaveCount(21);
  expect(explorer.reads().at(-1)?.query).toEqual({ window: "30d", route: "public-route", limit: "50" });
  const before = explorer.reads().length;
  await sectionFor(page).getByRole("button", { name: "다음 페이지", exact: true }).click();
  await expect(tableFor(page)).toContainText("공개 합성 결정 사유 21");
  await expect(tableFor(page).getByRole("row")).toHaveCount(6);
  expect(explorer.reads()).toHaveLength(before);
  expect(explorer.writes()).toEqual([]);
});

test("요청 ID는 명시적 적용으로 URL에 저장되고 새로 열어도 동일한 조건으로 복원된다", async ({
  page,
  explorer,
}) => {
  explorer.setReport(reportFor(25));
  await login(page, `${decisionsUrl}?window=30d&route=public-route`);
  await expect(tableFor(page)).toContainText("공개 합성 결정 사유 01");
  const input = sectionFor(page).getByRole("textbox", { name: "요청 ID", exact: true });
  const before = explorer.reads().length;
  await input.fill("req_public_21");
  expect(new URL(page.url()).searchParams.has("request_id")).toBe(false);
  expect(explorer.reads()).toHaveLength(before);
  await sectionFor(page).getByRole("button", { name: "결정 로그 조회", exact: true }).click();
  await expect(tableFor(page)).toContainText("공개 합성 결정 사유 21");
  await expect(tableFor(page).getByRole("row")).toHaveCount(2);
  expect(explorer.reads().at(-1)?.query).toEqual({
    window: "30d",
    route: "public-route",
    request_id: "req_public_21",
    limit: "50",
  });
  await page.reload();
  await expect(input).toHaveValue("req_public_21");
  await expect(tableFor(page)).toContainText("공개 합성 결정 사유 21");
  expect(explorer.writes()).toEqual([]);
});

test("결정 상세는 확률이 아닌 기록 점수와 후보 도구 및 원래 근거만 설명한다", async ({ page, explorer }) => {
  await login(page);
  const { dialog } = await open(page);
  await expect(dialog).toContainText("1.12");
  await expect(dialog).not.toContainText("112%");
  await expect(dialog).toContainText("후보 도구가 실제 호출되었다는 뜻은 아닙니다");
  await expect(dialog).toContainText("실제 실행 결과를 확정할 수 없습니다");
  await expect(dialog).toContainText(signalRow.reason);
  await expect(dialog).toContainText("선택한 목록 수신(한국 시각)");
  await expect(page.locator("body")).not.toContainText(rawDecisionMarker);
  expect(explorer.writes()).toEqual([]);
});

for (const mode of ["empty", "unconfirmed"] as const) {
  test(`근거 ${mode}는 없음과 조회 미확인을 구분한다`, async ({ page, explorer }) => {
    explorer.setReport({
      decisions: [decisionRow],
      signals: { [decisionRow.id]: mode === "empty" ? [] : null },
    });
    await login(page);
    const { dialog } = await open(page);
    await expect(dialog).toContainText(
      mode === "empty" ? "현재 응답에 근거 기록이 없습니다." : "근거 조회를 확인하지 못했습니다.",
    );
    await expect(dialog).not.toContainText(
      mode === "empty" ? "근거 조회를 확인하지 못했습니다." : "현재 응답에 근거 기록이 없습니다.",
    );
    expect(explorer.writes()).toEqual([]);
  });
}

test("최초 503을 빈 목록으로 말하지 않고 GET만 다시 조회해 복구한다", async ({ page, explorer }) => {
  explorer.setStatus(503);
  await login(page);
  await expect(sectionFor(page)).toContainText("최신 결정 목록을 확인하지 못했습니다.");
  await expect(sectionFor(page)).not.toContainText("결정 로그가 없습니다.");
  explorer.setStatus(200);
  await sectionFor(page).getByRole("button", { name: "결정 목록 다시 조회", exact: true }).click();
  await expect(tableFor(page)).toContainText(decisionRow.reason);
  await expect(sectionFor(page)).toContainText("마지막 목록 수신(한국 시각)");
  expect(explorer.writes()).toEqual([]);
});

test("초기 응답 대기는 빈 응답이 아니며 실제 빈 성공 후에만 빈 상태를 표시한다", async ({
  page,
  explorer,
}) => {
  explorer.hold();
  explorer.setReport({ decisions: [], signals: {} });
  await login(page);
  await expect.poll(() => explorer.reads().length).toBe(1);
  await expect(sectionFor(page)).not.toContainText("결정 로그가 없습니다.");
  await expect(
    sectionFor(page).getByRole("button", { name: "결정 목록 다시 조회", exact: true }),
  ).toHaveAttribute("aria-busy", "true");
  explorer.release();
  await expect(sectionFor(page)).toContainText("결정 로그가 없습니다.");
  expect(explorer.writes()).toEqual([]);
});

test("재조회 중 상세 DOM과 원래 기록을 유지하고 행이 없어지면 안전한 제목으로 복귀한다", async ({
  page,
  explorer,
}) => {
  await login(page);
  const { dialog } = await open(page);
  const original = await dialog.elementHandle();
  explorer.hold();
  explorer.setReport({ decisions: [], signals: {} });
  const refresh = dialog.getByRole("button", { name: "결정 목록 다시 조회", exact: true });
  await refresh.click();
  await expect(refresh).toBeFocused();
  await expect(dialog).toContainText(decisionRow.reason);
  await expect(dialog).toContainText("목록을 다시 조회하고 있습니다.");
  explorer.release();
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  expect(await original?.evaluate((element) => element === document.querySelector('[role="dialog"]'))).toBe(
    true,
  );
  await expect(dialog).toContainText(signalRow.reason);
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(
    sectionFor(page).getByRole("heading", { name: "도메인 결정 로그", exact: true }).locator("span"),
  ).toBeFocused();
  await expect(sectionFor(page)).toContainText("결정 로그가 없습니다.");
  expect(explorer.writes()).toEqual([]);
});

test("실패한 재조회는 이전 자료임을 경고하고 마지막 수신 시각을 유지한다", async ({ page, explorer }) => {
  await login(page);
  await expect(tableFor(page)).toContainText(decisionRow.reason);
  const received = await sectionFor(page).locator("time").getAttribute("datetime");
  explorer.setStatus(503);
  await sectionFor(page).getByRole("button", { name: "결정 목록 다시 조회", exact: true }).click();
  await expect(sectionFor(page)).toContainText("이전 결과를 표시합니다.");
  await expect(tableFor(page)).toContainText(decisionRow.reason);
  await expect(sectionFor(page).locator("time")).toHaveAttribute("datetime", received ?? "");
  expect(explorer.writes()).toEqual([]);
});

test("권한 거부 뒤 가용성 오류가 와도 옛 상세는 부활하지 않고 새 성공을 다시 선택해야 한다", async ({
  page,
  explorer,
}) => {
  await login(page);
  const { dialog } = await open(page);
  explorer.setStatus(403);
  await dialog.getByRole("button", { name: "결정 목록 다시 조회", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(sectionFor(page)).toContainText("도메인 결정 로그를 볼 수 없습니다.");
  explorer.setStatus(503);
  await sectionFor(page).getByRole("button", { name: "결정 목록 다시 조회", exact: true }).click();
  await expect(
    sectionFor(page).getByRole("button", { name: "결정 목록 다시 조회", exact: true }),
  ).toHaveAttribute("aria-busy", "false");
  await expect(dialogFor(page)).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(decisionRow.reason);
  explorer.setStatus(200);
  await sectionFor(page).getByRole("button", { name: "결정 목록 다시 조회", exact: true }).click();
  await expect(tableFor(page)).toContainText(decisionRow.reason);
  await expect(dialogFor(page)).toHaveCount(0);
  const fresh = await open(page);
  await expect(fresh.dialog).toContainText(signalRow.reason);
  expect(explorer.writes()).toEqual([]);
});

test("갱신 토큰 없는 최종 401은 로그인 화면 전환 없이 옛 상세를 폐기하고 새 조회로만 복구한다", async ({
  page,
  explorer,
}) => {
  await login(page);
  await expect(tableFor(page)).toContainText(decisionRow.reason);
  // Reinitialize the actual client from access-only storage, before opening the
  // detail. A terminal 401 must be handled locally, without refresh/logout.
  await page.evaluate(() => sessionStorage.removeItem("vibe.app.auth.refresh"));
  await page.reload();
  const { dialog } = await open(page);
  const before = explorer.reads().length;
  const authCalls: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/auth/refresh" || path === "/auth/logout") authCalls.push(path);
  });
  explorer.setStatus(401);
  await dialog.getByRole("button", { name: "결정 목록 다시 조회", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(sectionFor(page)).toContainText("필요하면 다시 로그인한 뒤 결정 목록을 다시 조회하세요.");
  await expect(page.locator("body")).not.toContainText(decisionRow.reason);
  await expect(
    sectionFor(page).getByRole("heading", { name: "도메인 결정 로그", exact: true }).locator("span"),
  ).toBeFocused();
  expect(new URL(page.url()).pathname).toBe(decisionsUrl);
  expect(explorer.reads()).toHaveLength(before + 1);
  expect(authCalls).toEqual([]);

  explorer.setStatus(503);
  await sectionFor(page).getByRole("button", { name: "결정 목록 다시 조회", exact: true }).click();
  await expect(
    sectionFor(page).getByRole("button", { name: "결정 목록 다시 조회", exact: true }),
  ).toHaveAttribute("aria-busy", "false");
  await expect(dialogFor(page)).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(decisionRow.reason);

  explorer.setStatus(200);
  await sectionFor(page).getByRole("button", { name: "결정 목록 다시 조회", exact: true }).click();
  await expect(tableFor(page)).toContainText(decisionRow.reason);
  await expect(dialogFor(page)).toHaveCount(0);
  expect(explorer.reads()).toHaveLength(before + 3);
  await expect(sectionFor(page)).toContainText("이 조회에서는 자동 새로고침이 중지되어 있습니다.");
  const fresh = await open(page);
  await expect(fresh.dialog).toContainText(signalRow.reason);
  expect(explorer.reads()).toHaveLength(before + 3);
  await fresh.dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await sectionFor(page).getByRole("textbox", { name: "요청 ID", exact: true }).fill(decisionRow.request_id);
  await sectionFor(page).getByRole("button", { name: "결정 로그 조회", exact: true }).click();
  await expect(tableFor(page)).toContainText(decisionRow.reason);
  await expect(sectionFor(page)).not.toContainText("이 조회에서는 자동 새로고침이 중지되어 있습니다.");
  expect(explorer.reads()).toHaveLength(before + 4);
  expect(authCalls).toEqual([]);
  expect(explorer.writes()).toEqual([]);
});

test("읽기 전용 상태에서 상세를 읽을 수 있고 raw capability 회수 즉시 상세와 행이 사라진다", async ({
  page,
  explorer,
  gateway,
}) => {
  gateway.setWrite(false);
  gateway.setMode("read_only");
  await login(page);
  const { dialog, triggerHandle: oldTrigger } = await open(page);
  gateway.setRawPromptView(false);
  await refreshIdentity(page);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(decisionRow.reason);
  await expect(sectionFor(page)).toContainText("프롬프트 원문 조회 권한");
  await oldTrigger?.evaluate((element) => (element as HTMLButtonElement).click());
  await expect(dialog).toHaveCount(0);
  expect(explorer.writes()).toEqual([]);
});

test("raw capability 없이 결정 목록 요청을 시작하지 않는다", async ({ page, explorer, gateway }) => {
  gateway.setRawPromptView(false);
  await login(page);
  await expect(sectionFor(page)).toContainText("프롬프트 원문 조회 권한");
  expect(explorer.reads()).toEqual([]);
  expect(explorer.writes()).toEqual([]);
});

test("설정된 접두사 메타데이터와 요청 ID는 표시·URL·조회에서 보호한다", async ({
  page,
  explorer,
  gateway,
}) => {
  const secret = `publickey_${"SYNTHETIC_ONLY_".repeat(4)}`;
  gateway.setPrefixes(["publickey_"]);
  explorer.setReport({
    decisions: [{ ...decisionRow, reason: secret }],
    signals: { [decisionRow.id]: [{ ...signalRow, reason: secret }] },
  });
  await login(page);
  await expect(tableFor(page)).toContainText("민감정보가 포함될 수 있어 표시하지 않습니다.");
  const { dialog } = await open(page);
  await expect(dialog).not.toContainText(secret);
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await sectionFor(page).getByRole("textbox", { name: "요청 ID", exact: true }).fill(secret);
  const before = explorer.reads().length;
  await sectionFor(page).getByRole("button", { name: "결정 로그 조회", exact: true }).click();
  await expect(sectionFor(page)).toContainText("인증정보로 보이는 검색어");
  expect(new URL(page.url()).searchParams.has("request_id")).toBe(false);
  expect(explorer.reads()).toHaveLength(before);
  expect(explorer.writes()).toEqual([]);
});

test("__proto__ 결정은 변경된 두 번째 조회 뒤에도 정확한 근거를 유지한다", async ({ page, explorer }) => {
  const id = "__proto__";
  const report = (reason: string) => ({
    decisions: [{ ...decisionRow, id }],
    signals: Object.fromEntries([[id, [{ ...signalRow, decision_id: id, reason }]]]),
  });
  explorer.setReport(report("첫 합성 근거"));
  await login(page);
  const first = await open(page);
  await expect(first.dialog).toContainText("첫 합성 근거");
  await first.dialog.getByRole("button", { name: "닫기", exact: true }).click();
  explorer.setReport(report("변경된 두 번째 합성 근거"));
  await sectionFor(page).getByRole("button", { name: "결정 목록 다시 조회", exact: true }).click();
  await expect(
    sectionFor(page).getByRole("button", { name: "결정 목록 다시 조회", exact: true }),
  ).toHaveAttribute("aria-busy", "false");
  const second = await open(page);
  await expect(second.dialog).toContainText("변경된 두 번째 합성 근거");
  await expect(second.dialog).not.toContainText("근거 조회를 확인하지 못했습니다.");
  expect(explorer.writes()).toEqual([]);
});

test("390px 다크 결정 상세는 제목·키보드·고정 하단·포커스 복귀와 axe를 만족한다", async ({
  page,
  explorer,
}, testInfo) => {
  explorer.setReport({
    decisions: [{ ...decisionRow, reason: "긴 공개 합성 결정 사유입니다. ".repeat(12) }],
    signals: { [decisionRow.id]: [{ ...signalRow, reason: "긴 공개 합성 근거입니다. ".repeat(12) }] },
  });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const { dialog, trigger } = await open(page);
  await expect(dialog.getByRole("heading", { name: "도메인 결정 근거", exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("domain-decisions-mobile-dark-initial.png") });
  await page.keyboard.press("Tab");
  const refresh = dialog.getByRole("button", { name: "결정 목록 다시 조회", exact: true });
  await expect(refresh).toBeFocused();
  const close = dialog.getByRole("button", { name: "닫기", exact: true });
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await expect(close).toBeInViewport({ ratio: 1 });
  expect(
    await close.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: (root: Element, options: object) => Promise<{ violations: { id: string }[] }> };
      }
    ).axe;
    const root = document.querySelector('[role="dialog"]');
    if (!root) throw new Error("결정 상세가 없습니다.");
    return (
      await axe.run(root, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } })
    ).violations;
  });
  expect(violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("domain-decisions-mobile-dark-footer.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(explorer.writes()).toEqual([]);
});
