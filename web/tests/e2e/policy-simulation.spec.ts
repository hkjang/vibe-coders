import { expect, type Locator, type Page } from "@playwright/test";
import { test, account, suggestion, success } from "./fixtures/policy-simulation";

// Synthetic API transport with the real React auth, router and feature guard.
// This does not establish actual Go policy evaluation or database write behavior.
const result = (page: Page) => page.getByRole("dialog", { name: "섀도우 영향 분석", exact: true });
const trigger = (page: Page) =>
  page.getByRole("button", { name: `${suggestion.title} 섀도우 영향 확인`, exact: true });
const field = (dialog: Locator, label: string) =>
  dialog.getByText(label, { exact: true }).locator("..").locator("dd");
async function login(page: Page) {
  await page.goto("login?return_to=%2Fapp%2Fgovernance%2Fpolicies%3Ftab%3Dadvisor");
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: / 섀도우 영향 확인$/u }).first()).toBeVisible();
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function close(page: Page) {
  await result(page).getByRole("button", { name: "패널 닫기", exact: true }).click();
  await expect(result(page)).toBeHidden();
}

test("추천·기간·규칙 스냅샷과 과거 표본의 결과만 표시하고 정책을 저장하지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await trigger(page).click();
  const dialog = result(page);
  await expect(dialog).toBeVisible();
  expect(gateway.simulations).toEqual([
    {
      rules: [{ name: suggestion.title, conditions: suggestion.conditions, actions: suggestion.actions }],
      window: "7d",
    },
  ]);
  await expect(field(dialog, "실행한 추천")).toHaveText(suggestion.title ?? suggestion.id);
  await expect(field(dialog, "실행한 분석 기간")).toContainText("7일");
  await expect(field(dialog, "평가 표본 수")).toHaveText("12");
  await expect(field(dialog, "차단 예상")).toHaveText("3");
  await expect(field(dialog, "허용 예상")).toHaveText("9");
  await expect(dialog.getByText("정책을 저장하거나 적용하지 않습니다.", { exact: false })).toBeVisible();
  expect(await dialog.textContent()).not.toContain("public-sample-key-must-not-render");
  expect(gateway.writes).toEqual([]);
  await close(page);
  await expect(trigger(page)).toBeFocused();
});

