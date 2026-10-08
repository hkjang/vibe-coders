import { expect, type Page } from "@playwright/test";
import { modelPath, ordinaryIds, test } from "../fixtures/model-catalog-sorting-gateway";

// Independent additions only. The original eight scenarios and synthetic fixture
// remain unchanged; no application internals or live gateway are used here.
const caption = "공급자별 모델 상태, 품질과 가격";
const table = (page: Page) => page.getByRole("table", { name: caption });
const links = (page: Page) => table(page).getByRole("link");
const params = (page: Page) => new URL(page.url()).searchParams;
const size = (page: Page) => page.getByRole("combobox", { name: "페이지당 표시 건수", exact: true });
const heading = (page: Page, label: string) =>
  table(page).getByRole("columnheader").filter({ hasText: label });

async function ready(page: Page, count: number) {
  await expect(links(page)).toHaveCount(count);
  await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
  await expect(table(page).getByText("확인 중", { exact: true })).toHaveCount(0);
}

async function paletteCommand(page: Page, query: string) {
  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
  await expect(palette).toBeVisible();
  const search = palette.getByRole("combobox", { name: "메뉴 검색", exact: true });
  await search.fill(query);
  await expect(palette.getByRole("option")).toHaveCount(1);
  await search.press("Enter");
  await expect(palette).toBeHidden();
}

test("팔레트의 명시적 새로고침은 정렬·표시 건수·페이지 URL과 행 순서를 유지한다", async ({
  page,
  modelGateway,
}) => {
  await page.goto("gateway/models?sort=quality_desc&page_size=25&page=2&q=model-");
  await ready(page, 25);
  const originalURL = page.url();
  const originalRows = await links(page).allTextContents();
  expect(originalRows).toEqual(ordinaryIds.slice(25, 50));
  expect(modelGateway.reads).toHaveLength(4);

  await paletteCommand(page, "지금 새로고침");
  await expect.poll(() => modelGateway.reads.length).toBe(8);
  await ready(page, 25);
  await expect(page).toHaveURL(originalURL);
  expect(await links(page).allTextContents()).toEqual(originalRows);
  await expect(page.getByText("정렬: 품질 내림차순", { exact: true })).toBeVisible();
  await expect(size(page)).toHaveValue("25");
  for (const path of ["/admin/models", "/admin/models/quality", "/admin/pricing", "/admin/model-tags"])
    expect(modelGateway.reads.filter((call) => call.path === path)).toHaveLength(2);
  expect(
    modelGateway.reads.filter((call) => call.path === "/admin/models").every((call) => call.query === ""),
  ).toBe(true);
  expect(modelGateway.writes).toEqual([]);
});

test("팔레트의 같은 모델 화면 이동은 기본 URL을 열고 뒤로·앞으로는 정렬 상태를 복원한다", async ({
  page,
  modelGateway,
}) => {
  await page.goto("gateway/models?sort=quality_desc&page_size=25&page=2&q=model-");
  await ready(page, 25);
  const originalURL = page.url();
  const originalRows = await links(page).allTextContents();
  expect(modelGateway.reads).toHaveLength(4);

  // Menu destinations intentionally open feature defaults, not a saved filter.
  await paletteCommand(page, "모델");
  await expect.poll(() => new URL(page.url()).pathname).toBe(modelPath);
  await expect.poll(() => new URL(page.url()).search).toBe("");
  await ready(page, 10);
  await expect(size(page)).toHaveValue("10");
  await expect(page.getByText("정렬: 기본 순서 (공급자·모델·출처)", { exact: true })).toBeVisible();
  expect(await links(page).allTextContents()).toEqual(ordinaryIds.slice(0, 10));

  await page.goBack();
  await expect(page).toHaveURL(originalURL);
  await ready(page, 25);
  await expect(size(page)).toHaveValue("25");
  await expect(heading(page, "품질")).toHaveAttribute("aria-sort", "descending");
  expect(await links(page).allTextContents()).toEqual(originalRows);
  await page.goForward();
  await expect.poll(() => new URL(page.url()).search).toBe("");
  await ready(page, 10);
  await page.goBack();
  await expect(page).toHaveURL(originalURL);
  await ready(page, 25);
  expect(await links(page).allTextContents()).toEqual(originalRows);
  expect(modelGateway.reads).toHaveLength(4);
  expect(modelGateway.writes).toEqual([]);
});

