import { expect, type Locator, type Page } from "@playwright/test";
import {
  test,
  type Kind,
  modelsUrl,
  providersUrl,
  firstEmail,
  secondEmail,
  contractId,
  contractName,
  contractFixture,
  createdActor,
  deprecationFixture,
  deprecationId,
  modelGlob,
  paths,
  readonlyReason,
} from "../fixtures/model-governance-safety-gateway";

// Mock API/real React routing evidence. Actual Go authorization, persistence,
// policy execution and UTC semantics have separate HTTP/store contract tests.
const revisedName = "수정한 공개 품질 기준";
const revisedMessage = "검토 중인 공개 지원 종료 안내";
const tabs = { contracts: "모델 계약", deprecations: "지원 종료" } as const;
const contractRow = (page: Page, name = contractName) =>
  page
    .getByRole("table", { name: "작업 유형별 모델 계약" })
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name, exact: true }) });
const deprecationRow = (page: Page, glob = modelGlob) =>
  page
    .getByRole("table", { name: "모델 지원 종료 정책" })
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: glob, exact: true }) });
const guard = (page: Page) => page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" });
async function signIn(page: Page, email = firstEmail) {
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByLabel("사용자 메뉴")).toBeVisible();
}
async function login(page: Page, path = modelsUrl) {
  await page.goto(`login?return_to=${encodeURIComponent(path)}`);
  await signIn(page);
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
}
async function selectTab(page: Page, kind: Kind) {
  await page.getByRole("tab", { name: tabs[kind], exact: true }).click();
}
async function refreshRuntime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function directSubmit(dialog: Locator) {
  // Native submit reaches the actual form handler; it does not remove readonly
  // constraints or replace React state. Mutation callbacks have separate units.
  await dialog.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
}
async function forceDisabledClick(button: Locator) {
  // DOM-only bypass attempt, not proof of React onClick entry: React may suppress
  // disabled handlers. The captured-mutate unit tests prove callback boundaries.
  await button.evaluate((node) => {
    const button = node as HTMLButtonElement;
    const disabled = button.disabled;
    button.disabled = false;
    button.click();
    button.disabled = disabled;
  });
}
type Action = "계약 수정" | "계약 삭제" | "정책 저장" | "정책 삭제";
async function prepare(page: Page, action: Action) {
  const kind: Kind = action.startsWith("계약") ? "contracts" : "deprecations";
  await selectTab(page, kind);
  let trigger: Locator, dialog: Locator, field: Locator | undefined;
  if (action === "계약 수정") {
    trigger = contractRow(page).getByRole("button", { name: "수정", exact: true });
    await trigger.click();
    dialog = page.getByRole("dialog", { name: "모델 계약 수정", exact: true });
    field = dialog.getByRole("textbox", { name: "이름", exact: true });
    await field.fill(revisedName);
  } else if (action === "정책 저장") {
    trigger = page.getByRole("button", { name: "정책 추가", exact: true });
    await trigger.click();
    dialog = page.getByRole("dialog", { name: "지원 종료 정책", exact: true });
    await dialog.getByRole("textbox", { name: "모델 패턴", exact: true }).fill(modelGlob);
    field = dialog.getByRole("textbox", { name: "안내 문구", exact: true });
    await field.fill(revisedMessage);
  } else {
    trigger = (kind === "contracts" ? contractRow(page) : deprecationRow(page)).getByRole("button", {
      name: "삭제",
      exact: true,
    });
    await trigger.click();
    dialog = page.getByRole("dialog", {
      name: kind === "contracts" ? "모델 계약 삭제" : "지원 종료 정책 삭제",
      exact: true,
    });
  }
  return {
    action,
    kind,
    trigger,
    dialog,
    field,
    value: action === "계약 수정" ? revisedName : revisedMessage,
    save: dialog.getByRole("button", {
      name: action === "계약 수정" ? "변경 내용 검토" : action === "정책 저장" ? "저장" : "삭제",
      exact: true,
    }),
    call:
      action === "계약 수정"
        ? `POST ${paths.contracts}`
        : action === "계약 삭제"
          ? `DELETE ${paths.contracts}`
          : action === "정책 저장"
            ? `POST ${paths.deprecations}`
            : `DELETE ${paths.deprecations}/${encodeURIComponent(deprecationId)}`,
  };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
function draftField(current: Prepared) {
  if (!current.field) throw new Error("This synthetic action has no editable draft field");
  return current.field;
}
async function review(current: Prepared) {
  await current.save.click();
  await expect(current.dialog.getByRole("table", { name: "모델 계약 변경 전후 비교" })).toBeVisible();
  return current.dialog.getByRole("button", { name: "검토한 계약 저장", exact: true });
}
async function finalButton(current: Prepared) {
  return current.action === "계약 수정" ? review(current) : current.save;
}
async function assertAttemptBlocked(current: Prepared) {
  if (current.field) await directSubmit(current.dialog);
  else await forceDisabledClick(current.save);
}
async function refreshList(page: Page, kind: Kind, dialog?: Locator) {
  const response = page.waitForResponse(
    (item) => item.request().method() === "GET" && new URL(item.url()).pathname === paths[kind],
  );
  const button = (dialog ?? page).getByRole("button", {
    name: kind === "contracts" ? "계약 목록 다시 조회" : "정책 목록 다시 조회",
    exact: true,
  });
  await button.click();
  const received = await response;
  await received.finished();
  return received;
}
async function mainFocus(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const node = document.activeElement;
        return (
          node instanceof HTMLElement &&
          node.id === "main-content" &&
          node.isConnected &&
          node.getClientRects().length > 0
        );
      }),
    )
    .toBe(true);
}

