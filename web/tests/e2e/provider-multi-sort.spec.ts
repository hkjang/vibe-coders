import { expect, type Download, type Page } from "@playwright/test";
import { test } from "../fixtures/provider-catalog-sorting-gateway";

const table = (page: Page) => page.getByRole("table", { name: "공급자 연결 설정과 운영 상태" });
async function ready(page: Page) {
  await expect(table(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
}
async function csvRows(download: Download) {
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

test("다중 정렬은 전체 공급자 목록·주소 복원·CSV에 같은 순서로 적용된다", async ({
  page,
  providerGateway,
}) => {
  await page.goto("gateway/providers?sort=name_desc&page=2&page_size=25");
  await ready(page);
  const trigger = page.getByRole("button", { name: "다중 정렬", exact: true });
  await trigger.click();
  await page.getByRole("combobox", { name: "1순위 정렬 열" }).selectOption("failover");
  await page.getByRole("combobox", { name: "1순위 정렬 방향" }).selectOption("desc");
  await page.getByRole("button", { name: "정렬 기준 추가" }).click();
  await page.getByRole("combobox", { name: "2순위 정렬 열" }).selectOption("timeout");
  await page.getByRole("combobox", { name: "2순위 정렬 방향" }).selectOption("asc");
  expect(new URL(page.url()).searchParams.get("sort")).toBe("name_desc");
  await page.getByRole("button", { name: "정렬 적용" }).click();
  await expect(trigger).toBeFocused();
  await expect.poll(() => new URL(page.url()).searchParams.get("sort")).toBe("priority_desc,timeout_asc");
  expect(new URL(page.url()).searchParams.get("page")).toBeNull();
  expect(new URL(page.url()).searchParams.get("page_size")).toBe("25");
  expect((await table(page).getByRole("link").allTextContents()).slice(0, 2)).toEqual([
    "z-late-zero",
    "a-late-slow",
  ]);
  expect(providerGateway.reads).toHaveLength(2);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("sort")).toBe("name_desc");
  await page.goForward();
  await page.reload();
  await ready(page);
  await expect(
    page.getByRole("status").filter({ hasText: "우선순위 내림차순 → 제한 시간 오름차순" }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  const rows = await csvRows(await download);
  expect(rows).toHaveLength(61);
  expect(rows.slice(0, 25)).toEqual(await table(page).getByRole("link").allTextContents());
  expect(providerGateway.reads).toHaveLength(6);
  await page.getByRole("button", { name: "우선순위 오름차순 정렬", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("sort")).toBe("priority_asc");
});

test("390px 다크에서 세 기준과 적용 버튼이 보이고 키보드 초점·취소·접근성을 지킨다", async ({
  page,
  providerGateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("providers?sort=priority_desc,timeout_asc,name_asc");
  await ready(page);
  const trigger = page.getByRole("button", { name: "다중 정렬", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "다중 정렬 설정" });
  await expect(dialog.getByRole("group")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "정렬 기준 추가" })).toBeDisabled();
  await page.getByRole("button", { name: "2순위 기준을 위로 이동" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox", { name: "1순위 정렬 열" })).toBeFocused();
  await expect(page.getByRole("combobox", { name: "1순위 정렬 열" })).toHaveValue("timeout");
  const box = await page.getByRole("button", { name: "정렬 적용" }).boundingBox();
  if (!box) throw new Error("Missing apply action");
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
  await page.screenshot({ path: info.outputPath("provider-multi-sort-mobile.png") });
  await page.getByRole("button", { name: "1순위 기준 삭제" }).click();
  await expect(page.getByRole("combobox", { name: "1순위 정렬 열" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect(new URL(page.url()).searchParams.get("sort")).toBe("priority_desc,timeout_asc,name_asc");
  expect(providerGateway.reads).toHaveLength(2);
});

test("잘못된 다중 정렬만 제거하고 정상 검색·표 크기는 보존한다", async ({ page, providerGateway }) => {
  await page.goto("gateway/providers?sort=priority_desc,priority_asc&q=provider-&page_size=25");
  await ready(page);
  expect(new URL(page.url()).searchParams.get("sort")).toBeNull();
  expect(new URL(page.url()).searchParams.get("q")).toBe("provider-");
  expect(new URL(page.url()).searchParams.get("page_size")).toBe("25");
  expect(providerGateway.reads).toHaveLength(2);
});

test("대기 중인 CSV는 정렬 변경으로 취소되어 이전 순서 파일을 내려주지 않는다", async ({
  page,
  providerGateway,
}) => {
  await page.goto("gateway/providers?sort=priority_desc,timeout_asc");
  await ready(page);
  providerGateway.holdProviderRead(2);
  const downloads: Download[] = [];
  page.on("download", (item) => downloads.push(item));
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  await expect.poll(() => providerGateway.reads.length).toBe(4);
  await page.getByRole("button", { name: "다중 정렬", exact: true }).click();
  await page.getByRole("button", { name: "2순위 기준을 위로 이동" }).click();
  await page.getByRole("button", { name: "정렬 적용" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("sort")).toBe("timeout_asc,priority_desc");
  await expect(page.getByRole("button", { name: "CSV 내보내기" })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  providerGateway.releaseProviderRead(2);
  const result = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  const rows = await csvRows(await result);
  expect(rows.slice(0, 10)).toEqual(await table(page).getByRole("link").allTextContents());
  expect(downloads).toHaveLength(1);
  expect(providerGateway.reads).toHaveLength(6);
});
