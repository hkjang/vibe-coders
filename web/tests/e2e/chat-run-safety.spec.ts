import { expect, type Locator, type Page } from "@playwright/test";
import {
  test,
  type Action,
  type ChatGateway,
  chatUrl,
  providersUrl,
  firstEmail,
  secondEmail,
  publicAnswer,
  publicReasoning,
  publicPrompt,
  publicModel,
  readonlyReason,
  paths,
  sseBody,
} from "../fixtures/chat-run-safety-gateway";

// Real React/FeatureRoute with synthetic APIs, not a model or real Go server.
// Held fulfillment proves pending/abort/late-completion UI boundaries only;
// incremental ReadableStream delivery has separate controlled-stream unit proof.
const sendButton = (page: Page) => page.getByRole("button", { name: "모델 호출", exact: true });
const previewButton = (page: Page) => page.getByRole("button", { name: "라우팅 미리보기", exact: true });
const codeButton = (page: Page) => page.getByRole("button", { name: "코드 검증", exact: true });
const followup = (page: Page) => page.getByRole("textbox", { name: "이어서 질문", exact: true });
const prompt = (page: Page) => page.getByRole("textbox", { name: "프롬프트", exact: true });
const answer = (page: Page, content = publicAnswer) =>
  page.locator(".chat-turn-assistant .chat-turn-body").filter({ hasText: content });
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
  if (path === chatUrl) await expect(sendButton(page)).toBeVisible();
}
async function refreshRuntime(page: Page) {
  const received = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await received).finished();
}
async function forceDisabledClick(button: Locator) {
  // Only a DOM constraint bypass attempt: React can suppress disabled onClick.
  // Captured callback/mutate guard tests, not this helper, prove direct entry.
  await button.evaluate((node) => {
    const button = node as HTMLButtonElement,
      disabled = button.disabled;
    button.disabled = false;
    button.click();
    button.disabled = disabled;
  });
}
async function start(page: Page) {
  await prompt(page).fill(publicPrompt);
  await sendButton(page).click();
}
async function complete(page: Page) {
  await start(page);
  await expect(answer(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "응답 수신 중단", exact: true })).toHaveCount(0);
}
async function bySidebar(page: Page, path: string) {
  const link = page.locator(`a[href="${path}"]`).first();
  if (!(await link.isVisible()))
    await page.getByRole("button", { name: /^AI Gateway|^AI 게이트웨이/u }).click();
  await link.click();
}
async function release(gateway: ChatGateway, action: Action) {
  const before = gateway.finished.filter((value) => value === action).length;
  gateway.release(action);
  await expect.poll(() => gateway.finished.filter((value) => value === action).length).toBe(before + 1);
}

