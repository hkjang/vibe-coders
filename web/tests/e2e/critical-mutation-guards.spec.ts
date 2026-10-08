import { expect, type Page } from "@playwright/test";
import { test as base, account, policy } from "./fixtures/policy-editor";

// Real React/AuthProvider/ApiClient with synthetic HTTP. These checks establish
// explicit dispatch and current UI permissions, not server persistence or CAS.
const reason = "공개 검증용 운영 변경 사유";
const test = base.extend<{
  critical: {
    writes: unknown[];
    disabled: (value: boolean) => void;
    denyNext: () => void;
    refreshes: () => number;
  };
}>({
  critical: async ({ context, baseURL, gateway }, run) => {
    void gateway; // Install the shared synthetic authenticated router first.
    if (!baseURL) throw new Error("Expected local synthetic origin");
    let stopped = false;
    let denied = false;
    let refreshes = 0;
    const writes: unknown[] = [];
    await context.route(new URL("/admin/kill-switch", baseURL).href, async (route) => {
      const request = route.request();
      expect(request.headers().authorization).toBe("Bearer public-editor-access");
      if (request.method() === "GET") {
        await route.fulfill({ json: { disabled: stopped } });
        return;
      }
      expect(request.method()).toBe("POST");
      expect(request.headers()["x-vibe-route"]).toBe("governance.policies");
      const body: unknown = request.postDataJSON();
      writes.push(body);
      if (denied) {
        denied = false;
        await route.fulfill({ status: 401, json: { error: { message: "public unauthorized" } } });
        return;
      }
      expect(body).toEqual({ disabled: !stopped, reason });
      stopped = !stopped;
      await route.fulfill({ json: { disabled: stopped, reason } });
    });
    await context.route(new URL("/auth/refresh", baseURL).href, async (route) => {
      refreshes += 1;
      await route.fulfill({
        json: {
          access_token: "public-editor-access",
          refresh_token: "public-editor-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_expires_in: 7200,
          user: account,
        },
      });
    });
    await run({
      writes,
      disabled: (value) => {
        stopped = value;
      },
      denyNext: () => {
        denied = true;
      },
      refreshes: () => refreshes,
    });
  },
});

async function login(page: Page) {
  await page.goto("login?return_to=%2Fapp%2Fgovernance%2Fpolicies%3Ftab%3Dsafety");
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: `${policy.name} 사용`, exact: true })).toBeVisible();
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
const entry = (page: Page, action: "kill" | "policy") =>
  page.getByRole("button", {
    name: action === "kill" ? "모든 /v1 호출 즉시 차단" : `${policy.name} 사용`,
    exact: true,
  });
const dialog = (page: Page, action: "kill" | "policy") =>
  page.getByRole("dialog", {
    name: action === "kill" ? "게이트웨이를 긴급 정지할까요?" : "정책을 사용할까요?",
    exact: true,
  });
const confirm = (page: Page, action: "kill" | "policy") =>
  dialog(page, action).getByRole("button", { name: action === "kill" ? "즉시 차단" : "사용", exact: true });

for (const mode of ["flag", "status"] as const) {
  test(`${mode} 읽기 전용은 긴급 정지와 정책 사용 진입을 막고 조회를 유지한다`, async ({
    page,
    gateway,
    critical,
  }) => {
    gateway.readonly(mode);
    await login(page);
    await expect(entry(page, "kill")).toBeDisabled();
    await expect(entry(page, "policy")).toBeDisabled();
    await expect(page.getByRole("heading", { name: "AI 정책 엔진", exact: true })).toBeVisible();
    expect(gateway.reads()).toBeGreaterThan(0);
    expect(critical.writes).toEqual([]);
    expect(gateway.saves).toEqual([]);
  });
}

