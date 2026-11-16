import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installRequestBulk } from "../fixtures/request-bulk-browser";

async function setup(page: Page, status = 200) {
  const fixture = await installRequestBulk(page);
  fixture.bootstrap.capabilities = { raw_prompt_view: true };
  const suggestions = {
    reads: 0,
    status,
    values: ["team-a-model"],
    hold: undefined as Promise<void> | undefined,
  };
  await page.route("**/admin/suggest?*", async (route) => {
    if (route.request().method() !== "GET") {
      fixture.writes.push(route.request());
      return route.fulfill({ status: 405, json: {} });
    }
    suggestions.reads++;
    const responseStatus = suggestions.status;
    const values = [...suggestions.values];
    if (suggestions.hold) await suggestions.hold;
    return route.fulfill({
      status: responseStatus,
      json: responseStatus === 200 ? { values } : { error: { message: "private-suggestion-fixture" } },
    });
  });
  await page.goto("observability/requests");
  await expect(page.getByRole("table")).toBeVisible();
  return { ...fixture, suggestions };
}
const values = (page: Page) =>
  page
    .locator("#request-filter-models option")
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
async function refreshIdentity(page: Page) {
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await response;
}

test("팀 변경 후에는 이전 자동완성을 지우고 새 입력 포커스에서 다시 조회한다", async ({ page }) => {
  const fixture = await setup(page);
  expect(fixture.suggestions.reads).toBe(0);
  await page.getByLabel("모델", { exact: true }).focus();
  await expect.poll(() => values(page)).toEqual(["team-a-model"]);
  if (!fixture.bootstrap.user) throw new Error("Missing synthetic account");
  fixture.bootstrap.user.team_id = "team-b";
  fixture.suggestions.values = ["team-b-model"];
  await refreshIdentity(page);
  await expect.poll(() => values(page)).toEqual([]);
  expect(fixture.suggestions.reads).toBe(1);
  await page.getByLabel("모델", { exact: true }).focus();
  await expect.poll(() => values(page)).toEqual(["team-b-model"]);
  expect(fixture.suggestions.reads).toBe(2);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("원문 조회 권한 변경은 이전 입력과 추천을 정리하고 새 포커스에서 다시 조회한다", async ({ page }) => {
  const fixture = await setup(page);
  await page.getByLabel("모델", { exact: true }).fill("입력 중인 모델");
  await expect.poll(() => values(page)).toEqual(["team-a-model"]);
  let release!: () => void;
  fixture.suggestions.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture.bootstrap.capabilities = { raw_prompt_view: false };
  fixture.suggestions.values = ["masked-model"];
  await refreshIdentity(page);
  // The request-list read owner also changes with raw access. Its loading state
  // unmounts the old filters, so a new field must explicitly request suggestions.
  await expect(page.getByRole("table")).toBeVisible();
  await expect.poll(() => values(page)).toEqual([]);
  await expect(page.getByLabel("모델", { exact: true })).toHaveValue("");
  expect(fixture.suggestions.reads).toBe(1);
  await page.getByLabel("모델", { exact: true }).focus();
  await expect.poll(() => fixture.suggestions.reads).toBe(2);
  await expect.poll(() => values(page)).toEqual([]);
  release();
  await expect.poll(() => values(page)).toEqual(["masked-model"]);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("자동완성 거부 뒤 직접 입력과 명시 재조회를 제공하며 입력창으로 포커스를 돌린다", async ({ page }) => {
  await page.clock.install();
  const fixture = await setup(page, 403);
  const model = page.getByLabel("모델", { exact: true });
  await model.fill("직접 입력한 모델");
  const retry = page.getByRole("button", { name: "모델 자동완성 다시 불러오기", exact: true });
  await expect(retry).toBeVisible();
  await expect(model).toHaveValue("직접 입력한 모델");
  await expect(page.locator("body")).not.toContainText("private-suggestion-fixture");
  const reads = fixture.suggestions.reads;
  fixture.suggestions.status = 200;
  await page.clock.runFor(361_000);
  await refreshIdentity(page);
  await page.evaluate(() => dispatchEvent(new Event("online")));
  expect(fixture.suggestions.reads).toBe(reads);
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(model).toBeFocused();
  await expect.poll(() => values(page)).toEqual(["team-a-model"]);
  await expect(retry).toHaveCount(0);
  await expect(model).toHaveValue("직접 입력한 모델");
  expect(fixture.suggestions.reads).toBe(reads + 1);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 자동완성 오류의 한글·접근성·직접 입력`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await setup(page, 403);
      await page.getByLabel("모델", { exact: true }).fill("직접 입력한 모델");
      const retry = page.getByRole("button", { name: "모델 자동완성 다시 불러오기", exact: true });
      await expect(retry).toBeVisible();
      await retry.focus();
      const field = page.locator(".request-filters");
      const modelHeight = await page
        .getByLabel("모델", { exact: true })
        .evaluate((input) => input.clientHeight);
      expect(await page.getByLabel("요청 ID", { exact: true }).evaluate((input) => input.clientHeight)).toBe(
        modelHeight,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(
        await page.evaluate(
          async () =>
            (
              await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
                document,
              )
            ).violations,
        ),
      ).toEqual([]);
      await page.mouse.move(0, 0);
      await expect(field).toHaveScreenshot(`request-suggestions-${theme}-${width}.png`, {
        animations: "disabled",
      });
      expect(fixture.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
