import { expect } from "@playwright/test";
import type { ContextRegistryMetadataPage } from "../../src/shared/api/generated";
import { admin, login, reader, test } from "./live-fixture";

for (const [id, role, account] of [
  ["AUTH-LIVE-051", "관리자", admin],
  ["AUTH-LIVE-052", "읽기 전용 관리자", reader],
] as const) {
  test(`${id} 실제 ${role}의 공용 참고자료 목록·페이지·사용 상태 정합성`, async ({ page }) => {
    const response = page.waitForResponse((value) => {
      const url = new URL(value.url());
      return (
        url.pathname === "/admin/contexts" &&
        url.searchParams.get("view") === "metadata" &&
        value.status() === 200
      );
    });
    await login(page, account, "/app/prompts/library?tab=contexts");
    const data: ContextRegistryMetadataPage = await (await response).json();
    expect(data.total === 31 && data.items.length === 25 && data.offset === 0).toBe(true);
    expect(
      data.items.every(
        (item) =>
          Object.keys(item).sort().join() ===
          "enabled,key,last_used_at,name,token_estimate,updated_at,use_count",
      ),
    ).toBe(true);
    const table = page.getByRole("table", { name: "공용 참고자료 목록" });
    await expect(table.getByRole("row")).toHaveCount(26);
    const names = await table.getByRole("row").allTextContents();
    expect(data.items.every((item, index) => names[index + 1]?.includes(item.name))).toBe(true);
    await page.getByRole("button", { name: "다음", exact: true }).click();
    await expect(table.getByRole("row")).toHaveCount(7);
    await page.reload();
    await expect(table.getByRole("row")).toHaveCount(7);
    const disabled = page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === "/admin/contexts" &&
        new URL(value.url()).searchParams.get("state") === "disabled" &&
        value.status() === 200,
    );
    await page.getByRole("combobox", { name: "참고자료 사용 상태" }).selectOption("disabled");
    const filtered: ContextRegistryMetadataPage = await (await disabled).json();
    expect(
      filtered.total === 15 && filtered.items.length === 15 && filtered.items.every((item) => !item.enabled),
    ).toBe(true);
    await expect(table.getByRole("row")).toHaveCount(16);
    expect((await page.locator("body").textContent())?.includes("private-context-fixture-body")).toBe(false);
  });
}
