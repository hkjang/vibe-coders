import { expect, test, type Page } from "@playwright/test";
import type axe from "axe-core";
import { installTeamPagination } from "../fixtures/team-pagination-browser";

async function install(page: Page) {
  const fixture = await installTeamPagination(page);
  fixture.bootstrap.backend_version = "v0.86.79";
  const user = fixture.bootstrap.user;
  if (!user?.scopes) throw new Error("Missing team reader fixture");
  user.scopes = user.scopes.filter((scope) => scope !== "admin:write");
  const feature = fixture.bootstrap.migration_registry?.find((item) => item.feature_id === "access.users");
  if (!feature) throw new Error("Missing team feature fixture");
  feature.read_only = true;
  const state = { failed: false };
  const requests: unknown[] = [];
  await page.route("**/admin/resource-search", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(new URL(route.request().url()).search).toBe("");
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        request_id: "team-search-request",
        groups: [
          {
            kind: "team",
            status: state.failed ? "unavailable" : "ok",
            limited: true,
            items: state.failed
              ? []
              : fixture.rows.slice(41, 43).map((row) => ({ kind: "team", id: row.id, title: row.name })),
          },
        ],
      },
    });
  });
  return { ...fixture, searchState: state, requests };
}

async function open(page: Page) {
  await page.goto("access/users?tab=teams");
  await expect(page.getByRole("link", { name: "운영팀 01 등록 정보 보기" })).toBeVisible();
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
  await palette.getByRole("button", { name: "자원 검색", exact: true }).click();
  await expect(palette.getByRole("combobox")).toBeFocused();
  await palette.getByRole("combobox").fill("운영팀");
  return palette;
}

test("전역 팀 이름 검색은 읽기 권한으로 정확한 상세를 열고 새로고침·닫기 초점을 보존한다", async ({
  page,
}) => {
  const fixture = await install(page);
  const palette = await open(page);
  await expect(palette.getByRole("option")).toHaveCount(2);
  expect(fixture.requests).toEqual([{ query: "운영팀", kinds: ["team"] }]);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "등록 팀 상세", exact: true });
  await expect(panel).toContainText("운영팀 42");
  await expect(panel.getByRole("button", { name: /저장|수정/u })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("registered_team")).toBe("team_page_042");
  expect(new URL(page.url()).searchParams.has("q")).toBe(false);
  expect(new URL(page.url()).searchParams.has("registered_q")).toBe(false);
  expect(fixture.reads.at(-1)?.get("id")).toBe("team_page_042");
  await page.reload();
  await expect(panel).toContainText("운영팀 42");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(page).not.toHaveURL(/registered_team=/u);
  fixture.check();
});

test("전역 팀 검색의 부분 실패를 다시 조회하고 같은 등록 정보로 이동한다", async ({ page }) => {
  const fixture = await install(page);
  fixture.searchState.failed = true;
  const palette = await open(page);
  await expect(palette.getByRole("status")).toContainText("일부 종류");
  await expect(palette.getByRole("option")).toHaveCount(0);
  fixture.searchState.failed = false;
  await palette.getByRole("button", { name: "자원 검색 다시 시도" }).click();
  await expect(palette.getByRole("option")).toHaveCount(2);
  await expect(palette.getByRole("status")).toContainText("더 구체적으로");
  await expect(palette.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "등록 팀 상세", exact: true })).toContainText("운영팀 41");
  expect(fixture.requests).toHaveLength(2);
  fixture.check();
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`전역 팀 검색 접근성·시각 기준 ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await install(page);
      const palette = await open(page);
      await expect(palette.getByRole("option")).toHaveCount(2);
      expect(
        await page.evaluate(async () =>
          (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map(
            (item) => item.id,
          ),
        ),
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page).toHaveScreenshot(`team-search-${theme}-${width}.png`, {
        animations: "disabled",
        fullPage: false,
        mask: [page.locator(".updated-at")],
      });
      await page.keyboard.press("Escape");
      await expect(palette).toHaveCount(0);
      fixture.check();
    });
  }
}
