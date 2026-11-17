import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installPromptLibrary } from "../fixtures/prompt-library-browser";

async function fixture(page: Page) {
  const base = await installPromptLibrary(page);
  base.bootstrap.backend_version = "v0.86.143";
  base.bootstrap.allowed_features = ["security.redteam"];
  Object.assign(base.bootstrap.migration_registry[0] ?? {}, {
    feature_id: "security.redteam",
    title: "레드팀 자동화",
    app_path: "/app/redteam",
    legacy_path: "/admin#/redteam",
    required_permission: "admin:read",
    risk_level: "critical",
  });
  const targets = [
    {
      id: "public-provider",
      target_type: "provider",
      target_ref: "provider:public",
      provider: "PublicCloud",
      risk_level: "high",
      enabled: true,
      metadata: { title: "서울 연결" },
    },
    {
      id: "public-model",
      target_type: "model",
      target_ref: "model:public",
      model: "public-model",
      risk_level: "low",
      enabled: true,
      metadata: { title: "문서 요약 모델" },
    },
    {
      id: "public-custom",
      target_type: "__proto__",
      target_ref: "custom:public",
      risk_level: "constructor",
      enabled: false,
      metadata: { title: "사용자 정의 자산" },
    },
  ];
  await page.route("**/admin/redteam/**", async (route) => {
    expect(route.request().method()).toBe("GET");
    const path = new URL(route.request().url()).pathname;
    if (path === "/admin/redteam/targets") return route.fulfill({ json: { targets } });
    if (path === "/admin/redteam/probe-packs") return route.fulfill({ json: { probe_packs: [] } });
    return route.fulfill({ json: path.endsWith("kill-switch") ? { enabled: false } : {} });
  });
  return base;
}

test("보이는 한글과 기존 식별자로 검색하고 URL·새로고침·지우기를 유지한다", async ({ page }) => {
  const api = await fixture(page);
  await page.goto("redteam?tab=targets");
  const search = page.getByRole("search");
  const input = search.getByLabel("대상 검색", { exact: true });
  for (const query of ["서울", "제공자", "높음", "PUBLICCLOUD"]) {
    await input.fill(query);
    await input.press("Enter");
    await expect(page).toHaveURL((url) => url.searchParams.get("q") === query);
    await expect(input).toHaveAttribute("value", query);
    await expect(page.getByRole("status").filter({ hasText: "검색 결과 1개 / 전체 3개 대상" })).toBeVisible();
    await expect(page.getByRole("button", { name: "provider:public 상세 보기", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "model:public 상세 보기", exact: true })).toHaveCount(0);
  }
  await page.reload();
  await expect(input).toHaveValue("PUBLICCLOUD");
  await expect(page.getByRole("status").filter({ hasText: "검색 결과 1개 / 전체 3개 대상" })).toBeVisible();
  await search.getByRole("button", { name: "검색 조건 지우기" }).click();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  expect(new URL(page.url()).searchParams.has("q")).toBe(false);
  expect(new URL(page.url()).searchParams.get("tab")).toBe("targets");
  await expect(page.getByRole("status").filter({ hasText: "전체 3개 대상" })).toBeVisible();
  api.check();
});

test("빈 결과에서 복귀하고 사용자 정의 유형도 검색한다", async ({ page }) => {
  const api = await fixture(page);
  await page.goto("redteam?tab=targets&q=없는대상");
  await expect(page.getByText("검색 조건에 맞는 대상이 없습니다.", { exact: true })).toBeVisible();
  const input = page.getByLabel("대상 검색", { exact: true });
  await input.fill("__proto__");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "custom:public 상세 보기", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "검색 결과 1개 / 전체 3개 대상" })).toBeVisible();
  api.check();
});

test("인증정보 입력은 URL에 반영하지 않고 지우기로 복구한다", async ({ page }) => {
  const api = await fixture(page);
  await page.goto("redteam?tab=targets&q=서울");
  const input = page.getByLabel("대상 검색", { exact: true });
  await input.fill(`vc_sk_${"a".repeat(40)}`);
  await input.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "인증정보로 보이는 검색어" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("q")).toBe("서울");
  await page.getByRole("button", { name: "검색 조건 지우기" }).click();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  expect(new URL(page.url()).searchParams.has("q")).toBe(false);
  api.check();
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}: 검색 결과·키보드·접근성`, async ({ page }) => {
      const api = await fixture(page);
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("redteam?tab=targets&q=높음");
      await expect(
        page.getByRole("status").filter({ hasText: "검색 결과 1개 / 전체 3개 대상" }),
      ).toBeVisible();
      await page.getByLabel("대상 검색", { exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("search").getByRole("button", { name: "검색", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      const clear = page.getByRole("button", { name: "검색 조건 지우기" });
      await expect(clear).toBeFocused();
      await expect(clear).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const result = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: () => Promise<AxeResults> } }).axe;
        return (await axe.run()).violations;
      });
      expect(result).toEqual([]);
      await clear.focus();
      const inventory = page.locator(".section-card").filter({ has: page.getByRole("search") });
      await expect(inventory).toHaveScreenshot(`redteam-target-search-${theme}-${width}.png`);
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("대상 검색", { exact: true })).toBeFocused();
      api.check();
    });
