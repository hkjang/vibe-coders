import { expect, type Locator, type Page } from "@playwright/test";
import {
  firstEmail,
  initial,
  readerEmail,
  routingUrl,
  secondEmail,
  targetUrl,
  test,
} from "../fixtures/cost-guard-gateway";

// Browser UX/request evidence uses synthetic responses. It does not establish
// real server authorization, atomic persistence, or cost-gate execution.
const title = "비용 보호 설정 수정";
const card = (page: Page) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "예상 비용 보호", exact: true, includeHidden: true }) });
const form = (page: Page) => page.getByRole("dialog", { name: title, exact: true });
const trigger = (page: Page) => page.getByRole("button", { name: title, exact: true });
const input = (dialog: Locator) =>
  dialog.getByRole("spinbutton", { name: "요청당 임계값 (원)", exact: true });
const save = (dialog: Locator) => dialog.getByRole("button", { name: "비용 보호 설정 저장", exact: true });
const refresh = (dialog: Locator) => dialog.getByRole("button", { name: "현재 설정 다시 조회", exact: true });
const guard = (page: Page) => page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" });
async function signIn(page: Page, email = firstEmail) {
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByLabel("사용자 메뉴")).toBeVisible();
}
async function login(page: Page, email = firstEmail, path = targetUrl) {
  await page.goto(`login?return_to=${encodeURIComponent(path)}`);
  await signIn(page, email);
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
}
async function open(page: Page) {
  await expect(trigger(page)).toBeEnabled();
  await trigger(page).click();
  await expect(form(page)).toBeVisible();
  return form(page);
}
type CloseMethod = "Escape" | "취소" | "외부 클릭" | "닫기 버튼";
async function close(page: Page, dialog: Locator, method: CloseMethod) {
  if (method === "Escape") await page.keyboard.press("Escape");
  else if (method === "외부 클릭") await page.mouse.click(5, 5);
  else
    await dialog
      .getByRole("button", { name: method === "취소" ? "취소" : "대화상자 닫기", exact: true })
      .click();
}
async function submitDirectly(dialog: Locator) {
  await dialog.locator("form").evaluate((element) => (element as HTMLFormElement).requestSubmit());
}
async function refreshRuntime(page: Page) {
  // AuthProvider's real visibility refresh path updates permissions/version in
  // the same session without replacing the document or forcing form remounts.
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function navigate(page: Page, label: RegExp) {
  await page.getByRole("complementary", { name: "주 메뉴" }).getByRole("link", { name: label }).click();
}
async function noStoredDraft(page: Page) {
  expect(
    await page.evaluate(() =>
      [localStorage, sessionStorage].every((storage) =>
        Object.values(storage).every((value) => !String(value).includes("987654.321125")),
      ),
    ),
  ).toBe(true);
}
async function noOverflow(page: Page, dialog: Locator) {
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function axeViolations(page: Page) {
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: (root: Document) => Promise<{ violations: { id: string; impact: string | null }[] }> };
      }
    ).axe;
    return (await axe.run(document)).violations.map(({ id, impact }) => ({ id, impact }));
  });
}

test("확인된 false/0는 제한 없음이며 예상 비용·승인 헤더의 범위를 설명한다", async ({ page, gateway }) => {
  gateway.replaceConfig({ enabled: false, threshold_krw: 0 });
  await login(page);
  await expect(card(page)).toContainText("비용 검사 제한 없음");
  await expect(card(page)).toContainText("0원");
  await expect(card(page)).toContainText("대체 가격을 포함해");
  await expect(card(page)).toContainText("전체 지출이나 누적 예산을 제한하는 기능이 아닙니다.");
  await expect(card(page)).toContainText("X-Cost-Approve: 1");
  const dialog = await open(page);
  await expect(input(dialog)).toHaveValue("0");
  await expect(dialog.getByRole("switch")).not.toBeChecked();
  await expect(dialog).toContainText("다른 관리자의 동시 변경을 막지는 않습니다.");
  await expect(dialog).toContainText("진행 중 요청이 취소되는 것은 아닙니다.");
  await close(page, dialog, "취소");
  await expect(dialog).toBeHidden();
  await expect(guard(page)).toBeHidden();
  expect(gateway.writes).toEqual([]);
});

