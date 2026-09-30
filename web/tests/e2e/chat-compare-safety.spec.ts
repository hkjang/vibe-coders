import { expect, type Locator, type Page } from "@playwright/test";
import {
  test,
  type Action,
  type CompareGateway,
  chatUrl,
  providersUrl,
  firstEmail,
  secondEmail,
  promptA,
  promptB,
  promptC,
  modelA,
  modelC,
  readonlyReason,
  basePath,
  runPath,
} from "../fixtures/chat-compare-safety-gateway";

// Real React and FeatureRoute, synthetic HTTP. No Go authorization, persistence,
// paid model, incremental streaming, cancellation or rollback proof is claimed.
const run = (page: Page) => page.getByRole("button", { name: "멀티 실행", exact: true });
const judge = (page: Page) => page.getByRole("button", { name: "자동 평가 실행", exact: true });
const question = (page: Page) => page.getByRole("textbox", { name: "사용자 질문", exact: true });
const models = (page: Page) => page.getByRole("textbox", { name: "비교할 모델", exact: true });
const answer = (page: Page, id = "public-run-1") =>
  page.locator(".gateway-compare-card .chat-turn-body").filter({ hasText: `공개 비교 응답 ${id}` });
const forms = [
  {
    action: "feedback",
    label: "평가 남기기",
    title: "모델 평가 남기기",
    field: "의견",
    value: "공개 사람 평가",
    save: "저장",
  },
  {
    action: "promote",
    label: "라우팅 후보로 승격",
    title: "라우팅 후보로 승격",
    field: "사유",
    value: "공개 라우팅 후보 사유",
    save: "초안으로 저장",
  },
  {
    action: "golden",
    label: "골든 답변으로 저장",
    title: "골든 답변으로 저장",
    field: "워크플로 이름",
    value: "공개 회귀 워크플로",
    save: "저장",
  },
] as const;
type FormCase = (typeof forms)[number];
async function signIn(page: Page, email = firstEmail) {
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByLabel("사용자 메뉴")).toBeVisible();
}
async function login(page: Page, path = chatUrl) {
  await page.goto(`login?return_to=${encodeURIComponent(path)}`);
  await signIn(page);
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
  if (path === chatUrl) await expect(run(page)).toBeVisible();
}
async function refreshRuntime(page: Page) {
  const received = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admin/ui-bootstrap",
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await received).finished();
}
async function complete(page: Page, text = promptA, model = modelA, id = "public-run-1") {
  await models(page).fill(`${model}:public-provider`);
  await question(page).fill(text);
  await run(page).click();
  await expect(answer(page, id)).toBeVisible();
}
async function openForm(page: Page, scenario: FormCase) {
  const trigger = page.getByRole("button", { name: scenario.label, exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: scenario.title, exact: true });
  const field = dialog.getByRole("textbox", { name: scenario.field, exact: true });
  await field.fill(scenario.value);
  return { dialog, field, trigger, save: dialog.getByRole("button", { name: scenario.save, exact: true }) };
}
async function directSubmit(dialog: Locator) {
  await dialog.locator("form").evaluate((element) => (element as HTMLFormElement).requestSubmit());
}
async function forceDisabledClick(button: Locator) {
  // DOM bypass attempt only: React may suppress disabled onClick. The captured
  // callback unit lane separately proves direct admission guards.
  await button.evaluate((node) => {
    const target = node as HTMLButtonElement,
      disabled = target.disabled;
    target.disabled = false;
    target.click();
    target.disabled = disabled;
  });
}
async function release(gateway: CompareGateway, action: Action) {
  const before = gateway.finished.filter((value) => value === action).length;
  gateway.release(action);
  await expect.poll(() => gateway.finished.filter((value) => value === action).length).toBe(before + 1);
}
const last = (gateway: CompareGateway, action: Action) =>
  gateway.operations.filter((item) => item.action === action).at(-1);
