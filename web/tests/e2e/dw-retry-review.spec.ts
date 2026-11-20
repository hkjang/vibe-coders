import { expect } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { test, retryReview } from "../fixtures/dw-retry-browser";
import { expectCellBoundaries } from "../fixtures/table-cell-boundaries";
import { expectReadableTableText } from "../fixtures/table-text-readability";

test("실패분 검토부터 접수·새로고침·부분 실패 확인까지 같은 작업을 유지한다", async ({ page, gateway }) => {
  await page.goto("data/warehouse?tab=pipeline");
  await page.getByRole("button", { name: "실패분 재처리", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "실패분 재처리 검토" });
  await expect(dialog.getByRole("table")).toBeVisible();
  expect(gateway.writes).toEqual([]);
  await dialog.getByRole("button", { name: "검토한 대상 재처리" }).click();
  await expect(dialog.getByRole("textbox", { name: "실행 사유" })).toBeFocused();
  expect(gateway.writes).toEqual([]);
  await dialog.getByRole("textbox", { name: "실행 사유" }).fill("연결 복구 후 미전송분 확인");
  await dialog.getByRole("button", { name: "검토한 대상 재처리" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "재처리 진행 중" })).toBeVisible();
  expect(gateway.writes).toEqual([
    {
      revision: retryReview.revision,
      reviewed_at: retryReview.reviewed_at,
      all: false,
      reason: "연결 복구 후 미전송분 확인",
    },
  ]);
  await expect(page).toHaveURL(new RegExp(`retry_job=${retryReview.run_id}`));
  await page.reload();
  await expect(page.getByRole("heading", { name: "재처리 진행 중" })).toBeVisible();
  expect(gateway.writes).toHaveLength(1);
  gateway.finish();
  await page.getByRole("button", { name: "상태 새로고침", exact: true }).click();
  await expect(page.getByRole("heading", { name: "일부 재처리 미완료" })).toBeVisible();
  await expect(page.getByText("남은 대기열을 확인하세요.")).toBeVisible();
  await expect(
    page.getByRole("table", { name: "구분별 재처리 결과" }).getByText("1,000", { exact: true }),
  ).toBeVisible();
  expect(gateway.writes).toHaveLength(1);
  gateway.requeue();
  await page.getByRole("button", { name: "실패분 재처리", exact: true }).click();
  await expect(dialog.getByText(/예상 1행/u)).toBeVisible();
  const reason = dialog.getByRole("textbox", { name: "실행 사유" });
  await expect(reason).toBeEnabled();
  await expect(reason).toHaveValue("");
  await reason.fill("남은 실패분 재검토 후 실행");
  await dialog.getByRole("button", { name: "검토한 대상 재처리" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`retry_job=dwr_${"b".repeat(64)}`));
  expect(gateway.writes).toHaveLength(2);
  expect(gateway.writes[1]).toMatchObject({ revision: "b".repeat(64), reason: "남은 실패분 재검토 후 실행" });
});
test("접수 응답 유실은 작업 조회로 복구하며 재전송하지 않는다", async ({ page, gateway }) => {
  gateway.loseResponse();
  await page.goto("data/warehouse?tab=pipeline");
  await page.getByRole("button", { name: "실패분 재처리", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "실패분 재처리 검토" });
  await dialog.getByRole("textbox", { name: "실행 사유" }).fill("응답 유실 복구 확인");
  await dialog.getByRole("button", { name: "검토한 대상 재처리" }).click();
  await dialog.getByRole("button", { name: "접수 결과 확인" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "재처리 진행 중" })).toBeVisible();
  expect(gateway.writes).toHaveLength(1);
});
for (const width of [390, 1440])
  for (const theme of ["light", "dark"] as const) {
    test(`재처리 검토의 표·키보드·명암 대비 ${width}px ${theme}`, async ({ page, gateway }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("data/warehouse?tab=pipeline");
      const trigger = page.getByRole("button", { name: "실패분 재처리", exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "실패분 재처리 검토" });
      const table = dialog.getByRole("table", { name: "재처리 대상과 예상 건수" });
      await expect(table).toBeVisible();
      await expectCellBoundaries(table);
      await expectReadableTableText(table);
      await expect(dialog.getByRole("button", { name: "검토한 대상 재처리" })).toBeInViewport();
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe;
        return (await axe.run(document)).violations;
      });
      expect(violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`dw-retry-${theme}-${width}.png`), fullPage: true });
      await expect(dialog).toHaveScreenshot(`dw-retry-dialog-${theme}-${width}.png`);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      expect(gateway.writes).toEqual([]);
    });
  }