for (const mode of ["read_only", "preview_read_only"] as const) {
  test(`${mode}는 네 저장·삭제를 막지만 admin:write의 순수 계약 계산은 허용한다`, async ({
    page,
    gateway,
  }) => {
    gateway.setMode(mode);
    await login(page);
    await selectTab(page, "contracts");
    await expect(contractRow(page)).toBeVisible();
    for (const button of [
      page.getByRole("button", { name: "계약 추가", exact: true }),
      contractRow(page).getByRole("button", { name: "수정", exact: true }),
      contractRow(page).getByRole("button", { name: "삭제", exact: true }),
    ])
      await expect(button).toBeDisabled();
    await page.getByRole("textbox", { name: "검증할 모델", exact: true }).fill("public-observed-model");
    await page.getByRole("button", { name: "계약 검증 실행", exact: true }).click();
    await expect(page.getByText("검증 결과", { exact: true })).toBeVisible();
    await expect(page.getByText(/실제 호출 성공이나 승격·교체를 보장하는 결과가 아닙니다/u)).toBeVisible();
    await expect(page.getByText(/데이터 부족/u).first()).toBeVisible();
    expect(gateway.runs).toHaveLength(1);
    expect(gateway.runs[0]?.body).toEqual({ model: "public-observed-model" });
    await selectTab(page, "deprecations");
    await expect(deprecationRow(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "정책 추가", exact: true })).toBeDisabled();
    await expect(deprecationRow(page).getByRole("button", { name: "삭제", exact: true })).toBeDisabled();
    expect(gateway.writes).toEqual([]);
  });
  for (const action of ["계약 수정", "계약 삭제", "정책 저장", "정책 삭제"] as const) {
    test(`${action}의 ${mode} 전환은 초안·대상을 보존하고 복구 뒤 수동 전송만 허용한다`, async ({
      page,
      gateway,
    }) => {
      await login(page);
      const current = await prepare(page, action);
      await current.dialog.evaluate((element) => {
        (element as HTMLElement).dataset.originalDraft = "retained";
      });
      gateway.setMode(mode);
      await refreshRuntime(page);
      await expect(current.dialog).toHaveAttribute("data-original-draft", "retained");
      await expect(current.dialog).toContainText(readonlyReason);
      await expect(current.save).toBeDisabled();
      if (current.field) {
        await expect(current.field).toHaveValue(current.value);
        await expect(current.field).toBeDisabled();
      } else await expect(current.dialog).toContainText(action === "계약 삭제" ? contractName : modelGlob);
      await assertAttemptBlocked(current);
      expect(gateway.writes).toEqual([]);
      gateway.setMode("writable");
      await refreshRuntime(page);
      await expect(current.save).toBeEnabled();
      expect(gateway.writes).toEqual([]);
      await (await finalButton(current)).click();
      await expect(current.dialog).toBeHidden();
      expect(gateway.writes.map(({ call }) => call)).toEqual([current.call]);
      if (action === "계약 수정")
        expect(gateway.writes[0]?.body).toMatchObject({ id: contractId, name: revisedName });
      if (action === "계약 삭제") expect(gateway.writes[0]?.id).toBe(contractId);
      if (action === "정책 저장")
        expect(gateway.writes[0]?.body).toMatchObject({ model_glob: modelGlob, message: revisedMessage });
    });
  }
}