async function bySidebar(page: Page, path: string) {
  const link = page.locator(`a[href="${path}"]`).first();
  if (!(await link.isVisible()))
    await page.getByRole("button", { name: /^AI Gateway|^AI 게이트웨이/u }).click();
  await link.click();
}
async function axeViolations(page: Page) {
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (root: Document) => Promise<{
            violations: { id: string; impact: string | null; nodes: { target: string[] }[] }[];
          }>;
        };
      }
    ).axe;
    return (await axe.run(document)).violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map(({ target }) => target),
    }));
  });
}
async function keyboardReadBody(page: Page, dialog: Locator) {
  const hint = dialog.getByText("내용이 길면 이 안내에 초점을 둔 뒤 위·아래 방향키로 살펴볼 수 있습니다.", {
    exact: true,
  });
  // Actual Tab navigation, not focus()/scrollTop assignment. Reaching the last
  // body item scrolls naturally; ArrowUp must then scroll the ancestor body.
  const focusSteps = [];
  for (
    let step = 0;
    step < 12 && (step === 0 || !(await hint.evaluate((node) => node === document.activeElement)));
    step++
  ) {
    await page.keyboard.press("Tab");
    focusSteps.push(
      await hint.evaluate((node) => ({
        activeTag: document.activeElement?.tagName,
        activeClass: document.activeElement?.className,
        activeLabel: document.activeElement?.getAttribute("aria-label"),
        hintFocused: document.activeElement === node,
        insideDialog: Boolean(node.closest('[role="dialog"]')?.contains(document.activeElement)),
        disabledFieldset: Boolean(node.closest("fieldset:disabled")),
        bodyScrollTop: node.closest(".dialog-body")?.scrollTop,
      })),
    );
  }
  if (!(await hint.evaluate((node) => node === document.activeElement)))
    await test.info().attach("keyboard-scroll-focus", {
      body: JSON.stringify(focusSteps),
      contentType: "application/json",
    });
  expect(focusSteps.length).toBeGreaterThan(0);
  expect(focusSteps.every(({ insideDialog }) => insideDialog)).toBe(true);
  await expect(hint).toBeFocused();
  const body = dialog.locator(".dialog-body");
  const before = await body.evaluate((node) => node.scrollTop);
  expect(before).toBeGreaterThan(0);
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeLessThan(before);
  await expect(hint).toBeFocused();
}

