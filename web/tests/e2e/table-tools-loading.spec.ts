import { expect } from "@playwright/test";
import { test } from "../fixtures/model-catalog-sorting-gateway";

test("열 설정을 누르기 전에는 자산을 요청하지 않고 로딩 중 이동하면 뒤늦게 열지 않는다", async ({
  page,
  modelGateway,
}) => {
  const assets: string[] = [];
  page.on("request", (r) => {
    if (/\/DataTableSettingsDialog-[^/]+\.js$/u.test(new URL(r.url()).pathname)) assets.push(r.url());
  });
  await page.goto("gateway/models");
  const trigger = page.getByRole("button", { name: "열 설정", exact: true });
  await expect(trigger).toBeVisible();
  expect(assets).toEqual([]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/DataTableSettingsDialog-*.js", async (route) => {
    await gate;
    await route.continue();
  });
  await trigger.click();
  await expect(page.getByRole("status").filter({ hasText: "열 설정을 불러오는 중" })).toBeVisible();
  await page.keyboard.press("Escape");
  const response = page.waitForResponse((r) =>
    /\/DataTableSettingsDialog-[^/]+\.js$/u.test(new URL(r.url()).pathname),
  );
  release();
  await (await response).finished();
  await expect(page.getByRole("dialog", { name: "표 열 설정" })).toHaveCount(0);
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "표 열 설정" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect(assets).toHaveLength(1);
  expect(modelGateway.writes).toEqual([]);
});

test("열 설정 자산 실패는 목록 조회·상세 이동을 중단하지 않는다", async ({ page, modelGateway }) => {
  await page.goto("gateway/models");
  await page.route("**/assets/DataTableSettingsDialog-*.js", (route) => route.abort("failed"));
  await page.getByRole("button", { name: "열 설정", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "열 설정을 불러오지 못했습니다" })).toBeVisible();
  await page
    .getByRole("table", { name: "공급자별 모델 상태, 품질과 가격" })
    .getByRole("link", { name: "model-00", exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "model-00", exact: true })).toBeVisible();
  expect(modelGateway.writes).toEqual([]);
});