for (const mode of ["read_only", "preview_read_only"] as const) {
  test(`${mode}는 신규 모델 실행을 막고 대상 조회와 routing:read 계산은 허용한다`, async ({
    page,
    gateway,
  }) => {
    gateway.setMode(mode);
    await login(page);
    await page.getByLabel("테스트 대상", { exact: true }).selectOption("public-chat-target");
    await expect(page.getByRole("textbox", { name: "모델", exact: true })).toHaveValue(publicModel);
    await prompt(page).fill(publicPrompt);
    await expect(sendButton(page)).toBeDisabled();
    await expect(page.getByText(readonlyReason, { exact: true })).toBeVisible();
    await forceDisabledClick(sendButton(page));
    await previewButton(page).click();
    await expect(page.getByText("공개 합성 경로 계산", { exact: true })).toBeVisible();
    expect(gateway.count("stream")).toBe(0);
    expect(gateway.count("preview")).toBe(1);
    expect(gateway.reads).toContain(`GET ${paths.targets}`);
    await expect(prompt(page)).toHaveValue(publicPrompt);
    await expect(codeButton(page)).toBeDisabled();
  });

  test(`${mode} 전환은 설정·질문 초안을 유지하고 실제 Enter 전송을 막으며 복구 뒤 수동으로만 보낸다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await complete(page);
    await page.getByRole("textbox", { name: "모델", exact: true }).fill("public-draft-model");
    await page.getByRole("textbox", { name: "공급자", exact: true }).fill("public-draft-provider");
    await page.getByLabel("최대 토큰", { exact: true }).fill("125");
    await page.getByLabel("응답 다양성 (Temperature)", { exact: true }).fill("0.4");
    await page.getByLabel("API 키 ID", { exact: true }).fill("public-key-reference");
    await page.getByLabel("프록시 인증 토큰 (Bearer)", { exact: true }).fill("synthetic-input-only-marker");
    await prompt(page).fill("전환 전 공개 질문 초안");
    await followup(page).fill("전환 전 이어서 질문 초안");
    gateway.setMode(mode);
    await refreshRuntime(page);
    await expect(sendButton(page)).toBeDisabled();
    await expect(followup(page)).toHaveValue("전환 전 이어서 질문 초안");
    await followup(page).press("Enter");
    await expect(followup(page)).toHaveValue("전환 전 이어서 질문 초안");
    expect(gateway.count("stream")).toBe(1);
    await expect(prompt(page)).toHaveValue("전환 전 공개 질문 초안");
    await expect(page.getByRole("textbox", { name: "모델", exact: true })).toHaveValue("public-draft-model");
    await expect(page.getByRole("textbox", { name: "공급자", exact: true })).toHaveValue(
      "public-draft-provider",
    );
    await expect(page.getByLabel("최대 토큰", { exact: true })).toHaveValue("125");
    await expect(page.getByLabel("응답 다양성 (Temperature)", { exact: true })).toHaveValue("0.4");
    await expect(page.getByLabel("API 키 ID", { exact: true })).toHaveValue("public-key-reference");
    await expect(page.getByLabel("프록시 인증 토큰 (Bearer)", { exact: true })).toHaveValue(
      "synthetic-input-only-marker",
    );
    gateway.setMode("writable");
    await refreshRuntime(page);
    await expect(sendButton(page)).toBeEnabled();
    expect(gateway.count("stream")).toBe(1);
    gateway.hold("stream");
    await followup(page).press("Enter");
    await expect.poll(() => gateway.count("stream")).toBe(2);
    await expect(followup(page)).toHaveValue("");
    expect(gateway.operations.at(-1)?.body).toMatchObject({
      model: "public-draft-model",
      provider: "public-draft-provider",
      max_tokens: 125,
      temperature: 0.4,
      api_key_id: "public-key-reference",
      bearer_token: "synthetic-input-only-marker",
    });
    expect(gateway.operations.at(-1)?.body.messages).toEqual([
      { role: "user", content: publicPrompt },
      { role: "assistant", content: publicAnswer },
      { role: "user", content: "전환 전 이어서 질문 초안" },
    ]);
    await release(gateway, "stream");
    await expect(answer(page)).toHaveCount(2);
  });

  test(`${mode}가 되어도 이미 접수된 응답은 읽을 수 있고 새 호출만 차단된다`, async ({ page, gateway }) => {
    await login(page);
    gateway.hold("stream");
    await start(page);
    await expect.poll(() => gateway.count("stream")).toBe(1);
    gateway.setMode(mode);
    await refreshRuntime(page);
    await expect(page.getByRole("button", { name: "응답 수신 중단", exact: true })).toBeEnabled();
    await release(gateway, "stream");
    await expect(answer(page)).toHaveCount(1);
    await expect(sendButton(page)).toBeDisabled();
    await page.getByText("추론 과정", { exact: true }).click();
    await expect(page.getByText(publicReasoning, { exact: true })).toBeVisible();
    await codeButton(page).click();
    await expect(page.getByText("공개 합성 정적 검사", { exact: true })).toBeVisible();
    expect(gateway.count("code")).toBe(1);
    expect(gateway.operations.find((operation) => operation.action === "code")?.body).toEqual({
      text: publicAnswer,
    });
    expect(gateway.count("stream")).toBe(1);
  });

  test(`${mode}에서 수신 중단은 허용하며 늦은 전체 응답을 되살리거나 서버 취소를 주장하지 않는다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    gateway.hold("stream");
    await start(page);
    await expect.poll(() => gateway.count("stream")).toBe(1);
    gateway.setMode(mode);
    await refreshRuntime(page);
    await page.getByRole("button", { name: "응답 수신 중단", exact: true }).click();
    await expect(page.getByText("응답 수신을 중단했습니다.", { exact: true })).toBeVisible();
    await expect(page.getByText(/공급자의 실행이나 비용 발생이 중단된다는 뜻은 아닙니다/u)).toBeVisible();
    await release(gateway, "stream");
    await expect(answer(page)).toHaveCount(0);
    await expect(sendButton(page)).toBeDisabled();
    expect(gateway.count("stream")).toBe(1);
    gateway.setMode("writable");
    await refreshRuntime(page);
    await expect(sendButton(page)).toBeEnabled();
    expect(gateway.count("stream")).toBe(1);
    await sendButton(page).click();
    await expect(answer(page)).toHaveCount(1);
    expect(gateway.count("stream")).toBe(2);
  });

  test(`${mode}에서도 순수 미리보기와 코드 검증은 각각 기존 API 권한을 요구한다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await complete(page);
    gateway.setMode(mode);
    gateway.setPreviewScope(false);
    await refreshRuntime(page);
    await expect(previewButton(page)).toBeDisabled();
    await forceDisabledClick(previewButton(page));
    await codeButton(page).click();
    await expect(page.getByRole("heading", { name: "코드 검증 결과", exact: true })).toBeVisible();
    expect(gateway.count("preview")).toBe(0);
    expect(gateway.count("code")).toBe(1);
    gateway.setWriteScope(false);
    gateway.setPreviewScope(true);
    await refreshRuntime(page);
    await expect(codeButton(page)).toBeDisabled();
    await forceDisabledClick(codeButton(page));
    await previewButton(page).click();
    await expect(page.getByText("공개 합성 경로 계산", { exact: true })).toBeVisible();
    expect(gateway.count("code")).toBe(1);
    expect(gateway.count("preview")).toBe(1);
    expect(gateway.count("stream")).toBe(1);
  });

  test(`${mode}는 화면의 대화 지우기를 허용하며 서버 실행이나 새 요청을 만들지 않는다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await complete(page);
    gateway.setMode(mode);
    await refreshRuntime(page);
    const clear = page.getByRole("button", { name: "대화 지우기", exact: true });
    await expect(clear).toBeEnabled();
    await clear.click();
    await expect(answer(page)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "아직 호출한 응답이 없습니다.", exact: true }),
    ).toBeVisible();
    await expect(prompt(page)).toHaveValue(publicPrompt);
    expect(gateway.count("stream")).toBe(1);
    expect(gateway.operations).toHaveLength(1);
  });
}