for (const mode of ["read_only", "preview_read_only"] as const) {
  test(`${mode}: 실행·자동평가 초안 유지와 기존 scope 아래 수동 회복`, async ({ page, gateway }) => {
    await login(page);
    await complete(page);
    await question(page).fill(promptB);
    await models(page).fill(`${modelC}:public-provider`);
    await page.getByLabel("실행 제목", { exact: true }).fill("공개 다음 실행");
    await page.getByLabel("시스템 지침", { exact: true }).fill("공개 시스템 지침");
    await page.getByLabel("자동 평가 방식", { exact: true }).selectOption("model");
    await page.getByRole("textbox", { name: "심사 모델", exact: true }).fill("public-judge");
    gateway.setMode(mode);
    await refreshRuntime(page);
    await expect(run(page)).toBeDisabled();
    await expect(judge(page)).toBeDisabled();
    await expect(page.getByText(readonlyReason, { exact: false })).toBeVisible();
    await forceDisabledClick(run(page));
    await forceDisabledClick(judge(page));
    expect(gateway.count("run")).toBe(1);
    expect(gateway.count("judge")).toBe(0);
    await expect(question(page)).toHaveValue(promptB);
    await expect(models(page)).toHaveValue(`${modelC}:public-provider`);
    gateway.setMode("writable");
    await refreshRuntime(page);
    await expect(judge(page)).toBeEnabled();
    expect(gateway.count("judge")).toBe(0);
    await judge(page).click();
    await expect(page.getByText("자동 평가 완료", { exact: true })).toBeVisible();
    expect(last(gateway, "judge")?.body).toEqual({
      run_id: "public-run-1",
      method: "model",
      judge_model: "public-judge",
    });
    await run(page).click();
    await expect(answer(page, "public-run-2")).toBeVisible();
    expect(last(gateway, "run")?.body).toMatchObject({
      title: "공개 다음 실행",
      models: [{ model: modelC, provider: "public-provider" }],
      save_prompt: false,
      messages: [
        { role: "system", content: "공개 시스템 지침" },
        { role: "user", content: promptB },
      ],
    });
  });
  for (const scenario of forms) {
    test(`${mode}: ${scenario.action} 열린 초안은 잠기고 native submit 0, 복구 후 수동 1`, async ({
      page,
      gateway,
    }) => {
      await login(page);
      await complete(page);
      const current = await openForm(page, scenario);
      gateway.setMode(mode);
      await refreshRuntime(page);
      await expect(current.field).toHaveValue(scenario.value);
      await expect(current.field).toBeDisabled();
      await expect(current.save).toBeDisabled();
      await expect(current.dialog.getByText(readonlyReason, { exact: true })).toBeVisible();
      await directSubmit(current.dialog);
      expect(gateway.count(scenario.action)).toBe(0);
      gateway.setMode("writable");
      await refreshRuntime(page);
      await expect(current.save).toBeEnabled();
      expect(gateway.count(scenario.action)).toBe(0);
      await current.save.click();
      await expect(current.dialog).toBeHidden();
      expect(gateway.count(scenario.action)).toBe(1);
      expect(last(gateway, scenario.action)?.path).toBe(runPath("public-run-1", scenario.action));
    });
  }
  test(`${mode}: 이미 전송한 비교 응답은 표시하고 신규 호출만 차단한다`, async ({ page, gateway }) => {
    await login(page);
    await models(page).fill(modelA);
    await question(page).fill(promptA);
    gateway.hold("run");
    await run(page).click();
    await expect.poll(() => gateway.count("run")).toBe(1);
    const pendingRun = page.getByRole("button", { name: "실행 중", exact: true });
    await expect(pendingRun).toBeDisabled();
    await forceDisabledClick(pendingRun);
    expect(gateway.count("run")).toBe(1);
    gateway.setMode(mode);
    await refreshRuntime(page);
    await release(gateway, "run");
    await expect(answer(page)).toBeVisible();
    await expect(run(page)).toBeDisabled();
    for (const scenario of forms)
      await expect(page.getByRole("button", { name: scenario.label, exact: true })).toBeDisabled();
    expect(gateway.count("run")).toBe(1);
  });
  test(`${mode}: 순수 예상비용·코드·답변비교·내보내기는 기존 권한으로 허용`, async ({ page, gateway }) => {
    await login(page);
    await complete(page);
    gateway.setMode(mode);
    await refreshRuntime(page);
    await page.getByRole("button", { name: "예상 비용", exact: true }).click();
    await expect(page.getByText(/입력 토큰 8/u)).toBeVisible();
    await page.getByRole("button", { name: "코드 위험 비교", exact: true }).click();
    await expect(page.getByText(/위험도 없음/u)).toBeVisible();
    await page.getByRole("button", { name: "답변 비교", exact: true }).click();
    await expect(page.getByText(/공개 저장 응답 비교/u)).toBeVisible();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "서버에서 내보내기", exact: true }).click();
    expect((await downloaded).suggestedFilename()).toBe("multi-model-public-run-1.md");
    for (const action of ["predict", "code", "diff", "export"] as const)
      expect(gateway.count(action)).toBe(1);
    expect(
      gateway.operations.filter((item) => ["judge", "feedback", "promote", "golden"].includes(item.action)),
    ).toEqual([]);
  });
}

