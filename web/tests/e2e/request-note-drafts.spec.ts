import { expect, type Locator, type Page } from "@playwright/test";
import {
  firstEmail,
  firstId,
  initial,
  masked,
  readerEmail,
  secondEmail,
  secondId,
  targetUrl,
  test,
  xviewUrl,
} from "../fixtures/request-note-gateway";

// Synthetic browser UX/request coverage, not real Go authorization or note storage proof.
const draftText = "브라우저 전용 미저장 초안 987654";
const form = (page: Page) => page.getByRole("dialog", { name: "요청 메모·태그 수정", exact: true });
const deletion = (page: Page) => page.getByRole("dialog", { name: "요청 태그·메모 삭제", exact: true });
const card = (page: Page) =>
  page
    .getByRole("heading", { name: "운영 메모·태그", exact: true, includeHidden: true })
    .locator("xpath=ancestor::section[1]");
const trigger = (page: Page) => card(page).getByRole("button", { name: "메모·태그 수정", exact: true });
const save = (dialog: Locator) => dialog.getByRole("button", { name: /^(메모·태그 저장|저장 중)$/u });
const guard = (page: Page) => page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" });
const refresh = (dialog: Locator) =>
  dialog.getByRole("button", { name: "현재 메모·태그 다시 조회", exact: true });
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
async function showNote(page: Page, id = firstId) {
  await page.getByRole("button", { name: `${id} 호출 상세 열기`, exact: true }).click();
  await page.getByRole("button", { name: "원인 설명 열기", exact: true }).click();
  await expect(card(page)).toBeVisible();
}
async function open(page: Page) {
  await expect(trigger(page)).toBeEnabled();
  await trigger(page).click();
  await expect(form(page)).toBeVisible();
  return form(page);
}
async function editNote(dialog: Locator, text = draftText) {
  await dialog.getByLabel("메모 변경 방법", { exact: true }).selectOption("replace");
  await dialog.getByLabel("새 메모", { exact: true }).fill(text);
}
async function submitDirectly(dialog: Locator) {
  await dialog.locator("form").evaluate((element) => (element as HTMLFormElement).requestSubmit());
}
async function refreshRuntime(page: Page) {
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function noStoredDraft(page: Page) {
  expect(
    await page.evaluate(
      (text) =>
        [localStorage, sessionStorage].every((storage) =>
          Object.values(storage).every((value) => !String(value).includes(text)),
        ),
      draftText,
    ),
  ).toBe(true);
  expect(page.url()).not.toContain(encodeURIComponent(draftText));
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

test("원문 권한 없는 작성자도 확인된 메모를 PATCH하며 유지 필드는 전송하지 않는다", async ({
  page,
  gateway,
}) => {
  gateway.replaceNote(masked);
  await login(page);
  await showNote(page);
  await expect(page.getByRole("button", { name: "분석 실행", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "재실행", exact: true })).toBeDisabled();
  const dialog = await open(page);
  await expect(dialog.getByLabel("메모 변경 방법", { exact: true })).toHaveValue("preserve");
  await expect(dialog.getByLabel("태그 변경 방법", { exact: true })).toHaveValue("preserve");
  await expect(dialog.getByLabel("새 메모", { exact: true })).toHaveCount(0);
  // Keep the post-commit read pending so the original trigger is definitely
  // disabled when close restores focus; this must not depend on response timing.
  gateway.holdReads();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(gateway.writes).toEqual([
    { method: "PATCH", id: firstId, body: { preserve_fields: ["note", "tags"] }, userId: "note-one" },
  ]);
  // The follow-up read can disable the original trigger. A safe fallback must
  // stay in the surviving detail Sheet, never on the obscured main page/body.
  const parent = page.getByRole("dialog", { name: "LLM 호출 상세", exact: true });
  await expect
    .poll(() =>
      parent.evaluate((element) => {
        const active = document.activeElement;
        return (
          active instanceof HTMLElement &&
          active.isConnected &&
          element.contains(active) &&
          active.getClientRects().length > 0 &&
          !active.matches(":disabled") &&
          !active.closest('[aria-hidden="true"], [inert]')
        );
      }),
    )
    .toBe(true);
  await page.keyboard.press("Tab");
  expect(await parent.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  gateway.releaseReads();
  await expect(trigger(page)).toBeEnabled();
});

for (const field of ["메모", "태그"] as const) {
  test(`마스킹된 ${field} 전체 교체는 빈 입력에서 시작하고 반대 필드는 유지한다`, async ({
    page,
    gateway,
  }) => {
    gateway.replaceNote(masked);
    await login(page);
    await showNote(page);
    const dialog = await open(page);
    await dialog.getByLabel(`${field} 변경 방법`, { exact: true }).selectOption("replace");
    const input = dialog.getByLabel(`새 ${field}`, { exact: true });
    await expect(input).toHaveValue("");
    await save(dialog).click();
    await expect(input).toBeFocused();
    expect(gateway.writes).toEqual([]);
    await input.fill(field === "메모" ? " 새 운영 설명 " : " 지연, 재현필요 ");
    await save(dialog).click();
    await expect(dialog).toBeHidden();
    expect(gateway.writes[0]?.body).toEqual(
      field === "메모"
        ? { preserve_fields: ["tags"], note: "새 운영 설명" }
        : { preserve_fields: ["note"], tags: ["지연", "재현필요"] },
    );
  });
  test(`${field} 비우기는 마스킹 원본 삭제를 경고하고 명시적 빈 값만 PATCH한다`, async ({
    page,
    gateway,
  }) => {
    gateway.replaceNote(masked);
    await login(page);
    await showNote(page);
    const dialog = await open(page);
    await dialog.getByLabel(`${field} 변경 방법`, { exact: true }).selectOption("clear");
    await expect(dialog).toContainText("마스킹된 원본도 보존하지 않습니다.");
    await save(dialog).click();
    await expect(dialog).toBeHidden();
    expect(gateway.writes[0]?.body).toEqual(
      field === "메모" ? { preserve_fields: ["tags"], note: "" } : { preserve_fields: ["note"], tags: [] },
    );
  });
}

test("전체 교체는 정리 후 비는 메모·태그를 저장하지 않고 명시적 비우기와 구별한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await showNote(page);
  const dialog = await open(page);
  await dialog.getByLabel("메모 변경 방법", { exact: true }).selectOption("replace");
  const noteInput = dialog.getByLabel("새 메모", { exact: true });
  await dialog.locator("form").evaluate((element) => {
    element.setAttribute("data-fixture-submits", "0");
    element.addEventListener("submit", () =>
      element.setAttribute(
        "data-fixture-submits",
        String(Number(element.getAttribute("data-fixture-submits")) + 1),
      ),
    );
  });
  const nativeSubmissions = async () =>
    Number(await dialog.locator("form").getAttribute("data-fixture-submits"));
  const clickInvalidSave = async () => {
    const submitted = await nativeSubmissions();
    await save(dialog).scrollIntoViewIfNeeded();
    const before = await save(dialog).boundingBox();
    expect(before).not.toBeNull();
    // Count the real native submit; never dispatch it or add a second click to
    // hide a blur-validation layout jump between pointerdown and pointerup.
    await save(dialog).click();
    await expect.poll(nativeSubmissions).toBe(submitted + 1);
    await expect(save(dialog)).toBeEnabled();
    expect((await save(dialog).boundingBox())?.y).toBe(before?.y);
  };
  for (const value of ["\u0085", " \u0085\t"]) {
    await noteInput.fill(value);
    await clickInvalidSave();
    await expect(dialog).toContainText("새 메모를 입력하거나 ‘비우기’를 선택하세요.");
    await expect(noteInput).toBeFocused();
    await expect(noteInput).toHaveValue(value);
    expect(gateway.writes).toEqual([]);
  }
  await dialog.getByLabel("메모 변경 방법", { exact: true }).selectOption("preserve");
  await dialog.getByLabel("태그 변경 방법", { exact: true }).selectOption("replace");
  const input = dialog.getByLabel("새 태그", { exact: true });
  for (const value of [", , ,", "# , #", "\u0085", "#\uFEFF"]) {
    await input.fill(value);
    await clickInvalidSave();
    await expect(dialog).toContainText("새 태그를 입력하거나 ‘비우기’를 선택하세요.");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(value);
    expect(gateway.writes).toEqual([]);
  }
  await input.fill("새태그");
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(gateway.writes[0]?.body).toEqual({ preserve_fields: ["note"], tags: ["새태그"] });
  const clear = await open(page);
  await clear.getByLabel("메모 변경 방법", { exact: true }).selectOption("clear");
  await expect(clear).toContainText("마스킹된 원본도 보존하지 않습니다.");
  await save(clear).click();
  await expect(clear).toBeHidden();
  expect(gateway.writes).toHaveLength(2);
  expect(gateway.writes[1]?.body).toEqual({ preserve_fields: ["tags"], note: "" });
});

for (const [name, note] of [
  ["태그만 있는 행", { ...initial, note: "" }],
  ["완전히 빈 행", { ...initial, note: "", tags: [] }],
] as const) {
  test(`${name}도 exists=true이면 확인 후 DELETE할 수 있다`, async ({ page, gateway }) => {
    gateway.replaceNote(note);
    await login(page);
    await showNote(page);
    await card(page).getByRole("button", { name: "태그·메모 삭제", exact: true }).click();
    const dialog = deletion(page);
    await expect(dialog).toContainText("요청 로그는 삭제하지 않습니다.");
    await expect(dialog).toContainText("메모가 비어 있어도 저장된 태그를 함께 삭제합니다.");
    await dialog.getByRole("button", { name: "태그·메모 삭제", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(card(page)).toContainText("저장된 메모·태그가 없습니다.");
    await expect(card(page).getByRole("button", { name: "태그·메모 삭제", exact: true })).toBeDisabled();
    expect(gateway.writes).toEqual([{ method: "DELETE", id: firstId, body: null, userId: "note-one" }]);
  });
}

test("exists=false는 새 메모를 만들 수 있지만 행 삭제는 허용하지 않는다", async ({ page, gateway }) => {
  gateway.replaceNote({ ...initial, exists: false, note: "", tags: [] });
  await login(page);
  await showNote(page);
  await expect(card(page)).toContainText("저장된 메모·태그가 없습니다.");
  await expect(card(page).getByRole("button", { name: "태그·메모 삭제", exact: true })).toBeDisabled();
  const dialog = await open(page);
  await editNote(dialog);
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(gateway.writes).toHaveLength(1);
});

test("조회 중과 오류는 빈 행으로 취급하지 않고 요청 ID와 재조회로 복구한다", async ({ page, gateway }) => {
  gateway.holdReads();
  await login(page);
  await showNote(page);
  await expect(trigger(page)).toBeDisabled();
  await expect(card(page)).not.toContainText("저장된 메모·태그가 없습니다.");
  gateway.releaseReads();
  await expect(trigger(page)).toBeEnabled();
  gateway.failReads();
  await card(page).getByRole("button", { name: "메모·태그 새로고침", exact: true }).click();
  await expect(card(page)).toContainText("req-note-read");
  await expect(trigger(page)).toBeDisabled();
  gateway.succeedReads();
  await card(page).getByRole("button", { name: "메모·태그 새로고침", exact: true }).click();
  await expect(trigger(page)).toBeEnabled();
  expect(gateway.writes).toEqual([]);
});

for (const [name, response] of [
  ["exists 누락", { ...initial, exists: undefined }],
  ["redacted_fields 누락", { ...initial, redacted_fields: undefined }],
  ["null", null],
  ["잘못된 exists", { ...initial, exists: "true" }],
  ["잘못된 마스킹 필드", { ...initial, redacted_fields: ["other"] }],
  ["중복 마스킹 필드", { ...initial, redacted_fields: ["note", "note"] }],
  ["다른 요청 ID", { ...initial, request_id: secondId }],
] as const) {
  test(`${name} 응답은 확인된 조회로 승격되지 않고 편집·삭제를 막는다`, async ({ page, gateway }) => {
    gateway.replaceNote(response);
    await login(page);
    await showNote(page);
    await expect(card(page)).toContainText("현재 메모·태그를 확인하기 전에는 변경할 수 없습니다.");
    if (name !== "다른 요청 ID") await expect(card(page)).toContainText("req-note-read");
    await expect(trigger(page)).toBeDisabled();
    await expect(card(page).getByRole("button", { name: "태그·메모 삭제", exact: true })).toBeDisabled();
    await expect(card(page)).not.toContainText("저장된 메모·태그가 없습니다.");
    expect(gateway.writes).toEqual([]);
  });
}

test("열린 초안은 재조회에서 기준값을 유지하며 미확인·오류 동안 직접 submit도 막는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await showNote(page);
  const dialog = await open(page);
  await editNote(dialog);
  gateway.replaceNote({ ...initial, note: "다른 관리자의 변경", tags: ["새 태그"] });
  gateway.holdReads();
  const reads = gateway.reads();
  await refresh(dialog).click();
  await expect.poll(gateway.reads).toBeGreaterThan(reads);
  await expect(save(dialog)).toBeDisabled();
  await submitDirectly(dialog);
  expect(gateway.writes).toEqual([]);
  gateway.releaseReads();
  await expect(save(dialog)).toBeEnabled();
  await expect(dialog.getByLabel("새 메모", { exact: true })).toHaveValue(draftText);
  await expect(dialog).toContainText("기존 메모: 기존 운영 메모");
  await expect(dialog).not.toContainText("다른 관리자의 변경");
  gateway.failReads();
  await refresh(dialog).click();
  await expect(dialog).toContainText("req-note-read");
  await submitDirectly(dialog);
  expect(gateway.writes).toEqual([]);
  gateway.succeedReads();
  await refresh(dialog).click();
  await expect(save(dialog)).toBeEnabled();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(gateway.writes[0]?.body).toEqual({ preserve_fields: ["tags"], note: draftText });
  await expect(card(page)).toContainText("새 태그");
  await noStoredDraft(page);
});

test("명령 팔레트의 전체 조회 무효화도 열린 메모 저장을 막고 초안을 보존한다", async ({ page, gateway }) => {
  await login(page);
  await showNote(page);
  const dialog = await open(page);
  await editNote(dialog);
  gateway.holdReads();
  const reads = gateway.reads();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "메뉴 검색", exact: true }).fill("지금 새로고침");
  await page.getByRole("option", { name: /지금 새로고침/u }).click();
  await expect.poll(gateway.reads).toBeGreaterThan(reads);
  await expect(save(dialog)).toBeDisabled();
  await submitDirectly(dialog);
  expect(gateway.writes).toEqual([]);
  gateway.releaseReads();
  await expect(save(dialog)).toBeEnabled();
  await expect(dialog.getByLabel("새 메모", { exact: true })).toHaveValue(draftText);
});

for (const version of ["v0.86.15"]) {
  test(`서버 버전 ${version ?? "누락"}은 새 편집 계약을 확인하지 못해 쓰기를 막는다`, async ({
    page,
    gateway,
  }) => {
    gateway.setVersion(version);
    await login(page);
    await showNote(page);
    await expect(card(page)).toContainText("v0.86.16");
    await expect(trigger(page)).toBeDisabled();
    await expect(card(page).getByRole("link", { name: "기존 관리자에서 요청 열기" })).toHaveAttribute(
      "href",
      "/admin#/requests",
    );
    expect(gateway.writes).toEqual([]);
  });
}

for (const version of ["invalid-version", undefined]) {
  test(`서버 버전 ${version ?? "누락"}은 상위 화면부터 기존 화면 안내로 전환하며 메모 쓰기를 만들지 않는다`, async ({
    page,
    gateway,
  }) => {
    gateway.setVersion(version);
    await login(page);
    await expect(
      page.getByRole("heading", { name: "이 기능은 안정 운영 화면에서 제공됩니다.", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "기존 화면에서 LLM 관측 열기" })).toHaveAttribute(
      "href",
      "/admin#/llm",
    );
    await expect(form(page)).toBeHidden();
    expect(gateway.reads()).toBe(0);
    expect(gateway.writes).toEqual([]);
  });
}

for (const kind of ["권한", "버전"] as const) {
  test(`초안 작성 뒤 최신 ${kind}이 변경되면 입력을 유지하고 실제 submit을 차단한다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await showNote(page);
    const dialog = await open(page);
    await editNote(dialog);
    if (kind === "권한") gateway.setWritable(false);
    else gateway.setVersion("v0.86.15");
    await refreshRuntime(page);
    await expect(save(dialog)).toBeDisabled();
    await expect(dialog.getByLabel("새 메모", { exact: true })).toHaveValue(draftText);
    await submitDirectly(dialog);
    expect(gateway.writes).toEqual([]);
  });
}

test("읽기 전용 계정은 확인된 데이터도 수정·삭제할 수 없다", async ({ page, gateway }) => {
  await login(page, readerEmail);
  await showNote(page);
  await expect(card(page)).toContainText(initial.note);
  await expect(trigger(page)).toBeDisabled();
  await expect(card(page).getByRole("button", { name: "태그·메모 삭제", exact: true })).toBeDisabled();
  // DOM tampering alone does not prove React dispatches a disabled handler;
  // latest-permission submit guards are exercised above and in component tests.
  await trigger(page).evaluate((element) => {
    element.removeAttribute("disabled");
    (element as HTMLButtonElement).click();
  });
  await expect(form(page)).toBeHidden();
  expect(gateway.writes).toEqual([]);
});

test("PATCH 405는 입력·요청 ID를 유지하며 PUT·POST 대체 저장 없이 명시적으로 재시도한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await showNote(page);
  const dialog = await open(page);
  await editNote(dialog);
  gateway.failWrites(405);
  await save(dialog).click();
  await expect(dialog.getByRole("alert")).toContainText("req-note-write");
  await expect(dialog).toContainText("다른 저장 방식으로 자동 재전송하지 않습니다.");
  await expect(dialog.getByLabel("새 메모", { exact: true })).toHaveValue(draftText);
  expect(gateway.writes).toHaveLength(1);
  const first = structuredClone(gateway.writes);
  await dialog.getByLabel("새 메모", { exact: true }).fill("수정 후 재시도");
  expect(gateway.writes).toEqual(first);
  gateway.succeedWrites();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(gateway.writes.map(({ method }) => method)).toEqual(["PATCH", "PATCH"]);
  expect(gateway.writes[1]?.body).toEqual({ preserve_fields: ["tags"], note: "수정 후 재시도" });
});

test("진행 중 모든 입력·닫기·재조회가 잠기고 연속 submit도 한 번만 전송한다", async ({ page, gateway }) => {
  await login(page);
  await showNote(page);
  const dialog = await open(page);
  await editNote(dialog);
  gateway.holdWrites();
  await save(dialog).click();
  await expect.poll(() => gateway.writes.length).toBe(1);
  await expect(dialog.getByLabel("새 메모", { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("태그 변경 방법", { exact: true })).toBeDisabled();
  await expect(refresh(dialog)).toBeDisabled();
  await expect(save(dialog)).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "대화상자 닫기", exact: true }).click();
  await expect(dialog).toBeVisible();
  const parent = page.getByRole("dialog", { name: "LLM 호출 상세", exact: true, includeHidden: true });
  await expect(parent.getByRole("button", { name: "접기", exact: true, includeHidden: true })).toBeDisabled();
  await parent
    .getByRole("button", { name: "패널 닫기", exact: true, includeHidden: true })
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect(dialog).toBeVisible();
  await submitDirectly(dialog);
  await submitDirectly(dialog);
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  await expect(dialog).toBeVisible();
  await expect(guard(page)).toBeHidden();
  expect(gateway.writes).toHaveLength(1);
  gateway.releaseWrites();
  await expect(dialog).toBeHidden();
  expect(gateway.writes).toHaveLength(1);
});

for (const method of ["Escape", "취소", "외부 클릭", "닫기 버튼"] as const) {
  test(`${method}은 미저장 변경을 확인하고 계속 편집·폐기·포커스 복원을 제공한다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await showNote(page);
    const dialog = await open(page);
    await editNote(dialog);
    const close = async () => {
      if (method === "Escape") await page.keyboard.press("Escape");
      else if (method === "외부 클릭") await page.mouse.click(5, 5);
      else
        await dialog
          .getByRole("button", { name: method === "취소" ? "취소" : "대화상자 닫기", exact: true })
          .click();
    };
    await close();
    await guard(page).getByRole("button", { name: "계속 편집" }).click();
    await expect(dialog.getByLabel("새 메모", { exact: true })).toHaveValue(draftText);
    await close();
    await guard(page).getByRole("button", { name: "변경 버리기" }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    expect(gateway.writes).toEqual([]);
    await noStoredDraft(page);
  });
}

for (const parentAction of ["접기", "패널 닫기"] as const) {
  test(`LLM 상위 ${parentAction}도 초안을 확인한 뒤에만 실행한다`, async ({ page, gateway }) => {
    await login(page);
    await showNote(page);
    const dialog = await open(page);
    await editNote(dialog);
    const parent = page.getByRole("dialog", { name: "LLM 호출 상세", exact: true, includeHidden: true });
    const action = parent.getByRole("button", { name: parentAction, exact: true, includeHidden: true });
    // Invoke the real parent handler behind the modal; it remains inert for a
    // physical pointer, so this proves handler coordination rather than reachability.
    const leave = () => action.evaluate((element) => (element as HTMLButtonElement).click());
    await leave();
    await guard(page).getByRole("button", { name: "계속 편집" }).click();
    await expect(dialog.getByLabel("새 메모", { exact: true })).toHaveValue(draftText);
    await leave();
    await guard(page).getByRole("button", { name: "변경 버리기" }).click();
    await expect(dialog).toBeHidden();
    if (parentAction === "접기")
      await expect(parent.getByRole("button", { name: "원인 설명 열기", exact: true })).toBeFocused();
    else {
      await expect(parent).toBeHidden();
      await expect(
        page.getByRole("button", { name: `${firstId} 호출 상세 열기`, exact: true }),
      ).toBeFocused();
    }
    expect(gateway.writes).toEqual([]);
  });
}

test("실제 SPA 이동과 뒤로가기는 미저장 초안을 확인한다", async ({ page, gateway }) => {
  await login(page, firstEmail, xviewUrl);
  await page
    .getByRole("complementary", { name: "주 메뉴" })
    .getByRole("link", { name: /LLM 관측/u })
    .click();
  await page.getByRole("tab", { name: /평가/u }).click();
  await showNote(page);
  const dialog = await open(page);
  await editNote(dialog);
  await page.goBack();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(dialog.getByLabel("새 메모", { exact: true })).toHaveValue(draftText);
  const link = page.getByRole("link", { name: /XView 실시간/u, includeHidden: true }).first();
  await link.evaluate((element) => (element as HTMLAnchorElement).click());
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(page).toHaveURL(/\/observability\/xview$/u);
  await expect(dialog).toBeHidden();
  expect(gateway.writes).toEqual([]);
});

test("실제 새로고침 경고 취소는 초안을 유지하고 폐기 후 재조회에는 경고하지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await showNote(page);
  const dialog = await open(page);
  await editNote(dialog);
  const waiting = page.waitForEvent("dialog");
  await page.evaluate(() => {
    setTimeout(() => location.reload(), 0);
  });
  const native = await waiting;
  expect(native.type()).toBe("beforeunload");
  await native.dismiss();
  await expect(dialog.getByLabel("새 메모", { exact: true })).toHaveValue(draftText);
  await page.keyboard.press("Escape");
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  let warnings = 0;
  page.on("dialog", async (event) => {
    warnings += 1;
    await event.dismiss();
  });
  await page.reload();
  await showNote(page);
  await expect(trigger(page)).toBeEnabled();
  expect(warnings).toBe(0);
  expect(gateway.writes).toEqual([]);
});