test("계약 편집은 재조회로 기준을 바꾸지 않고 원래 ID의 한 행만 갱신한다", async ({ page, gateway }) => {
  await login(page);
  const current = await prepare(page, "계약 수정");
  await current.dialog.getByRole("textbox", { name: "최소 품질 점수", exact: true }).fill("83.25");
  gateway.setContracts([{ ...contractFixture(), name: "다른 관리자가 변경한 이름", min_quality_score: 99 }]);
  await refreshList(page, "contracts", current.dialog);
  await expect(draftField(current)).toHaveValue(revisedName);
  const save = await review(current);
  const table = current.dialog.getByRole("table", { name: "모델 계약 변경 전후 비교" });
  await expect(
    table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "이름", exact: true }) }),
  ).toContainText(contractName);
  await expect(table).not.toContainText("다른 관리자가 변경한 이름");
  const quality = table
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "최소 품질 점수", exact: true }) });
  await expect(quality).toContainText("70");
  await expect(quality).toContainText("83.25");
  await expect(current.dialog).toContainText(contractId);
  await expect(current.dialog).toContainText("동시 변경을 막거나 병합하지 않습니다");
  await save.click();
  await expect(current.dialog).toBeHidden();
  expect(gateway.writes).toHaveLength(1);
  expect(gateway.writes[0]?.body).toEqual({
    id: contractId,
    name: revisedName,
    task_type: "code_review",
    min_quality_score: 83.25,
    min_golden_pass_rate: 0.8,
    min_success_rate: 0.95,
    max_latency_ms: 4000,
    max_avg_cost_krw: 12,
    enabled: true,
  });
  expect(gateway.getContracts()).toHaveLength(1);
  expect(gateway.getContracts()[0]).toMatchObject({
    id: contractId,
    name: revisedName,
    created_by: createdActor,
  });
  await expect(
    contractRow(page, revisedName).getByRole("button", { name: "수정", exact: true }),
  ).toBeFocused();
});

test("검토 단계도 최신 readonly를 적용하고 다시 편집한 값만 새 검토로 저장한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const current = await prepare(page, "계약 수정"),
    save = await review(current);
  gateway.setMode("read_only");
  await refreshRuntime(page);
  await expect(save).toBeDisabled();
  await expect(current.dialog.getByRole("button", { name: "다시 편집", exact: true })).toBeDisabled();
  await directSubmit(current.dialog);
  expect(gateway.writes).toEqual([]);
  gateway.setMode("writable");
  await refreshRuntime(page);
  await current.dialog.getByRole("button", { name: "다시 편집", exact: true }).click();
  await draftField(current).fill("재검토한 공개 계약");
  await (await review(current)).click();
  await expect(current.dialog).toBeHidden();
  expect(gateway.writes[0]?.body).toMatchObject({ id: contractId, name: "재검토한 공개 계약" });
});