test("조회 중에는 중지·0원을 만들지 않고 편집을 막는다", async ({ page, gateway }) => {
  gateway.holdReads();
  await login(page);
  await expect(card(page)).toContainText("설정 미확인");
  await expect(card(page)).not.toContainText("비용 검사 제한 없음");
  await expect(card(page)).not.toContainText("0원");
  await expect(trigger(page)).toBeDisabled();
  gateway.releaseReads();
  await expect(trigger(page)).toBeEnabled();
  expect(gateway.writes).toEqual([]);
});

test("조회 오류는 요청 ID·수동 재시도로 복구하며 확인된 값과 구별한다", async ({ page, gateway }) => {
  gateway.failReads();
  await login(page);
  await expect(card(page)).toContainText("req-cost-read");
  await expect(card(page)).toContainText("설정 미확인");
  await expect(trigger(page)).toBeDisabled();
  gateway.succeedReads();
  await card(page).getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(trigger(page)).toBeEnabled();
  await expect(card(page)).toContainText("47.25원");
  expect(gateway.writes).toEqual([]);
});

for (const [name, response] of [
  ["누락", {}],
  ["null", null],
  ["잘못된 숫자", { enabled: true, threshold_krw: "0" }],
] as const) {
  test(`불완전한 ${name} 응답은 설정 미확인·요청 ID로 남고 저장하지 않는다`, async ({ page, gateway }) => {
    gateway.replaceConfig(response);
    await login(page);
    await expect(card(page)).toContainText("설정 미확인");
    await expect(card(page)).toContainText("req-cost-read");
    await expect(trigger(page)).toBeDisabled();
    await expect(card(page)).not.toContainText("비용 검사 제한 없음");
    gateway.replaceConfig(initial);
    await card(page).getByRole("button", { name: "다시 시도", exact: true }).click();
    await expect(trigger(page)).toBeEnabled();
    expect(gateway.writes).toEqual([]);
  });
}

test("재조회 무효화·조회 실패는 저장을 차단하고 고정 초안을 덮지 않는다", async ({ page, gateway }) => {
  await login(page);
  const dialog = await open(page);
  await input(dialog).fill("987654.321125");
  gateway.replaceConfig({ enabled: false, threshold_krw: 999 });
  gateway.holdReads();
  const reads = gateway.reads();
  await refresh(dialog).click();
  await expect.poll(gateway.reads).toBeGreaterThan(reads);
  await expect(save(dialog)).toBeDisabled();
  await submitDirectly(dialog);
  expect(gateway.writes).toEqual([]);
  gateway.releaseReads();
  await expect(save(dialog)).toBeEnabled();
  await expect(input(dialog)).toHaveValue("987654.321125");
  await expect(dialog.getByRole("switch")).toBeChecked();
  gateway.failReads();
  await refresh(dialog).click();
  await expect(dialog).toContainText("req-cost-read");
  await submitDirectly(dialog);
  expect(gateway.writes).toEqual([]);
  gateway.succeedReads();
  await refresh(dialog).click();
  await expect(save(dialog)).toBeEnabled();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(gateway.writes).toEqual([
    { body: { enabled: true, threshold_krw: 987654.321125 }, userId: "cost-one" },
  ]);
  await noStoredDraft(page);
});

