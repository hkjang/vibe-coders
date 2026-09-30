import { expect, type Locator, type Page } from "@playwright/test";
import {
  alpha,
  beta,
  empty,
  extension,
  firstEmail,
  known,
  second,
  secondEmail,
  targetUrl,
  test,
} from "../fixtures/me-key-scope-gateway";

// This lane verifies browser behavior with public fixtures. Actual authorization
// and Go persistence are covered separately, not claimed by mocked responses.
const title = "내 API 키 권한 수정";
const guard = (page: Page) => page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" });
const keyItem = (page: Page, id = alpha.id) =>
  page.locator(".access-list > li").filter({ has: page.getByText(id, { exact: true }) });
const trigger = (page: Page, id = alpha.id) =>
  keyItem(page, id).getByRole("button", { name: "권한 수정", exact: true });
const scope = (form: Locator, id: string) => form.getByRole("checkbox", { name: new RegExp(id, "u") });
const save = (form: Locator) => form.getByRole("button", { name: "권한 저장", exact: true });
const refresh = (form: Locator) => form.getByRole("button", { name: "허용 권한 새로고침", exact: true });

async function signIn(page: Page, email = firstEmail) {
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByLabel("사용자 메뉴")).toBeVisible();
}
async function login(page: Page, path = targetUrl) {
  await page.goto(`login?return_to=${encodeURIComponent(path)}`);
  await signIn(page);
  const interval = page.getByLabel("자동 새로고침 간격");
  // The compact mobile header intentionally hides this desktop control.
  if (await interval.isVisible()) await interval.selectOption("0");
}
async function openForm(page: Page, id = alpha.id) {
  await trigger(page, id).click();
  const form = page.getByRole("dialog", { name: title, exact: true });
  await expect(form).toBeVisible();
  return form;
}
type CloseMethod = "Escape" | "취소" | "외부 클릭" | "닫기 버튼";
async function close(page: Page, form: Locator, method: CloseMethod) {
  if (method === "Escape") await page.keyboard.press("Escape");
  else if (method === "외부 클릭") await page.mouse.click(8, 8);
  else
    await form
      .getByRole("button", { name: method === "취소" ? "취소" : "대화상자 닫기", exact: true })
      .click();
}
async function noStoredDraft(page: Page) {
  expect(
    await page.evaluate(
      (values) =>
        [localStorage, sessionStorage].every((storage) =>
          Object.values(storage).every((stored) => values.every((value) => !String(stored).includes(value))),
        ),
      [alpha.name, second.name, extension, "embeddings:create"],
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

for (const method of ["Escape", "취소", "외부 클릭", "닫기 버튼"] as const) {
  test(`개인 권한 ${method}는 초안을 보존하고 명시적 폐기 후 원래 키에 포커스를 복원한다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    const form = await openForm(page);
    await scope(form, "chat:completion").check();
    await close(page, form, method);
    await expect(guard(page).getByRole("button", { name: "계속 편집" })).toBeFocused();
    await guard(page).getByRole("button", { name: "계속 편집" }).click();
    await expect(scope(form, extension)).toBeChecked();
    await expect(scope(form, "chat:completion")).toBeChecked();
    await close(page, form, method);
    await guard(page).getByRole("button", { name: "변경 버리기" }).click();
    await expect(form).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    const reopened = await openForm(page);
    await expect(scope(reopened, "chat:completion")).not.toBeChecked();
    await expect(scope(reopened, extension)).toBeChecked();
    expect(gateway.saves).toEqual([]);
    await noStoredDraft(page);
  });
}

test("개인 권한의 미변경·원복은 경고 없이 닫히고 빈 권한 저장은 역할 상속을 뜻하지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await expect(trigger(page, "personal-revoked")).toBeDisabled();
  let form = await openForm(page, beta.id);
  await close(page, form, "취소");
  await expect(form).toBeHidden();
  await expect(guard(page)).toBeHidden();
  form = await openForm(page, beta.id);
  await scope(form, "chat:completion").check();
  await scope(form, "chat:completion").uncheck();
  await close(page, form, "Escape");
  await expect(form).toBeHidden();
  await expect(guard(page)).toBeHidden();
  await expect(keyItem(page, empty.id)).toContainText("선택된 권한 없음");
  await expect(keyItem(page, empty.id)).not.toContainText("상속");
  form = await openForm(page, beta.id);
  await expect(form).toContainText("역할 권한을 자동 상속하지 않습니다");
  await expect(form).toContainText("별도의 ‘폐기’ 작업");
  await scope(form, "models:read").uncheck();
  await save(form).click();
  await expect(form).toBeHidden();
  expect(gateway.saves).toEqual([{ id: beta.id, body: { scopes: [] }, userId: "personal-one" }]);
  await expect(trigger(page, beta.id)).toBeFocused();
  const reopened = await openForm(page, beta.id);
  await expect(reopened.locator('input[type="checkbox"]:checked')).toHaveCount(0);
});

test("개인 키 자동 갱신과 행 재정렬은 열린 이름·ID·권한 기준을 바꾸지 않는다", async ({ page, gateway }) => {
  await page.clock.install();
  await login(page);
  await page.getByLabel("자동 새로고침 간격").selectOption("60");
  const form = await openForm(page);
  await scope(form, "chat:completion").check();
  const reads = gateway.reads();
  const renamed = { ...alpha, name: "서버에서 바뀐 개인 키", scopes: ["embeddings:create"] };
  gateway.replaceKeys([beta, renamed, empty, second]);
  await page.clock.fastForward(60_100);
  await expect.poll(gateway.reads).toBeGreaterThan(reads);
  await expect(form).toContainText(alpha.name);
  await expect(form).not.toContainText(renamed.name);
  for (const value of [extension, "models:read", "chat:completion"])
    await expect(scope(form, value)).toBeChecked();
  await expect(scope(form, "embeddings:create")).not.toBeChecked();
  await save(form).click();
  await expect(form).toBeHidden();
  expect(gateway.saves).toEqual([
    { id: alpha.id, body: { scopes: ["chat:completion", extension, "models:read"] }, userId: "personal-one" },
  ]);
  await expect(trigger(page)).toBeFocused();
  await expect(trigger(page, beta.id)).not.toBeFocused();
});

test("개인 권한 목록 재조회 중에는 직접 제출도 막고 선택한 초안을 유지한다", async ({ page, gateway }) => {
  await login(page);
  const form = await openForm(page);
  await scope(form, "chat:completion").check();
  gateway.holdReads();
  await refresh(form).click();
  await expect(form).toContainText("권한 목록을 불러오는 중입니다.");
  await expect(save(form)).toBeDisabled();
  await form.locator("form").evaluate((element) => (element as HTMLFormElement).requestSubmit());
  expect(gateway.saves).toEqual([]);
  await expect(scope(form, "chat:completion")).toBeChecked();
  gateway.releaseReads();
  await expect(save(form)).toBeEnabled();
  await expect(scope(form, extension)).toBeChecked();
});

for (const [label, value] of [
  ["누락", undefined],
  ["null", null],
] as const) {
  test(`개인 grantable_scopes ${label}은 빈 허용 목록과 구분하며 확인 후에만 저장한다`, async ({
    page,
    gateway,
  }) => {
    gateway.replaceCatalog(value);
    await login(page);
    const form = await openForm(page, empty.id);
    await expect(form).toContainText("부여 가능한 권한을 확인하기 전에는 저장할 수 없습니다.");
    await expect(save(form)).toBeDisabled();
    await form.locator("form").evaluate((element) => (element as HTMLFormElement).requestSubmit());
    expect(gateway.saves).toEqual([]);
    gateway.replaceCatalog([]);
    await refresh(form).click();
    await expect(form).toContainText(
      "현재 부여할 수 있는 권한이 없습니다. 모두 해제한 상태로 저장할 수 있습니다.",
    );
    await expect(save(form)).toBeEnabled();
    await save(form).click();
    await expect(form).toBeHidden();
    expect(gateway.saves).toEqual([{ id: empty.id, body: { scopes: [] }, userId: "personal-one" }]);
  });
}

test("확인된 빈 개인 허용 목록은 기존 권한을 자동 제거하지 않고 전체 해제 후 저장한다", async ({
  page,
  gateway,
}) => {
  gateway.replaceCatalog([]);
  await login(page);
  const form = await openForm(page);
  await expect(scope(form, extension)).toBeChecked();
  await expect(save(form)).toBeDisabled();
  await scope(form, extension).uncheck();
  await expect(save(form)).toBeDisabled();
  await scope(form, "models:read").uncheck();
  await expect(save(form)).toBeEnabled();
  await save(form).click();
  await expect(form).toBeHidden();
  expect(gateway.saves).toEqual([{ id: alpha.id, body: { scopes: [] }, userId: "personal-one" }]);
});

test("허용 목록에서 사라진 새 기타 권한도 선택 상태와 해제 수단을 유지한다", async ({ page, gateway }) => {
  const extra = "fixture:personal:new-catalog-only-scope";
  gateway.replaceCatalog([...known, extra]);
  await login(page);
  const form = await openForm(page, beta.id);
  await scope(form, extra).check();
  gateway.replaceCatalog(known);
  await refresh(form).click();
  await expect(form).toContainText("현재 내가 부여할 수 없는 권한이 선택되어 있습니다.");
  await expect(scope(form, extra)).toBeChecked();
  await expect(save(form)).toBeDisabled();
  // Once explicitly unchecked this catalog-only choice disappears. A click
  // verifies that user action without waiting for an unchecked, detached input.
  await scope(form, extra).click();
  await expect(scope(form, extra)).toHaveCount(0);
  await expect(save(form)).toBeEnabled();
  await save(form).click();
  await expect(form).toBeHidden();
  expect(gateway.saves).toEqual([{ id: beta.id, body: { scopes: ["models:read"] }, userId: "personal-one" }]);
});

test("개인 권한 목록 실패는 요청 ID와 재시도를 제공하고 현재 초안을 지우지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const form = await openForm(page);
  await scope(form, "chat:completion").check();
  gateway.failReads();
  await refresh(form).click();
  await expect(form.getByRole("alert")).toContainText("req-personal-catalog");
  await expect(save(form)).toBeDisabled();
  await expect(scope(form, extension)).toBeChecked();
  gateway.succeedReads();
  await form.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(save(form)).toBeEnabled();
  await expect(scope(form, "chat:completion")).toBeChecked();
  expect(gateway.saves).toEqual([]);
});

test("개인 권한 저장 실패는 입력·요청 ID를 유지하고 수정한 재시도만 전송한다", async ({ page, gateway }) => {
  await login(page);
  gateway.failSaves();
  const form = await openForm(page);
  await scope(form, "chat:completion").check();
  await save(form).click();
  await expect(form.getByRole("alert")).toContainText("req-personal-save");
  const submitted = structuredClone(gateway.saves);
  await scope(form, "chat:completion").uncheck();
  await scope(form, "embeddings:create").check();
  await close(page, form, "Escape");
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(scope(form, "embeddings:create")).toBeChecked();
  expect(gateway.saves).toEqual(submitted);
  gateway.succeedSaves();
  await save(form).click();
  await expect(form).toBeHidden();
  expect(gateway.saves).toEqual([
    ...submitted,
    {
      id: alpha.id,
      body: { scopes: ["embeddings:create", extension, "models:read"] },
      userId: "personal-one",
    },
  ]);
});

test("개인 권한 저장 중 입력·갱신·닫기를 잠그고 중복 전송을 막는다", async ({ page, gateway }) => {
  await login(page);
  const form = await openForm(page);
  await scope(form, "chat:completion").check();
  gateway.holdSaves();
  await save(form).evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect.poll(() => gateway.saves.length).toBe(1);
  const snapshot = structuredClone(gateway.saves);
  for (const checkbox of await form.getByRole("checkbox").all()) await expect(checkbox).toBeDisabled();
  await expect(refresh(form)).toBeDisabled();
  await expect(form.getByRole("button", { name: "취소", exact: true })).toBeDisabled();
  for (const method of ["Escape", "외부 클릭", "닫기 버튼"] as const) {
    await close(page, form, method);
    await expect(form).toBeVisible();
    await expect(guard(page)).toBeHidden();
  }
  await form.locator("form").evaluate((element) => (element as HTMLFormElement).requestSubmit());
  expect(gateway.saves).toEqual(snapshot);
  gateway.releaseSaves();
  await expect(form).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});

test("개인 권한 편집 중 탭 경로 이동은 유지·폐기를 묻는다", async ({ page, gateway }) => {
  await login(page);
  const form = await openForm(page);
  await scope(form, "chat:completion").check();
  // Exercise the real router callback behind the modal's inert background.
  const navigate = () =>
    page
      .getByRole("tab", { name: "내 홈", exact: true, includeHidden: true })
      .evaluate((element) => (element as HTMLElement).click());
  await navigate();
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(page).toHaveURL(/\/me\?tab=keys$/u);
  await expect(scope(form, "chat:completion")).toBeChecked();
  await navigate();
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(page).toHaveURL(/\/me$/u);
  await expect(page.locator("#main-content")).toBeFocused();
  expect(gateway.saves).toEqual([]);
});

test("개인 권한 초안은 실제 뒤로가기 취소에 남고 명시적 폐기 후 이전 화면으로 간다", async ({
  page,
  gateway,
}) => {
  await login(page, "/app/me?tab=requests");
  await page.getByRole("complementary", { name: "주 메뉴" }).getByRole("link", { name: /내 홈/u }).click();
  await page.getByRole("tab", { name: "내 키·연결", exact: true }).click();
  const form = await openForm(page);
  await scope(form, "chat:completion").check();
  await page.goBack();
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(scope(form, "chat:completion")).toBeChecked();
  await page.goBack();
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(page).toHaveURL(/\/me\?tab=requests$/u);
  await expect(form).toBeHidden();
  expect(gateway.saves).toEqual([]);
});

test("개인 권한 초안의 실제 새로고침 경고는 취소 가능하며 폐기 후 해제된다", async ({ page, gateway }) => {
  await login(page);
  const form = await openForm(page);
  await scope(form, "chat:completion").check();
  const event = page.waitForEvent("dialog");
  await page.evaluate(() => {
    setTimeout(() => window.location.reload(), 0);
  });
  const native = await event;
  expect(native.type()).toBe("beforeunload");
  await native.dismiss();
  await expect(scope(form, "chat:completion")).toBeChecked();
  await close(page, form, "취소");
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  let extra = 0;
  page.on("dialog", async (dialog) => {
    extra += 1;
    await dialog.dismiss();
  });
  await page.reload();
  await expect(trigger(page)).toBeVisible();
  expect(extra).toBe(0);
  expect(gateway.saves).toEqual([]);
});

test("다른 탭 로그아웃은 개인 초안·확인을 응답 완료 전에 폐기한다", async ({ page, context, gateway }) => {
  await login(page);
  const other = await context.newPage();
  await login(other);
  const form = await openForm(page);
  await scope(form, "chat:completion").check();
  await close(page, form, "Escape");
  gateway.holdLogouts();
  await other.getByLabel("사용자 메뉴").click();
  await other.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect.poll(gateway.logouts).toBe(1);
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await expect(form).toBeHidden();
  await expect(guard(page)).toBeHidden();
  expect(gateway.logoutResponses()).toBe(0);
  gateway.releaseLogouts();
  await expect.poll(gateway.logoutResponses).toBe(1);
  await signIn(page);
  const fresh = await openForm(page);
  await expect(scope(fresh, "chat:completion")).not.toBeChecked();
  await noStoredDraft(page);
});

for (const outcome of ["성공", "실패"] as const) {
  test(`이전 개인 저장의 늦은 ${outcome} 응답은 새 계정의 편집 가능한 초안을 덮어쓰지 않는다`, async ({
    page,
    context,
    gateway,
  }) => {
    await login(page);
    const other = await context.newPage();
    await login(other);
    const old = await openForm(page);
    await scope(old, "chat:completion").check();
    if (outcome === "실패") gateway.failSaves();
    gateway.holdSaves();
    await save(old).click();
    await expect.poll(() => gateway.saves.length).toBe(1);
    await other.getByLabel("사용자 메뉴").click();
    await other.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
    await signIn(page, secondEmail);
    const fresh = await openForm(page, second.id);
    await scope(fresh, "embeddings:create").check();
    const reads = gateway.reads();
    const response = page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === `/me/keys/${alpha.id}` && value.request().method() === "PATCH",
    );
    gateway.releaseSaves();
    await (await response).finished();
    await page.waitForTimeout(300);
    await expect(fresh).toBeVisible();
    await expect(fresh).toContainText(second.name);
    await expect(scope(fresh, "embeddings:create")).toBeChecked();
    await expect(scope(fresh, "chat:completion")).not.toBeChecked();
    await expect(fresh.getByRole("alert")).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    expect(gateway.reads()).toBe(reads);
    expect(gateway.saves).toHaveLength(1);
    await close(page, fresh, "Escape");
    await guard(page).getByRole("button", { name: "계속 편집" }).click();
    gateway.succeedSaves();
    await save(fresh).click();
    await expect(fresh).toBeHidden();
    expect(gateway.saves[1]).toEqual({
      id: second.id,
      body: { scopes: ["embeddings:create", "models:read"] },
      userId: "personal-two",
    });
    await expect(trigger(page, second.id)).toBeFocused();
    await noStoredDraft(page);
  });
}

test("개인 키 행이 사라지면 편집 종료 포커스는 다른 키가 아닌 본문으로 간다", async ({ page, gateway }) => {
  await login(page);
  const form = await openForm(page);
  gateway.replaceKeys([beta, empty, second]);
  await refresh(form).click();
  await expect(save(form)).toBeEnabled();
  await close(page, form, "취소");
  await expect(form).toBeHidden();
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(trigger(page, beta.id)).not.toBeFocused();
});

test("390px 다크 개인 권한 편집과 폐기 확인은 키보드·접근성·넘침 검사를 통과한다", async ({
  page,
  gateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page);
  // Long readonly permission badges must not widen the underlying personal list.
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= window.innerWidth &&
        document.body.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const form = await openForm(page);
  await scope(form, "chat:completion").focus();
  await page.keyboard.press("Space");
  await expect(scope(form, "chat:completion")).toBeChecked();
  await expect(save(form)).toBeInViewport();
  expect(await form.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("me-key-scope-mobile-dark.png") });
  await page.keyboard.press("Escape");
  const alert = guard(page);
  await expect(alert.getByRole("button", { name: "계속 편집" })).toBeFocused();
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Tab");
    expect(await alert.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    bodyMargin: getComputedStyle(document.body).margin,
    bodyPadding: getComputedStyle(document.body).padding,
    overflowing: Array.from(document.querySelectorAll("body *"))
      .flatMap((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.right > window.innerWidth || rect.left < 0)
          ? [
              {
                tag: element.tagName,
                className: element.getAttribute("class"),
                left: rect.left,
                right: rect.right,
                width: rect.width,
                client: element.clientWidth,
                scroll: element.scrollWidth,
                whiteSpace: getComputedStyle(element).whiteSpace,
              },
            ]
          : [];
      })
      .slice(0, 20),
  }));
  if (layout.document > layout.viewport || layout.body > layout.viewport) {
    // Geometry only, from public fixtures; never serialize DOM text or values.
    await info.attach("mobile-overflow.json", {
      body: JSON.stringify(layout),
      contentType: "application/json",
    });
  }
  expect(layout.document).toBeLessThanOrEqual(layout.viewport);
  expect(layout.body).toBeLessThanOrEqual(layout.viewport);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("me-key-scope-guard-mobile-dark.png") });
  await page.keyboard.press("Escape");
  await expect(alert).toBeHidden();
  await expect(scope(form, "chat:completion")).toBeChecked();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await expect(alert.getByRole("button", { name: "변경 버리기" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(trigger(page)).toBeFocused();
  expect(gateway.saves).toEqual([]);
});