for (const action of ["계약 수정", "계약 삭제", "정책 저장", "정책 삭제"] as const) {
  test(`${action}은 Preview 복구만으로 잃은 admin:write 권한을 대신하지 않는다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    const current = await prepare(page, action);
    gateway.setWriteScope(false);
    await refreshRuntime(page);
    await expect(current.save).toBeDisabled();
    await expect(current.dialog).toContainText("admin:write");
    await assertAttemptBlocked(current);
    expect(gateway.writes).toEqual([]);
    gateway.setWriteScope(true);
    await refreshRuntime(page);
    await expect(current.save).toBeEnabled();
    await (await finalButton(current)).click();
    await expect(current.dialog).toBeHidden();
    expect(gateway.writes).toHaveLength(1);
  });
}
test("순수 계약 검증도 최신 admin:write가 없으면 POST를 보내지 않는다", async ({ page, gateway }) => {
  await login(page);
  await selectTab(page, "contracts");
  await page.getByRole("textbox", { name: "검증할 모델", exact: true }).fill("public-observed-model");
  gateway.setMode("read_only");
  gateway.setWriteScope(false);
  await refreshRuntime(page);
  const run = page.getByRole("button", { name: "계약 검증 실행", exact: true });
  await expect(run).toBeDisabled();
  await forceDisabledClick(run);
  expect(gateway.runs).toEqual([]);
  gateway.setWriteScope(true);
  await refreshRuntime(page);
  await run.click();
  await expect(page.getByText("검증 결과", { exact: true })).toBeVisible();
  expect(gateway.runs).toHaveLength(1);
  expect(gateway.writes).toEqual([]);
});

for (const kind of ["contracts", "deprecations"] as const) {
  test(`${tabs[kind]} 확인된 빈 배열은 미확인 응답과 구분하고 추가할 수 있다`, async ({ page, gateway }) => {
    if (kind === "contracts") gateway.setContracts([]);
    else gateway.setDeprecations([]);
    await login(page);
    await selectTab(page, kind);
    await expect(
      page.getByText(
        kind === "contracts" ? "등록된 모델 계약이 없습니다." : "등록된 지원 종료 정책이 없습니다.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: kind === "contracts" ? "계약 추가" : "정책 추가", exact: true }),
    ).toBeEnabled();
    expect(gateway.writes).toEqual([]);
  });
  for (const failure of ["missing", "null", "partial", "503"] as const) {
    test(`${tabs[kind]} ${failure} 응답은 빈 목록이 아니라 미확인 오류이며 다시 조회해 복구한다`, async ({
      page,
      gateway,
    }) => {
      if (failure === "503") gateway.setReadStatus(kind, 503);
      else
        gateway.setReadPayload(
          kind,
          failure === "missing"
            ? {}
            : failure === "null"
              ? { [kind]: null }
              : { [kind]: [{ id: "partial-row", name: "불완전한 행" }] },
        );
      await login(page);
      await selectTab(page, kind);
      await expect(
        page.getByText(
          kind === "contracts" ? "모델 계약을 불러오지 못했습니다." : "지원 종료 정책을 불러오지 못했습니다.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: kind === "contracts" ? "계약 추가" : "정책 추가", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByText(
          kind === "contracts" ? "등록된 모델 계약이 없습니다." : "등록된 지원 종료 정책이 없습니다.",
          { exact: true },
        ),
      ).toBeHidden();
      await expect(page.getByText(/요청 ID: req-model-governance/u)).toBeVisible();
      gateway.setReadStatus(kind, 200);
      gateway.clearReadPayload(kind);
      await page.getByRole("button", { name: "다시 시도", exact: true }).click();
      await expect(kind === "contracts" ? contractRow(page) : deprecationRow(page)).toBeVisible();
      expect(gateway.writes).toEqual([]);
    });
  }
  test(`${tabs[kind]} 열린 초안은 목록 재조회 중과 오류에 잠기고 성공 확인 뒤에만 수동 저장된다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    const current = await prepare(page, kind === "contracts" ? "계약 수정" : "정책 저장");
    gateway.hold(`read:${kind}`);
    const starting = gateway.reads.filter((call) => call === `GET ${paths[kind]}`).length;
    const pending = refreshList(page, kind, current.dialog);
    await expect
      .poll(() => gateway.reads.filter((call) => call === `GET ${paths[kind]}`).length)
      .toBe(starting + 1);
    await expect(current.save).toBeDisabled();
    await expect(draftField(current)).toHaveValue(current.value);
    await directSubmit(current.dialog);
    expect(gateway.writes).toEqual([]);
    gateway.release(`read:${kind}`);
    await pending;
    await expect(current.save).toBeEnabled();
    gateway.setReadStatus(kind, 503);
    await refreshList(page, kind, current.dialog);
    await expect(current.dialog).toContainText("req-model-governance");
    await expect(current.save).toBeDisabled();
    await directSubmit(current.dialog);
    expect(gateway.writes).toEqual([]);
    gateway.setReadStatus(kind, 200);
    await current.dialog.getByRole("button", { name: "다시 시도", exact: true }).click();
    await expect(current.save).toBeEnabled();
    await expect(draftField(current)).toHaveValue(current.value);
    await (await finalButton(current)).click();
    await expect(current.dialog).toBeHidden();
    expect(gateway.writes).toHaveLength(1);
  });
}

test("지원 종료 추가는 동일 패턴을 갱신하며 201 응답과 UTC·빈 값 동작을 명확히 표시한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const current = await prepare(page, "정책 저장");
  await expect(current.dialog).toContainText("UTC");
  await expect(current.dialog).toContainText(/같은|동일/u);
  await expect(current.dialog).toContainText(/비우면.*경고/u);
  await current.dialog
    .getByRole("textbox", { name: "모델 패턴", exact: true })
    .fill(` ${modelGlob.toUpperCase()} `);
  const response = page.waitForResponse(
    (item) => item.request().method() === "POST" && new URL(item.url()).pathname === paths.deprecations,
  );
  await current.save.click();
  expect((await response).status()).toBe(201);
  await expect(current.dialog).toBeHidden();
  expect(gateway.writes[0]?.body).toEqual({
    model_glob: modelGlob.toUpperCase(),
    message: revisedMessage,
  });
  expect(gateway.getDeprecations()).toHaveLength(1);
  expect(gateway.getDeprecations()[0]).toMatchObject({
    id: deprecationId,
    replacement: "",
    sunset_date: "",
    message: revisedMessage,
  });
});

