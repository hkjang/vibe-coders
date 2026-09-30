import { expect, type Locator, type Page } from "@playwright/test";
import {
  evidence,
  firstEmail,
  firstName,
  initial,
  readerEmail,
  secondEmail,
  secondName,
  skill,
  targetUrl,
  test,
} from "../fixtures/skill-fitness-gateway";

// Synthetic UX/request assertions, not real Go permission/storage/promotion proof.
const draftText = "브라우저 전용 적합성 초안 987654";
const form = (page: Page) => page.getByRole("dialog", { name: "스킬 적합성 근거 기록", exact: true });
const sheet = (page: Page, name = firstName) =>
  page.getByRole("dialog", { name, exact: true, includeHidden: true });
const card = (page: Page) =>
  page
    .getByRole("heading", { name: "모델 적합성 근거", exact: true, includeHidden: true })
    .locator("xpath=ancestor::section[1]");
const trigger = (page: Page) => card(page).getByRole("button", { name: "근거 기록", exact: true });
const save = (dialog: Locator) => dialog.getByRole("button", { name: /^(근거 기록 저장|저장 중)$/u });
const reference = (dialog: Locator) => dialog.getByRole("textbox", { name: "참조 ID", exact: true });
const guard = (page: Page) => page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" });
const refresh = (dialog: Locator) => dialog.getByRole("button", { name: "현재 근거 다시 조회", exact: true });
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
async function showFitness(page: Page, name = firstName) {
  await page.getByRole("button", { name: `${name} 상세 열기`, exact: true }).click();
  await sheet(page, name).getByRole("button", { name: "적합성 근거", exact: true }).click();
  await expect(card(page)).toBeVisible();
}
async function open(page: Page) {
  await expect(trigger(page)).toBeEnabled();
  await trigger(page).click();
  await expect(form(page)).toBeVisible();
  return form(page);
}
async function edit(dialog: Locator, ref = "public-run-new") {
  await reference(dialog).fill(ref);
  await dialog.getByRole("textbox", { name: "메모", exact: true }).fill(draftText);
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

test("기본 빈 점수는 0이며 201 빈 시각을 수락하고 승격 없이 새 근거만 기록한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await showFitness(page);
  await expect(card(page).getByRole("cell", { name: "0", exact: true })).toBeVisible();
  const dialog = await open(page);
  await expect(dialog).toContainText("이 건수만으로 승격 가능 여부가 확정되지는 않습니다.");
  await expect(dialog).toContainText("서버는 참조 ID의 존재나 평가 결과를 확인하지 않습니다.");
  await expect(dialog).toContainText("같은 참조를 다시 기록해도 별도 근거로 추가됩니다.");
  await edit(dialog);
  gateway.holdReads();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(gateway.writes).toEqual([
    {
      method: "POST",
      body: {
        skill: firstName,
        kind: "multimodel",
        ref_id: "public-run-new",
        passed: true,
        score: 0,
        note: draftText,
      },
      userId: "fitness-one",
    },
  ]);
  // The post-commit GET is held: disabled original trigger must focus its surviving
  // Sheet, not the obscured main page/body or a detached/replaced DOM element.
  await expect
    .poll(() =>
      sheet(page).evaluate((element) => {
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
  expect(await sheet(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
  gateway.releaseReads();
  await expect(trigger(page)).toBeEnabled();
  await expect(card(page)).toContainText("public-run-new");
  await expect(sheet(page).getByText("초안", { exact: true })).toBeVisible();
});

for (const [kind, label, score] of [
  ["golden", "기준 답안 세트", "-0.25"],
  ["testcase", "테스트 사례", "1e-12"],
] as const) {
  test(`${label}은 유한 점수 ${score}와 실패 선택을 자동 판정 없이 그대로 보낸다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await showFitness(page);
    const dialog = await open(page);
    await edit(dialog);
    await dialog.getByRole("combobox", { name: "근거 종류", exact: true }).selectOption(kind);
    await dialog.getByRole("textbox", { name: "점수", exact: true }).fill(score);
    await dialog.getByRole("checkbox", { name: /^통과/u }).uncheck();
    await save(dialog).click();
    await expect(dialog).toBeHidden();
    expect(gateway.writes[0]?.body).toMatchObject({ kind, passed: false, score: Number(score) });
  });
}

test("중복 참조는 명시적인 두 저장으로 서로 다른 행에 추가되며 기존 근거를 덮어쓰지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await showFitness(page);
  for (let index = 0; index < 2; index += 1) {
    const dialog = await open(page);
    await edit(dialog, evidence.ref_id);
    await save(dialog).click();
    await expect(dialog).toBeHidden();
    await expect(trigger(page)).toBeEnabled();
  }
  expect(gateway.writes).toHaveLength(2);
  await expect(card(page).getByRole("cell", { name: evidence.ref_id, exact: true })).toHaveCount(3);
  await expect(sheet(page).getByText("초안", { exact: true })).toBeVisible();
});

test("필수 참조와 숫자 검증은 첫 물리 클릭을 실제 submit으로 처리하고 오류 필드에 포커스한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await showFitness(page);
  const dialog = await open(page);
  await dialog.locator("form").evaluate((element) => {
    const form = element as HTMLFormElement;
    form.dataset.nativeSubmits = "0";
    form.addEventListener("submit", () => {
      form.dataset.nativeSubmits = String(Number(form.dataset.nativeSubmits) + 1);
    });
  });
  let submits = 0;
  for (const value of ["", "\u0085", " \u0085 \n"]) {
    await reference(dialog).fill(value);
    await save(dialog).scrollIntoViewIfNeeded();
    const before = await save(dialog).boundingBox();
    await save(dialog).click();
    await expect(dialog.locator("form")).toHaveAttribute("data-native-submits", String(++submits));
    await expect(reference(dialog)).toBeFocused();
    expect((await save(dialog).boundingBox())?.y).toBe(before?.y);
    expect(gateway.writes).toEqual([]);
  }
  await reference(dialog).fill("\uFEFFopaque-reference");
  const score = dialog.getByRole("textbox", { name: "점수", exact: true });
  await score.fill("Infinity");
  await save(dialog).click();
  await expect(dialog.locator("form")).toHaveAttribute("data-native-submits", String(submits + 1));
  await expect(score).toBeFocused();
  expect(gateway.writes).toEqual([]);
  await score.fill("0");
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(gateway.writes[0]?.body.ref_id).toBe("\uFEFFopaque-reference");
});

test("조회 중과 실패는 빈 근거가 아니며 요청 ID·명시적 재조회로 복구한다", async ({ page, gateway }) => {
  gateway.holdReads();
  await login(page);
  await showFitness(page);
  await expect(trigger(page)).toBeDisabled();
  await expect(card(page)).not.toContainText("등록된 근거가 없습니다.");
  gateway.releaseReads();
  await expect(trigger(page)).toBeEnabled();
  gateway.failReads();
  await card(page).getByRole("button", { name: "적합성 근거 새로고침", exact: true }).click();
  await expect(card(page)).toContainText("req-fitness-read");
  await expect(trigger(page)).toBeDisabled();
  await expect(card(page)).not.toContainText("등록된 근거가 없습니다.");
  gateway.succeedReads();
  await card(page).getByRole("button", { name: "적합성 근거 새로고침", exact: true }).click();
  await expect(trigger(page)).toBeEnabled();
  expect(gateway.writes).toEqual([]);
});

for (const [name, response] of [
  ["null", null],
  ["통과 건수 누락", { ...initial, passing_count: undefined }],
  ["기준 건수 누락", { ...initial, required: undefined }],
  ["근거 null", { ...initial, evidence: null }],
  ["다른 스킬", { ...initial, skill: secondName }],
  ["다른 스킬의 행", { ...initial, evidence: [{ ...evidence, skill_name: secondName }] }],
  ["건수 불일치", { ...initial, passing_count: 2 }],
  ["조회 행의 빈 시각", { ...initial, evidence: [{ ...evidence, created_at: "" }] }],
  ["통과 필드 누락", { ...initial, evidence: [{ ...evidence, passed: undefined }] }],
] as const) {
  test(`${name} GET 응답은 확인 상태로 승격하지 않고 기록을 막는다`, async ({ page, gateway }) => {
    gateway.replaceFitness(response);
    await login(page);
    await showFitness(page);
    await expect(card(page)).toContainText("현재 스킬의 적합성 근거를 확인하기 전에는 기록할 수 없습니다.");
    await expect(trigger(page)).toBeDisabled();
    await expect(card(page)).not.toContainText("등록된 근거가 없습니다.");
    expect(gateway.writes).toEqual([]);
  });
}

test("확인된 빈 배열과 0 기준은 누락으로 바꾸지 않고 알려지지 않은 종류도 안전하게 표시한다", async ({
  page,
  gateway,
}) => {
  gateway.replaceFitness({ ...initial, evidence: [], passing_count: 0, required: 0 });
  await login(page);
  await showFitness(page);
  await expect(card(page)).toContainText("등록된 근거가 없습니다.");
  await expect(trigger(page)).toBeEnabled();
  gateway.replaceFitness({
    ...initial,
    evidence: ["constructor", "__proto__", "toString"].map((kind, index) => ({
      ...evidence,
      id: `other-${index}`,
      kind,
      passed: false,
    })),
    passing_count: 0,
  });
  await card(page).getByRole("button", { name: "적합성 근거 새로고침", exact: true }).click();
  for (const kind of ["constructor", "__proto__", "toString"])
    await expect(card(page)).toContainText(`기타 근거 (${kind})`);
  expect(gateway.writes).toEqual([]);
});

for (const name of [" 분석 스킬", "\uFEFF분석 스킬", "\u0085분석 스킬", "분석 스킬\u0085"]) {
  test(`모호한 스킬 식별자 ${JSON.stringify(name)}는 다른 대상으로 자동 수정하지 않는다`, async ({
    page,
    gateway,
  }) => {
    gateway.replaceSkills([skill(name)]);
    await login(page);
    // Accessible names normalize whitespace; select the exact opaque aria-label
    // and verify the raw heading rather than accidentally choosing a canonical ID.
    await page.locator(`button[aria-label=${JSON.stringify(`${name} 상세 열기`)}]`).click();
    const parent = page.locator(".sheet-content");
    expect(await parent.locator("h2").textContent()).toBe(name);
    await parent.getByRole("button", { name: "적합성 근거", exact: true }).click();
    await expect(card(page)).toContainText("스킬 식별자를 변경 없이 확인할 수 없습니다.");
    await expect(trigger(page)).toBeDisabled();
    expect(gateway.reads()).toBe(0);
    expect(gateway.writes).toEqual([]);
  });
}

test("재조회는 고정 대상·기준·초안을 바꾸지 않고 미확인·오류·무효화 동안 직접 submit을 차단한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await showFitness(page);
  const dialog = await open(page);
  await edit(dialog);
  gateway.replaceFitness({ ...initial, evidence: [], passing_count: 0, required: 7 });
  gateway.holdReads();
  const reads = gateway.reads();
  await refresh(dialog).click();
  await expect.poll(gateway.reads).toBeGreaterThan(reads);
  await expect(save(dialog)).toBeDisabled();
  await submitDirectly(dialog);
  expect(gateway.writes).toEqual([]);
  gateway.releaseReads();
  await expect(save(dialog)).toBeEnabled();
  await expect(dialog).toContainText("열 때 확인한 통과 근거 1건 · 승격 기준 2건");
  await expect(reference(dialog)).toHaveValue("public-run-new");
  gateway.failReads();
  await refresh(dialog).click();
  await expect(dialog).toContainText("req-fitness-read");
  await submitDirectly(dialog);
  expect(gateway.writes).toEqual([]);
  gateway.succeedReads();
  await refresh(dialog).click();
  await expect(save(dialog)).toBeEnabled();
  gateway.holdReads();
  const before = gateway.reads();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "메뉴 검색", exact: true }).fill("지금 새로고침");
  await page.getByRole("option", { name: /지금 새로고침/u }).click();
  await expect.poll(gateway.reads).toBeGreaterThan(before);
  await expect(save(dialog)).toBeDisabled();
  await submitDirectly(dialog);
  expect(gateway.writes).toEqual([]);
  gateway.releaseReads();
  await expect(save(dialog)).toBeEnabled();
  await expect(dialog.getByRole("textbox", { name: "메모", exact: true })).toHaveValue(draftText);
});

test("읽기 전용 계정은 확인된 근거를 보되 기록 창을 열지 않는다", async ({ page, gateway }) => {
  await login(page, readerEmail);
  await showFitness(page);
  await expect(card(page)).toContainText(evidence.ref_id);
  await expect(trigger(page)).toBeDisabled();
  await expect(card(page)).toContainText("admin:write");
  expect(gateway.writes).toEqual([]);
});
test("열린 초안의 쓰기 권한이 회수되면 최신 권한으로 실제 submit을 거부한다", async ({ page, gateway }) => {
  await login(page);
  await showFitness(page);
  const dialog = await open(page);
  await edit(dialog);
  gateway.setWritable(false);
  await refreshRuntime(page);
  await expect(save(dialog)).toBeDisabled();
  await expect(reference(dialog)).toHaveValue("public-run-new");
  await submitDirectly(dialog);
  expect(gateway.writes).toEqual([]);
});

test("저장 실패는 입력과 요청 ID를 유지하고 수동 재시도만 새 기록을 전송한다", async ({ page, gateway }) => {
  await login(page);
  await showFitness(page);
  const dialog = await open(page);
  await edit(dialog);
  gateway.failWrites();
  await save(dialog).click();
  await expect(dialog.getByRole("alert")).toContainText("req-fitness-write");
  await expect(reference(dialog)).toHaveValue("public-run-new");
  expect(gateway.writes).toHaveLength(1);
  const first = structuredClone(gateway.writes[0]);
  await reference(dialog).fill("public-retry-run");
  expect(gateway.writes[0]).toEqual(first);
  gateway.succeedWrites();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(gateway.writes).toHaveLength(2);
  expect(gateway.writes[1]?.body.ref_id).toBe("public-retry-run");
});
for (const [name, response] of [
  ["null", null],
  ["다른 스킬", { ...evidence, skill_name: secondName, created_at: "" }],
] as const) {
  test(`${name} 201은 결과 불확실로 초안을 유지하고 자동 중복 기록을 하지 않는다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await showFitness(page);
    const dialog = await open(page);
    await edit(dialog);
    gateway.overrideWriteResponse(response);
    await save(dialog).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(reference(dialog)).toHaveValue("public-run-new");
    await expect(dialog).toContainText("다시 저장하기 전에 목록을 조회하세요.");
    expect(gateway.writes).toHaveLength(1);
    await refresh(dialog).click();
    await expect(save(dialog)).toBeEnabled();
    expect(gateway.writes).toHaveLength(1);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  });
}
test("201 성공 뒤 GET 실패는 기록 완료와 조회 오류를 구분하고 재전송하지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await showFitness(page);
  const dialog = await open(page);
  await edit(dialog);
  gateway.failReadAfterSave();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(card(page)).toContainText("적합성 근거 기록은 완료됐습니다.");
  await expect(card(page)).toContainText("req-fitness-read");
  await expect(trigger(page)).toBeDisabled();
  expect(gateway.writes).toHaveLength(1);
  gateway.succeedReads();
  await card(page).getByRole("button", { name: "적합성 근거 새로고침", exact: true }).click();
  await expect(trigger(page)).toBeEnabled();
  await expect(card(page)).not.toContainText("적합성 근거 기록은 완료됐습니다.");
  expect(gateway.writes).toHaveLength(1);
});

test("저장 중 입력·닫기·재조회·부모 전환을 잠그고 연속 submit도 한 번만 추가한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await showFitness(page);
  const dialog = await open(page);
  await edit(dialog);
  gateway.holdWrites();
  await save(dialog).click();
  await expect.poll(() => gateway.writes.length).toBe(1);
  for (const field of [
    reference(dialog),
    dialog.getByRole("textbox", { name: "점수", exact: true }),
    dialog.getByRole("textbox", { name: "메모", exact: true }),
    dialog.getByRole("combobox", { name: "근거 종류", exact: true }),
    dialog.getByRole("checkbox", { name: /^통과/u }),
    refresh(dialog),
    save(dialog),
    dialog.getByRole("button", { name: "취소", exact: true }),
  ])
    await expect(field).toBeDisabled();
  await expect(
    sheet(page).getByRole("button", { name: "적합성 근거", exact: true, includeHidden: true }),
  ).toBeDisabled();
  await sheet(page)
    .getByRole("button", { name: "패널 닫기", exact: true, includeHidden: true })
    .evaluate((element) => (element as HTMLButtonElement).click());
  await dialog.getByRole("button", { name: "대화상자 닫기", exact: true }).click();
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
  test(`${method}은 변경 확인과 계속 편집·명시적 폐기·원래 포커스를 보장한다`, async ({ page, gateway }) => {
    await login(page);
    await showFitness(page);
    const dialog = await open(page);
    await edit(dialog);
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
    await expect(reference(dialog)).toHaveValue("public-run-new");
    if (method === "외부 클릭") {
      // Observe async focus restoration before another physical outside click.
      await expect(guard(page)).toBeHidden();
      await expect(dialog.getByRole("textbox", { name: "메모", exact: true })).toBeFocused();
    }
    await close();
    await guard(page).getByRole("button", { name: "변경 버리기" }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    expect(gateway.writes).toEqual([]);
    await noStoredDraft(page);
  });
}
for (const action of ["적합성 근거", "실행 로그", "패널 닫기"] as const) {
  test(`상위 ${action} 전환은 먼저 미저장 초안을 확인하고 폐기 후에만 실행한다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await showFitness(page);
    const dialog = await open(page);
    await edit(dialog);
    const target = sheet(page).getByRole("button", { name: action, exact: true, includeHidden: true });
    // Behind a modal this control is physically inert. Invoke its actual handler
    // solely to prove coordination, not to claim pointer reachability.
    const leave = () => target.evaluate((element) => (element as HTMLButtonElement).click());
    await leave();
    await guard(page).getByRole("button", { name: "계속 편집" }).click();
    await expect(reference(dialog)).toHaveValue("public-run-new");
    await leave();
    await guard(page).getByRole("button", { name: "변경 버리기" }).click();
    await expect(dialog).toBeHidden();
    if (action === "패널 닫기") {
      await expect(sheet(page)).toBeHidden();
      await expect(page.getByRole("button", { name: `${firstName} 상세 열기`, exact: true })).toBeFocused();
    } else await expect(target).toBeFocused();
    expect(gateway.writes).toEqual([]);
  });
}

test("다른 스킬 선택은 고정 대상을 먼저 확인하고 폐기 뒤 새 대상의 빈 초안을 연다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await showFitness(page);
  const dialog = await open(page);
  await edit(dialog);
  const row = page.getByRole("button", { name: `${secondName} 상세 열기`, exact: true, includeHidden: true });
  const select = () => row.evaluate((element) => (element as HTMLButtonElement).click());
  await select();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(dialog).toContainText(`대상 스킬: ${firstName}`);
  await select();
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(dialog).toBeHidden();
  await expect(sheet(page, secondName)).toBeVisible();
  const fresh = await open(page);
  await expect(fresh).toContainText(`대상 스킬: ${secondName}`);
  await expect(reference(fresh)).toHaveValue("");
  await edit(fresh);
  await save(fresh).click();
  await expect(fresh).toBeHidden();
  expect(gateway.writes[0]?.body.skill).toBe(secondName);
});

test("실제 SPA 링크와 뒤로가기는 변경된 초안을 먼저 확인한다", async ({ page, gateway }) => {
  await login(page, firstEmail, "/app/system/health");
  await expect(
    page.getByRole("heading", { name: "이 기능은 안정 운영 화면에서 제공됩니다.", exact: true }),
  ).toBeVisible();
  const menu = page.getByRole("complementary", { name: "주 메뉴" }).getByRole("link", { name: /^스킬/u });
  await menu.click();
  await expect(page).toHaveURL(/\/agents\/skills$/u);
  await showFitness(page);
  const dialog = await open(page);
  await edit(dialog);
  await page.goBack();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(reference(dialog)).toHaveValue("public-run-new");
  await page
    .locator('a[href="/app/agents/skills"]')
    .first()
    .evaluate((element) => (element as HTMLAnchorElement).click());
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/agents\/skills$/u);
  expect(gateway.writes).toEqual([]);
});
test("실제 beforeunload 취소는 초안을 유지하고 폐기 뒤 새로고침에는 남지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await showFitness(page);
  const dialog = await open(page);
  await edit(dialog);
  const waiting = page.waitForEvent("dialog");
  await page.evaluate(() => {
    setTimeout(() => location.reload(), 0);
  });
  const native = await waiting;
  expect(native.type()).toBe("beforeunload");
  await native.dismiss();
  await expect(reference(dialog)).toHaveValue("public-run-new");
  await page.keyboard.press("Escape");
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  let warnings = 0;
  page.on("dialog", async (event) => {
    warnings += 1;
    await event.dismiss();
  });
  await page.reload();
  await sheet(page).getByRole("button", { name: "적합성 근거", exact: true }).click();
  await expect(trigger(page)).toBeEnabled();
  expect(warnings).toBe(0);
  expect(gateway.writes).toEqual([]);
  await noStoredDraft(page);
});

test("다른 탭의 로그아웃은 서버 응답 전 초안과 폐기 확인을 즉시 지운다", async ({
  page,
  context,
  gateway,
}) => {
  await login(page);
  const other = await context.newPage();
  await login(other);
  await showFitness(page);
  const dialog = await open(page);
  await edit(dialog);
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
  test(`이전 세션의 늦은 ${outcome}은 새 작성자의 초안·조회·알림을 변경하지 않는다`, async ({
    page,
    context,
    gateway,
  }) => {
    await login(page);
    const other = await context.newPage();
    await login(other);
    await showFitness(page);
    const old = await open(page);
    await edit(old, "old-session-reference");
    if (outcome === "실패") gateway.failWrites();
    gateway.holdWrites();
    await save(old).click();
    await expect.poll(() => gateway.writes.length).toBe(1);
    await other.getByLabel("사용자 메뉴").click();
    await other.getByRole("button", { name: "로그아웃", exact: true }).click();
    await signIn(page, secondEmail);
    // Returning to the existing deep link can reopen the detail Sheet automatically.
    if (!(await sheet(page).isVisible()))
      await page.getByRole("button", { name: `${firstName} 상세 열기`, exact: true }).click();
    await sheet(page).getByRole("button", { name: "적합성 근거", exact: true }).click();
    const fresh = await open(page);
    await edit(fresh, "new-session-reference");
    const reads = gateway.reads();
    const response = page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === "/admin/skills/fitness" && value.request().method() === "POST",
    );
    gateway.releaseWrites();
    await (await response).finished();
    await page.waitForTimeout(500);
    await expect(fresh).toBeVisible();
    await expect(reference(fresh)).toHaveValue("new-session-reference");
    await expect(save(fresh)).toBeEnabled();
    await expect(fresh.getByRole("alert")).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    expect(gateway.reads()).toBe(reads);
    expect(gateway.writes).toHaveLength(1);
    gateway.succeedWrites();
    await save(fresh).click();
    await expect(fresh).toBeHidden();
    expect(gateway.writes[1]).toMatchObject({
      userId: "fitness-two",
      body: { ref_id: "new-session-reference" },
    });
  });
}

test("390px 다크 기록·폐기 확인은 고정 저장 버튼·axe·포커스·엄격한 넘침 검사를 통과한다", async ({
  page,
  gateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  gateway.replaceFitness({
    ...initial,
    evidence: [
      { ...evidence, ref_id: "public-long-reference-".repeat(12), created_by: "합성작성자".repeat(30) },
    ],
  });
  await login(page);
  await showFitness(page);
  const dialog = await open(page);
  await edit(dialog);
  await expect(save(dialog)).toBeInViewport();
  await noOverflow(page, dialog);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("skill-fitness-mobile-dark.png") });
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  const alert = guard(page);
  await expect(alert.getByRole("button", { name: "계속 편집" })).toBeFocused();
  await noOverflow(page, alert);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("skill-fitness-discard-mobile-dark.png") });
  await alert.getByRole("button", { name: "변경 버리기" }).click();
  await expect(trigger(page)).toBeFocused();
  await noOverflow(page, sheet(page));
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("skill-fitness-list-mobile-dark.png") });
  expect(gateway.writes).toEqual([]);
  await noStoredDraft(page);
});
