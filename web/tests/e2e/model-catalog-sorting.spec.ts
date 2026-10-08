import { expect, type Page } from "@playwright/test";
import { alphaRef, modelPath, ordinaryIds, test } from "../fixtures/model-catalog-sorting-gateway";

const caption = "공급자별 모델 상태, 품질과 가격";
const table = (page: Page) => page.getByRole("table", { name: caption });
const links = (page: Page) => table(page).getByRole("link");
const header = (page: Page, label: string) =>
  table(page).getByRole("columnheader").filter({ hasText: label });
const params = (page: Page) => new URL(page.url()).searchParams;
const size = (page: Page) => page.getByRole("combobox", { name: "페이지당 표시 건수", exact: true });
async function ready(page: Page, count: number) {
  await expect(links(page)).toHaveCount(count);
  await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
  await expect(table(page).getByText("확인 중", { exact: true })).toHaveCount(0);
}
async function sort(page: Page, label: string, direction: "ascending" | "descending") {
  await header(page, label).getByRole("button").click();
  await expect(header(page, label)).toHaveAttribute("aria-sort", direction);
}

test("61 received rows are sorted before slicing without a discovery GET or write", async ({
  page,
  modelGateway,
}) => {
  await page.goto("gateway/models?page=3");
  await ready(page, 10);
  expect(await links(page).allTextContents()).toEqual(ordinaryIds.slice(20, 30));
  expect(modelGateway.reads).toHaveLength(4);
  await sort(page, "입력 / 100만 토큰", "ascending");
  await expect(links(page).first()).toHaveText("z-free");
  expect(params(page).get("page")).toBeNull();
  await sort(page, "품질", "descending");
  await expect(links(page).first()).toHaveText("z-best");
  await expect(page.getByText("일부 공급자의 모델 목록을 갱신하지 못했습니다.")).toBeVisible();
  await page.getByRole("button", { name: "기본 순서", exact: true }).click();
  await expect(links(page).first()).toHaveText("model-00");
  await expect(table(page).getByText("이전 데이터", { exact: true })).toBeVisible();
  expect(modelGateway.reads).toHaveLength(4);
});

test("10/25/50 controls remain local and reset the page before slicing", async ({ page, modelGateway }) => {
  await page.goto("gateway/models");
  await ready(page, 10);
  await expect(size(page)).toHaveValue("10");
  await size(page).selectOption("25");
  await expect(links(page)).toHaveCount(25);
  expect(await links(page).allTextContents()).toEqual(ordinaryIds.slice(0, 25));
  await page.getByRole("button", { name: "다음", exact: true }).click();
  expect(await links(page).allTextContents()).toEqual(ordinaryIds.slice(25, 50));
  await size(page).selectOption("50");
  await expect(links(page)).toHaveCount(50);
  expect(await links(page).allTextContents()).toEqual(ordinaryIds.slice(0, 50));
  expect(params(page).get("page")).toBeNull();
  await size(page).selectOption("10");
  await expect(links(page)).toHaveCount(10);
  expect(modelGateway.reads).toHaveLength(4);
});

test("explicit sort, size and page survive reload and browser Back/Forward", async ({
  page,
  modelGateway,
}) => {
  await page.goto("gateway/models");
  await ready(page, 10);
  await sort(page, "입력 / 100만 토큰", "ascending");
  await size(page).selectOption("25");
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect.poll(() => params(page).get("page")).toBe("2");
  const pageTwo = await links(page).allTextContents();
  expect(modelGateway.reads).toHaveLength(4);
  await page.reload();
  await ready(page, 25);
  expect(params(page).get("sort")).toBe("input_price_asc");
  expect(params(page).get("page_size")).toBe("25");
  expect(params(page).get("page")).toBe("2");
  expect(await links(page).allTextContents()).toEqual(pageTwo);
  expect(modelGateway.reads).toHaveLength(8);
  await page.goBack();
  await expect(links(page).first()).toHaveText("z-free");
  await expect(links(page)).toHaveCount(25);
  expect(params(page).get("page")).toBeNull();
  await page.goBack();
  await expect(size(page)).toHaveValue("10");
  await expect(links(page)).toHaveCount(10);
  expect(params(page).get("sort")).toBe("input_price_asc");
  await page.goForward();
  await expect(size(page)).toHaveValue("25");
  await expect(links(page).first()).toHaveText("z-free");
  expect(modelGateway.reads).toHaveLength(8);
});