for (const scenario of forms) {
  test(`${scenario.action}: 실제 C 실행 완료가 열린 A 폼의 대상·모델·초안을 바꾸지 않는다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await complete(page);
    await question(page).fill(promptC);
    await models(page).fill(modelC);
    gateway.hold("run");
    await run(page).click();
    await expect.poll(() => gateway.count("run")).toBe(2);
    const current = await openForm(page, scenario);
    await release(gateway, "run");
    await expect(answer(page, "public-run-2")).toHaveCount(1);
    await expect(current.dialog).toHaveAccessibleDescription(new RegExp("실행 ID: public-run-1", "u"));
    await expect(current.dialog.getByRole("combobox", { name: "모델", exact: true })).toHaveValue(modelA);
    await expect(current.field).toHaveValue(scenario.value);
    await current.save.click();
    await expect(current.dialog).toBeHidden();
    expect(last(gateway, scenario.action)?.path).toBe(runPath("public-run-1", scenario.action));
    expect(last(gateway, scenario.action)?.body).toMatchObject(
      scenario.action === "golden" ? { selected_model: modelA, prompt: promptA } : { model: modelA },
    );
  });
  test(`${scenario.action}: pending 전체 잠금과 native 중복 요청 1회`, async ({ page, gateway }) => {
    await login(page);
    await complete(page);
    const current = await openForm(page, scenario);
    gateway.hold(scenario.action);
    await current.save.click();
    await expect.poll(() => gateway.count(scenario.action)).toBe(1);
    await expect(current.field).toBeDisabled();
    await expect(current.dialog.getByRole("button", { name: "취소", exact: true })).toBeDisabled();
    await directSubmit(current.dialog);
    await page.keyboard.press("Escape");
    await expect(current.dialog).toBeVisible();
    expect(gateway.count(scenario.action)).toBe(1);
    gateway.setMode("read_only");
    await refreshRuntime(page);
    await release(gateway, scenario.action);
    await expect(current.dialog).toBeHidden();
    await expect(page.getByRole("button", { name: scenario.label, exact: true })).toBeDisabled();
    await expect(page.locator("[data-sonner-toast][data-type='success']")).toHaveCount(1);
  });
  test(`${scenario.action}: 실패 Request ID와 고정 입력을 보존하고 수동 재시도`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await complete(page);
    const current = await openForm(page, scenario);
    gateway.setStatus(scenario.action, 503);
    await current.save.click();
    await expect(current.dialog.getByRole("alert")).toContainText("req-compare-safety");
    await expect(current.field).toHaveValue(scenario.value);
    gateway.setStatus(scenario.action, 200);
    await current.save.click();
    await expect(current.dialog).toBeHidden();
    const requests = gateway.operations.filter((item) => item.action === scenario.action);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
  });
  test(`${scenario.action}: 열린 폼의 admin:write 회수는 native submit을 막고 초안 유지`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await complete(page);
    const current = await openForm(page, scenario);
    gateway.setWrite(false);
    await refreshRuntime(page);
    await expect(current.field).toBeDisabled();
    await directSubmit(current.dialog);
    expect(gateway.count(scenario.action)).toBe(0);
    await expect(current.dialog).toContainText("admin:write");
    await expect(current.field).toHaveValue(scenario.value);
    gateway.setWrite(true);
    await refreshRuntime(page);
    await expect(current.save).toBeEnabled();
    expect(gateway.count(scenario.action)).toBe(0);
    await current.save.click();
    await expect(current.dialog).toBeHidden();
    expect(gateway.count(scenario.action)).toBe(1);
  });
}

test("A 실행 후 B 초안 편집이 골든 저장 질문 A를 오염시키지 않는다", async ({ page, gateway }) => {
  await login(page);
  await complete(page);
  await question(page).fill(promptB);
  const current = await openForm(page, forms[2]);
  await current.save.click();
  await expect(current.dialog).toBeHidden();
  expect(last(gateway, "golden")?.body).toMatchObject({ selected_model: modelA, prompt: promptA });
  await expect(question(page)).toHaveValue(promptB);
});
test("admin:write가 없으면 실제 실행·저장·순수 예상비용도 새로 허용하지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await complete(page);
  gateway.setWrite(false);
  await refreshRuntime(page);
  for (const button of [
    run(page),
    judge(page),
    page.getByRole("button", { name: "예상 비용", exact: true }),
    ...forms.map((scenario) => page.getByRole("button", { name: scenario.label, exact: true })),
  ]) {
    await expect(button).toBeDisabled();
    await forceDisabledClick(button);
  }
  expect(gateway.operations.map((item) => item.action)).toEqual(["run"]);
  await page.getByRole("button", { name: "코드 위험 비교", exact: true }).click();
  await expect(page.getByText(/위험도 없음/u)).toBeVisible();
  expect(gateway.count("code")).toBe(1);
});
test("raw 원문 권한이 없으면 이력·코드·diff·export는 조회하지 않는다", async ({ page, gateway }) => {
  gateway.setRaw(false);
  await login(page);
  await complete(page);
  await expect(page.getByText("실행 원문 조회 권한이 없습니다.", { exact: true })).toBeVisible();
  for (const label of ["코드 위험 비교", "답변 비교", "서버에서 내보내기"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    await expect(button).toBeDisabled();
    await forceDisabledClick(button);
  }
  expect(gateway.reads.filter((item) => item === `GET ${basePath}/runs`)).toEqual([]);
  expect(gateway.operations.map((item) => item.action)).toEqual(["run"]);
});
test("admin:read 회수는 서버 허용 화면에서도 원문 조회의 현재 권한을 요구한다", async ({ page, gateway }) => {
  await login(page);
  await complete(page);
  gateway.setRead(false);
  await refreshRuntime(page);
  // This bootstrap keeps available=true. FeatureRoute respects the server's
  // availability result; the scoped raw-read guard still requires admin:read.
  await expect(page.getByText("실행 원문 조회 권한이 없습니다.", { exact: true })).toBeVisible();
  for (const label of ["코드 위험 비교", "답변 비교", "서버에서 내보내기"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    await expect(button).toBeDisabled();
    await forceDisabledClick(button);
  }
  expect(gateway.operations.map((item) => item.action)).toEqual(["run"]);
});
for (const method of ["rule", "model"] as const) {
  test(`${method} 자동 평가는 고정 run_id로 저장 작업 1회만 전송한다`, async ({ page, gateway }) => {
    await login(page);
    await complete(page);
    await page.getByLabel("자동 평가 방식", { exact: true }).selectOption(method);
    if (method === "model")
      await page.getByRole("textbox", { name: "심사 모델", exact: true }).fill("public-judge");
    gateway.hold("judge");
    await judge(page).click();
    await expect.poll(() => gateway.count("judge")).toBe(1);
    await forceDisabledClick(judge(page));
    expect(gateway.count("judge")).toBe(1);
    await release(gateway, "judge");
    await expect(page.getByText("자동 평가 완료", { exact: true })).toBeVisible();
    await expect(
      page.getByText(new RegExp(`방식 ${method === "rule" ? "규칙 기반" : "심사 모델"}`, "u")),
    ).toBeVisible();
    expect(last(gateway, "judge")?.body).toEqual({
      run_id: "public-run-1",
      method,
      ...(method === "model" ? { judge_model: "public-judge" } : {}),
    });
  });
}

for (const action of ["run", "golden", "export"] as const) {
  for (const status of [200, 503]) {
    test(`${action} 이전 세션의 늦은 ${status}가 새 계정 초안·알림·다운로드를 오염시키지 않는다`, async ({
      page,
      context,
      gateway,
    }) => {
      await login(page);
      const other = await context.newPage();
      await login(other);
      const downloads: string[] = [];
      page.on("download", (download) => downloads.push(download.suggestedFilename()));
      if (action !== "run") await complete(page);
      await page.evaluate(() => {
        (window as unknown as { compareDocumentMarker: string }).compareDocumentMarker =
          "public-same-document";
      });
      gateway.setStatus(action, status);
      gateway.hold(action);
      if (action === "run") {
        await models(page).fill(modelA);
        await question(page).fill(promptA);
        await run(page).click();
      } else if (action === "golden") {
        const current = await openForm(page, forms[2]);
        await current.save.click();
      } else await page.getByRole("button", { name: "서버에서 내보내기", exact: true }).click();
      await expect.poll(() => gateway.count(action)).toBe(1);
      await other.getByLabel("사용자 메뉴").click();
      await other.getByRole("button", { name: "로그아웃", exact: true }).click();
      await signIn(page, secondEmail);
      expect(
        await page.evaluate(
          () => (window as unknown as { compareDocumentMarker?: string }).compareDocumentMarker,
        ),
      ).toBe("public-same-document");
      await expect(run(page)).toBeVisible();
      await question(page).fill("새 계정의 공개 초안");
      await release(gateway, action);
      await page.waitForTimeout(500);
      await expect(question(page)).toHaveValue("새 계정의 공개 초안");
      await expect(page.locator(".gateway-compare-card")).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      expect(downloads).toEqual([]);
      expect(gateway.operations.filter((item) => item.action === action).map((item) => item.userId)).toEqual([
        "compare-one",
      ]);
      gateway.setStatus(action, 200);
      await complete(page, promptC, modelC, "public-run-2");
      expect(last(gateway, "run")?.userId).toBe("compare-two");
    });
  }
}

for (const way of ["취소", "Escape", "바깥"] as const) {
  test(`${way} 닫기는 더티 폼을 보호하고 폐기 후 정확한 버튼 포커스를 돌린다`, async ({ page, gateway }) => {
    await login(page);
    await complete(page);
    const current = await openForm(page, forms[0]);
    const close = async () => {
      if (way === "Escape") await page.keyboard.press("Escape");
      else if (way === "바깥") await page.locator(".dialog-overlay").click({ position: { x: 5, y: 5 } });
      else await current.dialog.getByRole("button", { name: "취소", exact: true }).click();
    };
    await close();
    const guard = page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다", exact: true });
    await expect(guard).toBeVisible();
    await guard.getByRole("button", { name: "계속 편집", exact: true }).click();
    await expect(current.field).toHaveValue(forms[0].value);
    await close();
    await guard.getByRole("button", { name: "변경 버리기", exact: true }).click();
    await expect(current.dialog).toBeHidden();
    await expect(current.trigger).toBeFocused();
    expect(gateway.count("feedback")).toBe(0);
  });
}
for (const way of ["경로", "뒤로가기"] as const) {
  test(`${way} 이동은 열린 폼을 보호하고 유지 또는 폐기를 따른다`, async ({ page, gateway }) => {
    await login(page, providersUrl);
    await bySidebar(page, "/app/gateway/chat");
    await page.getByRole("tab", { name: "멀티 모델 비교", exact: true }).click();
    await complete(page);
    const current = await openForm(page, forms[1]);
    const navigate = async () => {
      if (way === "뒤로가기") await page.goBack();
      else {
        // The modal makes background links inert. Invoke the actual link handler
        // to exercise route coordination, not pointer reachability through a modal.
        await page
          .locator(`a[href="${providersUrl}"]`)
          .first()
          .evaluate((node) => (node as HTMLElement).click());
      }
    };
    await navigate();
    await page.getByRole("button", { name: "계속 편집", exact: true }).click();
    await expect(current.field).toHaveValue(forms[1].value);
    await navigate();
    await page.getByRole("button", { name: "변경 버리기", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${providersUrl}$`, "u"));
    expect(gateway.count("promote")).toBe(0);
  });
}
test("실제 새로고침 beforeunload를 취소하면 폼 입력을 유지한다", async ({ page, gateway }) => {
  await login(page);
  await complete(page);
  const current = await openForm(page, forms[0]);
  const shown = page.waitForEvent("dialog");
  await page.evaluate(() => {
    setTimeout(() => location.reload(), 0);
  });
  const native = await shown;
  expect(native.type()).toBe("beforeunload");
  await native.dismiss();
  await expect(current.field).toHaveValue(forms[0].value);
  expect(gateway.count("feedback")).toBe(0);
});
test("이력 GET 실패는 실행 성공과 구분하며 수동 조회로만 회복한다", async ({ page, gateway }) => {
  gateway.setHistoryStatus(503);
  await login(page);
  await complete(page);
  await expect(page.getByText("이력을 불러오지 못했습니다.", { exact: true })).toBeVisible();
  await expect(page.getByText(/요청 ID: req-compare-safety/u)).toBeVisible();
  await expect(answer(page)).toBeVisible();
  gateway.setHistoryStatus(200);
  const card = page
    .getByRole("heading", { name: "최근 실행 이력", exact: true })
    .locator("xpath=ancestor::section[1]");
  await card.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(card.getByRole("cell", { name: "public-run-1", exact: true })).toBeVisible();
  expect(gateway.count("run")).toBe(1);
});

