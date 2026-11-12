import { expect } from "@playwright/test";
import { test, account, policy } from "./fixtures/policy-editor";

test("정책 JSON 편집의 오류 초점·원본 복원·되돌리기 경계·검토 저장을 유지한다", async ({ page, gateway }) => {
  await page.goto("login?return_to=%2Fapp%2Fgovernance%2Fpolicies%3Ftab%3Dsafety");
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await page.getByRole("button", { name: `${policy.name} 초안 편집`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "비활성 정책 편집", exact: true });
  const first = dialog.getByRole("group", { name: "규칙 1", exact: true });
  await first.getByRole("button", { name: "조건 JSON 코드 편집기 열기", exact: true }).click();
  const editor = first.locator(".code-editor").first();
  const input = editor.locator("textarea.inputarea");
  await expect(input).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("{invalid_public");
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  expect(gateway.saves).toEqual([]);
  await first.getByRole("button", { name: "조건 JSON 원본 유지", exact: true }).click();
  await editor.getByRole("button", { name: "입력 되돌리기", exact: true }).click();
  await editor.getByRole("button", { name: "조건 JSON 기본 입력으로 전환", exact: true }).click();
  const original = await first.getByRole("textbox", { name: "조건 JSON", exact: true }).inputValue();
  expect(JSON.parse(original)).toEqual(policy.rules?.[0]?.conditions);
  await first.getByRole("button", { name: "조건 JSON 코드 편집기 열기", exact: true }).click();
  await expect(input).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText('{"model":"public-edited-model","future_filter":{"keep":[1,null]}}');
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await dialog.getByRole("button", { name: "검토한 내용 저장", exact: true }).click();
  await expect(dialog.getByText("비활성 정책을 저장했습니다.", { exact: true })).toBeVisible();
  expect(gateway.saves).toHaveLength(1);
  expect(gateway.saves[0]).toMatchObject({
    enabled: false,
    rules: [
      {
        id: policy.rules?.[0]?.id,
        conditions: { model: "public-edited-model", future_filter: { keep: [1, null] } },
      },
      { id: policy.rules?.[1]?.id, conditions: policy.rules?.[1]?.conditions },
    ],
  });
});
