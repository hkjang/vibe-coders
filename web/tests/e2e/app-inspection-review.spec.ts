import { expect, type Page } from "@playwright/test";
import { alpha, beta, firstEmail, readerEmail, targetUrl, test } from "../fixtures/app-permission-gateway";

// Public, mocked responses verify browser UX and API boundaries, not Go authorization.
const component = { kind: "model", ref: "fixture-model", label: "검토 모델" };
const apps = [alpha, beta].map((app) => ({ ...app, components: [component] }));
const validation = {
  ok: true,
  checks: [{ ...component, resolved: true, detail: "모델 참조" }],
  warnings: [],
  allowed_models: ["fixture-model"],
};
const plan = (id: string) => ({
  app_id: id,
  run_id: `plan-${id}`,
  title: "검토 앱",
  status: "planned",
  plan: [{ ...component, action: "model", resolved: true, detail: "모델 참조" }],
});
async function login(page: Page, email = firstEmail) {
  await page.goto(`login?return_to=${encodeURIComponent(targetUrl)}`);
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AI 업무 앱", exact: true })).toBeVisible();
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
}
async function open(page: Page, title = alpha.title) {
  await page.getByRole("button", { name: `${title} 상세 열기`, exact: true }).click();
  return page.getByRole("dialog", { name: title, exact: true });
}
test.beforeEach(async ({ page, gateway }) => {
  expect(gateway.unexpected).toEqual([]);
  await page.route("**/admin/apps", (route) => route.fulfill({ json: { apps } }));
});

for (const colorScheme of ["light", "dark"] as const)
  test(`${colorScheme === "light" ? "밝은" : "어두운"} 테마에서 검증·실행 계획을 키보드와 좁은 화면으로 확인한다`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme });
    await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
    let plans = 0;
    await page.route("**/admin/apps/*/validate", (route) => route.fulfill({ json: validation }));
    await page.route("**/v1/apps/*/run", (route) => {
      plans++;
      return route.fulfill({ json: plan(alpha.id) });
    });
    await login(page);
    const sheet = await open(page);
    const validate = sheet.getByRole("button", { name: "검증", exact: true });
    await validate.focus();
    await page.keyboard.press("Enter");
    await expect(sheet.getByRole("heading", { name: "검증 결과", exact: true })).toBeVisible();
    const run = sheet.getByRole("button", { name: "실행 계획 생성", exact: true });
    await run.focus();
    await page.keyboard.press("Enter");
    await expect(sheet.getByText("계획 생성 · 실제 실행 안 함", { exact: true })).toBeVisible();
    expect(plans).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Do not sample translucent intermediate colors during the sheet entrance animation.
    await sheet.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });
    const violations = await page.evaluate(async () => {
      const axe = (
        window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
      ).axe;
      return (await axe.run(document)).violations.map((v) => v.id);
    });
    expect(violations).toEqual([]);
    await sheet.getByRole("heading", { name: "실행 계획", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`app-inspection-${colorScheme}.png`) });
    await sheet.getByLabel("패널 닫기").click();
    await expect(page.getByRole("button", { name: `${alpha.title} 상세 열기`, exact: true })).toBeFocused();
  });

test("이전 앱의 지연 응답이 다음 앱의 계획을 덮어쓰지 않는다", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  let finished = 0;
  await page.route("**/v1/apps/*/run", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    if (id === alpha.id) {
      started++;
      await gate;
    }
    await route.fulfill({ json: plan(id) });
    finished++;
  });
  try {
    await login(page);
    let sheet = await open(page);
    await sheet.getByRole("button", { name: "실행 계획 생성", exact: true }).dblclick();
    await expect.poll(() => started).toBe(1);
    await sheet.getByLabel("패널 닫기").click();
    sheet = await open(page, beta.title);
    await sheet.getByRole("button", { name: "실행 계획 생성", exact: true }).click();
    await expect(sheet.getByText(`plan-${beta.id}`, { exact: true })).toBeVisible();
    release();
    await expect.poll(() => finished).toBe(2);
    await expect(sheet.getByText(`plan-${alpha.id}`, { exact: true })).toHaveCount(0);
    await expect(sheet.getByText(`plan-${beta.id}`, { exact: true })).toBeVisible();
  } finally {
    release();
  }
});

test("빈 응답이나 다른 앱 응답을 성공 계획으로 표시하지 않는다", async ({ page }) => {
  let calls = 0;
  await page.route("**/v1/apps/*/run", (route) => {
    calls++;
    return route.fulfill({ json: calls === 1 ? {} : plan(beta.id) });
  });
  await login(page);
  const sheet = await open(page);
  for (let i = 1; i <= 2; i++) {
    await sheet.getByRole("button", { name: "실행 계획 생성", exact: true }).click();
    await expect(sheet.getByText("실행 계획을 확인하지 못했습니다.", { exact: true })).toBeVisible();
    expect(calls).toBe(i);
    await expect(sheet.getByText("계획 생성 · 실제 실행 안 함", { exact: true })).toHaveCount(0);
  }
});

test("관리자 쓰기 권한 없는 사용자는 검증 API를 호출하지 않는다", async ({ page }) => {
  await login(page, readerEmail);
  const sheet = await open(page);
  await expect(sheet.getByRole("button", { name: "검증", exact: true })).toBeDisabled();
  await expect(
    sheet.getByText("구성 요소 검증에는 admin:write 권한이 필요합니다.", { exact: true }),
  ).toBeVisible();
});
