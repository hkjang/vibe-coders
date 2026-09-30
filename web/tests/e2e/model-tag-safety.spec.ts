import { expect, type Locator, type Page } from "@playwright/test";
import {
  test,
  type Action,
  type ModelTagGateway,
  tagsUrl,
  providersUrl,
  listPath,
  modelA,
  modelB,
  row,
  firstEmail,
  secondEmail,
  readonlyReason,
} from "../fixtures/model-tag-safety-gateway";

// Real React/router/auth lifecycle against synthetic HTTP. No server CAS, Go
// authorization, persistence, cancellation or rollback is established here.
const revised = "검토한 공개 작업";
const editor = (page: Page) => page.getByRole("dialog", { name: "모델 용도 태그", exact: true });
const deletion = (page: Page) => page.getByRole("dialog", { name: "모델 용도 태그 삭제", exact: true });
const save = (dialog: Locator) => dialog.getByRole("button", { name: "검토한 태그 저장", exact: true });
const guidance = (dialog: Locator) => dialog.getByRole("textbox", { name: "적합한 작업", exact: true });
const tagRow = (page: Page, goodFor = "공개 원본 A") =>
  page
    .getByRole("table", { name: "모델별 용도 태그", exact: true })
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: goodFor, exact: true }) });
async function signIn(page: Page, email = firstEmail) {
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByLabel("사용자 메뉴")).toBeVisible();
}
async function login(page: Page, path = tagsUrl) {
  await page.goto(`login?return_to=${encodeURIComponent(path)}`);
  await signIn(page);
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function refresh(page: Page, dialog?: Locator) {
  const response = page.waitForResponse(
    (item) => new URL(item.url()).pathname === listPath && item.request().method() === "GET",
  );
  await (dialog ?? page)
    .getByRole("button", { name: dialog ? "목록 다시 조회" : "태그 목록 새로고침", exact: true })
    .click();
  await (await response).finished();
}
async function edit(page: Page, original = "공개 원본 A") {
  const trigger = tagRow(page, original).getByRole("button", { name: "수정", exact: true });
  await trigger.click();
  const dialog = editor(page);
  await guidance(dialog).fill(revised);
  return { dialog, trigger };
}
async function add(page: Page, model = "public-new-model") {
  await page.getByRole("button", { name: "태그 추가", exact: true }).click();
  const dialog = editor(page);
  await dialog.getByRole("textbox", { name: "모델", exact: true }).fill(model);
  return dialog;
}
async function review(dialog: Locator) {
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "태그 변경 비교", exact: true })).toBeFocused();
  await dialog.getByRole("checkbox", { name: "대상과 변경 내용을 확인했습니다.", exact: true }).check();
  await expect(save(dialog)).toBeEnabled();
}
async function remove(page: Page, original = "공개 원본 A") {
  const trigger = tagRow(page, original).getByRole("button", { name: "삭제", exact: true });
  await trigger.click();
  return { dialog: deletion(page), trigger };
}
async function nativeSubmit(dialog: Locator) {
  await dialog.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
}
async function forceClick(button: Locator) {
  // DOM bypass only, not proof of React onClick entry. Direct captured-callback
  // admission (including async RHF/owner/invalidated-only) has separate units.
  await button.evaluate((node) => {
    const button = node as HTMLButtonElement,
      previous = button.disabled;
    button.disabled = false;
    button.click();
    button.disabled = previous;
  });
}
async function release(gateway: ModelTagGateway, action: Action) {
  const before = gateway.finished.filter((item) => item === action).length;
  gateway.release(action);
  await expect.poll(() => gateway.finished.filter((item) => item === action).length).toBe(before + 1);
}
const writes = (gateway: ModelTagGateway) => gateway.operations.filter((item) => item.action !== "list");
async function sidebar(page: Page, path: string) {
  const link = page.locator(`a[href="${path}"]`).first();
  if (!(await link.isVisible()))
    await page.getByRole("button", { name: /^AI Gateway|^AI 게이트웨이/u }).click();
  await link.click();
}