test("빈 숫자는 0이 아니며 음수는 거부하고 명시적 중지·0·작은 소수를 저장한다", async ({ page, gateway }) => {
  await login(page);
  let dialog = await open(page);
  await input(dialog).fill("");
  await save(dialog).click();
  await expect(dialog).toContainText("빈 값은 0이 아닙니다.");
  await expect(input(dialog)).toBeFocused();
  await input(dialog).fill("-1");
  await save(dialog).click();
  await expect(dialog).toContainText("유한한 0 이상의 금액을 입력하세요.");
  expect(gateway.writes).toEqual([]);
  await dialog.getByRole("switch").click();
  await expect(dialog.getByRole("switch")).not.toBeChecked();
  await input(dialog).fill("0");
  await expect(dialog).toContainText("이 예상 비용 검사가 요청을 차단하지 않습니다.");
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(card(page)).toContainText("비용 검사 제한 없음");
  dialog = await open(page);
  await dialog.getByRole("switch").click();
  await expect(dialog.getByRole("switch")).toBeChecked();
  await input(dialog).fill("0.000125");
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(card(page)).toContainText("0.000125원");
  expect(gateway.writes.map((write) => write.body)).toEqual([
    { enabled: false, threshold_krw: 0 },
    { enabled: true, threshold_krw: 0.000125 },
  ]);
});

