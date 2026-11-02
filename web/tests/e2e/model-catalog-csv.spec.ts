import { expect, type Download, type Page } from "@playwright/test";
import { test } from "../fixtures/model-catalog-sorting-gateway";

async function ready(page: Page, query = "") {
  await page.goto("gateway/models" + query);
  await expect(page.getByRole("table", { name: "공급자별 모델 상태, 품질과 가격" })).toBeVisible();
  await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
}
async function csv(download: Download) {
  expect(download.suggestedFilename()).toBe("모델-목록.csv");
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
test("가격 503 뒤 모델 403이 도착해도 이전 목록을 숨긴다", async ({ page, modelGateway }) => {
  await ready(page);
  modelGateway.holdModelRead(2);
  modelGateway.pricingStatus(503);
  modelGateway.status(403);
  const downloads: Download[] = [];
  page.on("download", (download) => downloads.push(download));
  const unavailable = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admin/pricing" && response.status() === 503,
  );
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  await (await unavailable).finished();
  await expect(page.getByRole("button", { name: "내보낼 모델 조회 중" })).toBeVisible();
  modelGateway.releaseModelRead(2);
  await expect(page.getByRole("heading", { name: "모델 조회 권한 확인 필요" })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  expect(downloads).toHaveLength(0);
  expect(modelGateway.reads).toHaveLength(8);
});
test("읽기 전용 모델 목록의 필터·정렬 전체 결과를 현재 페이지와 무관하게 내보낸다", async ({
  page,
  modelGateway,
}) => {
  await ready(page, "?q=model-&sort=model_desc&page=2&page_size=25");
  const downloaded = page.waitForEvent("download");
  const button = page.getByRole("button", { name: "CSV 내보내기" });
  await button.focus();
  await page.keyboard.press("Enter");
  const text = await csv(await downloaded);
  const rows = text.trimEnd().split("\r\n");
  expect(rows).toHaveLength(53);
  expect(rows[1]).toMatch(/^model-51,/u);
  expect(rows.at(-1)).toMatch(/^model-00,/u);
  expect(text).toContain("부분 응답 또는 이전 데이터 포함");
  expect(text).not.toContain("public-owner");
  expect(modelGateway.reads).toHaveLength(8);
  await expect(button).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "52개 모델" })).toBeVisible();
});
test("새 조회 결과만 내려받고 빈 결과에서는 파일을 만들지 않는다", async ({ page, modelGateway }) => {
  await ready(page);
  modelGateway.shrinkToOrdinary(2);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  expect((await csv(await downloaded)).trimEnd().split("\r\n")).toHaveLength(3);
  modelGateway.shrinkToOrdinary(0);
  const downloads: Download[] = [];
  page.on("download", (item) => downloads.push(item));
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  await expect(page.getByRole("status").filter({ hasText: "파일을 만들지 않았습니다" })).toBeVisible();
  expect(downloads).toHaveLength(0);
  expect(modelGateway.reads).toHaveLength(12);
});
test("내보내기 오류는 자동 재시도 없이 복구하며 권한 거부 시 이전 모델을 숨긴다", async ({
  page,
  modelGateway,
}) => {
  await ready(page);
  const downloads: Download[] = [];
  page.on("download", (item) => downloads.push(item));
  modelGateway.status(503);
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "서버가 요청을 처리하지 못했습니다" }),
  ).toBeVisible();
  expect(modelGateway.reads).toHaveLength(8);
  expect(downloads).toHaveLength(0);
  modelGateway.status(200);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  await downloaded;
  modelGateway.status(403);
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  await expect(page.getByRole("heading", { name: "모델 조회 권한 확인 필요" })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  expect(downloads).toHaveLength(1);
});
test("조회 중 필터를 바꾸면 이전 응답의 다운로드를 취소한다", async ({ page, modelGateway }) => {
  await ready(page);
  const downloads: Download[] = [];
  page.on("download", (item) => downloads.push(item));
  modelGateway.holdModelRead(2);
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  await expect(page.getByRole("button", { name: "내보낼 모델 조회 중" })).toBeVisible();
  await expect.poll(() => modelGateway.reads.length).toBe(8);
  const cancelled = page.waitForEvent(
    "requestfailed",
    (request) => new URL(request.url()).pathname === "/admin/models",
  );
  await page
    .getByRole("table")
    .getByRole("columnheader")
    .filter({ hasText: "품질" })
    .getByRole("button")
    .click();
  await cancelled;
  modelGateway.releaseModelRead(2);
  await expect(page.getByRole("button", { name: "CSV 내보내기" })).toBeEnabled();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  expect((await csv(await downloaded)).split("\r\n")[1]).toMatch(/^z-best,/u);
  expect(downloads).toHaveLength(1);
});
