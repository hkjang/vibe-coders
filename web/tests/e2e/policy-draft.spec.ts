import { expect, type Locator, type Page } from "@playwright/test";
import { test, account, suggestion } from "./fixtures/policy-draft";

// Real React authentication/router/guards with synthetic API responses. Actual
// Go persistence, audit and post-change behavior have separate HTTP evidence.
const dialog = (page: Page) => page.getByRole("dialog", { name: "비활성 정책 초안 생성", exact: true });
const trigger = (page: Page) =>
  page.getByRole("button", { name: `${suggestion.title} 초안 생성`, exact: true });
const submit = (page: Page) => dialog(page).getByRole("button", { name: "초안 생성", exact: true });
const field = (panel: Locator, label: string) =>
  panel.getByText(label, { exact: true }).locator("..").locator("dd");
const expectedBody = {
  title: suggestion.title,
  conditions: suggestion.conditions,
  actions: suggestion.actions,
};
async function login(page: Page) {
  await page.goto("login?return_to=%2Fapp%2Fgovernance%2Fpolicies%3Ftab%3Dadvisor");
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: / 초안 생성$/u }).first()).toBeVisible();
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}

test("검토한 규칙과 기간을 한글로 확인하고 기존 본문만 한 번 전송한다", async ({ page, gateway }) => {
  await login(page);
  await trigger(page).click();
  await expect(field(dialog(page), "검토한 추천")).toHaveText(suggestion.title ?? suggestion.id);
  await expect(field(dialog(page), "검토한 분석 기간")).toContainText("7일");
  await expect(field(dialog(page), "검토한 규칙")).toContainText("risk_score");
  await expect(dialog(page)).toContainText("실제 적용은 별도");
  expect(gateway.drafts).toEqual([]);
  await submit(page).click();
  await expect(dialog(page).getByText("비활성 정책 초안을 생성했습니다.", { exact: true })).toBeVisible();
  expect(gateway.drafts).toEqual([expectedBody]);
  await dialog(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});

test("검토 취소와 Escape는 정책을 만들지 않고 원래 버튼으로 돌아간다", async ({ page, gateway }) => {
  await login(page);
  await trigger(page).click();
  await dialog(page).getByRole("button", { name: "취소", exact: true }).click();
  await expect(trigger(page)).toBeFocused();
  await trigger(page).click();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
  expect(gateway.drafts).toEqual([]);
});

for (const mode of ["flag", "status"] as const) {
  test(`${mode} 읽기 전용에서는 초안 생성만 잠그고 순수 계산 버튼은 유지한다`, async ({ page, gateway }) => {
    gateway.readonly(mode);
    await login(page);
    await expect(trigger(page)).toBeDisabled();
    await expect(page.getByRole("button", { name: / 섀도우 영향 확인$/u })).toBeEnabled();
    await trigger(page).evaluate((node) => {
      (node as HTMLButtonElement).disabled = false;
      (node as HTMLButtonElement).click();
    });
    await expect(dialog(page)).toBeHidden();
    expect(gateway.drafts).toEqual([]);
  });
}

for (const change of ["scope", "readonly"] as const) {
  test(`${change} 회수는 열린 고정 검토를 유지하고 복구해도 자동 생성하지 않는다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await trigger(page).click();
    if (change === "scope") gateway.writable(false);
    else gateway.readonly("flag");
    await runtime(page);
    await expect(submit(page)).toBeDisabled();
    await expect(field(dialog(page), "검토한 추천")).toHaveText(suggestion.title ?? suggestion.id);
    // Native disabled manipulation is an extra UI observation, not evidence of
    // a captured stale callback (covered separately by unit tests).
    await submit(page).evaluate((node) => {
      (node as HTMLButtonElement).disabled = false;
      (node as HTMLButtonElement).click();
    });
    expect(gateway.drafts).toEqual([]);
    if (change === "scope") gateway.writable(true);
    else gateway.readonly(false);
    await runtime(page);
    const rereview = dialog(page).getByRole("button", { name: "원래 규칙 다시 확인", exact: true });
    await expect(rereview).toBeEnabled();
    expect(gateway.drafts).toEqual([]);
    await rereview.click();
    await expect(submit(page)).toBeEnabled();
    await submit(page).click();
    await expect(dialog(page)).toContainText("비활성 정책 초안을 생성했습니다.");
    expect(gateway.drafts).toEqual([expectedBody]);
  });
}

test("생성 중 중복 클릭과 닫기는 잠그고 한 번만 전송한다", async ({ page, gateway }) => {
  gateway.hold(1);
  await login(page);
  await trigger(page).click();
  await submit(page).evaluate((node) => {
    (node as HTMLButtonElement).click();
    (node as HTMLButtonElement).click();
  });
  await expect.poll(() => gateway.drafts.length).toBe(1);
  await expect(dialog(page).getByRole("button", { name: "생성 중", exact: true })).toBeDisabled();
  await expect(dialog(page).getByRole("button", { name: "취소", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("button", { name: "대화상자 닫기", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  expect(gateway.drafts).toHaveLength(1);
  gateway.release(1);
  await expect(dialog(page)).toContainText("비활성 정책 초안을 생성했습니다.");
});

test("실패 후 생성 여부와 중복 가능성을 안내하고 명시적 재시도만 허용한다", async ({ page, gateway }) => {
  gateway.reply(1, { status: 503, body: { error: { message: "public synthetic draft failure" } } });
  await login(page);
  await trigger(page).click();
  await submit(page).click();
  await expect(dialog(page)).toContainText("req-public-policy-draft");
  await expect(dialog(page)).toContainText("중복 초안");
  expect(gateway.drafts).toEqual([expectedBody]);
  await dialog(page).getByRole("button", { name: "다시 초안 생성", exact: true }).click();
  await expect(dialog(page)).toContainText("비활성 정책 초안을 생성했습니다.");
  expect(gateway.drafts).toEqual([expectedBody, expectedBody]);
});

test("누락된 성공 확인은 완료로 간주하거나 자동 재전송하지 않는다", async ({ page, gateway }) => {
  gateway.reply(1, { status: 201, body: {} });
  await login(page);
  await trigger(page).click();
  await submit(page).click();
  await expect(dialog(page)).toContainText("생성 여부를 확인할 수 없습니다.");
  await expect(dialog(page)).toContainText("중복 초안");
  await expect(dialog(page).getByText("비활성 정책 초안을 생성했습니다.", { exact: true })).toBeHidden();
  expect(gateway.drafts).toEqual([expectedBody]);
});

test("확정된 생성 뒤 목록 조회 실패는 생성 실패나 두 번째 POST로 바꾸지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await trigger(page).click();
  gateway.failPolicyReads(true);
  await submit(page).click();
  await expect(dialog(page)).toContainText("생성은 확인했지만 정책 목록을 갱신하지 못했습니다.");
  await expect(dialog(page)).toContainText("비활성 정책 초안을 생성했습니다.");
  await expect(dialog(page).getByRole("button", { name: "다시 초안 생성", exact: true })).toBeHidden();
  expect(gateway.drafts).toEqual([expectedBody]);
});

test("다른 사용자로 바뀐 뒤 이전 생성 응답은 새 검토를 닫거나 새 결과를 게시하지 않는다", async ({
  page,
  gateway,
}) => {
  gateway.hold(1);
  await login(page);
  await trigger(page).click();
  await submit(page).click();
  await expect.poll(() => gateway.drafts.length).toBe(1);
  gateway.owner("public-other-draft-reviewer");
  await runtime(page);
  await expect(dialog(page)).toBeHidden();
  await page.getByLabel("사용자 메뉴", { exact: true }).click();
  await expect(page.getByText("다른 공개 초안 운영자", { exact: true })).toBeVisible();
  await page.getByLabel("사용자 메뉴", { exact: true }).click();
  await trigger(page).click();
  gateway.release(1);
  await expect.poll(() => gateway.finished.includes(1)).toBe(true);
  await expect(dialog(page)).toBeVisible();
  await expect(submit(page)).toBeEnabled();
  await expect(dialog(page).getByText("비활성 정책 초안을 생성했습니다.", { exact: true })).toBeHidden();
  expect(gateway.drafts).toHaveLength(1);
});

test("현재 비밀값 접두사는 검토·오류·브라우저 저장소에서 숨기되 전송 규칙은 바꾸지 않는다", async ({
  page,
  gateway,
}) => {
  const marker = `corp_${"p".repeat(40)}`;
  const sensitive = { ...suggestion, title: marker, conditions: { model: marker } };
  gateway.suggestions([sensitive]);
  gateway.reply(1, {
    status: 503,
    body: { error: { message: "public synthetic failure" } },
    requestId: marker,
  });
  await login(page);
  await page
    .getByRole("button", { name: / 초안 생성$/u })
    .first()
    .click();
  await expect(dialog(page)).not.toContainText(marker);
  await submit(page).click();
  await expect(dialog(page).getByRole("button", { name: "다시 초안 생성", exact: true })).toBeVisible();
  expect(gateway.drafts).toEqual([
    { title: marker, conditions: sensitive.conditions, actions: sensitive.actions },
  ]);
  expect(await page.locator("body").textContent()).not.toContain(marker);
  expect(page.url()).not.toContain(marker);
  const stored = await page.evaluate(() =>
    JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
  );
  expect(stored).not.toContain(marker);
});

test("390px 다크 검토는 키보드 스크롤·닫기 초점과 axe를 유지한다", async ({ page, gateway }, info) => {
  gateway.suggestions([
    { ...suggestion, conditions: { model: "공개 모델 ".repeat(100), risk_score: ">=70" } },
  ]);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger(page).focus();
  await page.keyboard.press("Enter");
  const panel = dialog(page);
  await expect(panel).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const region = panel.getByRole("region", { name: "초안 생성 검토 읽기", exact: true });
  let reached = false;
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press("Tab");
    expect(await panel.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    if (await region.evaluate((node) => node === document.activeElement)) {
      reached = true;
      break;
    }
  }
  expect(reached).toBe(true);
  // The shared Dialog scrolls its outer .dialog-content, not .dialog-body.
  const before = await panel.evaluate((node) => node.scrollTop);
  await page.keyboard.press("PageDown");
  await expect.poll(() => panel.evaluate((node) => node.scrollTop)).toBeGreaterThan(before);
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
  await page.screenshot({ path: info.outputPath("policy-draft-mobile-dark.png") });
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger(page)).toBeFocused();
  expect(gateway.drafts).toEqual([]);
});
