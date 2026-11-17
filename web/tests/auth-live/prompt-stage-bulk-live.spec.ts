import { expect } from "@playwright/test";
import type { PromptStageBulkApply, PromptStageBulkReview } from "../../src/shared/api/generated";
import { admin, reader, login, test } from "./live-fixture";

test("AUTH-LIVE-057 실제 일괄 승격의 검토·적용·중복 거부와 감사", async ({ page }) => {
  await login(page, admin, "/app/prompts/library?tab=promotions");
  const preview = page.waitForResponse(
    (r) => new URL(r.url()).searchParams.get("view") === "promotion-review" && r.request().method() === "GET",
  );
  await page.getByRole("button", { name: "일괄 승격 검토", exact: true }).click();
  const response = await preview;
  expect(response.status()).toBe(200);
  const review: PromptStageBulkReview = await response.json();
  expect(review.items.length).toBe(2);
  const dialog = page.getByRole("dialog", { name: "프롬프트 일괄 승격 검토" });
  await expect(dialog.getByText("browser-bulk-alpha", { exact: true })).toBeVisible();
  await dialog.getByRole("textbox", { name: /^변경 사유/ }).fill("실제 브라우저 일괄 검토 완료");
  await dialog.getByRole("textbox", { name: /^변경할 버전 수 확인/ }).fill(String(review.items.length));
  await dialog.getByRole("checkbox").check();
  const saved = page.waitForResponse(
    (r) =>
      new URL(r.url()).searchParams.get("view") === "promotion-review" && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "확인한 2개 승격" }).click();
  expect((await saved).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  const payload: PromptStageBulkApply = {
    window: review.window,
    since: review.since,
    until: review.until,
    revision: review.revision,
    reason: "실제 브라우저 일괄 검토 완료",
  };
  const status = await page.evaluate(async (body) => {
    const response = await fetch("/admin/prompts/promotions?view=promotion-review", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
      },
      body: JSON.stringify(body),
    });
    return response.status;
  }, payload);
  expect(status).toBe(409);
});
test("AUTH-LIVE-058 실제 읽기 전용 관리자의 일괄 조회와 직접 변경 거부", async ({ page }) => {
  await login(page, reader, "/app/prompts/library?tab=promotions");
  const preview = page.waitForResponse(
    (r) => new URL(r.url()).searchParams.get("view") === "promotion-review" && r.request().method() === "GET",
  );
  await page.getByRole("button", { name: "일괄 승격 검토", exact: true }).click();
  const response = await preview;
  expect(response.status()).toBe(200);
  const review: PromptStageBulkReview = await response.json();
  const dialog = page.getByRole("dialog", { name: "프롬프트 일괄 승격 검토" });
  await expect(dialog.getByRole("button", { name: /^확인한 .*개 승격$/ })).toBeDisabled();
  const status = await page.evaluate(
    async (body) => {
      const response = await fetch("/admin/prompts/promotions?view=promotion-review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
        },
        body: JSON.stringify(body),
      });
      return response.status;
    },
    {
      window: review.window,
      since: review.since,
      until: review.until,
      revision: review.revision,
      reason: "읽기 전용 거부 확인",
    },
  );
  expect(status === 401 || status === 403).toBe(true);
});