test("정상 수정은 A ID 고정과 4필드 전체 upsert를 검토하고 B는 보존한다", async ({ page, gateway }) => {
  await login(page);
  const beforeB = gateway.records().find((item) => item.model === modelB);
  const exactTrigger = await tagRow(page).getByRole("button", { name: "수정", exact: true }).elementHandle();
  const { dialog } = await edit(page);
  expect(exactTrigger).not.toBeNull();
  const model = dialog.getByRole("textbox", { name: "모델", exact: true });
  await expect(model).toHaveAttribute("readonly", "");
  await model.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(modelB);
  await expect(model).toHaveValue(modelA);
  await review(dialog);
  await expect(dialog.getByRole("cell", { name: "공개 원본 A", exact: true })).toBeVisible();
  await expect(
    dialog.getByText("기존 모델의 태그 전체를 덮어씁니다. 빈 값은 기존 내용을 지웁니다.", { exact: true }),
  ).toBeVisible();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(writes(gateway).map((item) => item.body)).toEqual([
    { model: modelA, good_for: revised, avoid_for: "공개 부적합", risk_note: "공개 위험 메모" },
  ]);
  expect(gateway.records().find((item) => item.model === modelB)).toEqual(beforeB);
  await expect.poll(() => exactTrigger?.evaluate((node) => node === document.activeElement)).toBe(true);
});
test("확인된 빈 목록에서는 신규 모델 태그를 추가할 수 있다", async ({ page, gateway }) => {
  gateway.setRows([]);
  await login(page);
  await expect(page.getByText("등록된 용도 태그가 없습니다.", { exact: true })).toBeVisible();
  const dialog = await add(page);
  await guidance(dialog).fill("  공개 신규 작업  ");
  await review(dialog);
  await expect(dialog.getByText("이 ID의 새 태그를 추가합니다.", { exact: true })).toBeVisible();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(writes(gateway)[0]?.body).toEqual({
    model: "public-new-model",
    good_for: "공개 신규 작업",
    avoid_for: "",
    risk_note: "",
  });
});
test("같은 ID 추가는 기존 내용을 표시하고 빈 필드를 명시적으로 지운다", async ({ page, gateway }) => {
  await login(page);
  const dialog = await add(page, modelA);
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await expect(dialog.getByRole("cell", { name: "공개 원본 A", exact: true })).toBeVisible();
  await nativeSubmit(dialog);
  expect(writes(gateway)).toEqual([]);
  await dialog.getByRole("checkbox").check();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(writes(gateway)[0]?.body).toEqual({ model: modelA, good_for: "", avoid_for: "", risk_note: "" });
});
test("FEFF 원문 수정과 삭제는 plain 이웃을 바꾸지 않는다", async ({ page, gateway }) => {
  const opaque = `\ufeff${modelA}`;
  gateway.setRows([row(), row(opaque, "공개 FEFF 태그")]);
  await login(page);
  const { dialog } = await edit(page, "공개 FEFF 태그");
  await expect(dialog.getByRole("textbox", { name: "모델", exact: true })).toHaveValue(opaque);
  await review(dialog);
  await expect(dialog.getByRole("cell", { name: `\\ufeff${modelA}`, exact: true }).first()).toBeVisible();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(writes(gateway)[0]?.body?.model).toBe(opaque);
  const deletion = await remove(page, revised);
  await deletion.dialog.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(deletion.dialog).toBeHidden();
  expect(writes(gateway)[1]?.path).toBe(`${listPath}/${encodeURIComponent(opaque)}`);
  expect(gateway.records()).toEqual([row()]);
});
test("imported NEL 원본은 수정 차단하고 삭제는 정확한 원본만 전송한다", async ({ page, gateway }) => {
  // Leading NEL is an imported-row control; normal HTTP POST trims it.
  const opaque = `\u0085${modelA}`;
  gateway.setRows([row(), row(opaque, "공개 imported 태그")]);
  await login(page);
  await tagRow(page, "공개 imported 태그").getByRole("button", { name: "수정", exact: true }).click();
  const dialog = editor(page);
  await expect(dialog.getByText(/이 모델 ID는 저장 시 다른 ID/u)).toBeVisible();
  await nativeSubmit(dialog);
  expect(writes(gateway)).toEqual([]);
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  const current = await remove(page, "공개 imported 태그");
  await expect(current.dialog.getByText(/\\u0085public-tag-a/u)).toBeVisible();
  await current.dialog.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(current.dialog).toBeHidden();
  expect(writes(gateway).map((item) => item.id)).toEqual([opaque]);
  expect(gateway.records()).toEqual([row()]);
});
for (const id of ["vendor/../model", "vendor%2Fmodel", "한글/100%?query#fragment"]) {
  test(`원본 경로 ${id}는 한 번 인코딩한 정확한 DELETE만 보낸다`, async ({ page, gateway }) => {
    gateway.setRows([row(id, "공개 경로 태그"), row()]);
    await login(page);
    const current = await remove(page, "공개 경로 태그");
    await current.dialog.getByRole("button", { name: "삭제", exact: true }).click();
    await expect(current.dialog).toBeHidden();
    expect(writes(gateway).map(({ path, id }) => ({ path, id }))).toEqual([
      { path: `${listPath}/${encodeURIComponent(id)}`, id },
    ]);
    expect(gateway.records()).toEqual([row()]);
  });
}
for (const id of [".", ".."]) {
  test(`URL dot segment ${id}는 삭제를 안전하게 차단한다`, async ({ page, gateway }) => {
    gateway.setRows([row(id, "공개 dot 태그"), row()]);
    await login(page);
    const current = await remove(page, "공개 dot 태그");
    const confirm = current.dialog.getByRole("button", { name: "삭제", exact: true });
    await expect(confirm).toBeDisabled();
    await forceClick(confirm);
    expect(writes(gateway)).toEqual([]);
    expect(gateway.records()).toEqual([row(id, "공개 dot 태그"), row()]);
  });
}
test("신규 ID는 Go 공백만 정규화하며 NEL-only는 검토할 수 없다", async ({ page, gateway }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const dialog = await add(page, "\u0085 ");
  const reviewButton = dialog.getByRole("button", { name: "변경 내용 검토", exact: true });
  // Review is a type=button action, not native form submission. Its first
  // physical click must survive blur validation without a second click.
  await reviewButton.evaluate((node) => {
    node.setAttribute("data-native-clicks", "0");
    node.addEventListener("click", () =>
      node.setAttribute("data-native-clicks", String(Number(node.getAttribute("data-native-clicks")) + 1)),
    );
  });
  const footerY = (await save(dialog).boundingBox())?.y;
  await reviewButton.click();
  await expect(reviewButton).toHaveAttribute("data-native-clicks", "1");
  await expect(dialog.getByText("모델 이름을 입력하세요.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "모델", exact: true })).toBeFocused();
  expect((await save(dialog).boundingBox())?.y).toBe(footerY);
  expect(writes(gateway)).toEqual([]);
  await dialog.getByRole("textbox", { name: "모델", exact: true }).fill(" \u0085public-new\u0085 ");
  await review(dialog);
  await expect(dialog.getByRole("cell", { name: "public-new", exact: true })).toBeVisible();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(writes(gateway)[0]?.body?.model).toBe("public-new");
});

for (const mode of ["read_only", "preview_read_only"] as const) {
  for (const action of ["save", "delete"] as const) {
    test(`${mode} 열린 ${action} 대상·초안은 유지하고 복구 후 수동 요청만 허용한다`, async ({
      page,
      gateway,
    }) => {
      await login(page);
      const current = action === "save" ? await edit(page) : await remove(page);
      if (action === "save") await review(current.dialog);
      const button =
        action === "save"
          ? save(current.dialog)
          : current.dialog.getByRole("button", { name: "삭제", exact: true });
      gateway.setMode(mode);
      await runtime(page);
      await expect(button).toBeDisabled();
      if (action === "save") {
        await expect(guidance(current.dialog)).toHaveValue(revised);
        await nativeSubmit(current.dialog);
      } else await forceClick(button);
      expect(writes(gateway)).toEqual([]);
      await refresh(page, current.dialog);
      expect(writes(gateway)).toEqual([]);
      gateway.setMode("writable");
      await runtime(page);
      await expect(button).toBeEnabled();
      expect(writes(gateway)).toEqual([]);
      await button.click();
      await expect(current.dialog).toBeHidden();
      expect(gateway.count(action)).toBe(1);
    });
  }
}
for (const scope of ["read", "write"] as const) {
  test(`현재 admin:${scope} 회수는 검토한 native 저장을 차단하고 초안을 보존한다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    const { dialog } = await edit(page);
    await review(dialog);
    if (scope === "read") gateway.setRead(false);
    else gateway.setWrite(false);
    await runtime(page);
    await expect(save(dialog)).toBeDisabled();
    await nativeSubmit(dialog);
    expect(writes(gateway)).toEqual([]);
    await expect(guidance(dialog)).toHaveValue(revised);
    const reads = gateway.count("list");
    if (scope === "read") {
      await expect(dialog.getByRole("button", { name: "목록 다시 조회", exact: true })).toBeDisabled();
      expect(gateway.count("list")).toBe(reads);
      gateway.setRead(true);
    } else gateway.setWrite(true);
    await runtime(page);
    await expect(save(dialog)).toBeEnabled();
    expect(writes(gateway)).toEqual([]);
    await save(dialog).click();
    await expect(dialog).toBeHidden();
    expect(gateway.count("save")).toBe(1);
  });
}
test("조회 전용 계정은 raw 권한 없이 목록을 읽되 신규·수정·삭제는 잠긴다", async ({ page, gateway }) => {
  gateway.setWrite(false);
  await login(page);
  await expect(tagRow(page)).toBeVisible();
  for (const button of [
    page.getByRole("button", { name: "태그 추가", exact: true }),
    tagRow(page).getByRole("button", { name: "수정", exact: true }),
    tagRow(page).getByRole("button", { name: "삭제", exact: true }),
  ]) {
    await expect(button).toBeDisabled();
    await forceClick(button);
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(writes(gateway)).toEqual([]);
});

test("조회 중에는 초안을 열어도 검토·저장하지 못하고 정상 빈 목록 후 수동 입력한다", async ({
  page,
  gateway,
}) => {
  gateway.setRows([]);
  gateway.hold("list");
  await login(page);
  await page.getByRole("button", { name: "태그 추가", exact: true }).click();
  const dialog = editor(page);
  await expect(dialog.getByRole("textbox", { name: "모델", exact: true })).toBeDisabled();
  await nativeSubmit(dialog);
  expect(writes(gateway)).toEqual([]);
  await release(gateway, "list");
  const model = dialog.getByRole("textbox", { name: "모델", exact: true });
  await expect(model).toBeEnabled();
  await model.fill("public-after-load");
  await review(dialog);
  expect(writes(gateway)).toEqual([]);
  await save(dialog).click();
  await expect(dialog).toBeHidden();
});
for (const malformed of ["missing", "null", "incomplete", "duplicate", "http-error"] as const) {
  test(`목록 ${malformed}는 확인된 빈 목록이나 저장 기준으로 취급하지 않는다`, async ({ page, gateway }) => {
    if (malformed === "http-error") gateway.setStatus("list", 503);
    else
      gateway.setPayload(
        "list",
        malformed === "missing"
          ? {}
          : malformed === "null"
            ? { tags: null }
            : malformed === "incomplete"
              ? { tags: [{ model: modelA }] }
              : { tags: [row(), row()] },
      );
    await login(page);
    await page.getByRole("button", { name: "태그 추가", exact: true }).click();
    const dialog = editor(page);
    if (malformed === "duplicate") {
      await dialog.getByRole("textbox", { name: "모델", exact: true }).fill("new-target");
      await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
      await expect(dialog.getByText("태그 검토 실패", { exact: true })).toBeVisible();
    } else await expect(dialog.getByText("태그 목록 조회 실패", { exact: true })).toBeVisible();
    await nativeSubmit(dialog);
    expect(writes(gateway)).toEqual([]);
    await expect(save(dialog)).toBeDisabled();
    gateway.clearPayload("list");
    gateway.setStatus("list", 200);
    await refresh(page, dialog);
    await expect(dialog.getByRole("textbox", { name: "모델", exact: true })).toBeEnabled();
    await dialog.getByRole("textbox", { name: "모델", exact: true }).fill("recovered-model");
    await review(dialog);
    await save(dialog).click();
    await expect(dialog).toBeHidden();
    expect(gateway.count("save")).toBe(1);
  });
}
test("같은 목록 재조회는 검토 기준·초안을 바꾸지 않고 조회 중 저장은 막는다", async ({ page, gateway }) => {
  await login(page);
  const { dialog } = await edit(page);
  await review(dialog);
  gateway.hold("list");
  await dialog.getByRole("button", { name: "목록 다시 조회", exact: true }).click();
  await expect(save(dialog)).toBeDisabled();
  await nativeSubmit(dialog);
  expect(writes(gateway)).toEqual([]);
  await release(gateway, "list");
  await expect(save(dialog)).toBeEnabled();
  await expect(guidance(dialog)).toHaveValue(revised);
  await expect(dialog.getByRole("checkbox")).toBeChecked();
});
test("목록에서 A가 바뀌어도 초안을 덮지 않고 수동 최신 기준·재검토가 필요하다", async ({ page, gateway }) => {
  await login(page);
  const { dialog } = await edit(page);
  await review(dialog);
  gateway.setRows([row(modelA, "다른 작업자의 공개 기준"), row(modelB, "공개 원본 B")]);
  await refresh(page, dialog);
  await expect(save(dialog)).toBeDisabled();
  await nativeSubmit(dialog);
  expect(writes(gateway)).toEqual([]);
  await expect(guidance(dialog)).toHaveValue(revised);
  await dialog.getByRole("button", { name: "최신 기준 다시 선택", exact: true }).click();
  await review(dialog);
  await expect(dialog.getByRole("cell", { name: "다른 작업자의 공개 기준", exact: true })).toBeVisible();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(gateway.count("save")).toBe(1);
});
test("삭제된 수정 대상은 자동 복원하지 않으며 초안을 보존한다", async ({ page, gateway }) => {
  await login(page);
  const { dialog } = await edit(page);
  await review(dialog);
  gateway.setRows([]);
  await refresh(page, dialog);
  await nativeSubmit(dialog);
  await dialog.getByRole("button", { name: "최신 기준 다시 선택", exact: true }).click();
  await expect(dialog.getByText("태그 검토 실패", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/대상 태그가 변경되거나 삭제되었습니다/u)).toBeVisible();
  await expect(save(dialog)).toBeDisabled();
  await expect(guidance(dialog)).toHaveValue(revised);
  expect(writes(gateway)).toEqual([]);
});
test("신규 검토 뒤 같은 ID가 생기면 기존값을 새 기준으로 확인해야 한다", async ({ page, gateway }) => {
  await login(page);
  const dialog = await add(page, "new-collision");
  await review(dialog);
  gateway.setRows([row("new-collision", "새로 생긴 공개 태그")]);
  await refresh(page, dialog);
  await nativeSubmit(dialog);
  expect(writes(gateway)).toEqual([]);
  await dialog.getByRole("button", { name: "최신 기준 다시 선택", exact: true }).click();
  await review(dialog);
  await expect(dialog.getByRole("cell", { name: "새로 생긴 공개 태그", exact: true })).toBeVisible();
  await save(dialog).click();
  await expect(dialog).toBeHidden();
});
test("열린 삭제 대상이 바뀌면 ID를 유지하며 최신 대상의 재확인이 필요하다", async ({ page, gateway }) => {
  await login(page);
  const { dialog } = await remove(page);
  gateway.setRows([row(modelA, "변경된 삭제 기준")]);
  await refresh(page, dialog);
  const confirm = dialog.getByRole("button", { name: "삭제", exact: true });
  await expect(confirm).toBeDisabled();
  await forceClick(confirm);
  expect(writes(gateway)).toEqual([]);
  await dialog.getByRole("button", { name: "최신 삭제 대상 확인", exact: true }).click();
  await expect(confirm).toBeEnabled();
  expect(writes(gateway)).toEqual([]);
  await confirm.click();
  await expect(dialog).toBeHidden();
  expect(writes(gateway)[0]?.id).toBe(modelA);
});
test("검토 후 입력 변경은 확인을 폐기하고 변경한 전송값을 다시 검토한다", async ({ page, gateway }) => {
  await login(page);
  const { dialog } = await edit(page);
  await review(dialog);
  await guidance(dialog).fill("재검토할 공개 값");
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await nativeSubmit(dialog);
  expect(writes(gateway)).toEqual([]);
  await review(dialog);
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  expect(writes(gateway)[0]?.body?.good_for).toBe("재검토할 공개 값");
});

for (const action of ["save", "delete"] as const) {
  test(`${action} 대기 중 중복·닫기는 막되 이미 허용된 결과는 readonly 후에도 처리한다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    const { dialog } = action === "save" ? await edit(page) : await remove(page);
    if (action === "save") await review(dialog);
    const button =
      action === "save" ? save(dialog) : dialog.getByRole("button", { name: "삭제", exact: true });
    gateway.hold(action);
    await button.click();
    await expect.poll(() => gateway.count(action)).toBe(1);
    if (action === "save") {
      await expect(guidance(dialog)).toBeDisabled();
      await nativeSubmit(dialog);
    } else await forceClick(dialog.getByRole("button", { name: "처리 중", exact: true }));
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeDisabled();
    gateway.setMode("read_only");
    await runtime(page);
    await release(gateway, action);
    await expect(dialog).toBeHidden();
    expect(gateway.count(action)).toBe(1);
    await expect(page.getByRole("button", { name: "태그 추가", exact: true })).toBeDisabled();
  });
  test(`${action} 실패 Request ID와 대상을 유지하고 동일 요청을 수동으로만 재시도한다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    const { dialog } = action === "save" ? await edit(page) : await remove(page);
    if (action === "save") await review(dialog);
    const button =
      action === "save" ? save(dialog) : dialog.getByRole("button", { name: "삭제", exact: true });
    gateway.setStatus(action, 503);
    await button.click();
    await expect(dialog.getByRole("alert")).toContainText("req-model-tag-safety");
    expect(gateway.count(action)).toBe(1);
    if (action === "save") await expect(guidance(dialog)).toHaveValue(revised);
    gateway.setStatus(action, 200);
    await expect(button).toBeEnabled();
    expect(gateway.count(action)).toBe(1);
    await button.click();
    await expect(dialog).toBeHidden();
    const attempts = writes(gateway);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
  });
}
test("저장 성공 후 GET 실패는 저장 실패가 아니며 POST를 반복하지 않는다", async ({ page, gateway }) => {
  await login(page);
  const { dialog, trigger } = await edit(page);
  await review(dialog);
  gateway.setStatus("list", 503);
  await save(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("모델 용도 태그를 저장했습니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("모델 용도 태그를 불러오지 못했습니다.", { exact: true })).toBeVisible();
  await expect(trigger).toBeFocused();
  expect(gateway.count("save")).toBe(1);
  gateway.setStatus("list", 200);
  await refresh(page);
  await expect(tagRow(page, revised)).toBeVisible();
  expect(gateway.count("save")).toBe(1);
});
for (const action of ["save", "delete"] as const) {
  test(`${action} 불완전 200 응답은 확인된 성공으로 표시하지 않는다`, async ({ page, gateway }) => {
    await login(page);
    const { dialog } = action === "save" ? await edit(page) : await remove(page);
    if (action === "save") await review(dialog);
    gateway.setPayload(action, action === "save" ? { model: modelA } : { status: "ok" });
    await (
      action === "save" ? save(dialog) : dialog.getByRole("button", { name: "삭제", exact: true })
    ).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(gateway.count(action)).toBe(1);
    await expect(page.locator("[data-sonner-toast][data-type='success']")).toHaveCount(0);
    // The fixture may already have committed before a malformed acknowledgment;
    // neither this error nor the retained form proves rollback/no server write.
  });
}
for (const action of ["save", "delete"] as const) {
  for (const status of [200, 503]) {
    test(`${action} 이전 계정의 늦은 ${status}는 같은 문서 새 초안·알림·조회에 반영하지 않는다`, async ({
      page,
      context,
      gateway,
    }) => {
      await login(page);
      const other = await context.newPage();
      await login(other);
      const { dialog } = action === "save" ? await edit(page) : await remove(page);
      if (action === "save") await review(dialog);
      await page.evaluate(() => {
        (window as unknown as { tagDocumentMarker: string }).tagDocumentMarker = "public-same-document";
      });
      gateway.hold(action);
      gateway.setStatus(action, status);
      await (
        action === "save" ? save(dialog) : dialog.getByRole("button", { name: "삭제", exact: true })
      ).click();
      await expect.poll(() => gateway.count(action)).toBe(1);
      await other.getByLabel("사용자 메뉴").click();
      await other.getByRole("button", { name: "로그아웃", exact: true }).click();
      await signIn(page, secondEmail);
      expect(
        await page.evaluate(() => (window as unknown as { tagDocumentMarker?: string }).tagDocumentMarker),
      ).toBe("public-same-document");
      const next = await add(page, "public-next-session");
      await guidance(next).fill("새 계정의 공개 초안");
      await review(next);
      const reads = gateway.count("list");
      await release(gateway, action);
      await page.waitForTimeout(500);
      await expect(guidance(next)).toHaveValue("새 계정의 공개 초안");
      await expect(next).toBeVisible();
      await expect(next.getByRole("alert")).toHaveCount(0);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      expect(gateway.count("list")).toBe(reads);
      expect(writes(gateway).map(({ userId }) => userId)).toEqual(["tag-one"]);
      gateway.setStatus(action, 200);
      await save(next).click();
      await expect(next).toBeHidden();
      expect(writes(gateway).at(-1)?.userId).toBe("tag-two");
      // Held fulfill completion is not proof that an aborted response reached
      // React or that the server cancelled; overlapping old/new flight units are separate.
    });
  }
}
for (const close of ["취소", "Escape", "바깥"] as const) {
  test(`${close}는 dirty 초안을 유지 또는 명시 폐기하며 정확한 수정 버튼으로 돌아온다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    const { dialog, trigger } = await edit(page);
    const requestClose = async () => {
      if (close === "취소") await dialog.getByRole("button", { name: "취소", exact: true }).click();
      else if (close === "Escape") await page.keyboard.press("Escape");
      else await page.locator(".dialog-overlay").click({ position: { x: 4, y: 4 } });
    };
    await requestClose();
    await expect(page.getByRole("button", { name: "계속 편집", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "계속 편집", exact: true }).click();
    await expect(guidance(dialog)).toHaveValue(revised);
    if (close === "바깥") {
      // Observe async focus restoration before another physical outside click.
      await expect(
        page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다", exact: true }),
      ).toBeHidden();
      await expect(guidance(dialog)).toBeFocused();
    }
    await requestClose();
    await page.getByRole("button", { name: "변경 버리기", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(writes(gateway)).toEqual([]);
  });
}
for (const direction of ["route", "back"] as const) {
  test(`${direction} 이동은 열린 태그 초안을 보호한다`, async ({ page, gateway }) => {
    await login(page, providersUrl);
    await sidebar(page, "/app/gateway/chat");
    await page.getByRole("tab", { name: "모델 용도 태그", exact: true }).click();
    const { dialog } = await edit(page);
    const leave = async () => {
      if (direction === "back") await page.evaluate(() => history.back());
      else {
        // Native modal makes the sidebar inert to pointer input. Invoking its
        // actual handler probes router guarding, not pointer reachability.
        await page
          .locator(`a[href="${providersUrl}"]`)
          .first()
          .evaluate((node) => (node as HTMLElement).click());
      }
    };
    await leave();
    await page.getByRole("button", { name: "계속 편집", exact: true }).click();
    await expect(guidance(dialog)).toHaveValue(revised);
    await leave();
    await page.getByRole("button", { name: "변경 버리기", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(writes(gateway)).toEqual([]);
  });
}
test("실제 beforeunload를 취소하면 검토 중인 태그 초안을 유지한다", async ({ page, gateway }) => {
  await login(page);
  const { dialog } = await edit(page);
  await review(dialog);
  const shown = page.waitForEvent("dialog");
  await page.evaluate(() => {
    setTimeout(() => location.reload(), 0);
  });
  const native = await shown;
  expect(native.type()).toBe("beforeunload");
  await native.dismiss();
  await expect(guidance(dialog)).toHaveValue(revised);
  expect(writes(gateway)).toEqual([]);
});

async function keyboardBody(page: Page, dialog: Locator) {
  const hint = dialog.getByText(
    "초안은 자동 저장되지 않습니다. 내용이 길면 이 안내에 초점을 둔 뒤 위·아래 방향키로 살펴보세요.",
    { exact: true },
  );
  let steps = 0;
  do {
    await page.keyboard.press("Tab");
    steps++;
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  } while (steps < 16 && !(await hint.evaluate((node) => node === document.activeElement)));
  await expect(hint).toBeFocused();
  const body = dialog.locator(".dialog-body");
  const before = await body.evaluate((node) => node.scrollTop);
  expect(before).toBeGreaterThan(0);
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeLessThan(before);
}
async function axe(page: Page) {
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (root: Document) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
        };
      }
    ).axe;
    return (await axe.run(document)).violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map(({ target }) => target),
    }));
  });
}
test("390px 다크 검토 폼은 첫 저장·키보드·읽기 전용·pending·axe·넘침을 지킨다", async ({
  page,
  gateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  const longModel = `public/${"한글모델".repeat(30)}/model`;
  const original = "긴공개작업".repeat(60);
  const changed = "모바일새공개작업".repeat(40);
  const risk = `${"공개위험설명".repeat(45)}\n\n${"추가공개위험".repeat(45)}`;
  gateway.setRows([row(longModel, original), row(modelB, "공개 원본 B")]);
  await login(page);
  const { dialog } = await edit(page, original);
  await guidance(dialog).fill(changed);
  await dialog.getByRole("textbox", { name: "위험 메모", exact: true }).fill(risk);
  await review(dialog);
  async function readableComparison() {
    const region = dialog.locator('[aria-label="태그 변경 비교 표 영역"]');
    expect(await region.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    const table = region.getByRole("table", { name: "태그 변경 전후 비교", exact: true });
    for (const [label, before, after] of [
      ["모델", longModel, longModel],
      ["적합한 작업", original, changed],
      ["위험 메모", "공개 위험 메모", risk],
    ]) {
      const cells = table
        .getByRole("row")
        .filter({ has: page.getByRole("rowheader", { name: label, exact: true }) })
        .getByRole("cell");
      expect(await cells.nth(0).textContent()).toBe(before);
      expect(await cells.nth(1).textContent()).toBe(after);
    }
    // Entire original/review text, including internal newlines, stays in the
    // table. Explicit body scrolling is separate from always-visible claims.
  }
  await readableComparison();
  await dialog.locator("form").evaluate((form) => {
    form.setAttribute("data-native-count", "0");
    form.addEventListener("submit", () =>
      form.setAttribute("data-native-count", String(Number(form.getAttribute("data-native-count")) + 1)),
    );
  });
  gateway.setMode("read_only");
  await runtime(page);
  await expect(save(dialog)).toBeDisabled();
  await readableComparison();
  await page.screenshot({ path: info.outputPath("model-tag-mobile-transition.png") });
  await keyboardBody(page, dialog);
  const reason = dialog.getByText(readonlyReason, { exact: false });
  await reason.scrollIntoViewIfNeeded();
  await expect(reason).toBeInViewport({ ratio: 1 });
  await expect(save(dialog)).toBeInViewport({ ratio: 1 });
  for (const target of [reason, save(dialog)])
    expect(
      await target.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }),
    ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await axe(page)).toEqual([]);
  await reason.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("model-tag-mobile-dark.png") });
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("button", { name: "계속 편집", exact: true })).toBeFocused();
  await page.screenshot({ path: info.outputPath("model-tag-mobile-discard.png") });
  await page.getByRole("button", { name: "계속 편집", exact: true }).click();
  gateway.setMode("writable");
  await runtime(page);
  await expect(save(dialog)).toBeEnabled();
  gateway.hold("save");
  const before = await save(dialog).boundingBox();
  await save(dialog).click();
  await expect(dialog.locator("form")).toHaveAttribute("data-native-count", "1");
  expect((await dialog.getByRole("button", { name: "저장 중", exact: true }).boundingBox())?.y).toBe(
    before?.y,
  );
  await expect.poll(() => gateway.count("save")).toBe(1);
  await readableComparison();
  await keyboardBody(page, dialog);
  expect(await axe(page)).toEqual([]);
  await release(gateway, "save");
  await expect(dialog).toBeHidden();
  expect(gateway.count("save")).toBe(1);
  // Scroll/viewport assertions prove explicit inspection, not that a lock reason
  // is automatically always visible. No synthetic DOM focus substitutes for Tab.
});
test("390px 다크 삭제 확인은 원본 ID·취소 포커스·접근성·넘침을 지킨다", async ({ page, gateway }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  const id = `\ufeff한글/100%?${"public".repeat(25)}`;
  gateway.setRows([row(id, "공개 긴 ID")]);
  await login(page);
  const { dialog } = await remove(page, "공개 긴 ID");
  gateway.setMode("read_only");
  await runtime(page);
  await expect(dialog.getByRole("button", { name: "삭제", exact: true })).toBeDisabled();
  const originalId = dialog.locator(".model-tag-delete-target dd");
  expect(await originalId.textContent()).toBe(id.replace("\ufeff", "\\ufeff"));
  expect(await originalId.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  const description = dialog.locator(".dialog-header p");
  await expect(description).toBeInViewport({ ratio: 1 });
  expect(
    await dialog.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const description = node.querySelector(".dialog-header p")?.getBoundingClientRect();
      if (!description) return false;
      return (
        description.left >= rect.left &&
        description.right <= rect.right &&
        description.top >= rect.top &&
        description.bottom <= rect.bottom &&
        node.scrollWidth <= node.clientWidth
      );
    }),
  ).toBe(true);
  const close = dialog.getByRole("button", { name: "대화상자 닫기", exact: true });
  await expect(close).toBeInViewport({ ratio: 1 });
  expect(
    await close.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }),
  ).toBe(true);
  expect(await axe(page)).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("model-tag-delete-mobile.png") });
  await close.click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.page-stack[tabindex="-1"]')).toBeFocused();
  expect(
    await page.evaluate(() => {
      const node = document.activeElement as HTMLElement | null;
      return Boolean(
        node?.isConnected &&
        node.getBoundingClientRect().width &&
        !node.matches(":disabled") &&
        !node.closest('[inert], [aria-hidden="true"]'),
      );
    }),
  ).toBe(true);
  expect(writes(gateway)).toEqual([]);
});