test("활성 정렬 열을 숨겨도 한글 현재 정렬과 행 순서를 유지하고 기본 순서로 돌아간다", async ({
  page,
  modelGateway,
}) => {
  await page.goto("gateway/models?sort=quality_desc&page_size=25");
  await ready(page, 25);
  await expect(links(page).first()).toHaveText("z-best");
  const sortedRows = await links(page).allTextContents();
  const originalURL = page.url();
  const settingsTrigger = page.getByRole("button", { name: "열 설정", exact: true });
  await settingsTrigger.click();
  const settings = page.getByRole("dialog", { name: "표 열 설정", exact: true });
  // Checkbox labels include the existing width description, such as '품질 160px'.
  const quality = settings.getByRole("checkbox", { name: /^품질(?:\s|$)/u });
  await expect(quality).toBeChecked();
  await quality.uncheck();
  await expect(quality).not.toBeChecked();
  await settings.getByRole("button", { name: "설정 완료", exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(settingsTrigger).toBeFocused();

  await expect(heading(page, "품질")).toHaveCount(0);
  await expect(page.getByText("정렬: 품질 내림차순", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(originalURL);
  expect(await links(page).allTextContents()).toEqual(sortedRows);
  await page.getByRole("button", { name: "기본 순서", exact: true }).click();
  await expect.poll(() => params(page).get("sort")).toBeNull();
  await expect(page.getByText("정렬: 기본 순서 (공급자·모델·출처)", { exact: true })).toBeVisible();
  await expect(heading(page, "품질")).toHaveCount(0);
  await expect(size(page)).toHaveValue("25");
  expect(await links(page).allTextContents()).toEqual(ordinaryIds.slice(0, 25));
  expect(modelGateway.reads).toHaveLength(4);
  expect(modelGateway.writes).toEqual([]);
});

test("열린 상세의 원래 행이 실제 자동 조회 뒤 사라지면 닫을 때 모델 목록으로 초점을 복귀한다", async ({
  page,
  modelGateway,
}) => {
  await page.clock.install();
  await page.goto("gateway/models");
  await ready(page, 10);
  await page.getByRole("combobox", { name: "자동 새로고침 간격", exact: true }).selectOption("60");
  const trigger = table(page).getByRole("link", { name: "model-09", exact: true });
  const originalTrigger = await trigger.elementHandle();
  if (!originalTrigger) throw new Error("The normal model detail trigger was not mounted");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const detail = page.getByRole("dialog", { name: "model-09", exact: true });
  await expect(detail).toBeVisible();
  expect(modelGateway.reads).toHaveLength(4);

  // Existing synthetic server control plus the public refresh interval: no DOM
  // removal, direct QueryClient access or product navigation internals.
  modelGateway.shrinkToOrdinary(1);
  await page.clock.fastForward(60_001);
  await expect.poll(() => modelGateway.reads.length).toBe(8);
  await expect.poll(() => originalTrigger.evaluate((node) => node.isConnected)).toBe(false);
  await expect(page.locator(".model-list-section tbody [data-model-trigger]")).toHaveCount(1);
  await expect(detail).toBeVisible();
  expect(params(page).get("model")).toBe("model-09");
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(page.getByRole("heading", { name: "모델 목록", exact: true })).toBeFocused();
  await expect(links(page)).toHaveCount(1);
  await expect(links(page).first()).toHaveText("model-00");
  expect(params(page).get("model")).toBeNull();
  expect(
    modelGateway.reads.filter((call) => call.path === "/admin/models").every((call) => call.query === ""),
  ).toBe(true);
  expect(modelGateway.writes).toEqual([]);
  await originalTrigger.dispose();
});

test("390px 다크에서 공급자 한글 정렬과 10·25·50건 선택을 키보드로 조작하고 axe를 유지한다", async ({
  page,
  modelGateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("gateway/models");
  await ready(page, 10);
  const provider = heading(page, "공급자");
  const sortButton = provider.getByRole("button");
  await expect(sortButton).toHaveAccessibleName("공급자 오름차순 정렬");
  await sortButton.focus();
  await page.keyboard.press("Enter");
  await expect(provider).toHaveAttribute("aria-sort", "ascending");
  await expect(page.getByText("정렬: 공급자 오름차순", { exact: true })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(provider).toHaveAttribute("aria-sort", "descending");
  await expect(page.getByText("정렬: 공급자 내림차순", { exact: true })).toBeVisible();
  await expect(links(page).first()).toHaveText("tie-model");

  const select = size(page);
  expect(await select.getByRole("option").allTextContents()).toEqual(["10건", "25건", "50건"]);
  await select.focus();
  for (const [key, value, count] of [
    ["ArrowDown", "25", 25],
    ["ArrowDown", "50", 50],
    ["Home", "10", 10],
  ] as const) {
    await select.press(key);
    await select.press("Enter");
    await expect(select).toHaveValue(value);
    await expect(links(page)).toHaveCount(count);
    await expect(select).toBeFocused();
    const box = await select.boundingBox();
    if (!box) throw new Error("The page-size selector has no visible box");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(params(page).get("page_size")).toBeNull();
  expect(params(page).get("sort")).toBe("provider_desc");
  await expect(page.getByText("정렬: 공급자 내림차순", { exact: true })).toBeVisible();
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as { axe: { run: (root: Document) => Promise<{ violations: unknown[] }> } }
    ).axe;
    return (await axe.run(document)).violations;
  });
  expect(violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("model-catalog-boundaries-390-dark.png"), fullPage: true });
  expect(modelGateway.reads).toHaveLength(4);
  expect(modelGateway.writes).toEqual([]);
});
