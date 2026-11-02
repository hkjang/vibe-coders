import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/model-catalog-sorting-gateway";

async function watchHistory(page: Page, candidate: string) {
  await page.addInitScript((value) => {
    const variants = [value];
    for (let index = 0; index < 4; index++) variants.push(encodeURIComponent(variants.at(-1) ?? value));
    const result = window as unknown as { modelSearchReachedHistory: boolean };
    result.modelSearchReachedHistory = false;
    const inspect = (url: string | URL | null | undefined) => {
      if (url && variants.some((item) => String(url).includes(item))) result.modelSearchReachedHistory = true;
    };
    const push = window.history.pushState;
    const replace = window.history.replaceState;
    window.history.pushState = function (data, unused, url) {
      inspect(url);
      return push.call(this, data, unused, url);
    };
    window.history.replaceState = function (data, unused, url) {
      inspect(url);
      return replace.call(this, data, unused, url);
    };
  }, candidate);
}

for (const [label, prefix, candidate] of [
  ["설정 접두사", "corp_", "corp_" + "a".repeat(32)],
  ["인코딩 접두사", "%41_", "%2541_" + "b".repeat(32)],
  ["한글 접두사", "조직_", encodeURIComponent(encodeURIComponent("조직_" + "c".repeat(32)))],
]) {
  test(`${label}: 모델 검색을 주소·기록에 쓰기 전에 차단하고 일반 검색으로 복구한다`, async ({
    page,
    modelGateway,
  }) => {
    if (!prefix || !candidate) throw new Error("Missing synthetic credential case");
    modelGateway.prefixes([prefix]);
    await watchHistory(page, candidate);
    await page.goto("gateway/models?sort=model_desc&page_size=25");
    await expect(page.getByRole("table", { name: "공급자별 모델 상태, 품질과 가격" })).toBeVisible();
    const original = page.url();
    const input = page.getByRole("textbox", { name: "모델 검색" });
    await input.fill(candidate);
    await input.press("Enter");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toBeFocused();
    await expect(page.getByRole("alert").filter({ hasText: "인증정보로 보이는 검색어" })).toBeVisible();
    await expect(page).toHaveURL(original);
    expect(
      await page.evaluate(
        () => (window as unknown as { modelSearchReachedHistory: boolean }).modelSearchReachedHistory,
      ),
    ).toBe(false);
    await input.fill("model-");
    await input.press("Enter");
    await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("model-");
    await expect(input).not.toHaveAttribute("aria-invalid", "true");
    expect(new URL(page.url()).searchParams.get("sort")).toBe("model_desc");
    expect(new URL(page.url()).searchParams.get("page_size")).toBe("25");
    expect(
      await page.evaluate(
        () => (window as unknown as { modelSearchReachedHistory: boolean }).modelSearchReachedHistory,
      ),
    ).toBe(false);
    expect(modelGateway.reads).toHaveLength(4);
  });
}