for (const action of ["kill", "policy"] as const) {
  for (const restriction of ["feature", "scope"] as const) {
    test(`${action} 확인 중 ${restriction} 회수는 잠금·복구 후 명시적 1회 전송을 유지한다`, async ({
      page,
      gateway,
      critical,
    }) => {
      await login(page);
      await entry(page, action).click();
      if (action === "kill")
        await dialog(page, action).getByRole("textbox", { name: "변경 사유", exact: true }).fill(reason);
      await expect(confirm(page, action)).toBeEnabled();
      if (restriction === "feature") gateway.readonly("flag");
      else gateway.writable(false);
      await runtime(page);
      await expect(confirm(page, action)).toBeDisabled();
      await expect(dialog(page, action)).toContainText("직접 확인하기 전에는 전송하지 않습니다.");
      if (action === "kill") {
        await expect(
          dialog(page, action).getByRole("textbox", { name: "변경 사유", exact: true }),
        ).toHaveValue(reason);
        await expect(
          dialog(page, action).getByRole("textbox", { name: "변경 사유", exact: true }),
        ).toBeDisabled();
      }
      await confirm(page, action).evaluate((node) => (node as HTMLButtonElement).click());
      expect(critical.writes).toEqual([]);
      expect(gateway.saves).toEqual([]);
      gateway.readonly(false);
      gateway.writable(true);
      await runtime(page);
      await expect(confirm(page, action)).toBeEnabled();
      expect(critical.writes).toEqual([]);
      expect(gateway.saves).toEqual([]);
      await confirm(page, action).click();
      await expect(dialog(page, action)).toBeHidden();
      expect(critical.writes).toEqual(action === "kill" ? [{ disabled: true, reason }] : []);
      expect(gateway.saves).toHaveLength(action === "policy" ? 1 : 0);
      if (action === "policy") expect(gateway.saves[0]).toMatchObject({ id: policy.id, enabled: true });
      expect(critical.refreshes()).toBe(0);
    });
  }

  test(`${action} 401은 인증 갱신과 자동 두 번째 POST 없이 오류를 표시한다`, async ({
    page,
    gateway,
    critical,
  }) => {
    if (action === "kill") critical.denyNext();
    else
      gateway.reply(1, { status: 401, body: { error: { message: "public unauthorized" } }, commit: false });
    await login(page);
    await entry(page, action).click();
    if (action === "kill")
      await dialog(page, action).getByRole("textbox", { name: "변경 사유", exact: true }).fill(reason);
    await confirm(page, action).click();
    await expect(dialog(page, action).getByRole("alert")).toBeVisible();
    await expect(confirm(page, action)).toBeEnabled();
    expect(critical.refreshes()).toBe(0);
    expect(critical.writes).toHaveLength(action === "kill" ? 1 : 0);
    expect(gateway.saves).toHaveLength(action === "policy" ? 1 : 0);
    await dialog(page, action).getByRole("button", { name: "취소", exact: true }).click();
    await expect(dialog(page, action)).toBeHidden();
    expect(critical.refreshes()).toBe(0);
  });
}

test("390px 다크 확인창의 사유·한글 잠금·키보드·초점·axe를 유지한다", async ({
  page,
  gateway,
  critical,
}, info) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await entry(page, "kill").focus();
  await page.keyboard.press("Enter");
  await dialog(page, "kill").getByRole("textbox", { name: "변경 사유", exact: true }).fill(reason);
  gateway.readonly("flag");
  await runtime(page);
  await expect(confirm(page, "kill")).toBeDisabled();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(dialog(page, "kill")).toContainText("입력한 사유는 유지됩니다.");
  expect(await dialog(page, "kill").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const cancel = dialog(page, "kill").getByRole("button", { name: "취소", exact: true });
  await cancel.focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog(page, "kill").getByRole("button", { name: "대화상자 닫기", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  expect(
    await page.evaluate(async () => {
      const engine = (
        window as Window & { axe?: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
      ).axe;
      if (!engine) throw new Error("Accessibility engine missing");
      return (await engine.run(document)).violations.map(({ id }) => id);
    }),
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath("critical-permission-mobile-dark.png") });
  gateway.readonly(false);
  await runtime(page);
  await expect(confirm(page, "kill")).toBeEnabled();
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page, "kill")).toBeHidden();
  await expect(entry(page, "kill")).toBeFocused();
  expect(critical.writes).toEqual([]);
  expect(gateway.saves).toEqual([]);
});
