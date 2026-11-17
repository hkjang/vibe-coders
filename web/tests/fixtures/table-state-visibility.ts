import { expect, type Locator } from "@playwright/test";

export async function visibleState(shell: Locator, fraction: number) {
  const scroll = shell.locator(".data-table-scroll");
  await scroll.evaluate((node, value) => {
    node.scrollLeft = (node.scrollWidth - node.clientWidth) * value;
  }, fraction);
  // Measure actual text fragments, not the wide colspan cell. No locator action
  // may scroll the message back into view and conceal the original defect.
  await expect
    .poll(async () =>
      shell.evaluate((node) => {
        const viewport = node.querySelector(".data-table-scroll"),
          cell = node.querySelector(".data-table-state");
        if (!viewport || !cell) return false;
        const bounds = viewport.getBoundingClientRect();
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        let text: Node | null,
          fragments = 0;
        while ((text = walker.nextNode())) {
          if (!text.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(text);
          for (const rect of range.getClientRects()) {
            fragments++;
            if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) return false;
          }
        }
        return fragments > 0;
      }),
    )
    .toBe(true);
}