for (const mode of ["writable", "read_only", "preview_read_only"] as const) {
  test(`${mode} 기능 상태는 없는 admin:write를 부여하지 않는다`, async ({ page, gateway }) => {
    gateway.setMode(mode);
    gateway.setWriteScope(false);
    await login(page);
    await prompt(page).fill(publicPrompt);
    await expect(sendButton(page)).toBeDisabled();
    await forceDisabledClick(sendButton(page));
    await previewButton(page).click();
    await expect(page.getByText("공개 합성 경로 계산", { exact: true })).toBeVisible();
    expect(gateway.count("stream")).toBe(0);
    expect(gateway.count("preview")).toBe(1);
    await expect(codeButton(page)).toBeDisabled();
  });
}

test("첫 호출의 중복 클릭은 한 건만 접수하고 실행 중 입력 변경은 보낸 본문을 바꾸지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await prompt(page).fill(publicPrompt);
  gateway.hold("stream");
  await sendButton(page).evaluate((node) => {
    (node as HTMLButtonElement).click();
    (node as HTMLButtonElement).click();
  });
  await expect.poll(() => gateway.count("stream")).toBe(1);
  await prompt(page).fill("실행 중 준비한 다음 질문");
  await page.getByRole("textbox", { name: "모델", exact: true }).fill("next-public-model");
  expect(gateway.operations[0]?.body.messages).toEqual([{ role: "user", content: publicPrompt }]);
  expect(gateway.operations[0]?.body.model).toBe("vibe/auto");
  await expect(page.getByRole("button", { name: "스트리밍 중", exact: true })).toBeDisabled();
  await release(gateway, "stream");
  await expect(answer(page)).toHaveCount(1);
  await expect(prompt(page)).toHaveValue("실행 중 준비한 다음 질문");
  expect(gateway.count("stream")).toBe(1);
});

