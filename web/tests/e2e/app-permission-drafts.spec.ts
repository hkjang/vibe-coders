import { expect, type Locator, type Page } from "@playwright/test";
import {
  alpha,
  beta,
  existing,
  firstEmail,
  longSubject,
  opaqueSubject,
  permission,
  readerEmail,
  secondEmail,
  targetUrl,
  test,
  unknown,
} from "../fixtures/app-permission-gateway";

// Browser fixtures verify UX/request boundaries, not real Go/JWT/DB enforcement.
const guard = (page: Page) => page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" });
const grantForm = (page: Page) => page.getByRole("dialog", { name: "앱 접근 권한 추가", exact: true });
const revokeForm = (page: Page) => page.getByRole("dialog", { name: "앱 추가 접근 권한 회수", exact: true });
const add = (form: Locator) => form.getByRole("button", { name: "접근 권한 추가", exact: true });
const confirmRevoke = (form: Locator) => form.getByRole("button", { name: "권한 회수", exact: true });
const appTrigger = (page: Page, title = alpha.title) =>
  page.getByRole("button", { name: `${title} 상세 열기`, exact: true });
const revokeTrigger = (sheet: Locator, subject = existing.subject_id ?? "") =>
  sheet.getByRole("button", { name: `${subject} 권한 회수`, exact: true });

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
async function openPermissions(page: Page, app = alpha) {
  await appTrigger(page, app.title).click();
  const sheet = page.getByRole("dialog", { name: app.title, exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "권한 관리", exact: true }).click();
  await expect(sheet.getByRole("heading", { name: "추가 앱 접근 권한", exact: true })).toBeVisible();
  return sheet;
}
async function openGrant(page: Page, sheet: Locator) {
  await add(sheet).click();
  const form = grantForm(page);
  await expect(form).toBeVisible();
  return form;
}
async function fillGrant(form: Locator, value = opaqueSubject, type = "team") {
  await form.getByRole("combobox", { name: "대상 종류", exact: true }).selectOption(type);
  await form.getByRole("textbox", { name: type === "team" ? "팀 ID" : "사용자 ID", exact: true }).fill(value);
}
type CloseMethod = "Escape" | "취소" | "외부 클릭" | "닫기 버튼";
async function close(page: Page, form: Locator, method: CloseMethod) {
  if (method === "Escape") await page.keyboard.press("Escape");
  else if (method === "외부 클릭") await page.mouse.click(5, 5);
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
          Object.values(storage).every((value) =>
            values.every((fragment) => !String(value).includes(fragment)),
          ),
        ),
      [opaqueSubject, longSubject, "fixture-new-session-subject"],
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

test("앱 권한은 추가 허용임을 설명하고 사용자·팀 ID를 문자열 그대로 전송한다", async ({ page, gateway }) => {
  gateway.replacePermissions([]);
  await login(page);
  const sheet = await openPermissions(page);
  await expect(sheet).toContainText("기존 팀·역할 조건은 바뀌지 않습니다.");
  await expect(sheet).toContainText("기존 팀·역할 조건에 따른 접근은 유지됩니다.");
  await expect(sheet).not.toContainText("특정 사용자나 팀에게만 열어 주려면");
  for (const type of ["user", "team"] as const) {
    const form = await openGrant(page, sheet);
    await fillGrant(form, opaqueSubject, type);
    await add(form).click();
    await expect(form).toBeHidden();
    await expect(add(sheet)).toBeFocused();
  }
  expect(gateway.writes).toEqual(
    ["user", "team"].map((subject_type) => ({
      method: "POST",
      appId: alpha.id,
      subject_type,
      subject_id: opaqueSubject,
      userId: "app-grants-one",
    })),
  );
  await noStoredDraft(page);
});

