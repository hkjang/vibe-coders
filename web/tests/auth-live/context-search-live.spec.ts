import { expect } from "@playwright/test";
import type { ContextRegistryMetadataPage } from "../../src/shared/api/generated";
import { admin, reader, login, test } from "./live-fixture";
for (const [id, role, account] of [
  ["AUTH-LIVE-059", "관리자", admin],
  ["AUTH-LIVE-060", "읽기 전용 관리자", reader],
] as const) {
  test(`${id} 실제 ${role}의 참고자료 검색·서버 정렬·직접 주소`, async ({ page }) => {
    const response = page.waitForResponse((r) => {
      const u = new URL(r.url());
      return (
        u.pathname === "/admin/contexts" &&
        u.searchParams.get("q") === "browser-context-0" &&
        r.status() === 200
      );
    });
    await login(
      page,
      account,
      "/app/prompts/library?tab=contexts&contexts_q=browser-context-0&contexts_sort=use_count:desc&contexts_state=enabled",
    );
    const data: ContextRegistryMetadataPage = await (await response).json();
    expect(data.total).toBe(5);
    expect(data.items.map((row) => row.key)).toEqual(
      ["08", "06", "04", "02", "00"].map((suffix) => "browser-context-" + suffix),
    );
    const input = page.getByRole("textbox", { name: "참고자료 검색" });
    await expect(input).toHaveValue("browser-context-0");
    await page.reload();
    await expect(input).toHaveValue("browser-context-0");
    const next = page.waitForResponse((r) => {
      const u = new URL(r.url());
      return (
        u.pathname === "/admin/contexts" &&
        u.searchParams.get("q") === "browser-context-1" &&
        r.status() === 200
      );
    });
    await input.fill("browser-context-1");
    await input.press("Enter");
    const filtered: ContextRegistryMetadataPage = await (await next).json();
    expect(filtered.total).toBe(5);
    expect(filtered.items[0]?.key).toBe("browser-context-18");
    await expect(page.getByRole("table", { name: "공용 참고자료 목록" }).getByRole("row")).toHaveCount(6);
    expect((await page.locator("body").textContent())?.includes("private-context-fixture-body")).toBe(false);
  });
}
