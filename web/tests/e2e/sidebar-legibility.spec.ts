import { expect, test } from "@playwright/test";
import type axe from "axe-core";
import { installIpUsage } from "../fixtures/ip-usage-browser";

const title = "사용자와 팀의 계정·접근 권한 및 IP 사용량 관리";
const accessibleName = title + " 읽기 전용 미리보기";

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 844, height: 390 },
]) {
  test(`많은 메뉴에서 현재 화면을 찾고 사용자의 스크롤을 유지한다 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const fixture = await installIpUsage(page);
    const registry = fixture.bootstrap.migration_registry;
    const access = registry?.find((item) => item.feature_id === "access.users");
    if (!registry || !access) throw new Error("Missing public registry fixture");
    for (const [featureId, path, label] of [
      ["gateway.health", "gateway/health", "게이트웨이 상태"],
      ["gateway.providers", "gateway/providers", "AI 공급자"],
      ["gateway.models", "gateway/models", "모델"],
      ["gateway.chat", "gateway/chat", "채팅 테스트"],
      ["routing.rules", "routing/rules", "라우팅"],
      ["observability.traces", "observability/traces", "추적 탐색기"],
      ["observability.sessions", "observability/sessions", "세션 탐색기"],
      ["observability.io", "observability/io", "요청 입출력"],
      ["observability.xview", "observability/xview", "요청 분포"],
      ["observability.llm", "observability/llm", "모델 관측"],
      ["observability.probes", "observability/probes", "연결 진단"],
      ["prompts.lab", "prompts/lab", "프롬프트 실험실"],
      ["prompts.library", "prompts/library", "프롬프트 보관함"],
      ["prompts.regression", "prompts/regression", "회귀 검증"],
    ] as const) {
      registry.push({ ...access, feature_id: featureId, app_path: "/app/" + path, title: label });
    }
    fixture.bootstrap.allowed_features = registry.map((feature) => feature.feature_id);
    const mobile = viewport.width < 1024;
    const sidebar = page.locator(mobile ? ".app-sidebar-mobile" : ".app-sidebar-desktop");
    const nav = sidebar.locator(".sidebar-nav");
    await page.goto("access/users/ips");
    for (let entry = 0; entry < 2; entry += 1) {
      await expect(page.getByRole("table", { name: "IP별 사용량" })).toBeVisible();
      if (mobile) await page.getByRole("button", { name: "탐색 메뉴 열기" }).click();
      await expect
        .poll(() =>
          nav.evaluate((element) => {
            const active = element.querySelector('[aria-current="page"]');
            if (!active) return false;
            const bounds = element.getBoundingClientRect(),
              selected = active.getBoundingClientRect();
            return selected.top >= bounds.top && selected.bottom <= bounds.bottom && element.scrollTop > 0;
          }),
        )
        .toBe(true);
      if (entry === 0) await page.reload();
    }
    // A metadata refresh must not pull the user back to the selected item.
    await nav.evaluate((element) => {
      element.scrollTop = 0;
    });
    const refreshed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/admin/ui-bootstrap",
    );
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await (await refreshed).finished();
    await expect.poll(() => nav.evaluate((element) => element.scrollTop)).toBe(0);
    fixture.check();
  });
}

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
