import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/provider-catalog-sorting-gateway";

async function refreshIdentity(page: Page) {
  const response = page.waitForResponse((reply) => new URL(reply.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function ready(page: Page) {
  await page.goto("gateway/providers");
  await expect(page.getByRole("link", { name: "provider-00", exact: true })).toBeVisible();
}

test("계정 전환과 복귀 사이의 보류 응답은 현재 공급자 목록을 복원하지 않는다", async ({
  page,
  providerGateway,
}) => {
  await ready(page);
  providerGateway.holdProviderRead(2);
  providerGateway.holdProviderRead(3);
  providerGateway.owner("public-next-owner");
  await refreshIdentity(page);
  await expect
    .poll(() => providerGateway.reads.filter((item) => item.path === "/admin/providers").length)
    .toBe(2);
  await expect(page.getByRole("link", { name: "provider-00", exact: true })).toHaveCount(0);
  const cancelled = page.waitForEvent("requestfailed", {
    predicate: (request) => new URL(request.url()).pathname === "/admin/providers",
  });
  providerGateway.owner("provider-reader");
  await refreshIdentity(page);
  await expect
    .poll(() => providerGateway.reads.filter((item) => item.path === "/admin/providers").length)
    .toBe(3);
  await cancelled;
  providerGateway.releaseProviderRead(2);
  await expect(page.getByRole("link", { name: "provider-00", exact: true })).toHaveCount(0);
  providerGateway.shrink(1);
  providerGateway.releaseProviderRead(3);
  await expect(page.getByRole("link", { name: "provider-00", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "provider-01", exact: true })).toHaveCount(0);
});

test("서버 조회 거부는 이전 목록을 감추고 수동 확인 후 새 목록만 표시한다", async ({
  page,
  providerGateway,
}) => {
  await ready(page);
  providerGateway.status(403);
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByRole("heading", { name: "공급자 조회 권한 확인 필요" })).toBeVisible();
  await expect(page.getByRole("link", { name: "provider-00", exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toBeFocused();
  const reads = providerGateway.reads.length;
  providerGateway.status(200);
  providerGateway.shrink(1);
  await refreshIdentity(page);
  expect(providerGateway.reads).toHaveLength(reads);
  await page.getByRole("button", { name: "권한 확인 후 다시 조회" }).click();
  await expect(page.getByRole("link", { name: "provider-00", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "provider-01", exact: true })).toHaveCount(0);
});

test("읽기 전용 전환은 초안을 유지하고 조회 권한 회수는 목록·초안을 폐기한다", async ({
  page,
  providerGateway,
}) => {
  providerGateway.readonly(false);
  providerGateway.scopes(["admin:read", "admin:write"]);
  await ready(page);
  await page.getByRole("button", { name: "공급자 추가" }).click();
  await page.getByRole("textbox", { name: /^이름/u }).fill("public-unsaved-draft");
  providerGateway.readonly(true);
  await refreshIdentity(page);
  await expect(page.getByRole("textbox", { name: /^이름/u })).toHaveValue("public-unsaved-draft");
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  providerGateway.scopes([]);
  await refreshIdentity(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /^이름/u })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "provider-00", exact: true })).toHaveCount(0);
  providerGateway.scopes(["admin:read", "admin:write"]);
  providerGateway.readonly(false);
  await refreshIdentity(page);
  await expect(page.getByRole("link", { name: "provider-00", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "공급자 추가" }).click();
  await expect(page.getByRole("textbox", { name: /^이름/u })).toHaveValue("");
});
