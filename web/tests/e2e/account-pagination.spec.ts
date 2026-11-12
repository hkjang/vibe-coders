import { expect, test } from "@playwright/test";
import type axe from "axe-core";
import { installAccountPagination } from "../fixtures/account-pagination-browser";

test("계정 페이지·필터를 서버에 전달하고 새로고침 후 복원한다", async ({ page }) => {
  const fixture = await installAccountPagination(page);
  await page.goto("access/users?account_page=2&account_size=10");
  const table = page.getByRole("table", { name: "로그인 계정 목록", exact: true });
  await expect(table).toContainText("account-10@example.test");
  expect(fixture.reads[0]?.get("offset")).toBe("10");
  await page.reload();
  await expect(table).toContainText("account-10@example.test");
  await page.getByLabel("계정 검색", { exact: true }).fill("account-42@");
  const apply = page.getByRole("button", { name: "필터 적용", exact: true });
  await apply.click();
  await expect(table).toContainText("account-42@example.test");
  await expect(apply).toBeFocused();
  expect(fixture.reads.at(-1)?.get("offset")).toBe("0");
  await page.reload();
  await expect(table).toContainText("account-42@example.test");
  await expect(page.getByLabel("계정 검색", { exact: true })).toHaveValue("account-42@");
  fixture.check();
});

test("중지 계정 필터는 실제 계정 상태 disabled를 조회하고 새로고침 후 유지한다", async ({ page }) => {
  const fixture = await installAccountPagination(page);
  await page.goto("access/users/accounts");
  const table = page.getByRole("table", { name: "로그인 계정 목록", exact: true });
  await expect(table).toContainText("account-0@example.test");
  await page.getByLabel("계정 상태", { exact: true }).selectOption({ label: "중지" });
  await page.getByRole("button", { name: "필터 적용", exact: true }).click();
  await expect(page.getByText(/검색 결과 30개 계정/u)).toBeVisible();
  await expect(table).toContainText("account-1@example.test");
  await expect(table).not.toContainText("account-0@example.test");
  expect(fixture.reads.at(-1)?.get("status")).toBe("disabled");
  await expect(page).toHaveURL(/account_status=disabled/u);
  await page.reload();
  await expect(page.getByLabel("계정 상태", { exact: true })).toHaveValue("disabled");
  await expect(page.getByText(/검색 결과 30개 계정/u)).toBeVisible();
  expect(fixture.reads.at(-1)?.get("status")).toBe("disabled");
  fixture.check();
});

test("팀 미지정은 빈 팀 ID를 서버로 보내며 현재 페이지 CSV만 내려받는다", async ({ page }) => {
  const fixture = await installAccountPagination(page);
  await page.goto("access/users");
  await page.getByLabel("소속 팀", { exact: true }).selectOption("none");
  await page.getByRole("button", { name: "필터 적용", exact: true }).click();
  const table = page.getByRole("table", { name: "로그인 계정 목록", exact: true });
  await expect(table).toContainText("account-0@example.test");
  await expect(table.getByRole("row")).toHaveCount(2);
  expect(fixture.reads.at(-1)?.has("team_id")).toBe(true);
  expect(fixture.reads.at(-1)?.get("team_id")).toBe("");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "현재 페이지 CSV" }).click();
  const stream = await (await download).createReadStream();
  if (!stream) throw new Error("CSV download stream unavailable");
  let csv = "";
  for await (const chunk of stream) csv += String(chunk);
  expect(csv).toContain("'=1+1");
  expect(csv).toContain("2026-11-12T00:00:00Z");
  expect(csv).not.toContain("account-1@example.test");
  fixture.check();
});

test("계정 조회만 실패하면 키 사용량은 유지하고 계정 조회를 재시도한다", async ({ page }) => {
  const fixture = await installAccountPagination(page);
  fixture.state.accountStatus = 500;
  await page.goto("access/users");
  await expect(page.getByText("로그인 계정을(를) 불러오지 못했습니다.")).toBeVisible();
  await expect(page.getByText(/계정 수 미확인/u)).toBeVisible();
  await expect(page.getByText(/검색 결과 0개 계정/u)).toHaveCount(0);
  fixture.state.accountStatus = 200;
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByRole("table", { name: "로그인 계정 목록", exact: true })).toContainText(
    "account-0@example.test",
  );
  fixture.check();
});

test("범위 밖 페이지는 전체 건수를 유지하고 마지막 페이지로 복구한다", async ({ page }) => {
  const fixture = await installAccountPagination(page);
  await page.goto("access/users?account_page=20");
  await expect(page.getByText(/검색 결과 61개 계정/u)).toBeVisible();
  await page.getByRole("button", { name: "마지막 페이지로 이동" }).click();
  await expect(page.getByRole("table", { name: "로그인 계정 목록", exact: true })).toContainText(
    "account-50@example.test",
  );
  await expect(page).toHaveURL(/account_page=3/u);
  fixture.check();
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  for (const theme of ["light", "dark"] as const) {
    test(`계정 필터·표·정렬의 키보드와 접근성 ${theme} ${viewport.width}×${viewport.height}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await installAccountPagination(page);
      await page.goto("access/users");
      await expect(page.getByRole("table", { name: "로그인 계정 목록", exact: true })).toContainText(
        "account-0@example.test",
      );
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.getByLabel("계정 검색", { exact: true }).focus();
      await page.keyboard.type("account-1@");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("table", { name: "로그인 계정 목록", exact: true })).toContainText(
        "account-1@example.test",
      );
      await expect(page.getByRole("table", { name: "로그인 계정 목록", exact: true })).toContainText("중지");
      await expect(page.getByLabel("계정 검색", { exact: true })).toBeFocused();
      const trigger = page.getByRole("button", { name: "다중 정렬", exact: true });
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog", { name: "다중 정렬 설정" })).toBeVisible();
      expect(
        await page.evaluate(async () =>
          (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map((v) => v.id),
        ),
      ).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(
        await page.evaluate(async () =>
          (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map((v) => v.id),
        ),
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("account-pagination.png") });
      fixture.check();
    });
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`로그인 계정 시각 기준 ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const fixture = await installAccountPagination(page);
      await page.goto("access/users/accounts?account_q=account-1%40");
      await expect(page.getByRole("table", { name: "로그인 계정 목록", exact: true })).toContainText("중지");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page).toHaveScreenshot(`account-pagination-${theme}-${width}.png`, {
        animations: "disabled",
        fullPage: true,
        mask: [page.locator(".updated-at")],
      });
      fixture.check();
    });
  }
}
