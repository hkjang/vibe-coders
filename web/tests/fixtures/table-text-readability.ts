import { expect, type Locator } from "@playwright/test";

/** Measure actual text nodes, including badges and nested code, not just cells. */
export async function expectReadableTableText(table: Locator) {
  const measure = () =>
    table.evaluate((element) => {
      const minimum = (parseFloat(getComputedStyle(document.documentElement).fontSize) * 13) / 16;
      const texts: Array<{ text: string; size: number }> = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        const text = node.textContent?.trim();
        if (!parent || !text || parent.closest('.sr-only, [aria-hidden="true"], svg')) continue;
        if (!parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        texts.push({ text: text.slice(0, 80), size: parseFloat(getComputedStyle(parent).fontSize) });
      }
      return { minimum, texts };
    });
  // Dialog entrance transitions may briefly make all descendants transparent.
  await expect
    .poll(async () => (await measure()).texts.length, {
      message: "표의 실제 표시 문구를 검사해야 합니다",
    })
    .toBeGreaterThan(0);
  const measured = await measure();
  expect(
    measured.texts.filter(({ size }) => size < measured.minimum - 0.01),
    "상태·식별자·설명도 기본 13px와 사용자의 글자 확대 설정을 따라야 합니다",
  ).toEqual([]);
  return measured;
}
