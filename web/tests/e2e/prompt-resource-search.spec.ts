import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installPromptLibrary, libraryAsset } from "../fixtures/prompt-library-browser";
import { installPromptLab } from "../fixtures/prompt-lab-browser";
import { labExperiment } from "../fixtures/prompt-lab";

async function install(page: Page, kind: "prompt_asset" | "prompt_experiment", failOnce = false) {
  const fixture =
    kind === "prompt_asset" ? await installPromptLibrary(page, true) : await installPromptLab(page, true);
  fixture.bootstrap.backend_version = "v0.86.97";
  if (!fixture.bootstrap.user) throw new Error("Synthetic reader is missing");
  fixture.bootstrap.user.scopes = ["admin:read"];
  fixture.bootstrap.permissions = ["admin:read"];
  const row =
    kind === "prompt_asset"
      ? { id: libraryAsset.id, title: libraryAsset.name }
      : { id: labExperiment.id, title: labExperiment.title };
  const searches: unknown[] = [];
  await page.route("**/admin/resource-search", (route) => {
    expect(route.request().method()).toBe("POST");
    expect(new URL(route.request().url()).search).toBe("");
    searches.push(route.request().postDataJSON());
    const failed = failOnce && searches.length === 1;
    return route.fulfill({
      json: {
        request_id: "prompt-search-fixture",
        groups: [
          {
            kind,
            status: failed ? "unavailable" : "ok",
            limited: false,
            items: failed ? [] : [{ kind, ...row }],
          },
        ],
      },
    });
  });
  return { ...fixture, searches, row };
}
async function open(page: Page, start: string) {
  await page.goto(start);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
  await dialog.getByRole("button", { name: "자원 검색", exact: true }).click();
  await dialog.getByRole("combobox", { name: "자원 이름 검색" }).fill("요약");
  return dialog;
}

for (const kind of ["prompt_asset", "prompt_experiment"] as const) {
  test(`${kind} 이름 검색에서 상세·새로고침·뒤로 및 앞으로 이동`, async ({ page }) => {
    const fixture = await install(page, kind);
    const start =
      kind === "prompt_asset" ? "prompts/library?tab=assets&asset_q=목록외" : "prompts/lab?q=목록외";
    const dialog = await open(page, start);
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await expect(dialog).not.toContainText("문서의 핵심을 세 문장");
    await page.keyboard.press("Enter");
    const detail =
      kind === "prompt_asset"
        ? page.getByRole("dialog", { name: fixture.row.title, exact: true })
        : page.getByText(`실험: ${fixture.row.title}`, { exact: true });
    await expect(detail).toBeVisible();
    const destination = page.url(),
      url = new URL(destination);
    expect(url.searchParams.get(kind === "prompt_asset" ? "asset" : "exp")).toBe(fixture.row.id);
    expect(url.searchParams.has("q")).toBe(false);
    expect(url.searchParams.has("asset_q")).toBe(false);
    await page.reload();
    await expect(detail).toBeVisible();
    await page.goBack();
    await expect(detail).not.toBeVisible();
    await page.goForward();
    await expect(detail).toBeVisible();
    expect(page.url()).toBe(destination);
    expect(fixture.searches).toEqual([{ query: "요약", kinds: [kind] }]);
    expect(fixture.writes).toEqual([]);
    fixture.check();
  });
}

test("이름 검색 실패 후 재조회로 자산 결과를 복구한다", async ({ page }) => {
  const fixture = await install(page, "prompt_asset", true);
  const dialog = await open(page, "prompts/library?tab=assets");
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await dialog.getByRole("button", { name: "자원 검색 다시 시도" }).click();
  await expect(dialog.getByRole("option")).toHaveCount(1);
  expect(fixture.searches).toHaveLength(2);
  expect(fixture.writes).toEqual([]);
  fixture.check();
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`프롬프트 검색 시각·키보드·접근성 ${theme}-${width}`, async ({ page }) => {
      const fixture = await install(page, "prompt_asset");
      await page.clock.setFixedTime(new Date("2026-11-13T01:00:00Z"));
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const dialog = await open(page, "prompts/library?tab=assets");
      await expect(dialog.getByRole("option")).toHaveCount(1);
      await dialog.evaluate(async (node) => {
        await Promise.all(node.getAnimations().map((a) => a.finished));
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (selector: string) => Promise<AxeResults> } }).axe;
        return (await axe.run('[role="dialog"]')).violations.map(({ id }) => id);
      });
      expect(violations).toEqual([]);
      await expect(page).toHaveScreenshot(`prompt-search-${theme}-${width}.png`);
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      expect(fixture.writes).toEqual([]);
      fixture.check();
    });
  }