for (const method of ["Escape", "취소", "외부 클릭", "닫기 버튼"] as const) {
  test(`${method} 닫기는 초안 유지·폐기를 확인하고 수정 버튼 포커스를 복원한다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    const dialog = await open(page);
    await input(dialog).fill("987654.321125");
    await close(page, dialog, method);
    await expect(guard(page).getByRole("button", { name: "계속 편집" })).toBeFocused();
    await guard(page).getByRole("button", { name: "계속 편집" }).click();
    await expect(input(dialog)).toHaveValue("987654.321125");
    await close(page, dialog, method);
    await guard(page).getByRole("button", { name: "변경 버리기" }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    const fresh = await open(page);
    await expect(input(fresh)).toHaveValue("47.25");
    expect(gateway.writes).toEqual([]);
    await noStoredDraft(page);
  });
}

test("저장 중 중복 제출·입력·조회·닫기를 잠그고 정확히 한 본문만 보낸다", async ({ page, gateway }) => {
  await login(page);
  const dialog = await open(page);
  await input(dialog).fill("600.125");
  gateway.holdWrites();
  await dialog.locator("form").evaluate((element) => {
    (element as HTMLFormElement).requestSubmit();
    (element as HTMLFormElement).requestSubmit();
  });
  await expect.poll(() => gateway.writes.length).toBe(1);
  await expect(input(dialog)).toBeDisabled();
  await expect(dialog.getByRole("switch")).toBeDisabled();
  await expect(refresh(dialog)).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  await dialog.getByRole("button", { name: "대화상자 닫기" }).click();
  await expect(dialog).toBeVisible();
  await expect(guard(page)).toBeHidden();
  expect(gateway.writes).toEqual([{ body: { enabled: true, threshold_krw: 600.125 }, userId: "cost-one" }]);
  gateway.releaseWrites();
  await expect(dialog).toBeHidden();
  expect(gateway.writes).toHaveLength(1);
});

test("저장 실패는 요청 ID·입력을 유지하고 명시적 수정 재시도만 전송한다", async ({ page, gateway }) => {
  await login(page);
  const dialog = await open(page);
  gateway.failWrites();
  await input(dialog).fill("600.25");
  await save(dialog).click();
  await expect(dialog.getByRole("alert")).toContainText("req-cost-write");
  await expect(input(dialog)).toHaveValue("600.25");
  const first = structuredClone(gateway.writes);
  await input(dialog).fill("601.25");
  expect(gateway.writes).toEqual(first);
  gateway.succeedWrites();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(gateway.writes.map((write) => write.body)).toEqual([
    { enabled: true, threshold_krw: 600.25 },
    { enabled: true, threshold_krw: 601.25 },
  ]);
});

test("저장 완료 후 조회 실패는 재전송하지 않고 복구 뒤 과거 성공 안내를 재사용하지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  let dialog = await open(page);
  await input(dialog).fill("800.25");
  gateway.failReadAfterSave();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(card(page)).toContainText("설정 저장은 완료됐습니다.");
  await expect(card(page)).toContainText("req-cost-read");
  await expect(page.locator("#main-content")).toBeFocused();
  expect(gateway.writes).toHaveLength(1);
  gateway.failReadAfterSave(false);
  gateway.succeedReads();
  await card(page).getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(trigger(page)).toBeEnabled();
  await expect(card(page)).not.toContainText("설정 저장은 완료됐습니다.");
  // Check successful-read reset before opening another draft (which has its
  // own reset), so a permanently sticky past-success flag cannot pass.
  gateway.failReads();
  await card(page).getByRole("button", { name: "비용 보호 설정 새로고침", exact: true }).click();
  await expect(card(page)).toContainText("req-cost-read");
  await expect(card(page)).not.toContainText("설정 저장은 완료됐습니다.");
  expect(gateway.writes).toHaveLength(1);
  gateway.succeedReads();
  await card(page).getByRole("button", { name: "다시 시도", exact: true }).click();
  dialog = await open(page);
  gateway.failWrites();
  await input(dialog).fill("801.25");
  await save(dialog).click();
  await expect(dialog.getByRole("alert")).toContainText("req-cost-write");
  gateway.failReads();
  await refresh(dialog).click();
  await expect(dialog).toContainText("req-cost-read");
  await expect(card(page)).not.toContainText("설정 저장은 완료됐습니다.");
  expect(gateway.writes).toHaveLength(2);
});

test("읽기 전용 화면은 편집을 열지 않고 DOM 활성화 시도에도 저장하지 않는다", async ({ page, gateway }) => {
  await login(page, readerEmail);
  await expect(card(page)).toContainText("47.25원");
  await expect(trigger(page)).toBeDisabled();
  // Removing the DOM attribute is not proof React invokes a disabled callback;
  // direct latest-permission handler guards are separate focused unit evidence.
  await trigger(page).evaluate((element) => {
    element.removeAttribute("disabled");
    (element as HTMLButtonElement).click();
  });
  await expect(form(page)).toBeHidden();
  expect(gateway.writes).toEqual([]);
});

test("열린 초안의 최신 쓰기 권한이 사라지면 직접 submit도 저장하지 않는다", async ({ page, gateway }) => {
  await login(page);
  const dialog = await open(page);
  await input(dialog).fill("987654.321125");
  gateway.setWritable(false);
  await refreshRuntime(page);
  await expect(save(dialog)).toBeDisabled();
  await expect(input(dialog)).toHaveValue("987654.321125");
  await submitDirectly(dialog);
  expect(gateway.writes).toEqual([]);
});

test("다른 화면 이동은 초안을 유지하거나 명시적으로 폐기한다", async ({ page, gateway }) => {
  await login(page);
  const dialog = await open(page);
  await input(dialog).fill("987654.321125");
  // Real SPA link handler behind the inert modal exercises navigation guarding.
  const routeLink = page
    .getByRole("link", { name: /라우팅/u, includeHidden: true })
    .filter({ hasText: "라우팅" })
    .first();
  const leave = () => routeLink.evaluate((element) => (element as HTMLAnchorElement).click());
  await leave();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(input(dialog)).toHaveValue("987654.321125");
  await leave();
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(page).toHaveURL(/\/routing\/rules$/u);
  await expect(dialog).toBeHidden();
  expect(gateway.writes).toEqual([]);
});

test("실제 뒤로가기는 계속 편집에 남고 폐기 뒤 이전 탭으로 이동한다", async ({ page, gateway }) => {
  await login(page, firstEmail, `${targetUrl}?tab=sunset`);
  await navigate(page, /정책 및 거버넌스/u);
  const dialog = await open(page);
  await input(dialog).fill("987654.321125");
  await page.goBack();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(input(dialog)).toHaveValue("987654.321125");
  await page.goBack();
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(page).toHaveURL(/\/governance\/policies\?tab=sunset$/u);
  await expect(dialog).toBeHidden();
  expect(gateway.writes).toEqual([]);
});

test("실제 새로고침 경고를 취소할 수 있고 폐기 뒤에는 다시 경고하지 않는다", async ({ page, gateway }) => {
  await login(page);
  const dialog = await open(page);
  await input(dialog).fill("987654.321125");
  const waiting = page.waitForEvent("dialog");
  await page.evaluate(() => {
    setTimeout(() => location.reload(), 0);
  });
  const native = await waiting;
  expect(native.type()).toBe("beforeunload");
  await native.dismiss();
  await expect(input(dialog)).toHaveValue("987654.321125");
  await close(page, dialog, "취소");
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  let warnings = 0;
  page.on("dialog", async (event) => {
    warnings += 1;
    await event.dismiss();
  });
  await page.reload();
  await expect(trigger(page)).toBeEnabled();
  expect(warnings).toBe(0);
  expect(gateway.writes).toEqual([]);
});

test("다른 탭 로그아웃은 서버 응답 전에 초안과 폐기 확인을 지운다", async ({ page, context, gateway }) => {
  await login(page);
  const other = await context.newPage();
  await login(other);
  const dialog = await open(page);
  await input(dialog).fill("987654.321125");
  await close(page, dialog, "Escape");
  gateway.holdLogouts();
  await other.getByLabel("사용자 메뉴").click();
  await other.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect.poll(gateway.logouts).toBe(1);
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(guard(page)).toBeHidden();
  expect(gateway.logoutResponses()).toBe(0);
  gateway.releaseLogouts();
  await expect.poll(gateway.logoutResponses).toBe(1);
  await noStoredDraft(page);
});

for (const outcome of ["성공", "실패"] as const) {
  test(`이전 세션의 늦은 ${outcome} 응답은 새 계정의 편집 가능한 초안·조회·알림을 건드리지 않는다`, async ({
    page,
    context,
    gateway,
  }) => {
    await login(page);
    const other = await context.newPage();
    await login(other);
    const old = await open(page);
    await input(old).fill("111.25");
    if (outcome === "실패") gateway.failWrites();
    gateway.holdWrites();
    await save(old).click();
    await expect.poll(() => gateway.writes.length).toBe(1);
    await other.getByLabel("사용자 메뉴").click();
    await other.getByRole("button", { name: "로그아웃", exact: true }).click();
    await signIn(page, secondEmail);
    const fresh = await open(page);
    await input(fresh).fill("222.25");
    const reads = gateway.reads();
    const response = page.waitForResponse(
      (value) => new URL(value.url()).pathname === "/admin/cost" && value.request().method() === "POST",
    );
    gateway.releaseWrites();
    await (await response).finished();
    await page.waitForTimeout(500);
    await expect(fresh).toBeVisible();
    await expect(input(fresh)).toHaveValue("222.25");
    await expect(save(fresh)).toBeEnabled();
    await expect(fresh.getByRole("alert")).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    expect(gateway.reads()).toBe(reads);
    expect(gateway.writes).toHaveLength(1);
    gateway.succeedWrites();
    await save(fresh).click();
    await expect(fresh).toBeHidden();
    expect(gateway.writes[1]).toEqual({ body: { enabled: true, threshold_krw: 222.25 }, userId: "cost-two" });
  });
}

test("390px 다크 편집·폐기 확인은 키보드·axe·엄격한 가로 넘침 검사를 통과한다", async ({
  page,
  gateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page);
  const dialog = await open(page);
  await dialog.getByRole("switch").focus();
  await page.keyboard.press("Space");
  await expect(dialog.getByRole("switch")).not.toBeChecked();
  await input(dialog).fill("987654.321125");
  await noOverflow(page, dialog);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("cost-guard-mobile-dark.png") });
  await page.keyboard.press("Escape");
  const alert = guard(page);
  await expect(alert.getByRole("button", { name: "계속 편집" })).toBeFocused();
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Tab");
    expect(await alert.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await noOverflow(page, alert);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("cost-guard-discard-mobile-dark.png") });
  await alert.getByRole("button", { name: "변경 버리기" }).click();
  await expect(trigger(page)).toBeFocused();
  expect(gateway.writes).toEqual([]);
  await noStoredDraft(page);
});

test("저장 후 두 화면의 캐시가 갱신되고 라우팅도 true/0·작은 소수를 정확히 표시한다", async ({
  page,
  gateway,
}) => {
  await login(page, firstEmail, routingUrl);
  const summary = () =>
    page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "비용 예측 가드", exact: true }) });
  await expect(summary()).toContainText("47.25원");
  await navigate(page, /정책 및 거버넌스/u);
  let dialog = await open(page);
  await input(dialog).fill("0");
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(card(page)).toContainText("비용 검사 제한 없음");
  await navigate(page, /^라우팅/u);
  await page.getByRole("tab", { name: "미리보기", exact: true }).click();
  await expect(summary()).toContainText("제한 없음");
  await expect(summary()).toContainText("0원");
  await navigate(page, /정책 및 거버넌스/u);
  dialog = await open(page);
  await input(dialog).fill("0.000125");
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(card(page)).toContainText("0.000125원");
  await navigate(page, /^라우팅/u);
  await page.getByRole("tab", { name: "미리보기", exact: true }).click();
  await expect(summary()).toContainText("0.000125원");
  gateway.failReads();
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(summary()).toContainText("설정 미확인");
  await expect(summary()).not.toContainText("0.000125원");
  expect(gateway.writes).toHaveLength(2);
});

test("이전 v14 및 v15 사전 배포 서버는 비용 편집을 막고 기존 화면 링크를 안내한다", async ({
  page,
  gateway,
}) => {
  gateway.setVersion("v0.86.14");
  await login(page);
  for (const version of ["v0.86.14", "v0.86.15-rc.1"]) {
    gateway.setVersion(version);
    await refreshRuntime(page);
    await expect(card(page)).toContainText("비용 보호 설정의 서버 버전을 확인하세요.");
    await expect(trigger(page)).toBeDisabled();
    await expect(
      card(page).getByRole("link", { name: "기존 관리자에서 비용 보호 설정 열기" }),
    ).toHaveAttribute("href", "/admin#/safety");
  }
  expect(gateway.writes).toEqual([]);
});

for (const [name, version] of [
  ["누락", undefined],
  ["잘못된", "not-a-release"],
] as const) {
  test(`${name} 서버 버전은 전역 진입부터 실패 안전하며 비용 POST가 없다`, async ({ page, gateway }) => {
    gateway.setVersion(version);
    await login(page);
    // Global bootstrap/fallback/FeatureRoute may reject before the cost editor;
    // direct cost-specific version-handler guards are proved by unit tests.
    await expect(form(page)).toBeHidden();
    await expect(trigger(page)).toHaveCount(0);
    await expect(page.getByRole("link", { name: /기존/u }).first()).toBeVisible();
    expect(gateway.writes).toEqual([]);
  });
}

test("열린 초안에서 서버 버전이 내려가면 초안을 유지하되 직접 submit도 차단한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const dialog = await open(page);
  await input(dialog).fill("987654.321125");
  gateway.setVersion("v0.86.14");
  await refreshRuntime(page);
  await expect(dialog).toContainText("비용 보호 설정의 서버 버전을 확인하세요.");
  await expect(save(dialog)).toBeDisabled();
  await expect(input(dialog)).toHaveValue("987654.321125");
  await submitDirectly(dialog);
  expect(gateway.writes).toEqual([]);
  gateway.setVersion("v0.86.15");
  await refreshRuntime(page);
  await expect(save(dialog)).toBeEnabled();
  await expect(input(dialog)).toHaveValue("987654.321125");
});