for (const action of ["계약 삭제", "정책 삭제"] as const) {
  test(`${action} 확인 대상은 목록의 새 이름·다른 행 재조회로 바뀌지 않는다`, async ({ page, gateway }) => {
    await login(page);
    const current = await prepare(page, action);
    if (action === "계약 삭제")
      gateway.setContracts([
        { ...contractFixture(), id: "another-contract", name: "다른 계약" },
        { ...contractFixture(), name: "재조회된 계약 이름" },
      ]);
    else
      gateway.setDeprecations([
        { ...deprecationFixture(), id: "another-policy", model_glob: "another-*" },
        { ...deprecationFixture(), model_glob: "refreshed-*" },
      ]);
    await refreshList(page, current.kind, current.dialog);
    await expect(current.dialog).toContainText(action === "계약 삭제" ? contractName : modelGlob);
    await expect(current.dialog).not.toContainText(
      action === "계약 삭제" ? "재조회된 계약 이름" : "refreshed-*",
    );
    await current.save.click();
    await expect(current.dialog).toBeHidden();
    expect(gateway.writes).toHaveLength(1);
    if (action === "계약 삭제") {
      expect(gateway.writes[0]?.id).toBe(contractId);
      expect(gateway.getContracts().map(({ id }) => id)).toEqual(["another-contract"]);
    } else {
      expect(gateway.writes[0]?.call).toBe(current.call);
      expect(gateway.getDeprecations().map(({ id }) => id)).toEqual(["another-policy"]);
    }
  });
}

test("별도 ID로 가져온 지원 종료 항목은 같은 패턴 POST로 덮어쓰지 않고 표준 ID의 새 항목과 공존한다", async ({
  page,
  gateway,
}) => {
  const imported = { ...deprecationFixture(), id: "가져온_정책", message: "기존 가져온 정책 안내" };
  gateway.setDeprecations([imported]);
  await login(page);
  const current = await prepare(page, "정책 저장");
  await current.save.click();
  await expect(current.dialog).toBeHidden();
  expect(gateway.writes[0]?.body).not.toHaveProperty("id");
  expect(gateway.getDeprecations()).toHaveLength(2);
  expect(gateway.getDeprecations().find(({ id }) => id === imported.id)).toEqual(imported);
  expect(gateway.getDeprecations().find(({ id }) => id === deprecationId)).toMatchObject({
    message: revisedMessage,
  });
});

for (const action of ["계약 수정", "계약 삭제", "정책 저장", "정책 삭제"] as const) {
  test(`${action} 전송 중 중복·취소는 잠기며 readonly 이후 이미 보낸 성공을 취소했다고 표시하지 않는다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    const current = await prepare(page, action),
      save = await finalButton(current);
    gateway.hold("write");
    await save.click();
    await expect.poll(() => gateway.writes.length).toBe(1);
    await expect(current.dialog.getByRole("button", { name: "취소", exact: true })).toBeDisabled();
    if (current.field && action === "정책 저장") await expect(current.field).toBeDisabled();
    if (current.field) {
      await directSubmit(current.dialog);
      await directSubmit(current.dialog);
    } else await forceDisabledClick(current.dialog.getByRole("button", { name: "처리 중", exact: true }));
    gateway.setMode("read_only");
    await refreshRuntime(page);
    await page.keyboard.press("Escape");
    await expect(current.dialog).toBeVisible();
    expect(gateway.writes).toHaveLength(1);
    gateway.release("write");
    await expect(current.dialog).toBeHidden();
    await expect(
      page.getByRole("button", {
        name: current.kind === "contracts" ? "계약 추가" : "정책 추가",
        exact: true,
      }),
    ).toBeDisabled();
    expect(gateway.writes).toHaveLength(1);
    await mainFocus(page);
  });
}
for (const action of ["계약 수정", "정책 저장"] as const) {
  test(`${action} 실패는 요청 ID·입력을 유지하고 수동 재시도만 전송한다`, async ({ page, gateway }) => {
    await login(page);
    const current = await prepare(page, action),
      save = await finalButton(current);
    gateway.setWriteStatus(503);
    await save.click();
    await expect(current.dialog.getByRole("alert")).toContainText("req-model-governance");
    await expect(current.dialog).toContainText(action === "계약 수정" ? revisedName : "지원 종료 정책");
    if (action === "정책 저장") await expect(draftField(current)).toHaveValue(revisedMessage);
    expect(gateway.writes).toHaveLength(1);
    gateway.setWriteStatus(200);
    await save.click();
    await expect(current.dialog).toBeHidden();
    expect(gateway.writes).toHaveLength(2);
    expect(gateway.writes[1]?.body).toEqual(gateway.writes[0]?.body);
  });
  test(`${action} 성공 후 목록 실패는 저장 실패나 자동 재전송으로 바뀌지 않는다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    const current = await prepare(page, action),
      save = await finalButton(current);
    gateway.setReadStatus(current.kind, 503);
    await save.click();
    await expect(current.dialog).toBeHidden();
    await expect(page.getByText(/요청 ID: req-model-governance/u)).toBeVisible();
    expect(gateway.writes).toHaveLength(1);
    gateway.setReadStatus(current.kind, 200);
    await page.getByRole("button", { name: "다시 시도", exact: true }).click();
    await expect(
      current.kind === "contracts" ? contractRow(page, revisedName) : deprecationRow(page),
    ).toBeVisible();
    expect(gateway.writes).toHaveLength(1);
  });
  for (const status of [200, 503]) {
    test(`${action} 이전 계정의 늦은 ${status}는 새 계정 편집창과 알림을 변경하지 않는다`, async ({
      page,
      context,
      gateway,
    }) => {
      await login(page);
      const other = await context.newPage();
      await login(other);
      const current = await prepare(page, action),
        save = await finalButton(current);
      gateway.setWriteStatus(status);
      gateway.hold("write");
      await save.click();
      await expect.poll(() => gateway.writes.length).toBe(1);
      await other.getByLabel("사용자 메뉴").click();
      await other.getByRole("button", { name: "로그아웃", exact: true }).click();
      await signIn(page, secondEmail);
      const next = await prepare(page, action);
      await draftField(next).fill("새 계정의 별도 초안");
      const response = page.waitForResponse(
        (item) => `${item.request().method()} ${new URL(item.url()).pathname}` === current.call,
      );
      gateway.release("write");
      await (await response).finished();
      await page.waitForTimeout(300);
      await expect(next.dialog).toBeVisible();
      await expect(draftField(next)).toHaveValue("새 계정의 별도 초안");
      await expect(next.dialog.getByRole("alert")).toHaveCount(0);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      expect(gateway.writes).toHaveLength(1);
      expect(gateway.writes[0]?.userId).toBe("model-one");
    });
  }
}