test("XView에서 다른 요청 선택과 상위 설명 패널 닫기도 고정 초안을 먼저 확인한다", async ({
  page,
  gateway,
}) => {
  await login(page, firstEmail, xviewUrl);
  await page.getByRole("button", { name: "최근 25건 선택", exact: true }).click();
  await page.getByRole("button", { name: `${firstId} 원인 설명 열기`, exact: true }).click();
  const dialog = await open(page);
  await editNote(dialog);
  const switchRequest = page.getByRole("button", {
    name: `${secondId} 원인 설명 열기`,
    exact: true,
    includeHidden: true,
  });
  await switchRequest.evaluate((element) => (element as HTMLButtonElement).click());
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(dialog).toContainText(firstId);
  await switchRequest.evaluate((element) => (element as HTMLButtonElement).click());
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(card(page)).toContainText("두 번째 요청 메모");
  const fresh = await open(page);
  await expect(fresh).toContainText(secondId);
  await editNote(fresh);
  const parent = page.getByRole("dialog", { name: "요청 원인 설명", exact: true, includeHidden: true });
  await parent
    .getByRole("button", { name: "패널 닫기", exact: true, includeHidden: true })
    .evaluate((element) => (element as HTMLButtonElement).click());
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(parent).toBeHidden();
  await expect(switchRequest).toBeFocused();
  await expect(page.getByRole("dialog", { name: "선택한 요청 2건", exact: true })).toBeVisible();
  expect(gateway.writes).toEqual([]);
});

