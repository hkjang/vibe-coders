import { expectCellBoundaries } from "../fixtures/table-cell-boundaries";
import { expect } from "@playwright/test";
import { test } from "../fixtures/provider-catalog-sorting-gateway";

for (const width of [1440, 390]) {
  test(`긴 한글·URL·모델 패턴은 ${width}px에서 열 간격과 원문을 유지한다`, async ({
    page,
    providerGateway,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const name = "운영용_한글공급자_".repeat(8);
    const pattern = "public-model-with-a-long-unbroken-identifier-".repeat(6);
    providerGateway.replace([
      {
        name,
        provider_ref: `prv_${"x".repeat(43)}`,
        base_url: `https://public.example.invalid/${"public-path/".repeat(12)}`,
        model_patterns: pattern,
        failover_group: "장애전환그룹이름".repeat(7),
        priority: 100,
        enabled: true,
        timeout_ms: 30000,
        api_key_configured: true,
        created_at: "2026-10-12T00:00:00Z",
      },
    ]);
    await page.goto("gateway/providers");
    const table = page.getByRole("table", { name: "공급자 연결 설정과 운영 상태" });
    const link = table.getByRole("link", { name, exact: true });
    await expect(link).toBeVisible();
    await expect(table.getByText("확인 중", { exact: true })).toHaveCount(0);
    await expectCellBoundaries(table);
    await page.getByRole("separator", { name: "공급자 열 너비 조절", exact: true }).press("Home");
    await expectCellBoundaries(table);
    await expect(link).toHaveText(name);
    await expect(table.getByText(pattern, { exact: true })).toHaveText(pattern);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await link.focus();
    await expect(link).toBeFocused();
    await page.screenshot({ path: info.outputPath("long-table-cells.png"), fullPage: true });
  });
}
