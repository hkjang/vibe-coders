import { expect, test } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installText2SqlWorkspace } from "../fixtures/text2sql-workspace-browser";

const tabs = [
  ["overview", "요약", [""]],
  ["runtime", "런타임·연결", ["", "/connections", "/features"]],
  ["schemas", "스키마·레지스트리", ["", "/connections"]],
  ["access", "권한·용어", ["", "/glossary"]],
  ["risk", "위험·이상", ["/risk-queue", "/anomalies"]],
  ["golden", "기준 SQL 검증", [""]],
  ["reports", "리포트·인사이트", ["/miners", "/reports"]],
] as const;
for (const [tab, label, suffixes] of tabs)
  test(`${label}: 직접 열기·새로고침·현재 탭만 갱신`, async ({ page }) => {
    const fixture = await installText2SqlWorkspace(page);
    await page.goto(`text2sql?tab=${tab}`);
    await expect(page.getByRole("tab", { name: label, selected: true })).toBeVisible();
    await page.getByLabel("자동 새로고침 간격").selectOption("0");
    await page.reload();
    const refresh = page.getByRole("button", { name: "새로고침", exact: true });
    await expect(refresh).toBeEnabled();
    const before = { ...fixture.state.reads };
    await refresh.click();
    await expect
      .poll(() =>
        Object.entries(fixture.state.reads)
          .filter(([key, count]) => count > (before[key] ?? 0))
          .map(([key]) => key)
          .sort(),
      )
      .toEqual(suffixes.map((suffix) => `/admin/text2sql${suffix}`).sort());
    await expect(page.getByRole("link", { name: "기존 화면에서 열기", exact: true })).toHaveAttribute(
      "href",
      "/admin#/text2sql",
    );
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
test("권한 거부 뒤 이전 질문·SQL을 숨기고 수동 재시도로 복구한다", async ({ page }) => {
  const fixture = await installText2SqlWorkspace(page);
  await page.goto("text2sql");
  await expect(page.getByText("지난달 주문 건수", { exact: true })).toBeVisible();
  fixture.state.deny = "/admin/text2sql";
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByText("지난달 주문 건수", { exact: true })).toHaveCount(0);
  await expect(page.getByText("SELECT COUNT(*) FROM orders", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toBeVisible();
  fixture.state.deny = "";
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByText("지난달 주문 건수", { exact: true })).toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
test("일부 연결 조회 실패는 프로필과 다른 탭을 유지한다", async ({ page }) => {
  const fixture = await installText2SqlWorkspace(page);
  fixture.state.fail = "/admin/text2sql/connections";
  await page.goto("text2sql?tab=runtime");
  await expect(page.getByText("vibe/text2sql-finance", { exact: true })).toBeVisible();
  await expect(page.getByText("요청 ID: text2sql-workspace-fixture", { exact: true })).toBeVisible();
  fixture.state.fail = "";
  await page.getByRole("button", { name: "실행 DB 연결 재시도" }).click();
  await expect(page.getByText("분석 DB", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "위험·이상" }).click();
  await expect(page.getByRole("table", { name: "Text2SQL 위험 요청 큐" })).toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
test("연결 점검은 명시적으로 실행하고 표는 다음 갱신에도 유지한다", async ({ page }) => {
  const fixture = await installText2SqlWorkspace(page);
  await page.goto("text2sql?tab=runtime");
  const table = page.getByRole("table", { name: "Text2SQL 실행 DB 연결" });
  await expect(table.getByText("분석 DB", { exact: true })).toBeVisible();
  expect(fixture.state.reads["/admin/text2sql/healthcheck"]).toBeUndefined();
  await table.getByRole("button", { name: "연결 점검", exact: true }).click();
  await expect(page.getByText("읽기 전용 연결 정상", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  expect(fixture.state.reads["/admin/text2sql/healthcheck"]).toBe(1);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    for (const [tab, label] of tabs.filter(([id]) =>
      ["overview", "runtime", "schemas", "golden"].includes(id),
    ))
      test(`${label}: ${theme} ${width}px 키보드·접근성·시각 기준`, async ({ page }) => {
        const fixture = await installText2SqlWorkspace(page);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
        await page.goto(`text2sql?tab=${tab}`);
        await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
        const current = page.getByRole("tab", { name: label, exact: true });
        await current.focus();
        await expect(current).toBeFocused();
        await page.keyboard.press("ArrowRight");
        const next = tabs[(tabs.findIndex(([id]) => id === tab) + 1) % tabs.length];
        if (!next) throw new Error("다음 탭이 없습니다.");
        await expect(page.getByRole("tab", { name: next[1], exact: true })).toBeFocused();
        await page.keyboard.press("ArrowLeft");
        await expect(current).toBeFocused();
        await expect(current).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("tabpanel", { name: label, exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.locator("body")).toHaveCSS(
          "color",
          theme === "dark" ? "rgb(231, 234, 240)" : "rgb(23, 32, 51)",
        );
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const violations = await page.evaluate(
          async () =>
            (
              await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
                document,
              )
            ).violations,
        );
        expect(violations).toEqual([]);
        await expect(page).toHaveScreenshot(`text2sql-${tab}-${theme}-${width}.png`, {
          animations: "disabled",
          fullPage: true,
        });
        expect(fixture.writes).toEqual([]);
        expect(fixture.unexpected).toEqual([]);
      });

test("가져오기 파일 형식을 검증하고 검증된 JSON만 기존 API로 보낸다", async ({ page }) => {
  const fixture = await installText2SqlWorkspace(page);
  await page.goto("text2sql?tab=schemas");
  const picker = page.getByLabel("레지스트리 JSON 파일 선택", { exact: true });
  await picker.setInputFiles("tests/fixtures/text2sql-registry-invalid.json");
  await expect(
    page.getByText("JSON 형식을 확인하세요. 테이블·컬럼 배열과 각 항목의 스키마·이름이 필요합니다.").first(),
  ).toBeVisible();
  expect(fixture.writes).toEqual([]);
  const body = { tables: [{ schema_name: "analytics", table_name: "orders" }], columns: [] };
  await picker.setInputFiles("tests/fixtures/text2sql-registry-valid.json");
  await expect(
    page.getByText("가져오기 완료 — 테이블 1개, 컬럼 0개 (오류 0건)", { exact: true }),
  ).toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]?.postDataJSON()).toEqual(body);
  expect(fixture.unexpected).toEqual([]);
});
test("스키마 탭을 떠나면 지연된 내보내기로 다운로드를 시작하지 않는다", async ({ page }) => {
  const fixture = await installText2SqlWorkspace(page);
  fixture.state.holdExport = true;
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await page.goto("text2sql?tab=schemas");
  await page.getByRole("button", { name: "JSON 내보내기", exact: true }).click();
  await expect.poll(() => fixture.state.reads["/admin/text2sql/registry/export"]).toBe(1);
  await page.getByRole("tab", { name: "위험·이상", exact: true }).click();
  await expect(page.getByRole("table", { name: "Text2SQL 위험 요청 큐" })).toBeVisible();
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/admin/text2sql/registry/export",
  );
  fixture.releaseExport();
  await (await response).finished();
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  expect(downloads).toEqual([]);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
