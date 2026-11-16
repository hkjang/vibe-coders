import { expect } from "@playwright/test";
import { test, traceAccount, flowRequestA } from "./fixtures/trace-safe-flow";

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 단계 필터·상태 요약·표 스크롤`, async ({ page, gateway }) => {
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      const target = `/app/observability/traces?selected_ref=${flowRequestA.request_ref}&flow_status=error`;
      await page.goto(`login?return_to=${encodeURIComponent(target)}`);
      await page.getByLabel("이메일", { exact: true }).fill(traceAccount.email);
      await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
      await page.getByRole("button", { name: "로그인", exact: true }).click();
      const card = page.getByRole("region", { name: "선택한 요청의 단계 기록", exact: true });
      await expect(card.getByRole("table")).toBeVisible();
      expect(gateway.calls).toHaveLength(1);
      await expect(card.getByRole("combobox", { name: "단계 상태", exact: true })).toHaveValue("error");
      await expect(card).toContainText("하위 단계 2개 중 1개 표시");
      await page.mouse.move(0, 0);
      await expect(card.locator(".trace-step-explorer")).toHaveScreenshot(
        `trace-steps-${theme}-${width}.png`,
        { animations: "disabled" },
      );
      await expect(card.getByRole("region", { name: "단계 표 가로 스크롤", exact: true })).toHaveScreenshot(
        `trace-step-table-${theme}-${width}.png`,
        { animations: "disabled" },
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const violations = await page.evaluate(async () => {
        const axe = (
          window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
        ).axe;
        return (await axe.run(document)).violations.map((item) => item.id);
      });
      expect(violations).toEqual([]);
      const kind = card.getByRole("combobox", { name: "단계 유형", exact: true });
      await kind.focus();
      await page.keyboard.press("Tab");
      await expect(card.getByRole("combobox", { name: "단계 상태", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await expect(card.getByRole("combobox", { name: "단계 상태", exact: true })).toHaveValue("all");
      await page.keyboard.press("Tab");
      await expect(card.getByRole("region", { name: "단계 표 가로 스크롤" })).toBeFocused();
    });
  }
}
