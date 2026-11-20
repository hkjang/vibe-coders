import { expect, type Locator } from "@playwright/test";

/** Check painted text after ancestor clipping, rather than only the cell box. */
export async function expectCellBoundaries(table: Locator) {
  const violations = await table.locator("tbody td").evaluateAll((cells) => {
    const failures: string[] = [];
    for (const cell of cells) {
      const box = cell.getBoundingClientRect(),
        style = getComputedStyle(cell);
      const left = box.left + parseFloat(style.paddingLeft);
      const right = box.right - parseFloat(style.paddingRight);
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!node.textContent?.trim() || !parent || parent.closest('.sr-only,[aria-hidden="true"],svg'))
          continue;
        if (!parent.checkVisibility({ checkVisibilityCSS: true })) continue;
        let clipLeft = -Infinity,
          clipRight = Infinity;
        for (
          let ancestor: HTMLElement | null = parent;
          ancestor && ancestor !== cell && cell.contains(ancestor);
          ancestor = ancestor.parentElement
        ) {
          const css = getComputedStyle(ancestor);
          if (css.display !== "inline" && ["hidden", "clip", "auto", "scroll"].includes(css.overflowX)) {
            const bounds = ancestor.getBoundingClientRect();
            clipLeft = Math.max(clipLeft, bounds.left);
            clipRight = Math.min(clipRight, bounds.right);
          }
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          const paintedLeft = Math.max(rect.left, clipLeft),
            paintedRight = Math.min(rect.right, clipRight);
          if (paintedRight > paintedLeft && (paintedLeft < left - 1 || paintedRight > right + 1))
            failures.push(`${node.textContent.slice(0, 45)}: ${paintedLeft - left}/${paintedRight - right}`);
        }
      }
    }
    return failures;
  });
  expect(violations, "표의 글자가 셀 안쪽 여백과 옆 열을 침범해서는 안 됩니다").toEqual([]);
}
