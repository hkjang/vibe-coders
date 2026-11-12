import { expect, test } from "@playwright/test";
import type axe from "axe-core";
import { installIpUsage } from "../fixtures/ip-usage-browser";

test("사용자 메뉴는 Escape로 닫고 열기 버튼에 초점을 돌린다", async ({ page }) => {
  const fixture = await installIpUsage(page);
  await page.goto("access/users/ips");
  const trigger = page.getByLabel("사용자 메뉴", { exact: true });
  await trigger.click();
  const menu = page.locator(".user-menu");
  await expect(menu).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(menu).not.toHaveAttribute("open");
  await expect(trigger).toBeFocused();
  fixture.check();
});

test("상단 메뉴 밖을 선택하면 닫고 선택한 곳의 초점을 유지한다", async ({ page }) => {
  const fixture = await installIpUsage(page);
  await page.goto("access/users/ips");
  await page.getByLabel("사용자 메뉴", { exact: true }).click();
  const search = page.getByLabel("IP별 사용량 검색어", { exact: true });
  await search.click();
  await expect(page.locator(".user-menu")).not.toHaveAttribute("open");
  await expect(search).toBeFocused();
  fixture.check();
});

test("표시 설정은 키보드로 열고 탭 이동으로 빠져나온다", async ({ page }) => {
  const fixture = await installIpUsage(page);
  await page.goto("access/users/ips");
  const trigger = page.getByLabel("화면 표시 설정", { exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.locator(".preference-menu");
  for (const name of ["테마", "정보 밀도", "자동 갱신 주기"]) {
    await page.keyboard.press("Tab");
    await expect(menu.getByRole("combobox", { name, exact: true })).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(menu).not.toHaveAttribute("open");
  await expect(page.locator(".header-legacy")).toBeFocused();
  fixture.check();
});

for (const kind of ["palette", "help"] as const) {
  test(`상단 메뉴 안에서 단축키를 사용한 뒤 메뉴 열기 버튼으로 복귀한다 ${kind}`, async ({ page }) => {
    const fixture = await installIpUsage(page);
    await page.goto("access/users/ips");
    const label = kind === "palette" ? "화면 표시 설정" : "사용자 메뉴";
    const menu = page.locator(kind === "palette" ? ".preference-menu" : ".user-menu");
    const trigger = page.getByLabel(label, { exact: true });
    await trigger.click();
    if (kind === "palette") {
      await menu.getByRole("combobox", { name: "테마", exact: true }).focus();
      await page.keyboard.press("Control+k");
    } else {
      await menu.getByRole("button", { name: "로그아웃", exact: true }).focus();
      await page.keyboard.press("?");
    }
    await expect(
      page.getByRole("dialog", { name: kind === "palette" ? "명령 팔레트" : "단축키", exact: true }),
    ).toBeVisible();
    await expect(menu).not.toHaveAttribute("open");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    fixture.check();
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  test(`표시 설정에서 화면 크기와 관계없이 테마·밀도·갱신을 바꾼다 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const fixture = await installIpUsage(page);
    await page.goto("access/users/ips");
    await page.getByLabel("화면 표시 설정", { exact: true }).click();
    const settings = page.locator(".preference-menu");
    await settings.getByRole("combobox", { name: "테마", exact: true }).selectOption("dark");
    await settings.getByRole("combobox", { name: "정보 밀도", exact: true }).selectOption("compact");
    await settings.getByRole("combobox", { name: "자동 갱신 주기", exact: true }).selectOption("60");
    await page.keyboard.press("Escape");
    await expect(settings).not.toHaveAttribute("open");
    await page.reload();
    await page.getByLabel("화면 표시 설정", { exact: true }).click();
    await expect(settings.getByRole("combobox", { name: "테마", exact: true })).toHaveValue("dark");
    await expect(settings.getByRole("combobox", { name: "정보 밀도", exact: true })).toHaveValue("compact");
    await expect(settings.getByRole("combobox", { name: "자동 갱신 주기", exact: true })).toHaveValue("60");
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
    test(`상단 메뉴의 화면 범위와 접근성 ${theme} ${viewport.width}×${viewport.height}`, async ({
      page,
    }, info) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await installIpUsage(page);
      await page.goto("access/users/ips");
      await page.getByLabel("화면 표시 설정", { exact: true }).click();
      await page
        .locator(".preference-menu")
        .getByRole("combobox", { name: "테마", exact: true })
        .selectOption(theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const [label, selector] of [
        ["화면 표시 설정", ".preference-menu"],
        ["사용자 메뉴", ".user-menu"],
      ] as const) {
        const menu = page.locator(selector);
        if (!(await menu.evaluate((element) => (element as HTMLDetailsElement).open))) {
          await page.getByLabel(label, { exact: true }).click();
        }
        await expect(menu).toHaveAttribute("open", "");
        const panel = menu.locator(".popover-card");
        const box = await panel.boundingBox();
        if (!box) throw new Error("Header panel is not visible");
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(
          await page.evaluate(async () =>
            (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map((v) => ({
              id: v.id,
              nodes: v.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
            })),
          ),
        ).toEqual([]);
        await page.screenshot({ path: info.outputPath(selector.slice(1) + ".png") });
        await page.keyboard.press("Escape");
        await expect(menu).not.toHaveAttribute("open");
        await expect(page.getByLabel(label, { exact: true })).toBeFocused();
      }
      fixture.check();
    });
  }
}