test("390px 다크 골든 폼은 첫 native 저장·키보드·접근성·엄격한 넘침을 지킨다", async ({
  page,
  gateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page);
  await complete(page);
  await page.getByRole("button", { name: forms[2].label, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: forms[2].title, exact: true });
  await expect(dialog.getByRole("button", { name: "대화상자 닫기", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("combobox", { name: "모델", exact: true })).toBeFocused();
  const field = dialog.getByRole("textbox", { name: "워크플로 이름", exact: true });
  const save = dialog.getByRole("button", { name: "저장", exact: true });
  await dialog.locator("form").evaluate((form) => {
    form.setAttribute("data-native-count", "0");
    form.addEventListener("submit", () =>
      form.setAttribute("data-native-count", String(Number(form.getAttribute("data-native-count")) + 1)),
    );
  });
  await field.fill(" ");
  const before = await save.boundingBox();
  await save.click();
  await expect(dialog.locator("form")).toHaveAttribute("data-native-count", "1");
  await expect(field).toBeFocused();
  expect((await save.boundingBox())?.y).toBe(before?.y);
  expect(gateway.count("golden")).toBe(0);
  await field.fill("모바일 공개 회귀");
  gateway.setMode("read_only");
  await refreshRuntime(page);
  await expect(save).toBeDisabled();
  await expect(field).toHaveValue("모바일 공개 회귀");
  // Preserve the actual transition first. This is not an always-visible notice
  // claim: the operator explicitly scrolls the dialog to read the reason next.
  await page.screenshot({ path: info.outputPath("compare-golden-mobile-transition.png") });
  await keyboardReadBody(page, dialog);
  const reason = dialog.getByText(readonlyReason, { exact: true });
  await reason.scrollIntoViewIfNeeded();
  await expect(reason).toBeInViewport({ ratio: 1 });
  await expect(save).toBeInViewport({ ratio: 1 });
  for (const target of [reason, save]) {
    await expect
      .poll(() =>
        target.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        }),
      )
      .toBe(true);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await reason.scrollIntoViewIfNeeded();
  await expect(reason).toBeInViewport({ ratio: 1 });
  await expect(save).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath("compare-golden-mobile-dark.png") });
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("button", { name: "계속 편집", exact: true })).toBeFocused();
  await page.screenshot({ path: info.outputPath("compare-golden-mobile-discard.png") });
  await page.getByRole("button", { name: "계속 편집", exact: true }).click();
  gateway.setMode("writable");
  await refreshRuntime(page);
  await expect(save).toBeEnabled();
  gateway.hold("golden");
  await save.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => gateway.count("golden")).toBe(1);
  await expect(field).toBeDisabled();
  await keyboardReadBody(page, dialog);
  expect(await axeViolations(page)).toEqual([]);
  await release(gateway, "golden");
  await expect(dialog).toBeHidden();
  expect(gateway.count("golden")).toBe(1);
});