for (const action of ["계약 수정", "정책 저장"] as const) {
  for (const way of ["취소", "Escape", "배경"] as const) {
    test(`${action} ${way} 닫기는 계속 편집·명시적 폐기와 원래 trigger 포커스를 지킨다`, async ({
      page,
      gateway,
    }) => {
      await login(page);
      const current = await prepare(page, action);
      if (way === "취소") await current.dialog.getByRole("button", { name: "취소", exact: true }).click();
      else if (way === "Escape") await page.keyboard.press("Escape");
      else await page.mouse.click(3, 3);
      await guard(page).getByRole("button", { name: "계속 편집", exact: true }).click();
      await expect(draftField(current)).toHaveValue(current.value);
      await current.dialog.getByRole("button", { name: "취소", exact: true }).click();
      await guard(page).getByRole("button", { name: "변경 버리기", exact: true }).click();
      await expect(current.dialog).toBeHidden();
      await expect(current.trigger).toBeFocused();
      expect(gateway.writes).toEqual([]);
    });
  }
  test(`${action} 새로고침은 실제 beforeunload로 미저장 변경을 보호한다`, async ({ page, gateway }) => {
    await login(page);
    const current = await prepare(page, action);
    const pending = page.waitForEvent("dialog");
    // A canceled native reload has no completed navigation to await. Trigger the
    // real reload separately, then inspect the retained document after dismissal.
    await page.evaluate(() => {
      setTimeout(() => location.reload(), 0);
    });
    const native = await pending;
    expect(native.type()).toBe("beforeunload");
    await native.dismiss();
    await expect(draftField(current)).toHaveValue(current.value);
    expect(gateway.writes).toEqual([]);
  });
}

