import { expect, type Page } from "@playwright/test";
import type axe from "axe-core";
import { test, chatUrl, firstEmail, modelA } from "../fixtures/chat-compare-safety-gateway";
import {
  activateEditor,
  refreshRuntime,
  replaceCode,
  watchEditorAssets,
} from "../fixtures/agent-code-editor";

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const assets = await watchEditorAssets(page);
  await page.goto(`login?return_to=${encodeURIComponent(chatUrl)}`);
  await page.getByLabel("이메일", { exact: true }).fill(firstEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: "멀티 실행", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "비교할 모델", exact: true }).fill(`${modelA}:public-provider`);
  assets.expectDeferred();
  return {
    errors,
    system: await activateEditor(page.locator("main"), "시스템 지침"),
    user: await activateEditor(page.locator("main"), "사용자 질문"),
  };
}

test("두 코드 프롬프트는 실행 당시 원문을 고정하고 다음 초안과 골든 저장을 분리한다", async ({
  page,
  gateway,
}) => {
  const { system, user, errors } = await open(page);
  const systemDraft = "  공개 시스템 지침\n  공백 유지  ",
    userDraft = "  공개 사용자 질문\n  공백 유지  ";
  await replaceCode(system, systemDraft);
  await replaceCode(user, userDraft);
  gateway.hold("run");
  await page.getByRole("button", { name: "멀티 실행", exact: true }).click();
  await expect.poll(() => gateway.count("run")).toBe(1);
  await replaceCode(user, "아직 실행하지 않은 다음 질문");
  expect(gateway.operations.find((op) => op.action === "run")?.body.messages).toEqual([
    { role: "system", content: systemDraft },
    { role: "user", content: userDraft },
  ]);
  gateway.release("run");
  await expect(page.locator(".gateway-compare-card .chat-turn-body")).toContainText(
    "공개 비교 응답 public-run-1",
  );
  await page.getByRole("button", { name: "골든 답변으로 저장", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "골든 답변으로 저장", exact: true });
  await dialog.getByRole("textbox", { name: "워크플로 이름", exact: true }).fill("공개 회귀 검증");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(gateway.operations.find((op) => op.action === "golden")?.body).toMatchObject({
    selected_model: modelA,
    prompt: userDraft.trim(),
  });
  await user.getByRole("button", { name: "사용자 질문 기본 입력으로 전환", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "사용자 질문", exact: true })).toHaveValue(
    "아직 실행하지 않은 다음 질문",
  );
  expect(gateway.count("run")).toBe(1);
  expect(errors).toEqual([]);
});

test("모델 비교 코드 초안은 읽기 전용 전환 뒤 유지되며 권한 복구만으로 실행하지 않는다", async ({
  page,
  gateway,
}) => {
  const { system, user, errors } = await open(page);
  await replaceCode(system, "읽기 전용 시스템 초안");
  await replaceCode(user, "읽기 전용 사용자 초안");
  gateway.setMode("read_only");
  await refreshRuntime(page);
  await expect(page.getByRole("button", { name: "멀티 실행", exact: true })).toBeDisabled();
  expect(gateway.count("run")).toBe(0);
  await system.getByRole("button", { name: "시스템 지침 기본 입력으로 전환", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "시스템 지침", exact: true })).toHaveValue(
    "읽기 전용 시스템 초안",
  );
  gateway.setMode("writable");
  await refreshRuntime(page);
  await expect(page.getByRole("button", { name: "멀티 실행", exact: true })).toBeEnabled();
  expect(gateway.count("run")).toBe(0);
  await page.getByRole("button", { name: "멀티 실행", exact: true }).click();
  await expect.poll(() => gateway.count("run")).toBe(1);
  expect(gateway.operations.find((op) => op.action === "run")?.body.messages).toEqual([
    { role: "system", content: "읽기 전용 시스템 초안" },
    { role: "user", content: "읽기 전용 사용자 초안" },
  ]);
  await expect(page.locator(".gateway-compare-card .chat-turn-body")).toContainText(
    "공개 비교 응답 public-run-1",
  );
  expect(errors).toEqual([]);
});

for (const colorScheme of ["light", "dark"] as const)
  test(`모델 비교 코드 편집 ${colorScheme} 좁은 화면의 키보드·접근성과 줄 바꿈`, async ({
    page,
    gateway,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
    const { system, user, errors } = await open(page);
    await replaceCode(system, "긴 공개 시스템 지침 ".repeat(30));
    await replaceCode(user, "공개 사용자 질문 ".repeat(30));
    await page.keyboard.press("Tab");
    await expect(user.locator("textarea.inputarea")).not.toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(
      await page.evaluate(async () =>
        (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map((v) => v.id),
      ),
    ).toEqual([]);
    await page.screenshot({ path: info.outputPath(`compare-code-${colorScheme}.png`) });
    expect(gateway.count("run")).toBe(0);
    expect(errors).toEqual([]);
  });