test("이어서 질문의 진행 중 재전송 잠금·공백·Shift+Enter는 입력을 잃거나 중복 호출하지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await complete(page);
  await followup(page).fill("   ");
  await followup(page).press("Enter");
  await expect(followup(page)).toHaveValue("   ");
  expect(gateway.count("stream")).toBe(1);
  await followup(page).fill("공개 후속 질문");
  await followup(page).press("Shift+Enter");
  await expect(followup(page)).toHaveValue("공개 후속 질문\n");
  expect(gateway.count("stream")).toBe(1);
  gateway.hold("stream");
  await followup(page).press("Enter");
  await expect.poll(() => gateway.count("stream")).toBe(2);
  await expect(followup(page)).toHaveValue("");
  await expect(followup(page)).toBeDisabled();
  // The user-facing pending lock is distinct from the captured-send unit guard.
  // Dispatching on a disabled DOM node alone does not prove React callback entry.
  await followup(page).evaluate((node) =>
    node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(gateway.count("stream")).toBe(2);
  await release(gateway, "stream");
  await expect(answer(page)).toHaveCount(2);
  await expect(followup(page)).toBeEnabled();
  await followup(page).fill("보내지 않은 다음 질문");
  await expect(followup(page)).toHaveValue("보내지 않은 다음 질문");
});

test("합성 한글 조합 Enter와 keyCode229는 질문을 보존하고 일반 Enter에서만 한 번 보낸다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await complete(page);
  await followup(page).fill("조합 중인 공개 한글 질문");
  // Synthetic browser events exercise the real React key handler; this does
  // not substitute for an operating-system IME or every browser/IME engine.
  for (const composing of [true, false]) {
    await followup(page).evaluate(
      (node, composing) =>
        node.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            isComposing: composing,
            keyCode: composing ? 13 : 229,
            bubbles: true,
            cancelable: true,
          }),
        ),
      composing,
    );
    await expect(followup(page)).toHaveValue("조합 중인 공개 한글 질문");
    expect(gateway.count("stream")).toBe(1);
  }
  await followup(page).press("Enter");
  await expect(answer(page)).toHaveCount(2);
  await expect(followup(page)).toHaveValue("");
  expect(gateway.count("stream")).toBe(2);
  expect(gateway.operations.at(-1)?.body.messages).toEqual([
    { role: "user", content: publicPrompt },
    { role: "assistant", content: publicAnswer },
    { role: "user", content: "조합 중인 공개 한글 질문" },
  ]);
});

for (const status of [401, 403, 503]) {
  test(`모델 응답 ${status}는 요청 ID와 초안을 남기며 자동 재시도하지 않는다`, async ({ page, gateway }) => {
    await login(page);
    gateway.setStatus("stream", status);
    await start(page);
    await expect(page.getByText(/요청 ID: req-chat-safety/u)).toBeVisible();
    await expect(prompt(page)).toHaveValue(publicPrompt);
    await expect(sendButton(page)).toBeEnabled();
    expect(gateway.count("stream")).toBe(1);
    gateway.setStatus("stream", 200);
    await sendButton(page).click();
    await expect(answer(page)).toHaveCount(1);
    expect(gateway.count("stream")).toBe(2);
  });
}

for (const action of ["preview", "code"] as const) {
  test(`${action} 계산 실패의 요청 ID·수동 재시도·중복 잠금을 유지한다`, async ({ page, gateway }) => {
    await login(page);
    if (action === "code") await complete(page);
    const button = action === "preview" ? previewButton(page) : codeButton(page);
    gateway.setStatus(action, 503);
    gateway.hold(action);
    await button.click();
    await expect.poll(() => gateway.count(action)).toBe(1);
    await expect(button).toBeDisabled();
    await forceDisabledClick(button);
    expect(gateway.count(action)).toBe(1);
    await release(gateway, action);
    await expect(page.getByText(/요청 ID: req-chat-safety/u)).toBeVisible();
    await expect(button).toBeEnabled();
    gateway.setStatus(action, 200);
    await button.click();
    await expect(
      page.getByText(action === "preview" ? "공개 합성 경로 계산" : "공개 합성 정적 검사", { exact: true }),
    ).toBeVisible();
    expect(gateway.count(action)).toBe(2);
  });
}

