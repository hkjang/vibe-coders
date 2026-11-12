import { expect, test } from "@playwright/test";
import type axe from "axe-core";
import { installIpUsage } from "../fixtures/ip-usage-browser";

const title = "사용자와 팀의 계정·접근 권한 및 IP 사용량 관리";
const accessibleName = title + " 읽기 전용 미리보기";

for (const theme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    test(`사이드바 한글 이름과 상태를 가리지 않는다 ${theme} ${viewport.width}×${viewport.height}`, async ({
      page,
    }, info) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await installIpUsage(page);
      const feature = fixture.bootstrap.migration_registry?.find(
        (item) => item.feature_id === "access.users",
      );
      if (!feature) throw new Error("Missing public access fixture");
      feature.title = title;
      await page.goto("access/users/ips");
      await expect(page.getByRole("table", { name: "IP별 사용량" })).toBeVisible();
      const mobile = viewport.width < 1024;
      if (mobile) await page.getByRole("button", { name: "탐색 메뉴 열기" }).click();
      const sidebar = page.locator(mobile ? ".app-sidebar-mobile" : ".app-sidebar-desktop");
      const link = sidebar.getByRole("link", { name: accessibleName, exact: true });
      await expect(link).toBeVisible();
      await link.focus();
      await expect(link).toBeFocused();
      expect(
        await link.evaluate((element) => {
          const text = element.querySelector<HTMLElement>(".sidebar-item-title");
          const badge = element.querySelector<HTMLElement>(".badge");
          if (!text || !badge) return false;
          const bounds = element.getBoundingClientRect(),
            label = text.getBoundingClientRect(),
            status = badge.getBoundingClientRect();
          return (
            text.scrollWidth <= text.clientWidth &&
            label.height > parseFloat(getComputedStyle(text).lineHeight) &&
            label.left >= bounds.left &&
            label.right <= bounds.right &&
            status.top >= label.bottom &&
            status.right <= bounds.right
          );
        }),
      ).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(
        await page.evaluate(async () =>
          (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map((item) => ({
            id: item.id,
            targets: item.nodes.map((node) => node.target),
          })),
        ),
      ).toEqual([]);
      await page.screenshot({ path: info.outputPath("navigation.png") });
      if (mobile) {
        await page.keyboard.press("Escape");
        await expect(page.getByRole("button", { name: "탐색 메뉴 열기" })).toBeFocused();
      } else {
        await page.getByRole("button", { name: "사이드바 접기" }).click();
        await expect(link).toHaveAccessibleName(accessibleName);
        await expect(link).toHaveAttribute("title", accessibleName);
        await expect(link.locator(".sidebar-item-copy")).toBeHidden();
        await page.reload();
        await expect(sidebar).toHaveAttribute("data-collapsed", "true");
        await link.focus();
        await expect(link).toBeFocused();
        await page.getByRole("button", { name: "사이드바 펼치기" }).click();
        await expect(link.locator(".sidebar-item-title")).toBeVisible();
        await expect(link).toHaveAttribute("aria-current", "page");
      }
      fixture.check();
    });
  }
}
