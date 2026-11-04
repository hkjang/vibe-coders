import { expect, type Download, type Page } from "@playwright/test";
import { ordinaryNames, test } from "../fixtures/provider-catalog-sorting-gateway";

async function ready(page: Page, query = "") {
  await page.goto("gateway/providers" + query);
  await expect(page.getByRole("table", { name: "공급자 연결 설정과 운영 상태" })).toBeVisible();
  await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
}
async function csv(download: Download) {
  expect(download.suggestedFilename()).toBe("공급자-목록.csv");
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Missing synthetic download");
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let text = "";
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new Error("Unexpected download chunk");
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
async function refreshIdentity(page: Page) {
  const reply = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admin/ui-bootstrap",
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await reply).finished();
}
test("읽기 전용 공급자의 필터·정렬 전체 결과를 현재 페이지와 무관하게 내보낸다", async ({
  page,
  providerGateway,
}) => {
  await ready(page, "?q=provider-&sort=name_desc&page=3&range=7d");
  await expect(page.getByRole("button", { name: "공급자 추가" })).toBeDisabled();
  const result = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기", exact: true }).click();
  const text = await csv(await result);
  expect(text.startsWith("\uFEFF공급자,")).toBe(true);
  // This fixture has no commas/newlines in public values; general quoting is unit-tested.
  const rows = text
    .slice(1)
    .trim()
    .split("\r\n")
    .slice(1)
    .map((line) => line.split(","));
  expect(rows.map((row) => row[0])).toEqual([...ordinaryNames].reverse());
  expect(rows.every((row) => row.at(-2) === "7d")).toBe(true);
  expect(rows.every((row) => /^\d{4}-\d{2}-\d{2}T.*Z$/u.test(row.at(-1) ?? ""))).toBe(true);
  expect(providerGateway.reads).toHaveLength(4);
  expect(new URL(page.url()).searchParams.get("page")).toBe("3");
});
test("내보내기는 이전 화면 캐시가 아닌 새 조회 결과를 사용한다", async ({ page, providerGateway }) => {
  await ready(page);
  providerGateway.shrink(3);
  const result = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  const text = await csv(await result);
  expect(text.trim().split("\r\n")).toHaveLength(4);
  expect(text).not.toContain("provider-03");
  await expect(page.getByText("3개 공급자의 CSV 다운로드를 요청했습니다.")).toBeVisible();
});
test("다운로드한 CSV에서도 URL 자격정보를 제거하고 수식을 무력화한다", async ({ page, providerGateway }) => {
  providerGateway.replace([
    {
      name: "공개 마스킹 공급자",
      provider_ref: "prv_" + "x".repeat(43),
      base_url:
        "https://public-user:public-password@public.example.invalid/v1?api_key=private-value#fragment",
      model_patterns: "  =2+2",
      failover_group: "public",
      enabled: true,
      priority: 1,
      timeout_ms: 0,
      api_key_configured: true,
      created_at: "2026-10-14T00:00:00Z",
    },
  ]);
  await ready(page);
  const result = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  const text = await csv(await result);
  for (const value of ["public-user", "public-password", "private-value", "fragment"])
    expect(text).not.toContain(value);
  expect(text).toContain(",'  =2+2,");
  expect(text).toContain(",0,");
});
test("실패한 운영 조회로 파일을 만들지 않고 명시적 재시도만 허용한다", async ({ page, providerGateway }) => {
  await ready(page);
  providerGateway.failSlo(true);
  const downloads: Download[] = [];
  page.on("download", (item) => downloads.push(item));
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  await expect(page.getByRole("region", { name: "공급자 목록 내보내기" }).getByRole("alert")).toBeVisible();
  expect(downloads).toHaveLength(0);
  providerGateway.failSlo(false);
  const result = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  await csv(await result);
  expect(downloads).toHaveLength(1);
});
for (const change of ["owner", "scope", "filter"] as const) {
  test(`${change} 변경 중 보류한 내보내기는 늦은 응답으로 파일을 생성하지 않는다`, async ({
    page,
    providerGateway,
  }) => {
    await ready(page);
    providerGateway.holdProviderRead(2);
    const downloads: Download[] = [];
    page.on("download", (item) => downloads.push(item));
    const cancelled = page.waitForEvent("requestfailed", {
      predicate: (request) => new URL(request.url()).pathname === "/admin/providers",
    });
    await page.getByRole("button", { name: "CSV 내보내기" }).click();
    await expect
      .poll(() => providerGateway.reads.filter((item) => item.path === "/admin/providers").length)
      .toBe(2);
    if (change === "filter") await page.getByRole("combobox", { name: /^상태/u }).selectOption("disabled");
    else {
      if (change === "owner") providerGateway.owner("public-new-owner");
      else providerGateway.scopes([]);
      await refreshIdentity(page);
    }
    // Observe the abort before releasing the held response. Otherwise response
    // completion can race the browser's requestfailed event after navigation.
    await cancelled;
    providerGateway.releaseProviderRead(2);
    await expect(page.getByRole("button", { name: "내보낼 목록 조회 중" })).toHaveCount(0);
    if (change !== "scope") {
      // A new completed read is a deterministic completion barrier, not a sleep.
      if (change === "filter") await page.getByRole("combobox", { name: /^상태/u }).selectOption("all");
      const next = page.waitForEvent("download");
      await page.getByRole("button", { name: "CSV 내보내기" }).click();
      await csv(await next);
      expect(downloads).toHaveLength(1);
    } else expect(downloads).toHaveLength(0);
  });
}
test("모바일 내보내기 버튼과 안내는 키보드로 조작 가능하다", async ({ page, providerGateway }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await ready(page);
  providerGateway.shrink(1);
  const button = page.getByRole("button", { name: "CSV 내보내기" });
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport();
  await button.focus();
  const result = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  await csv(await result);
  await expect(button).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(
    await page.evaluate(async () => {
      const axe = (
        window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
      ).axe;
      return (await axe.run(document)).violations.map((violation) => violation.id);
    }),
  ).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("provider-csv-mobile.png") });
});