test("대상 목록 조회 실패는 직접 입력을 지우지 않고 조회 재시도로만 회복한다", async ({ page, gateway }) => {
  gateway.setTargetsStatus(503);
  await login(page);
  await expect(page.getByText("테스트 대상 목록을 불러오지 못했습니다.", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "모델", exact: true }).fill("public-manual-model");
  await prompt(page).fill(publicPrompt);
  gateway.setTargetsStatus(200);
  const received = page.waitForResponse(
    (response) => new URL(response.url()).pathname === paths.targets && response.status() === 200,
  );
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await (await received).finished();
  await expect(page.getByRole("option", { name: "공개 합성 대상", exact: true })).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "모델", exact: true })).toHaveValue("public-manual-model");
  await expect(prompt(page)).toHaveValue(publicPrompt);
  expect(gateway.operations).toEqual([]);
});

test("이전 답변의 늦은 코드 검증은 다음 호출의 답변에 붙지 않는다", async ({ page, gateway }) => {
  await login(page);
  await complete(page);
  gateway.hold("code");
  await codeButton(page).click();
  await expect.poll(() => gateway.count("code")).toBe(1);
  gateway.setPayload("stream", sseBody("다음 공개 답변"));
  await prompt(page).fill("다음 공개 질문");
  await sendButton(page).click();
  await expect(answer(page, "다음 공개 답변")).toHaveCount(1);
  await release(gateway, "code");
  await expect(page.getByRole("heading", { name: "코드 검증 결과", exact: true })).toHaveCount(0);
  await codeButton(page).click();
  await expect(page.getByRole("heading", { name: "코드 검증 결과", exact: true })).toBeVisible();
  expect(
    gateway.operations.filter((operation) => operation.action === "code").map((operation) => operation.body),
  ).toEqual([{ text: publicAnswer }, { text: "다음 공개 답변" }]);
});

for (const action of ["stream", "preview", "code"] as const) {
  for (const status of [200, 503]) {
    test(`${action} 이전 세션의 늦은 ${status}는 새 계정 초안·응답·알림에 반영되지 않는다`, async ({
      page,
      context,
      gateway,
    }) => {
      await login(page);
      const other = await context.newPage();
      await login(other);
      if (action === "code") await complete(page);
      gateway.setStatus(action, status);
      gateway.hold(action);
      if (action === "stream") await start(page);
      else await (action === "preview" ? previewButton(page) : codeButton(page)).click();
      await expect.poll(() => gateway.count(action)).toBe(1);
      await other.getByLabel("사용자 메뉴").click();
      await other.getByRole("button", { name: "로그아웃", exact: true }).click();
      await signIn(page, secondEmail);
      await expect(sendButton(page)).toBeVisible();
      await prompt(page).fill("새 계정의 공개 질문 초안");
      await release(gateway, action);
      await page.waitForTimeout(150);
      await expect(prompt(page)).toHaveValue("새 계정의 공개 질문 초안");
      await expect(answer(page)).toHaveCount(0);
      await expect(page.getByText("공개 합성 경로 계산", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "코드 검증 결과", exact: true })).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      expect(
        gateway.operations
          .filter((operation) => operation.action === action)
          .map((operation) => operation.userId),
      ).toEqual(["chat-one"]);
      gateway.setStatus(action, 200);
      gateway.setPayload("stream", sseBody("새 계정의 공개 응답"));
      await sendButton(page).click();
      await expect(answer(page, "새 계정의 공개 응답")).toHaveCount(1);
      expect(gateway.operations.at(-1)?.userId).toBe("chat-two");
      expect(gateway.operations.at(-1)?.body.messages).toEqual([
        { role: "user", content: "새 계정의 공개 질문 초안" },
      ]);
    });
  }
}

