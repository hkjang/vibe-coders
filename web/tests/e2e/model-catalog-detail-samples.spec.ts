import { expect, type Locator, type Page } from "@playwright/test";
import { alphaRef, test } from "../fixtures/model-catalog-sorting-gateway";

// Independent list-to-detail checks reuse the unchanged public synthetic fixture.
const table = (page: Page) =>
  page.getByRole("table", { name: "공급자별 모델 상태, 품질과 가격", exact: true });
const definition = (dialog: Locator, label: string) =>
  dialog.getByText(label, { exact: true }).locator("..").locator("dd");

async function loadedRow(page: Page, model: string) {
  await page.goto(`gateway/models?q=${model}`);
  const link = table(page).getByRole("link", { name: model, exact: true });
  await expect(table(page).getByRole("link")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
  await expect(table(page).getByText("확인 중", { exact: true })).toHaveCount(0);
  return {
    link,
    row: table(page)
      .getByRole("row")
      .filter({ has: page.getByRole("link", { name: model, exact: true }) }),
  };
}

function onlyInitialReads(reads: Array<{ path: string; query: string }>) {
  expect(reads).toHaveLength(4);
  for (const path of ["/admin/models", "/admin/models/quality", "/admin/pricing", "/admin/model-tags"])
    expect(reads.filter((call) => call.path === path)).toHaveLength(1);
  expect(reads.find((call) => call.path === "/admin/models")?.query).toBe("");
  expect(reads.find((call) => call.path === "/admin/models/quality")?.query).toBe("?window=24h");
}

test("요청 무표본 모델은 목록과 같은 상세에서 성공률만 미관측으로 표시하고 평가 품질을 유지한다", async ({
  page,
  modelGateway,
}) => {
  const model = "signal-eval-only";
  const { link, row } = await loadedRow(page, model);
  await expect(row.getByText("요청 표본 없음", { exact: true })).toBeVisible();
  await expect(row.getByText("0%", { exact: true })).toHaveCount(0);
  await expect(row.getByText("95점", { exact: true })).toBeVisible();
  onlyInitialReads(modelGateway.reads);

  await link.click();
  const dialog = page.getByRole("dialog", { name: model, exact: true });
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).searchParams.get("model_provider")).toBe(alphaRef);
  await expect(definition(dialog, "종합 품질")).toHaveText("95점");
  await expect(definition(dialog, "평가")).toHaveText("80% · 5건");
  // Only request success is unknown. Golden's separate 0% · 0건 is legitimate
  // under the existing presentation and must not trigger a broad no-zero check.
  await expect(definition(dialog, "요청 성공률")).toHaveText("요청 표본 없음");
  onlyInitialReads(modelGateway.reads);
  expect(modelGateway.writes).toEqual([]);
  expect(modelGateway.unexpected).toEqual([]);
});

test("실제 요청 표본의 0퍼센트·0점과 fixture의 캐시 입력 무료 가격은 같은 상세에서도 유지한다", async ({
  page,
  modelGateway,
}) => {
  const model = "signal-observed-zero";
  const { link, row } = await loadedRow(page, model);
  await expect(row.getByText("0%", { exact: true })).toBeVisible();
  await expect(row.getByText("0점", { exact: true })).toBeVisible();
  await expect(row.getByText("요청 표본 없음", { exact: true })).toHaveCount(0);
  await expect(row.getByText("₩100", { exact: true })).toBeVisible();
  await expect(row.getByText("₩200", { exact: true })).toBeVisible();
  onlyInitialReads(modelGateway.reads);

  await link.click();
  const dialog = page.getByRole("dialog", { name: model, exact: true });
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).searchParams.get("model_provider")).toBe(alphaRef);
  await expect(definition(dialog, "요청 성공률")).toHaveText("0%");
  await expect(definition(dialog, "종합 품질")).toHaveText("0점");
  await expect(definition(dialog, "요청 성공률")).not.toHaveText("요청 표본 없음");
  // This immutable browser fixture has 100/200 input/output, not free prices.
  // Only cached input is zero; do not copy the different unit-test price fixture.
  await expect(definition(dialog, "입력 / 100만 토큰")).toHaveText("₩100");
  await expect(definition(dialog, "출력 / 100만 토큰")).toHaveText("₩200");
  await expect(definition(dialog, "캐시 입력 / 100만 토큰")).toHaveText("₩0");
  onlyInitialReads(modelGateway.reads);
  expect(modelGateway.writes).toEqual([]);
  expect(modelGateway.unexpected).toEqual([]);
});
