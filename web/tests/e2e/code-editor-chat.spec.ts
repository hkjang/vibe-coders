import { expect, type Page } from "@playwright/test";
import { test, chatUrl, firstEmail, secondEmail, publicAnswer } from "../fixtures/chat-run-safety-gateway";
import {
  activateEditor,
  refreshRuntime,
  replaceCode,
  watchEditorAssets,
} from "../fixtures/agent-code-editor";

async function signIn(page: Page, email: string) {
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: "모델 호출", exact: true })).toBeVisible();
}
async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const assets = await watchEditorAssets(page);
  await page.goto(`login?return_to=${encodeURIComponent(chatUrl)}`);
  await signIn(page, firstEmail);
  assets.expectDeferred();
  return { errors, editor: await activateEditor(page.locator("main"), "프롬프트") };
}

test("코드 프롬프트는 읽기 전용 계산과 호출 권한을 구분하고 실행 중 다음 초안을 보존한다", async ({
  page,
  gateway,
}) => {
  const { editor, errors } = await open(page);
  const draft = "  공개 한글 질문\n  줄바꿈 유지  ";
  await replaceCode(editor, draft);
  gateway.setMode("read_only");
  await refreshRuntime(page);
  await expect(page.getByRole("button", { name: "모델 호출", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "라우팅 미리보기", exact: true }).click();
  await expect.poll(() => gateway.count("preview")).toBe(1);
  expect(gateway.operations.find((op) => op.action === "preview")?.body.messages).toEqual([
    { role: "user", content: draft },
  ]);
  expect(gateway.count("stream")).toBe(0);
  gateway.setMode("writable");
  await refreshRuntime(page);
  gateway.hold("stream");
  await page.getByRole("button", { name: "모델 호출", exact: true }).click();
  await expect.poll(() => gateway.count("stream")).toBe(1);
  await replaceCode(editor, "다음에 실행할 한글 질문");
  expect(gateway.operations.find((op) => op.action === "stream")?.body.messages).toEqual([
    { role: "user", content: draft.trim() },
  ]);
  await expect(page.getByRole("textbox", { name: "이어서 질문", exact: true })).toBeDisabled();
  gateway.release("stream");
  await expect(page.locator(".chat-turn-assistant .chat-turn-body")).toHaveText(publicAnswer);
  await editor.getByRole("button", { name: "프롬프트 기본 입력으로 전환", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "프롬프트", exact: true })).toHaveValue(
    "다음에 실행할 한글 질문",
  );
  expect(gateway.count("stream")).toBe(1);
  expect(errors).toEqual([]);
});

test("열린 코드 프롬프트는 로그아웃 때 폐기하고 다른 계정에 전달하지 않는다", async ({ page, gateway }) => {
  const { editor, errors } = await open(page);
  const draft = "이전 계정의 공개 초안";
  await replaceCode(editor, draft);
  await page.getByLabel("사용자 메뉴").click();
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await signIn(page, secondEmail);
  await expect(page.locator(".monaco-editor")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "프롬프트", exact: true })).not.toHaveValue(draft);
  const next = await activateEditor(page.locator("main"), "프롬프트");
  await replaceCode(next, "새 계정 질문");
  await page.getByRole("button", { name: "모델 호출", exact: true }).click();
  await expect.poll(() => gateway.count("stream")).toBe(1);
  expect(gateway.operations[0]).toMatchObject({
    userId: "chat-two",
    body: { messages: [{ role: "user", content: "새 계정 질문" }] },
  });
  await expect(page.locator(".chat-turn-assistant .chat-turn-body")).toHaveText(publicAnswer);
  expect(errors).toEqual([]);
});