for (const way of ["다른 탭", "다른 경로"] as const) {
  test(`${way}로 단일 화면을 떠나면 수신을 정리하고 재진입에 늦은 응답을 붙이지 않는다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    gateway.hold("stream");
    await start(page);
    await expect.poll(() => gateway.count("stream")).toBe(1);
    if (way === "다른 탭") await page.getByRole("tab", { name: "모델 용도 태그", exact: true }).click();
    else await bySidebar(page, providersUrl);
    await release(gateway, "stream");
    if (way === "다른 탭") await page.getByRole("tab", { name: "단일 호출", exact: true }).click();
    else await bySidebar(page, chatUrl);
    await expect(answer(page)).toHaveCount(0);
    await expect(sendButton(page)).toBeEnabled();
    await expect(page.getByText(/요청 ID: req-chat-safety/u)).toHaveCount(0);
    expect(gateway.count("stream")).toBe(1);
  });
}

test("대화·입력 전용 인증값은 URL과 브라우저 저장소에 남지 않고 새로고침에서 복원되지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await page.getByLabel("프록시 인증 토큰 (Bearer)", { exact: true }).fill("synthetic-browser-secret-marker");
  await complete(page);
  await expect(page.getByText("synthetic-header-must-not-render", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(
      (markers) => {
        const content =
          location.href + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
        return markers.some((marker) => content.includes(marker));
      },
      [publicPrompt, publicAnswer, "synthetic-browser-secret-marker"],
    ),
  ).toBe(false);
  await page.reload();
  await expect(sendButton(page)).toBeVisible();
  await expect(answer(page)).toHaveCount(0);
  await expect(page.getByLabel("프록시 인증 토큰 (Bearer)", { exact: true })).toHaveValue("");
  expect(gateway.count("stream")).toBe(1);
});

async function mobileCheck(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.locator("#main-content").evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
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
for (const mode of ["read_only", "preview_read_only"] as const) {
  test(`390px 다크 ${mode}는 질문·수신 중단·순수 계산의 키보드와 접근성·엄격한 넘침을 지킨다`, async ({
    page,
    gateway,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
    await login(page);
    await complete(page);
    await followup(page).fill("모바일 공개 다음 질문");
    gateway.hold("stream");
    await followup(page).press("Enter");
    await expect.poll(() => gateway.count("stream")).toBe(2);
    gateway.setMode(mode);
    await refreshRuntime(page);
    const stop = page.getByRole("button", { name: "응답 수신 중단", exact: true });
    await stop.focus();
    await expect(stop).toBeFocused();
    await mobileCheck(page);
    // axe may inspect/scroll other regions. Capture the actual reception control
    // only after a deliberate scroll and a fresh full-visibility assertion.
    await stop.scrollIntoViewIfNeeded();
    // Bring the top-edge-aligned button below the sticky header by an explicit
    // user wheel movement. Intersection alone cannot prove it is unobscured.
    await page.mouse.move(380, 200);
    await page.mouse.wheel(0, -200);
    await expect(stop).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() =>
        stop.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        }),
      )
      .toBe(true);
    await expect(stop).toBeFocused();
    await page.screenshot({ path: info.outputPath(`chat-run-${mode}-pending.png`) });
    await page.keyboard.press("Enter");
    await expect(page.getByText("응답 수신을 중단했습니다.", { exact: true })).toBeVisible();
    await release(gateway, "stream");
    await expect(answer(page)).toHaveCount(1);
    await followup(page).fill("보존할 모바일 질문");
    await followup(page).press("Enter");
    await expect(followup(page)).toHaveValue("보존할 모바일 질문");
    await expect(followup(page)).toBeFocused();
    const reason = page.getByText("읽기 전용에서는 새 질문을 전송할 수 없습니다. 입력은 유지됩니다.", {
      exact: true,
    });
    await expect(followup(page)).toHaveAccessibleDescription(
      "읽기 전용에서는 새 질문을 전송할 수 없습니다. 입력은 유지됩니다.",
    );
    await expect(followup(page)).toBeInViewport();
    await expect(reason).toBeInViewport();
    expect(gateway.count("stream")).toBe(2);
    await mobileCheck(page);
    await page.screenshot({ path: info.outputPath(`chat-run-${mode}-stopped-before-scroll.png`) });
    // Adjacency is not sticky visibility: the operator explicitly scrolls to
    // read the whole input + description group. No product auto-scroll promise.
    await page.mouse.move(380, 200);
    await page.mouse.wheel(0, 180);
    await expect(followup(page)).toBeInViewport({ ratio: 1 });
    await expect(reason).toBeInViewport({ ratio: 1 });
    await expect(followup(page)).toBeFocused();
    await expect(followup(page)).toHaveValue("보존할 모바일 질문");
    await page.screenshot({ path: info.outputPath(`chat-run-${mode}-stopped.png`) });
    await codeButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "코드 검증 결과", exact: true })).toBeVisible();
    await mobileCheck(page);
    expect(gateway.count("code")).toBe(1);
  });
}
