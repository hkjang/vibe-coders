import { expect, type Page } from "@playwright/test";
import { ordinaryNames, privateRefs, providerPath, test } from "../fixtures/provider-catalog-sorting-gateway";

const table = (page: Page) => page.getByRole("table", { name: "공급자 연결 설정과 운영 상태" });
const links = (page: Page) => table(page).getByRole("link");
const size = (page: Page) => page.getByRole("combobox", { name: "페이지당 표시 건수", exact: true });
const params = (page: Page) => new URL(page.url()).searchParams;
async function ready(page: Page, count: number) {
  await expect(links(page)).toHaveCount(count);
  await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
  await expect(table(page).getByText("확인 중", { exact: true })).toHaveCount(0);
}

test("수신 전체 목록을 정렬한 뒤 표시하며 유효한 제한 시간 0을 보존한다", async ({
  page,
  providerGateway,
}) => {
  await page.goto("gateway/providers?page=3");
  await ready(page, 10);
  await expect(links(page)).toHaveText(ordinaryNames.slice(20, 30));
  await page.getByRole("button", { name: "제한 시간 오름차순 정렬", exact: true }).click();
  await expect(links(page).first()).toHaveText("z-late-zero");
  await expect(table(page).getByRole("cell", { name: "0 ms", exact: true })).toBeVisible();
  expect(params(page).get("page")).toBeNull();
  await page.getByRole("button", { name: "제한 시간 내림차순 정렬", exact: true }).click();
  await expect(links(page).first()).toHaveText("a-late-slow");
  await expect(page.getByText(/화면 정렬은 라우팅 우선순위 설정을 변경하지 않습니다/)).toBeVisible();
  await expect(page.getByRole("button", { name: "공급자 추가", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "기본 순서", exact: true }).click();
  await expect(links(page)).toHaveText(ordinaryNames.slice(0, 10));
  expect(providerGateway.reads).toHaveLength(2);
});

test("10·25·50건 선택과 페이지 이동은 로컬이며 전환 완료 뒤 전체 행을 대조한다", async ({
  page,
  providerGateway,
}) => {
  await page.goto("gateway/providers");
  await ready(page, 10);
  await size(page).selectOption("25");
  await expect(links(page)).toHaveText(ordinaryNames.slice(0, 25));
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(links(page)).toHaveText(ordinaryNames.slice(25, 50));
  await expect(page.getByText("61개 결과 · 수신 61개 중 26–50번째 결과 표시", { exact: true })).toBeVisible();
  await size(page).selectOption("50");
  await expect(links(page)).toHaveText(ordinaryNames.slice(0, 50));
  expect(params(page).get("page")).toBeNull();
  await size(page).selectOption("10");
  await expect(links(page)).toHaveText(ordinaryNames.slice(0, 10));
  expect(params(page).get("page_size")).toBeNull();
  expect(providerGateway.reads).toHaveLength(2);
});

test("호환 주소와 새로고침·뒤로·앞으로에서 정렬과 표시 건수를 복원한다", async ({
  page,
  providerGateway,
}) => {
  await page.goto("providers?sort=timeout_desc&page_size=25&page=2");
  await ready(page, 25);
  await expect(links(page)).toHaveText(ordinaryNames.slice(24, 49));
  expect(new URL(page.url()).pathname).toBe(providerPath);
  await size(page).selectOption("50");
  await expect(links(page)).toHaveCount(50);
  await page.getByRole("button", { name: "공급자 오름차순 정렬", exact: true }).click();
  await expect.poll(() => params(page).get("sort")).toBe("name_asc");
  await page.goBack();
  await expect.poll(() => params(page).get("sort")).toBe("timeout_desc");
  await expect(size(page)).toHaveValue("50");
  await page.goBack();
  await expect(links(page)).toHaveText(ordinaryNames.slice(24, 49));
  await expect(size(page)).toHaveValue("25");
  await page.goForward();
  await expect(size(page)).toHaveValue("50");
  await page.goBack();
  expect(providerGateway.reads).toHaveLength(2);
  await page.reload();
  await ready(page, 25);
  await expect(links(page)).toHaveText(ordinaryNames.slice(24, 49));
  expect(params(page).get("page")).toBe("2");
  expect(providerGateway.reads).toHaveLength(4);
});

test("동점인 비공개 공급자를 불투명 참조로 구분하고 원래 링크에 초점을 복원한다", async ({
  page,
  providerGateway,
}) => {
  await page.goto("gateway/providers?sort=priority_desc");
  await ready(page, 10);
  await expect(links(page).nth(0)).toHaveText("a-late-slow");
  await expect(links(page).nth(1)).toHaveText("z-late-zero");
  for (const ref of privateRefs) {
    const trigger = table(page).locator(`[data-provider-trigger="${ref}"]`);
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(params(page).get("provider")).toBe(ref);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  expect(providerGateway.reads).toHaveLength(2);
});

test("새 목록이 짧아지면 페이지를 보정하고 사라진 상세 링크 대신 목록 제목으로 복귀한다", async ({
  page,
  providerGateway,
}) => {
  await page.goto("gateway/providers?page=3");
  await ready(page, 10);
  await links(page).first().click();
  await expect(page.getByRole("dialog", { name: "provider-20", exact: true })).toBeVisible();
  providerGateway.shrink(11);
  // Exercise refresh/drawer coordination, not pointer reachability through a modal.
  await page
    .getByRole("button", { name: "새로고침", exact: true, includeHidden: true })
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect.poll(() => providerGateway.reads.length).toBe(4);
  await expect.poll(() => params(page).get("page")).toBe("2");
  await expect(
    page.getByRole("dialog").getByText("현재 목록에 요청한 공급자가 없습니다.", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "공급자 목록", exact: true })).toBeFocused();
  await expect(links(page)).toHaveText(["provider-10"]);
  expect(
    providerGateway.reads
      .filter((call) => call.path === "/admin/providers")
      .every((call) => call.query === ""),
  ).toBe(true);
});

test("390px 다크에서 한글 정렬·건수 선택을 키보드로 조작하고 axe와 가로 경계를 지킨다", async ({
  page,
  providerGateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("gateway/providers");
  await ready(page, 10);
  const sort = page.getByRole("button", { name: "공급자 오름차순 정렬", exact: true });
  await sort.focus();
  await page.keyboard.press("Enter");
  await expect(table(page).getByRole("columnheader").filter({ hasText: "공급자" })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await expect(page.getByText("정렬: 공급자 오름차순", { exact: true })).toBeVisible();
  const select = size(page);
  await select.focus();
  await select.press("ArrowDown");
  await select.press("Enter");
  await expect(select).toHaveValue("25");
  await expect(links(page)).toHaveCount(25);
  await expect(select).toBeFocused();
  const box = await select.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as { axe: { run: (root: Document) => Promise<{ violations: unknown[] }> } }
    ).axe;
    return (await axe.run(document)).violations;
  });
  expect(violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("provider-catalog-390-dark.png"), fullPage: true });
  expect(providerGateway.reads).toHaveLength(2);
});
