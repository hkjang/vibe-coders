import { expect, type Page } from "@playwright/test";
import {
  test,
  targetUrl,
  firstId,
  email,
  rootName,
  toolName,
  rootSpan,
  toolSpan,
  traceResult,
} from "../fixtures/request-flow-safety-gateway";

// Real embedded UI and browser, synthetic HTTP data. Server authorization and
// masking are retained, not proven by this fixture. No causal timing inference.
const sheet = (page: Page) => page.getByRole("dialog", { name: "LLM 호출 상세", exact: true });
const card = (page: Page) =>
  sheet(page).getByRole("heading", { name: "처리 흐름", exact: true }).locator("xpath=ancestor::section[1]");
async function open(page: Page) {
  await page.goto(`login?return_to=${encodeURIComponent(targetUrl)}`);
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByLabel("사용자 메뉴")).toBeVisible();
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
  await page.getByRole("button", { name: `${firstId} 호출 상세 열기`, exact: true }).click();
  await sheet(page).getByRole("button", { name: "원인 설명 열기", exact: true }).click();
  await expect(card(page).getByText(toolName, { exact: true })).toBeVisible();
}

test("키보드로 보기 전환과 하위 기록 접기를 수행하고 새로고침 후 초점과 접힘을 유지한다", async ({
  page,
  gateway,
}) => {
  await open(page);
  const hierarchy = card(page).getByRole("button", { name: "기록 관계", exact: true });
  await hierarchy.focus();
  await page.keyboard.press("Enter");
  await expect(hierarchy).toBeFocused();
  await expect(hierarchy).toHaveAttribute("aria-pressed", "true");
  const summary = card(page).locator("summary").filter({ hasText: "하위 기록 1개" });
  await page.keyboard.press("Tab");
  await expect(summary).toBeFocused();
  await page.keyboard.press("Space");
  await expect(card(page).getByText(toolName, { exact: true })).toBeHidden();
  expect(gateway.count("trace")).toBe(1);
  gateway.hold("trace", 2);
  await card(page).getByRole("button", { name: "처리 흐름 다시 조회", exact: true }).click();
  await expect.poll(() => gateway.count("trace")).toBe(2);
  await summary.focus();
  gateway.release("trace", 2);
  await expect.poll(() => gateway.finished.has("trace:2")).toBe(true);
  await expect(summary).toBeFocused();
  await expect(card(page).getByText(toolName, { exact: true })).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(card(page).getByText(toolName, { exact: true })).toBeVisible();
  await card(page).getByRole("button", { name: "흐름 막대", exact: true }).click();
  await expect(card(page).getByRole("list", { name: "요청 스팬 흐름" })).toBeVisible();
  expect(gateway.count("links")).toBe(1);
});

test("중복·누락·순환 기록을 버리지 않고 민감한 식별자나 오류를 노출하지 않는다", async ({
  page,
  gateway,
}) => {
  const secret = "vc_sk_hierarchy-private-example";
  gateway.setReply("trace", {
    body: traceResult({
      spans: [
        rootSpan(),
        toolSpan(),
        toolSpan({ span_id: "same", parent_span_id: "missing", name: "중복 하나" }),
        toolSpan({ span_id: "same", name: "중복 둘" }),
        toolSpan({ span_id: "a", parent_span_id: "b", name: "순환 하나" }),
        toolSpan({ span_id: "b", parent_span_id: "a", name: "순환 둘" }),
        toolSpan({ span_id: secret, name: secret, error: secret }),
      ],
    }),
  });
  await open(page);
  await card(page).getByRole("button", { name: "기록 관계", exact: true }).click();
  const tree = card(page).getByRole("list", { name: "요청 기록 관계" });
  await expect(tree.getByRole("listitem")).toHaveCount(7);
  await expect(tree.getByText(/순환 관계가 있어/u)).toHaveCount(2);
  await expect(tree.getByText(rootName, { exact: true })).toBeVisible();
  expect(await tree.evaluate((element) => element.outerHTML)).not.toContain(secret);
  expect(page.url()).not.toContain(secret);
  expect(
    await page.evaluate(
      (marker) =>
        [localStorage, sessionStorage].every((storage) =>
          Object.values(storage).every((value) => !String(value).includes(marker)),
        ),
      secret,
    ),
  ).toBe(true);
  expect(gateway.count("trace")).toBe(1);
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 기록 관계의 대비·키보드 구조·가로 넘침·화면 기준`, async ({
      page,
      gateway,
    }) => {
      await page.setViewportSize({ width, height: 1100 });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      gateway.setReply("trace", {
        body: traceResult({
          spans: [
            rootSpan(),
            toolSpan(),
            ...Array.from({ length: 7 }, (_, index) =>
              toolSpan({
                span_id: `nested-${index}`,
                parent_span_id: index ? `nested-${index - 1}` : "span:tool:public-tool",
                name: `하위 처리 ${index + 1}`,
              }),
            ),
          ],
        }),
      });
      await open(page);
      await card(page).getByRole("button", { name: "기록 관계", exact: true }).click();
      await expect(
        card(page).getByRole("list", { name: "요청 기록 관계" }).getByRole("listitem"),
      ).toHaveCount(9);
      expect(await sheet(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
        true,
      );
      expect(await card(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
        true,
      );
      // The card is taller than its scrolling sheet. Capture the viewport and
      // the lower records separately instead of a clipped, blank-padded image.
      await card(page).evaluate((element) => element.scrollIntoView({ block: "start" }));
      await expect(sheet(page)).toHaveScreenshot(`request-record-tree-${theme}-${width}.png`, {
        animations: "disabled",
      });
      await card(page).getByText("하위 처리 7", { exact: true }).scrollIntoViewIfNeeded();
      await expect(card(page).getByText("하위 처리 7", { exact: true })).toBeVisible();
      await expect(sheet(page)).toHaveScreenshot(`request-record-tree-lower-${theme}-${width}.png`, {
        animations: "disabled",
      });
      const violations = await page.evaluate(async () => {
        const axe = (
          window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
        ).axe;
        return (await axe.run(document)).violations.map((item) => item.id);
      });
      expect(violations).toEqual([]);
      expect(gateway.count("trace")).toBe(1);
    });
  }
}