test("저장 성공 뒤 GET 실패는 재저장을 요구하지 않고 조회 복구와 구분한다", async ({ page, gateway }) => {
  await login(page);
  await showNote(page);
  const dialog = await open(page);
  await editNote(dialog);
  gateway.failReadAfterSave();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(card(page)).toContainText("메모·태그 저장은 완료됐습니다.");
  await expect(card(page)).toContainText("req-note-read");
  await expect(trigger(page)).toBeDisabled();
  expect(gateway.writes).toHaveLength(1);
  gateway.succeedReads();
  await card(page).getByRole("button", { name: "메모·태그 새로고침", exact: true }).click();
  await expect(trigger(page)).toBeEnabled();
  await expect(card(page)).not.toContainText("메모·태그 저장은 완료됐습니다.");
  gateway.failReads();
  await card(page).getByRole("button", { name: "메모·태그 새로고침", exact: true }).click();
  await expect(card(page)).toContainText("req-note-read");
  await expect(card(page)).not.toContainText("메모·태그 저장은 완료됐습니다.");
  expect(gateway.writes).toHaveLength(1);
});

test("다른 탭 로그아웃은 응답을 기다리지 않고 초안·폐기 확인을 지운다", async ({
  page,
  context,
  gateway,
}) => {
  await login(page);
  const other = await context.newPage();
  await login(other);
  await showNote(page);
  const dialog = await open(page);
  await editNote(dialog);
  await page.keyboard.press("Escape");
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
  test(`이전 세션의 늦은 ${outcome}은 새 계정의 메모 초안·조회·알림을 바꾸지 않는다`, async ({
    page,
    context,
    gateway,
  }) => {
    await login(page);
    const other = await context.newPage();
    await login(other);
    await showNote(page);
    const old = await open(page);
    await editNote(old, "이전 세션 메모");
    if (outcome === "실패") gateway.failWrites();
    gateway.holdWrites();
    await save(old).click();
    await expect.poll(() => gateway.writes.length).toBe(1);
    await other.getByLabel("사용자 메뉴").click();
    await other.getByRole("button", { name: "로그아웃", exact: true }).click();
    await signIn(page, secondEmail);
    await showNote(page);
    const fresh = await open(page);
    await editNote(fresh, "새 세션의 고정 초안");
    const reads = gateway.reads();
    const response = page.waitForResponse(
      (value) => value.url().endsWith(`/requests/${firstId}/note`) && value.request().method() === "PATCH",
    );
    gateway.releaseWrites();
    await (await response).finished();
    await page.waitForTimeout(500);
    await expect(fresh).toBeVisible();
    await expect(fresh.getByLabel("새 메모", { exact: true })).toHaveValue("새 세션의 고정 초안");
    await expect(save(fresh)).toBeEnabled();
    await expect(fresh.getByRole("alert")).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    expect(gateway.reads()).toBe(reads);
    expect(gateway.writes).toHaveLength(1);
    gateway.succeedWrites();
    await save(fresh).click();
    await expect(fresh).toBeHidden();
    expect(gateway.writes[1]).toEqual({
      method: "PATCH",
      id: firstId,
      body: { preserve_fields: ["tags"], note: "새 세션의 고정 초안" },
      userId: "note-two",
    });
  });
}

test("390px 다크 편집·폐기·삭제는 axe·포커스와 엄격한 가로 넘침 검사를 통과한다", async ({
  page,
  gateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  gateway.replaceNote(masked);
  await login(page);
  await showNote(page);
  const dialog = await open(page);
  await editNote(dialog);
  await dialog.getByLabel("태그 변경 방법", { exact: true }).selectOption("clear");
  await noOverflow(page, dialog);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("request-note-mobile-dark.png") });
  await save(dialog).scrollIntoViewIfNeeded();
  await expect(save(dialog)).toBeInViewport();
  await noOverflow(page, dialog);
  await page.screenshot({ path: info.outputPath("request-note-save-mobile-dark.png") });
  await page.keyboard.press("Escape");
  const alert = guard(page);
  await expect(alert.getByRole("button", { name: "계속 편집" })).toBeFocused();
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Tab");
    expect(await alert.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await noOverflow(page, alert);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("request-note-discard-mobile-dark.png") });
  await alert.getByRole("button", { name: "변경 버리기" }).click();
  await expect(trigger(page)).toBeFocused();
  await card(page).getByRole("button", { name: "태그·메모 삭제", exact: true }).click();
  const confirm = deletion(page);
  await noOverflow(page, confirm);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("request-note-delete-mobile-dark.png") });
  await confirm.getByRole("button", { name: "취소", exact: true }).click();
  await expect(card(page).getByRole("button", { name: "태그·메모 삭제", exact: true })).toBeFocused();
  expect(gateway.writes).toEqual([]);
  await noStoredDraft(page);
});
