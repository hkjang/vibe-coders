import { expect, type Page } from "@playwright/test";
import { alpha, firstEmail, secondEmail, targetUrl, test } from "../fixtures/app-permission-gateway";

async function signIn(page: Page, email = firstEmail) {
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AI 업무 앱", exact: true })).toBeVisible();
}
async function login(page: Page) {
  await page.goto(`login?return_to=${encodeURIComponent(targetUrl)}`);
  await signIn(page);
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
}

test("목록의 권한 거부는 이전 앱을 숨기고 명시적 재시도로 복구한다", async ({ page, gateway }) => {
  expect(gateway.unexpected).toEqual([]);
  let denied = false;
  await page.route("**/admin/apps", (route) =>
    route.fulfill({
      status: denied ? 403 : 200,
      json: denied ? { error: { message: "denied" } } : { apps: [alpha] },
    }),
  );
  await login(page);
  const row = page.getByRole("button", { name: `${alpha.title} 상세 열기`, exact: true });
  await expect(row).toBeVisible();
  denied = true;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByText("업무 앱 조회 권한을 다시 확인하세요.", { exact: true })).toBeVisible();
  await expect(row).toHaveCount(0);
  denied = false;
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(row).toBeVisible();
});

test("저장의 401은 토큰 갱신 후 자동 재전송하지 않는다", async ({ page, gateway }) => {
  expect(gateway.unexpected).toEqual([]);
  let writes = 0;
  let refreshes = 0;
  await page.route("**/admin/apps", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    writes++;
    return route.fulfill({ status: 401, json: { error: { message: "authorization changed" } } });
  });
  await page.route("**/auth/refresh", (route) => {
    refreshes++;
    return route.fulfill({ status: 401, json: {} });
  });
  await login(page);
  await page.getByRole("button", { name: "새 업무 앱", exact: true }).click();
  const form = page.getByRole("dialog", { name: "새 AI 업무 앱", exact: true });
  await form.getByRole("textbox", { name: "제목", exact: true }).fill("공개 테스트 초안");
  await form.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await form.getByRole("checkbox", { name: "변경 내용과 적용 범위를 확인했습니다.", exact: true }).check();
  await form.getByRole("button", { name: "앱 만들기", exact: true }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  expect(writes).toBe(1);
  expect(refreshes).toBe(0);
  await expect(form.getByRole("textbox", { name: "제목", exact: true })).toHaveValue("공개 테스트 초안");
});

for (const status of [200, 503])
  test(`이전 계정 저장의 늦은 ${status} 응답은 새 계정의 초안을 변경하지 않는다`, async ({
    page,
    context,
    gateway,
  }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    await page.route("**/admin/apps", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      writes++;
      await held;
      return route.fulfill({ status, json: status === 200 ? alpha : { error: { message: "old failure" } } });
    });
    try {
      await login(page);
      const other = await context.newPage();
      await login(other);
      await page.getByRole("button", { name: "새 업무 앱", exact: true }).click();
      const form = page.getByRole("dialog", { name: "새 AI 업무 앱", exact: true });
      await form.getByRole("textbox", { name: "제목", exact: true }).fill("이전 계정 초안");
      await form.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
      await form
        .getByRole("checkbox", { name: "변경 내용과 적용 범위를 확인했습니다.", exact: true })
        .check();
      await form.getByRole("button", { name: "앱 만들기", exact: true }).click();
      await expect.poll(() => writes).toBe(1);
      await other.getByLabel("사용자 메뉴").click();
      await other.getByRole("button", { name: "로그아웃", exact: true }).click();
      await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
      await signIn(page, secondEmail);
      await page.getByRole("button", { name: "새 업무 앱", exact: true }).click();
      await form.getByRole("textbox", { name: "제목", exact: true }).fill("새 계정 초안");
      const reads = gateway.listReads();
      const response = page.waitForResponse(
        (value) => new URL(value.url()).pathname === "/admin/apps" && value.request().method() === "POST",
      );
      release();
      await response;
      await expect(form.getByRole("textbox", { name: "제목", exact: true })).toHaveValue("새 계정 초안");
      await expect(form.getByRole("button", { name: "앱 만들기", exact: true })).toBeDisabled();
      await expect(form.getByRole("textbox", { name: "제목", exact: true })).toBeEditable();
      await expect(form.getByRole("alert")).toHaveCount(0);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      expect(gateway.listReads()).toBe(reads);
      expect(writes).toBe(1);
    } finally {
      release();
    }
  });
