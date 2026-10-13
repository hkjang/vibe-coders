import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/model-catalog-sorting-gateway";

async function refreshIdentity(page: Page) {
  const response = page.waitForResponse((reply) => new URL(reply.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function ready(page: Page) {
  await page.goto("gateway/models");
  await expect(page.getByRole("link", { name: "model-00", exact: true })).toBeVisible();
}

test("계정 전환과 복귀 사이의 보류 응답은 현재 모델 목록을 복원하지 않는다", async ({
  page,
  modelGateway,
}) => {
  await ready(page);
  modelGateway.holdModelRead(2);
  modelGateway.holdModelRead(3);
  modelGateway.owner("public-next-owner");
  await refreshIdentity(page);
  await expect.poll(() => modelGateway.reads.filter((item) => item.path === "/admin/models").length).toBe(2);
  await expect(page.getByRole("link", { name: "model-00", exact: true })).toHaveCount(0);
  const cancelled = page.waitForEvent("requestfailed", {
    predicate: (request) => new URL(request.url()).pathname === "/admin/models",
  });
  modelGateway.owner("public-model-reader");
  await refreshIdentity(page);
  await expect.poll(() => modelGateway.reads.filter((item) => item.path === "/admin/models").length).toBe(3);
  await cancelled;
  modelGateway.releaseModelRead(2);
  await expect(page.getByRole("link", { name: "model-00", exact: true })).toHaveCount(0);
  modelGateway.shrinkToOrdinary(1);
  modelGateway.releaseModelRead(3);
  await expect(page.getByRole("link", { name: "model-00", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "model-01", exact: true })).toHaveCount(0);
});

test("서버 조회 거부는 이전 목록을 감추고 수동 확인 후 새 목록만 표시한다", async ({
  page,
  modelGateway,
}) => {
  await ready(page);
  modelGateway.status(403);
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByRole("heading", { name: "모델 조회 권한 확인 필요" })).toBeVisible();
  await expect(page.getByRole("link", { name: "model-00", exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toBeFocused();
  const reads = modelGateway.reads.length;
  modelGateway.status(200);
  modelGateway.shrinkToOrdinary(1);
  await refreshIdentity(page);
  expect(modelGateway.reads).toHaveLength(reads);
  await page.getByRole("button", { name: "권한 확인 후 다시 조회" }).click();
  await expect(page.getByRole("link", { name: "model-00", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "model-01", exact: true })).toHaveCount(0);
});

test("읽기 전용 전환은 초안을 유지하고 조회 권한 회수는 목록·초안을 폐기한다", async ({
  page,
  modelGateway,
}) => {
  modelGateway.readonly(false);
  modelGateway.scopes(["admin:read", "admin:write"]);
  await ready(page);
  await page.getByRole("tab", { name: "모델 계약" }).click();
  await page.getByRole("button", { name: "계약 추가" }).click();
  await page.getByRole("textbox", { name: /^이름/u }).fill("public-unsaved-draft");
  modelGateway.readonly(true);
  await refreshIdentity(page);
  await expect(page.getByRole("textbox", { name: /^이름/u })).toHaveValue("public-unsaved-draft");
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  modelGateway.scopes([]);
  await refreshIdentity(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /^이름/u })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "model-00", exact: true })).toHaveCount(0);
  modelGateway.scopes(["admin:read", "admin:write"]);
  modelGateway.readonly(false);
  await refreshIdentity(page);
  await expect(page.getByRole("link", { name: "model-00", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "모델 계약" }).click();
  await page.getByRole("button", { name: "계약 추가" }).click();
  await expect(page.getByRole("textbox", { name: /^이름/u })).toHaveValue("");
});