async function goBySidebar(page: Page, target: string) {
  const link = page.locator(`a[href="${target}"]`).first();
  if (!(await link.isVisible()))
    await page.getByRole("button", { name: /^AI Gateway|^AI 게이트웨이/u }).click();
  await link.click();
}
for (const way of ["경로 이동", "뒤로가기"] as const) {
  test(`계약 초안 ${way}는 실제 SPA history를 보호하고 폐기 후에만 이동한다`, async ({ page, gateway }) => {
    await login(page, providersUrl);
    await goBySidebar(page, modelsUrl);
    await expect(page).toHaveURL(new RegExp(`${modelsUrl}$`));
    const current = await prepare(page, "계약 수정");
    if (way === "뒤로가기") await page.goBack();
    else {
      // Background link is inert behind the modal; invoke its actual React Link
      // handler solely to exercise route coordination, not pointer reachability.
      await page
        .locator(`a[href="${providersUrl}"]`)
        .first()
        .evaluate((link) => (link as HTMLAnchorElement).click());
    }
    await guard(page).getByRole("button", { name: "계속 편집", exact: true }).click();
    await expect(draftField(current)).toHaveValue(revisedName);
    if (way === "뒤로가기") await page.goBack();
    else
      await page
        .locator(`a[href="${providersUrl}"]`)
        .first()
        .evaluate((link) => (link as HTMLAnchorElement).click());
    await guard(page).getByRole("button", { name: "변경 버리기", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${providersUrl}$`));
    expect(gateway.writes).toEqual([]);
  });
}

test("기존 계약 ID는 공백 정규화하지 않으며 모호한 대상·중복 행을 조작하지 않는다", async ({
  page,
  gateway,
}) => {
  gateway.setContracts([
    contractFixture(),
    { ...contractFixture(), id: ` ${contractId}`, name: "공백이 있는 ID" },
    { ...contractFixture(), id: `\u0085${contractId}`, name: "NEL이 있는 ID" },
    { ...contractFixture(), id: "duplicate", name: "중복 ID 첫 행" },
    { ...contractFixture(), id: "duplicate", name: "중복 ID 다음 행" },
  ]);
  await login(page);
  await selectTab(page, "contracts");
  for (const name of ["공백이 있는 ID", "NEL이 있는 ID", "중복 ID 첫 행", "중복 ID 다음 행"]) {
    for (const label of ["수정", "삭제"])
      await expect(contractRow(page, name).getByRole("button", { name: label, exact: true })).toBeDisabled();
  }
  const current = await prepare(page, "계약 삭제");
  await current.save.click();
  await expect(current.dialog).toBeHidden();
  expect(gateway.writes[0]?.id).toBe(contractId);
  expect(gateway.getContracts()).toHaveLength(4);
});

test("지원 종료의 경로가 모호한 기존 ID는 회수하지 않고 정확한 한글 ID만 삭제한다", async ({
  page,
  gateway,
}) => {
  const unicodeId = "moddep_public_정책";
  gateway.setDeprecations([
    { ...deprecationFixture(), id: unicodeId },
    { ...deprecationFixture(), id: "/ambiguous", model_glob: "ambiguous-*" },
    { ...deprecationFixture(), id: "..", model_glob: "parent-*" },
  ]);
  await login(page);
  await selectTab(page, "deprecations");
  for (const glob of ["ambiguous-*", "parent-*"])
    await expect(
      deprecationRow(page, glob).getByRole("button", { name: "삭제", exact: true }),
    ).toBeDisabled();
  const current = await prepare(page, "정책 삭제");
  await current.save.click();
  await expect(current.dialog).toBeHidden();
  expect(gateway.writes[0]?.call).toBe(`DELETE ${paths.deprecations}/${encodeURIComponent(unicodeId)}`);
  expect(gateway.getDeprecations()).toHaveLength(2);
});

test("첫 물리 클릭은 native submit 한 번이며 잘못된 기준은 첫 오류로 이동하고 소수·0 의미를 보존한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await selectTab(page, "contracts");
  await page.getByRole("button", { name: "계약 추가", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "모델 계약 추가", exact: true });
  await dialog.locator("form").evaluate((form) => {
    form.dataset.submits = "0";
    form.addEventListener("submit", () => {
      form.dataset.submits = String(Number(form.dataset.submits) + 1);
    });
  });
  const save = dialog.getByRole("button", { name: "저장", exact: true });
  await save.click();
  await expect(dialog.locator("form")).toHaveAttribute("data-submits", "1");
  await expect(dialog.getByRole("textbox", { name: "이름", exact: true })).toBeFocused();
  expect(gateway.writes).toEqual([]);
  await dialog.getByRole("textbox", { name: "이름", exact: true }).fill(" \u0085 ");
  await save.click();
  await expect(dialog.locator("form")).toHaveAttribute("data-submits", "2");
  await expect(dialog.getByRole("textbox", { name: "이름", exact: true })).toBeFocused();
  expect(gateway.writes).toEqual([]);
  await dialog.getByRole("textbox", { name: "이름", exact: true }).fill("새 공개 소수 기준");
  const latency = dialog.getByRole("textbox", { name: "최대 평균 지연(ms)", exact: true });
  await latency.fill("1.5");
  await save.click();
  await expect(dialog.locator("form")).toHaveAttribute("data-submits", "3");
  await expect(latency).toBeFocused();
  expect(gateway.writes).toEqual([]);
  await latency.fill("0");
  await dialog.getByRole("textbox", { name: "최대 평균 비용(원)", exact: true }).fill("0.00000001");
  await save.click();
  await expect(dialog).toBeHidden();
  expect(gateway.writes).toHaveLength(1);
  expect(gateway.writes[0]?.body).toMatchObject({
    name: "새 공개 소수 기준",
    min_quality_score: 0,
    max_latency_ms: 0,
    max_avg_cost_krw: 0.00000001,
  });
  expect(gateway.writes[0]?.body).not.toHaveProperty("id");
});

test("지원 종료의 실제 날짜 오류는 첫 클릭·포커스로 알리고 UTC 날짜 문자열을 그대로 전송한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const current = await prepare(page, "정책 저장");
  const date = current.dialog.getByRole("textbox", { name: "종료일", exact: true });
  await date.fill("2026-02-30");
  await current.dialog.locator("form").evaluate((form) => {
    form.dataset.submits = "0";
    form.addEventListener("submit", () => {
      form.dataset.submits = String(Number(form.dataset.submits) + 1);
    });
  });
  await current.save.click();
  await expect(current.dialog.locator("form")).toHaveAttribute("data-submits", "1");
  await expect(date).toBeFocused();
  await expect(current.dialog).toContainText("실제 날짜를 YYYY-MM-DD 형식으로 입력하세요.");
  expect(gateway.writes).toEqual([]);
  await date.fill("2028-02-29");
  await current.save.click();
  await expect(current.dialog).toBeHidden();
  expect(gateway.writes).toHaveLength(1);
  expect(gateway.writes[0]?.body).toMatchObject({ sunset_date: "2028-02-29" });
});

async function mobileCheck(page: Page, dialog: Locator) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const violations = await page.evaluate(async () => {
    const api = (
      window as unknown as {
        axe: { run: (root: Document) => Promise<{ violations: { id: string; impact: string | null }[] }> };
      }
    ).axe;
    return (await api.run(document)).violations.map(({ id, impact }) => ({ id, impact }));
  });
  expect(violations).toEqual([]);
}
for (const action of ["계약 수정", "정책 저장"] as const) {
  test(`390px 다크 ${action}은 검토·읽기 전용·폐기 확인의 넘침과 접근성·포커스를 지킨다`, async ({
    page,
    gateway,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
    await login(page);
    const current = await prepare(page, action);
    await mobileCheck(page, current.dialog);
    // The surrounding model tabs stay inert while the editor is modal. Verify
    // actual keyboard confinement rather than inventing a background tab click.
    for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      expect(await current.dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    await page.screenshot({ path: info.outputPath(`model-governance-${action}-editor.png`) });
    const save = await finalButton(current);
    if (action === "계약 수정") {
      await expect(
        current.dialog.getByRole("heading", { name: "변경 내용 검토", exact: true }),
      ).toBeFocused();
      await current.dialog
        .getByRole("table", { name: "모델 계약 변경 전후 비교" })
        .getByRole("row")
        .last()
        .scrollIntoViewIfNeeded();
    }
    gateway.setMode("preview_read_only");
    await refreshRuntime(page);
    await expect(save).toBeDisabled();
    if (action === "계약 수정") {
      // Preserve the operator's lower review-table position. This screenshot
      // proves the footer reason is visible without jumping to the top notice.
      await expect(current.dialog.getByRole("table", { name: "모델 계약 변경 전후 비교" })).toBeInViewport();
      await expect(current.dialog.locator(".dialog-footer").getByRole("status")).toHaveText(
        "읽기 전용 · 저장 잠김",
      );
      await expect(current.dialog.locator(".dialog-footer").getByRole("status")).toBeInViewport();
      await expect(save).toBeInViewport();
      await expect(save).toHaveAccessibleDescription("읽기 전용 · 저장 잠김");
      await mobileCheck(page, current.dialog);
      await page.screenshot({
        path: info.outputPath("model-governance-contract-review-footer-readonly.png"),
      });
      const comparison = current.dialog.getByLabel("계약 변경 비교 표 영역", { exact: true });
      await comparison.focus();
      for (let step = 0; step < 12; step += 1) await page.keyboard.press("ArrowRight");
      await expect.poll(() => comparison.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      await expect(comparison.getByRole("cell", { name: revisedName, exact: true })).toBeInViewport();
      await expect(current.dialog.locator(".dialog-footer").getByRole("status")).toBeInViewport();
      await mobileCheck(page, current.dialog);
      await page.screenshot({
        path: info.outputPath("model-governance-contract-review-keyboard-scroll.png"),
      });
    }
    await current.dialog.getByText(readonlyReason, { exact: true }).scrollIntoViewIfNeeded();
    await expect(current.dialog.getByText(readonlyReason, { exact: true })).toBeInViewport();
    await mobileCheck(page, current.dialog);
    await page.screenshot({ path: info.outputPath(`model-governance-${action}-readonly.png`) });
    await current.dialog.getByRole("button", { name: "취소", exact: true }).click();
    await mobileCheck(page, guard(page));
    await guard(page).getByRole("button", { name: "변경 버리기", exact: true }).click();
    await expect(current.dialog).toBeHidden();
    await mainFocus(page);
    expect(gateway.writes).toEqual([]);
  });
}
