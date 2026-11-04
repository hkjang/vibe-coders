import { expect, type Download, type Page } from "@playwright/test";
import { test } from "../fixtures/model-catalog-sorting-gateway";

const table = (page: Page) => page.getByRole("table", { name: "공급자별 모델 상태, 품질과 가격" });
async function ready(page: Page) {
  await expect(table(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
}
async function rows(download: Download) {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Missing synthetic CSV");
  let result = "";
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new Error("Unexpected synthetic CSV chunk");
    result += decoder.decode(chunk, { stream: true });
  }
  return (result + decoder.decode())
    .trimEnd()
    .split("\r\n")
    .slice(1)
    .map((line) => line.split(",")[0]);
}
test("다중 기준은 전체 목록을 정렬하고 주소·새로고침·CSV에서 같은 순서를 유지한다", async ({
  page,
  modelGateway,
}) => {
  await page.goto("gateway/models?sort=model_desc&page=2&page_size=25");
  await ready(page);
  const trigger = page.getByRole("button", { name: "다중 정렬", exact: true });
  await trigger.click();
  await page.getByRole("combobox", { name: "1순위 정렬 열" }).selectOption("quality");
  await page.getByRole("combobox", { name: "1순위 정렬 방향" }).selectOption("desc");
  await page.getByRole("button", { name: "정렬 기준 추가" }).click();
  await page.getByRole("combobox", { name: "2순위 정렬 열" }).selectOption("input-price");
  await page.getByRole("combobox", { name: "2순위 정렬 방향" }).selectOption("asc");
  await page.getByRole("button", { name: "정렬 적용" }).click();
  await expect(trigger).toBeFocused();
  await expect.poll(() => new URL(page.url()).searchParams.get("sort")).toBe("quality_desc,input_price_asc");
  expect(new URL(page.url()).searchParams.get("page")).toBeNull();
  expect(new URL(page.url()).searchParams.get("page_size")).toBe("25");
  expect((await table(page).getByRole("link").allTextContents()).slice(0, 6)).toEqual([
    "z-best",
    "signal-eval-only",
    "tie-model",
    "tie-model",
    "tie-model",
    "z-free",
  ]);
  expect(modelGateway.reads).toHaveLength(4);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("sort")).toBe("model_desc");
  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.get("sort")).toBe("quality_desc,input_price_asc");
  await page.reload();
  await ready(page);
  await expect(
    page.getByRole("status").filter({ hasText: "품질 내림차순 → 입력 가격 오름차순" }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  const exported = await rows(await download);
  expect(exported).toHaveLength(61);
  expect(exported.slice(0, 25)).toEqual(await table(page).getByRole("link").allTextContents());
  expect(modelGateway.reads).toHaveLength(12);
  await table(page).getByRole("columnheader").filter({ hasText: "품질" }).getByRole("button").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("sort")).toBe("quality_asc");
});
test("390px 다크 설정에서 키보드 이동·삭제·취소와 초점·접근성을 지킨다", async ({
  page,
  modelGateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("models?sort=quality_desc,input_price_asc");
  await ready(page);
  const trigger = page.getByRole("button", { name: "다중 정렬", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "다중 정렬 설정" });
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "2순위 기준을 위로 이동" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox", { name: "1순위 정렬 열" })).toBeFocused();
  await expect(page.getByRole("combobox", { name: "1순위 정렬 열" })).toHaveValue("input-price");
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  expect(
    await page.evaluate(
      async () =>
        (
          await (
            window as unknown as { axe: { run: (root: Document) => Promise<{ violations: unknown[] }> } }
          ).axe.run(document)
        ).violations,
    ),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("model-multi-sort-mobile.png") });
  for (let index = 0; index < 4; index++) {
    await page.getByRole("button", { name: "정렬 기준 추가" }).click();
  }
  await expect(dialog.getByRole("group")).toHaveCount(6);
  await expect(page.getByRole("button", { name: "정렬 기준 추가" })).toBeDisabled();
  const applyBox = await page.getByRole("button", { name: "정렬 적용" }).boundingBox();
  if (!applyBox) throw new Error("Missing visible apply action");
  expect(applyBox.y).toBeGreaterThanOrEqual(0);
  expect(applyBox.y + applyBox.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: info.outputPath("model-multi-sort-six-criteria.png") });
  await page.getByRole("button", { name: "1순위 기준 삭제" }).click();
  await expect(page.getByRole("combobox", { name: "1순위 정렬 열" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect(new URL(page.url()).searchParams.get("sort")).toBe("quality_desc,input_price_asc");
  expect(modelGateway.reads).toHaveLength(4);
});
test("잘못된 다중 정렬은 제거하고 정상 필터와 크기는 보존한다", async ({ page, modelGateway }) => {
  await page.goto("gateway/models?sort=quality_desc,quality_asc&q=model-&page_size=25");
  await ready(page);
  expect(new URL(page.url()).searchParams.get("sort")).toBeNull();
  expect(new URL(page.url()).searchParams.get("q")).toBe("model-");
  expect(new URL(page.url()).searchParams.get("page_size")).toBe("25");
  await expect(table(page).getByRole("link").first()).toHaveText("model-00");
  expect(modelGateway.reads).toHaveLength(4);
});