for (const method of ["Escape", "취소", "외부 클릭", "닫기 버튼"] as const) {
  test(`앱 접근 추가의 ${method} 닫기는 초안을 유지·폐기하고 추가 버튼에 포커스를 복원한다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    const sheet = await openPermissions(page);
    const form = await openGrant(page, sheet);
    await fillGrant(form);
    await close(page, form, method);
    await expect(guard(page).getByRole("button", { name: "계속 편집" })).toBeFocused();
    await guard(page).getByRole("button", { name: "계속 편집" }).click();
    await expect(form.getByRole("textbox", { name: "팀 ID", exact: true })).toHaveValue(opaqueSubject);
    await close(page, form, method);
    await guard(page).getByRole("button", { name: "변경 버리기" }).click();
    await expect(form).toBeHidden();
    await expect(sheet).toBeVisible();
    await expect(add(sheet)).toBeFocused();
    const reopened = await openGrant(page, sheet);
    await expect(reopened.getByRole("textbox", { name: "사용자 ID", exact: true })).toHaveValue("");
    expect(gateway.writes).toEqual([]);
    await noStoredDraft(page);
  });
}

test("앱 접근 추가의 빈 입력 검증·원복은 API를 부르지 않는다", async ({ page, gateway }) => {
  await login(page);
  const sheet = await openPermissions(page);
  let form = await openGrant(page, sheet);
  await form.locator("form").evaluate((element) => (element as HTMLFormElement).requestSubmit());
  await expect(form.getByRole("textbox", { name: "사용자 ID", exact: true })).toBeFocused();
  expect(gateway.writes).toEqual([]);
  await close(page, form, "취소");
  await expect(form).toBeHidden();
  await expect(guard(page)).toBeHidden();
  form = await openGrant(page, sheet);
  await form.getByRole("textbox", { name: "사용자 ID", exact: true }).fill("fixture-user-draft");
  await form.getByRole("textbox", { name: "사용자 ID", exact: true }).fill("");
  await close(page, form, "Escape");
  await expect(form).toBeHidden();
  await expect(guard(page)).toBeHidden();
});

test("앱 목록 자동 갱신·재정렬과 권한 재조회는 추가 초안과 앱 ID를 바꾸지 않는다", async ({
  page,
  gateway,
}) => {
  await page.clock.install();
  await login(page);
  await page.getByLabel("자동 새로고침 간격").selectOption("60");
  const sheet = await openPermissions(page);
  const form = await openGrant(page, sheet);
  await fillGrant(form);
  const reads = gateway.listReads();
  gateway.replaceApps([beta, { ...alpha, title: "서버에서 바뀐 앱 제목" }]);
  gateway.replacePermissions([permission("new-read", "user", "fixture-other-user")]);
  await page.clock.fastForward(60_100);
  await expect.poll(gateway.listReads).toBeGreaterThan(reads);
  await expect(form).toContainText(alpha.title);
  await expect(form).toContainText(alpha.id);
  await expect(form).not.toContainText("서버에서 바뀐 앱 제목");
  // The underlying control is inert while the modal is open. Calling its real
  // handler exercises a background refresh without bypassing the mutation guard.
  await page
    .getByRole("button", { name: "권한 목록 새로고침", exact: true, includeHidden: true })
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect(form.getByRole("textbox", { name: "팀 ID", exact: true })).toHaveValue(opaqueSubject);
  await add(form).click();
  await expect(form).toBeHidden();
  expect(gateway.writes).toEqual([
    {
      method: "POST",
      appId: alpha.id,
      subject_type: "team",
      subject_id: opaqueSubject,
      userId: "app-grants-one",
    },
  ]);
});

test("앱 권한 목록 오류는 빈 목록으로 위장하지 않고 요청 ID와 재시도를 제공한다", async ({
  page,
  gateway,
}) => {
  gateway.failReads();
  await login(page);
  const sheet = await openPermissions(page);
  await expect(sheet.getByRole("alert")).toContainText("req-app-permission-list");
  await expect(sheet).not.toContainText("추가 접근 권한이 없습니다.");
  gateway.succeedReads();
  await sheet.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(revokeTrigger(sheet)).toBeVisible();
  expect(gateway.writes).toEqual([]);
});

test("앱 접근 추가 실패는 요청 ID·입력을 유지하고 수정한 재시도만 보낸다", async ({ page, gateway }) => {
  await login(page);
  const sheet = await openPermissions(page);
  const form = await openGrant(page, sheet);
  await fillGrant(form);
  gateway.failWrites();
  await add(form).click();
  await expect(form.getByRole("alert")).toContainText("req-app-permission-write");
  await expect(form.getByRole("textbox", { name: "팀 ID", exact: true })).toHaveValue(opaqueSubject);
  const first = structuredClone(gateway.writes);
  await fillGrant(form, "다시 시도 / 사용자+ID", "user");
  expect(gateway.writes).toEqual(first);
  gateway.succeedWrites();
  await add(form).click();
  await expect(form).toBeHidden();
  expect(gateway.writes).toEqual([
    ...first,
    {
      method: "POST",
      appId: alpha.id,
      subject_type: "user",
      subject_id: "다시 시도 / 사용자+ID",
      userId: "app-grants-one",
    },
  ]);
});

test("앱 접근 추가 저장 중에는 모든 입력·상위 닫기·접기를 잠그고 한 번만 전송한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const sheet = await openPermissions(page);
  const form = await openGrant(page, sheet);
  await fillGrant(form);
  gateway.holdWrites();
  await add(form).evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect.poll(() => gateway.writes.length).toBe(1);
  await expect(form.getByRole("combobox", { name: "대상 종류", exact: true })).toBeDisabled();
  await expect(form.getByRole("textbox", { name: "팀 ID", exact: true })).toBeDisabled();
  await expect(form.getByRole("button", { name: "취소", exact: true })).toBeDisabled();
  for (const name of ["검증", "실행(플랜)", "발행", "지원 중단", "버전 이력", "수정", "삭제"])
    await expect(page.getByRole("button", { name, exact: true, includeHidden: true })).toBeDisabled();
  for (const method of ["Escape", "외부 클릭", "닫기 버튼"] as const) {
    await close(page, form, method);
    await expect(form).toBeVisible();
    await expect(guard(page)).toBeHidden();
  }
  for (const name of ["패널 닫기", "권한 관리", "권한 목록 새로고침"]) {
    await page
      .getByRole("button", { name, exact: true, includeHidden: true })
      .evaluate((element) => (element as HTMLButtonElement).click());
    await expect(form).toBeVisible();
  }
  await form.locator("form").evaluate((element) => (element as HTMLFormElement).requestSubmit());
  expect(gateway.writes).toHaveLength(1);
  gateway.releaseWrites();
  await expect(form).toBeHidden();
  await expect(add(sheet)).toBeFocused();
});

test("앱 권한 회수는 확인 전 DELETE가 없고 팀과 대상 ID를 그대로 고정한다", async ({ page, gateway }) => {
  await login(page);
  const sheet = await openPermissions(page);
  await revokeTrigger(sheet, opaqueSubject).click();
  const form = revokeForm(page);
  await expect(form).toBeVisible();
  await expect(form).toContainText(opaqueSubject);
  await expect(form).toContainText("전체 접근을 금지하는 작업이 아닙니다.");
  await expect(form).toContainText("앱 접근이 계속 허용됩니다.");
  expect(gateway.writes).toEqual([]);
  await close(page, form, "취소");
  await expect(form).toBeHidden();
  await expect(revokeTrigger(sheet, opaqueSubject)).toBeFocused();
  await revokeTrigger(sheet, opaqueSubject).click();
  gateway.replacePermissions([permission("changed-permission", "user", "fixture-replaced-subject")]);
  await page
    .getByRole("button", { name: "권한 목록 새로고침", exact: true, includeHidden: true })
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect(form).toContainText(opaqueSubject);
  await confirmRevoke(form).click();
  await expect(form).toBeHidden();
  await expect(add(sheet)).toBeFocused();
  expect(gateway.writes).toEqual([
    {
      method: "DELETE",
      appId: alpha.id,
      subject_type: "team",
      subject_id: opaqueSubject,
      userId: "app-grants-one",
    },
  ]);
});

test("잘못된 null 응답은 계약 오류·요청 ID로 구분하고 회수 대상을 만들지 않는다", async ({
  page,
  gateway,
}) => {
  gateway.replacePermissions([unknown, permission("null-type", null, "fixture-null-type")]);
  await login(page);
  const sheet = await openPermissions(page);
  await expect(sheet.getByRole("alert")).toContainText("서버 응답 형식을 확인할 수 없습니다.");
  await expect(sheet.getByRole("alert")).toContainText("req-app-permission-list");
  await expect(sheet.getByRole("button", { name: /권한 회수$/u })).toHaveCount(0);
  await expect(sheet).not.toContainText("추가 접근 권한이 없습니다.");
  // A failed list must not invent revocation targets; it need not disable a
  // separate new grant that does not depend on the existing list contents.
  gateway.replacePermissions([unknown]);
  await sheet.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(revokeTrigger(sheet, longSubject)).toBeDisabled();
  await expect(sheet.getByText(longSubject, { exact: true })).toBeVisible();
  expect(gateway.writes).toEqual([]);
});

test("알 수 없는 유형·누락·빈 ID를 사용자 회수로 바꾸지 않는다", async ({ page, gateway }) => {
  gateway.replacePermissions([
    unknown,
    permission("missing-type", undefined, "fixture-missing-type"),
    permission("empty-id", "user", ""),
    permission("blank-id", "team", "   "),
  ]);
  await login(page);
  const sheet = await openPermissions(page);
  await expect(sheet.getByText(longSubject, { exact: true })).toBeVisible();
  const buttons = sheet.getByRole("button", { name: /권한 회수$/u });
  await expect(buttons).toHaveCount(4);
  for (const button of await buttons.all()) {
    await expect(button).toBeDisabled();
    // Attempt DOM activation without the native disabled attribute. This is a
    // browser interaction guard, not proof of server authorization or of a
    // callback suppressed by React's disabled-prop handling being executed.
    await button.evaluate((element) => {
      (element as HTMLButtonElement).disabled = false;
      (element as HTMLButtonElement).click();
    });
  }
  await expect(revokeForm(page)).toBeHidden();
  expect(gateway.writes).toEqual([]);
});

test("기존 ID의 FEFF·공백을 정규화해 다른 권한을 회수하지 않고 정확한 Unicode 대상만 전송한다", async ({
  page,
  gateway,
}) => {
  const canonical = "alice";
  const blocked = [`\uFEFF${canonical}`, ` ${canonical} `];
  const unicode = `${opaqueSubject}\uFEFF내부 문자`;
  const subjects = [canonical, ...blocked, unicode];
  gateway.replacePermissions(
    subjects.map((subject, index) => permission(`opaque-existing-${index}`, "user", subject)),
  );
  await login(page);
  const sheet = await openPermissions(page);
  const rows = sheet.locator("tbody tr");
  await expect(rows).toHaveCount(subjects.length);
  for (const [index, subject] of subjects.entries()) {
    // Raw textContent and exact CSS attribute values deliberately avoid
    // accessible-name/text locators that normalize the whitespace under test.
    await expect(rows.nth(index).locator("td").nth(1)).toHaveJSProperty("textContent", subject);
  }
  const exactTrigger = (subject: string) =>
    sheet.locator(`button[aria-label=${JSON.stringify(`${subject} 권한 회수`)}]`);
  for (const subject of blocked) {
    const button = exactTrigger(subject);
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", "대상 종류와 ID를 확인할 수 없어 회수할 수 없습니다.");
    // Removing native disabled only tests the browser activation boundary;
    // React may still suppress the callback. Unit/Go contracts are separate.
    await button.evaluate((element) => {
      const control = element as HTMLButtonElement;
      control.disabled = false;
      control.click();
      control.disabled = true;
    });
    await expect(revokeForm(page)).toBeHidden();
    expect(gateway.writes).toEqual([]);
    await expect(exactTrigger(canonical)).toBeEnabled();
  }
  for (const subject of [canonical, unicode]) {
    await exactTrigger(subject).click();
    const form = revokeForm(page);
    await expect(form).toBeVisible();
    await confirmRevoke(form).click();
    await expect(form).toBeHidden();
    await expect(exactTrigger(subject)).toHaveCount(0);
  }
  expect(gateway.writes).toEqual(
    [canonical, unicode].map((subject_id) => ({
      method: "DELETE",
      appId: alpha.id,
      subject_type: "user",
      subject_id,
      userId: "app-grants-one",
    })),
  );
  await expect(rows).toHaveCount(blocked.length);
  for (const [index, subject] of blocked.entries()) {
    await expect(rows.nth(index).locator("td").nth(1)).toHaveJSProperty("textContent", subject);
    await expect(exactTrigger(subject)).toBeDisabled();
  }
});

test("회수 실패는 대상과 요청 ID를 유지하며 재시도·중복 제출을 보호한다", async ({ page, gateway }) => {
  await login(page);
  const sheet = await openPermissions(page);
  await revokeTrigger(sheet).click();
  const form = revokeForm(page);
  gateway.failWrites();
  await confirmRevoke(form).click();
  await expect(form.getByRole("alert")).toContainText("req-app-permission-write");
  await expect(form).toContainText(existing.subject_id ?? "");
  gateway.succeedWrites();
  gateway.holdWrites();
  await confirmRevoke(form).evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect.poll(() => gateway.writes.length).toBe(2);
  await expect(form.getByRole("button", { name: "취소", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(form).toBeVisible();
  await form.locator("form").evaluate((element) => (element as HTMLFormElement).requestSubmit());
  expect(gateway.writes).toHaveLength(2);
  gateway.releaseWrites();
  await expect(form).toBeHidden();
  expect(gateway.writes[1]).toEqual(gateway.writes[0]);
});

test("읽기 전용 사용자는 강제 DOM 실행으로도 추가·회수 쓰기를 전송하지 않는다", async ({ page, gateway }) => {
  await login(page, readerEmail);
  const sheet = await openPermissions(page);
  const buttons = [add(sheet), revokeTrigger(sheet)];
  for (const button of buttons) {
    await expect(button).toBeDisabled();
    await button.evaluate((element) => {
      (element as HTMLButtonElement).disabled = false;
      (element as HTMLButtonElement).click();
    });
  }
  await expect(grantForm(page)).toBeHidden();
  await expect(revokeForm(page)).toBeHidden();
  expect(gateway.writes).toEqual([]);
});

for (const outer of ["권한 관리", "패널 닫기"] as const) {
  test(`추가 초안에서 상위 ${outer}는 계속 편집·폐기를 확인한다`, async ({ page, gateway }) => {
    await login(page);
    const sheet = await openPermissions(page);
    const form = await openGrant(page, sheet);
    await fillGrant(form);
    const act = () =>
      page
        .getByRole("button", { name: outer, exact: true, includeHidden: true })
        .evaluate((element) => (element as HTMLButtonElement).click());
    await act();
    await expect(guard(page)).toBeVisible();
    await guard(page).getByRole("button", { name: "계속 편집" }).click();
    await expect(form.getByRole("textbox", { name: "팀 ID", exact: true })).toHaveValue(opaqueSubject);
    await act();
    await guard(page).getByRole("button", { name: "변경 버리기" }).click();
    await expect(form).toBeHidden();
    if (outer === "패널 닫기") {
      await expect(sheet).toBeHidden();
      await expect(appTrigger(page)).toBeFocused();
    } else {
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole("button", { name: "권한 관리", exact: true })).toBeFocused();
    }
    expect(gateway.writes).toEqual([]);
  });
}

test("앱 추가 초안의 실제 뒤로가기는 취소 가능하고 폐기 뒤 상세 패널을 닫는다", async ({ page, gateway }) => {
  // Selecting a detail row replaces query state. Establish a real SPA history
  // entry through its navigation link before testing a browser back operation.
  await login(page, firstEmail, `${targetUrl}?tab=runs`);
  await page
    .getByRole("complementary", { name: "주 메뉴" })
    .getByRole("link", { name: /AI 업무 앱/u })
    .click();
  const sheet = await openPermissions(page);
  const form = await openGrant(page, sheet);
  await fillGrant(form);
  await page.goBack();
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(form.getByRole("textbox", { name: "팀 ID", exact: true })).toHaveValue(opaqueSubject);
  await page.goBack();
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(form).toBeHidden();
  await expect(page).toHaveURL(/\/agents\/apps\?tab=runs$/u);
  expect(gateway.writes).toEqual([]);
});

test("앱 추가 초안은 실제 새로고침 경고에 남고 폐기 후에는 경고하지 않는다", async ({ page, gateway }) => {
  await login(page);
  const sheet = await openPermissions(page);
  const form = await openGrant(page, sheet);
  await fillGrant(form);
  const waiting = page.waitForEvent("dialog");
  await page.evaluate(() => {
    setTimeout(() => location.reload(), 0);
  });
  const native = await waiting;
  expect(native.type()).toBe("beforeunload");
  await native.dismiss();
  await expect(form.getByRole("textbox", { name: "팀 ID", exact: true })).toHaveValue(opaqueSubject);
  await close(page, form, "취소");
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  let warnings = 0;
  page.on("dialog", async (dialog) => {
    warnings += 1;
    await dialog.dismiss();
  });
  await page.reload();
  await expect(page.getByRole("dialog", { name: alpha.title, exact: true })).toBeVisible();
  expect(warnings).toBe(0);
  expect(gateway.writes).toEqual([]);
});

test("다른 탭 로그아웃은 응답 전에 앱 접근 초안과 폐기 확인을 지운다", async ({ page, context, gateway }) => {
  await login(page);
  const other = await context.newPage();
  await login(other);
  const sheet = await openPermissions(page);
  const form = await openGrant(page, sheet);
  await fillGrant(form);
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
  await noStoredDraft(page);
});

for (const operation of ["추가", "회수"] as const)
  for (const outcome of ["성공", "실패"] as const) {
    test(`이전 앱 권한 ${operation}의 늦은 ${outcome} 응답은 새 계정의 편집 가능한 초안을 바꾸지 않는다`, async ({
      page,
      context,
      gateway,
    }) => {
      await login(page);
      const other = await context.newPage();
      await login(other);
      const sheet = await openPermissions(page);
      let old: Locator;
      if (operation === "추가") {
        old = await openGrant(page, sheet);
        await fillGrant(old);
      } else {
        await revokeTrigger(sheet).click();
        old = revokeForm(page);
      }
      if (outcome === "실패") gateway.failWrites();
      gateway.holdWrites();
      await (operation === "추가" ? add(old) : confirmRevoke(old)).click();
      await expect.poll(() => gateway.writes.length).toBe(1);
      await other.getByLabel("사용자 메뉴").click();
      await other.getByRole("button", { name: "로그아웃", exact: true }).click();
      await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
      await signIn(page, secondEmail);
      // Login returns to the selected app URL, in the same document. Open only
      // the permissions section rather than replacing the document via goto.
      const freshSheet = page.getByRole("dialog", { name: alpha.title, exact: true });
      await expect(freshSheet).toBeVisible();
      await freshSheet.getByRole("button", { name: "권한 관리", exact: true }).click();
      const fresh = await openGrant(page, freshSheet);
      await fillGrant(fresh, "fixture-new-session-subject", "user");
      const reads = gateway.permissionReads();
      const response = page.waitForResponse(
        (value) =>
          new URL(value.url()).pathname === `/admin/apps/${alpha.id}/permissions` &&
          value.request().method() === (operation === "추가" ? "POST" : "DELETE"),
      );
      gateway.releaseWrites();
      await (await response).finished();
      await page.waitForTimeout(300);
      await expect(fresh).toBeVisible();
      await expect(fresh.getByRole("textbox", { name: "사용자 ID", exact: true })).toHaveValue(
        "fixture-new-session-subject",
      );
      await expect(fresh.getByRole("alert")).toHaveCount(0);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      expect(gateway.permissionReads()).toBe(reads);
      expect(gateway.writes).toHaveLength(1);
      gateway.succeedWrites();
      await add(fresh).click();
      await expect(fresh).toBeHidden();
      expect(gateway.writes[1]).toEqual({
        method: "POST",
        appId: alpha.id,
        subject_type: "user",
        subject_id: "fixture-new-session-subject",
        userId: "app-grants-two",
      });
      await noStoredDraft(page);
    });
  }

test("390px 다크 앱 접근 추가·회수와 중첩 폐기 확인은 키보드·접근성·넘침을 보호한다", async ({
  page,
  gateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page);
  const sheet = await openPermissions(page);
  await revokeTrigger(sheet).scrollIntoViewIfNeeded();
  for (const button of await sheet.getByRole("button", { name: /권한 회수$/u }).all()) {
    const lineCount = await button.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set(
        Array.from(range.getClientRects())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => Math.round(rect.top * 10)),
      ).size;
    });
    expect(lineCount).toBe(1);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("app-permission-table-mobile-dark.png") });
  const form = await openGrant(page, sheet);
  await fillGrant(form, longSubject);
  await expect(add(form)).toBeInViewport();
  expect(await form.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("app-permission-grant-mobile-dark.png") });
  await page.keyboard.press("Escape");
  const alert = guard(page);
  await expect(alert.getByRole("button", { name: "계속 편집" })).toBeFocused();
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Tab");
    expect(await alert.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("app-permission-guard-mobile-dark.png") });
  await page.keyboard.press("Escape");
  await expect(form.getByRole("textbox", { name: "팀 ID", exact: true })).toHaveValue(longSubject);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(add(sheet)).toBeFocused();
  await revokeTrigger(sheet, opaqueSubject).click();
  const revoke = revokeForm(page);
  await expect(confirmRevoke(revoke)).toBeInViewport();
  expect(await revoke.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("app-permission-revoke-mobile-dark.png") });
  await page.keyboard.press("Escape");
  await expect(revokeTrigger(sheet, opaqueSubject)).toBeFocused();
  expect(gateway.writes).toEqual([]);
});