test("the compatibility entry preserves permitted sorting, size, page and filter through reload", async ({
  page,
  modelGateway,
}) => {
  await page.goto("models?sort=quality_desc&page_size=25&page=2&q=model-");
  await ready(page, 25);
  expect(new URL(page.url()).pathname).toBe(modelPath);
  expect(params(page).get("sort")).toBe("quality_desc");
  expect(params(page).get("page_size")).toBe("25");
  expect(params(page).get("page")).toBe("2");
  expect(params(page).get("q")).toBe("model-");
  await expect(header(page, "품질")).toHaveAttribute("aria-sort", "descending");
  expect(await links(page).allTextContents()).toEqual(ordinaryIds.slice(25, 50));
  await page.reload();
  await ready(page, 25);
  expect(await links(page).allTextContents()).toEqual(ordinaryIds.slice(25, 50));
  expect(params(page).get("sort")).toBe("quality_desc");
  expect(modelGateway.reads).toHaveLength(8);
});

test("a local filter resets page but preserves sort/size and no-sample information", async ({
  page,
  modelGateway,
}) => {
  await page.goto("gateway/models?sort=quality_desc&page_size=25&page=3");
  await ready(page, 11);
  await page.getByLabel("모델 검색", { exact: true }).fill("signal");
  await page.getByRole("search").getByRole("button", { name: "검색", exact: true }).click();
  await expect(links(page)).toHaveCount(3);
  expect(params(page).get("page")).toBeNull();
  expect(params(page).get("sort")).toBe("quality_desc");
  await expect(size(page)).toHaveValue("25");
  await expect(table(page).getByText("요청 표본 없음", { exact: true })).toBeVisible();
  await expect(table(page).getByText("0%", { exact: true })).toHaveCount(1);
  await expect(size(page)).toBeVisible();
  expect(modelGateway.reads).toHaveLength(4);
});

test("a successful smaller catalogue clamps the URL without silently requesting server pages", async ({
  page,
  modelGateway,
}) => {
  await page.goto("gateway/models?page=7");
  await ready(page, 1);
  modelGateway.shrinkToOrdinary(11);
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(links(page).first()).toHaveText("model-10");
  await expect(links(page)).toHaveCount(1);
  await expect.poll(() => params(page).get("page")).toBe("2");
  await expect.poll(() => modelGateway.reads.length).toBe(8);
  expect(
    modelGateway.reads.filter((call) => call.path === "/admin/models").every((call) => call.query === ""),
  ).toBe(true);
});

test("equal values keep duplicate source identity and return focus to the exact model trigger", async ({
  page,
  modelGateway,
}) => {
  await page.goto("gateway/models?q=tie-model");
  await ready(page, 3);
  const expected = await links(page).evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.modelTrigger),
  );
  await sort(page, "품질", "descending");
  expect(
    await links(page).evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.modelTrigger)),
  ).toEqual(expected);
  await sort(page, "품질", "ascending");
  expect(
    await links(page).evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.modelTrigger)),
  ).toEqual(expected);
  const trigger = table(page)
    .getByRole("row")
    .filter({ hasText: "에이전트 경로" })
    .getByRole("link", { name: "tie-model", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "tie-model", exact: true });
  await expect(dialog).toBeVisible();
  expect(params(page).get("model_provider")).toBe(alphaRef);
  expect(params(page).get("source")).toBe("agent_route");
  await expect(dialog.getByText("에이전트 경로", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(modelGateway.reads).toHaveLength(4);
});

test("390px dark controls support keyboard sorting, scrolling and unclipped sizing without axe violations", async ({
  page,
  modelGateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("gateway/models");
  await ready(page, 10);
  const quality = header(page, "품질");
  await quality.getByRole("button").focus();
  await page.keyboard.press("Enter");
  await expect(quality).toHaveAttribute("aria-sort", "descending");
  await expect(links(page).first()).toHaveText("z-best");
  await page.keyboard.press("Space");
  await expect(quality).toHaveAttribute("aria-sort", "ascending");
  await expect(links(page).first()).toHaveText("signal-observed-zero");
  const scroll = page.locator(".data-table-scroll");
  await expect(scroll).toHaveAttribute("tabindex", "0");
  await scroll.evaluate((node) => {
    node.scrollLeft = 0;
  });
  await scroll.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  await size(page).selectOption("25");
  await expect(links(page)).toHaveCount(25);
  const box = await size(page).boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("Page-size control has no visible browser box");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as { axe: { run: (root: Document) => Promise<{ violations: unknown[] }> } }
    ).axe;
    return (await axe.run(document)).violations;
  });
  expect(violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("model-catalog-sorting-390-dark.png"), fullPage: true });
  expect(modelGateway.reads).toHaveLength(4);
});