test("중복 활성화는 한 번만 계산하고 실패 후에는 명시적으로만 다시 실행한다", async ({ page, gateway }) => {
  gateway.hold(1);
  gateway.reply(1, {
    status: 503,
    body: { error: { code: "policy_sim_failed", message: "public synthetic failure" } },
  });
  await login(page);
  await trigger(page).evaluate((node) => {
    (node as HTMLButtonElement).click();
    (node as HTMLButtonElement).click();
  });
  await expect.poll(() => gateway.simulations.length).toBe(1);
  await expect(page.getByText("정책 영향을 계산하고 있습니다.", { exact: true })).toBeVisible();
  gateway.release(1);
  await expect(page.getByText("정책 영향을 계산하지 못했습니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("req-public-policy-simulation", { exact: false })).toBeVisible();
  await expect(result(page)).toBeHidden();
  expect(gateway.simulations).toHaveLength(1);
  expect(gateway.refreshes()).toBe(0);
  await page.getByRole("button", { name: "다시 시뮬레이션", exact: true }).click();
  await expect(result(page)).toBeVisible();
  expect(gateway.simulations).toHaveLength(2);
});

test("기간을 바꾸면 이전 계산의 늦은 결과를 폐기하고 새 기간을 따로 실행한다", async ({ page, gateway }) => {
  gateway.hold(1);
  await login(page);
  await trigger(page).click();
  await expect.poll(() => gateway.simulations.length).toBe(1);
  await page.getByLabel("정책 어드바이저 분석 기간").selectOption("30d");
  await expect(trigger(page)).toBeEnabled();
  gateway.release(1);
  await expect.poll(() => gateway.finished.includes(1)).toBe(true);
  await expect(result(page)).toBeHidden();
  await trigger(page).click();
  await expect(result(page)).toBeVisible();
  await expect(field(result(page), "실행한 분석 기간")).toContainText("30일");
  expect(gateway.simulations.map((body) => body.window)).toEqual(["7d", "30d"]);
});

test("다른 탭을 다녀오면 이전 요청이 새 화면에 결과를 다시 열지 않는다", async ({ page, gateway }) => {
  gateway.hold(1);
  await login(page);
  await trigger(page).click();
  await expect.poll(() => gateway.simulations.length).toBe(1);
  await page.getByRole("tab", { name: "모델 일몰", exact: true }).click();
  await page.getByRole("tab", { name: "정책 어드바이저", exact: true }).click();
  await expect(trigger(page)).toBeEnabled();
  gateway.release(1);
  await expect.poll(() => gateway.finished.includes(1)).toBe(true);
  await expect(result(page)).toBeHidden();
  await trigger(page).click();
  await expect(result(page)).toBeVisible();
  expect(gateway.simulations).toHaveLength(2);
});

for (const mode of ["flag", "status"] as const) {
  test(`${mode} 읽기 전용에서도 admin:write의 순수 시뮬레이션은 허용한다`, async ({ page, gateway }) => {
    gateway.readonly(mode);
    await login(page);
    await expect(trigger(page)).toBeEnabled();
    await trigger(page).click();
    await expect(result(page)).toBeVisible();
    expect(gateway.simulations).toHaveLength(1);
    expect(gateway.writes).toEqual([]);
  });
}

test("조회 권한만 있으면 계산 요청을 보내지 않는다", async ({ page, gateway }) => {
  gateway.writable(false);
  await login(page);
  await expect(trigger(page)).toBeDisabled();
  await trigger(page).evaluate((node) => {
    (node as HTMLButtonElement).disabled = false;
    (node as HTMLButtonElement).click();
  });
  expect(gateway.simulations).toEqual([]);
});

for (const change of ["owner", "scope"] as const) {
  test(`${change} 변경 후 이전 계산 결과를 새 권한 문맥에 노출하지 않는다`, async ({ page, gateway }) => {
    gateway.hold(1);
    await login(page);
    await trigger(page).click();
    await expect.poll(() => gateway.simulations.length).toBe(1);
    if (change === "owner") gateway.owner("public-other-policy-reviewer");
    else gateway.writable(false);
    await runtime(page);
    // Network completion alone does not prove the React owner/scope commit.
    if (change === "scope") {
      await expect(trigger(page)).toBeDisabled();
      await expect(trigger(page)).toHaveAttribute(
        "title",
        "정책 화면의 조회 권한과 admin:write 실행 권한이 필요합니다.",
      );
      await expect(page.getByText("정책 영향을 계산하고 있습니다.", { exact: true })).toBeHidden();
    } else {
      await page.getByLabel("사용자 메뉴", { exact: true }).click();
      await expect(page.getByText("다른 공개 정책 운영자", { exact: true })).toBeVisible();
      await page.getByLabel("사용자 메뉴", { exact: true }).click();
    }
    gateway.release(1);
    await expect.poll(() => gateway.finished.includes(1)).toBe(true);
    await expect(result(page)).toBeHidden();
    if (change === "scope") await expect(trigger(page)).toBeDisabled();
    else {
      await trigger(page).click();
      await expect(result(page)).toBeVisible();
    }
  });
}

test("응답의 누락값을 0으로 바꾸지 않으며 실제 숫자 0은 별도로 표시한다", async ({ page, gateway }) => {
  gateway.reply(1, { body: { evaluated: 0, blocked: 0, shadow: { blocked_cost_krw: 0 } } });
  await login(page);
  await trigger(page).click();
  await expect(field(result(page), "평가 표본 수")).toHaveText("0");
  await expect(field(result(page), "차단 예상")).toHaveText("0");
  await expect(field(result(page), "승인 요구 예상")).toHaveText("확인할 수 없음");
  await expect(field(result(page), "영향 팀 수")).toHaveText("확인할 수 없음");
  await expect(field(result(page), "차단 대상 표본의 과거 비용")).toContainText("0");
});

test("복원되지 않는 비밀정보 조건은 차단 0건이어도 안전 판정으로 표시하지 않는다", async ({
  page,
  gateway,
}) => {
  gateway.suggestions([{ ...suggestion, conditions: { contains_secret: true } }]);
  gateway.reply(1, {
    body: {
      ...success,
      blocked: 0,
      allowed: 12,
      block_rate: 0,
      shadow: {
        affected_keys: 0,
        affected_teams: 0,
        false_positive_candidates: 0,
        false_positive_rate: 0,
        blocked_cost_krw: 0,
      },
    },
  });
  await login(page);
  await trigger(page).click();
  const dialog = result(page);
  await expect(dialog.getByText("당시 값을 복원하지 못하는 조건이 있습니다.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("비밀정보 포함", { exact: false })).toBeVisible();
  await expect(field(dialog, "차단 예상")).toHaveText("0");
  expect(gateway.simulations[0]).toEqual({
    rules: [{ name: suggestion.title, conditions: { contains_secret: true }, actions: suggestion.actions }],
    window: "7d",
  });
});

test("현재 비밀값 접두사는 표시에서 가리지만 전송 규칙은 변경하지 않는다", async ({ page, gateway }) => {
  const marker = `corp_${"public".repeat(8)}`;
  gateway.suggestions([
    { ...suggestion, title: marker, rationale: `합성 ${marker}`, conditions: { model: marker } },
  ]);
  await login(page);
  const action = page.getByRole("button", { name: / 섀도우 영향 확인$/u });
  expect(await action.getAttribute("aria-label")).not.toContain(marker);
  await action.click();
  await expect(result(page)).toBeVisible();
  expect(await result(page).evaluate((node) => node.outerHTML)).not.toContain(marker);
  expect(
    await page.evaluate(
      () => `${location.href} ${JSON.stringify(localStorage)} ${JSON.stringify(sessionStorage)}`,
    ),
  ).not.toContain(marker);
  expect(gateway.simulations).toEqual([
    { rules: [{ name: marker, conditions: { model: marker }, actions: suggestion.actions }], window: "7d" },
  ]);
});

test("390px 다크 결과는 표본 한계를 표시하고 키보드·초점 복원·axe를 유지한다", async ({
  page,
  gateway,
}, info) => {
  gateway.reply(1, { body: { ...success, evaluated: 5000, allowed: 4997, block_rate: 3 / 5000 } });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger(page).focus();
  await page.keyboard.press("Enter");
  const dialog = result(page);
  await expect(dialog).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(field(dialog, "평가 표본 수")).toHaveText("5,000");
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const readingHint = dialog.getByRole("region", { name: "시뮬레이션 결과 읽기", exact: true });
  let reachedReadingHint = false;
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    if (await readingHint.evaluate((node) => node === document.activeElement)) {
      reachedReadingHint = true;
      break;
    }
  }
  expect(reachedReadingHint).toBe(true);
  const scrollBody = dialog.locator(".sheet-body");
  const beforeScroll = await scrollBody.evaluate((node) => node.scrollTop);
  await page.keyboard.press("PageDown");
  await expect.poll(() => scrollBody.evaluate((node) => node.scrollTop)).toBeGreaterThan(beforeScroll);
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  expect(
    await page.evaluate(async () => {
      const engine = (
        window as Window & {
          axe?: {
            run: (root: Document) => Promise<{ violations: { id: string }[]; incomplete: { id: string }[] }>;
          };
        }
      ).axe;
      if (!engine) throw new Error("Accessibility engine missing");
      const report = await engine.run(document);
      return {
        violations: report.violations.map(({ id }) => id),
        namingNeedsReview: report.incomplete
          .filter(({ id }) => id === "aria-prohibited-attr")
          .map(({ id }) => id),
      };
    }),
  ).toEqual({ violations: [], namingNeedsReview: [] });
  await page.screenshot({ path: info.outputPath("policy-simulation-mobile-dark.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger(page)).toBeFocused();
  expect(gateway.simulations).toHaveLength(1);
});
