import { expect } from "@playwright/test";
import type { PromptProductMetadataPage } from "../../src/shared/api/generated";
import { admin, login, reader, test } from "./live-fixture";

for (const [id, role, account] of [
  ["AUTH-LIVE-053", "관리자", admin],
  ["AUTH-LIVE-054", "읽기 전용 관리자", reader],
] as const) {
  test(`${id} 실제 ${role}의 프롬프트 제품 목록·페이지·사용 상태 정합성`, async ({ page }) => {
    const response = page.waitForResponse((value) => {
      const url = new URL(value.url());
      return (
        url.pathname === "/admin/prompt-products" &&
        url.searchParams.get("view") === "metadata" &&
        value.status() === 200
      );
    });
    await login(page, account, "/app/prompts/library?tab=products");
    const data: PromptProductMetadataPage = await (await response).json();
    expect(data.total === 31 && data.items.length === 25 && data.offset === 0).toBe(true);
    expect(
      data.items.every(
        (item) =>
          Object.keys(item).sort().join() ===
          "category,created_at,last_used_at,name,source_distinct_keys,source_requests,template_state,use_count",
      ),
    ).toBe(true);
    const table = page.getByRole("table", { name: "프롬프트 제품 목록" });
    await expect(table.getByRole("row")).toHaveCount(26);
    const names = await table.getByRole("row").allTextContents();
    expect(data.items.every((item, index) => names[index + 1]?.includes(item.name))).toBe(true);
    await page.getByRole("button", { name: "다음", exact: true }).click();
    await expect(table.getByRole("row")).toHaveCount(7);
    await page.reload();
    await expect(table.getByRole("row")).toHaveCount(7);
    const missing = page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === "/admin/prompt-products" &&
        new URL(value.url()).searchParams.get("state") === "missing" &&
        value.status() === 200,
    );
    await page.getByRole("combobox", { name: "원본 템플릿 상태" }).selectOption("missing");
    const filtered: PromptProductMetadataPage = await (await missing).json();
    expect(
      filtered.total === 10 &&
        filtered.items.length === 10 &&
        filtered.items.every((item) => item.template_state === "missing" && item.use_count === null),
    ).toBe(true);
    await expect(table.getByRole("row")).toHaveCount(11);
    expect((await page.locator("body").textContent())?.includes("private-product-fixture-body")).toBe(false);
  });
}
