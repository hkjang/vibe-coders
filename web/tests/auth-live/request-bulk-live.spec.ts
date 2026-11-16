import { expect } from "@playwright/test";
import { admin, login, reader, test } from "./live-fixture";

interface RequestPageData {
  requests: { request_id: string; created_at: string; estimated_cost: number; model: string }[];
}

for (const [id, role, account] of [
  ["AUTH-LIVE-049", "관리자", admin],
  ["AUTH-LIVE-050", "읽기 전용 관리자", reader],
] as const) {
  test(`${id} 실제 ${role}의 요청 열 설정·선택 CSV와 서버 페이지 이동`, async ({ page }) => {
    const response = page.waitForResponse((value) => {
      const url = new URL(value.url());
      return (
        url.pathname === "/admin/requests" &&
        url.searchParams.get("model") === "synthetic-bulk-selection" &&
        value.status() === 200
      );
    });
    await login(page, account, "/app/observability/requests?model=synthetic-bulk-selection&limit=2");
    const data: RequestPageData = await (await response).json();
    expect(data.requests.length === 2).toBe(true);
    await page.getByRole("button", { name: "여러 요청 선택", exact: true }).click();
    await page.getByRole("checkbox", { name: "2번째 요청 선택", exact: true }).check();
    await page.getByRole("button", { name: "열 설정", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "표 열 설정" });
    await dialog.getByRole("checkbox", { name: /^모델/u }).uncheck();
    await dialog.getByRole("button", { name: "설정 완료", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "2번째 요청 선택", exact: true })).toBeChecked();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "선택한 요청 CSV", exact: true }).click();
    let csv = "";
    for await (const chunk of await (await download).createReadStream()) csv += String(chunk);
    const lines = csv
      .replace(/^\uFEFF/u, "")
      .trimEnd()
      .split("\r\n");
    const headers = lines[0]?.split(",") ?? [];
    const values = lines[1]?.split(",") ?? [];
    const selected = data.requests[1];
    // Fixed synthetic fields contain no commas; raw response values never enter diagnostics.
    expect(
      lines.length === 2 &&
        selected !== undefined &&
        values[headers.indexOf("요청 ID")] === selected.request_id &&
        values[headers.indexOf("시각")] === selected.created_at &&
        values[headers.indexOf("모델")] === selected.model &&
        Number(values[headers.indexOf("추정 비용")]) === selected.estimated_cost,
    ).toBe(true);
    await page.getByRole("button", { name: "다음", exact: true }).click();
    await expect(page.getByRole("table", { name: "현재 페이지 요청 목록" }).getByRole("row")).toHaveCount(2);
    await expect(page.getByRole("checkbox", { name: "1번째 요청 선택", exact: true })).not.toBeChecked();
    await expect(page.getByRole("button", { name: "선택한 요청 CSV", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "이전", exact: true }).click();
    await expect(page.getByRole("table", { name: "현재 페이지 요청 목록" }).getByRole("row")).toHaveCount(3);
    await expect(page.getByRole("checkbox", { name: "2번째 요청 선택", exact: true })).not.toBeChecked();
    await page.reload();
    await expect(page.getByRole("table", { name: "현재 페이지 요청 목록" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /^모델/u })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: /^요청 ID/u })).toBeVisible();
    const summary = page.getByRole("region", { name: "요청 조회 조건", exact: true });
    await expect(summary).toContainText("적용 중인 조건 1개");
    const unfiltered = page.waitForResponse((value) => {
      const url = new URL(value.url());
      return url.pathname === "/admin/requests" && !url.searchParams.has("model") && value.status() === 200;
    });
    await page.getByRole("button", { name: "모델 필터 해제", exact: true }).click();
    await unfiltered;
    await expect(summary).toContainText("적용 중인 조건 0개");
    expect(new URL(page.url()).searchParams.toString() === "limit=2").toBe(true);
    await expect(page.getByRole("heading", { name: "요청 조회 결과", exact: true })).toBeFocused();
    await page.goBack();
    await expect(summary).toContainText("적용 중인 조건 1개");
    await expect(page.getByRole("table", { name: "현재 페이지 요청 목록" }).getByRole("row")).toHaveCount(3);
    const suggested = page.waitForResponse((value) => {
      const url = new URL(value.url());
      return (
        url.pathname === "/admin/suggest" &&
        url.searchParams.get("field") === "model" &&
        value.status() === 200
      );
    });
    await page.getByLabel("모델", { exact: true }).focus();
    const payload: { values?: string[] | null } = await (await suggested).json();
    // Compare authenticated server values without exposing them in diagnostics.
    await expect
      .poll(async () => {
        const rendered = await page
          .locator("#request-filter-models option")
          .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
        return JSON.stringify(rendered) === JSON.stringify(payload.values ?? []);
      })
      .toBe(true);
  });
}
